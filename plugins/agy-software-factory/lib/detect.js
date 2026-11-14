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
  'tests',
  'test',
  'bin',
]);

const MONOREPO_CONTAINER_DIRS = new Set([
  'apps',
  'packages',
  'services',
  'libs',
  'modules',
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

function detectNodePackageManager(absDir, rootPath, pkg) {
  if (typeof pkg?.packageManager === 'string') {
    const pmSpec = pkg.packageManager.trim().toLowerCase();
    if (pmSpec.startsWith('pnpm@') || pmSpec === 'pnpm') return 'pnpm';
    if (pmSpec.startsWith('yarn@') || pmSpec === 'yarn') return 'yarn';
    if (pmSpec.startsWith('bun@') || pmSpec === 'bun') return 'bun';
    if (pmSpec.startsWith('npm@') || pmSpec === 'npm') return 'npm';
  }

  const dirsToCheck = absDir === rootPath ? [absDir] : [absDir, rootPath];
  for (const dir of dirsToCheck) {
    if (fs.existsSync(path.join(dir, 'pnpm-lock.yaml'))) return 'pnpm';
    if (fs.existsSync(path.join(dir, 'yarn.lock'))) return 'yarn';
    if (
      fs.existsSync(path.join(dir, 'bun.lockb')) ||
      fs.existsSync(path.join(dir, 'bun.lock'))
    ) {
      return 'bun';
    }
    if (fs.existsSync(path.join(dir, 'package-lock.json'))) return 'npm';
  }

  return 'npm';
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
    const pm = detectNodePackageManager(absDir, rootPath, pkg);
    const rawScripts = pkg.scripts && typeof pkg.scripts === 'object' ? pkg.scripts : {};
    const scripts = {};
    for (const [k, v] of Object.entries(rawScripts)) {
      if (typeof v === 'string') {
        scripts[k] = v;
      }
    }

    const commands = {};
    if (scripts.lint) {
      commands.lint = `${pm} run lint`;
    }
    if (scripts.typecheck) {
      commands.typecheck = `${pm} run typecheck`;
    } else if (scripts['type-check']) {
      commands.typecheck = `${pm} run type-check`;
    }
    if (scripts.test && !isPlaceholderTestScript(scripts.test)) {
      commands.test = pm === 'yarn' ? 'yarn test' : `${pm} test`;
    }
    if (scripts.build) {
      commands.build = `${pm} run build`;
    }

    const name =
      typeof pkg.name === 'string' && pkg.name.trim().length > 0 ? pkg.name.trim() : defaultName;

    detected.push({
      name,
      path: absDir,
      relPath,
      type: 'node',
      packageManager: pm,
      scripts,
      commands,
    });
  }

  const pyprojectPath = path.join(absDir, 'pyproject.toml');
  const requirementsPath = path.join(absDir, 'requirements.txt');
  const setupPyPath = path.join(absDir, 'setup.py');
  const hasPyproject = fs.existsSync(pyprojectPath) && fs.statSync(pyprojectPath).isFile();
  const hasRequirements = fs.existsSync(requirementsPath) && fs.statSync(requirementsPath).isFile();
  const hasSetupPy = fs.existsSync(setupPyPath) && fs.statSync(setupPyPath).isFile();
  if (hasPyproject || hasRequirements || hasSetupPy) {
    const commands = {};
    const pyText = [
      hasPyproject ? fs.readFileSync(pyprojectPath, 'utf8') : '',
      hasRequirements ? fs.readFileSync(requirementsPath, 'utf8') : '',
      hasSetupPy ? fs.readFileSync(setupPyPath, 'utf8') : '',
    ].join('\n');

    if (/\bruff\b/i.test(pyText)) {
      commands.lint = 'ruff check .';
    }
    if (/\bmypy\b/i.test(pyText)) {
      commands.typecheck = 'mypy .';
    }
    if (/\bpytest\b/i.test(pyText)) {
      commands.test = 'python3 -m pytest';
    } else if (fs.existsSync(path.join(absDir, 'tests'))) {
      commands.test = 'python3 -m unittest discover -s tests -p "test*.py"';
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
      const childComponents = inspectDirectory(childPath, root);
      components.push(...childComponents);

      if (MONOREPO_CONTAINER_DIRS.has(childName) && childComponents.length === 0) {
        const nestedEntries = fs.readdirSync(childPath, { withFileTypes: true });
        const nestedDirs = nestedEntries
          .filter((entry) => {
            if (!entry.isDirectory()) return false;
            if (entry.name.startsWith('.')) return false;
            if (SKIP_CHILD_DIRS.has(entry.name)) return false;
            return true;
          })
          .map((entry) => entry.name)
          .sort((a, b) => a.localeCompare(b));

        for (const nestedName of nestedDirs) {
          components.push(...inspectDirectory(path.join(childPath, nestedName), root));
        }
      }
    }
  }

  return {
    root,
    hasDockerCompose: Boolean(dockerComposeFile),
    dockerComposeFile,
    components,
  };
}
