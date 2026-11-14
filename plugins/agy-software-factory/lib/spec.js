import fs from 'node:fs';
import path from 'node:path';
import { detectProject } from './detect.js';

const SPEC_CANDIDATES = ['.factory/spec.json', 'factory-spec.json'];

export function normalizeAllowPathsList(allowPaths) {
  if (!allowPaths) return [];
  const rawList = Array.isArray(allowPaths)
    ? allowPaths
    : String(allowPaths).split(',');
  return rawList
    .map((p) => String(p).trim().replace(/\\/g, '/').replace(/^\.\//, ''))
    .filter(Boolean);
}

export function findSpecFilePath(cwd = process.cwd()) {
  const resolvedCwd = path.resolve(cwd);
  for (const rel of SPEC_CANDIDATES) {
    const full = path.join(resolvedCwd, rel);
    if (fs.existsSync(full) && fs.statSync(full).isFile()) {
      return full;
    }
  }
  return null;
}

export function loadFactorySpec(cwd = process.cwd()) {
  const specPath = findSpecFilePath(cwd);
  if (!specPath) return null;
  const raw = fs.readFileSync(specPath, 'utf8');
  const parsed = JSON.parse(raw);
  return { specPath, spec: parsed };
}

function normalizePrefixForOverlap(pattern) {
  const clean = pattern.replace(/\\/g, '/').replace(/^\.\//, '');
  if (clean === '.' || clean === '*' || clean === '**') return '';
  return clean.replace(/\/\*+$/, '').replace(/\/+$/, '');
}

function patternsOverlap(patA, patB) {
  if (patA === patB) return true;
  if (patA.includes('*') || patB.includes('*')) {
    const hasWildcardSuffixA = patA.endsWith('/*') || patA.endsWith('/**') || patA === '*' || patA === '**';
    const hasWildcardSuffixB = patB.endsWith('/*') || patB.endsWith('/**') || patB === '*' || patB === '**';
    const prefA = normalizePrefixForOverlap(patA);
    const prefB = normalizePrefixForOverlap(patB);
    if (prefA === '' || prefB === '') return true;
    if (prefA === prefB && (hasWildcardSuffixA || hasWildcardSuffixB)) return true;
    if (hasWildcardSuffixA && prefB.startsWith(`${prefA}/`)) return true;
    if (hasWildcardSuffixB && prefA.startsWith(`${prefB}/`)) return true;
    return false;
  }
  const cleanA = patA.replace(/\/+$/, '');
  const cleanB = patB.replace(/\/+$/, '');
  return (
    cleanA === cleanB ||
    cleanA.startsWith(`${cleanB}/`) ||
    cleanB.startsWith(`${cleanA}/`)
  );
}

export function validateFactorySpec(spec) {
  const errors = [];
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) {
    return {
      valid: false,
      errors: ['Specification must be a JSON object.'],
      slices: [],
    };
  }

  if (!spec.slices || typeof spec.slices !== 'object' || Array.isArray(spec.slices)) {
    errors.push('Missing or invalid "slices" object in factory spec.');
    return { valid: false, errors, slices: [] };
  }

  const sliceNames = Object.keys(spec.slices);
  if (sliceNames.length === 0) {
    errors.push('"slices" must define at least one slice.');
  }

  const slicePatterns = [];
  for (const name of sliceNames) {
    const sliceDef = spec.slices[name];
    if (!sliceDef || typeof sliceDef !== 'object') {
      errors.push(`Slice "${name}" must be an object.`);
      continue;
    }
    const allowPaths = normalizeAllowPathsList(sliceDef.allowPaths);
    if (allowPaths.length === 0) {
      errors.push(`Slice "${name}" must define non-empty "allowPaths".`);
      continue;
    }
    slicePatterns.push({ name, allowPaths });
  }

  for (let i = 0; i < slicePatterns.length; i += 1) {
    for (let j = i + 1; j < slicePatterns.length; j += 1) {
      const a = slicePatterns[i];
      const b = slicePatterns[j];
      for (const patA of a.allowPaths) {
        for (const patB of b.allowPaths) {
          if (patternsOverlap(patA, patB)) {
            errors.push(
              `Overlapping slice ownership between "${a.name}" (${patA}) and "${b.name}" (${patB}).`
            );
          }
        }
      }
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    slices: sliceNames,
  };
}

export function resolveSliceSpec(cwd = process.cwd(), sliceName) {
  const loaded = loadFactorySpec(cwd);
  if (!loaded) {
    throw new Error(
      `No factory spec found in ${path.resolve(cwd)} (expected .factory/spec.json or factory-spec.json).`
    );
  }
  const { spec, specPath } = loaded;
  const sliceDef = spec?.slices?.[sliceName];
  if (!sliceDef || typeof sliceDef !== 'object') {
    const available = Object.keys(spec?.slices || {}).join(', ') || '(none)';
    throw new Error(
      `Unknown slice "${sliceName}" in ${specPath}. Available slices: ${available}`
    );
  }
  const allowPaths = normalizeAllowPathsList(sliceDef.allowPaths);
  if (allowPaths.length === 0) {
    throw new Error(`Slice "${sliceName}" in ${specPath} has no allowPaths configured.`);
  }
  return {
    name: sliceName,
    specPath,
    allowPaths,
    verifyCommand: sliceDef.verifyCommand || null,
    description: sliceDef.description || '',
  };
}

export function runPlan({
  cwd = process.cwd(),
  init = false,
  slice = null,
} = {}) {
  const resolvedCwd = path.resolve(cwd);

  if (init) {
    const specPath = path.join(resolvedCwd, '.factory', 'spec.json');
    if (!fs.existsSync(specPath)) {
      fs.mkdirSync(path.dirname(specPath), { recursive: true });
      const detected = detectProject(resolvedCwd);
      const childComps = detected.components.filter((c) => c.relPath !== '.');
      const slices = {};
      if (childComps.length > 0) {
        for (const comp of childComps) {
          const sliceKey = comp.relPath.replace(/[^A-Za-z0-9_-]/g, '-');
          slices[sliceKey] = {
            description: `${comp.name} (${comp.type}) slice`,
            allowPaths: [`${comp.relPath}/**`],
            verifyCommand: comp.commands?.test || comp.commands?.build || null,
          };
        }
      } else {
        slices.core = {
          description: 'Core implementation slice',
          allowPaths: ['src/**', 'lib/**'],
          verifyCommand: 'npm test',
        };
      }

      const initialSpec = {
        name: path.basename(resolvedCwd) || 'factory-project',
        contracts: {},
        acceptanceCriteria: [
          'All unit and integration tests pass via agy-factory verify --require-tests',
          'Zero high-severity findings in agy-factory audit-diff',
        ],
        slices,
      };
      fs.writeFileSync(specPath, `${JSON.stringify(initialSpec, null, 2)}\n`, 'utf8');
    }
  }

  if (slice) {
    const resolvedSlice = resolveSliceSpec(resolvedCwd, slice);
    return {
      ok: true,
      cwd: resolvedCwd,
      specPath: resolvedSlice.specPath,
      slice: resolvedSlice,
    };
  }

  const loaded = loadFactorySpec(resolvedCwd);
  if (!loaded) {
    return {
      ok: false,
      cwd: resolvedCwd,
      specPath: null,
      valid: false,
      errors: [
        'No .factory/spec.json or factory-spec.json found. Run `agy-factory plan --init` to scaffold one.',
      ],
      slices: [],
      spec: null,
    };
  }

  const validation = validateFactorySpec(loaded.spec);
  return {
    ok: validation.valid,
    cwd: resolvedCwd,
    specPath: loaded.specPath,
    valid: validation.valid,
    errors: validation.errors,
    slices: validation.slices,
    spec: loaded.spec,
  };
}
