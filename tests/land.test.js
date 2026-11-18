import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { runLand } from "../plugins/antigravity-factory/lib/land.js";
import { runVerify } from "../plugins/antigravity-factory/lib/verify.js";
function setup(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "land-safe-")),
    cwd = path.join(root, "main"),
    worker = path.join(root, "worker");
  fs.mkdirSync(cwd);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const git = (...a) => execFileSync("git", a, { cwd, stdio: "ignore" });
  git("init");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "Test");
  fs.writeFileSync(path.join(cwd, ".gitignore"), ".env\n.factory/\n");
  fs.mkdirSync(path.join(cwd, "src"));
  fs.writeFileSync(path.join(cwd, "src/app.js"), "original");
  git("add", ".");
  git("commit", "-m", "base");
  git("worktree", "add", worker, "-b", "worker");
  fs.writeFileSync(path.join(worker, "src/app.js"), "worker");
  return { cwd, worker, git };
}
test("landing rejects dirty and committed target conflicts without writing", (t) => {
  const { cwd, worker, git } = setup(t);
  runVerify({ cwd: worker });
  fs.writeFileSync(path.join(cwd, "src/app.js"), "developer");
  for (const committed of [false, true]) {
    if (committed) {
      git("add", ".");
      git("commit", "-m", "developer");
    }
    const r = runLand({
      cwd,
      worktree: worker,
      allowPaths: ["src/**"],
      force: true,
    });
    assert.equal(r.ok, false);
    assert.equal(
      fs.readFileSync(path.join(cwd, "src/app.js"), "utf8"),
      "developer",
    );
  }
});
test("landing requires worker verification and verifies integrated state", (t) => {
  const { cwd, worker } = setup(t);
  assert.equal(
    runLand({ cwd, worktree: worker, allowPaths: ["src/**"] }).ok,
    false,
  );
  runVerify({ cwd: worker });
  const r = runLand({ cwd, worktree: worker, allowPaths: ["src/**"] });
  assert.equal(r.ok, true);
  assert.equal(r.verification.ok, true);
  assert.equal(r.requiresReview, true);
});
test("target symlink parents and force cannot escape ownership", (t) => {
  const { cwd, worker } = setup(t);
  runVerify({ cwd: worker });
  fs.renameSync(path.join(cwd, "src"), path.join(cwd, "real"));
  fs.symlinkSync("real", path.join(cwd, "src"));
  assert.equal(
    runLand({ cwd, worktree: worker, allowPaths: ["src/**"], force: true }).ok,
    false,
  );
  assert.equal(
    fs.readFileSync(path.join(cwd, "real/app.js"), "utf8"),
    "original",
  );
});
test("failed integrated verification restores only lander writes", (t) => {
  const { cwd, worker } = setup(t);
  runVerify({ cwd: worker });
  fs.writeFileSync(
    path.join(cwd, ".factory.json"),
    JSON.stringify({
      verification: {
        commands: [{ id: "reject", command: 'node -e "process.exit(1)"' }],
      },
    }),
  );
  const r = runLand({ cwd, worktree: worker, allowPaths: ["src/**"] });
  assert.equal(r.ok, false);
  assert.equal(r.rolledBack, true);
  assert.equal(
    fs.readFileSync(path.join(cwd, "src/app.js"), "utf8"),
    "original",
  );
});
test("edits during failing verification survive rollback with recovery details", (t) => {
  const { cwd, worker } = setup(t);
  runVerify({ cwd: worker });
  fs.writeFileSync(
    path.join(cwd, ".factory.json"),
    JSON.stringify({
      verification: {
        commands: [
          {
            id: "edit",
            command: `node -e "require('fs').writeFileSync('src/app.js','concurrent');process.exit(1)"`,
          },
        ],
      },
    }),
  );
  const r = runLand({ cwd, worktree: worker, allowPaths: ["src/**"] });
  assert.equal(r.ok, false);
  assert.deepEqual(r.rollbackConflicts, ["src/app.js"]);
  assert.equal(
    fs.readFileSync(path.join(cwd, "src/app.js"), "utf8"),
    "concurrent",
  );
  assert.ok(fs.existsSync(r.recoveryPath));
});
test("human landing output explains conflicts and recovery for preserved concurrent edits", async (t) => {
  const { runCli } =
    await import("../plugins/antigravity-factory/bin/agy-factory.js");
  const { cwd, worker } = setup(t);
  runVerify({ cwd: worker });
  fs.writeFileSync(
    path.join(cwd, ".factory.json"),
    JSON.stringify({
      verification: {
        commands: [
          {
            id: "edit",
            command: `node -e "require('fs').writeFileSync('src/app.js','concurrent');process.exit(1)"`,
          },
        ],
      },
    }),
  );
  let output = "";
  const code = runCli(
    ["land", "--cwd", cwd, "--worktree", worker, "--allow-paths", "src/**"],
    {
      stdout: { write: (s) => (output += s) },
      stderr: { write: (s) => (output += s) },
    },
  );
  assert.equal(code, 1);
  assert.match(output, /Integrated verification failed/);
  assert.match(output, /src\/app.js/);
  assert.match(output, /land-recovery-.*\.json/);
  assert.match(output, /preserved|manual/i);
});
