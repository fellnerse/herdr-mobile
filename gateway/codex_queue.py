"""Send a message to the Codex session behind a Herdr pane."""

from __future__ import annotations

import shutil
import subprocess
import uuid

import panechat


class CodexQueueError(RuntimeError):
    pass


def send(pane_id: str, text: str) -> None:
    chat = panechat.get(pane_id)
    if not chat or not chat.is_codex or not chat.session:
        raise CodexQueueError("Could not identify this pane's Codex session")
    try:
        uuid.UUID(chat.session)
    except (ValueError, AttributeError) as exc:
        raise CodexQueueError("Codex session ID is unavailable") from exc
    binary = (shutil.which("codex") or shutil.which("/opt/homebrew/bin/codex")
              or shutil.which("/usr/local/bin/codex"))
    if not binary:
        raise CodexQueueError("Codex CLI is not installed on the gateway machine")
    try:
        result = subprocess.run(
            [binary, "queue", "--thread", chat.session, "--message", text],
            cwd=chat.cwd or None, capture_output=True, text=True, timeout=20,
        )
    except (OSError, subprocess.TimeoutExpired) as exc:
        raise CodexQueueError(f"Could not queue Codex message: {exc}") from exc
    if result.returncode:
        detail = (result.stderr or result.stdout).strip().splitlines()
        raise CodexQueueError(detail[-1] if detail else "Codex rejected the message")
