import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { detectProject } from '../plugins/agy-software-factory/lib/detect.js';
import { runVerify, computeWorkspaceDigest } from '../plugins/agy-software-factory/lib/verify.js';
import { runAuditDiff, matchesAllowedPath } from '../plugins/agy-software-factory/lib/audit-diff.js';
import { runInit } from '../plugins/agy-software-factory/lib/init.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const CLI_BIN = path.join(REPO_ROOT, 'bin', 'agy-factory.js');
const PLUGIN_SOURCE_DIR = path.join(REPO_ROOT, 'plugins', 'agy-software-factory');

function createTempDir(t) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-test-'));
  t.after(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });
  return tempDir;
}

function writeJson(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n', 'utf8');
}

test('detectProject detects multi-service repo with api, web, and docker-compose.yml', async (t) => {
  const tempDir = createTempDir(t);

  writeJson(path.join(tempDir, 'api', 'package.json'), {
    name: 'sample-api',
    version: '1.0.0',
    scripts: {
      test: 'node -e "process.exit(0)"',
    },
  });

  writeJson(path.join(tempDir, 'web', 'package.json'), {
    name: 'sample-web',
    version: '1.0.0',
    scripts: {
      build: 'node -e "process.exit(0)"',
    },
  });

  fs.writeFileSync(
    path.join(tempDir, 'docker-compose.yml'),
    'services:\n  api:\n    build: ./api\n  web:\n    build: ./web\n',
    'utf8'
  );

  const result = await detectProject(tempDir);

  assert.equal(result.hasDockerCompose, true);
  assert.ok(
    String(result.dockerComposeFile).endsWith('docker-compose.yml'),
    `Expected dockerComposeFile to reference docker-compose.yml, got ${result.dockerComposeFile}`
  );
  assert.equal(result.components.length, 2);

  const apiComponent = result.components.find(
    (c) => c.relPath === 'api' || c.name === 'api' || c.name === 'sample-api'
  );
  const webComponent = result.components.find(
    (c) => c.relPath === 'web' || c.name === 'web' || c.name === 'sample-web'
  );

  assert.ok(apiComponent, 'Expected api component to be detected');
  assert.equal(apiComponent.type, 'node');
  assert.ok(apiComponent.commands.test, 'Expected api test command to be detected');
  assert.ok(!apiComponent.commands.lint, 'Expected missing api lint script not to map a command');

  assert.ok(webComponent, 'Expected web component to be detected');
  assert.equal(webComponent.type, 'node');
  assert.ok(webComponent.commands.build, 'Expected web build command to be detected');
});

test('runVerify records PASS for passing test, NOT_RUN for missing lint, and writes receipt', async (t) => {
  const tempDir = createTempDir(t);

  writeJson(path.join(tempDir, 'package.json'), {
    name: 'passing-service',
    version: '1.0.0',
    scripts: {
      test: 'node -e "process.exit(0)"',
    },
  });

  const digestBefore = await computeWorkspaceDigest(tempDir);
  assert.match(digestBefore, /^[a-f0-9]{64}$/);

  const receipt = await runVerify({ cwd: tempDir, skipDocker: true });

  assert.equal(receipt.ok, true);
  assert.equal(receipt.summary.fail, 0);

  const testCheck = receipt.checks.find((c) => c.category === 'test');
  const lintCheck = receipt.checks.find((c) => c.category === 'lint');

  assert.ok(testCheck, 'Expected test check entry');
  assert.equal(testCheck.status, 'PASS');

  assert.ok(lintCheck, 'Expected lint check entry');
  assert.equal(lintCheck.status, 'NOT_RUN');

  const receiptPath = path.join(tempDir, '.factory', 'verify-receipt.json');
  assert.equal(fs.existsSync(receiptPath), true, 'Expected .factory/verify-receipt.json to exist');

  const savedReceipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8'));
  assert.equal(savedReceipt.ok, true);
  assert.match(savedReceipt.digest, /^[a-f0-9]{64}$/);
});

test('runVerify with requireTests: true fails when no test script exists (NOT_RUN is not PASS)', async (t) => {
  const tempDir = createTempDir(t);

  writeJson(path.join(tempDir, 'package.json'), {
    name: 'no-test-service',
    version: '1.0.0',
    scripts: {
      build: 'node -e "process.exit(0)"',
    },
  });

  const receipt = await runVerify({
    cwd: tempDir,
    requireTests: true,
    skipDocker: true,
  });

  assert.equal(receipt.ok, false);
  const testCheck = receipt.checks.find((c) => c.category === 'test');
  assert.ok(testCheck, 'Expected test check entry');
  assert.equal(testCheck.status, 'NOT_RUN');
});

test('runVerify fails with FAIL status when test script exits non-zero', async (t) => {
  const tempDir = createTempDir(t);

  writeJson(path.join(tempDir, 'package.json'), {
    name: 'failing-service',
    version: '1.0.0',
    scripts: {
      test: 'node -e "process.exit(1)"',
    },
  });

  const receipt = await runVerify({ cwd: tempDir, skipDocker: true });

  assert.equal(receipt.ok, false);
  assert.ok(receipt.summary.fail >= 1);

  const testCheck = receipt.checks.find((c) => c.category === 'test');
  assert.ok(testCheck, 'Expected test check entry');
  assert.equal(testCheck.status, 'FAIL');
});

test('runVerify fails hygiene check when .env exists without .gitignore', async (t) => {
  const tempDir = createTempDir(t);

  writeJson(path.join(tempDir, 'package.json'), {
    name: 'env-hygiene-test',
    version: '1.0.0',
    scripts: {
      test: 'node -e "process.exit(0)"',
    },
  });
  fs.writeFileSync(path.join(tempDir, '.env'), 'PORT=4000\n', 'utf8');

  const receipt = await runVerify({ cwd: tempDir, skipDocker: true });

  assert.equal(receipt.ok, false);
  const hygieneCheck = receipt.checks.find(
    (c) => c.category === 'hygiene' || c.id === 'hygiene'
  );
  assert.ok(hygieneCheck, 'Expected hygiene check entry');
  assert.equal(hygieneCheck.status, 'FAIL');
});

test('runAuditDiff returns APPROVE_CANDIDATE with 0 findings on clean JS files', async (t) => {
  const tempDir = createTempDir(t);

  fs.writeFileSync(
    path.join(tempDir, 'math.js'),
    'export function sum(a, b) {\n  return a + b;\n}\n',
    'utf8'
  );

  const report = await runAuditDiff({ cwd: tempDir, allFiles: true });

  assert.equal(report.status, 'APPROVE_CANDIDATE');
  assert.equal(report.findings.length, 0);
  assert.ok(report.filesScanned >= 1);
});

test('runAuditDiff returns FLAGGED for dangerous-exec and hardcoded-secret patterns', async (t) => {
  const tempDir = createTempDir(t);

  const fakeAwsKey = ['AKIA', '1234567890ABCDEF'].join(''); // factory-audit-ignore
  const dynamicExecName = ['ev', 'al'].join(''); // factory-audit-ignore
  const unsafeCode = [
    `const awsAccessKey = "${fakeAwsKey}";`,
    `export function runUntrusted(userInput) {`,
    `  return ${dynamicExecName}(userInput);`,
    `}`,
    '',
  ].join('\n');

  fs.writeFileSync(path.join(tempDir, 'unsafe.js'), unsafeCode, 'utf8');

  const report = await runAuditDiff({ cwd: tempDir, allFiles: true });

  assert.equal(report.status, 'FLAGGED');
  assert.ok(
    report.findings.some((f) => f.rule === 'dangerous-exec'),
    `Expected dangerous-exec finding, got: ${JSON.stringify(report.findings)}`
  );
  assert.ok(
    report.findings.some((f) => f.rule === 'hardcoded-secret'),
    `Expected hardcoded-secret finding, got: ${JSON.stringify(report.findings)}`
  );
});

test('runInit in link mode creates .agents/plugins.json, .factory.json, and updates .gitignore', async (t) => {
  const tempDir = createTempDir(t);

  const result = await runInit({
    targetDir: tempDir,
    mode: 'link',
    pluginSourceDir: PLUGIN_SOURCE_DIR,
  });

  assert.equal(result.mode, 'link');

  const pluginsJsonPath = path.join(tempDir, '.agents', 'plugins.json');
  const factoryConfigPath = path.join(tempDir, '.factory.json');
  const gitignorePath = path.join(tempDir, '.gitignore');

  assert.equal(fs.existsSync(pluginsJsonPath), true);
  assert.equal(fs.existsSync(factoryConfigPath), true);
  assert.equal(fs.existsSync(gitignorePath), true);

  const pluginsJson = JSON.parse(fs.readFileSync(pluginsJsonPath, 'utf8'));
  assert.ok(Array.isArray(pluginsJson.entries));
  assert.ok(pluginsJson.entries.length >= 1);
  assert.equal(typeof pluginsJson.entries[0].path, 'string');

  const factoryConfig = JSON.parse(fs.readFileSync(factoryConfigPath, 'utf8'));
  assert.equal(factoryConfig.enforceStopVerify, false);
  assert.equal(factoryConfig.requireTests, true);

  const gitignoreContent = fs.readFileSync(gitignorePath, 'utf8');
  assert.ok(gitignoreContent.includes('.factory'), 'Expected .gitignore to ignore .factory/');
});

test('runInit in copy mode copies plugin.json into .agents/plugins/agy-software-factory/', async (t) => {
  const tempDir = createTempDir(t);

  const result = await runInit({
    targetDir: tempDir,
    mode: 'copy',
    pluginSourceDir: PLUGIN_SOURCE_DIR,
  });

  assert.equal(result.mode, 'copy');

  const copiedPluginJsonPath = path.join(
    tempDir,
    '.agents',
    'plugins',
    'agy-software-factory',
    'plugin.json'
  );
  assert.equal(fs.existsSync(copiedPluginJsonPath), true);

  const manifest = JSON.parse(fs.readFileSync(copiedPluginJsonPath, 'utf8'));
  assert.equal(manifest.name, 'agy-software-factory');
});

test('CLI subprocess: node bin/agy-factory.js detect --cwd <tempDir> --json outputs valid JSON', (t) => {
  const tempDir = createTempDir(t);

  writeJson(path.join(tempDir, 'package.json'), {
    name: 'cli-subprocess-fixture',
    version: '1.0.0',
    scripts: {
      test: 'node -e "process.exit(0)"',
    },
  });

  const proc = spawnSync(
    process.execPath,
    [CLI_BIN, 'detect', '--cwd', tempDir, '--json'],
    { encoding: 'utf8' }
  );

  assert.equal(
    proc.status,
    0,
    `Expected exit code 0, got ${proc.status}. stderr: ${proc.stderr}`
  );

  const parsed = JSON.parse(proc.stdout);
  assert.equal(parsed.hasDockerCompose, false);
  assert.ok(Array.isArray(parsed.components));
  assert.equal(parsed.components.length, 1);
  assert.equal(parsed.components[0].type, 'node');
  assert.ok(parsed.components[0].commands.test);
});

test('runInit in copy mode works inside a CommonJS repo (copied CLI + hook execute cleanly and idempotently)', async (t) => {
  const tempDir = createTempDir(t);

  writeJson(path.join(tempDir, 'package.json'), {
    name: 'cjs-host-repo',
    version: '1.0.0',
    type: 'commonjs',
    scripts: {
      test: 'node -e "process.exit(0)"',
    },
  });

  await runInit({
    targetDir: tempDir,
    mode: 'copy',
    pluginSourceDir: PLUGIN_SOURCE_DIR,
  });

  const copiedPluginDir = path.join(
    tempDir,
    '.agents',
    'plugins',
    'agy-software-factory'
  );
  const copiedPkgPath = path.join(copiedPluginDir, 'package.json');
  assert.equal(fs.existsSync(copiedPkgPath), true, 'Expected copied plugin package.json to exist');
  const copiedPkg = JSON.parse(fs.readFileSync(copiedPkgPath, 'utf8'));
  assert.equal(copiedPkg.type, 'module');

  const copiedCliBin = path.join(copiedPluginDir, 'bin', 'agy-factory.js');
  const cliProc = spawnSync(
    process.execPath,
    [copiedCliBin, 'detect', '--cwd', tempDir, '--json'],
    { encoding: 'utf8' }
  );
  assert.equal(
    cliProc.status,
    0,
    `Expected copied agy-factory.js to run in CJS repo, got ${cliProc.status}. stderr: ${cliProc.stderr}`
  );
  const detected = JSON.parse(cliProc.stdout);
  assert.equal(detected.components.length, 1);
  assert.equal(detected.components[0].type, 'node');

  const copiedPreToolBin = path.join(copiedPluginDir, 'bin', 'pre-tool-guard.js');
  const hookProc = spawnSync(process.execPath, [copiedPreToolBin], {
    input: JSON.stringify({
      toolCall: { name: 'write_file', args: { Path: '/repo/.env' } },
      workspacePaths: [tempDir],
      conversationId: 'conv-cjs-copy',
      stepIdx: 1,
    }),
    encoding: 'utf8',
  });
  assert.equal(
    hookProc.status,
    0,
    `Expected copied pre-tool-guard.js to run in CJS repo, got ${hookProc.status}. stderr: ${hookProc.stderr}`
  );
  assert.equal(JSON.parse(hookProc.stdout).decision, 'deny');

  // Re-running copy from the already-copied destination directory should be a safe no-op
  const rerun = await runInit({
    targetDir: tempDir,
    mode: 'copy',
    pluginSourceDir: copiedPluginDir,
  });
  assert.equal(rerun.mode, 'copy');
});

test('runAuditDiff rejects option-like --base flags starting with "-" and skips untracked symlinks', async (t) => {
  const tempRepo = createTempDir(t);
  const outsideDir = createTempDir(t);

  execFileSync('git', ['init'], { cwd: tempRepo, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'factory@example.com'], {
    cwd: tempRepo,
    stdio: 'ignore',
  });
  execFileSync('git', ['config', 'user.name', 'Factory Test'], {
    cwd: tempRepo,
    stdio: 'ignore',
  });
  execFileSync('git', ['config', 'commit.gpgsign', 'false'], {
    cwd: tempRepo,
    stdio: 'ignore',
  });

  fs.writeFileSync(path.join(tempRepo, 'index.js'), 'export const ok = true;\n', 'utf8');
  execFileSync('git', ['add', '.'], { cwd: tempRepo, stdio: 'ignore' });
  execFileSync('git', ['commit', '-m', 'init'], { cwd: tempRepo, stdio: 'ignore' });

  await assert.rejects(async () => {
    return await runAuditDiff({ cwd: tempRepo, base: '--output=/tmp/injected' });
  });
  await assert.rejects(async () => {
    return await runAuditDiff({ cwd: tempRepo, base: '-n' });
  });

  const fakeAwsKey = ['AKIA', '1234567890ABCDEF'].join(''); // factory-audit-ignore
  const outsideSecretFile = path.join(outsideDir, 'outside-secret.js');
  fs.writeFileSync(outsideSecretFile, `export const k = "${fakeAwsKey}";\n`, 'utf8');
  fs.symlinkSync(outsideSecretFile, path.join(tempRepo, 'symlinked-secret.js'));

  const report = await runAuditDiff({ cwd: tempRepo });
  assert.equal(report.status, 'APPROVE_CANDIDATE');
  assert.equal(report.findings.length, 0);
});

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function writeNpmWrapper(destPath, execPath, npmExecPath) {
  const wrapper = `#!/bin/sh\nexec ${shellQuote(execPath)} ${shellQuote(npmExecPath)} "$@"\n`;
  fs.writeFileSync(destPath, wrapper, { encoding: 'utf8', mode: 0o755 });
  fs.chmodSync(destPath, 0o755);
}

function createDockerComposeNodeFixture(repoDir, pkgName) {
  fs.writeFileSync(
    path.join(repoDir, 'docker-compose.yml'),
    'services:\n  app:\n    image: alpine:3.20\n',
    'utf8'
  );
  fs.writeFileSync(
    path.join(repoDir, 'package.json'),
    JSON.stringify({
      name: pkgName,
      version: '1.0.0',
      scripts: { test: `${JSON.stringify(process.execPath)} -e "process.exit(0)"` },
    }),
    'utf8'
  );
}

function findExecutableNpm(searchDirs) {
  for (const dir of searchDirs) {
    if (!dir) continue;
    const candidate = path.join(dir, 'npm');
    try {
      const stat = fs.statSync(candidate);
      if (!stat.isFile()) continue;
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      // Try next directory in searchDirs
    }
  }
  return null;
}

function provisionMinimalNodeEnv(
  minimalBinDir,
  {
    nodeBinDir = path.dirname(process.execPath),
    envPath = process.env.PATH || '',
    execPath = process.execPath,
    npmExecPath = process.env.npm_execpath || '',
  } = {}
) {
  fs.symlinkSync(execPath, path.join(minimalBinDir, 'node'));
  if (fs.existsSync('/bin/sh')) {
    fs.symlinkSync('/bin/sh', path.join(minimalBinDir, 'sh'));
  }

  const searchDirs = [
    nodeBinDir,
    ...String(envPath).split(path.delimiter).filter(Boolean),
  ];
  const destNpm = path.join(minimalBinDir, 'npm');
  const resolvedNpm = findExecutableNpm(searchDirs);

  if (resolvedNpm) {
    fs.symlinkSync(resolvedNpm, destNpm);
  } else if (npmExecPath && fs.existsSync(npmExecPath)) {
    writeNpmWrapper(destNpm, execPath, npmExecPath);
  }

  assert.ok(
    fs.existsSync(destNpm),
    `expected npm to be resolved into minimalBinDir (searched: ${searchDirs.join(', ')})`
  );
  return destNpm;
}

test('runVerify treats Docker Compose as optional (NOT_RUN, ok: true) when docker CLI is not on PATH', async (t) => {
  const tempRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-no-docker-'));
  const minimalBinDir = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-minimal-bin-'));
  t.after(() => {
    fs.rmSync(tempRepo, { recursive: true, force: true });
    fs.rmSync(minimalBinDir, { recursive: true, force: true });
  });

  // Expose node, sh, and portably resolved npm without docker on PATH
  provisionMinimalNodeEnv(minimalBinDir);
  createDockerComposeNodeFixture(tempRepo, 'optional-docker-test');

  const receipt = await runVerify({
    cwd: tempRepo,
    requireTests: true,
    env: { ...process.env, PATH: minimalBinDir },
  });

  const dockerCheck = receipt.checks.find((c) => c.category === 'docker-compose');
  assert.ok(dockerCheck, 'expected docker-compose check entry');
  assert.equal(dockerCheck.status, 'NOT_RUN');
  assert.match(dockerCheck.output, /not installed/i);
  assert.equal(receipt.ok, true);
});

test('provisionMinimalNodeEnv resolves non-adjacent npm via PATH, npm_execpath wrapper, and fails loudly if absent', async (t) => {
  const tempRoot = createTempDir(t);
  const fakeNodeDir = path.join(tempRoot, 'fake-node-bin');
  const separateNpmDir = path.join(tempRoot, 'separate-npm-bin');
  const emptyDir = path.join(tempRoot, 'empty-bin');
  const isolatedBinDir = path.join(tempRoot, 'isolated-bin');
  const wrapperBinDir = path.join(tempRoot, 'wrapper-bin');
  const missingBinDir = path.join(tempRoot, 'missing-bin');
  const tempRepo = path.join(tempRoot, 'repo');

  for (const dir of [
    fakeNodeDir,
    separateNpmDir,
    emptyDir,
    isolatedBinDir,
    wrapperBinDir,
    missingBinDir,
    tempRepo,
  ]) {
    fs.mkdirSync(dir, { recursive: true });
  }

  // Simulate an environment where `node` dir does not contain `npm`, and `npm` lives elsewhere on PATH
  fs.symlinkSync(process.execPath, path.join(fakeNodeDir, 'node'));
  const hostNpm = findExecutableNpm([
    path.dirname(process.execPath),
    ...(process.env.PATH || '').split(path.delimiter).filter(Boolean),
  ]);
  if (hostNpm) {
    fs.symlinkSync(hostNpm, path.join(separateNpmDir, 'npm'));
  } else if (process.env.npm_execpath && fs.existsSync(process.env.npm_execpath)) {
    writeNpmWrapper(path.join(separateNpmDir, 'npm'), process.execPath, process.env.npm_execpath);
  }

  const destNpm = provisionMinimalNodeEnv(isolatedBinDir, {
    nodeBinDir: fakeNodeDir,
    envPath: separateNpmDir,
    npmExecPath: '',
  });
  assert.equal(fs.lstatSync(destNpm).isSymbolicLink(), true);

  createDockerComposeNodeFixture(tempRepo, 'non-adjacent-npm-test');

  const receipt = await runVerify({
    cwd: tempRepo,
    requireTests: true,
    env: { ...process.env, PATH: isolatedBinDir },
  });
  assert.equal(receipt.checks.find((c) => c.category === 'docker-compose')?.status, 'NOT_RUN');
  assert.equal(receipt.ok, true);

  // Verify npm_execpath fallback wrapper when no standalone npm binary exists
  const fakeNpmCli = path.join(tempRoot, 'fake-npm-cli.cjs');
  fs.writeFileSync(fakeNpmCli, 'process.exit(0);\n', 'utf8');
  const wrappedNpm = provisionMinimalNodeEnv(wrapperBinDir, {
    nodeBinDir: emptyDir,
    envPath: emptyDir,
    npmExecPath: fakeNpmCli,
  });
  assert.equal(fs.lstatSync(wrappedNpm).isFile(), true);
  assert.match(fs.readFileSync(wrappedNpm, 'utf8'), /fake-npm-cli\.cjs/);
  const wrapRes = spawnSync(wrappedNpm, ['--version'], {
    env: { ...process.env, PATH: wrapperBinDir },
  });
  assert.equal(wrapRes.status, 0);

  // Verify setup fails loudly if npm cannot be found anywhere
  assert.throws(
    () =>
      provisionMinimalNodeEnv(missingBinDir, {
        nodeBinDir: emptyDir,
        envPath: emptyDir,
        npmExecPath: '',
      }),
    /expected npm to be resolved into minimalBinDir/
  );
});

test('detectProject detects pnpm/yarn/bun package managers and monorepo apps/* & packages/*', (t) => {
  const tempRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-monorepo-'));
  t.after(() => {
    fs.rmSync(tempRepo, { recursive: true, force: true });
  });

  // Root uses pnpm-lock.yaml
  fs.writeFileSync(path.join(tempRepo, 'pnpm-lock.yaml'), 'lockfileVersion: 9.0\n', 'utf8');

  // apps/web inherits pnpm from root lockfile
  const webDir = path.join(tempRepo, 'apps', 'web');
  fs.mkdirSync(webDir, { recursive: true });
  fs.writeFileSync(
    path.join(webDir, 'package.json'),
    JSON.stringify({
      name: '@acme/web',
      scripts: { build: 'vite build', lint: 'eslint .' },
    }),
    'utf8'
  );

  // packages/shared declares yarn via packageManager
  const sharedDir = path.join(tempRepo, 'packages', 'shared');
  fs.mkdirSync(sharedDir, { recursive: true });
  fs.writeFileSync(
    path.join(sharedDir, 'package.json'),
    JSON.stringify({
      name: '@acme/shared',
      packageManager: 'yarn@4.1.0',
      scripts: { test: 'node --test', typecheck: 'tsc --noEmit' },
    }),
    'utf8'
  );

  const detected = detectProject(tempRepo);
  assert.equal(detected.components.length, 2);

  const webComp = detected.components.find((c) => c.relPath === 'apps/web');
  assert.ok(webComp);
  assert.equal(webComp.packageManager, 'pnpm');
  assert.equal(webComp.commands.build, 'pnpm run build');
  assert.equal(webComp.commands.lint, 'pnpm run lint');

  const sharedComp = detected.components.find((c) => c.relPath === 'packages/shared');
  assert.ok(sharedComp);
  assert.equal(sharedComp.packageManager, 'yarn');
  assert.equal(sharedComp.commands.test, 'yarn test');
  assert.equal(sharedComp.commands.typecheck, 'yarn run typecheck');
});

test('runVerify honors requireTests: true from .factory.json when CLI flag is omitted', async (t) => {
  const tempRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-cfg-reqtests-'));
  t.after(() => {
    fs.rmSync(tempRepo, { recursive: true, force: true });
  });

  // Initialize workspace (creates .factory.json with requireTests: true)
  await runInit({ targetDir: tempRepo, mode: 'link' });

  // Package with build only, no test script
  fs.writeFileSync(
    path.join(tempRepo, 'package.json'),
    JSON.stringify({
      name: 'cfg-test-app',
      version: '1.0.0',
      scripts: { build: 'node -e "process.exit(0)"' },
    }),
    'utf8'
  );

  // Without passing requireTests explicitly, .factory.json requireTests: true should cause ok: false
  const receiptFail = await runVerify({ cwd: tempRepo, skipDocker: true });
  assert.equal(receiptFail.requireTests, true);
  assert.equal(receiptFail.ok, false);

  // Once a real test script is added, runVerify passes automatically
  fs.writeFileSync(
    path.join(tempRepo, 'package.json'),
    JSON.stringify({
      name: 'cfg-test-app',
      version: '1.0.0',
      scripts: {
        build: 'node -e "process.exit(0)"',
        test: 'node -e "process.exit(0)"',
      },
    }),
    'utf8'
  );

  const receiptPass = await runVerify({ cwd: tempRepo, skipDocker: true });
  assert.equal(receiptPass.requireTests, true);
  assert.equal(receiptPass.ok, true);
});

test('runAuditDiff enforces --allow-paths slice ownership boundaries', async (t) => {
  const tempRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-slice-bounds-'));
  t.after(() => {
    fs.rmSync(tempRepo, { recursive: true, force: true });
  });

  fs.mkdirSync(path.join(tempRepo, 'api', 'src'), { recursive: true });
  fs.mkdirSync(path.join(tempRepo, 'web', 'src'), { recursive: true });
  fs.writeFileSync(path.join(tempRepo, 'api', 'src', 'index.js'), 'export const ok = true;\n', 'utf8');

  // Within owned slice ("api/**") -> APPROVE_CANDIDATE
  const inBounds = await runAuditDiff({
    cwd: tempRepo,
    allFiles: true,
    allowPaths: 'api/**,db/init.sql',
  });
  assert.equal(inBounds.status, 'APPROVE_CANDIDATE');
  assert.equal(inBounds.findings.length, 0);

  // Touching forbidden file ("web/src/App.jsx") -> FLAGGED with slice-boundary-violation
  fs.writeFileSync(path.join(tempRepo, 'web', 'src', 'App.jsx'), 'export default function App() {}\n', 'utf8');
  const outOfBounds = await runAuditDiff({
    cwd: tempRepo,
    allFiles: true,
    allowPaths: 'api/**,db/init.sql',
  });
  assert.equal(outOfBounds.status, 'FLAGGED');
  const violation = outOfBounds.findings.find((f) => f.rule === 'slice-boundary-violation');
  assert.ok(violation, 'expected slice-boundary-violation finding');
  assert.equal(violation.file, 'web/src/App.jsx');
  assert.equal(violation.severity, 'high');
});

test('runVerify hygiene honors git check-ignore (.git/info/exclude) and fails if .env is tracked', async (t) => {
  const tempRepo = createTempDir(t);

  execFileSync('git', ['init'], { cwd: tempRepo, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'factory@example.com'], {
    cwd: tempRepo,
    stdio: 'ignore',
  });
  execFileSync('git', ['config', 'user.name', 'Factory Test'], {
    cwd: tempRepo,
    stdio: 'ignore',
  });
  execFileSync('git', ['config', 'commit.gpgsign', 'false'], {
    cwd: tempRepo,
    stdio: 'ignore',
  });

  writeJson(path.join(tempRepo, 'package.json'), {
    name: 'git-ignore-hygiene-test',
    version: '1.0.0',
    scripts: { test: 'node -e "process.exit(0)"' },
  });
  execFileSync('git', ['add', 'package.json'], { cwd: tempRepo, stdio: 'ignore' });
  execFileSync('git', ['commit', '-m', 'init'], { cwd: tempRepo, stdio: 'ignore' });

  // Ignore .env via .git/info/exclude rather than root .gitignore
  fs.mkdirSync(path.join(tempRepo, '.git', 'info'), { recursive: true });
  fs.writeFileSync(path.join(tempRepo, '.git', 'info', 'exclude'), '.env\n', 'utf8');
  fs.writeFileSync(path.join(tempRepo, '.env'), 'PORT=4000\n', 'utf8');

  const excludePassReceipt = await runVerify({ cwd: tempRepo, skipDocker: true });
  const excludeHygiene = excludePassReceipt.checks.find((c) => c.category === 'hygiene');
  assert.equal(excludeHygiene?.status, 'PASS');
  assert.equal(excludePassReceipt.ok, true);

  // If .env is force-tracked in git, hygiene must still FAIL
  execFileSync('git', ['add', '-f', '.env'], { cwd: tempRepo, stdio: 'ignore' });
  const trackedFailReceipt = await runVerify({ cwd: tempRepo, skipDocker: true });
  const trackedHygiene = trackedFailReceipt.checks.find((c) => c.category === 'hygiene');
  assert.equal(trackedHygiene?.status, 'FAIL');
  assert.equal(trackedFailReceipt.ok, false);
});

test('matchesAllowedPath and runAuditDiff support zero-depth /**/ globs', async (t) => {
  assert.equal(matchesAllowedPath('src/index.js', ['src/**/index.js']), true);
  assert.equal(matchesAllowedPath('src/nested/deep/index.js', ['src/**/index.js']), true);
  assert.equal(matchesAllowedPath('src/other.js', ['src/**/index.js']), false);
  assert.equal(matchesAllowedPath('app.test.js', ['**/*.test.js']), true);
  assert.equal(matchesAllowedPath('tests/unit/app.test.js', ['**/*.test.js']), true);

  const tempRepo = createTempDir(t);
  fs.mkdirSync(path.join(tempRepo, 'src', 'nested'), { recursive: true });
  fs.writeFileSync(path.join(tempRepo, 'src', 'index.js'), 'export const root = 1;\n', 'utf8');
  fs.writeFileSync(
    path.join(tempRepo, 'src', 'nested', 'index.js'),
    'export const nested = 2;\n',
    'utf8'
  );

  const report = await runAuditDiff({
    cwd: tempRepo,
    allFiles: true,
    allowPaths: 'src/**/index.js',
  });
  assert.equal(report.status, 'APPROVE_CANDIDATE');
  assert.equal(report.findings.length, 0);
});
