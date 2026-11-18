import test from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
const base = process.env.API_BASE_URL;
test("real PostgreSQL persists HTTP mutations and rejects invalid inputs", async () => {
  assert.ok(
    base && process.env.DATABASE_URL,
    "Run through scripts/verify-stack.js",
  );
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  let id;
  let completedId;
  try {
    assert.equal((await fetch(`${base}/health`)).status, 200);
    const created = await fetch(`${base}/api/tasks`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "Integration persistence" }),
    });
    assert.equal(created.status, 201);
    id = (await created.json()).task.id;
    assert.equal(
      (await pool.query("SELECT title FROM tasks WHERE id=$1", [id])).rows[0]
        .title,
      "Integration persistence",
    );
    assert.equal(
      (
        await fetch(`${base}/api/tasks/${id}`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ done: true }),
        })
      ).status,
      200,
    );
    assert.equal(
      (await pool.query("SELECT done FROM tasks WHERE id=$1", [id])).rows[0]
        .done,
      true,
    );
    assert.equal(
      (
        await fetch(`${base}/api/tasks`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: '{"title":""}',
        })
      ).status,
      400,
    );
    const createdSecond = await fetch(`${base}/api/tasks`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "Completed task to clear" }),
    });
    assert.equal(createdSecond.status, 201);
    completedId = (await createdSecond.json()).task.id;
    assert.equal(
      (
        await fetch(`${base}/api/tasks/${completedId}`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ done: true }),
        })
      ).status,
      200,
    );
    assert.equal(
      (await fetch(`${base}/api/tasks/${id}`, { method: "DELETE" })).status,
      200,
    );
    assert.equal(
      (await pool.query("SELECT id FROM tasks WHERE id=$1", [id])).rowCount,
      0,
    );
    const clearCompletedRes = await fetch(`${base}/api/tasks/completed`, {
      method: "DELETE",
    });
    assert.equal(clearCompletedRes.status, 200);
    const clearCompletedBody = await clearCompletedRes.json();
    assert.ok(clearCompletedBody.deletedCount >= 1);
    assert.ok(clearCompletedBody.ids.includes(completedId));
    assert.equal(
      (await pool.query("SELECT id FROM tasks WHERE id=$1", [completedId]))
        .rowCount,
      0,
    );
  } finally {
    if (id) await pool.query("DELETE FROM tasks WHERE id=$1", [id]);
    if (completedId)
      await pool.query("DELETE FROM tasks WHERE id=$1", [completedId]);
    await pool.end();
  }
});
