"""Pane chat: the Claude Code in a Herdr pane, read as a chat.

The pane is still a terminal; nothing here drives a process. What makes it
readable as messages is that Claude Code writes every session down as it goes -
`~/.claude/projects/<dir>/<session>.jsonl`, whose lines are the same user,
assistant and tool-result messages the headless chat streams - and Herdr says
which session a pane is in (`agent_session`). So the log is tailed into the
event list chat.js already folds, and what goes back is Herdr's: a message is
`agent.prompt`, Stop is Esc.

A permission prompt is not in the log; the TUI draws it. What is in the log
is the tool call, written before Claude Code asks about it, so a tool with no
result yet in a pane Herdr calls `blocked` is the question - asked as an event
the page draws like any other, and answered with the keys the TUI numbers its
options with. Anything harder than one question with one answer stays in the
terminal.

Nothing is kept: the event list lives as long as the gateway, and starts
again from the log when the pane moves to another session (`/clear`).
"""

from __future__ import annotations

import json
import re
import threading
import time
from pathlib import Path

import chat
import tokens
from herdr_rpc import call_herdr_rpc

# What a phone opening a long session is handed: the end of it.
KEEP = 400
# How often a waiting poll looks at the log and the pane again.
POLL = 0.5

COMMAND_NAME = re.compile(r"<command-name>([^<]*)</command-name>")
COMMAND_ARGS = re.compile(r"<command-args>([^<]*)</command-args>")


def slim_log(entry: dict) -> dict | None:
    """What of one session-log line is worth sending, or None."""
    if not isinstance(entry, dict) or entry.get("isSidechain") or entry.get("isMeta"):
        return None
    kind = entry.get("type")
    if kind == "system" and entry.get("subtype") == "turn_duration":
        return {"type": "result", "duration_ms": entry.get("durationMs")}
    if kind not in ("user", "assistant") or not isinstance(entry.get("message"), dict):
        return None
    event = chat.slim(entry)
    if event or kind == "assistant":
        return event
    # The user's own message, which the headless stream never echoes back.
    text = chat._text_of(entry["message"].get("content")).strip()
    name = COMMAND_NAME.search(text)
    if name:
        args = COMMAND_ARGS.search(text)
        text = ("/" + name.group(1).lstrip("/") + " " + (args.group(1) if args else "")).strip()
    elif text.startswith("<"):
        return None  # a command's output, a reminder, a notification
    return {"type": "prompt", "text": text, "images": []} if text else None


class PaneChat:
    def __init__(self, pane_id: str):
        self.pane_id = pane_id
        self.lock = threading.Lock()
        self.pane: dict = {}
        self.session = None
        self.path: Path | None = None
        self.offset = 0
        self.tail = b""
        self.events: list[dict] = []
        self.model = ""
        # tool_use_id -> the tool_use block, until its result is in the log
        self.unresolved: dict[str, dict] = {}
        # tool_use_id -> the ask event, once one was raised for it
        self.asks: dict[str, dict] = {}
        self.answered: set = set()
        self.pending: dict[str, dict] = {}

    @property
    def epoch(self) -> str:
        return f"{chat.EPOCH}-{(self.session or '')[:8]}"

    @property
    def status(self) -> str:
        return self.pane.get("agent_status") or ""

    @property
    def cwd(self) -> str:
        return self.pane.get("foreground_cwd") or self.pane.get("cwd") or ""

    @property
    def dir(self) -> Path:
        return chat.CHAT_DIR / "panes" / self.pane_id.replace(":", "-")

    def refresh(self) -> bool:
        """Read the pane and whatever the log gained; False for a pane that is gone."""
        res = call_herdr_rpc("pane.get", {"pane_id": self.pane_id})
        pane = (res.get("result") or {}).get("pane")
        if not pane:
            return False
        self.pane = pane
        session = pane.get("agent_session") or {}
        sid = session.get("value") if pane.get("agent") == "claude" and session.get("kind") == "id" else None
        if sid != self.session:
            self.session, self.path = sid, None
            self._restart()
        if self.session and not self.path:
            self.path = tokens.session_log(self.session)  # written with the first message
        self._read_log()
        self._raise_ask()
        return True

    def _restart(self):
        self.offset, self.tail, self.events, self.model = 0, b"", [], ""
        self.unresolved, self.asks, self.answered, self.pending = {}, {}, set(), {}

    def _read_log(self):
        if not self.path:
            return
        try:
            size = self.path.stat().st_size
            if size < self.offset:
                self._restart()  # rewritten under us: read it again
            if size == self.offset:
                return
            with open(self.path, "rb") as f:
                f.seek(self.offset)
                data = self.tail + f.read(size - self.offset)
        except OSError:
            return
        first = self.offset == 0
        self.offset = size
        *lines, self.tail = data.split(b"\n")
        for line in lines:
            try:
                entry = json.loads(line)
            except ValueError:
                continue
            event = slim_log(entry)
            if not event:
                continue
            if event["type"] == "assistant":
                self.model = (entry.get("message") or {}).get("model") or self.model
                for b in event["content"]:
                    if b.get("type") == "tool_use":
                        self.unresolved[b.get("id")] = b
            elif event["type"] == "tool_results":
                for r in event["content"]:
                    self.unresolved.pop(r.get("tool_use_id"), None)
            elif event["type"] == "interrupted":
                self.unresolved.clear()  # nothing from before is still running
            self.events.append(event)
        if first:
            self.events = self.events[-KEEP:]

    def _raise_ask(self):
        """A blocked pane with a tool call still open is asking about that call."""
        self.pending = {}
        if self.status != "blocked":
            return
        waiting = [t for t in self.unresolved if t not in self.answered]
        if not waiting:
            return
        tid = waiting[0]
        if tid not in self.asks:
            block = self.unresolved[tid]
            tool = block.get("name") or ""
            ask = {"type": "ask", "request_id": tid, "tool": tool, "tool_use_id": tid,
                   "input": block.get("input") or {}, "description": "",
                   # The TUI's second option is "yes, and don't ask again".
                   "suggestions": [] if tool in ("AskUserQuestion", "ExitPlanMode") else ["2"]}
            self.asks[tid] = ask
            self.events.append(ask)
        self.pending = {tid: self.asks[tid]}

    # ---- what chat.py's routes call --------------------------------------

    def summary(self) -> dict:
        title = self.pane.get("terminal_title_stripped") or ""
        if not title or title == "Claude Code":
            title = self.cwd.rsplit("/", 1)[-1] or self.pane_id
        return {"id": "pane:" + self.pane_id, "kind": "pane", "pane_id": self.pane_id,
                "title": title, "cwd": self.cwd, "model": self.model, "mode": "",
                "status": self.status, "claude": bool(self.session),
                "running": self.status == "working", "pending": list(self.pending)}

    def read(self, since: int, epoch: str, wait: float) -> tuple[int, list, int]:
        deadline = time.time() + wait
        with self.lock:
            self.refresh()
            began = self.epoch
            if epoch != began or since > len(self.events):
                since = 0
            seen = (self.status, len(self.pending))
        while time.time() < deadline:
            with self.lock:
                if since < len(self.events) or (self.status, len(self.pending)) != seen \
                        or self.epoch != began:
                    break
            time.sleep(POLL)
            with self.lock:
                self.refresh()
        with self.lock:
            if self.epoch != began:
                since = 0
            return since, self.events[since:], len(self.events)

    def _keys(self, keys: list):
        res = call_herdr_rpc("agent.send_keys", {"target": self.pane_id, "keys": keys})
        if "error" in res:
            res = call_herdr_rpc("pane.send_keys", {"pane_id": self.pane_id, "keys": keys})
        if "error" in res:
            raise ValueError(res["error"].get("message") or "Herdr refused the keys")

    def send(self, text: str, images: list):
        if not self.session:
            raise ValueError("There is no Claude Code in this pane")
        if self.status == "blocked":
            raise ValueError("It is waiting on a question - answer that first")
        # An image goes as its path, which Claude Code reads like any file.
        paths = ["@" + str(self.dir / n) for n in images if chat.read_image(self.dir, n)[0] is not None]
        text = "\n".join([text.strip()] + paths).strip()
        res = call_herdr_rpc("agent.prompt", {"target": self.pane_id, "text": text})
        if "error" in res:
            raise ValueError(res["error"].get("message") or "Herdr refused the prompt")

    def answer(self, request_id: str, behavior: str, answers: dict | None = None):
        with self.lock:
            ask = self.pending.get(request_id)
        if not ask:
            raise ValueError("That question is no longer open")
        if behavior == "deny":
            keys = ["esc"]
        elif ask["tool"] == "AskUserQuestion":
            qs = ask["input"].get("questions") or []
            if len(qs) != 1 or qs[0].get("multiSelect"):
                raise ValueError("Answer this one in the terminal")
            labels = [o.get("label") for o in qs[0].get("options") or []]
            picked = (answers or {}).get(qs[0].get("question"))
            if picked not in labels:
                raise ValueError("Pick one of the options")
            keys = [str(labels.index(picked) + 1)]
        else:
            keys = ["2" if behavior == "always" else "1"]
        self._keys(keys)
        with self.lock:
            self.answered.add(request_id)
            self.pending.pop(request_id, None)
            self.events.append({"type": "answered", "request_id": request_id,
                                "behavior": behavior, "answers": answers})

    def stop(self):
        if self.status == "working":
            try:
                self._keys(["esc"])
            except ValueError:
                pass

    def kill(self):
        pass  # the pane is not ours to stop

    def commands(self, wait: float) -> list:
        return chat._COMMANDS.get(self.cwd, [])

    def image(self, name: str):
        return chat.read_image(self.dir, name)


_PANES: dict[str, PaneChat] = {}
_LOCK = threading.Lock()


def get(pane_id: str) -> PaneChat | None:
    """The pane as a chat, or None for one Herdr does not have."""
    if not re.fullmatch(r"[\w-]+:[\w-]+", pane_id or ""):
        return None
    with _LOCK:
        pc = _PANES.setdefault(pane_id, PaneChat(pane_id))
    with pc.lock:
        return pc if pc.refresh() else None
