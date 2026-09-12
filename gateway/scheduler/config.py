"""Scheduler configuration, with defaults that work unattended."""

from __future__ import annotations

import json
from pathlib import Path
from dataclasses import asdict, dataclass, field, fields

from . import STATE_DIR

CONFIG_PATH = STATE_DIR / "scheduler.json"


@dataclass
class Config:
    threshold: float = 85.0
    """Stop admitting new work once any usage window passes this percentage."""

    poll_seconds: int = 60
    """How often to re-check quota and the queue while idle."""

    max_concurrent: int = 1
    """Parallel tasks. Each gets its own worktree, so raising this is safe for
    collisions -- but they share one subscription, so quota drains faster."""

    task_timeout_ms: int = 2 * 60 * 60 * 1000
    """Give up waiting on a single prompt after this long."""

    max_attempts: int = 2
    """Retries before a task is parked as failed for a human to look at."""

    agent_kind: str = "claude"

    agent_args: list[str] = field(default_factory=list)
    """Passed through to the agent after `--`.

    Empty by default: tasks run with normal permission prompts and park as
    `blocked` whenever the agent wants approval, which is safe but not very
    unattended. Truly autonomous overnight runs need an explicit opt-in here --
    e.g. ["--permission-mode", "acceptEdits"] to auto-approve file edits only,
    or ["--dangerously-skip-permissions"] for full autonomy. Tasks always run in
    a throwaway worktree, never your working tree, but bypassing approvals still
    lets an agent run arbitrary commands unsupervised. Your call, not the
    default's.
    """

    branch_prefix: str = "sheep/"

    repo_roots: list[str] = field(default_factory=lambda: ["~/projects"])
    """Where to look for repositories to offer in the queue's project picker.
    Each root is scanned one level deep, and counts itself if it is a repo.
    Whatever Herdr already has open is offered regardless of the roots."""

    keep_worktree_on_success: bool = True
    """Leave the branch in place for review rather than auto-committing away."""

    def save(self, path: Path | None = None) -> None:
        path = path or CONFIG_PATH
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(asdict(self), indent=2) + "\n")


def load(path: Path | None = None) -> Config:
    path = path or CONFIG_PATH
    try:
        raw = json.loads(path.read_text())
    except (FileNotFoundError, json.JSONDecodeError):
        return Config()
    known = {f.name for f in fields(Config)}
    return Config(**{k: v for k, v in raw.items() if k in known})
