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

test("records, workspace, verify hygiene/polyglot/autoInstall, and compose isolation hardening", async (t) => {
  const fs = await import("node:fs");
  const path = await import("node:path");
  const os = await import("node:os");
  const { execFileSync } = await import("node:child_process");
  const { pathToFileURL } = await import("node:url");

  const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
  const { readRecord } = await import(
    pathToFileURL(path.join(repoRoot, "plugins/antigravity-factory/lib/records.js")).href
  );
  const { evaluateStatus } = await import(
    pathToFileURL(path.join(repoRoot, "plugins/antigravity-factory/lib/status.js")).href
  );
  const { snapshotWorkspace } = await import(
    pathToFileURL(path.join(repoRoot, "plugins/antigravity-factory/lib/workspace.js")).href
  );
  const { inspectComposeIsolation } = await import(
    pathToFileURL(path.join(repoRoot, "plugins/antigravity-factory/lib/verify.js")).href
  );

  // 1. readRecord rejects symlinked receipt and evaluateStatus reports UNVERIFIED
  const recDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-rec-"));
  const outSecret = path.join(os.tmpdir(), `agy-rec-target-${Date.now()}.json`);
  t.after(() => {
    fs.rmSync(recDir, { recursive: true, force: true });
    fs.rmSync(outSecret, { force: true });
  });
  fs.writeFileSync(
    outSecret,
    JSON.stringify({ status: "PASS", workspaceDigest: "abc", expiresAt: "2099-01-01T00:00:00Z" })
  );
  fs.mkdirSync(path.join(recDir, ".factory"), { recursive: true });
  fs.symlinkSync(outSecret, path.join(recDir, ".factory", "verify-receipt.json"));
  assert.equal(readRecord(recDir, "verify-receipt.json"), null);
  assert.equal(readRecord(recDir, "../outside.json"), null);
  assert.equal(evaluateStatus({ cwd: recDir }).outcome, "UNVERIFIED");

  // 2. snapshotWorkspace: orphan branch with other branches + symlinked parent dir isolation
  const wsDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-ws-"));
  const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-ws-out-"));
  t.after(() => {
    fs.rmSync(wsDir, { recursive: true, force: true });
    fs.rmSync(outsideDir, { recursive: true, force: true });
  });
  fs.writeFileSync(path.join(outsideDir, "secret.txt"), "outside-secret");
  execFileSync("git", ["init", "-q"], { cwd: wsDir });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: wsDir });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: wsDir });
  fs.mkdirSync(path.join(wsDir, "src"), { recursive: true });
  fs.writeFileSync(path.join(wsDir, "src", "secret.txt"), "tracked-inside\n");
  execFileSync("git", ["add", "src/secret.txt"], { cwd: wsDir });
  execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: wsDir });
  execFileSync("git", ["checkout", "-q", "--orphan", "fresh-orphan"], { cwd: wsDir });
  fs.rmSync(path.join(wsDir, "src"), { recursive: true, force: true });
  fs.symlinkSync(outsideDir, path.join(wsDir, "src"));
  const snap = snapshotWorkspace(wsDir);
  assert.match(snap.digest, /^[a-f0-9]{64}$/);
  assert.equal(typeof snap.hasChanges, "boolean");

  // 3. verify hygiene flags unignored .env.local, nested api/.env, tracked id_ecdsa/id_dsa,
  //    and does not auto-run npm install by default when node_modules is absent
  const hygDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-hyg-"));
  t.after(() => fs.rmSync(hygDir, { recursive: true, force: true }));
  execFileSync("git", ["init", "-q"], { cwd: hygDir });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: hygDir });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: hygDir });
  fs.writeFileSync(
    path.join(hygDir, "package.json"),
    JSON.stringify({
      name: "hyg-app",
      dependencies: { "nonexistent-pkg-for-test": "^1.0.0" },
      scripts: { test: "node -e \"process.exit(0)\"" },
    })
  );
  fs.mkdirSync(path.join(hygDir, "api"), { recursive: true });
  fs.writeFileSync(path.join(hygDir, ".env.local"), "SECRET=123\n");
  fs.writeFileSync(path.join(hygDir, "api", ".env"), "API_KEY=456\n");
  fs.writeFileSync(path.join(hygDir, "id_ecdsa"), "dummy-key\n");
  execFileSync("git", ["add", "package.json", "id_ecdsa"], { cwd: hygDir });
  execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: hygDir });
  const hygResult = runVerify({ cwd: hygDir, requireTests: true });
  assert.equal(hygResult.ok, false);
  const hygieneCheck = hygResult.checks.find((c) => c.id === "hygiene");
  assert.equal(hygieneCheck?.status, "FAIL");
  const hygSummary = hygieneCheck.output;
  assert.match(hygSummary, /\.env\.local/);
  assert.match(hygSummary, /api\/\.env/);
  assert.match(hygSummary, /id_ecdsa/);
  assert.ok(!fs.existsSync(path.join(hygDir, "node_modules")));

  // 4. polyglot requiredChecks fail when sibling language test check at "." is NOT_RUN
  const polyDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-poly-"));
  t.after(() => fs.rmSync(polyDir, { recursive: true, force: true }));
  fs.writeFileSync(
    path.join(polyDir, "package.json"),
    JSON.stringify({ name: "poly", scripts: { test: "node -e \"process.exit(0)\"" } })
  );
  fs.writeFileSync(path.join(polyDir, "pyproject.toml"), "[project]\nname='w'\n");
  fs.writeFileSync(
    path.join(polyDir, ".factory.json"),
    JSON.stringify({
      verification: {
        requiredChecks: [{ component: ".", category: "test" }],
      },
    })
  );
  const polyRes = runVerify({ cwd: polyDir, requireTests: false });
  assert.equal(polyRes.ok, false);
  assert.equal(
    polyRes.checks.find((c) => c.id === "required:.:test")?.status,
    "FAIL"
  );

  // 5. inspectComposeIsolation flags dangerous compose options and external paths
  const dirty = inspectComposeIsolation(
    {
      services: {
        app: {
          image: "node:20",
          build: { context: "/etc" },
          env_file: ["/etc/shadow"],
          cap_add: ["SYS_ADMIN"],
          security_opt: ["apparmor=unconfined"],
          network_mode: "host",
          pid: "container:db",
          devices: ["/dev/kmsg:/dev/kmsg"],
          volumes_from: ["other"],
          volumes: ["/var/lib:/data"],
        },
      },
      volumes: {
        sockvol: { driver_opts: { device: "/var/run/docker.sock" } },
      },
    },
    { workspaceRoot: hygDir }
  );
  const joined = dirty.join("\n");
  for (const needle of [
    "cap_add",
    "security_opt",
    "network_mode",
    "pid",
    "devices",
    "volumes_from",
    "driver_opts",
    "build context",
    "env_file",
    "bind mount",
  ]) {
    assert.ok(joined.includes(needle), `Expected compose finding for ${needle}, got:\n${joined}`);
  }
});
