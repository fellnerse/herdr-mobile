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
    """How long to wait on the event stream before sweeping the queue anyway.

    Delivery does not depend on events arriving, only its latency does: this is
    the worst case if the stream drops, not the normal case."""

    agent_kind: str = "claude"

    agent_args: list[str] = field(default_factory=list)
    """Passed to the agent when a lost session has to be relaunched.

    Only used on the cold path. A prompt normally lands in a session you started
    yourself, so its permission mode is whatever you chose when you opened that
    chat -- this queue never widens it. Set it to match, e.g.
    ["--permission-mode", "acceptEdits"], so a session that comes back after a
    reboot comes back the way you left it.
    """

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
