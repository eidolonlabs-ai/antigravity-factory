import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DEFAULT_PLUGIN_DIR = path.resolve(__dirname, '..');

function resolvePluginSource(pluginSourceDir) {
  if (!pluginSourceDir) {
    return {
      pluginDir: DEFAULT_PLUGIN_DIR,
      pluginsParentDir: path.dirname(DEFAULT_PLUGIN_DIR),
    };
  }

  const resolved = path.resolve(pluginSourceDir);
  const nestedCandidate = path.join(resolved, 'agy-software-factory');
  if (fs.existsSync(nestedCandidate) && fs.statSync(nestedCandidate).isDirectory()) {
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
      const parsed = JSON.parse(fs.readFileSync(pluginsJsonPath, 'utf8'));
      if (parsed && typeof parsed === 'object') {
        data = {
          ...parsed,
          entries: Array.isArray(parsed.entries) ? [...parsed.entries] : [],
        };
      }
    } catch {
      data = { entries: [] };
    }
  }

  const exists = data.entries.some(
    (item) => item && typeof item === 'object' && item.path === entryPath
  );
  if (!exists) {
    data.entries.push({ path: entryPath });
  }

  fs.writeFileSync(pluginsJsonPath, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
}

function ensureGitignoreHasFactory(gitignorePath) {
  let content = '';
  if (fs.existsSync(gitignorePath)) {
    content = fs.readFileSync(gitignorePath, 'utf8');
  }

  const lines = content.split(/\r?\n/).map((line) => line.trim());
  if (lines.includes('.factory/') || lines.includes('.factory')) {
    return;
  }

  const prefix = content.length === 0 || content.endsWith('\n') ? '' : '\n';
  fs.writeFileSync(gitignorePath, `${content}${prefix}.factory/\n`, 'utf8');
}

const VALID_TARGETS = new Set(['agy', 'claude', 'gemini', 'codex', 'all']);

function parseTargets(rawTarget = 'agy') {
  const list = String(rawTarget || 'agy')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  if (list.length === 0) return new Set(['agy']);
  for (const t of list) {
    if (!VALID_TARGETS.has(t)) {
      throw new Error(
        `Invalid init target "${t}". Expected one of: agy, claude, gemini, codex, all.`
      );
    }
  }
  if (list.includes('all')) {
    return new Set(['agy', 'claude', 'gemini', 'codex']);
  }
  return new Set(list);
}

function writeClaudeConfig(resolvedTarget, hookDirRef) {
  const claudeDir = path.join(resolvedTarget, '.claude');
  fs.mkdirSync(claudeDir, { recursive: true });
  const settingsPath = path.join(claudeDir, 'settings.json');
  const guardCmd = `node "${path.join(hookDirRef, 'bin', 'pre-tool-guard.js')}"`;
  const stopCmd = `node "${path.join(hookDirRef, 'bin', 'stop-verify-gate.js')}"`;

  const settings = {
    hooks: {
      PreToolUse: [
        {
          matcher: 'Write|Edit|MultiEdit|Bash',
          hooks: [{ type: 'command', command: guardCmd }],
        },
      ],
      Stop: [
        {
          matcher: '*',
          hooks: [{ type: 'command', command: stopCmd }],
        },
      ],
    },
  };
  fs.writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, 'utf8');

  const claudeMdPath = path.join(resolvedTarget, 'CLAUDE.md');
  if (!fs.existsSync(claudeMdPath)) {
    const claudeMd = [
      '# Claude Code — Software Factory Instructions',
      '',
      '@AGENTS.md',
      '',
      '- Before multi-file edits, inspect or validate `.factory/spec.json` (`agy-factory plan`).',
      '- Run `agy-factory verify --require-tests` and `agy-factory audit-diff` before finishing.',
      '',
    ].join('\n');
    fs.writeFileSync(claudeMdPath, claudeMd, 'utf8');
  }
  return settingsPath;
}

function writeGeminiConfig(resolvedTarget, hookDirRef) {
  const geminiDir = path.join(resolvedTarget, '.gemini');
  fs.mkdirSync(geminiDir, { recursive: true });
  const settingsPath = path.join(geminiDir, 'settings.json');
  const guardCmd = `node "${path.join(hookDirRef, 'bin', 'pre-tool-guard.js')}"`;
  const stopCmd = `node "${path.join(hookDirRef, 'bin', 'stop-verify-gate.js')}"`;

  const settings = {
    hooks: {
      BeforeTool: [
        {
          matcher: '.*',
          hooks: [{ type: 'command', command: guardCmd }],
        },
      ],
      AfterAgent: [
        {
          matcher: '.*',
          hooks: [{ type: 'command', command: stopCmd }],
        },
      ],
    },
  };
  fs.writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, 'utf8');
  return settingsPath;
}

function writeGitPreCommitHook(resolvedTarget, hookDirRef) {
  const gitHooksDir = path.join(resolvedTarget, '.git', 'hooks');
  if (!fs.existsSync(path.join(resolvedTarget, '.git'))) {
    return null;
  }
  fs.mkdirSync(gitHooksDir, { recursive: true });
  const preCommitPath = path.join(gitHooksDir, 'pre-commit');
  const cliPath = path.join(hookDirRef, 'bin', 'agy-factory.js');
  const script = [
    '#!/usr/bin/env sh',
    'set -e',
    `node "${cliPath}" audit-diff --cwd "."`,
    `node "${cliPath}" verify --cwd "."`,
    '',
  ].join('\n');
  fs.writeFileSync(preCommitPath, script, { encoding: 'utf8', mode: 0o755 });
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
 * @param {string} [options.target='agy']
 * @param {string} [options.pluginSourceDir]
 */
export function runInit({
  targetDir,
  cwd,
  mode = 'link',
  target = 'agy',
  pluginSourceDir,
} = {}) {
  if (mode !== 'link' && mode !== 'copy') {
    throw new Error(`Invalid init mode "${mode}". Expected "link" or "copy".`);
  }

  const targets = parseTargets(target);
  const resolvedTarget = path.resolve(targetDir || cwd || process.cwd());
  fs.mkdirSync(resolvedTarget, { recursive: true });

  const { pluginDir, pluginsParentDir } = resolvePluginSource(pluginSourceDir);
  if (!fs.existsSync(pluginDir)) {
    throw new Error(`Plugin source directory does not exist: ${pluginDir}`);
  }

  const pluginsJsonPath = path.join(resolvedTarget, '.agents', 'plugins.json');
  const destPluginDir = path.join(
    resolvedTarget,
    '.agents',
    'plugins',
    'agy-software-factory'
  );

  if (mode === 'copy') {
    const srcReal = fs.realpathSync(pluginDir);
    const destReal = fs.existsSync(destPluginDir) ? fs.realpathSync(destPluginDir) : null;
    if (srcReal !== destReal) {
      fs.mkdirSync(path.dirname(destPluginDir), { recursive: true });
      fs.cpSync(pluginDir, destPluginDir, {
        recursive: true,
        force: true,
        filter: (src) => {
          const base = path.basename(src);
          return base !== 'node_modules' && base !== '.DS_Store';
        },
      });
    }
  }

  if (targets.has('agy')) {
    if (mode === 'link') {
      upsertPluginsJson(pluginsJsonPath, pluginsParentDir);
    } else {
      upsertPluginsJson(pluginsJsonPath, '.agents/plugins');
    }
  }

  const effectivePluginRef =
    mode === 'copy' ? '.agents/plugins/agy-software-factory' : pluginDir;

  const targetConfigs = {};
  if (targets.has('claude')) {
    targetConfigs.claudeSettingsPath = writeClaudeConfig(resolvedTarget, effectivePluginRef);
  }
  if (targets.has('gemini')) {
    targetConfigs.geminiSettingsPath = writeGeminiConfig(resolvedTarget, effectivePluginRef);
  }
  if (targets.has('codex')) {
    targetConfigs.gitPreCommitPath = writeGitPreCommitHook(resolvedTarget, effectivePluginRef);
  }

  ensureGitignoreHasFactory(path.join(resolvedTarget, '.gitignore'));

  const factoryConfigPath = path.join(resolvedTarget, '.factory.json');
  if (!fs.existsSync(factoryConfigPath)) {
    const defaultConfig = {
      enforceStopVerify: false,
      requireTests: true,
    };
    fs.writeFileSync(
      factoryConfigPath,
      `${JSON.stringify(defaultConfig, null, 2)}\n`,
      'utf8'
    );
  }

  return {
    targetDir: resolvedTarget,
    mode,
    targets: [...targets],
    pluginsJsonPath: targets.has('agy') ? pluginsJsonPath : null,
    factoryConfigPath,
    ...targetConfigs,
  };
}
