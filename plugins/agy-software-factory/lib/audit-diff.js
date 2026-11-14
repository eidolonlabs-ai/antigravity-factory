import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { resolveSliceSpec } from './spec.js';

const SKIP_DIRS = new Set([
  'node_modules',
  'dist',
  'build',
  'coverage',
  '.git',
  '.factory',
]);

const SKIP_FILES = new Set([
  'package-lock.json',
  'pnpm-lock.yaml',
  'yarn.lock',
  '.DS_Store',
]);

const BINARY_EXTENSIONS = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.ico',
  '.pdf',
  '.zip',
  '.gz',
  '.tar',
  '.tgz',
  '.woff',
  '.woff2',
  '.ttf',
  '.eot',
  '.mp4',
  '.mp3',
  '.wasm',
  '.pyc',
  '.so',
  '.dylib',
  '.dll',
  '.exe',
]);

const PROSE_DOC_EXTENSIONS = new Set(['.md', '.markdown', '.txt']);

const ENV_TEMPLATE_BASENAMES = new Set([
  '.env.example',
  '.env.sample',
  '.env.template',
  '.env.test',
]);

const PLACEHOLDER_TOKENS = [
  'example',
  'changeme',
  'placeholder',
  'your_',
  'tasks_password',
  'dummy',
  'mock',
  'test',
  'sample',
  'replace',
  'xxxx',
  '0000',
  'todo',
];

const IGNORE_MARKER = ['factory', 'audit', 'ignore'].join('-');

// Construct patterns from segments so audit-diff never matches its own source code.
const AWS_KEY_RE = new RegExp(['\\bAKIA', '[0-9A-Z]{16}\\b'].join(''));
const PEM_KEY_RE = new RegExp(
  ['-----BEGIN ', '(?:RSA |EC |OPENSSH |DSA |ENCRYPTED )?', 'PRIVATE KEY-----'].join('')
);
const SECRET_ASSIGN_RE = new RegExp(
  ['\\b(api[_-]?key|secret|token|password)', '\\s*[:=]\\s*', '[\'"]([^\'"]{8,})[\'"]'].join(''),
  'i'
);

const EVAL_RE = new RegExp(['\\beval', '\\s*\\('].join(''));
const NEW_FUNCTION_RE = new RegExp(['\\bnew\\s+Function', '\\s*\\('].join(''));
const SHELL_EXEC_INTERP_RE = new RegExp(
  ['\\b(?:exec|execSync)', '\\s*\\(\\s*`[^`]*\\$', '\\{'].join('')
);

const REACT_XSS_RE = new RegExp(['\\bdangerouslySet', 'InnerHTML\\b'].join(''));
const INNER_HTML_RE = new RegExp(['\\.innerHTML', '\\s*='].join(''));

const SQL_SELECT_RE = new RegExp(['\\bSELECT\\b.*\\bWHERE\\b.*(?<!\\$)\\$', '\\{'].join(''), 'i');
const SQL_VALUES_RE = new RegExp(['\\bVALUES\\s*\\(.*(?<!\\$)\\$', '\\{'].join(''), 'i');
const SQL_DELETE_RE = new RegExp(['\\bDELETE\\s+FROM\\b.*\\bWHERE\\b.*(?<!\\$)\\$', '\\{'].join(''), 'i');
const SQL_UPDATE_RE = new RegExp(
  ['\\bUPDATE\\b.*\\bSET\\b.*(?:[\'"]\\s*\\$', '\\{|\\bWHERE\\b.*(?<!\\$)\\$', '\\{)'].join(''),
  'i'
);
const PY_SQL_FSTRING_RE = new RegExp(
  ['\\bf([\'"])(?:SELECT|INSERT\\s+INTO|UPDATE|DELETE\\s+FROM)\\b.*\\{.*\\1'].join(''),
  'i'
);

function runGit(args, cwd) {
  return spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    timeout: 15_000,
    maxBuffer: 10 * 1024 * 1024,
  });
}

function getGitTopLevel(cwd) {
  const res = runGit(['rev-parse', '--show-toplevel'], cwd);
  if (res.status !== 0) return null;
  const raw = res.stdout.trim();
  if (!raw || !fs.existsSync(raw)) return null;
  return fs.realpathSync(raw);
}

function shouldSkipRelPath(relPath) {
  const normalized = relPath.replace(/\\/g, '/');
  const parts = normalized.split('/').filter(Boolean);
  if (parts.length === 0) return true;

  for (let i = 0; i < parts.length - 1; i++) {
    if (SKIP_DIRS.has(parts[i])) return true;
  }

  const baseName = parts[parts.length - 1];
  if (SKIP_FILES.has(baseName)) return true;

  const ext = path.posix.extname(baseName).toLowerCase();
  if (BINARY_EXTENSIONS.has(ext)) return true;

  return false;
}

function isBinaryBuffer(buf) {
  const checkLen = Math.min(buf.length, 8192);
  for (let i = 0; i < checkLen; i++) {
    if (buf[i] === 0) return true;
  }
  return false;
}

function walkAllCandidateFiles(dirPath, rootPath, acc = []) {
  if (!fs.existsSync(dirPath)) return acc;
  const entries = fs.readdirSync(dirPath, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      walkAllCandidateFiles(path.join(dirPath, entry.name), rootPath, acc);
    } else if (entry.isFile()) {
      if (SKIP_FILES.has(entry.name)) continue;
      const fullPath = path.join(dirPath, entry.name);
      const rel = path.relative(rootPath, fullPath).split(path.sep).join('/');
      if (!shouldSkipRelPath(rel)) {
        acc.push({ absPath: fullPath, relPath: rel });
      }
    }
  }
  return acc;
}

function collectGitChangedFiles(realCwd, realRepoRoot, base) {
  const absPaths = new Set();

  const statusRes = runGit(['status', '--porcelain', '-z', '-uall'], realCwd);
  if (statusRes.status === 0 && statusRes.stdout) {
    const tokens = statusRes.stdout.split('\0');
    for (let i = 0; i < tokens.length; i++) {
      const entry = tokens[i];
      if (!entry || entry.length < 4) continue;
      const xy = entry.slice(0, 2);
      const fileRelToRepo = entry.slice(3);
      if (xy[0] === 'R' || xy[0] === 'C') {
        i += 1; // skip original source path in -z output
      }
      if (xy.includes('D') && xy.trim() === 'D') {
        continue;
      }
      absPaths.add(path.resolve(realRepoRoot, fileRelToRepo));
    }
  }

  if (typeof base === 'string' && base.trim().length > 0) {
    const trimmedBase = base.trim();
    if (trimmedBase.startsWith('-')) {
      throw new Error(`Invalid base revision "${trimmedBase}": revision must not start with "-".`);
    }
    const diffRes = runGit(['diff', '--name-only', '-z', trimmedBase, '--'], realCwd);
    if (diffRes.status === 0 && diffRes.stdout) {
      for (const fileRelToRepo of diffRes.stdout.split('\0')) {
        if (!fileRelToRepo) continue;
        absPaths.add(path.resolve(realRepoRoot, fileRelToRepo));
      }
    }
  }

  const results = [];
  for (const candidateAbs of absPaths) {
    if (candidateAbs !== realCwd && !candidateAbs.startsWith(`${realCwd}${path.sep}`)) {
      continue;
    }
    let stat;
    try {
      stat = fs.lstatSync(candidateAbs);
    } catch {
      continue;
    }
    if (stat.isSymbolicLink() || !stat.isFile()) continue;

    let realCandidate;
    try {
      realCandidate = fs.realpathSync(candidateAbs);
    } catch {
      continue;
    }
    if (realCandidate !== realCwd && !realCandidate.startsWith(`${realCwd}${path.sep}`)) {
      continue;
    }

    const relPath = path.relative(realCwd, candidateAbs).split(path.sep).join('/');
    if (!shouldSkipRelPath(relPath)) {
      results.push({ absPath: candidateAbs, relPath });
    }
  }

  return results;
}

function isPlaceholderSecret(secretValue) {
  const lower = secretValue.toLowerCase();
  if (lower.includes('$' + '{') || lower.includes('<') || lower.includes('>')) {
    return true;
  }
  return PLACEHOLDER_TOKENS.some((tok) => lower.includes(tok));
}

function scanFileLines(absPath, relPath) {
  let buf;
  try {
    buf = fs.readFileSync(absPath);
  } catch {
    return { scanned: false, findings: [] };
  }

  if (isBinaryBuffer(buf)) {
    return { scanned: false, findings: [] };
  }

  const content = buf.toString('utf8');
  const lines = content.split(/\r?\n/);
  const baseName = path.posix.basename(relPath);
  const ext = path.posix.extname(baseName).toLowerCase();
  const isProseDoc = PROSE_DOC_EXTENSIONS.has(ext);
  const isEnvTemplate = ENV_TEMPLATE_BASENAMES.has(baseName);

  const findings = [];

  for (let idx = 0; idx < lines.length; idx++) {
    const rawLine = lines[idx];
    if (!rawLine || rawLine.includes(IGNORE_MARKER)) continue;

    const lineNum = idx + 1;
    const snippet = rawLine.trim().slice(0, 200);

    // 1. Hardcoded secrets
    if (AWS_KEY_RE.test(rawLine)) {
      findings.push({
        rule: 'hardcoded-secret',
        severity: 'high',
        file: relPath,
        line: lineNum,
        snippet,
        message: 'Potential hardcoded AWS Access Key ID detected.',
      });
    } else if (PEM_KEY_RE.test(rawLine)) {
      findings.push({
        rule: 'hardcoded-secret',
        severity: 'high',
        file: relPath,
        line: lineNum,
        snippet,
        message: 'Private key header detected in source file.',
      });
    } else if (!isProseDoc && !isEnvTemplate) {
      const assignMatch = SECRET_ASSIGN_RE.exec(rawLine);
      if (assignMatch && !isPlaceholderSecret(assignMatch[2])) {
        findings.push({
          rule: 'hardcoded-secret',
          severity: 'high',
          file: relPath,
          line: lineNum,
          snippet,
          message: `Potential hardcoded ${assignMatch[1]} assignment detected.`,
        });
      }
    }

    if (isProseDoc) {
      continue;
    }

    // 2. Dangerous dynamic code execution
    if (
      EVAL_RE.test(rawLine) ||
      NEW_FUNCTION_RE.test(rawLine) ||
      SHELL_EXEC_INTERP_RE.test(rawLine)
    ) {
      findings.push({
        rule: 'dangerous-exec',
        severity: 'high',
        file: relPath,
        line: lineNum,
        snippet,
        message: [
          'Dynamic code or shell command interpolation via eval',
          '(), Function(), or child_process exec template literal detected.',
        ].join(''),
      });
    }

    // 3. XSS DOM sinks
    if (REACT_XSS_RE.test(rawLine) || INNER_HTML_RE.test(rawLine)) {
      findings.push({
        rule: 'xss-sink',
        severity: 'medium',
        file: relPath,
        line: lineNum,
        snippet,
        message: ['Unescaped HTML sink (dangerouslySet', 'InnerHTML / innerHTML) detected.'].join(''),
      });
    }

    // 4. Raw SQL string interpolation
    if (
      SQL_SELECT_RE.test(rawLine) ||
      SQL_VALUES_RE.test(rawLine) ||
      SQL_DELETE_RE.test(rawLine) ||
      SQL_UPDATE_RE.test(rawLine) ||
      PY_SQL_FSTRING_RE.test(rawLine)
    ) {
      findings.push({
        rule: 'sql-interpolation',
        severity: 'high',
        file: relPath,
        line: lineNum,
        snippet,
        message: 'Raw string/template interpolation inside SQL statement; use parameterized queries.',
      });
    }
  }

  return { scanned: true, findings };
}

function parseAllowPaths(allowPaths) {
  if (!allowPaths) return [];
  const rawList = Array.isArray(allowPaths)
    ? allowPaths
    : String(allowPaths).split(',');
  return rawList
    .map((p) => String(p).trim().replace(/\\/g, '/').replace(/^\.\//, ''))
    .filter(Boolean);
}

function globToRegExp(globPattern) {
  let regexStr = '^';
  for (let i = 0; i < globPattern.length; i += 1) {
    const ch = globPattern[i];
    if (ch === '*') {
      if (globPattern[i + 1] === '*') {
        regexStr += '.*';
        i += 1;
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
  for (const rawPattern of allowedPatterns) {
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

/**
 * Scans git diff / untracked files (or full workspace when `allFiles: true` or non-git)
 * for hardcoded secrets, dangerous execution sinks, XSS sinks, SQL string interpolation,
 * and optional slice-ownership boundary violations (`allowPaths`).
 *
 * @param {object} [options]
 * @param {string} [options.cwd=process.cwd()]
 * @param {string|null} [options.base=null]
 * @param {boolean} [options.allFiles=false]
 * @param {string|string[]|null} [options.allowPaths=null]
 */
export function runAuditDiff({
  cwd = process.cwd(),
  base = null,
  allFiles = false,
  allowPaths = null,
  slice = null,
} = {}) {
  if (base !== null && base !== undefined) {
    const trimmedBase = String(base).trim();
    if (trimmedBase.startsWith('-')) {
      throw new Error(`Invalid base revision "${trimmedBase}": revision must not start with "-".`);
    }
  }

  const resolvedCwd = path.resolve(cwd);
  let effectiveAllowPaths = allowPaths;
  if (!effectiveAllowPaths && slice) {
    const sliceSpec = resolveSliceSpec(resolvedCwd, slice);
    effectiveAllowPaths = sliceSpec.allowPaths;
  }

  const allowedPatterns = parseAllowPaths(effectiveAllowPaths);
  const realCwd = fs.existsSync(resolvedCwd) ? fs.realpathSync(resolvedCwd) : resolvedCwd;
  const gitTopLevel = !allFiles ? getGitTopLevel(realCwd) : null;

  const candidates = gitTopLevel
    ? collectGitChangedFiles(realCwd, gitTopLevel, base)
    : walkAllCandidateFiles(realCwd, realCwd);

  candidates.sort((a, b) => a.relPath.localeCompare(b.relPath));

  let filesScanned = 0;
  const findings = [];

  for (const item of candidates) {
    if (allowedPatterns.length > 0 && !matchesAllowedPath(item.relPath, allowedPatterns)) {
      findings.push({
        rule: 'slice-boundary-violation',
        severity: 'high',
        file: item.relPath,
        line: 1,
        snippet: `Allowed slice paths: ${allowedPatterns.join(', ')}`,
        message: `File "${item.relPath}" is outside allowed slice ownership (${allowedPatterns.join(', ')}).`,
      });
    }
    const res = scanFileLines(item.absPath, item.relPath);
    if (res.scanned) {
      filesScanned += 1;
      findings.push(...res.findings);
    }
  }

  const hasHigh = findings.some((f) => f.severity === 'high');
  const status = hasHigh ? 'FLAGGED' : findings.length > 0 ? 'WARN' : 'APPROVE_CANDIDATE';

  return {
    cwd: resolvedCwd,
    status,
    filesScanned,
    findings,
  };
}
