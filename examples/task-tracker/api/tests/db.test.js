import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
test("idle PostgreSQL connection errors do not terminate the API process", () => {
  const moduleUrl = new URL("../src/db.js", import.meta.url).href;
  const r = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `import pool from ${JSON.stringify(moduleUrl)}; pool.emit('error',new Error('simulated disconnect')); await pool.end();`,
    ],
    { encoding: "utf8" },
  );
  assert.equal(r.status, 0, r.stderr);
});
