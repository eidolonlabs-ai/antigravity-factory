import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { evaluateStop } from "../plugins/agy-software-factory/bin/stop-verify-gate.js";
import { evaluateStatus } from "../plugins/agy-software-factory/lib/status.js";
import { runVerify } from "../plugins/agy-software-factory/lib/verify.js";
for (const name of ["stop-model-stop", "stop-legacy"])
  test(`${name}: bounded session budget survives edits and resets after success`, (t) => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "factory-stop-"));
    t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
    fs.writeFileSync(path.join(cwd, ".gitignore"), ".env\n");
    fs.writeFileSync(
      path.join(cwd, ".factory.json"),
      JSON.stringify({ stop: { mode: "remind", maxContinuations: 1 } }),
    );
    const payload = {
      ...JSON.parse(
        fs.readFileSync(
          new URL(`./fixtures/antigravity/${name}.json`, import.meta.url),
        ),
      ),
      workspacePaths: [cwd],
    };
    assert.equal(evaluateStop(payload).decision, "continue");
    fs.writeFileSync(path.join(cwd, "edit.txt"), "new");
    assert.equal(evaluateStop(payload).decision, "allow");
    assert.equal(
      evaluateStatus({ cwd, conversationId: payload.conversationId }).outcome,
      "EXHAUSTED",
    );
    assert.equal(
      evaluateStop({ ...payload, conversationId: "different" }).decision,
      "continue",
    );
    for (const terminationReason of [
      "error",
      "cancelled",
      "max_steps_exceeded",
    ])
      assert.equal(
        evaluateStop({ ...payload, terminationReason }).decision,
        "allow",
      );
    assert.equal(
      evaluateStop({ ...payload, fullyIdle: false }).decision,
      "allow",
    );
    runVerify({ cwd });
    assert.equal(evaluateStop(payload).decision, "allow");
    assert.equal(
      evaluateStatus({ cwd, conversationId: payload.conversationId }).outcome,
      "VERIFIED",
    );
  });
