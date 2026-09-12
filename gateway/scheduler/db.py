"""SQLite-backed task queue.

The queue lives on disk rather than in the dispatcher, so restarting the
gateway costs at most the turn in flight: `reset_orphans` brings anything left
running back as paused and it resumes from its recorded session.
"""

from __future__ import annotations

import sqlite3
from pathlib import Path
from dataclasses import dataclass
from datetime import datetime, timezone

from . import STATE_DIR

DB_PATH = STATE_DIR / "scheduler.sqlite3"

# queued  -> waiting for a free slot and enough quota
# running -> agent is live and working
# paused  -> quota exhausted mid-task; resumable via session_uuid
# blocked -> agent is asking a question; needs a human
# done / failed -> terminal
STATES = ("queued", "running", "paused", "blocked", "done", "failed")

SCHEMA = """
CREATE TABLE IF NOT EXISTS task (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    prompt        TEXT NOT NULL,
    repo_path     TEXT NOT NULL,
    base_ref      TEXT,
    branch        TEXT,
    explicit_branch TEXT,
    priority      INTEGER NOT NULL DEFAULT 0,
    state         TEXT NOT NULL DEFAULT 'queued',
    session_uuid  TEXT,
    workspace_id  TEXT,
    worktree_path TEXT,
    pane_id       TEXT,
    agent_name    TEXT,
    attempts      INTEGER NOT NULL DEFAULT 0,
    -- Whether this task's own prompt ever reached the agent. One stopped on a
    -- startup dialog never got it, so resuming has to send the real prompt
    -- instead of telling it to carry on from nothing.
    prompted      INTEGER NOT NULL DEFAULT 0,
    last_error    TEXT,
    created_at    TEXT NOT NULL,
    started_at    TEXT,
    finished_at   TEXT
);
CREATE INDEX IF NOT EXISTS task_state_idx ON task(state, priority DESC, id);
"""

# Columns added after the first release, applied to an existing table.
MIGRATIONS = (("prompted", "INTEGER NOT NULL DEFAULT 0"),)


def now() -> str:
    return datetime.now(timezone.utc).isoformat()


@dataclass
class Task:
    id: int
    prompt: str
    repo_path: str
    base_ref: str | None
    branch: str | None
    explicit_branch: str | None
    priority: int
    state: str
    session_uuid: str | None
    workspace_id: str | None
    worktree_path: str | None
    pane_id: str | None
    agent_name: str | None
    attempts: int
    prompted: int
    last_error: str | None
    created_at: str
    started_at: str | None
    finished_at: str | None

    @classmethod
    def from_row(cls, row: sqlite3.Row) -> Task:
        return cls(**{k: row[k] for k in row.keys()})


def connect(path: Path | None = None) -> sqlite3.Connection:
    path = path or DB_PATH
    path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(path, timeout=10.0)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.executescript(SCHEMA)
    # CREATE TABLE IF NOT EXISTS leaves an older table as it was, so new
    # columns have to be added to it explicitly.
    existing = {row["name"] for row in conn.execute("PRAGMA table_info(task)")}
    for column, spec in MIGRATIONS:
        if column not in existing:
            conn.execute(f"ALTER TABLE task ADD COLUMN {column} {spec}")
    conn.commit()
    return conn


def add(conn: sqlite3.Connection, prompt: str, repo_path: str, base_ref: str | None = None,
        branch: str | None = None, priority: int = 0) -> int:
    cur = conn.execute(
        "INSERT INTO task (prompt, repo_path, base_ref, explicit_branch, priority, created_at)"
        " VALUES (?,?,?,?,?,?)",
        (prompt, repo_path, base_ref, branch, priority, now()),
    )
    conn.commit()
    return cur.lastrowid


def get(conn: sqlite3.Connection, task_id: int) -> Task | None:
    row = conn.execute("SELECT * FROM task WHERE id=?", (task_id,)).fetchone()
    return Task.from_row(row) if row else None


def list_tasks(conn: sqlite3.Connection, state: str | None = None) -> list[Task]:
    if state:
        rows = conn.execute(
            "SELECT * FROM task WHERE state=? ORDER BY priority DESC, id", (state,)
        ).fetchall()
    else:
        rows = conn.execute("SELECT * FROM task ORDER BY priority DESC, id").fetchall()
    return [Task.from_row(r) for r in rows]


def next_runnable(conn: sqlite3.Connection) -> Task | None:
    """Highest-priority task ready to start or resume.

    Paused tasks come first: they already hold a worktree and a session, so
    finishing them frees resources before new work is admitted.
    """
    row = conn.execute(
        "SELECT * FROM task WHERE state IN ('paused','queued')"
        " ORDER BY CASE state WHEN 'paused' THEN 0 ELSE 1 END, priority DESC, id LIMIT 1"
    ).fetchone()
    return Task.from_row(row) if row else None


def update(conn: sqlite3.Connection, task_id: int, **fields) -> None:
    if not fields:
        return
    assignments = ", ".join(f"{k}=?" for k in fields)
    conn.execute(f"UPDATE task SET {assignments} WHERE id=?", (*fields.values(), task_id))
    conn.commit()


def count_running(conn: sqlite3.Connection) -> int:
    return conn.execute("SELECT COUNT(*) FROM task WHERE state='running'").fetchone()[0]


def reset_orphans(conn: sqlite3.Connection) -> int:
    """Recover tasks left 'running' by a scheduler crash.

    Their agent is gone but the session UUID survives, so they requeue as
    paused and resume rather than starting over.
    """
    cur = conn.execute(
        "UPDATE task SET state='paused', last_error='scheduler restarted' WHERE state='running'"
    )
    conn.commit()
    return cur.rowcount
