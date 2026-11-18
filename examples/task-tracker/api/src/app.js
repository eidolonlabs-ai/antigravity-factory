import cors from "cors";
import express from "express";

const MAX_TITLE_LENGTH = 200;

/**
 * Parse and validate a positive integer route ID parameter.
 * @param {string} rawId
 * @returns {number|null}
 */
function parseTaskId(rawId) {
  if (!/^\d+$/.test(rawId)) {
    return null;
  }
  const id = Number(rawId);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

/**
 * Validate and trim a task title.
 * @param {unknown} title
 * @returns {{ value?: string, error?: string }}
 */
function validateTitle(title) {
  if (typeof title !== "string") {
    return { error: "title must be a string" };
  }
  const trimmed = title.trim();
  if (trimmed.length === 0) {
    return { error: "title must not be empty" };
  }
  if (trimmed.length > MAX_TITLE_LENGTH) {
    return { error: `title must be at most ${MAX_TITLE_LENGTH} characters` };
  }
  return { value: trimmed };
}

/**
 * Create the Express application wired with the given pg Pool.
 * @param {{ query: Function }} pool
 */
export function createApp(pool) {
  const app = express();

  app.use(cors());
  app.use(express.json());

  app.use((err, _req, res, next) => {
    if (err instanceof SyntaxError && err.status === 400 && "body" in err) {
      return res.status(400).json({ error: "Invalid JSON payload" });
    }
    return next(err);
  });

  app.get("/health", async (_req, res) => {
    try {
      await pool.query("SELECT 1");
      return res.status(200).json({ ok: true, db: "connected" });
    } catch (err) {
      return res.status(500).json({ ok: false, error: "Database unavailable" });
    }
  });

  app.get("/api/tasks", async (_req, res) => {
    try {
      const result = await pool.query(
        "SELECT id, title, done, created_at FROM tasks ORDER BY id DESC"
      );
      return res.status(200).json({ tasks: result.rows });
    } catch (err) {
      return res.status(500).json({ error: "Failed to fetch tasks" });
    }
  });

  app.post("/api/tasks", async (req, res) => {
    const { value: title, error } = validateTitle(req.body?.title);
    if (error) {
      return res.status(400).json({ error });
    }

    try {
      const result = await pool.query(
        "INSERT INTO tasks (title) VALUES ($1) RETURNING id, title, done, created_at",
        [title]
      );
      return res.status(201).json({ task: result.rows[0] });
    } catch (err) {
      return res.status(500).json({ error: "Failed to create task" });
    }
  });

  app.patch("/api/tasks/:id", async (req, res) => {
    const id = parseTaskId(req.params.id);
    if (id === null) {
      return res.status(400).json({ error: "Invalid task id" });
    }

    const body = req.body ?? {};
    const hasTitle = Object.prototype.hasOwnProperty.call(body, "title");
    const hasDone = Object.prototype.hasOwnProperty.call(body, "done");

    if (!hasTitle && !hasDone) {
      return res.status(400).json({ error: "At least one of title or done must be provided" });
    }

    const updates = [];
    const values = [];

    if (hasTitle) {
      const { value: title, error } = validateTitle(body.title);
      if (error) {
        return res.status(400).json({ error });
      }
      values.push(title);
      updates.push(`title = $${values.length}`);
    }

    if (hasDone) {
      if (typeof body.done !== "boolean") {
        return res.status(400).json({ error: "done must be a boolean" });
      }
      values.push(body.done);
      updates.push(`done = $${values.length}`);
    }

    values.push(id);
    const sql = `UPDATE tasks SET ${updates.join(", ")} WHERE id = $${values.length} RETURNING id, title, done, created_at`;

    try {
      const result = await pool.query(sql, values);
      if (result.rows.length === 0) {
        return res.status(404).json({ error: "Task not found" });
      }
      return res.status(200).json({ task: result.rows[0] });
    } catch (err) {
      return res.status(500).json({ error: "Failed to update task" });
    }
  });

  app.delete("/api/tasks/completed", async (_req, res) => {
    try {
      const result = await pool.query(
        "DELETE FROM tasks WHERE done = TRUE RETURNING id"
      );
      return res.status(200).json({
        deletedCount: result.rows.length,
        ids: result.rows.map((r) => r.id),
      });
    } catch (err) {
      return res.status(500).json({ error: "Failed to clear completed tasks" });
    }
  });

  app.delete("/api/tasks/:id", async (req, res) => {
    const id = parseTaskId(req.params.id);
    if (id === null) {
      return res.status(400).json({ error: "Invalid task id" });
    }

    try {
      const result = await pool.query(
        "DELETE FROM tasks WHERE id = $1 RETURNING id",
        [id]
      );
      if (result.rows.length === 0) {
        return res.status(404).json({ error: "Task not found" });
      }
      return res.status(200).json({ deleted: true, id: result.rows[0].id });
    } catch (err) {
      return res.status(500).json({ error: "Failed to delete task" });
    }
  });

  return app;
}
