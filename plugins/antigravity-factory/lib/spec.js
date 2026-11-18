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
    if (rawPattern.endsWith('/**')) {
      const prefix = rawPattern.replace(/\/\*+$/, '').replace(/\/+$/, '');
      if (normFile === prefix || normFile.startsWith(`${prefix}/`)) {
        return true;
      }
      continue;
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
  const normA = segA.replace(/\*\*+/g, '*');
  const normB = segB.replace(/\*\*+/g, '*');
  if (!hasWildcard(normA) && !hasWildcard(normB)) {
    return normA === normB;
  }
  const reA = globToRegExp(normA);
  const reB = globToRegExp(normB);
  if (!hasWildcard(normA)) return reB.test(normA);
  if (!hasWildcard(normB)) return reA.test(normB);

  const firstWildA = normA.search(/[*?]/);
  const firstWildB = normB.search(/[*?]/);
  const prefA = normA.slice(0, firstWildA);
  const prefB = normB.slice(0, firstWildB);
  if (!prefA.startsWith(prefB) && !prefB.startsWith(prefA)) {
    return false;
  }

  const lastWildA = Math.max(normA.lastIndexOf('*'), normA.lastIndexOf('?'));
  const lastWildB = Math.max(normB.lastIndexOf('*'), normB.lastIndexOf('?'));
  const sufA = normA.slice(lastWildA + 1);
  const sufB = normB.slice(lastWildB + 1);
  if (!sufA.endsWith(sufB) && !sufB.endsWith(sufA)) {
    return false;
  }

  const longerPref = prefA.length >= prefB.length ? prefA : prefB;
  const longerSuf = sufA.length >= sufB.length ? sufA : sufB;
  const candidates = [
    `${longerPref}${longerSuf}`,
    `${longerPref}x${longerSuf}`,
    `${longerPref}xx${longerSuf}`,
    normA.replace(/\*/g, '').replace(/\?/g, 'x'),
    normB.replace(/\*/g, '').replace(/\?/g, 'x'),
  ];
  return (
    candidates.some((c) => reA.test(c) && reB.test(c)) ||
    (normA.includes('*') && normB.includes('*'))
  );
}

function compilePatternAlternatives(rawPattern) {
  const clean = String(rawPattern)
    .trim()
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
    .replace(/\/+$/, '');
  if (!clean) return [];
  if (clean === '.' || clean === '*' || clean === '**') {
    return [['**']];
  }
  if (clean.endsWith('/**')) {
    const prefix = clean.slice(0, -3).replace(/\/+$/, '');
    if (!prefix) return [['**']];
    const parts = prefix.split('/').filter(Boolean);
    return [parts, [...parts, '**']];
  }
  if (!hasWildcard(clean)) {
    const parts = clean.split('/').filter(Boolean);
    return [parts, [...parts, '**']];
  }
  return [clean.split('/').filter(Boolean)];
}

function segmentListsIntersect(segsA, segsB) {
  const memo = new Map();
  const dp = (i, j) => {
    const key = `${i},${j}`;
    if (memo.has(key)) return memo.get(key);
    let result = false;
    if (i === segsA.length && j === segsB.length) {
      result = true;
    } else if (i < segsA.length && segsA[i] === '**') {
      result = dp(i + 1, j) || (j < segsB.length && dp(i, j + 1));
    } else if (j < segsB.length && segsB[j] === '**') {
      result = dp(i, j + 1) || (i < segsA.length && dp(i + 1, j));
    } else if (i < segsA.length && j < segsB.length) {
      result = segmentsCanOverlap(segsA[i], segsB[j]) && dp(i + 1, j + 1);
    }
    memo.set(key, result);
    return result;
  };
  return dp(0, 0);
}

function patternsOverlap(patA, patB) {
  const altsA = compilePatternAlternatives(patA);
  const altsB = compilePatternAlternatives(patB);
  for (const segsA of altsA) {
    for (const segsB of altsB) {
      if (segmentListsIntersect(segsA, segsB)) {
        return true;
      }
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
          const cmd = comp.commands?.test || comp.commands?.build || null;
          if (slices[sliceKey]) {
            const existing = slices[sliceKey];
            existing.description = `${existing.description} + ${comp.name} (${comp.type})`;
            if (cmd && existing.verifyCommand && existing.verifyCommand !== cmd) {
              existing.verifyCommand = `${existing.verifyCommand} && ${cmd}`;
            } else if (cmd && !existing.verifyCommand) {
              existing.verifyCommand = cmd;
            }
          } else {
            slices[sliceKey] = {
              description: `${comp.name} (${comp.type}) slice`,
              allowPaths: [`${comp.relPath}/**`],
              verifyCommand: cmd,
            };
          }
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
