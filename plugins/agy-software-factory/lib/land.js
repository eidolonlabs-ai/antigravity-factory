import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { runAuditDiff, matchesAllowedPath } from './audit-diff.js';
import { normalizeAllowPathsList, resolveSliceSpec } from './spec.js';

function resolveHeadSha(repoDir) {
  const res = spawnSync('git', ['rev-parse', '--verify', 'HEAD'], {
    cwd: repoDir,
    encoding: 'utf8',
    timeout: 10_000,
  });
  if (res.status !== 0) return null;
  const sha = (res.stdout || '').trim();
  return sha || null;
}

function resolveDiffBaseSha(coordinatorDir, worktreeDir) {
  const targetHeadSha = resolveHeadSha(coordinatorDir);
  if (!targetHeadSha) return null;
  const res = spawnSync('git', ['merge-base', targetHeadSha, 'HEAD'], {
    cwd: worktreeDir,
    encoding: 'utf8',
    timeout: 10_000,
  });
  if (res.status === 0) {
    const mergeBase = (res.stdout || '').trim();
    if (mergeBase) return mergeBase;
  }
  return targetHeadSha;
}

function isFactoryPath(relPath) {
  return relPath === '.factory' || relPath.startsWith('.factory/');
}

function collectWorktreeChanges(worktreeDir, baseSha = null) {
  const checkRes = spawnSync('git', ['rev-parse', '--is-inside-work-tree'], {
    cwd: worktreeDir,
    encoding: 'utf8',
    timeout: 10_000,
  });
  if (checkRes.status !== 0) {
    throw new Error(`Worktree at "${worktreeDir}" is not a valid git working tree.`);
  }

  const modifiedOrAdded = [];
  const deleted = [];

  if (baseSha) {
    const diffRes = spawnSync(
      'git',
      ['diff', '--name-status', '--no-renames', '-z', baseSha, '--'],
      {
        cwd: worktreeDir,
        encoding: 'utf8',
        timeout: 15_000,
        maxBuffer: 10 * 1024 * 1024,
      }
    );
    if (diffRes.status === 0 && diffRes.stdout) {
      const tokens = diffRes.stdout.split('\0');
      for (let i = 0; i < tokens.length; i += 2) {
        const status = tokens[i];
        const rawPath = tokens[i + 1];
        if (!status || !rawPath) continue;
        const relPath = rawPath.replace(/\\/g, '/');
        if (isFactoryPath(relPath)) continue;
        if (status.startsWith('D')) {
          deleted.push(relPath);
        } else {
          modifiedOrAdded.push(relPath);
        }
      }
    }

    const untrackedRes = spawnSync(
      'git',
      ['ls-files', '--others', '--exclude-standard', '-z'],
      {
        cwd: worktreeDir,
        encoding: 'utf8',
        timeout: 15_000,
        maxBuffer: 10 * 1024 * 1024,
      }
    );
    if (untrackedRes.status === 0 && untrackedRes.stdout) {
      for (const rawPath of untrackedRes.stdout.split('\0')) {
        if (!rawPath) continue;
        const relPath = rawPath.replace(/\\/g, '/');
        if (isFactoryPath(relPath)) continue;
        modifiedOrAdded.push(relPath);
      }
    }
  } else {
    const res = spawnSync('git', ['status', '--porcelain', '-z', '-uall'], {
      cwd: worktreeDir,
      encoding: 'utf8',
      timeout: 15_000,
      maxBuffer: 10 * 1024 * 1024,
    });
    const tokens = (res.stdout || '').split('\0');
    for (let i = 0; i < tokens.length; i += 1) {
      const entry = tokens[i];
      if (!entry || entry.length < 4) continue;
      const xy = entry.slice(0, 2);
      const relPath = entry.slice(3).replace(/\\/g, '/');
      if (xy[0] === 'R') {
        const origPath = (tokens[i + 1] || '').replace(/\\/g, '/');
        i += 1;
        if (origPath && !isFactoryPath(origPath)) {
          deleted.push(origPath);
        }
      } else if (xy[0] === 'C') {
        i += 1;
      }
      if (isFactoryPath(relPath)) {
        continue;
      }
      if (xy.includes('D')) {
        deleted.push(relPath);
      } else {
        modifiedOrAdded.push(relPath);
      }
    }
  }

  return {
    modifiedOrAdded: [...new Set(modifiedOrAdded)].sort(),
    deleted: [...new Set(deleted)].sort(),
  };
}

/**
 * Verifies a worker git worktree against slice ownership & security rules, then lands
 * owned changes into the coordinator workspace (`cwd`).
 *
 * @param {object} options
 * @param {string} [options.cwd=process.cwd()]
 * @param {string} options.worktree
 * @param {string|null} [options.slice=null]
 * @param {string|string[]|null} [options.allowPaths=null]
 * @param {boolean} [options.dryRun=false]
 * @param {boolean} [options.force=false]
 */
export function runLand({
  cwd = process.cwd(),
  worktree,
  slice = null,
  allowPaths = null,
  dryRun = false,
  force = false,
} = {}) {
  if (!worktree || typeof worktree !== 'string') {
    throw new Error('Missing required --worktree <path> argument for land command.');
  }

  const resolvedCwd = path.resolve(cwd);
  const resolvedWorktree = path.resolve(worktree);

  if (!fs.existsSync(resolvedWorktree) || !fs.statSync(resolvedWorktree).isDirectory()) {
    throw new Error(`Worktree directory does not exist: ${resolvedWorktree}`);
  }

  let effectiveAllowPaths = normalizeAllowPathsList(allowPaths);
  if (effectiveAllowPaths.length === 0 && slice) {
    const sliceSpec = resolveSliceSpec(resolvedCwd, slice);
    effectiveAllowPaths = sliceSpec.allowPaths;
  }

  if (effectiveAllowPaths.length === 0) {
    throw new Error(
      'Landing requires --allow-paths "<globs>" or --slice <name> (with .factory/spec.json) to enforce slice boundaries.'
    );
  }

  const diffBaseSha = resolveDiffBaseSha(resolvedCwd, resolvedWorktree);

  const audit = runAuditDiff({
    cwd: resolvedWorktree,
    base: diffBaseSha,
    allowPaths: effectiveAllowPaths,
  });

  const { modifiedOrAdded, deleted } = collectWorktreeChanges(
    resolvedWorktree,
    diffBaseSha
  );

  for (const relDelete of deleted) {
    if (!matchesAllowedPath(relDelete, effectiveAllowPaths)) {
      audit.findings.push({
        rule: 'slice-boundary-violation',
        severity: 'high',
        file: relDelete,
        line: 1,
        snippet: `Deleted file outside allowed slice paths: ${effectiveAllowPaths.join(', ')}`,
        message: `Deleted file "${relDelete}" is outside allowed slice ownership (${effectiveAllowPaths.join(', ')}).`,
      });
      audit.status = 'FLAGGED';
    }
  }

  if (audit.status === 'FLAGGED' && !force) {
    return {
      ok: false,
      dryRun: Boolean(dryRun),
      worktree: resolvedWorktree,
      targetDir: resolvedCwd,
      allowPaths: effectiveAllowPaths,
      landedFiles: [],
      deletedFiles: [],
      audit,
    };
  }

  const realWorktree = fs.realpathSync(resolvedWorktree);
  const realCwd = fs.existsSync(resolvedCwd) ? fs.realpathSync(resolvedCwd) : resolvedCwd;

  const landedFiles = [];
  const deletedFiles = [];

  for (const relPath of modifiedOrAdded) {
    if (!matchesAllowedPath(relPath, effectiveAllowPaths)) {
      continue;
    }
    const srcAbs = path.resolve(realWorktree, relPath);
    const destAbs = path.resolve(realCwd, relPath);

    if (!srcAbs.startsWith(`${realWorktree}${path.sep}`)) {
      continue;
    }
    if (!destAbs.startsWith(`${realCwd}${path.sep}`)) {
      continue;
    }

    let stat;
    try {
      stat = fs.lstatSync(srcAbs);
    } catch {
      continue;
    }
    if (stat.isSymbolicLink() || !stat.isFile()) {
      continue;
    }

    if (!dryRun) {
      fs.mkdirSync(path.dirname(destAbs), { recursive: true });
      fs.copyFileSync(srcAbs, destAbs);
    }
    landedFiles.push(relPath);
  }

  for (const relPath of deleted) {
    if (!matchesAllowedPath(relPath, effectiveAllowPaths)) {
      continue;
    }
    const destAbs = path.resolve(realCwd, relPath);
    if (!destAbs.startsWith(`${realCwd}${path.sep}`)) {
      continue;
    }
    if (!dryRun && fs.existsSync(destAbs)) {
      const stat = fs.lstatSync(destAbs);
      if (stat.isFile()) {
        fs.rmSync(destAbs, { force: true });
      }
    }
    deletedFiles.push(relPath);
  }

  return {
    ok: true,
    dryRun: Boolean(dryRun),
    worktree: resolvedWorktree,
    targetDir: resolvedCwd,
    allowPaths: effectiveAllowPaths,
    landedFiles,
    deletedFiles,
    audit,
  };
}
