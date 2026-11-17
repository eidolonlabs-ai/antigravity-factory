import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { hash } from "./policy.js";
import { readRecord, writeRecord } from "./records.js";
function inventory(root, dir = root, result = {}) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (["node_modules", ".DS_Store"].includes(e.name)) continue;
    const full = path.join(dir, e.name),
      rel = path.relative(root, full).split(path.sep).join("/");
    if (e.isSymbolicLink())
      throw new Error(`Plugin bundle contains symlink: ${rel}`);
    if (e.isDirectory()) inventory(root, full, result);
    else if (e.isFile()) result[rel] = hash(fs.readFileSync(full));
  }
  return result;
}
function removeOwnedTree(dir) {
  if (!fs.existsSync(dir)) return;
  const makeWritable = (p) => {
    const st = fs.lstatSync(p);
    if (st.isDirectory()) {
      fs.chmodSync(p, st.mode | 0o700);
      for (const n of fs.readdirSync(p)) makeWritable(path.join(p, n));
    }
  };
  makeWritable(dir);
  fs.rmSync(dir, { recursive: true, force: true });
}
export function prepareCopy(cwd, source, target) {
  const incoming = inventory(source),
    current = fs.existsSync(target) ? inventory(target) : {},
    record = readRecord(cwd, "plugin-install.json");
  const managed =
    record?.schemaVersion === 1 && record.target === target
      ? record.files
      : null;
  if (managed)
    for (const [rel, digest] of Object.entries(managed)) {
      if (
        path.isAbsolute(rel) ||
        rel.split(/[\\/]/).includes("..") ||
        typeof digest !== "string" ||
        !/^[a-f0-9]{64}$/.test(digest)
      )
        throw new Error("Invalid managed plugin inventory");
    }
  for (const [rel, digest] of Object.entries(current)) {
    if (managed && Object.hasOwn(managed, rel)) {
      if (managed[rel] !== digest)
        throw new Error(
          `Plugin file modified: ${rel}. Back up or reconcile before updating.`,
        );
    } else if (Object.hasOwn(incoming, rel) && incoming[rel] !== digest)
      throw new Error(
        `Plugin copy conflict: ${rel}. Preserve local edits before updating.`,
      );
  }
  if (managed)
    for (const rel of Object.keys(managed))
      if (!Object.hasOwn(current, rel))
        throw new Error(`Plugin file modified/deleted: ${rel}`);
  const parent = path.dirname(target);
  fs.mkdirSync(parent, { recursive: true });
  const id = crypto.randomUUID(),
    stage = path.join(parent, `.factory-stage-${id}`),
    backup = path.join(parent, `.factory-backup-${id}`);
  fs.mkdirSync(stage);
  try {
    if (fs.existsSync(target)) fs.cpSync(target, stage, { recursive: true });
    if (managed)
      for (const rel of Object.keys(managed))
        if (!Object.hasOwn(incoming, rel))
          fs.rmSync(path.join(stage, rel), { force: true });
    fs.cpSync(source, stage, {
      recursive: true,
      filter: (src) =>
        !["node_modules", ".DS_Store"].includes(path.basename(src)),
    });
    const writable = (dir) => {
      fs.chmodSync(dir, 0o755);
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, entry.name);
        if (entry.isDirectory()) writable(p);
        else if (
          Object.hasOwn(
            incoming,
            path.relative(stage, p).split(path.sep).join("/"),
          )
        )
          fs.chmodSync(p, fs.statSync(p).mode | 0o200);
      }
    };
    writable(stage);
    if (fs.existsSync(target)) fs.renameSync(target, backup);
    fs.renameSync(stage, target);
  } catch (e) {
    removeOwnedTree(stage);
    if (fs.existsSync(backup) && !fs.existsSync(target))
      fs.renameSync(backup, target);
    throw e;
  }
  return {
    commit() {
      writeRecord(cwd, "plugin-install.json", {
        schemaVersion: 1,
        target,
        files: incoming,
      });
      // Inventory commit is the transaction boundary. Cleanup must never trigger
      // rollback from a backup that may have been partially removed.
      try {
        removeOwnedTree(backup);
        return {};
      } catch (error) {
        return { backupPath: backup, cleanupWarning: error.message };
      }
    },
    rollback() {
      removeOwnedTree(target);
      if (fs.existsSync(backup)) fs.renameSync(backup, target);
    },
  };
}
