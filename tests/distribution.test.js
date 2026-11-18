import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { runInit } from "../plugins/antigravity-factory/lib/init.js";
function setup(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "factory install "));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}
test("malformed registration is preserved instead of overwritten", (t) => {
  const cwd = setup(t);
  fs.mkdirSync(path.join(cwd, ".agents"));
  fs.writeFileSync(path.join(cwd, ".agents/plugins.json"), "{invalid");
  assert.throws(
    () => runInit({ cwd, mode: "copy" }),
    /registration|JSON|manifest/i,
  );
  assert.equal(
    fs.readFileSync(path.join(cwd, ".agents/plugins.json"), "utf8"),
    "{invalid",
  );
  assert.equal(fs.existsSync(path.join(cwd, ".agents/plugins")), false);
});
test("copy upgrade refuses modified managed files and preserves unrelated files", (t) => {
  const cwd = setup(t);
  runInit({ cwd, mode: "copy" });
  const plugin = path.join(cwd, ".agents/plugins/antigravity-factory");
  fs.writeFileSync(path.join(plugin, "personal.txt"), "keep");
  const manifest = path.join(plugin, "plugin.json");
  fs.appendFileSync(manifest, "\n ");
  assert.throws(() => runInit({ cwd, mode: "copy" }), /modified|conflict/i);
  assert.equal(
    fs.readFileSync(path.join(plugin, "personal.txt"), "utf8"),
    "keep",
  );
});
test("copy upgrades remove only stale managed files", (t) => {
  const cwd = setup(t),
    source = path.join(cwd, "source/antigravity-factory"),
    target = path.join(cwd, "target");
  fs.mkdirSync(source, { recursive: true });
  fs.writeFileSync(
    path.join(source, "plugin.json"),
    '{"name":"antigravity-factory"}',
  );
  fs.writeFileSync(path.join(source, "old.txt"), "old");
  runInit({ cwd: target, mode: "copy", pluginSourceDir: source });
  fs.rmSync(path.join(source, "old.txt"));
  fs.writeFileSync(path.join(source, "new.txt"), "new");
  runInit({ cwd: target, mode: "copy", pluginSourceDir: source });
  assert.equal(
    fs.existsSync(
      path.join(target, ".agents/plugins/antigravity-factory/old.txt"),
    ),
    false,
  );
  assert.equal(
    fs.readFileSync(
      path.join(target, ".agents/plugins/antigravity-factory/new.txt"),
      "utf8",
    ),
    "new",
  );
});
test("release bundle is complete and runs independently from a read-only extracted directory", async (t) => {
  const { spawnSync } = await import("node:child_process");
  const cwd = setup(t);
  const result = spawnSync(
    process.execPath,
    ["scripts/package-plugin.js", "--out", cwd],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr);
  const files = fs.readdirSync(cwd);
  assert.ok(files.some((p) => p.endsWith(".tgz")));
  const smoke = spawnSync(
    process.execPath,
    [
      "scripts/smoke-plugin.js",
      path.join(
        cwd,
        files.find((p) => p.endsWith(".tgz")),
      ),
    ],
    { encoding: "utf8" },
  );
  assert.equal(smoke.status, 0, smoke.stderr);
});
test("installer refuses symlink registration paths", (t) => {
  const cwd = setup(t),
    external = path.join(cwd, "external");
  fs.mkdirSync(external);
  fs.symlinkSync(external, path.join(cwd, ".agents"));
  assert.throws(() => runInit({ cwd, mode: "copy" }), /symlink/i);
  assert.deepEqual(fs.readdirSync(external), []);
});
test("read-only unrelated directories survive successful copy upgrade cleanup", (t) => {
  const cwd = setup(t);
  runInit({ cwd, mode: "copy" });
  const bundle = path.join(cwd, ".agents/plugins/antigravity-factory"),
    privateDir = path.join(bundle, "user-private");
  fs.mkdirSync(privateDir);
  fs.writeFileSync(path.join(privateDir, "note.txt"), "keep");
  fs.chmodSync(privateDir, 0o555);
  t.after(() => {
    if (fs.existsSync(privateDir)) fs.chmodSync(privateDir, 0o755);
  });
  assert.doesNotThrow(() => runInit({ cwd, mode: "copy" }));
  assert.ok(fs.existsSync(path.join(bundle, "plugin.json")));
  assert.equal(
    fs.readFileSync(path.join(privateDir, "note.txt"), "utf8"),
    "keep",
  );
});

test("runInit deduplicates link/copy plugin registrations, refuses symlinked pre-commit hook, and packaging/smoke scripts pass", async (t) => {
  const os = await import("node:os");
  const { execFileSync } = await import("node:child_process");
  const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");

  // 1. Switching link <-> copy deduplicates .agents/plugins.json
  const cwd = setup(t);
  runInit({ cwd, mode: "link" });
  runInit({ cwd, mode: "copy" });
  runInit({ cwd, mode: "link" });
  const regPath = path.join(cwd, ".agents", "plugins.json");
  const reg = JSON.parse(fs.readFileSync(regPath, "utf8"));
  const entries = Array.isArray(reg) ? reg : reg.entries || reg.plugins || [];
  const matches = entries.filter((e) => {
    const p = typeof e === "string" ? e : e.path || e.source || e.id || e.name || "";
    return String(p).includes("antigravity-factory");
  });
  assert.equal(matches.length, 1, `Expected 1 deduplicated registration, got ${JSON.stringify(entries)}`);

  // 2. gitHook refuses symlinked .git/hooks/pre-commit
  const hookCwd = setup(t);
  execFileSync("git", ["init", "-q"], { cwd: hookCwd });
  const hooksDir = path.join(hookCwd, ".git", "hooks");
  fs.mkdirSync(hooksDir, { recursive: true });
  const targetHook = path.join(hookCwd, "outside-hook.sh");
  fs.writeFileSync(targetHook, "#!/bin/sh\necho untouched\n");
  fs.symlinkSync(targetHook, path.join(hooksDir, "pre-commit"));
  assert.throws(() => runInit({ cwd: hookCwd, mode: "link", gitHook: true }));
  assert.equal(fs.readFileSync(targetHook, "utf8"), "#!/bin/sh\necho untouched\n");

  // 3. package-plugin.js --out <tmp> includes references/entry-paths.md and excludes .DS_Store/node_modules
  const pkgOut = fs.mkdtempSync(path.join(os.tmpdir(), "agy-pkg-out-"));
  t.after(() => fs.rmSync(pkgOut, { recursive: true, force: true }));
  execFileSync(
    process.execPath,
    [path.join(repoRoot, "scripts", "package-plugin.js"), "--out", pkgOut],
    { cwd: repoRoot, stdio: "pipe" }
  );
  const archives = fs.readdirSync(pkgOut).filter((f) => f.endsWith(".tar.gz") || f.endsWith(".tgz"));
  assert.equal(archives.length, 1, `Expected 1 tarball in ${pkgOut}, got ${JSON.stringify(fs.readdirSync(pkgOut))}`);
  const tarEntries = execFileSync("tar", ["-tzf", path.join(pkgOut, archives[0])], {
    encoding: "utf8",
  });
  assert.match(tarEntries, /skills\/factory-intake\/references\/entry-paths\.md/);
  assert.doesNotMatch(tarEntries, /node_modules|\.DS_Store/);

  // 4. smoke-plugin.js passes cleanly against packaged tarball
  const smokeOut = execFileSync(
    process.execPath,
    [path.join(repoRoot, "scripts", "smoke-plugin.js"), path.join(pkgOut, archives[0])],
    { cwd: repoRoot, encoding: "utf8" }
  );
  assert.ok(smokeOut !== undefined);
});
