import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
const skipped = new Set([
  ".git",
  ".factory",
  "node_modules",
  "dist",
  "build",
  "coverage",
  "__pycache__",
]);
const internal = (p) => p.split("/").includes(".factory");
function git(cwd, args) {
  const r = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
    timeout: 15000,
  });
  if (r.error || r.status !== 0)
    throw new Error(
      `Git inspection failed (${args[0]}): ${r.error?.message || r.stderr}`,
    );
  return r.stdout;
}
export function snapshotWorkspace(cwd) {
  const root = fs.realpathSync(cwd),
    probe = spawnSync("git", ["rev-parse", "--show-toplevel"], {
      cwd: root,
      encoding: "utf8",
      timeout: 15000,
    });
  let names = [],
    index = "",
    head = "",
    hasChanges = false;
  if (probe.status === 0) {
    const headResult = spawnSync("git", ["rev-parse", "--verify", "HEAD"], {
      cwd: root,
      encoding: "utf8",
      timeout: 15000,
    });
    if (headResult.status === 0) head = headResult.stdout.trim();
    else {
      git(root, ["symbolic-ref", "HEAD"]);
      const refs = spawnSync("git", ["show-ref", "--head"], {
        cwd: root,
        encoding: "utf8",
      });
      if (refs.error || ![0, 1].includes(refs.status))
        throw new Error("Cannot inspect unborn Git HEAD");
      if (refs.stdout) throw new Error("Cannot resolve Git HEAD");
    }
    index = git(root, ["ls-files", "--stage", "-z", "--", "."])
      .split("\0")
      .filter((e) => e && !internal(e.slice(e.indexOf("\t") + 1)))
      .sort()
      .join("\0");
    names = [
      ...new Set(
        git(root, [
          "ls-files",
          "--cached",
          "--others",
          "--exclude-standard",
          "-z",
          "--",
          ".",
        ])
          .split("\0")
          .filter((p) => p && !internal(p)),
      ),
    ].sort();
    hasChanges = git(root, ["status", "--porcelain", "-z", "-uall", "--", "."])
      .split("\0")
      .some((e) => e && !internal(e.slice(3)));
  } else {
    let ancestor = root;
    while (true) {
      if (fs.existsSync(path.join(ancestor, ".git")))
        throw new Error("Git workspace inspection failed");
      const parent = path.dirname(ancestor);
      if (parent === ancestor) break;
      ancestor = parent;
    }
    const walk = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (skipped.has(entry.name)) continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else names.push(path.relative(root, full).split(path.sep).join("/"));
      }
    };
    walk(root);
    names.sort();
  }
  const digest = crypto.createHash("sha256");
  digest.update(JSON.stringify({ head, index }));
  for (const name of names) {
    const full = path.join(root, name);
    let st;
    try {
      st = fs.lstatSync(full);
    } catch (e) {
      if (e.code === "ENOENT") {
        digest.update(JSON.stringify([name, "deleted"]));
        continue;
      }
      throw e;
    }
    if (st.isSymbolicLink()) {
      digest.update(JSON.stringify([name, "symlink", fs.readlinkSync(full)]));
      continue;
    }
    if (!st.isFile())
      throw new Error(
        `Unsupported source entry: ${name}; submodules require separate verification`,
      );
    digest.update(JSON.stringify([name, "file", st.mode & 0o777, st.size]));
    digest.update(fs.readFileSync(full));
  }
  return { digest: digest.digest("hex"), hasChanges };
}
