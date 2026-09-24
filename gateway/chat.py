"""Chat: Claude Code without the terminal.

Every chat is a Claude Code session driven headless: one `claude -p` process
per chat, kept running, speaking stream-json both ways. What comes back is the
agent's own messages - text, tool calls, tool results - rather than a screen
to be read for glyphs, and what goes in is messages too, so a second one can be
typed while the first is still being answered. No Herdr pane is involved, and
the session is an ordinary one: `claude --resume` on the desktop opens it too.

Permission prompts come back as well. With `--permission-prompt-tool stdio`
Claude Code asks its host - this module - before a tool the permission mode
does not already allow, and waits for the answer on stdin. The phone sees the
question as an event and answers it through /api/chat/answer. AskUserQuestion
travels the same way, with the chosen answers put into the tool's input.

What the phone reads is a list of events per chat, long-polled by index. Text
deltas live only in memory, for the typing; everything else is appended to a
JSONL file, so a chat survives a gateway restart as its finished messages.
A process nobody has talked to for a while is stopped, and the next message
starts it again on the same session.
"""

from __future__ import annotations

import base64
import json
import os
import re
import shutil
import subprocess
import threading
import time
import uuid
from pathlib import Path

STATE_DIR = Path(os.environ.get("SHEEPIT_STATE_DIR") or Path.home() / ".config/sheepit")
CHAT_DIR = STATE_DIR / "chats"

MODES = ("auto", "acceptEdits", "plan", "manual", "bypassPermissions")
# A tool result can be a whole file; the phone needs to see that it happened.
MAX_RESULT = 4000
# The API refuses an image over 5 MB; the phone scales them down well below.
MAX_IMAGE = 5 * 1024 * 1024
IMAGE_TYPES = {"image/jpeg": "jpg", "image/png": "png", "image/gif": "gif", "image/webp": "webp"}
# A process with nothing to do is a few hundred MB of node; the next message
# resumes the session anyway.
IDLE_REAP = 30 * 60
# The phone long-polls every 20s while a chat is open. Nobody has polled for
# longer than this: nobody is looking, so a finished answer is worth a push.
WATCHED_FOR = 25
INTERRUPTED = "[Request interrupted by user"
# Changes with every start, so a phone holding indices from the last run
# knows to read the chat again from the top.
EPOCH = uuid.uuid4().hex[:8]


def claude_bin() -> str:
    found = os.environ.get("SHEEPIT_CLAUDE") or shutil.which("claude")
    if found:
        return found
    # The menu bar app starts the gateway with launchd's PATH, which has none
    # of the places an install puts it.
    for p in ("~/.local/bin/claude", "~/.claude/local/claude",
              "/opt/homebrew/bin/claude", "/usr/local/bin/claude"):
        p = os.path.expanduser(p)
        if os.access(p, os.X_OK):
            return p
    return "claude"


def _clip(value):
    if isinstance(value, str):
        return value if len(value) <= MAX_RESULT else value[:MAX_RESULT] + f"\n… ({len(value) - MAX_RESULT} more)"
    if isinstance(value, list):
        return [_clip(v) for v in value]
    if isinstance(value, dict):
        if value.get("type") == "image":
            return {"type": "image"}
        return {k: (_clip(v) if k in ("content", "text") else v) for k, v in value.items()}
    return value


def _text_of(content) -> str:
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return "".join(b.get("text", "") for b in content if isinstance(b, dict))
    return ""


def slim(event: dict) -> dict | None:
    """What of one stream-json line is worth sending, or None."""
    kind = event.get("type")
    if kind == "stream_event":
        delta = (event.get("event") or {}).get("delta") or {}
        if delta.get("type") == "text_delta":
            return {"type": "delta", "text": delta.get("text", "")}
        return None
    if kind == "assistant":
        blocks = [b for b in (event.get("message") or {}).get("content") or []
                  if b.get("type") in ("text", "tool_use")]
        return {"type": "assistant", "content": blocks} if blocks else None
    if kind == "user":
        content = (event.get("message") or {}).get("content")
        if _text_of(content).startswith(INTERRUPTED):
            return {"type": "interrupted"}
        blocks = [
            {"type": "tool_result", "tool_use_id": b.get("tool_use_id"),
             "is_error": bool(b.get("is_error")), "content": _clip(b.get("content"))}
            for b in content or [] if isinstance(b, dict) and b.get("type") == "tool_result"
        ]
        return {"type": "tool_results", "content": blocks} if blocks else None
    if kind == "result":
        return {"type": "result", "is_error": bool(event.get("is_error")),
                "subtype": event.get("subtype"), "cost": event.get("total_cost_usd"),
                "duration_ms": event.get("duration_ms"), "num_turns": event.get("num_turns"),
                "text": event.get("result") if event.get("is_error") else None}
    if kind == "system" and event.get("subtype") == "init":
        return {"type": "init", "model": event.get("model"),
                "permission_mode": event.get("permissionMode")}
    if kind == "control_request":
        req = event.get("request") or {}
        if req.get("subtype") == "can_use_tool":
            return {"type": "ask", "request_id": event.get("request_id"),
                    "tool": req.get("tool_name"), "input": req.get("input") or {},
                    "tool_use_id": req.get("tool_use_id"),
                    "description": req.get("description") or "",
                    "suggestions": req.get("permission_suggestions") or []}
    return None


class Chat:
    def __init__(self, meta: dict):
        self.meta = meta
        self.events: list[dict] = []
        self.cond = threading.Condition()
        self.proc: subprocess.Popen | None = None
        self.stdin_lock = threading.Lock()
        self.busy = False
        # request_id -> the ask event, while Claude Code waits on it
        self.pending: dict[str, dict] = {}
        self.last_used = time.time()
        self.last_seen = 0.0
        self.reaping = False

    @property
    def dir(self) -> Path:
        return CHAT_DIR / self.meta["id"]

    @property
    def path(self) -> Path:
        return CHAT_DIR / f"{self.meta['id']}.jsonl"

    def save_meta(self):
        CHAT_DIR.mkdir(parents=True, exist_ok=True)
        (CHAT_DIR / f"{self.meta['id']}.json").write_text(json.dumps(self.meta))

    def load(self):
        try:
            with open(self.path) as f:
                self.events = [json.loads(line) for line in f if line.strip()]
        except FileNotFoundError:
            self.events = []
        # A turn the last gateway was in the middle of is gone with it, and
        # without saying so the chat would look like it is still thinking.
        for ev in reversed(self.events):
            if ev["type"] in ("result", "exit", "error", "interrupted"):
                break
            if ev["type"] == "prompt":
                self.push({"type": "error", "text": "The gateway restarted before this was answered."})
                break

    def push(self, event: dict):
        event["at"] = time.time()
        if event["type"] != "delta":
            CHAT_DIR.mkdir(parents=True, exist_ok=True)
            with open(self.path, "a") as f:
                f.write(json.dumps(event) + "\n")
        with self.cond:
            self.events.append(event)
            self.cond.notify_all()

    @property
    def alive(self) -> bool:
        return self.proc is not None and self.proc.poll() is None

    def summary(self) -> dict:
        return {**self.meta, "running": self.busy, "pending": list(self.pending)}

    def _write(self, obj: dict):
        with self.stdin_lock:
            self.proc.stdin.write(json.dumps(obj) + "\n")
            self.proc.stdin.flush()

    def _start(self):
        meta = self.meta
        cmd = [claude_bin(), "-p", "--input-format", "stream-json",
               "--output-format", "stream-json", "--verbose", "--include-partial-messages",
               "--permission-prompt-tool", "stdio", "--permission-mode", meta["mode"]]
        if meta.get("model"):
            cmd += ["--model", meta["model"]]
        # The first process names the session, so its id is known before
        # Claude Code says it; every one after picks it up again.
        cmd += ["--resume" if meta.get("started") else "--session-id", meta["session_id"]]
        # stderr shares the pipe, so a full one cannot stall the other.
        self.proc = subprocess.Popen(
            cmd, cwd=meta["cwd"], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT, text=True, bufsize=1)
        self.reaping = False
        self.last_used = time.time()
        threading.Thread(target=self._pump, args=(self.proc,), daemon=True).start()
        # What the SDK asks first: the answer lists every slash command and
        # skill this session has, with descriptions - which `init` does not.
        self._write({"type": "control_request", "request_id": f"init-{uuid.uuid4().hex[:8]}",
                     "request": {"subtype": "initialize"}})

    def send(self, text: str, images: list):
        content = []
        for name in images:
            data, ctype = self.image(name)
            if data is None:
                raise ValueError("That image is gone")
            content.append({"type": "image", "source": {
                "type": "base64", "media_type": ctype, "data": base64.b64encode(data).decode()}})
        if text.strip():
            content.append({"type": "text", "text": text})
        if not self.alive:
            try:
                self._start()
            except OSError as e:
                self.push({"type": "prompt", "text": text, "images": images})
                self.push({"type": "error", "text": f"Could not start Claude Code: {e}"})
                return
        meta = self.meta
        # Only now: a process that never got a message never wrote a session,
        # and `--resume` on one that does not exist fails.
        meta["started"] = True
        meta["updated"] = self.last_used = time.time()
        if not meta.get("title"):
            meta["title"] = text.strip().splitlines()[0][:60] if text.strip() else "An image"
        self.save_meta()
        self.busy = True
        # Before the write, so the phone that wakes on it already reads busy.
        self.push({"type": "prompt", "text": text, "images": images})
        try:
            self._write({"type": "user", "message": {"role": "user", "content": content}})
        except OSError as e:
            self.push({"type": "error", "text": f"Claude Code went away: {e}"})

    def answer(self, request_id: str, behavior: str, answers: dict | None = None):
        ask = self.pending.pop(request_id, None)
        if not ask:
            raise ValueError("That question is no longer open")
        if behavior == "deny":
            response = {"behavior": "deny", "message": "The user declined this from their phone."}
        else:
            updated = dict(ask["input"])
            if answers:
                updated["answers"] = answers
            response = {"behavior": "allow", "updatedInput": updated}
            if behavior == "always" and ask.get("suggestions"):
                response["updatedPermissions"] = ask["suggestions"]
        self.last_used = time.time()
        self.push({"type": "answered", "request_id": request_id, "behavior": behavior,
                   "answers": answers})
        self._write({"type": "control_response", "response": {
            "subtype": "success", "request_id": request_id, "response": response}})

    def stop(self):
        """Interrupt the turn, the way Esc does; the process stays."""
        if self.alive and self.busy:
            self._write({"type": "control_request", "request_id": uuid.uuid4().hex,
                         "request": {"subtype": "interrupt"}})

    def kill(self):
        if self.alive:
            self.reaping = True
            self.proc.terminate()

    def _pump(self, proc: subprocess.Popen):
        noise = []
        for line in proc.stdout:
            try:
                raw = json.loads(line)
                event = slim(raw) if isinstance(raw, dict) else None
                if isinstance(raw, dict) and raw.get("type") == "control_response":
                    self._took_commands(raw.get("response") or {})
            except ValueError:
                # Not JSON: stderr, kept as the explanation if the run fails.
                noise = (noise + [line.rstrip()])[-20:]
                continue
            if not event:
                continue
            kind = event["type"]
            if kind == "init":
                self.busy = True
            elif kind == "ask":
                self.pending[event["request_id"]] = event
            self.push(event)
            if kind == "result":
                self.busy = False
                self.last_used = time.time()
                self.notify("done")
            elif kind == "ask":
                self.notify("ask", event)
        code = proc.wait()
        if proc is not self.proc:
            return
        was_busy, self.busy = self.busy, False
        self.pending.clear()
        if not self.reaping:
            text = "\n".join(noise).strip()
            self.push({"type": "exit", "code": code,
                       "text": text or f"Claude Code exited ({code})"})
            if was_busy:
                self.notify("done")
        elif was_busy:
            self.push({"type": "exit", "code": code, "text": "Stopped."})

    def _took_commands(self, response: dict):
        if not str(response.get("request_id", "")).startswith("init-"):
            return
        commands = [
            {"name": c.get("name"), "description": c.get("description") or "",
             "hint": c.get("argumentHint") or ""}
            for c in (response.get("response") or {}).get("commands") or []
            # "__"-names are Claude Code's own plumbing, not for typing,
            # and "(removed)" ones only say where the feature went.
            if c.get("name") and not c["name"].startswith("__")
            and not (c.get("description") or "").startswith("(removed)")
        ]
        _COMMANDS[self.meta["cwd"]] = sorted(commands, key=lambda c: c["name"])
        with self.cond:
            self.cond.notify_all()

    def commands(self, wait: float) -> list:
        """The slash commands and skills for this chat's project. The first
        ask for a project starts the chat's process to find out; after that
        the answer is remembered per project."""
        cwd = self.meta["cwd"]
        if cwd not in _COMMANDS:
            if not self.alive:
                self._start()
            deadline = time.time() + wait
            with self.cond:
                while cwd not in _COMMANDS and time.time() < deadline:
                    self.cond.wait(deadline - time.time())
        return _COMMANDS.get(cwd, [])

    def notify(self, kind: str, ask: dict | None = None):
        if time.time() - self.last_seen < WATCHED_FOR:
            return  # somebody is looking at it
        title = self.meta.get("title") or "Chat"
        if kind == "ask":
            if ask["tool"] == "AskUserQuestion":
                qs = ask["input"].get("questions") or [{}]
                body = qs[0].get("question") or "A question is waiting."
            else:
                body = f"Allow {ask['tool']}: {ask.get('description') or ''}".strip(": ")
            title = f"{title} needs you"
        else:
            body = ""
            for ev in reversed(self.events):
                if ev["type"] == "assistant":
                    body = " ".join(b.get("text", "") for b in ev["content"] if b.get("type") == "text")
                    if body.strip():
                        break
            body = " ".join(body.split())[:140] or "Finished."
        try:
            _notify(title, body, f"/chat.html#{self.meta['id']}")
        except Exception as e:  # a push that fails must not take the chat with it
            print(f"chat push failed: {e}")

    def image(self, name: str):
        if not re.fullmatch(r"[0-9a-f]{12}\.(jpg|png|gif|webp)", name or ""):
            return None, None
        try:
            data = (self.dir / name).read_bytes()
        except OSError:
            return None, None
        ext = name.rsplit(".", 1)[1]
        return data, next(t for t, e in IMAGE_TYPES.items() if e == ext)

    def read(self, since: int, wait: float) -> tuple[list, int]:
        self.last_seen = time.time()
        with self.cond:
            if since >= len(self.events) and wait > 0:
                self.cond.wait(wait)
            self.last_seen = time.time()
            return self.events[since:], len(self.events)


_CHATS: dict[str, Chat] = {}
_LOCK = threading.Lock()
# project directory -> [{name, description, hint}], from `initialize`
_COMMANDS: dict[str, list] = {}
_known_dirs = lambda: []  # noqa: E731 - replaced by init_chat_routes
_notify = lambda title, body, url: None  # noqa: E731


def load_all():
    if not CHAT_DIR.is_dir():
        return
    for p in CHAT_DIR.glob("*.json"):
        try:
            chat = Chat(json.loads(p.read_text()))
        except (ValueError, OSError):
            continue
        chat.load()
        _CHATS[chat.meta["id"]] = chat


def reap_forever():
    while True:
        time.sleep(60)
        for chat in list(_CHATS.values()):
            if (chat.alive and not chat.busy and not chat.pending
                    and time.time() - chat.last_used > IDLE_REAP):
                chat.kill()


def get(chat_id) -> Chat | None:
    return _CHATS.get(chat_id if isinstance(chat_id, str) else "")


# ---- routes -------------------------------------------------------------

def handle_list(handler, qs):
    chats = sorted((c.summary() for c in _CHATS.values()),
                   key=lambda m: m.get("updated") or m.get("created") or 0, reverse=True)
    handler.send_json({"ok": True, "chats": chats, "dirs": _known_dirs(), "modes": list(MODES)})


def handle_events(handler, qs):
    chat = get((qs.get("id") or [""])[0])
    if not chat:
        handler.send_json({"ok": False, "error": "No such chat"}, 404)
        return
    try:
        since = max(0, int((qs.get("since") or ["0"])[0]))
    except ValueError:
        since = 0
    if (qs.get("epoch") or [""])[0] != EPOCH or since > len(chat.events):
        since = 0
    wait = 20.0 if (qs.get("wait") or [""])[0] == "1" else 0.0
    events, nxt = chat.read(since, wait)
    handler.send_json({"ok": True, "epoch": EPOCH, "from": since, "next": nxt,
                       "events": events, "chat": chat.summary()})


def handle_commands(handler, qs):
    chat = get((qs.get("id") or [""])[0])
    if not chat:
        handler.send_json({"ok": False, "error": "No such chat"}, 404)
        return
    try:
        commands = chat.commands(wait=15.0)
    except OSError as e:
        handler.send_json({"ok": False, "error": f"Could not start Claude Code: {e}"}, 500)
        return
    handler.send_json({"ok": True, "commands": commands})


def handle_image(handler, qs):
    chat = get((qs.get("id") or [""])[0])
    data, ctype = chat.image((qs.get("name") or [""])[0]) if chat else (None, None)
    if data is None:
        handler.send_json({"ok": False, "error": "No such image"}, 404)
        return
    handler.send_response(200)
    handler.send_header("Content-Type", ctype)
    handler.send_header("Content-Length", str(len(data)))
    handler.send_header("X-Content-Type-Options", "nosniff")
    handler.send_header("Cache-Control", "private, max-age=86400")
    handler.end_headers()
    if not handler.head_only:
        handler.wfile.write(data)


def handle_upload(handler, qs):
    """An image arrives as itself rather than as JSON, and is kept with the
    chat - not in the project, since it goes to Claude inline."""
    chat = get((qs.get("id") or [""])[0])
    ext = IMAGE_TYPES.get((handler.headers.get("Content-Type") or "").split(";")[0].strip())
    try:
        length = int(handler.headers.get("Content-Length", 0))
    except ValueError:
        length = -1
    if not chat or not ext:
        handler.send_json({"ok": False, "error": "Need a chat and a JPEG, PNG, GIF or WebP"}, 400)
        return
    if length <= 0 or length > MAX_IMAGE:
        handler.send_json({"ok": False, "error": "That image is too big to send"}, 413)
        return
    data = handler.rfile.read(length)
    if len(data) != length:
        handler.send_json({"ok": False, "error": "The upload was cut short"}, 400)
        return
    name = f"{uuid.uuid4().hex[:12]}.{ext}"
    chat.dir.mkdir(parents=True, exist_ok=True)
    (chat.dir / name).write_bytes(data)
    handler.send_json({"ok": True, "name": name})


def handle_new(handler, body):
    cwd = str(body.get("cwd") or "").rstrip("/")
    # The client names the directory, so it has to be one the flock already
    # has a pane in: this is a shell with a language model in front of it.
    if cwd not in {d["cwd"] for d in _known_dirs()} or not os.path.isdir(cwd):
        handler.send_json({"ok": False, "error": "Not a project SheepIt knows"}, 400)
        return
    mode = body.get("mode") if body.get("mode") in MODES else "auto"
    model = str(body.get("model") or "").strip()[:60]
    now = time.time()
    meta = {"id": uuid.uuid4().hex[:12], "session_id": str(uuid.uuid4()), "cwd": cwd,
            "mode": mode, "model": model, "title": "", "created": now, "updated": now,
            "started": False}
    chat = Chat(meta)
    chat.save_meta()
    with _LOCK:
        _CHATS[meta["id"]] = chat
    handler.send_json({"ok": True, "chat": chat.summary()})


def handle_send(handler, body):
    chat = get(body.get("id"))
    text = str(body.get("text") or "")
    images = [str(n) for n in body.get("images") or []][:8]
    if not chat or not (text.strip() or images):
        handler.send_json({"ok": False, "error": "Need a chat and something to say"}, 400)
        return
    try:
        chat.send(text, images)
    except ValueError as e:
        handler.send_json({"ok": False, "error": str(e)}, 400)
        return
    handler.send_json({"ok": True, "chat": chat.summary()})


def handle_answer(handler, body):
    chat = get(body.get("id"))
    behavior = body.get("behavior")
    answers = body.get("answers") if isinstance(body.get("answers"), dict) else None
    if not chat or behavior not in ("allow", "always", "deny"):
        handler.send_json({"ok": False, "error": "Need a chat and allow, always or deny"}, 400)
        return
    try:
        chat.answer(str(body.get("request_id") or ""), behavior, answers)
    except (ValueError, OSError) as e:
        handler.send_json({"ok": False, "error": str(e)}, 409)
        return
    handler.send_json({"ok": True, "chat": chat.summary()})


def handle_stop(handler, body):
    chat = get(body.get("id"))
    if chat:
        try:
            chat.stop()
        except OSError:
            chat.kill()
    handler.send_json({"ok": bool(chat)})


def handle_delete(handler, body):
    chat = get(body.get("id"))
    if not chat:
        handler.send_json({"ok": False, "error": "No such chat"}, 404)
        return
    chat.kill()
    with _LOCK:
        _CHATS.pop(chat.meta["id"], None)
    shutil.rmtree(chat.dir, ignore_errors=True)
    for suffix in (".json", ".jsonl"):
        try:
            (CHAT_DIR / f"{chat.meta['id']}{suffix}").unlink()
        except FileNotFoundError:
            pass
    handler.send_json({"ok": True})


def init_chat_routes(register_route_fn, known_dirs_fn, notify_fn) -> None:
    """notify_fn(title, body, url) parks a push and sends it."""
    global _known_dirs, _notify
    _known_dirs = known_dirs_fn
    _notify = notify_fn
    load_all()
    threading.Thread(target=reap_forever, daemon=True).start()
    register_route_fn("GET", "/api/chat", handle_list)
    register_route_fn("GET", "/api/chat/events", handle_events)
    register_route_fn("GET", "/api/chat/image", handle_image)
    register_route_fn("GET", "/api/chat/commands", handle_commands)
    register_route_fn("POST", "/api/chat/new", handle_new)
    register_route_fn("POST", "/api/chat/send", handle_send)
    register_route_fn("POST", "/api/chat/answer", handle_answer)
    register_route_fn("POST", "/api/chat/stop", handle_stop)
    register_route_fn("POST", "/api/chat/delete", handle_delete)
