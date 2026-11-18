import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import { createApp } from "../src/app.js";

function createMockPool() {
  let nextId = 1;
  let tasks = [];
  let failHealth = false;

  return {
    reset() {
      nextId = 1;
      tasks = [];
      failHealth = false;
    },
    setFailHealth(value) {
      failHealth = value;
    },
    seed(initialTasks) {
      tasks = initialTasks.map((t) => ({ ...t }));
      nextId = tasks.reduce((max, t) => Math.max(max, t.id), 0) + 1;
    },
    async query(sql, params = []) {
      const normalized = sql.trim().replace(/\s+/g, " ");

      if (normalized === "SELECT 1") {
        if (failHealth) {
          throw new Error("connection refused");
        }
        return { rows: [{ "?column?": 1 }] };
      }

      if (normalized.startsWith("SELECT id, title, done, created_at FROM tasks")) {
        const sorted = [...tasks].sort((a, b) => b.id - a.id);
        return { rows: sorted };
      }

      if (normalized.startsWith("INSERT INTO tasks (title) VALUES ($1)")) {
        const task = {
          id: nextId++,
          title: params[0],
          done: false,
          created_at: new Date().toISOString(),
        };
        tasks.push(task);
        return { rows: [task] };
      }

      if (normalized.startsWith("UPDATE tasks SET ")) {
        const id = params[params.length - 1];
        const task = tasks.find((t) => t.id === id);
        if (!task) {
          return { rows: [] };
        }
        const setClause = normalized.slice("UPDATE tasks SET ".length, normalized.indexOf(" WHERE "));
        const assignments = setClause.split(", ");
        assignments.forEach((assign, idx) => {
          const field = assign.split(" = ")[0];
          task[field] = params[idx];
        });
        return { rows: [{ ...task }] };
      }

      if (normalized === "DELETE FROM tasks WHERE done = TRUE RETURNING id") {
        const removed = tasks.filter((t) => t.done === true);
        tasks = tasks.filter((t) => t.done !== true);
        return { rows: removed.map((t) => ({ id: t.id })) };
      }

      if (normalized.startsWith("DELETE FROM tasks WHERE id = $1")) {
        const id = params[0];
        const idx = tasks.findIndex((t) => t.id === id);
        if (idx === -1) {
          return { rows: [] };
        }
        const [removed] = tasks.splice(idx, 1);
        return { rows: [{ id: removed.id }] };
      }

      throw new Error(`Unexpected query in mock pool: ${normalized}`);
    },
  };
}

describe("Tasks API", () => {
  const pool = createMockPool();
  let server;
  let baseUrl;

  before(async () => {
    const app = createApp(pool);
    await new Promise((resolve) => {
      server = app.listen(0, "127.0.0.1", () => {
        const addr = server.address();
        baseUrl = `http://127.0.0.1:${addr.port}`;
        resolve();
      });
    });
  });

  beforeEach(() => {
    pool.reset();
  });

  after(async () => {
    await new Promise((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  });

  it("GET /health returns 200 when database is reachable", async () => {
    const res = await fetch(`${baseUrl}/health`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(body, { ok: true, db: "connected" });
  });

  it("GET /health returns 500 when database query fails", async () => {
    pool.setFailHealth(true);
    const res = await fetch(`${baseUrl}/health`);
    assert.equal(res.status, 500);
    const body = await res.json();
    assert.equal(body.ok, false);
  });

  it("GET /api/tasks returns tasks ordered by id DESC", async () => {
    pool.seed([
      { id: 1, title: "First", done: false, created_at: "2026-01-01T00:00:00.000Z" },
      { id: 2, title: "Second", done: true, created_at: "2026-01-02T00:00:00.000Z" },
    ]);

    const res = await fetch(`${baseUrl}/api/tasks`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.tasks.length, 2);
    assert.equal(body.tasks[0].id, 2);
    assert.equal(body.tasks[1].id, 1);
  });

  it("POST /api/tasks validates title and creates task", async () => {
    const emptyRes = await fetch(`${baseUrl}/api/tasks`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "   " }),
    });
    assert.equal(emptyRes.status, 400);
    const emptyBody = await emptyRes.json();
    assert.ok(emptyBody.error);

    const longRes = await fetch(`${baseUrl}/api/tasks`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "a".repeat(201) }),
    });
    assert.equal(longRes.status, 400);

    const createRes = await fetch(`${baseUrl}/api/tasks`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "  Write tests  " }),
    });
    assert.equal(createRes.status, 201);
    const createBody = await createRes.json();
    assert.equal(createBody.task.id, 1);
    assert.equal(createBody.task.title, "Write tests");
    assert.equal(createBody.task.done, false);
  });

  it("PATCH /api/tasks/:id toggles done, updates title, and returns 404/400", async () => {
    pool.seed([
      { id: 1, title: "Initial", done: false, created_at: "2026-01-01T00:00:00.000Z" },
    ]);

    const toggleRes = await fetch(`${baseUrl}/api/tasks/1`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ done: true }),
    });
    assert.equal(toggleRes.status, 200);
    const toggleBody = await toggleRes.json();
    assert.equal(toggleBody.task.done, true);
    assert.equal(toggleBody.task.title, "Initial");

    const titleRes = await fetch(`${baseUrl}/api/tasks/1`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "  Updated  " }),
    });
    assert.equal(titleRes.status, 200);
    const titleBody = await titleRes.json();
    assert.equal(titleBody.task.title, "Updated");

    const badIdRes = await fetch(`${baseUrl}/api/tasks/abc`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ done: true }),
    });
    assert.equal(badIdRes.status, 400);

    const missingRes = await fetch(`${baseUrl}/api/tasks/999`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ done: true }),
    });
    assert.equal(missingRes.status, 404);
  });

  it("DELETE /api/tasks/:id deletes task and returns 404/400", async () => {
    pool.seed([
      { id: 1, title: "To delete", done: false, created_at: "2026-01-01T00:00:00.000Z" },
    ]);

    const delRes = await fetch(`${baseUrl}/api/tasks/1`, { method: "DELETE" });
    assert.equal(delRes.status, 200);
    const delBody = await delRes.json();
    assert.deepEqual(delBody, { deleted: true, id: 1 });

    const missingRes = await fetch(`${baseUrl}/api/tasks/1`, { method: "DELETE" });
    assert.equal(missingRes.status, 404);

    const badIdRes = await fetch(`${baseUrl}/api/tasks/0`, { method: "DELETE" });
    assert.equal(badIdRes.status, 400);
  });

  it("DELETE /api/tasks/completed removes only completed tasks and returns deletedCount and ids", async () => {
    pool.seed([
      { id: 1, title: "Active task", done: false, created_at: "2026-01-01T00:00:00.000Z" },
      { id: 2, title: "Done task 1", done: true, created_at: "2026-01-02T00:00:00.000Z" },
      { id: 3, title: "Done task 2", done: true, created_at: "2026-01-03T00:00:00.000Z" },
    ]);

    const clearRes = await fetch(`${baseUrl}/api/tasks/completed`, { method: "DELETE" });
    assert.equal(clearRes.status, 200);
    const clearBody = await clearRes.json();
    assert.deepEqual(clearBody, { deletedCount: 2, ids: [2, 3] });

    const listRes = await fetch(`${baseUrl}/api/tasks`);
    assert.equal(listRes.status, 200);
    const listBody = await listRes.json();
    assert.equal(listBody.tasks.length, 1);
    assert.equal(listBody.tasks[0].id, 1);

    const emptyClearRes = await fetch(`${baseUrl}/api/tasks/completed`, { method: "DELETE" });
    assert.equal(emptyClearRes.status, 200);
    const emptyClearBody = await emptyClearRes.json();
    assert.deepEqual(emptyClearBody, { deletedCount: 0, ids: [] });
  });
});
