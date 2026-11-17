import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { prepareCopy } from "./install-copy.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DEFAULT_PLUGIN_DIR = path.resolve(__dirname, "..");

function resolvePluginSource(pluginSourceDir) {
  if (!pluginSourceDir) {
    return {
      pluginDir: DEFAULT_PLUGIN_DIR,
      pluginsParentDir: path.dirname(DEFAULT_PLUGIN_DIR),
    };
  }

  const resolved = path.resolve(pluginSourceDir);
  const nestedCandidate = path.join(resolved, "agy-software-factory");
  if (
    fs.existsSync(nestedCandidate) &&
    fs.statSync(nestedCandidate).isDirectory()
  ) {
    return {
      pluginDir: nestedCandidate,
      pluginsParentDir: resolved,
    };
  }

  return {
    pluginDir: resolved,
    pluginsParentDir: path.dirname(resolved),
  };
}

function upsertPluginsJson(pluginsJsonPath, entryPath) {
  fs.mkdirSync(path.dirname(pluginsJsonPath), { recursive: true });

  let data = { entries: [] };
  if (fs.existsSync(pluginsJsonPath)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(pluginsJsonPath, "utf8"));
      if (parsed && typeof parsed === "object") {
        data = {
          ...parsed,
          entries: Array.isArray(parsed.entries) ? [...parsed.entries] : [],
        };
      }
    } catch (error) {
      throw new Error(`Invalid plugin registration JSON: ${error.message}`);
    }
  }

  const exists = data.entries.some(
    (item) => item && typeof item === "object" && item.path === entryPath,
  );
  if (!exists) {
    data.entries.push({ path: entryPath });
  }

  fs.writeFileSync(
    pluginsJsonPath,
    `${JSON.stringify(data, null, 2)}\n`,
    "utf8",
  );
}

function ensureGitignoreHasFactory(gitignorePath) {
  let content = "";
  if (fs.existsSync(gitignorePath)) {
    content = fs.readFileSync(gitignorePath, "utf8");
  }

  const lines = content.split(/\r?\n/).map((line) => line.trim());
  if (lines.includes(".factory/") || lines.includes(".factory")) {
    return;
  }

  const prefix = content.length === 0 || content.endsWith("\n") ? "" : "\n";
  fs.writeFileSync(gitignorePath, `${content}${prefix}.factory/\n`, "utf8");
}

function resolveGitHooksDir(resolvedTarget) {
  const dotGitPath = path.join(resolvedTarget, ".git");
  if (!fs.existsSync(dotGitPath)) {
    return null;
  }
  const stat = fs.statSync(dotGitPath);
  if (stat.isDirectory()) {
    return path.join(dotGitPath, "hooks");
  }
  if (stat.isFile()) {
    const content = fs.readFileSync(dotGitPath, "utf8");
    const match = content.match(/^gitdir:\s*(.+)$/m);
    if (!match) {
      return null;
    }
    const gitDir = path.resolve(resolvedTarget, match[1].trim());
    const commonDirFile = path.join(gitDir, "commondir");
    if (fs.existsSync(commonDirFile)) {
      const commonRel = fs.readFileSync(commonDirFile, "utf8").trim();
      if (commonRel) {
        return path.join(path.resolve(gitDir, commonRel), "hooks");
      }
    }
    return path.join(gitDir, "hooks");
  }
  return null;
}

function writeGitPreCommitHook(resolvedTarget, hookDirRef) {
  const gitHooksDir = resolveGitHooksDir(resolvedTarget);
  if (!gitHooksDir) {
    return null;
  }
  fs.mkdirSync(gitHooksDir, { recursive: true });
  const preCommitPath = path.join(gitHooksDir, "pre-commit");
  const cliPath = path.join(hookDirRef, "bin", "agy-factory.js");
  const gateLines = [
    `node "${cliPath}" audit-diff --cwd "."`,
    `node "${cliPath}" verify --cwd "."`,
  ];

  if (fs.existsSync(preCommitPath)) {
    const existing = fs.readFileSync(preCommitPath, "utf8");
    if (!existing.includes("agy-factory.js")) {
      const sep = existing.endsWith("\n") ? "" : "\n";
      const updated = `${existing}${sep}${gateLines.join("\n")}\n`;
      fs.writeFileSync(preCommitPath, updated, {
        encoding: "utf8",
        mode: 0o755,
      });
      fs.chmodSync(preCommitPath, 0o755);
    }
    return preCommitPath;
  }

  const script = ["#!/usr/bin/env sh", "set -e", ...gateLines, ""].join("\n");
  fs.writeFileSync(preCommitPath, script, { encoding: "utf8", mode: 0o755 });
  fs.chmodSync(preCommitPath, 0o755);
  return preCommitPath;
}

/**
 * Installs or links the `agy-software-factory` plugin into `targetDir`.
 *
 * @param {object} [options]
 * @param {string} [options.targetDir=process.cwd()]
 * @param {string} [options.cwd]
 * @param {'link'|'copy'} [options.mode='link']
 * @param {'agy'} [options.target='agy']
 * @param {boolean} [options.gitHook=false] Install the optional Git verification hook.
 * @param {string} [options.pluginSourceDir]
 */
export function runInit({
  targetDir,
  cwd,
  mode = "link",
  target = "agy",
  gitHook = false,
  pluginSourceDir,
} = {}) {
  if (mode !== "link" && mode !== "copy") {
    throw new Error(`Invalid init mode "${mode}". Expected "link" or "copy".`);
  }

  if (target !== "agy") {
    throw new Error(
      `Invalid init target "${target}". Only Antigravity (agy) is supported.`,
    );
  }
  const resolvedTarget = path.resolve(targetDir || cwd || process.cwd());
  fs.mkdirSync(resolvedTarget, { recursive: true });

  const { pluginDir, pluginsParentDir } = resolvePluginSource(pluginSourceDir);
  if (!fs.existsSync(pluginDir)) {
    throw new Error(`Plugin source directory does not exist: ${pluginDir}`);
  }

  for (const rel of [
    ".agents",
    ".agents/plugins",
    ".agents/plugins/agy-software-factory",
    ".agents/plugins.json",
    ".factory",
    ".factory.json",
    ".gitignore",
  ]) {
    try {
      if (fs.lstatSync(path.join(resolvedTarget, rel)).isSymbolicLink())
        throw new Error(`Refusing symlink installation path: ${rel}`);
    } catch (e) {
      if (e.code !== "ENOENT") throw e;
    }
  }
  const pluginsJsonPath = path.join(resolvedTarget, ".agents", "plugins.json");
  const destPluginDir = path.join(
    resolvedTarget,
    ".agents",
    "plugins",
    "agy-software-factory",
  );

  // Validate existing registration before copying or changing any managed files.
  if (fs.existsSync(pluginsJsonPath)) {
    let registration;
    try {
      registration = JSON.parse(fs.readFileSync(pluginsJsonPath, "utf8"));
    } catch (e) {
      throw new Error(`Invalid plugin registration JSON: ${e.message}`);
    }
    if (
      !registration ||
      typeof registration !== "object" ||
      Array.isArray(registration) ||
      !Array.isArray(registration.entries)
    )
      throw new Error("Invalid plugin registration manifest");
  }
  const restorePaths = [
    ".agents/plugins.json",
    ".factory.json",
    ".gitignore",
  ].map((rel) => path.join(resolvedTarget, rel));
  if (gitHook) {
    const hooksDir = resolveGitHooksDir(resolvedTarget);
    if (hooksDir) restorePaths.push(path.join(hooksDir, "pre-commit"));
  }
  const originals = restorePaths.map((p) => ({
    path: p,
    exists: fs.existsSync(p),
    data: fs.existsSync(p) ? fs.readFileSync(p) : null,
    mode: fs.existsSync(p) ? fs.statSync(p).mode & 0o777 : 0o644,
  }));
  let copyTransaction = null;
  if (mode === "copy") {
    const srcReal = fs.realpathSync(pluginDir);
    const destReal = fs.existsSync(destPluginDir)
      ? fs.realpathSync(destPluginDir)
      : null;
    if (srcReal !== destReal) {
      copyTransaction = prepareCopy(resolvedTarget, pluginDir, destPluginDir);
    }
  }

  try {
    upsertPluginsJson(
      pluginsJsonPath,
      mode === "link" ? pluginsParentDir : ".agents/plugins",
    );

    const effectivePluginRef =
      mode === "copy" ? ".agents/plugins/agy-software-factory" : pluginDir;

    const targetConfigs = {};
    if (gitHook) {
      targetConfigs.gitPreCommitPath = writeGitPreCommitHook(
        resolvedTarget,
        effectivePluginRef,
      );
    }

    ensureGitignoreHasFactory(path.join(resolvedTarget, ".gitignore"));

    const factoryConfigPath = path.join(resolvedTarget, ".factory.json");
    if (!fs.existsSync(factoryConfigPath)) {
      const defaultConfig = {
        enforceStopVerify: false,
        requireTests: true,
      };
      fs.writeFileSync(
        factoryConfigPath,
        `${JSON.stringify(defaultConfig, null, 2)}\n`,
        "utf8",
      );
    }

    const cleanup = copyTransaction ? copyTransaction.commit() : {};
    return {
      targetDir: resolvedTarget,
      mode,
      targets: ["agy"],
      pluginsJsonPath,
      factoryConfigPath,
      ...targetConfigs,
      ...cleanup,
    };
  } catch (error) {
    if (copyTransaction) copyTransaction.rollback();
    for (const original of originals) {
      if (original.exists)
        fs.writeFileSync(original.path, original.data, { mode: original.mode });
      else fs.rmSync(original.path, { force: true });
    }
    throw error;
  }
}
