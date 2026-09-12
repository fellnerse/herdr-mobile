"""Finding git repositories and their branches, for the queue's pickers.

Typing an absolute path on a phone keyboard is miserable, so the sheet offers
what is actually on the machine instead.
"""

from __future__ import annotations

import subprocess
from pathlib import Path

from .config import Config

GIT_TIMEOUT = 5.0


def _git(repo: Path, *args: str) -> str:
    """Run git in a repo and return stdout, or "" on any failure."""
    try:
        done = subprocess.run(
            ["git", "-C", str(repo), *args],
            capture_output=True,
            text=True,
            timeout=GIT_TIMEOUT,
        )
    except (OSError, subprocess.SubprocessError):
        return ""
    return done.stdout.strip() if done.returncode == 0 else ""


def is_repo(path: Path) -> bool:
    """A worktree's .git is a file, not a directory, so test for either."""
    return path.is_dir() and (path / ".git").exists()


def current_branch(repo: Path) -> str:
    return _git(repo, "branch", "--show-current")


def branches(repo: Path) -> dict:
    """Local branches, current first so it is the natural default."""
    if not is_repo(repo):
        return {"branches": [], "current": ""}
    raw = _git(repo, "for-each-ref", "--format=%(refname:short)", "refs/heads")
    names = [b for b in raw.splitlines() if b]
    head = current_branch(repo)
    ordered = ([head] if head in names else []) + sorted(b for b in names if b != head)
    return {"branches": ordered, "current": head}


def discover(cfg: Config, extra: list[str] | None = None) -> list[dict]:
    """Repositories worth offering, from the configured roots plus `extra`.

    `extra` is where the caller passes the working directories Herdr already
    has open -- those are the projects in play, whether or not they happen to
    sit under one of the roots. Worktrees the scheduler made are skipped: they
    are its own output, not somewhere to queue new work.
    """
    found: dict[str, dict] = {}

    def offer(path: Path) -> None:
        try:
            resolved = path.expanduser().resolve()
        except OSError:
            return
        if str(resolved) in found or not is_repo(resolved):
            return
        if _git(resolved, "rev-parse", "--is-inside-work-tree") != "true":
            return
        # Skip the scheduler's own worktrees.
        if _git(resolved, "rev-parse", "--git-common-dir") not in ("", ".git"):
            return
        found[str(resolved)] = {
            "path": str(resolved),
            "name": resolved.name,
            "branch": current_branch(resolved),
        }

    for root in cfg.repo_roots:
        root_path = Path(root).expanduser()
        if is_repo(root_path):
            offer(root_path)
        if root_path.is_dir():
            try:
                for child in sorted(root_path.iterdir()):
                    offer(child)
            except OSError:
                continue

    for path in extra or []:
        if path:
            offer(Path(path))

    return sorted(found.values(), key=lambda r: r["name"].lower())
