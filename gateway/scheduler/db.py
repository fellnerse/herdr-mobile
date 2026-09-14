"""SQLite-backed queue of prompts waiting for a chat session.

One queue per pane. The queue lives on disk rather than in the dispatcher
because a prompt queued overnight has to survive a gateway restart -- and the
pane it belongs to usually outlives several.
"""

from __future__ import annotations

import sqlite3
from pathlib import Path
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone

from . import STATE_DIR

DB_PATH = STATE_DIR / "scheduler.sqlite3"

# waiting -> not yet delivered: holding for quota, or for the agent to finish
# sent    -> handed to the agent; the conversation owns it now
# failed  -> could not be delivered, with last_error saying why
STATES = ("waiting", "sent", "failed")

SCHEMA = """
CREATE TABLE IF NOT EXISTS queued_prompt (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    pane_id      TEXT NOT NULL,
    -- Captured when queued, for the cold path: if the pane does not survive a
    -- reboot, this is everything needed to put the conversation back.
    workspace_id TEXT,
    session_uuid TEXT,
    cwd          TEXT,
    prompt       TEXT NOT NULL,
    state        TEXT NOT NULL DEFAULT 'waiting',
    -- Set on a resume, which has to overtake whatever is already queued: it
    -- continues the turn the rest of the queue is waiting behind.
    head         INTEGER NOT NULL DEFAULT 0,
    last_error   TEXT,
    created_at   TEXT NOT NULL,
    sent_at      TEXT
);
CREATE INDEX IF NOT EXISTS queued_prompt_pane_idx
    ON queued_prompt(pane_id, head DESC, id);

-- The old per-task queue described work that had to be provisioned: a repo, a
-- base ref, a branch, a worktree. None of that survives into a queue that
-- delivers into a session you already have open, and its rows cannot be
-- expressed here, so it goes rather than being migrated.
DROP TABLE IF EXISTS task;
"""


def now() -> str:
    return datetime.now(timezone.utc).isoformat()


@dataclass
class Prompt:
    id: int
    pane_id: str
    workspace_id: str | None
    session_uuid: str | None
    cwd: str | None
    prompt: str
    state: str
    head: int
    last_error: str | None
    created_at: str
    sent_at: str | None

    @classmethod
    def from_row(cls, row: sqlite3.Row) -> Prompt:
        return cls(**{k: row[k] for k in row.keys()})


def connect(path: Path | None = None) -> sqlite3.Connection:
    path = path or DB_PATH
    path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(path, timeout=10.0)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.executescript(SCHEMA)
    conn.commit()
    return conn


def add(conn: sqlite3.Connection, pane_id: str, prompt: str, workspace_id: str | None = None,
        session_uuid: str | None = None, cwd: str | None = None, head: bool = False) -> int:
    cur = conn.execute(
        "INSERT INTO queued_prompt (pane_id, workspace_id, session_uuid, cwd, prompt,"
        " head, created_at) VALUES (?,?,?,?,?,?,?)",
        (pane_id, workspace_id, session_uuid, cwd, prompt, int(head), now()),
    )
    conn.commit()
    return cur.lastrowid


def get(conn: sqlite3.Connection, prompt_id: int) -> Prompt | None:
    row = conn.execute("SELECT * FROM queued_prompt WHERE id=?", (prompt_id,)).fetchone()
    return Prompt.from_row(row) if row else None


def list_prompts(conn: sqlite3.Connection, pane_id: str | None = None,
                 state: str | None = None) -> list[Prompt]:
    where, params = [], []
    if pane_id:
        where.append("pane_id=?")
        params.append(pane_id)
    if state:
        where.append("state=?")
        params.append(state)
    clause = f" WHERE {' AND '.join(where)}" if where else ""
    rows = conn.execute(
        f"SELECT * FROM queued_prompt{clause} ORDER BY head DESC, id", params
    ).fetchall()
    return [Prompt.from_row(r) for r in rows]


def next_for_pane(conn: sqlite3.Connection, pane_id: str) -> Prompt | None:
    row = conn.execute(
        "SELECT * FROM queued_prompt WHERE pane_id=? AND state='waiting'"
        " ORDER BY head DESC, id LIMIT 1",
        (pane_id,),
    ).fetchone()
    return Prompt.from_row(row) if row else None


def waiting_panes(conn: sqlite3.Connection) -> list[str]:
    """Panes with something still to deliver, oldest queue first."""
    rows = conn.execute(
        "SELECT pane_id FROM queued_prompt WHERE state='waiting'"
        " GROUP BY pane_id ORDER BY MIN(id)"
    ).fetchall()
    return [r["pane_id"] for r in rows]


def count_waiting(conn: sqlite3.Connection, pane_id: str) -> int:
    return conn.execute(
        "SELECT COUNT(*) FROM queued_prompt WHERE pane_id=? AND state='waiting'", (pane_id,)
    ).fetchone()[0]


def update(conn: sqlite3.Connection, prompt_id: int, **fields) -> None:
    if not fields:
        return
    assignments = ", ".join(f"{k}=?" for k in fields)
    conn.execute(
        f"UPDATE queued_prompt SET {assignments} WHERE id=?", (*fields.values(), prompt_id)
    )
    conn.commit()


def delete(conn: sqlite3.Connection, prompt_id: int) -> None:
    conn.execute("DELETE FROM queued_prompt WHERE id=?", (prompt_id,))
    conn.commit()


# How long a delivered prompt stays readable before the queue forgets it. Long
# enough to look back at the night it ran, short enough that the list is still
# what is owed rather than a log of everything ever sent.
KEEP_SENT = timedelta(hours=24)


def prune_sent(conn: sqlite3.Connection, keep: timedelta = KEEP_SENT) -> int:
    """Drop prompts the conversation has owned for longer than `keep`.

    A delivered prompt stops being the queue's business the moment it lands, so
    nothing is lost here that the transcript does not already have. `failed` is
    deliberately never pruned: those are the ones still waiting on you.
    """
    cutoff = (datetime.now(timezone.utc) - keep).isoformat()
    cur = conn.execute(
        "DELETE FROM queued_prompt WHERE state='sent' AND COALESCE(sent_at, created_at) < ?",
        (cutoff,),
    )
    conn.commit()
    return cur.rowcount


def fail_pane(conn: sqlite3.Connection, pane_id: str, error: str) -> int:
    """Give up on everything still waiting for a chat that is not coming back.

    Marked rather than deleted: what you typed should still be there to read and
    re-queue somewhere else. Silently dropping it is the one outcome that cannot
    be undone from the phone.
    """
    cur = conn.execute(
        "UPDATE queued_prompt SET state='failed', last_error=? WHERE pane_id=? AND state='waiting'",
        (error, pane_id),
    )
    conn.commit()
    return cur.rowcount
