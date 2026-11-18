import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { runAuditDiff, matchesAllowedPath } from "./audit-diff.js";
import { normalizeAllowPathsList, resolveSliceSpec } from "./spec.js";
import { runVerify, computeWorkspaceDigest } from "./verify.js";
import { loadFactoryPolicy, hash, within } from "./policy.js";
import { readRecord, factoryDirectory, writeRecord } from "./records.js";
import crypto from "node:crypto";

function resolveHeadSha(repoDir) {
  const res = spawnSync("git", ["rev-parse", "--verify", "HEAD"], {
    cwd: repoDir,
    encoding: "utf8",
    timeout: 10_000,
  });
  if (res.status !== 0) return null;
  const sha = (res.stdout || "").trim();
  return sha || null;
}

function resolveDiffBaseSha(coordinatorDir, worktreeDir) {
  const targetHeadSha = resolveHeadSha(coordinatorDir);
  if (!targetHeadSha)
    throw new Error("Landing requires a committed target Git repository");
  const res = spawnSync("git", ["merge-base", targetHeadSha, "HEAD"], {
    cwd: worktreeDir,
    encoding: "utf8",
    timeout: 10_000,
  });
  if (res.status === 0) {
    const mergeBase = (res.stdout || "").trim();
    if (mergeBase) return mergeBase;
  }
  throw new Error("Cannot resolve common Git base for landing");
}

function isFactoryPath(relPath) {
  return relPath === ".factory" || relPath.startsWith(".factory/");
}

function collectWorktreeChanges(worktreeDir, baseSha = null) {
  const checkRes = spawnSync("git", ["rev-parse", "--is-inside-work-tree"], {
    cwd: worktreeDir,
    encoding: "utf8",
    timeout: 10_000,
  });
  if (checkRes.status !== 0) {
    throw new Error(
      `Worktree at "${worktreeDir}" is not a valid git working tree.`,
    );
  }

  const modifiedOrAdded = [];
  const deleted = [];

  if (baseSha) {
    const diffRes = spawnSync(
      "git",
      ["diff", "--name-status", "--no-renames", "-z", baseSha, "--"],
      {
        cwd: worktreeDir,
        encoding: "utf8",
        timeout: 15_000,
        maxBuffer: 10 * 1024 * 1024,
      },
    );
    if (diffRes.status !== 0)
      throw new Error("Cannot enumerate worker changes");
    if (diffRes.stdout) {
      const tokens = diffRes.stdout.split("\0");
      for (let i = 0; i < tokens.length; i += 2) {
        const status = tokens[i];
        const rawPath = tokens[i + 1];
        if (!status || !rawPath) continue;
        const relPath = rawPath.replace(/\\/g, "/");
        if (isFactoryPath(relPath)) continue;
        if (status.startsWith("D")) {
          deleted.push(relPath);
        } else {
          modifiedOrAdded.push(relPath);
        }
      }
    }

    const untrackedRes = spawnSync(
      "git",
      ["ls-files", "--others", "--exclude-standard", "-z"],
      {
        cwd: worktreeDir,
        encoding: "utf8",
        timeout: 15_000,
        maxBuffer: 10 * 1024 * 1024,
      },
    );
    if (untrackedRes.status !== 0)
      throw new Error("Cannot enumerate untracked worker files");
    const untrackedSet = new Set();
    if (untrackedRes.stdout) {
      for (const rawPath of untrackedRes.stdout.split("\0")) {
        if (!rawPath) continue;
        const relPath = rawPath.replace(/\\/g, "/");
        if (isFactoryPath(relPath)) continue;
        untrackedSet.add(relPath);
        modifiedOrAdded.push(relPath);
      }
    }
    if (untrackedSet.size > 0) {
      for (let i = deleted.length - 1; i >= 0; i -= 1) {
        if (untrackedSet.has(deleted[i])) {
          deleted.splice(i, 1);
        }
      }
    }
  } else {
    const res = spawnSync("git", ["status", "--porcelain", "-z", "-uall"], {
      cwd: worktreeDir,
      encoding: "utf8",
      timeout: 15_000,
      maxBuffer: 10 * 1024 * 1024,
    });
    const tokens = (res.stdout || "").split("\0");
    for (let i = 0; i < tokens.length; i += 1) {
      const entry = tokens[i];
      if (!entry || entry.length < 4) continue;
      const xy = entry.slice(0, 2);
      const relPath = entry.slice(3).replace(/\\/g, "/");
      if (xy[0] === "R") {
        const origPath = (tokens[i + 1] || "").replace(/\\/g, "/");
        i += 1;
        if (origPath && !isFactoryPath(origPath)) {
          deleted.push(origPath);
        }
      } else if (xy[0] === "C") {
        i += 1;
      }
      if (isFactoryPath(relPath)) {
        continue;
      }
      if (xy.includes("D")) {
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
  if (!worktree || typeof worktree !== "string") {
    throw new Error(
      "Missing required --worktree <path> argument for land command.",
    );
  }

  const resolvedCwd = path.resolve(cwd);
  const resolvedWorktree = path.resolve(worktree);

  if (
    !fs.existsSync(resolvedWorktree) ||
    !fs.statSync(resolvedWorktree).isDirectory()
  ) {
    throw new Error(`Worktree directory does not exist: ${resolvedWorktree}`);
  }

  let effectiveAllowPaths = normalizeAllowPathsList(allowPaths);
  if (effectiveAllowPaths.length === 0 && slice) {
    const sliceSpec = resolveSliceSpec(resolvedCwd, slice);
    effectiveAllowPaths = sliceSpec.allowPaths;
  }

  if (effectiveAllowPaths.length === 0) {
    throw new Error(
      'Landing requires --allow-paths "<globs>" or --slice <name> (with .factory/spec.json) to enforce slice boundaries.',
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
    diffBaseSha,
  );

  for (const relDelete of deleted) {
    if (!matchesAllowedPath(relDelete, effectiveAllowPaths)) {
      audit.findings.push({
        rule: "slice-boundary-violation",
        severity: "high",
        file: relDelete,
        line: 1,
        snippet: `Deleted file outside allowed slice paths: ${effectiveAllowPaths.join(", ")}`,
        message: `Deleted file "${relDelete}" is outside allowed slice ownership (${effectiveAllowPaths.join(", ")}).`,
      });
      audit.status = "FLAGGED";
    }
  }

  const realWorktree = fs.realpathSync(resolvedWorktree);
  const realCwd = fs.realpathSync(resolvedCwd);
  const report = {
    ok: false,
    dryRun: Boolean(dryRun),
    worktree: realWorktree,
    targetDir: realCwd,
    allowPaths: effectiveAllowPaths,
    landedFiles: [],
    deletedFiles: [],
    audit,
    conflicts: [],
    verification: null,
    rolledBack: false,
    rollbackConflicts: [],
    requiresReview: true,
  };

  if (
    audit.findings.some((f) => f.rule === "slice-boundary-violation") ||
    (audit.status === "FLAGGED" && !force)
  ) {
    return report;
  }
  if (realWorktree === realCwd) {
    report.conflicts.push("Source and target must differ");
    return report;
  }
  const operations = [];
  try {
    for (const rel of [...modifiedOrAdded, ...deleted]) {
      if (!matchesAllowedPath(rel, effectiveAllowPaths))
        throw new Error(`Outside slice: ${rel}`);
      const before = snapshot(realCwd, rel),
        after = deleted.includes(rel) ? null : snapshot(realWorktree, rel);
      const base = baseSnapshot(realWorktree, diffBaseSha, rel);
      if (!same(before, base) && !same(before, after))
        throw new Error(`Target conflict: ${rel}`);
      // Staged content is user work even when the working copy has subsequently changed.
      const staged = spawnSync(
        "git",
        ["diff", "--cached", "--quiet", "--", rel],
        { cwd: realCwd },
      );
      if (staged.status !== 0)
        throw new Error(`Staged target conflict: ${rel}`);
      operations.push({ rel, before, after });
    }
  } catch (e) {
    report.conflicts.push(e.message);
    return report;
  }
  const receipt = readRecord(realWorktree, "verify-receipt.json");
  const subject = computeWorkspaceDigest(realWorktree),
    policy = loadFactoryPolicy(realWorktree);
  const workerVerified =
    receipt?.schemaVersion === 1 &&
    receipt.ok === true &&
    receipt.workspaceIdentity === hash(realWorktree) &&
    receipt.subjectDigest === subject &&
    receipt.policyDigest === policy.policyDigest;
  if (!workerVerified)
    report.conflicts.push(
      "Worker needs fresh passing deterministic verification",
    );
  if (dryRun) {
    report.ok = report.conflicts.length === 0;
    report.landedFiles = modifiedOrAdded;
    report.deletedFiles = deleted;
    return report;
  }
  if (!workerVerified) return report;
  const dir = factoryDirectory(realCwd),
    lock = path.join(dir, "land.lock");
  let handle;
  try {
    handle = fs.openSync(lock, "wx", 0o600);
    fs.writeFileSync(
      handle,
      JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }) + "\n",
      "utf8",
    );
  } catch {
    report.conflicts.push(
      "Another landing holds .factory/land.lock; inspect before manual recovery",
    );
    return report;
  }
  const applied = [],
    recoveryName = `land-recovery-${crypto.randomUUID()}.json`;
  try {
    if (computeWorkspaceDigest(realWorktree) !== subject)
      throw new Error("Worker changed during preflight");
    for (const op of operations)
      if (!same(snapshot(realCwd, op.rel), op.before))
        throw new Error(`Target changed during preflight: ${op.rel}`);
    writeRecord(realCwd, recoveryName, { schemaVersion: 1, operations });
    for (const op of operations) {
      if (!same(snapshot(realCwd, op.rel), op.before))
        throw new Error(`Target changed during apply: ${op.rel}`);
      applySnapshot(realCwd, op.rel, op.after);
      applied.push(op);
    }
    report.verification = runVerify({ cwd: realCwd });
    if (!report.verification.ok)
      throw new Error("Integrated verification failed");
    report.ok = true;
    report.landedFiles = modifiedOrAdded;
    report.deletedFiles = deleted;
    fs.rmSync(path.join(dir, recoveryName), { force: true });
  } catch (e) {
    report.conflicts.push(e.message);
    for (const op of applied.reverse()) {
      try {
        if (!same(snapshot(realCwd, op.rel), op.after)) {
          report.rollbackConflicts.push(op.rel);
          continue;
        }
        applySnapshot(realCwd, op.rel, op.before);
      } catch {
        report.rollbackConflicts.push(op.rel);
      }
    }
    report.rolledBack =
      applied.length > 0 && report.rollbackConflicts.length === 0;
    if (report.rollbackConflicts.length)
      report.recoveryPath = path.join(dir, recoveryName);
    else fs.rmSync(path.join(dir, recoveryName), { force: true });
  } finally {
    fs.closeSync(handle);
    fs.rmSync(lock, { force: true });
  }
  return report;
}

function safePath(root, rel) {
  const target = path.resolve(root, rel);
  if (!within(root, target) || target === root)
    throw new Error(`Unsafe landing path: ${rel}`);
  let cursor = root;
  for (const part of path.relative(root, target).split(path.sep)) {
    cursor = path.join(cursor, part);
    try {
      if (fs.lstatSync(cursor).isSymbolicLink())
        throw new Error(`Symlink landing path: ${rel}`);
    } catch (e) {
      if (e.code !== "ENOENT") throw e;
    }
  }
  return target;
}
function snapshot(root, rel) {
  const target = safePath(root, rel);
  try {
    const stat = fs.lstatSync(target);
    if (!stat.isFile()) throw new Error(`Non-file landing path: ${rel}`);
    return {
      data: fs.readFileSync(target).toString("base64"),
      mode: stat.mode & 0o777,
    };
  } catch (e) {
    if (e.code === "ENOENT") return null;
    throw e;
  }
}
function baseSnapshot(root, base, rel) {
  const listing = spawnSync("git", ["ls-tree", "-z", base, "--", rel], {
    cwd: root,
    encoding: "utf8",
  });
  if (listing.status !== 0) throw new Error("Cannot inspect base tree");
  if (!listing.stdout) return null;
  const mode = listing.stdout.split(" ")[0];
  if (!["100644", "100755"].includes(mode))
    throw new Error(`Unsupported base path: ${rel}`);
  const data = spawnSync("git", ["show", `${base}:${rel}`], {
    cwd: root,
    maxBuffer: 50 * 1024 * 1024,
  });
  if (data.status !== 0) throw new Error(`Cannot read base: ${rel}`);
  return {
    data: data.stdout.toString("base64"),
    mode: mode === "100755" ? 0o755 : 0o644,
  };
}
function same(a, b) {
  return a === null
    ? b === null
    : b !== null && a.data === b.data && a.mode === b.mode;
}
function applySnapshot(root, rel, value) {
  const target = safePath(root, rel);
  if (value === null) {
    fs.rmSync(target, { force: true });
    return;
  }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const tmp = path.join(
    path.dirname(target),
    `.factory-land-${crypto.randomUUID()}`,
  );
  try {
    fs.writeFileSync(tmp, Buffer.from(value.data, "base64"), {
      mode: value.mode,
      flag: "wx",
    });
    fs.chmodSync(tmp, value.mode);
    fs.renameSync(tmp, target);
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}
