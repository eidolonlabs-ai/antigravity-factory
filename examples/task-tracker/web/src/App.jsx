import { useEffect, useState } from 'react';

const FILTERS = ['All', 'Active', 'Done'];

async function parseErrorMessage(res, fallback) {
  try {
    const data = await res.json();
    if (data && typeof data.error === 'string' && data.error.trim()) {
      return data.error;
    }
  } catch {
    // Ignore non-JSON error responses
  }
  return fallback;
}

export default function App() {
  const [tasks, setTasks] = useState([]);
  const [newTitle, setNewTitle] = useState('');
  const [filter, setFilter] = useState('All');
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    let active = true;

    async function fetchTasks() {
      setLoading(true);
      setError('');
      try {
        const res = await fetch('/api/tasks');
        if (!res.ok) {
          throw new Error(await parseErrorMessage(res, 'Failed to load tasks'));
        }
        const data = await res.json();
        if (active) {
          setTasks(Array.isArray(data.tasks) ? data.tasks : []);
        }
      } catch (err) {
        if (active) {
          setError(err.message || 'Failed to load tasks');
        }
      } finally {
        if (active) {
          setLoading(false);
        }
      }
    }

    fetchTasks();
    return () => {
      active = false;
    };
  }, []);

  async function handleAddTask(e) {
    e.preventDefault();
    const trimmed = newTitle.trim();
    if (!trimmed || submitting) return;

    setSubmitting(true);
    setError('');
    try {
      const res = await fetch('/api/tasks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: trimmed }),
      });
      if (!res.ok) {
        throw new Error(await parseErrorMessage(res, 'Failed to create task'));
      }
      const data = await res.json();
      if (data.task) {
        setTasks((prev) => [data.task, ...prev]);
      }
      setNewTitle('');
    } catch (err) {
      setError(err.message || 'Failed to create task');
    } finally {
      setSubmitting(false);
    }
  }

  async function handleToggleTask(task) {
    setError('');
    const nextDone = !task.done;
    try {
      const res = await fetch(`/api/tasks/${task.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ done: nextDone }),
      });
      if (!res.ok) {
        throw new Error(await parseErrorMessage(res, 'Failed to update task'));
      }
      const data = await res.json();
      const updated = data.task || { ...task, done: nextDone };
      setTasks((prev) => prev.map((t) => (t.id === task.id ? updated : t)));
    } catch (err) {
      setError(err.message || 'Failed to update task');
    }
  }

  async function handleDeleteTask(id) {
    setError('');
    try {
      const res = await fetch(`/api/tasks/${id}`, {
        method: 'DELETE',
      });
      if (!res.ok) {
        throw new Error(await parseErrorMessage(res, 'Failed to delete task'));
      }
      setTasks((prev) => prev.filter((t) => t.id !== id));
    } catch (err) {
      setError(err.message || 'Failed to delete task');
    }
  }

  async function handleClearCompleted() {
    setError('');
    try {
      const res = await fetch('/api/tasks/completed', {
        method: 'DELETE',
      });
      if (!res.ok) {
        throw new Error(await parseErrorMessage(res, 'Failed to clear completed tasks'));
      }
      setTasks((prev) => prev.filter((t) => !t.done));
    } catch (err) {
      setError(err.message || 'Failed to clear completed tasks');
    }
  }

  const remainingCount = tasks.filter((t) => !t.done).length;
  const completedCount = tasks.filter((t) => t.done).length;
  const filteredTasks = tasks.filter((t) => {
    if (filter === 'Active') return !t.done;
    if (filter === 'Done') return t.done;
    return true;
  });

  return (
    <main className="app-shell">
      <section className="tracker-card" aria-label="Task Tracker">
        <header className="tracker-header">
          <h1>Task Tracker</h1>
          <p className="subtitle">Stay focused on what matters today.</p>
        </header>

        {error && (
          <div className="error-banner" role="alert">
            <span>{error}</span>
            <button
              type="button"
              className="error-dismiss"
              onClick={() => setError('')}
              aria-label="Dismiss error"
            >
              ×
            </button>
          </div>
        )}

        <form className="task-form" onSubmit={handleAddTask}>
          <input
            type="text"
            className="task-input"
            placeholder="Add a new task..."
            value={newTitle}
            onChange={(e) => setNewTitle(e.target.value)}
            maxLength={200}
            aria-label="New task title"
            disabled={submitting}
          />
          <button
            type="submit"
            className="add-button"
            disabled={submitting || !newTitle.trim()}
          >
            {submitting ? 'Adding...' : 'Add'}
          </button>
        </form>

        <div className="toolbar">
          <div className="filters" role="group" aria-label="Filter tasks">
            {FILTERS.map((name) => (
              <button
                key={name}
                type="button"
                className={`filter-button${filter === name ? ' active' : ''}`}
                onClick={() => setFilter(name)}
                aria-pressed={filter === name}
              >
                {name}
              </button>
            ))}
          </div>
          <span className="remaining-count">
            {remainingCount} {remainingCount === 1 ? 'task' : 'tasks'} left
          </span>
          {completedCount > 0 && (
            <button
              type="button"
              className="clear-completed-button"
              onClick={handleClearCompleted}
            >
              Clear completed
            </button>
          )}
        </div>

        {loading ? (
          <div className="status-state" role="status">
            Loading tasks...
          </div>
        ) : filteredTasks.length === 0 ? (
          <div className="status-state">
            {tasks.length === 0
              ? 'No tasks yet. Add one above to get started.'
              : `No ${filter.toLowerCase()} tasks.`}
          </div>
        ) : (
          <ul className="task-list">
            {filteredTasks.map((task) => (
              <li key={task.id} className={`task-item${task.done ? ' done' : ''}`}>
                <label className="task-label">
                  <input
                    type="checkbox"
                    className="task-checkbox"
                    checked={Boolean(task.done)}
                    onChange={() => handleToggleTask(task)}
                  />
                  <span className="task-title">{task.title}</span>
                </label>
                <button
                  type="button"
                  className="delete-button"
                  onClick={() => handleDeleteTask(task.id)}
                  aria-label={`Delete "${task.title}"`}
                >
                  Delete
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}
