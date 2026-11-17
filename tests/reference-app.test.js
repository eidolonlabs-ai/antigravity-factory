import test from "node:test";
import assert from "node:assert/strict";
import { loadFactoryPolicy } from "../plugins/agy-software-factory/lib/policy.js";
import { detectProject } from "../plugins/agy-software-factory/lib/detect.js";
import { fileURLToPath } from "node:url";
test("reference project exposes required checks and an explicit live browser command", () => {
  const cwd = fileURLToPath(
      new URL("../examples/task-tracker", import.meta.url),
    ),
    policy = loadFactoryPolicy(cwd),
    project = detectProject(cwd);
  for (const check of policy.verification.requiredChecks)
    assert.ok(
      project.components.find((c) => c.relPath === check.component)?.commands[
        check.category
      ],
    );
  assert.ok(
    policy.verification.commands.some((c) => c.providesEvidence === "browser"),
  );
  assert.ok(policy.verification.requiredEvidence.includes("browser"));
});
test("live runner fails explicitly when Docker is unavailable", async (t) => {
  const fs = await import("node:fs"),
    os = await import("node:os"),
    path = await import("node:path");
  const { spawnSync } = await import("node:child_process");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "factory-runner-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, "scripts"));
  fs.mkdirSync(path.join(root, "bin"));
  fs.writeFileSync(path.join(root, "package.json"), '{"type":"module"}');
  fs.copyFileSync(
    fileURLToPath(
      new URL(
        "../examples/task-tracker/scripts/verify-stack.js",
        import.meta.url,
      ),
    ),
    path.join(root, "scripts/verify-stack.js"),
  );
  fs.writeFileSync(
    path.join(root, "bin/docker"),
    '#!/bin/sh\necho "Docker unavailable" >&2\nexit 127\n',
    { mode: 0o755 },
  );
  const r = spawnSync(
    process.execPath,
    [path.join(root, "scripts/verify-stack.js")],
    { env: { ...process.env, PATH: path.join(root, "bin") }, encoding: "utf8" },
  );
  assert.equal(r.status, 1);
  assert.match(r.stderr, /Docker unavailable/);
  assert.doesNotMatch(r.stdout, /PASS/);
});
