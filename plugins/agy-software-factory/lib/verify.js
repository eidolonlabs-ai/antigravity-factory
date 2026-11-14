import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { detectProject } from './detect.js';

const CATEGORIES = ['lint', 'typecheck', 'test', 'build'];
const WALK_SKIP_DIRS = new Set([
  '.git',
  '.factory',
  'node_modules',
  'dist',
  'build',
  'coverage',
]);
const ALLOWED_ENV_TEMPLATES = new Set([
  '.env.example',
  '.env.sample',
  '.env.template',
  '.env.test',
]);

function runGit(args, cwd) {
  return spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    timeout: 15_000,
    maxBuffer: 10 * 1024 * 1024,
  });
}

function isGitWorkTree(cwd) {
  const res = runGit(['rev-parse', '--is-inside-work-tree'], cwd);
  return res.status === 0 && res.stdout.trim() === 'true';
}

function getGitTopLevel(cwd) {
  const res = runGit(['rev-parse', '--show-toplevel'], cwd);
  if (res.status !== 0) return null;
  const raw = res.stdout.trim();
  if (!raw || !fs.existsSync(raw)) return null;
  return fs.realpathSync(raw);
}

function isFactoryRelPath(relPath) {
  const norm = relPath.replace(/\\/g, '/');
  return (
    norm === '.factory' ||
    norm.startsWith('.factory/') ||
    norm.includes('/.factory/') ||
    norm.endsWith('/.factory')
  );
}

function inspectGitWorkspace(resolvedCwd) {
  const realCwd = fs.existsSync(resolvedCwd) ? fs.realpathSync(resolvedCwd) : resolvedCwd;
  const repoTopLevel = getGitTopLevel(realCwd);
  if (!repoTopLevel) return null;

  const statusRes = runGit(['status', '--porcelain', '-z', '-uall', '--', '.'], realCwd);
  const porcelainEntries = [];
  const untrackedHashes = [];

  if (statusRes.status === 0 && statusRes.stdout) {
    const tokens = statusRes.stdout.split('\0');
    for (let i = 0; i < tokens.length; i++) {
      const entry = tokens[i];
      if (!entry || entry.length < 4) continue;
      const xy = entry.slice(0, 2);
      const fileRelToRepo = entry.slice(3);
      let origRelToRepo = null;
      if (xy[0] === 'R' || xy[0] === 'C') {
        origRelToRepo = tokens[i + 1] || '';
        i += 1;
      }

      const absPath = path.resolve(repoTopLevel, fileRelToRepo);
      const relToCwd = path.relative(realCwd, absPath).split(path.sep).join('/');
      if (isFactoryRelPath(fileRelToRepo) || isFactoryRelPath(relToCwd)) {
        continue;
      }

      porcelainEntries.push(
        origRelToRepo !== null
          ? `${xy} ${origRelToRepo} -> ${fileRelToRepo}`
          : `${xy} ${fileRelToRepo}`
      );

      if (xy === '??') {
        try {
          const lstat = fs.lstatSync(absPath);
          if (!lstat.isSymbolicLink() && lstat.isFile()) {
            const contentSha = crypto
              .createHash('sha256')
              .update(fs.readFileSync(absPath))
              .digest('hex');
            untrackedHashes.push(`${fileRelToRepo}:${contentSha}`);
          }
        } catch {
          // Ignore unreadable or concurrently deleted untracked entries.
        }
      }
    }
  }

  porcelainEntries.sort();
  untrackedHashes.sort();

  const excludeArgs = ['--', '.', ':(exclude).factory', ':(exclude)**/.factory/**'];
  const headDiffRes = runGit(['diff', 'HEAD', ...excludeArgs], realCwd);
  let gitDiff = '';
  if (headDiffRes.status === 0) {
    gitDiff = headDiffRes.stdout;
  } else {
    const cachedRes = runGit(['diff', '--cached', ...excludeArgs], realCwd);
    const worktreeRes = runGit(['diff', ...excludeArgs], realCwd);
    gitDiff = [
      cachedRes.status === 0 ? cachedRes.stdout : '',
      worktreeRes.status === 0 ? worktreeRes.stdout : '',
    ]
      .filter(Boolean)
      .join('\n');
  }

  const hasChanges = porcelainEntries.length > 0 || gitDiff.length > 0;
  const digest = crypto
    .createHash('sha256')
    .update(`${porcelainEntries.join('\n')}\n---\n${gitDiff}\n---\n${untrackedHashes.join('\n')}`)
    .digest('hex');

  return { hasChanges, digest };
}

function walkFilesForDigest(dirPath, rootPath, acc = []) {
  if (!fs.existsSync(dirPath)) return acc;
  const entries = fs.readdirSync(dirPath, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue;
    if (WALK_SKIP_DIRS.has(entry.name)) continue;
    const fullPath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      walkFilesForDigest(fullPath, rootPath, acc);
    } else if (entry.isFile()) {
      const contentSha = crypto
        .createHash('sha256')
        .update(fs.readFileSync(fullPath))
        .digest('hex');
      const rel = path.relative(rootPath, fullPath).split(path.sep).join('/');
      acc.push(`${rel}:${contentSha}`);
    }
  }
  return acc;
}

/**
 * Returns true when the git working tree at `cwd` has uncommitted tracked or untracked changes
 * (excluding `.factory/`). Returns false if clean or outside a git repository.
 *
 * @param {string} [cwd=process.cwd()]
 * @returns {boolean}
 */
export function hasUncommittedChanges(cwd = process.cwd()) {
  const resolvedCwd = path.resolve(cwd);
  const gitState = inspectGitWorkspace(resolvedCwd);
  return gitState ? gitState.hasChanges : false;
}

/**
 * Computes a deterministic SHA-256 hex digest of the workspace state, ignoring `.factory/`.
 *
 * @param {string} [cwd=process.cwd()]
 * @returns {string}
 */
export function computeWorkspaceDigest(cwd = process.cwd()) {
  const resolvedCwd = path.resolve(cwd);
  const gitState = inspectGitWorkspace(resolvedCwd);
  if (gitState) {
    return gitState.digest;
  }

  const realCwd = fs.existsSync(resolvedCwd) ? fs.realpathSync(resolvedCwd) : resolvedCwd;
  const fileEntries = walkFilesForDigest(realCwd, realCwd).sort();
  return crypto.createHash('sha256').update(fileEntries.join('\n')).digest('hex');
}

function gitignoreCoversEnv(gitignorePath) {
  if (!fs.existsSync(gitignorePath) || !fs.statSync(gitignorePath).isFile()) {
    return false;
  }
  const lines = fs.readFileSync(gitignorePath, 'utf8').split(/\r?\n/);
  let ignored = false;
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    if (
      line === '.env' ||
      line === '/.env' ||
      line === '.env*' ||
      line === '/.env*' ||
      line === '*.env' ||
      line === '**/.env'
    ) {
      ignored = true;
    } else if (line === '!.env' || line === '!/.env') {
      ignored = false;
    }
  }
  return ignored;
}

function isSensitiveTrackedFile(relFilePath) {
  const base = path.posix.basename(relFilePath.replace(/\\/g, '/'));
  if (ALLOWED_ENV_TEMPLATES.has(base)) return false;
  if (base === '.env' || base.startsWith('.env.')) return true;
  if (base === 'id_rsa' || base === 'id_ed25519') return true;
  if (base.endsWith('.pem') || base.endsWith('.key')) return true;
  return false;
}

function runHygieneCheck(resolvedCwd) {
  const start = Date.now();
  const issues = [];

  const envPath = path.join(resolvedCwd, '.env');
  const gitignorePath = path.join(resolvedCwd, '.gitignore');
  if (fs.existsSync(envPath) && fs.statSync(envPath).isFile()) {
    if (!gitignoreCoversEnv(gitignorePath)) {
      issues.push('.env exists in workspace without a .gitignore entry ignoring .env');
    }
  }

  if (isGitWorkTree(resolvedCwd)) {
    const lsRes = runGit(['ls-files'], resolvedCwd);
    if (lsRes.status === 0) {
      const tracked = lsRes.stdout
        .split(/\r?\n/)
        .map((s) => s.trim())
        .filter(Boolean);
      const trackedSecrets = tracked.filter(isSensitiveTrackedFile);
      if (trackedSecrets.length > 0) {
        issues.push(`Sensitive files tracked in git: ${trackedSecrets.join(', ')}`);
      }
    }
  }

  const durationMs = Date.now() - start;
  if (issues.length > 0) {
    return {
      id: 'hygiene',
      category: 'hygiene',
      component: 'workspace',
      status: 'FAIL',
      command: null,
      durationMs,
      output: issues.join('; '),
    };
  }

  return {
    id: 'hygiene',
    category: 'hygiene',
    component: 'workspace',
    status: 'PASS',
    command: null,
    durationMs,
    output: 'Workspace hygiene check passed.',
  };
}

function execShellCommand(command, cwd, timeoutMs = 120_000, baseEnv = process.env) {
  const start = Date.now();
  const res = spawnSync(command, {
    cwd,
    shell: true,
    encoding: 'utf8',
    timeout: timeoutMs,
    maxBuffer: 10 * 1024 * 1024,
    env: {
      ...baseEnv,
      CI: baseEnv.CI || 'true',
    },
  });
  const durationMs = Date.now() - start;
  const combined = [res.stdout || '', res.stderr || '']
    .filter(Boolean)
    .join('\n')
    .trim();
  const output = combined.length > 4000 ? combined.slice(-4000) : combined;
  const ok = res.status === 0 && !res.error;
  const errMsg = res.error ? res.error.message : '';

  return {
    ok,
    durationMs,
    output: output || errMsg,
  };
}

function isDockerComposeAvailable(baseEnv = process.env) {
  const res = spawnSync('docker', ['compose', 'version'], {
    stdio: 'ignore',
    timeout: 5_000,
    env: baseEnv,
  });
  return res.status === 0 && !res.error;
}

function ensureNodeDependenciesIfNeeded(component, resolvedCwd, baseEnv = process.env) {
  if (component.type !== 'node') return null;
  const pkgPath = path.join(component.path, 'package.json');
  if (!fs.existsSync(pkgPath)) return null;

  let pkg;
  try {
    pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  } catch {
    return null;
  }

  const hasDeps =
    (pkg.dependencies && Object.keys(pkg.dependencies).length > 0) ||
    (pkg.devDependencies && Object.keys(pkg.devDependencies).length > 0);
  const localNodeModules = path.join(component.path, 'node_modules');
  const rootNodeModules = resolvedCwd ? path.join(resolvedCwd, 'node_modules') : null;
  const hasInstalledModules =
    fs.existsSync(localNodeModules) ||
    (rootNodeModules && fs.existsSync(rootNodeModules));

  if (hasDeps && !hasInstalledModules) {
    const pm = component.packageManager || 'npm';
    const installCmd =
      pm === 'pnpm'
        ? 'pnpm install'
        : pm === 'yarn'
          ? 'yarn install'
          : pm === 'bun'
            ? 'bun install'
            : 'npm install --no-audit --no-fund';
    const installRes = execShellCommand(installCmd, component.path, 180_000, baseEnv);
    if (!installRes.ok) {
      return `${pm} install failed: ${installRes.output}`;
    }
  }
  return null;
}

function resolveRequireTestsOption(resolvedCwd, explicitRequireTests) {
  if (typeof explicitRequireTests === 'boolean') {
    return explicitRequireTests;
  }
  const configPath = path.join(resolvedCwd, '.factory.json');
  if (fs.existsSync(configPath) && fs.statSync(configPath).isFile()) {
    try {
      const parsed = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      if (typeof parsed?.requireTests === 'boolean') {
        return parsed.requireTests;
      }
    } catch {
      // Ignore malformed .factory.json and default to false
    }
  }
  return false;
}

/**
 * Runs deterministic workspace verification checks and writes `.factory/verify-receipt.json`.
 *
 * @param {object} [options]
 * @param {string} [options.cwd=process.cwd()]
 * @param {boolean} [options.requireTests]
 * @param {boolean} [options.skipDocker=false]
 * @param {NodeJS.ProcessEnv} [options.env=process.env]
 */
export function runVerify({
  cwd = process.cwd(),
  requireTests,
  skipDocker = false,
  env = process.env,
} = {}) {
  const resolvedCwd = path.resolve(cwd);
  const effectiveRequireTests = resolveRequireTestsOption(resolvedCwd, requireTests);
  const project = detectProject(resolvedCwd);
  const checks = [];

  // a) Hygiene check
  checks.push(runHygieneCheck(resolvedCwd));

  // b) Optional Docker Compose syntax check
  if (project.hasDockerCompose && !skipDocker && isDockerComposeAvailable(env)) {
    const cmd = 'docker compose config --quiet';
    const res = execShellCommand(cmd, resolvedCwd, 30_000, env);
    checks.push({
      id: 'docker-compose',
      category: 'docker-compose',
      component: 'workspace',
      status: res.ok ? 'PASS' : 'FAIL',
      command: cmd,
      durationMs: res.durationMs,
      output: res.output || (res.ok ? `${project.dockerComposeFile} is valid.` : 'docker compose config failed.'),
    });
  } else {
    checks.push({
      id: 'docker-compose',
      category: 'docker-compose',
      component: 'workspace',
      status: 'NOT_RUN',
      command: project.hasDockerCompose ? 'docker compose config --quiet' : null,
      durationMs: 0,
      output: !project.hasDockerCompose
        ? 'No docker-compose file detected'
        : skipDocker
          ? 'Skipped (--skip-docker)'
          : 'Docker Compose CLI not installed (optional check skipped)',
    });
  }

  // c) Per-component checks (lint, typecheck, test, build)
  for (const component of project.components) {
    const compLabel = component.relPath === '.' ? component.name : component.relPath;
    const hasAnyConfiguredCommand = CATEGORIES.some((cat) => Boolean(component.commands?.[cat]));
    const installError = hasAnyConfiguredCommand
      ? ensureNodeDependenciesIfNeeded(component, resolvedCwd, env)
      : null;

    for (const category of CATEGORIES) {
      const cmd = component.commands?.[category] || null;
      const checkId = `${compLabel}:${category}`;

      if (!cmd) {
        checks.push({
          id: checkId,
          category,
          component: compLabel,
          status: 'NOT_RUN',
          command: null,
          durationMs: 0,
          output: 'No script configured',
        });
        continue;
      }

      if (installError) {
        checks.push({
          id: checkId,
          category,
          component: compLabel,
          status: 'FAIL',
          command: cmd,
          durationMs: 0,
          output: installError,
        });
        continue;
      }

      const res = execShellCommand(cmd, component.path, 120_000, env);
      checks.push({
        id: checkId,
        category,
        component: compLabel,
        status: res.ok ? 'PASS' : 'FAIL',
        command: cmd,
        durationMs: res.durationMs,
        output: res.output,
      });
    }
  }

  const summary = {
    pass: checks.filter((c) => c.status === 'PASS').length,
    fail: checks.filter((c) => c.status === 'FAIL').length,
    notRun: checks.filter((c) => c.status === 'NOT_RUN').length,
  };

  const hasPassingTests = checks.some((c) => c.category === 'test' && c.status === 'PASS');
  const ok = summary.fail === 0 && (!effectiveRequireTests || hasPassingTests);

  const factoryDir = path.join(resolvedCwd, '.factory');
  fs.mkdirSync(factoryDir, { recursive: true });

  const digest = computeWorkspaceDigest(resolvedCwd);
  const timestamp = new Date().toISOString();

  const receipt = {
    timestamp,
    cwd: resolvedCwd,
    digest,
    ok,
    requireTests: Boolean(effectiveRequireTests),
    summary,
    checks,
  };

  const receiptPath = path.join(factoryDir, 'verify-receipt.json');
  fs.writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, 'utf8');

  return receipt;
}
