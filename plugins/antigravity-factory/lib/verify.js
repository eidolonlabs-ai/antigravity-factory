import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { detectProject } from "./detect.js";
import { loadFactoryPolicy, hash, within } from "./policy.js";
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

const HYGIENE_SKIP_DIRS = new Set([
  ".git",
  ".factory",
  "node_modules",
  "dist",
  "build",
  "coverage",
  "__pycache__",
]);

function isEnvSecretBasename(baseName) {
  const lower = baseName.toLowerCase();
  if (ALLOWED_ENV_TEMPLATES.has(lower)) return false;
  return lower === ".env" || lower.startsWith(".env.");
}

function gitignoreCoversEnv(gitignorePath, relPath = ".env") {
  if (!fs.existsSync(gitignorePath) || !fs.statSync(gitignorePath).isFile()) {
    return false;
  }
  const baseName = path.posix.basename(relPath);
  const isRoot = !relPath.includes("/");
  const lines = fs.readFileSync(gitignorePath, "utf8").split(/\r?\n/);
  let ignored = false;
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    if (line === `!.env` || line === `!/.env` || line === `!${baseName}` || line === `!${relPath}`) {
      ignored = false;
      continue;
    }
    if (
      line === ".env*" ||
      line === "**/.env*" ||
      (isRoot && line === "/.env*") ||
      (baseName === ".env" &&
        (line === ".env" ||
          line === "**/.env" ||
          line === "*.env" ||
          (isRoot && line === "/.env"))) ||
      (baseName !== ".env" &&
        (line === ".env.*" ||
          line === "**/.env.*" ||
          line === baseName ||
          line === relPath ||
          (isRoot && (line === "/.env.*" || line === `/${baseName}`))))
    ) {
      ignored = true;
    }
  }
  return ignored;
}

function findEnvFiles(rootDir, currentDir = rootDir, acc = []) {
  const entries = fs.readdirSync(currentDir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      if (HYGIENE_SKIP_DIRS.has(entry.name)) continue;
      findEnvFiles(rootDir, path.join(currentDir, entry.name), acc);
    } else if (entry.isFile() && isEnvSecretBasename(entry.name)) {
      acc.push(
        path.relative(rootDir, path.join(currentDir, entry.name)).split(path.sep).join("/"),
      );
    }
  }
  return acc;
}

function isSensitiveTrackedFile(relFilePath) {
  const base = path.posix.basename(relFilePath.replace(/\\/g, "/")).toLowerCase();
  if (ALLOWED_ENV_TEMPLATES.has(base)) return false;
  if (base === ".env" || base.startsWith(".env.")) return true;
  if (
    base === "id_rsa" ||
    base === "id_ed25519" ||
    base === "id_ecdsa" ||
    base === "id_dsa"
  )
    return true;
  if (base.endsWith(".pem") || base.endsWith(".key")) return true;
  return false;
}

function runHygieneCheck(resolvedCwd) {
  const start = Date.now();
  const issues = [];

  const inGitWorkTree = isGitWorkTree(resolvedCwd);
  const gitignorePath = path.join(resolvedCwd, ".gitignore");
  const envFiles = findEnvFiles(resolvedCwd).sort();

  for (const relEnv of envFiles) {
    const isIgnoredByGit =
      inGitWorkTree &&
      runGit(["check-ignore", "-q", "--no-index", "--", relEnv], resolvedCwd)
        .status === 0;
    if (!isIgnoredByGit && !gitignoreCoversEnv(gitignorePath, relEnv)) {
      issues.push(
        `${relEnv} exists in workspace without a .gitignore entry ignoring it`,
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
  { autoInstall = baseEnv.FACTORY_AUTO_INSTALL === "1" } = {},
) {
  if (!autoInstall) return null;
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

function isExternalComposePath(rawSrc, realRoot) {
  if (!rawSrc || typeof rawSrc !== "string") return false;
  if (rawSrc.startsWith("~") || rawSrc.split(/[\\/]/).includes("..")) {
    return true;
  }
  if (!realRoot) {
    return (
      rawSrc.startsWith("/etc") ||
      rawSrc.startsWith("/var") ||
      rawSrc.startsWith("/run") ||
      rawSrc.startsWith("/dev") ||
      rawSrc.startsWith("/root")
    );
  }
  const absCandidate = path.isAbsolute(rawSrc)
    ? path.resolve(rawSrc)
    : path.resolve(realRoot, rawSrc);
  let resolved = absCandidate;
  try {
    if (fs.existsSync(absCandidate)) {
      resolved = fs.realpathSync(absCandidate);
    } else if (fs.existsSync(path.dirname(absCandidate))) {
      resolved = path.join(
        fs.realpathSync(path.dirname(absCandidate)),
        path.basename(absCandidate),
      );
    }
  } catch {
    return true;
  }
  return !within(realRoot, resolved);
}

export function inspectComposeIsolation(resolvedModel, { workspaceRoot } = {}) {
  const problems = [];
  const services = resolvedModel?.services;
  const realRoot = workspaceRoot
    ? (() => {
        try {
          return fs.realpathSync(workspaceRoot);
        } catch {
          return path.resolve(workspaceRoot);
        }
      })()
    : null;

  const topVolumes = resolvedModel?.volumes;
  if (topVolumes && typeof topVolumes === "object") {
    for (const [volName, volCfg] of Object.entries(topVolumes)) {
      const opts = volCfg?.driver_opts;
      if (opts && typeof opts === "object") {
        const device = String(opts.device || "");
        const o = String(opts.o || "");
        if (device.includes("docker.sock") || o.includes("docker.sock")) {
          problems.push(`volume ${volName}: docker.sock driver_opts is not allowed`);
        } else if (device && isExternalComposePath(device, realRoot)) {
          problems.push(`volume ${volName}: external device bind "${device}" escapes workspace`);
        }
      }
    }
  }

  if (!services || typeof services !== "object") return problems;
  for (const [name, svc] of Object.entries(services)) {
    if (!svc || typeof svc !== "object") continue;
    if (svc.container_name) {
      problems.push(`${name}: fixed container_name collides across parallel runs`);
    }
    if (svc.privileged) {
      problems.push(`${name}: privileged containers are not allowed`);
    }
    for (const hostKey of ["pid", "ipc", "uts", "cgroup", "userns_mode"]) {
      const val = svc[hostKey];
      if (
        val === "host" ||
        (typeof val === "string" && val.startsWith("container:"))
      ) {
        problems.push(
          `${name}: ${hostKey} "${val}" namespace sharing is not allowed`,
        );
      }
    }
    if (
      svc.network_mode === "host" ||
      (typeof svc.network_mode === "string" && svc.network_mode.startsWith("container:"))
    ) {
      problems.push(`${name}: network_mode "${svc.network_mode}" is not allowed`);
    }
    if (Array.isArray(svc.cap_add) && svc.cap_add.length > 0) {
      problems.push(`${name}: cap_add (${svc.cap_add.join(", ")}) is not allowed`);
    }
    if (Array.isArray(svc.security_opt)) {
      for (const opt of svc.security_opt) {
        if (/unconfined|label[:=]disable/i.test(String(opt))) {
          problems.push(`${name}: unsafe security_opt "${opt}" is not allowed`);
        }
      }
    }
    if (Array.isArray(svc.devices) && svc.devices.length > 0) {
      problems.push(`${name}: host devices mapping is not allowed`);
    }
    if (Array.isArray(svc.volumes_from) && svc.volumes_from.length > 0) {
      problems.push(`${name}: volumes_from is not allowed`);
    }
    if (realRoot && svc.build) {
      const ctx = typeof svc.build === "string" ? svc.build : svc.build?.context;
      if (typeof ctx === "string" && !/^https?:\/\//i.test(ctx) && isExternalComposePath(ctx, realRoot)) {
        problems.push(`${name}: build context "${ctx}" escapes workspace`);
      }
    }
    const envFiles = Array.isArray(svc.env_file)
      ? svc.env_file
      : svc.env_file
        ? [svc.env_file]
        : [];
    for (const ef of envFiles) {
      const efPath = typeof ef === "string" ? ef : ef?.path;
      if (typeof efPath === "string" && isExternalComposePath(efPath, realRoot)) {
        problems.push(`${name}: env_file "${efPath}" escapes workspace`);
      }
    }
    for (const vol of Array.isArray(svc.volumes) ? svc.volumes : []) {
      const isObj = vol && typeof vol === "object";
      const src = isObj ? String(vol.source || "") : String(vol).split(":")[0];
      if (src.includes("docker.sock")) {
        problems.push(`${name}: mounting docker.sock is not allowed (${src})`);
        continue;
      }
      const isBind =
        (isObj && vol.type === "bind") ||
        (!isObj &&
          (src.startsWith("/") ||
            src.startsWith(".") ||
            src.startsWith("~") ||
            src.includes("/") ||
            src.includes("\\")));
      if (isBind && isExternalComposePath(src, realRoot)) {
        problems.push(`${name}: bind mount "${src}" escapes workspace`);
      }
    }
  }
  return problems;
}

function runComposeSubcommand(args, cwd, timeoutMs, baseEnv) {
  const start = Date.now();
  const res = spawnSync("docker", args, {
    cwd,
    encoding: "utf8",
    timeout: timeoutMs,
    maxBuffer: 10 * 1024 * 1024,
    env: baseEnv,
  });
  const durationMs = Date.now() - start;
  const combined = [res.stdout || "", res.stderr || ""]
    .filter(Boolean)
    .join("\n")
    .trim();
  return {
    ok: res.status === 0 && !res.error,
    durationMs,
    stdout: (res.stdout || "").trim(),
    output: combined.length > 4000 ? combined.slice(-4000) : combined,
  };
}

function runDockerComposeCheck(project, resolvedCwd, env) {
  const composeFile = project.dockerComposeFile;
  const cmdDisplay = `docker compose -f ${composeFile} config --quiet`;
  const res = runComposeSubcommand(
    ["compose", "-f", composeFile, "config", "--quiet"],
    resolvedCwd,
    30_000,
    env,
  );
  if (!res.ok) {
    return {
      id: "docker-compose",
      category: "docker-compose",
      component: "workspace",
      status: "FAIL",
      command: cmdDisplay,
      durationMs: res.durationMs,
      output: res.output || "docker compose config failed.",
    };
  }
  const jsonRes = runComposeSubcommand(
    ["compose", "-f", composeFile, "config", "--format", "json"],
    resolvedCwd,
    30_000,
    env,
  );
  if (jsonRes.ok) {
    let model;
    try {
      model = JSON.parse(jsonRes.stdout || jsonRes.output);
    } catch {
      return {
        id: "docker-compose",
        category: "docker-compose",
        component: "workspace",
        status: "FAIL",
        command: `docker compose -f ${composeFile} config --format json`,
        durationMs: res.durationMs + jsonRes.durationMs,
        output: "Invalid JSON output from docker compose config --format json",
      };
    }
    const problems = inspectComposeIsolation(model, { workspaceRoot: resolvedCwd });
    if (problems.length > 0) {
      return {
        id: "docker-compose",
        category: "docker-compose",
        component: "workspace",
        status: "FAIL",
        command: `docker compose -f ${composeFile} config --format json`,
        durationMs: res.durationMs + jsonRes.durationMs,
        output: `Compose isolation violation(s): ${problems.join("; ")}`,
      };
    }
  }
  return {
    id: "docker-compose",
    category: "docker-compose",
    component: "workspace",
    status: "PASS",
    command: cmdDisplay,
    durationMs: res.durationMs,
    output: res.output || `${project.dockerComposeFile} is valid.`,
  };
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

  // b) Optional Docker Compose syntax & isolation check
  if (
    project.hasDockerCompose &&
    !skipDocker &&
    isDockerComposeAvailable(env)
  ) {
    checks.push(runDockerComposeCheck(project, resolvedCwd, env));
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
    const matching = checks.filter(
      (c) =>
        c.componentPath === required.component &&
        c.category === required.category,
    );
    if (matching.length === 0 || matching.some((c) => c.status !== "PASS")) {
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
