import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { detectProject } from "./detect.js";
import { loadFactoryPolicy, hash } from "./policy.js";
import { writeRecord } from "./records.js";
import { snapshotWorkspace } from "./workspace.js";

const CATEGORIES = ["lint", "typecheck", "test", "build"];
const ALLOWED_ENV_TEMPLATES = new Set([
  ".env.example",
  ".env.sample",
  ".env.template",
  ".env.test",
]);

function runGit(args, cwd) {
  return spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    timeout: 15_000,
    maxBuffer: 10 * 1024 * 1024,
  });
}

function isGitWorkTree(cwd) {
  const res = runGit(["rev-parse", "--is-inside-work-tree"], cwd);
  return res.status === 0 && res.stdout.trim() === "true";
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
  const gitState = snapshotWorkspace(resolvedCwd);
  return gitState ? gitState.hasChanges : false;
}

/**
 * Computes a deterministic SHA-256 hex digest of the workspace state, ignoring `.factory/`.
 *
 * @param {string} [cwd=process.cwd()]
 * @returns {string}
 */
export function computeWorkspaceDigest(cwd = process.cwd()) {
  return snapshotWorkspace(cwd).digest;
}

function gitignoreCoversEnv(gitignorePath) {
  if (!fs.existsSync(gitignorePath) || !fs.statSync(gitignorePath).isFile()) {
    return false;
  }
  const lines = fs.readFileSync(gitignorePath, "utf8").split(/\r?\n/);
  let ignored = false;
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    if (
      line === ".env" ||
      line === "/.env" ||
      line === ".env*" ||
      line === "/.env*" ||
      line === "*.env" ||
      line === "**/.env"
    ) {
      ignored = true;
    } else if (line === "!.env" || line === "!/.env") {
      ignored = false;
    }
  }
  return ignored;
}

function isSensitiveTrackedFile(relFilePath) {
  const base = path.posix.basename(relFilePath.replace(/\\/g, "/"));
  if (ALLOWED_ENV_TEMPLATES.has(base)) return false;
  if (base === ".env" || base.startsWith(".env.")) return true;
  if (base === "id_rsa" || base === "id_ed25519") return true;
  if (base.endsWith(".pem") || base.endsWith(".key")) return true;
  return false;
}

function runHygieneCheck(resolvedCwd) {
  const start = Date.now();
  const issues = [];

  const inGitWorkTree = isGitWorkTree(resolvedCwd);

  const envPath = path.join(resolvedCwd, ".env");
  const gitignorePath = path.join(resolvedCwd, ".gitignore");
  if (fs.existsSync(envPath) && fs.statSync(envPath).isFile()) {
    const isIgnoredByGit =
      inGitWorkTree &&
      runGit(["check-ignore", "-q", "--no-index", ".env"], resolvedCwd)
        .status === 0;
    if (!gitignoreCoversEnv(gitignorePath) && !isIgnoredByGit) {
      issues.push(
        ".env exists in workspace without a .gitignore entry ignoring .env",
      );
    }
  }

  if (inGitWorkTree) {
    const lsRes = runGit(["ls-files"], resolvedCwd);
    if (lsRes.status === 0) {
      const tracked = lsRes.stdout
        .split(/\r?\n/)
        .map((s) => s.trim())
        .filter(Boolean);
      const trackedSecrets = tracked.filter(isSensitiveTrackedFile);
      if (trackedSecrets.length > 0) {
        issues.push(
          `Sensitive files tracked in git: ${trackedSecrets.join(", ")}`,
        );
      }
    }
  }

  const durationMs = Date.now() - start;
  if (issues.length > 0) {
    return {
      id: "hygiene",
      category: "hygiene",
      component: "workspace",
      status: "FAIL",
      command: null,
      durationMs,
      output: issues.join("; "),
    };
  }

  return {
    id: "hygiene",
    category: "hygiene",
    component: "workspace",
    status: "PASS",
    command: null,
    durationMs,
    output: "Workspace hygiene check passed.",
  };
}

function execShellCommand(
  command,
  cwd,
  timeoutMs = 120_000,
  baseEnv = process.env,
) {
  const start = Date.now();
  const childEnv = {
    ...baseEnv,
    CI: baseEnv.CI || "true",
    PYTHONDONTWRITEBYTECODE: "1",
  };
  // node:test's internal context would otherwise suppress nested test runners.
  delete childEnv.NODE_TEST_CONTEXT;
  const res = spawnSync(command, {
    cwd,
    shell: true,
    encoding: "utf8",
    timeout: timeoutMs,
    maxBuffer: 10 * 1024 * 1024,
    env: childEnv,
  });
  const durationMs = Date.now() - start;
  const combined = [res.stdout || "", res.stderr || ""]
    .filter(Boolean)
    .join("\n")
    .trim();
  const output = combined.length > 4000 ? combined.slice(-4000) : combined;
  const ok = res.status === 0 && !res.error;
  const errMsg = res.error ? res.error.message : "";

  return {
    ok,
    durationMs,
    output: output || errMsg,
  };
}

function isDockerComposeAvailable(baseEnv = process.env) {
  const res = spawnSync("docker", ["compose", "version"], {
    stdio: "ignore",
    timeout: 5_000,
    env: baseEnv,
  });
  return res.status === 0 && !res.error;
}

function ensureNodeDependenciesIfNeeded(
  component,
  resolvedCwd,
  baseEnv = process.env,
) {
  if (component.type !== "node") return null;
  const pkgPath = path.join(component.path, "package.json");
  if (!fs.existsSync(pkgPath)) return null;

  let pkg;
  try {
    pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
  } catch {
    return null;
  }

  const hasDeps =
    (pkg.dependencies && Object.keys(pkg.dependencies).length > 0) ||
    (pkg.devDependencies && Object.keys(pkg.devDependencies).length > 0);
  const localNodeModules = path.join(component.path, "node_modules");
  let hasRootWorkspaceModules = false;
  if (resolvedCwd && component.path !== resolvedCwd) {
    const rootNodeModules = path.join(resolvedCwd, "node_modules");
    if (fs.existsSync(rootNodeModules)) {
      const rootPkgPath = path.join(resolvedCwd, "package.json");
      const hasPnpmWorkspace = fs.existsSync(
        path.join(resolvedCwd, "pnpm-workspace.yaml"),
      );
      let hasPkgWorkspaces = false;
      if (fs.existsSync(rootPkgPath)) {
        try {
          const rootPkg = JSON.parse(fs.readFileSync(rootPkgPath, "utf8"));
          hasPkgWorkspaces = Boolean(rootPkg?.workspaces);
        } catch {
          hasPkgWorkspaces = false;
        }
      }
      hasRootWorkspaceModules = hasPnpmWorkspace || hasPkgWorkspaces;
    }
  }
  const hasInstalledModules =
    fs.existsSync(localNodeModules) || hasRootWorkspaceModules;

  if (hasDeps && !hasInstalledModules) {
    const pm = component.packageManager || "npm";
    const installCmd =
      pm === "pnpm"
        ? "pnpm install"
        : pm === "yarn"
          ? "yarn install"
          : pm === "bun"
            ? "bun install"
            : "npm install --no-audit --no-fund";
    const installRes = execShellCommand(
      installCmd,
      component.path,
      180_000,
      baseEnv,
    );
    if (!installRes.ok) {
      return `${pm} install failed: ${installRes.output}`;
    }
  }
  return null;
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
  const policy = loadFactoryPolicy(resolvedCwd);
  const effectiveRequireTests = requireTests ?? policy.requireTests;
  const startDigest = computeWorkspaceDigest(resolvedCwd);
  const project = detectProject(resolvedCwd);
  const checks = [];

  // a) Hygiene check
  checks.push(runHygieneCheck(resolvedCwd));

  // b) Optional Docker Compose syntax check
  if (
    project.hasDockerCompose &&
    !skipDocker &&
    isDockerComposeAvailable(env)
  ) {
    const cmd = "docker compose config --quiet";
    const res = execShellCommand(cmd, resolvedCwd, 30_000, env);
    checks.push({
      id: "docker-compose",
      category: "docker-compose",
      component: "workspace",
      status: res.ok ? "PASS" : "FAIL",
      command: cmd,
      durationMs: res.durationMs,
      output:
        res.output ||
        (res.ok
          ? `${project.dockerComposeFile} is valid.`
          : "docker compose config failed."),
    });
  } else {
    checks.push({
      id: "docker-compose",
      category: "docker-compose",
      component: "workspace",
      status: "NOT_RUN",
      command: project.hasDockerCompose
        ? "docker compose config --quiet"
        : null,
      durationMs: 0,
      output: !project.hasDockerCompose
        ? "No docker-compose file detected"
        : skipDocker
          ? "Skipped (--skip-docker)"
          : "Docker Compose CLI not installed (optional check skipped)",
    });
  }

  // c) Per-component checks (lint, typecheck, test, build)
  const usedCompLabels = new Set();
  const childRelPaths = new Set(
    project.components.filter((c) => c.relPath !== ".").map((c) => c.relPath),
  );
  for (const component of project.components) {
    let compLabel =
      component.relPath === "." ? component.name : component.relPath;
    if (component.relPath === "." && childRelPaths.has(compLabel)) {
      compLabel = `root:${compLabel}`;
    }
    if (usedCompLabels.has(compLabel)) {
      compLabel = `${compLabel}(${component.type})`;
    }
    usedCompLabels.add(compLabel);
    const hasAnyConfiguredCommand = CATEGORIES.some((cat) =>
      Boolean(component.commands?.[cat]),
    );
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
          componentPath: component.relPath,
          status: "NOT_RUN",
          command: null,
          durationMs: 0,
          output: "No script configured",
        });
        continue;
      }

      if (installError) {
        checks.push({
          id: checkId,
          category,
          component: compLabel,
          componentPath: component.relPath,
          status: "FAIL",
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
        componentPath: component.relPath,
        status: res.ok ? "PASS" : "FAIL",
        command: cmd,
        durationMs: res.durationMs,
        output: res.output,
      });
    }
  }

  for (const command of policy.verification.commands) {
    const result = execShellCommand(
      command.command,
      path.resolve(resolvedCwd, command.cwd),
      command.timeoutMs,
      env,
    );
    checks.push({
      id: `custom:${command.id}`,
      category: "custom",
      component: "workspace",
      status: result.ok ? "PASS" : "FAIL",
      command: command.command,
      output: result.output,
      durationMs: result.durationMs,
      providesEvidence: command.providesEvidence,
    });
  }
  for (const required of policy.verification.requiredChecks) {
    if (
      !checks.some(
        (c) =>
          c.componentPath === required.component &&
          c.category === required.category &&
          c.status === "PASS",
      )
    ) {
      checks.push({
        id: `required:${required.component}:${required.category}`,
        component: required.component,
        category: "policy",
        status: "FAIL",
        durationMs: 0,
        output: "Required check missing, skipped, or failed",
      });
    }
  }
  const digest = computeWorkspaceDigest(resolvedCwd);
  if (
    digest !== startDigest ||
    loadFactoryPolicy(resolvedCwd).policyDigest !== policy.policyDigest
  )
    checks.push({
      id: "subject-changed",
      component: "workspace",
      category: "freshness",
      status: "FAIL",
      durationMs: 0,
      output:
        "Workspace or policy changed during verification. Run verification again.",
    });
  const summary = {
    pass: checks.filter((c) => c.status === "PASS").length,
    fail: checks.filter((c) => c.status === "FAIL").length,
    notRun: checks.filter((c) => c.status === "NOT_RUN").length,
  };

  const hasPassingTests = checks.some(
    (c) => c.category === "test" && c.status === "PASS",
  );
  const ok = summary.fail === 0 && (!effectiveRequireTests || hasPassingTests);

  const timestamp = new Date().toISOString();

  const receipt = {
    schemaVersion: 1,
    pluginVersion: JSON.parse(
      fs.readFileSync(new URL("../plugin.json", import.meta.url), "utf8"),
    ).version,
    workspaceIdentity: hash(fs.realpathSync(resolvedCwd)),
    subjectDigest: digest,
    policyDigest: policy.policyDigest,
    timestamp,
    cwd: resolvedCwd,
    digest,
    ok,
    requireTests: Boolean(effectiveRequireTests),
    summary,
    checks,
  };

  writeRecord(resolvedCwd, "verify-receipt.json", receipt);

  return receipt;
}
