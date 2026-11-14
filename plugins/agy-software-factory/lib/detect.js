import fs from 'node:fs';
import path from 'node:path';

const SKIP_CHILD_DIRS = new Set([
  'node_modules',
  'dist',
  'build',
  'coverage',
  '.factory',
  'plugins',
  'examples',
]);

const COMPOSE_FILES = [
  'docker-compose.yml',
  'compose.yaml',
  'docker-compose.yaml',
  'compose.yml',
];

function safeReadJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function isPlaceholderTestScript(script) {
  return typeof script === 'string' && script.includes('Error: no test specified');
}

function inspectDirectory(dirPath, rootPath) {
  const detected = [];
  const absDir = path.resolve(dirPath);
  const relPath =
    absDir === rootPath ? '.' : path.relative(rootPath, absDir).split(path.sep).join('/');
  const defaultName = absDir === rootPath ? path.basename(rootPath) || 'root' : path.basename(absDir);

  const pkgPath = path.join(absDir, 'package.json');
  if (fs.existsSync(pkgPath) && fs.statSync(pkgPath).isFile()) {
    const pkg = safeReadJson(pkgPath) || {};
    const rawScripts = pkg.scripts && typeof pkg.scripts === 'object' ? pkg.scripts : {};
    const scripts = {};
    for (const [k, v] of Object.entries(rawScripts)) {
      if (typeof v === 'string') {
        scripts[k] = v;
      }
    }

    const commands = {};
    if (scripts.lint) {
      commands.lint = 'npm run lint';
    }
    if (scripts.typecheck) {
      commands.typecheck = 'npm run typecheck';
    } else if (scripts['type-check']) {
      commands.typecheck = 'npm run type-check';
    }
    if (scripts.test && !isPlaceholderTestScript(scripts.test)) {
      commands.test = 'npm test';
    }
    if (scripts.build) {
      commands.build = 'npm run build';
    }

    const name =
      typeof pkg.name === 'string' && pkg.name.trim().length > 0 ? pkg.name.trim() : defaultName;

    detected.push({
      name,
      path: absDir,
      relPath,
      type: 'node',
      scripts,
      commands,
    });
  }

  const pyprojectPath = path.join(absDir, 'pyproject.toml');
  const requirementsPath = path.join(absDir, 'requirements.txt');
  const hasPyproject = fs.existsSync(pyprojectPath) && fs.statSync(pyprojectPath).isFile();
  const hasRequirements = fs.existsSync(requirementsPath) && fs.statSync(requirementsPath).isFile();
  if (hasPyproject || hasRequirements) {
    const commands = {};
    const pyText = [
      hasPyproject ? fs.readFileSync(pyprojectPath, 'utf8') : '',
      hasRequirements ? fs.readFileSync(requirementsPath, 'utf8') : '',
    ].join('\n');

    if (/\bruff\b/i.test(pyText)) {
      commands.lint = 'ruff check .';
    }
    if (/\bmypy\b/i.test(pyText)) {
      commands.typecheck = 'mypy .';
    }
    if (/\bpytest\b/i.test(pyText) || fs.existsSync(path.join(absDir, 'tests'))) {
      commands.test = 'python3 -m pytest';
    }

    detected.push({
      name: defaultName,
      path: absDir,
      relPath,
      type: 'python',
      scripts: {},
      commands,
    });
  }

  const goModPath = path.join(absDir, 'go.mod');
  if (fs.existsSync(goModPath) && fs.statSync(goModPath).isFile()) {
    detected.push({
      name: defaultName,
      path: absDir,
      relPath,
      type: 'go',
      scripts: {},
      commands: {
        test: 'go test ./...',
        build: 'go build ./...',
      },
    });
  }

  const cargoPath = path.join(absDir, 'Cargo.toml');
  if (fs.existsSync(cargoPath) && fs.statSync(cargoPath).isFile()) {
    detected.push({
      name: defaultName,
      path: absDir,
      relPath,
      type: 'rust',
      scripts: {},
      commands: {
        test: 'cargo test',
        build: 'cargo build',
      },
    });
  }

  return detected;
}

/**
 * Detects workspace stack, Docker Compose configuration, and runnable component scripts.
 *
 * @param {string} [cwd=process.cwd()]
 */
export function detectProject(cwd = process.cwd()) {
  const root = path.resolve(cwd);

  let dockerComposeFile = null;
  for (const candidate of COMPOSE_FILES) {
    const candidatePath = path.join(root, candidate);
    if (fs.existsSync(candidatePath) && fs.statSync(candidatePath).isFile()) {
      dockerComposeFile = candidate;
      break;
    }
  }

  const components = [];
  if (fs.existsSync(root) && fs.statSync(root).isDirectory()) {
    components.push(...inspectDirectory(root, root));

    const entries = fs.readdirSync(root, { withFileTypes: true });
    const childDirs = entries
      .filter((entry) => {
        if (!entry.isDirectory()) return false;
        if (entry.name.startsWith('.')) return false;
        if (SKIP_CHILD_DIRS.has(entry.name)) return false;
        return true;
      })
      .map((entry) => entry.name)
      .sort((a, b) => a.localeCompare(b));

    for (const childName of childDirs) {
      const childPath = path.join(root, childName);
      components.push(...inspectDirectory(childPath, root));
    }
  }

  return {
    root,
    hasDockerCompose: Boolean(dockerComposeFile),
    dockerComposeFile,
    components,
  };
}
