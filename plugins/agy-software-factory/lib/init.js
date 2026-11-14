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

/**
 * Installs or links the `agy-software-factory` plugin into `targetDir`.
 *
 * @param {object} [options]
 * @param {string} [options.targetDir=process.cwd()]
 * @param {'link'|'copy'} [options.mode='link']
 * @param {string} [options.pluginSourceDir]
 */
export function runInit({
  targetDir,
  cwd,
  mode = 'link',
  pluginSourceDir,
} = {}) {
  if (mode !== 'link' && mode !== 'copy') {
    throw new Error(`Invalid init mode "${mode}". Expected "link" or "copy".`);
  }

  const resolvedTarget = path.resolve(targetDir || cwd || process.cwd());
  fs.mkdirSync(resolvedTarget, { recursive: true });

  const { pluginDir, pluginsParentDir } = resolvePluginSource(pluginSourceDir);
  if (!fs.existsSync(pluginDir)) {
    throw new Error(`Plugin source directory does not exist: ${pluginDir}`);
  }

  const pluginsJsonPath = path.join(resolvedTarget, '.agents', 'plugins.json');

  if (mode === 'link') {
    upsertPluginsJson(pluginsJsonPath, pluginsParentDir);
  } else {
    const destPluginDir = path.join(
      resolvedTarget,
      '.agents',
      'plugins',
      'agy-software-factory'
    );
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
    upsertPluginsJson(pluginsJsonPath, '.agents/plugins');
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
    pluginsJsonPath,
    factoryConfigPath,
  };
}
