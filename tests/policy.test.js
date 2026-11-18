import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import {
  runVerify,
  computeWorkspaceDigest,
} from "../plugins/antigravity-factory/lib/verify.js";
function project(t, policy = {}) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "factory-policy-"));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  fs.writeFileSync(
    path.join(cwd, ".gitignore"),
    ".env\n.factory/\nnode_modules/\n",
  );
  fs.writeFileSync(
    path.join(cwd, "package.json"),
    JSON.stringify({
      name: "fixture",
      scripts: { test: 'node -e "process.exit(0)"' },
    }),
  );
  fs.writeFileSync(path.join(cwd, ".factory.json"), JSON.stringify(policy));
  return cwd;
}
test("required component checks cannot be substituted by another passing test", (t) => {
  const cwd = project(t, {
    schemaVersion: 1,
    verification: { requiredChecks: [{ component: "web", category: "test" }] },
  });
  assert.equal(runVerify({ cwd }).ok, false);
});
test("malformed policy fails rather than weakening verification", (t) => {
  const cwd = project(t);
  fs.writeFileSync(path.join(cwd, ".factory.json"), "{");
  assert.throws(() => runVerify({ cwd }), /policy|JSON|config/i);
});
test("custom commands are required and policy selectors use root dot", (t) => {
  const cwd = project(t, {
    schemaVersion: 1,
    verification: {
      requiredChecks: [{ component: ".", category: "test" }],
      commands: [
        { id: "integration", cwd: ".", command: 'node -e "process.exit(1)"' },
      ],
    },
  });
  assert.equal(runVerify({ cwd }).ok, false);
});
test("verification refuses a changed subject during a successful test", (t) => {
  const cwd = project(t);
  fs.writeFileSync(
    path.join(cwd, "package.json"),
    JSON.stringify({
      scripts: {
        test: `node -e "require('fs').writeFileSync('changed.txt','changed')"`,
      },
    }),
  );
  assert.equal(runVerify({ cwd }).ok, false);
});
test("HEAD changes invalidate even clean workspace digests", (t) => {
  const cwd = project(t);
  const git = (...args) => execFileSync("git", args, { cwd, stdio: "ignore" });
  git("init");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "Test");
  git("add", ".");
  git("commit", "-m", "initial");
  const a = computeWorkspaceDigest(cwd);
  fs.writeFileSync(path.join(cwd, "source.txt"), "new");
  git("add", ".");
  git("commit", "-m", "change");
  assert.notEqual(a, computeWorkspaceDigest(cwd));
});
test("generated factory records do not invalidate receipts", (t) => {
  const cwd = project(t);
  const receipt = runVerify({ cwd });
  assert.equal(receipt.ok, true);
  assert.equal(receipt.schemaVersion, 1);
  assert.equal(receipt.digest, computeWorkspaceDigest(cwd));
});
test("verification actually executes child node:test suites inside node:test", (t) => {
  const cwd = project(t);
  fs.writeFileSync(
    path.join(cwd, "fail.test.cjs"),
    `require('node:test')('fails',()=>{throw new Error('real failure')})`,
  );
  fs.writeFileSync(
    path.join(cwd, "package.json"),
    JSON.stringify({ scripts: { test: "node --test fail.test.cjs" } }),
  );
  assert.equal(runVerify({ cwd }).ok, false);
});
test("staged blobs, large file changes and symlink targets invalidate passing subjects", (t) => {
  const cwd = project(t);
  const git = (...args) => execFileSync("git", args, { cwd, stdio: "ignore" });
  git("init");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "Test");
  fs.writeFileSync(path.join(cwd, "source.txt"), "base");
  git("add", ".");
  git("commit", "-m", "initial");
  const file = path.join(cwd, "source.txt");
  fs.writeFileSync(file, "stagedA");
  git("add", "source.txt");
  fs.writeFileSync(file, "working");
  const a = runVerify({ cwd });
  fs.writeFileSync(file, "stagedB");
  git("add", "source.txt");
  fs.writeFileSync(file, "working");
  assert.notEqual(a.digest, computeWorkspaceDigest(cwd));
  fs.writeFileSync(file, "a".repeat(11 * 1024 * 1024));
  const b = runVerify({ cwd });
  fs.writeFileSync(file, "b".repeat(11 * 1024 * 1024));
  assert.notEqual(b.digest, computeWorkspaceDigest(cwd));
  fs.symlinkSync("source.txt", path.join(cwd, "link"));
  const c = runVerify({ cwd });
  fs.unlinkSync(path.join(cwd, "link"));
  fs.symlinkSync("package.json", path.join(cwd, "link"));
  assert.notEqual(c.digest, computeWorkspaceDigest(cwd));
});
test("policy validates command bounds, mappings and schema", (t) => {
  for (const verification of [
    { commands: [{ id: "x", command: "true", timeoutMs: 999 }] },
    { commands: [{ id: "x", command: "true", timeoutMs: 1800001 }] },
    { commands: [{ id: "x", command: "true", providesEvidence: "review" }] },
    {
      commands: [
        { id: "x", command: "true" },
        { id: "x", command: "true" },
      ],
    },
    { commands: [{ id: "x", command: "true", cwd: ".." }] },
    { artifactRoots: ["relative"] },
    { requiredChecks: [{ component: ".", category: "missing" }] },
  ])
    assert.throws(() => runVerify({ cwd: project(t, { verification }) }));
  assert.throws(() => runVerify({ cwd: project(t, { schemaVersion: 99 }) }));
});
