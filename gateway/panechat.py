"""Pane chat: the Claude Code in a Herdr pane, read as a chat.

The pane is still a terminal; nothing here drives a process. What makes it
readable as messages is that Claude Code writes every session down as it goes -
`~/.claude/projects/<dir>/<session>.jsonl`, whose lines are the same user,
assistant and tool-result messages the headless chat streams - and Herdr says
which session a pane is in (`agent_session`). So the log is tailed into the
event list the main app renderer folds, and what goes back is Herdr's: a
message is `agent.prompt`, Stop is Esc.

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
import sqlite3
import threading
import time
import uuid
from pathlib import Path

import chat
import tokens
from herdr_rpc import call_herdr_rpc
from scheduler import db as sched_db

# What a phone opening a long session is handed: the end of it.
KEEP = 400
# How often a waiting poll looks at the log and the pane again.
POLL = 0.5
# How much of a log's end is read to find out which session it is. Claude Code
# writes its title line again on every turn, so the newest one is always within
# a few thousand bytes of the end however long the session has run.
IDENTIFY_BYTES = 128 * 1024
# How long a working pane's log may stay silent before we suspect it is not
# that pane's log any more.
QUIET_AFTER = 20.0
# Slack on "this file was written after that moment". The moment is a
# time.time() the gateway took; the file's stamp comes from the filesystem,
# which is coarser - Linux stamps inodes off a tick-granularity clock, and
# several filesystems keep mtime to the whole second. A log written just after
# /clear can therefore carry an mtime just before it, and without this the
# comparison throws away the very session it was meant to find.
MTIME_SLACK = 2.0

COMMAND_NAME = re.compile(r"<command-name>([^<]*)</command-name>")
COMMAND_ARGS = re.compile(r"<command-args>([^<]*)</command-args>")
AI_TITLE = re.compile(r'"(?:aiTitle|agentName)"\s*:\s*"((?:[^"\\]|\\.)*)"')


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


def slim_codex(entry: dict) -> dict | None:
    """Translate one Codex rollout line into the shared pane-chat events."""
    if not isinstance(entry, dict):
        return None
    kind = entry.get("type")
    payload = entry.get("payload") or {}
    if kind == "response_item":
        item = payload
        item_kind = item.get("type")
        if item_kind == "message":
            role = item.get("role")
            if role not in ("user", "assistant"):
                return None
            content = item.get("content") or []
            text = "".join(
                b.get("text", "") for b in content
                if isinstance(b, dict) and b.get("type") in
                ("input_text", "output_text", "text")
            ).strip()
            if not text:
                return None
            if role == "user" and text.startswith("<environment_context>"):
                return None
            return {"type": "prompt" if role == "user" else "assistant",
                    **({"text": text, "images": []} if role == "user" else
                       {"content": [{"type": "text", "text": text}]})}
        if item_kind in ("function_call", "custom_tool_call"):
            try:
                args = item.get("arguments") or item.get("input") or "{}"
                args = json.loads(args) if isinstance(args, str) else args
            except (ValueError, TypeError):
                args = {"input": item.get("input") or item.get("arguments", "")}
            if not isinstance(args, dict):
                args = {"input": args}
            return {"type": "assistant", "content": [{
                "type": "tool_use", "id": item.get("call_id") or item.get("id"),
                "name": item.get("name") or "tool", "input": args,
            }]}
        if item_kind in ("function_call_output", "custom_tool_call_output"):
            output = item.get("output", "")
            if isinstance(output, list):
                output = "\n".join(
                    block.get("text", "") if isinstance(block, dict) else str(block)
                    for block in output
                )
            return {"type": "tool_results", "content": [{
                "tool_use_id": item.get("call_id") or item.get("id"),
                "is_error": bool(item.get("is_error")),
                "content": output,
            }]}
    if kind == "event_msg" and payload.get("type") in ("turn_aborted", "turn_failed"):
        return {"type": "interrupted"}
    return None


# path -> (the size it was read at, the title found in it). Reading a tail is
# cheap but not free, and a log that has not grown cannot have been retitled.
_TITLES: dict = {}


def log_title(path: Path) -> str:
    """The title Claude Code last wrote into a session log.

    It writes the same string Herdr reports as the pane's terminal title, and
    writes it again on every turn - so the end of the file carries the current
    one however long the session has run, and a tail is enough to identify a
    log without reading the megabytes in front of it.
    """
    try:
        size = path.stat().st_size
    except OSError:
        return ""
    seen = _TITLES.get(path)
    if seen and seen[0] == size:
        return seen[1]
    try:
        with open(path, "rb") as f:
            if size > IDENTIFY_BYTES:
                f.seek(size - IDENTIFY_BYTES)
            chunk = f.read().decode("utf-8", "replace")
    except OSError:
        return ""
    found = AI_TITLE.findall(chunk)
    title = ""
    if found:
        try:
            title = json.loads('"' + found[-1] + '"')
        except ValueError:
            title = found[-1]
    _TITLES[path] = (size, title)
    return title


class PaneChat:
    def __init__(self, pane_id: str):
        self.pane_id = pane_id
        self.lock = threading.Lock()
        self.pane: dict = {}
        self.session = None
        self.path: Path | None = None
        # The pane title the log now being tailed was picked for, and when that
        # log last grew: between them they say when to go looking again.
        self.title_seen = None
        self.grew_at = 0.0
        # If Herdr cannot name a brand-new session, its first log can still be
        # identified by the write Claude makes after this pane's first prompt.
        self.first_prompt_at = None
        # Set the moment `/clear` is seen typed into the log, so a rescan does
        # not wait on the quiet timer for a session that is already leaving.
        self.expect_new_session = False
        self.clear_at = None
        self.cleared_path = None
        self.generation = 0
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
        return f"{chat.EPOCH}-{(self.session or '')[:8]}-{self.generation}"

    @property
    def status(self) -> str:
        return self.pane.get("agent_status") or ""

    @property
    def cwd(self) -> str:
        return self.pane.get("foreground_cwd") or self.pane.get("cwd") or ""

    @property
    def dir(self) -> Path:
        return chat.CHAT_DIR / "panes" / self.pane_id.replace(":", "-")

    @property
    def is_claude(self) -> bool:
        """Whether there is a Claude Code in this pane at all."""
        return self.pane.get("agent") == "claude"

    @property
    def is_codex(self) -> bool:
        return self.pane.get("agent") == "codex"

    @property
    def is_supported(self) -> bool:
        return self.is_claude or self.is_codex

    @property
    def title(self) -> str:
        return self.pane.get("terminal_title_stripped") or ""

    def refresh(self) -> bool:
        """Read the pane and whatever the log gained; False for a pane that is gone."""
        res = call_herdr_rpc("pane.get", {"pane_id": self.pane_id})
        pane = (res.get("result") or {}).get("pane")
        if not pane:
            return False
        self.pane = pane
        self._resolve()
        self._read_log()
        self._raise_ask()
        return True

    def _adopt(self, session, path):
        """Start again on another session - or on none."""
        self.session, self.path = session, path
        self.title_seen = self.title
        self.grew_at = time.time()
        self.expect_new_session = False
        self._restart()
        if path:
            self.clear_at = self.cleared_path = None
            self.session = session or path.stem
        if self.is_claude and self.session:
            self._save_session()

    def _save_session(self):
        """Keep the pane-to-log link across a gateway restart."""
        if not self.session and self.first_prompt_at is None:
            try:
                (self.dir / "session.json").unlink()
            except OSError:
                pass
            return
        try:
            self.dir.mkdir(parents=True, exist_ok=True)
            target = self.dir / "session.json"
            temporary = self.dir / "session.json.tmp"
            temporary.write_text(json.dumps({
                "cwd": self.cwd,
                "session": self.session,
                "first_prompt_at": self.first_prompt_at,
            }))
            temporary.replace(target)
        except OSError:
            pass

    def _saved_session_path(self):
        """Return this pane's prior log only when its working directory matches."""
        try:
            saved = json.loads((self.dir / "session.json").read_text())
        except (OSError, ValueError, TypeError):
            return None
        if saved.get("cwd") != self.cwd:
            return None
        if saved.get("session"):
            return tokens.session_log(saved["session"])
        self.first_prompt_at = saved.get("first_prompt_at")
        if self.first_prompt_at is None:
            return None
        updated = []
        for path in tokens.session_logs(self.cwd):
            try:
                if path.stat().st_mtime >= self.first_prompt_at:
                    updated.append(path)
            except OSError:
                continue
        return updated[0] if len(updated) == 1 else None

    def _resolve(self):
        """Which session this pane is in, and so which log there is to tail.

        Herdr says so in `agent_session`, on a version that carries one. Where
        it does not, the log is found by hand: Claude Code files its sessions
        under a directory named after the cwd and writes the pane's own title
        into each of them, so the title is what picks between the several a
        repository accumulates.

        The picking is not redone every poll. It stands until the pane's title
        changes, or until a working pane's log has gone quiet for a while -
        which is what a `/clear` into a fresh session looks like from here.
        """
        if not self.is_supported:
            if self.session or self.path:
                self._adopt(None, None)
            return

        if self.is_codex:
            session = self.pane.get("agent_session") or {}
            sid = session.get("value") if session.get("kind") == "id" else None
            if self.path and self.title == self.title_seen and not self._gone_quiet() \
                    and not self.expect_new_session and (not sid or sid == self.session):
                return
            path = self._find_codex_log(sid)
            if path != self.path:
                self._adopt(sid or self._codex_session_id(path), path)
            elif path:
                self.title_seen = self.title
                self.grew_at = time.time()
            return

        session = self.pane.get("agent_session") or {}
        if session.get("kind") == "id" and session.get("value"):
            sid = session["value"]
            if sid != self.session:
                self._adopt(sid, tokens.session_log(sid))
            elif not self.path:
                # The log is written with the first message, not with the pane.
                self.path = tokens.session_log(sid)
            return

        # Older Herdr versions do not report a session id. If the terminal is
        # still generically titled, use the pane's persisted association before
        # trying to rediscover a log among other sessions in the same cwd.
        if not self.session and self.title in ("", "Claude Code"):
            path = self._saved_session_path()
            if path:
                self._adopt(path.stem, path)
                return

        if self.path and self.title == self.title_seen and not self._gone_quiet() \
                and not self.expect_new_session:
            return
        path = self._find_log()
        if path != self.path:
            self._adopt(path.stem if path else None, path)
        else:
            self.title_seen = self.title
            self.grew_at = time.time()

    def _gone_quiet(self) -> bool:
        """The pane is working and the log we are watching is not: wrong log.

        A long tool call is quiet too, so this is allowed to be wrong - being
        wrong costs one directory scan, and the scan finds the same log again.
        """
        return self.status == "working" and time.time() - self.grew_at > QUIET_AFTER

    def _find_log(self) -> "Path | None":
        """The log of the session this pane is in, by its title; None for
        nothing certain enough to show.

        A pane too new to have been given a title cannot be told from its
        neighbours, and the one place that must not guess is a repository with
        several sessions in it - somebody else's conversation drawn as yours is
        worse than an empty screen, and the title arrives within a turn or two.
        """
        logs = tokens.session_logs(self.cwd)
        if self.clear_at is not None:
            logs = [p for p in logs if p != self.cleared_path
                    and self._mtime_at_least(p, self.clear_at)]
        if not logs:
            return None
        title = self.title
        if title and title != "Claude Code":
            for path in logs:
                if log_title(path) == title:
                    return path
        # Herdr may not report `agent_session`, and Claude can keep the generic
        # terminal title for the first turn. A log written after the first
        # prompt is evidence of the session that prompt started. Refuse ties so
        # another active pane in the same cwd is never mistaken for this one.
        if self.first_prompt_at is not None:
            updated = [p for p in logs
                       if self._mtime_at_least(p, self.first_prompt_at)]
            if len(updated) == 1:
                return updated[0]
        return logs[0] if len(logs) == 1 else None

    @staticmethod
    def _mtime_at_least(path: Path, when: float) -> bool:
        try:
            return path.stat().st_mtime >= when - MTIME_SLACK
        except OSError:
            return False

    def _find_codex_log(self, session_id=None):
        """Find a rollout for this pane, refusing ambiguous same-cwd matches."""
        try:
            candidates = sorted(
                tokens.CODEX_HOME.glob("sessions/*/*/*/*.jsonl"),
                key=lambda p: p.stat().st_mtime,
                reverse=True,
            )[:40]
        except OSError:
            return None
        if self.clear_at is not None:
            candidates = [p for p in candidates if p != self.cleared_path
                          and self._mtime_at_least(p, self.clear_at)]
        matches = []
        for path in candidates:
            try:
                with path.open("rb") as f:
                    lines = [f.readline() for _ in range(4)]
            except OSError:
                continue
            for raw in lines:
                try:
                    entry = json.loads(raw)
                except (ValueError, TypeError):
                    continue
                if entry.get("type") != "session_meta":
                    continue
                meta = entry.get("payload") or {}
                if session_id and meta.get("id") != session_id:
                    continue
                if meta.get("cwd") == self.cwd:
                    matches.append(path)
                break
        if session_id and matches:
            return matches[0]
        if len(matches) == 1:
            return matches[0]
        if matched := self._codex_log_by_sent_prompt(matches):
            return matched
        return self._codex_log_by_title(matches)

    @staticmethod
    def _codex_session_id(path):
        if not path:
            return None
        try:
            with path.open("rb") as stream:
                for _ in range(4):
                    entry = json.loads(stream.readline())
                    if entry.get("type") == "session_meta":
                        return (entry.get("payload") or {}).get("id")
        except (OSError, ValueError, TypeError):
            pass
        return None

    def _codex_log_by_sent_prompt(self, matches):
        """Use this pane's delivered prompts when Codex has no session ID.

        The terminal title is a short summary and often shares no words with
        the thread's first prompt. A prompt the gateway delivered to this pane
        is stronger evidence, provided it appears in exactly one rollout.
        """
        if len(matches) < 2 or not sched_db.DB_PATH.exists():
            return None
        try:
            with sqlite3.connect(f"file:{sched_db.DB_PATH}?mode=ro", uri=True,
                                 timeout=0.2) as conn:
                recent = [row[0] for row in conn.execute(
                    "SELECT prompt FROM queued_prompt WHERE pane_id=? AND state='sent' "
                    "ORDER BY id DESC LIMIT 8", (self.pane_id,)
                )]
        except (OSError, sqlite3.Error):
            return None
        prompts = []
        for prompt in recent:
            if prompt == "/clear":
                break
            if prompt:
                prompts.append(prompt)
        if not prompts:
            return None
        wanted = set(prompts)
        found = {prompt: [] for prompt in wanted}
        for path in matches:
            try:
                with path.open("rb") as f:
                    size = path.stat().st_size
                    f.seek(max(0, size - 1024 * 1024))
                    lines = f.read().splitlines()
            except OSError:
                continue
            for raw in lines:
                try:
                    entry = json.loads(raw)
                except ValueError:
                    continue
                if entry.get("type") != "response_item":
                    continue
                item = entry.get("payload") or {}
                if item.get("type") != "message" or item.get("role") != "user":
                    continue
                text = "".join(block.get("text", "") for block in item.get("content") or []
                               if isinstance(block, dict) and block.get("type") in
                               ("input_text", "text"))
                if text in wanted and path not in found[text]:
                    found[text].append(path)
        for prompt in prompts:
            if len(found[prompt]) == 1:
                return found[prompt][0]
            if len(found[prompt]) > 1:
                return None
        return None

    def _codex_log_by_title(self, matches):
        """Use Codex's thread index when Herdr has no session ID.

        A renamed thread's `name` is what Codex puts in the terminal title.
        The index `title` remains the first prompt, which may share no words
        with that title. Fall back to the first prompt for older Codex indexes.
        """
        title = self.title.split(" | ", 1)[0]
        words = set(re.findall(r"[a-z0-9]+", title.lower()))
        if not title:
            return None
        database = tokens.CODEX_HOME / "state_5.sqlite"
        try:
            with sqlite3.connect(f"file:{database}?mode=ro", uri=True, timeout=0.2) as db:
                columns = {row[1] for row in db.execute("PRAGMA table_info(threads)")}
                name_column = "name" if "name" in columns else "NULL"
                rows = db.execute(
                    f"SELECT rollout_path, title, {name_column} FROM threads "
                    "WHERE cwd = ? AND archived = 0",
                    (self.cwd,),
                ).fetchall()
        except (OSError, sqlite3.Error):
            return None
        candidates = set(matches)
        named = [Path(path) for path, _, name in rows
                 if name == title and Path(path) in candidates]
        if len(named) == 1:
            return named[0]
        if named or len(words) < 3:
            return None
        scored = []
        for path, thread_title, _ in rows:
            if Path(path) not in candidates:
                continue
            other = set(re.findall(r"[a-z0-9]+", (thread_title or "").lower()))
            common = len(words & other)
            if common >= 3 and common / len(words) >= 0.6:
                scored.append((common / len(words), common, Path(path)))
        scored.sort(reverse=True)
        if not scored or len(scored) > 1 and scored[0][:2] == scored[1][:2]:
            return None
        return scored[0][2]

    def _restart(self):
        self.offset, self.tail, self.events, self.model = 0, b"", [], ""
        self.unresolved, self.asks, self.answered, self.pending = {}, {}, set(), {}

    def clear_after_command(self, sent_at: float):
        """Drop the old conversation as soon as /clear is accepted, rather than
        waiting on the title/quiet-timer heuristics to notice a new session -
        which, for a single-session cwd, otherwise re-adopt the very log
        /clear just ended."""
        self.cleared_path = self.path
        self._adopt(None, None)
        self.clear_at = sent_at
        self.generation += 1
        # And forget the saved link to it: /clear puts the generic title back,
        # which is exactly when the saved session is trusted, so the next poll
        # read the conversation that was just cleared straight back in.
        self.first_prompt_at = None
        self._save_session()

    def _read_log(self):
        if not self.path:
            return
        try:
            size = self.path.stat().st_size
            if size < self.offset:
                self._restart()  # rewritten under us: read it again
            if size == self.offset:
                return
            self.grew_at = time.time()
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
            if self.is_codex:
                meta = entry.get("payload") or {}
                model = meta.get("model")
                if isinstance(model, str) and model:
                    self.model = model
                event = slim_codex(entry)
            else:
                event = slim_log(entry)
            if not event:
                continue
            if event["type"] == "assistant":
                if not self.is_codex:
                    self.model = (entry.get("message") or {}).get("model") or self.model
                for b in event["content"]:
                    if b.get("type") == "tool_use" and b.get("id"):
                        self.unresolved[b.get("id")] = b
            elif event["type"] == "tool_results":
                for r in event["content"]:
                    self.unresolved.pop(r.get("tool_use_id"), None)
            elif event["type"] == "interrupted":
                self.unresolved.clear()  # nothing from before is still running
            elif event["type"] == "prompt" and event["text"] == "/clear":
                # The next session's log has not been written yet, but this one
                # is done - don't wait for it to go quiet before looking again.
                self.expect_new_session = True
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
                   # Claude exposes its second option as "always". Codex's
                   # confirmation is a plain yes/no prompt.
                   "suggestions": [] if self.is_codex or tool in
                   ("AskUserQuestion", "ExitPlanMode") else ["2"]}
            self.asks[tid] = ask
            self.events.append(ask)
        self.pending = {tid: self.asks[tid]}

    # ---- what chat.py's routes call --------------------------------------

    def summary(self) -> dict:
        title = self.title
        if not title or title == "Claude Code":
            title = self.cwd.rsplit("/", 1)[-1] or self.pane_id
        # Two different nothings: a pane running no Claude Code, and one whose
        # session has not been found. They read identically to somebody looking
        # at an empty chat, so the page is told which it is.
        return {"id": "pane:" + self.pane_id, "kind": "pane", "pane_id": self.pane_id,
                "title": title, "cwd": self.cwd, "model": self.model, "mode": "",
                "status": self.status, "claude": self.is_claude,
                "supported": self.is_supported, "agent": self.pane.get("agent"),
                "session": bool(self.session),
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
        """Queue a prompt for the pane. The id of the row, or None for one that
        went straight into a shell.

        A pane sitting on a question is no longer refused: the queue holds text
        typed at it until the question is answered, which keeps the message
        rather than making somebody remember what they had written.
        """
        if not self.is_supported:
            raise ValueError("There is no supported agent in this pane")
        # An attachment goes as its path, which Claude Code reads like any file -
        # ahead of the text, since an `@` token under the cursor opens Claude
        # Code's file picker and the Enter meant to send takes a suggestion.
        paths = ["@" + str(p) for p in (chat.upload_path(self.dir, n) for n in images) if p]
        text = "\n".join(paths + [text.strip()]).strip()
        if _queue is None:
            raise ValueError("The queue is not running")
        first_prompt = self.is_claude and not self.session and self.first_prompt_at is None
        if first_prompt:
            self.first_prompt_at = time.time()
            self._save_session()
        payload, _ = _queue(self.pane_id, text)
        if not payload.get("ok"):
            if first_prompt:
                self.first_prompt_at = None
                self._save_session()
            error = payload.get("error")
            if isinstance(error, dict):
                error = error.get("message")
            raise ValueError(error or "The queue refused the prompt")
        return payload.get("id")

    def answer(self, request_id: str, behavior: str, answers: dict | None = None):
        with self.lock:
            ask = self.pending.get(request_id)
        if not ask:
            raise ValueError("That question is no longer open")
        if self.is_codex:
            keys = ["n" if behavior == "deny" else "y"]
        elif behavior == "deny":
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
        """Same answer a headless chat on this project would give - discovered
        the same way, since a pane's own Claude Code has no route to ask it
        directly. Unlike a headless chat's own first ask, there is no chat
        here already to spend on it, so a throwaway one is spun up and killed
        once `_COMMANDS` has this project (or `wait` runs out) - never
        registered, so it is never a chat the flock could show."""
        cwd = self.cwd
        if cwd not in chat._COMMANDS:
            probe = chat.Chat({
                "id": f"probe-{uuid.uuid4().hex[:8]}", "session_id": str(uuid.uuid4()),
                "cwd": cwd, "mode": "auto", "model": "", "title": "",
                "created": time.time(), "updated": time.time(), "started": False,
            })
            try:
                probe.commands(wait)
            except OSError:
                pass
            finally:
                probe.kill()
        return chat._COMMANDS.get(cwd, [])

    def image(self, name: str):
        return chat.upload_path(self.dir, name)


_PANES: dict[str, PaneChat] = {}
_LOCK = threading.Lock()
# How a prompt leaves here. The gateway hands over its queue, so a pane read as
# a chat sends the same way the transcript does - `agent.prompt` from here
# would be a second door into a window the queue is holding shut.
_queue = None


def cleared(pane_id: str, pane: dict, sent_at: float) -> None:
    """Invalidate a pane's chat, read as either the transcript or the chat
    send path, the moment /clear is accepted - Claude included, since its
    log-identity heuristics alone re-adopt the old session until a new log
    exists to tell them apart."""
    if pane.get("agent") not in ("codex", "claude"):
        return
    with _LOCK:
        pc = _PANES.setdefault(pane_id, PaneChat(pane_id))
    with pc.lock:
        pc.pane = pane
        pc.clear_after_command(sent_at)


def init(queue_fn) -> None:
    """queue_fn(pane_id, prompt) -> (payload, status), as /api/queue answers."""
    global _queue
    _queue = queue_fn


def get(pane_id: str) -> PaneChat | None:
    """The pane as a chat, or None for one Herdr does not have."""
    if not re.fullmatch(r"[\w-]+:[\w-]+", pane_id or ""):
        return None
    with _LOCK:
        pc = _PANES.setdefault(pane_id, PaneChat(pane_id))
    with pc.lock:
        return pc if pc.refresh() else None
