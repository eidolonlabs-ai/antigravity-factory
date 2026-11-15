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

function upsertHookSettingsJson(settingsPath, eventEntries) {
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });

  let settings = {};
  if (fs.existsSync(settingsPath)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        settings = { ...parsed };
      }
    } catch {
      settings = {};
    }
  }

  const hooksObj =
    settings.hooks && typeof settings.hooks === 'object' && !Array.isArray(settings.hooks)
      ? { ...settings.hooks }
      : {};

  for (const [eventName, { matcher, command }] of eventEntries) {
    const existingList = Array.isArray(hooksObj[eventName])
      ? [...hooksObj[eventName]]
      : [];
    const alreadyRegistered = existingList.some(
      (entry) =>
        entry &&
        typeof entry === 'object' &&
        Array.isArray(entry.hooks) &&
        entry.hooks.some((h) => h && typeof h === 'object' && h.command === command)
    );
    if (!alreadyRegistered) {
      existingList.push({
        matcher,
        hooks: [{ type: 'command', command }],
      });
    }
    hooksObj[eventName] = existingList;
  }

  settings.hooks = hooksObj;
  fs.writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, 'utf8');
}

function buildAgentInstructionsMarkdown(title, resolvedTarget, hookDirRef) {
  const normRef = hookDirRef.split(path.sep).join('/');
  const hasRootAgentsMd = fs.existsSync(path.join(resolvedTarget, 'AGENTS.md'));
  const rulesImport = hasRootAgentsMd
    ? '@AGENTS.md'
    : `@${path.posix.join(normRef, 'rules', 'AGENTS.md')}`;
  const cliPath = path.posix.join(normRef, 'bin', 'agy-factory.js');
  const skillsDir = path.posix.join(normRef, 'skills');

  return [
    `# ${title}`,
    '',
    rulesImport,
    '',
    '## Software Factory CLI & Stage Playbooks',
    '',
    `- **Stage 1 (Plan)**: Read \`${skillsDir}/factory-spec-planner/SKILL.md\`, run \`node "${cliPath}" detect\`, and validate \`.factory/spec.json\` (\`node "${cliPath}" plan\`).`,
    `- **Stage 2 (Isolate)**: Read \`${skillsDir}/factory-pipeline/SKILL.md\`, run parallel slices in isolated worktrees with \`FACTORY_SLICE=<slice>\`, and merge via \`node "${cliPath}" land --worktree <dir> --slice <slice>\`.`,
    `- **Stage 3 (Verify)**: Read \`${skillsDir}/factory-qa-verifier/SKILL.md\` and run \`node "${cliPath}" verify --require-tests\` before completion.`,
    `- **Stage 4 (Review)**: Read \`${skillsDir}/factory-security-reviewer/SKILL.md\` and run \`node "${cliPath}" audit-diff\` + a read-only semantic diff review.`,
    '',
  ].join('\n');
}

function writeClaudeConfig(resolvedTarget, hookDirRef) {
  const claudeDir = path.join(resolvedTarget, '.claude');
  const settingsPath = path.join(claudeDir, 'settings.json');
  const guardCmd = `node "${path.join(hookDirRef, 'bin', 'pre-tool-guard.js')}"`;
  const stopCmd = `node "${path.join(hookDirRef, 'bin', 'stop-verify-gate.js')}"`;

  upsertHookSettingsJson(settingsPath, [
    ['PreToolUse', { matcher: 'Write|Edit|MultiEdit|Bash', command: guardCmd }],
    ['Stop', { matcher: '*', command: stopCmd }],
  ]);

  const claudeMdPath = path.join(resolvedTarget, 'CLAUDE.md');
  if (!fs.existsSync(claudeMdPath)) {
    const claudeMd = buildAgentInstructionsMarkdown(
      'Claude Code — Software Factory Instructions',
      resolvedTarget,
      hookDirRef
    );
    fs.writeFileSync(claudeMdPath, claudeMd, 'utf8');
  }
  return { claudeSettingsPath: settingsPath, claudeMdPath };
}

function writeGeminiConfig(resolvedTarget, hookDirRef) {
  const geminiDir = path.join(resolvedTarget, '.gemini');
  const settingsPath = path.join(geminiDir, 'settings.json');
  const guardCmd = `node "${path.join(hookDirRef, 'bin', 'pre-tool-guard.js')}"`;
  const stopCmd = `node "${path.join(hookDirRef, 'bin', 'stop-verify-gate.js')}"`;

  upsertHookSettingsJson(settingsPath, [
    ['BeforeTool', { matcher: '.*', command: guardCmd }],
    ['AfterAgent', { matcher: '.*', command: stopCmd }],
  ]);

  const geminiMdPath = path.join(resolvedTarget, 'GEMINI.md');
  if (!fs.existsSync(geminiMdPath)) {
    const geminiMd = buildAgentInstructionsMarkdown(
      'Gemini CLI — Software Factory Instructions',
      resolvedTarget,
      hookDirRef
    );
    fs.writeFileSync(geminiMdPath, geminiMd, 'utf8');
  }
  return { geminiSettingsPath: settingsPath, geminiMdPath };
}

function ensureCodexAgentsMd(resolvedTarget, pluginDir, hookDirRef) {
  const agentsMdPath = path.join(resolvedTarget, 'AGENTS.md');
  if (!fs.existsSync(agentsMdPath)) {
    const rulesFile = path.join(pluginDir, 'rules', 'AGENTS.md');
    const baseRules = fs.existsSync(rulesFile)
      ? fs.readFileSync(rulesFile, 'utf8').trimEnd()
      : '# Software Factory Rules';
    const normRef = hookDirRef.split(path.sep).join('/');
    const cliPath = path.posix.join(normRef, 'bin', 'agy-factory.js');
    const skillsDir = path.posix.join(normRef, 'skills');
    const content = [
      baseRules,
      '',
      '## CLI & Stage Playbooks',
      '',
      `- **Detect & Plan**: \`node "${cliPath}" detect\` and \`node "${cliPath}" plan --init\` (see \`${skillsDir}/factory-spec-planner/SKILL.md\`).`,
      `- **Isolate & Land Worktrees**: Run slice builders with \`FACTORY_SLICE=<slice>\` and land via \`node "${cliPath}" land --worktree <dir> --slice <slice>\` (see \`${skillsDir}/factory-pipeline/SKILL.md\`).`,
      `- **Verify & Audit**: Run \`node "${cliPath}" verify --require-tests\` and \`node "${cliPath}" audit-diff\` before committing or finishing (see \`${skillsDir}/factory-qa-verifier/SKILL.md\` and \`${skillsDir}/factory-security-reviewer/SKILL.md\`).`,
      '',
    ].join('\n');
    fs.writeFileSync(agentsMdPath, content, 'utf8');
  }
  return agentsMdPath;
}

function resolveGitHooksDir(resolvedTarget) {
  const dotGitPath = path.join(resolvedTarget, '.git');
  if (!fs.existsSync(dotGitPath)) {
    return null;
  }
  const stat = fs.statSync(dotGitPath);
  if (stat.isDirectory()) {
    return path.join(dotGitPath, 'hooks');
  }
  if (stat.isFile()) {
    const content = fs.readFileSync(dotGitPath, 'utf8');
    const match = content.match(/^gitdir:\s*(.+)$/m);
    if (!match) {
      return null;
    }
    const gitDir = path.resolve(resolvedTarget, match[1].trim());
    const commonDirFile = path.join(gitDir, 'commondir');
    if (fs.existsSync(commonDirFile)) {
      const commonRel = fs.readFileSync(commonDirFile, 'utf8').trim();
      if (commonRel) {
        return path.join(path.resolve(gitDir, commonRel), 'hooks');
      }
    }
    return path.join(gitDir, 'hooks');
  }
  return null;
}

function writeGitPreCommitHook(resolvedTarget, hookDirRef) {
  const gitHooksDir = resolveGitHooksDir(resolvedTarget);
  if (!gitHooksDir) {
    return null;
  }
  fs.mkdirSync(gitHooksDir, { recursive: true });
  const preCommitPath = path.join(gitHooksDir, 'pre-commit');
  const cliPath = path.join(hookDirRef, 'bin', 'agy-factory.js');
  const gateLines = [
    `node "${cliPath}" audit-diff --cwd "."`,
    `node "${cliPath}" verify --cwd "."`,
  ];

  if (fs.existsSync(preCommitPath)) {
    const existing = fs.readFileSync(preCommitPath, 'utf8');
    if (!existing.includes('agy-factory.js')) {
      const sep = existing.endsWith('\n') ? '' : '\n';
      const updated = `${existing}${sep}${gateLines.join('\n')}\n`;
      fs.writeFileSync(preCommitPath, updated, { encoding: 'utf8', mode: 0o755 });
      fs.chmodSync(preCommitPath, 0o755);
    }
    return preCommitPath;
  }

  const script = ['#!/usr/bin/env sh', 'set -e', ...gateLines, ''].join('\n');
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
    Object.assign(targetConfigs, writeClaudeConfig(resolvedTarget, effectivePluginRef));
  }
  if (targets.has('gemini')) {
    Object.assign(targetConfigs, writeGeminiConfig(resolvedTarget, effectivePluginRef));
  }
  if (targets.has('codex')) {
    targetConfigs.agentsMdPath = ensureCodexAgentsMd(
      resolvedTarget,
      pluginDir,
      effectivePluginRef
    );
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
