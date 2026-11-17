import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { runCli } from "../plugins/agy-software-factory/bin/agy-factory.js";
import { runVerify } from "../plugins/agy-software-factory/lib/verify.js";
function cli(cwd, args) {
  let text = "";
  let error = "";
  const code = runCli([...args, "--cwd", cwd, "--json"], {
    stdout: { write: (s) => (text += s) },
    stderr: { write: (s) => (error += s) },
  });
  return { code, value: text ? JSON.parse(text) : null, error };
}
function setup(t) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "factory-evidence-"));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  fs.writeFileSync(path.join(cwd, ".gitignore"), ".env\n.factory/\n");
  fs.writeFileSync(
    path.join(cwd, ".factory.json"),
    JSON.stringify({ verification: { requiredEvidence: ["review"] } }),
  );
  return cwd;
}
test("evidence must describe the inspected subject and required evidence controls status", (t) => {
  const cwd = setup(t);
  runVerify({ cwd });
  const before = cli(cwd, ["status"]);
  assert.equal(before.code, 1);
  assert.equal(before.value.outcome, "UNVERIFIED");
  const record = [
    "evidence",
    "record",
    "--kind",
    "review",
    "--status",
    "PASS",
    "--summary",
    "Reviewed diff",
    "--producer",
    "independent-reviewer",
    "--subject-digest",
    before.value.subjectDigest,
    "--policy-digest",
    before.value.policyDigest,
  ];
  assert.equal(cli(cwd, record).code, 0);
  assert.equal(cli(cwd, ["status"]).value.outcome, "VERIFIED");
  fs.writeFileSync(path.join(cwd, "changed.txt"), "change");
  assert.equal(cli(cwd, record).code, 2);
  assert.equal(cli(cwd, ["status"]).value.outcome, "UNVERIFIED");
});
test("evidence cannot reference nonexistent artifacts or another workspace receipt", (t) => {
  const cwd = setup(t);
  const receipt = runVerify({ cwd });
  const status = cli(cwd, ["status"]).value;
  assert.ok(status);
  assert.equal(
    cli(cwd, [
      "evidence",
      "record",
      "--kind",
      "browser",
      "--status",
      "PASS",
      "--summary",
      "check",
      "--producer",
      "test",
      "--artifact",
      "missing",
      "--subject-digest",
      status.subjectDigest,
      "--policy-digest",
      status.policyDigest,
    ]).code,
    2,
  );
  receipt.workspaceIdentity = "other";
  fs.writeFileSync(
    path.join(cwd, ".factory/verify-receipt.json"),
    JSON.stringify(receipt),
  );
  assert.equal(cli(cwd, ["status"]).value.outcome, "UNVERIFIED");
});
test("status selects session exhaustion without poisoning other conversations", (t) => {
  const cwd = setup(t);
  runVerify({ cwd });
  fs.writeFileSync(
    path.join(cwd, ".factory/stop-gate-state.json"),
    JSON.stringify({
      sessions: {
        one: { count: 1, exhausted: true, updatedAt: new Date().toISOString() },
      },
    }),
  );
  assert.equal(
    cli(cwd, ["status", "--conversation", "one"]).value.outcome,
    "EXHAUSTED",
  );
  assert.equal(
    cli(cwd, ["status", "--conversation", "two"]).value.outcome,
    "UNVERIFIED",
  );
  assert.equal(cli(cwd, ["status"]).value.outcome, "UNVERIFIED");
});
test("fresh failing evidence yields FAILED and missing status does not create files", (t) => {
  const cwd = setup(t);
  assert.equal(cli(cwd, ["status"]).value.outcome, "UNVERIFIED");
  assert.equal(fs.existsSync(path.join(cwd, ".factory")), false);
  runVerify({ cwd });
  const s = cli(cwd, ["status"]).value;
  cli(cwd, [
    "evidence",
    "record",
    "--kind",
    "review",
    "--status",
    "FAIL",
    "--summary",
    "Bug found",
    "--producer",
    "reviewer",
    "--subject-digest",
    s.subjectDigest,
    "--policy-digest",
    s.policyDigest,
  ]);
  assert.equal(cli(cwd, ["status"]).value.outcome, "FAILED");
});
