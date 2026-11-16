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

export function globToRegExp(globPattern) {
  let regexStr = '^';
  for (let i = 0; i < globPattern.length; i += 1) {
    const ch = globPattern[i];
    if (ch === '*') {
      if (globPattern[i + 1] === '*') {
        if (globPattern[i + 2] === '/') {
          regexStr += '(?:.+/)?';
          i += 2;
        } else {
          regexStr += '.*';
          i += 1;
        }
      } else {
        regexStr += '[^/]*';
      }
    } else if (ch === '?') {
      regexStr += '[^/]';
    } else if ('\\.[]{}()+-^$|'.includes(ch)) {
      regexStr += `\\${ch}`;
    } else {
      regexStr += ch;
    }
  }
  regexStr += '$';
  return new RegExp(regexStr);
}

export function matchesAllowedPath(relPath, allowedPatterns) {
  const normFile = relPath.replace(/\\/g, '/').replace(/^\.\//, '');
  for (const rawInput of allowedPatterns) {
    const rawPattern = String(rawInput).trim().replace(/\\/g, '/').replace(/^\.\//, '');
    if (!rawPattern) continue;
    if (rawPattern === '.' || rawPattern === '*' || rawPattern === '**') {
      return true;
    }
    if (rawPattern.endsWith('/**') || rawPattern.endsWith('/*')) {
      const prefix = rawPattern.replace(/\/\*+$/, '').replace(/\/+$/, '');
      if (normFile === prefix || normFile.startsWith(`${prefix}/`)) {
        return true;
      }
    }
    if (rawPattern.includes('*') || rawPattern.includes('?')) {
      if (globToRegExp(rawPattern).test(normFile)) {
        return true;
      }
      continue;
    }
    const cleanPrefix = rawPattern.replace(/\/+$/, '');
    if (normFile === cleanPrefix || normFile.startsWith(`${cleanPrefix}/`)) {
      return true;
    }
  }
  return false;
}

function hasWildcard(str) {
  return str.includes('*') || str.includes('?');
}

function segmentsCanOverlap(segA, segB) {
  if (!hasWildcard(segA) && !hasWildcard(segB)) {
    return segA === segB;
  }
  const reA = globToRegExp(segA);
  const reB = globToRegExp(segB);
  if (!hasWildcard(segA)) return reB.test(segA);
  if (!hasWildcard(segB)) return reA.test(segB);

  const firstWildA = segA.search(/[*?]/);
  const firstWildB = segB.search(/[*?]/);
  const prefA = segA.slice(0, firstWildA);
  const prefB = segB.slice(0, firstWildB);
  if (!prefA.startsWith(prefB) && !prefB.startsWith(prefA)) {
    return false;
  }

  const lastWildA = Math.max(segA.lastIndexOf('*'), segA.lastIndexOf('?'));
  const lastWildB = Math.max(segB.lastIndexOf('*'), segB.lastIndexOf('?'));
  const sufA = segA.slice(lastWildA + 1);
  const sufB = segB.slice(lastWildB + 1);
  if (!sufA.endsWith(sufB) && !sufB.endsWith(sufA)) {
    return false;
  }

  const longerPref = prefA.length >= prefB.length ? prefA : prefB;
  const longerSuf = sufA.length >= sufB.length ? sufA : sufB;
  const candidates = [
    `${longerPref}${longerSuf}`,
    `${longerPref}x${longerSuf}`,
    `${longerPref}xx${longerSuf}`,
  ];
  return (
    candidates.some((c) => reA.test(c) && reB.test(c)) ||
    (segA.includes('*') && segB.includes('*'))
  );
}

function patternsOverlap(patA, patB) {
  if (patA === patB) return true;
  const cleanA = patA.replace(/\/+$/, '');
  const cleanB = patB.replace(/\/+$/, '');
  if (cleanA === cleanB) return true;

  if (!hasWildcard(cleanA) && !hasWildcard(cleanB)) {
    return (
      cleanA.startsWith(`${cleanB}/`) || cleanB.startsWith(`${cleanA}/`)
    );
  }

  const hasWildcardSuffixA =
    cleanA.endsWith('/*') ||
    cleanA.endsWith('/**') ||
    cleanA === '*' ||
    cleanA === '**';
  const hasWildcardSuffixB =
    cleanB.endsWith('/*') ||
    cleanB.endsWith('/**') ||
    cleanB === '*' ||
    cleanB === '**';
  const prefA = normalizePrefixForOverlap(cleanA);
  const prefB = normalizePrefixForOverlap(cleanB);

  if (
    (hasWildcardSuffixA && prefA === '') ||
    (hasWildcardSuffixB && prefB === '')
  ) {
    return true;
  }
  if (prefA === prefB && (hasWildcardSuffixA || hasWildcardSuffixB)) {
    return true;
  }
  if (hasWildcardSuffixA && prefB.startsWith(`${prefA}/`)) return true;
  if (hasWildcardSuffixB && prefA.startsWith(`${prefB}/`)) return true;

  // Directory prefix vs mid-segment/extension glob inside that directory (e.g. "src" vs "src/*.js")
  if (!hasWildcard(cleanA) && cleanB.startsWith(`${cleanA}/`)) return true;
  if (!hasWildcard(cleanB) && cleanA.startsWith(`${cleanB}/`)) return true;

  const reA = globToRegExp(cleanA);
  const reB = globToRegExp(cleanB);
  if (!hasWildcard(cleanA) && reB.test(cleanA)) return true;
  if (!hasWildcard(cleanB) && reA.test(cleanB)) return true;

  // Recursive "**" glob vs another glob (e.g. "**/*.test.js" vs "api/**" or "api/*.test.js")
  if (cleanA.includes('**') || cleanB.includes('**')) {
    const samplePaths = [
      `${prefA || 'dir'}/${(cleanB.split('/').pop() || 'file').replace(/\*\*/g, 'x').replace(/\*/g, 'x').replace(/\?/g, 'x')}`,
      `${prefB || 'dir'}/${(cleanA.split('/').pop() || 'file').replace(/\*\*/g, 'x').replace(/\*/g, 'x').replace(/\?/g, 'x')}`,
    ];
    if (samplePaths.some((s) => reA.test(s) && reB.test(s))) {
      return true;
    }
  }

  // Segment-by-segment glob intersection (e.g. "src/*.js" vs "src/app.*" or "src/*.ts")
  if (!cleanA.includes('**') && !cleanB.includes('**')) {
    const segsA = cleanA.split('/');
    const segsB = cleanB.split('/');
    if (segsA.length === segsB.length) {
      return segsA.every((sA, idx) => segmentsCanOverlap(sA, segsB[idx]));
    }
  }

  return false;
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
