#!/usr/bin/env python3
"""
SheepIt: the gateway between the phone and a local Herdr server.
Connects directly to the Herdr UNIX socket and serves a mobile-friendly PWA.
"""

from __future__ import annotations

import os
import re
import sys
import time
import json
import hashlib
import logging
import secrets
import threading
import mimetypes
import contextlib
import subprocess
import shutil
from pathlib import Path
from urllib.parse import urlparse, urlsplit, parse_qs, unquote
from http import HTTPStatus
from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler

import push
import tokens
import gitdiff
import machine
import wsproto
import chat
import panechat
import heartbeat
from herdr_rpc import HERDR_SOCKET_PATH, call_herdr_rpc
from terminal import TerminalStream, TerminalError
from scheduler import config as sched_config
from scheduler import db as sched_db
from scheduler import quota as sched_quota
from scheduler.dispatch import Scheduler

# The console attaches to Herdr's client socket, which sits beside the RPC one
# and speaks the protocol a real Herdr GUI speaks.
HERDR_CLIENT_SOCKET_PATH = (
    os.environ.get("HERDR_CLIENT_SOCKET")
    or str(Path(HERDR_SOCKET_PATH).with_name("herdr-client.sock"))
)

HOST = os.environ.get("HOST", "127.0.0.1")
PORT = int(os.environ.get("SHEEPIT_PORT") or os.environ.get("PORT", "3009"))
# The PWA lives beside the gateway, not inside it.
WEB_DIR = (Path(__file__).resolve().parent.parent / "web").resolve()

# The dispatch thread, once `run` starts it. Held so a freshly queued prompt can
# nudge it awake instead of waiting out a poll.
SCHEDULER = None



# Directories that are never worth completing into on a phone.
SKIP_DIRS = {".git", "node_modules", "__pycache__", ".venv", "venv", ".direnv",
             ".mypy_cache", ".pytest_cache", "dist", "build", ".next", "target"}


def complete_path(base: str, query: str, limit: int = 20) -> list:
    """Complete `query` against the pane's working directory.

    `base` comes from herdr, `query` from the client, so the resolved target is
    checked to still sit inside `base`: without that, "../../.." walks the
    gateway out of the project and lists arbitrary parts of the filesystem.
    """
    try:
        root = Path(base).resolve(strict=True)
    except (OSError, RuntimeError):
        return []

    head, _, prefix = query.rpartition("/")
    try:
        target = (root / head).resolve()
    except (OSError, RuntimeError):
        return []
    if target != root and root not in target.parents:
        return []

    try:
        entries = sorted(
            target.iterdir(), key=lambda e: (not e.is_dir(), e.name.lower())
        )
    except OSError:
        return []

    out = []
    for entry in entries:
        name = entry.name
        if not name.lower().startswith(prefix.lower()):
            continue
        # Hidden entries only surface once the user types the dot.
        if name.startswith(".") and not prefix.startswith("."):
            continue
        is_dir = entry.is_dir()
        if is_dir and name in SKIP_DIRS:
            continue
        out.append({
            "name": name,
            "path": f"{head}/{name}" if head else name,
            "is_dir": is_dir,
        })
        if len(out) >= limit:
            break
    return out


def agent_rows() -> list:
    """Every row the phone shows, in one call. Driven from workspaces and their
    tabs, not from agents: a freshly created workspace has no agent yet, and a
    tab the agent is not in would otherwise be invisible from the phone even
    though the laptop shows it. Workspace labels are also what the desktop UI
    shows ("sheepit", "ib-orbit") - agent.list only carries ids."""
    res = call_herdr_rpc("agent.list")
    if "error" in res:
        raise RuntimeError(res["error"])
    agents_raw = res.get("result", {}).get("agents", [])
    ws_list = call_herdr_rpc("workspace.list").get("result", {}).get("workspaces", [])
    panes = call_herdr_rpc("pane.list").get("result", {}).get("panes", [])
    tabs = call_herdr_rpc("tab.list").get("result", {}).get("tabs", [])
    return build_agent_rows(ws_list, tabs, panes, agents_raw)


def project_of(ws: dict, pane: dict) -> tuple:
    """Which project a row belongs to: its key and the name to show.

    Herdr knows this for a workspace it opened on a repository - `worktree`
    carries the repo root even when the checkout is a linked worktree, which is
    what puts the scheduler's `sheep/` branches under the project they were cut
    from rather than in five projects of their own.

    A workspace opened by hand has no `worktree` at all, so the directory is
    the best key there is. It agrees with the repo root whenever the pane sits
    at the top of a checkout, which is the common case.
    """
    tree = ws.get("worktree") or {}
    root = tree.get("repo_root") or ""
    if root:
        return root, tree.get("repo_name") or root.rstrip("/").rsplit("/", 1)[-1]
    cwd = (pane.get("cwd") or "").rstrip("/")
    if cwd:
        return cwd, cwd.rsplit("/", 1)[-1] or cwd
    return "", ws.get("label") or "elsewhere"


def tabs_from_panes(ws_id: str, ws_panes: list) -> list:
    """Stand-in tabs for a Herdr that did not answer tab.list, built from the
    tab ids the panes carry. They keep the order pane.list gave them rather
    than being sorted by id, because "t10" sorts before "t3" and a fallback
    that reorders the tabs is worse than one that only loses their labels."""
    seen = []
    for pane in ws_panes:
        tab_id = pane.get("tab_id")
        if tab_id and tab_id not in seen:
            seen.append(tab_id)
    return [
        {"tab_id": tab_id, "workspace_id": ws_id, "number": i + 1, "label": ""}
        for i, tab_id in enumerate(seen)
    ]


def worktree_branch(workspace_id: str) -> dict:
    """The branch and repository of the worktree a workspace has open.

    Read from Herdr rather than guessed from the path: `worktree.list` is the
    only thing that knows which checkout a workspace is holding, and it names
    the branch outright. Returns empty when the workspace is not a worktree at
    all, which is the answer for a project's own checkout.
    """
    res = call_herdr_rpc("worktree.list", {"workspace_id": workspace_id})
    result = res.get("result") or {}
    root = (result.get("source") or {}).get("repo_root", "")
    for tree in result.get("worktrees") or []:
        if tree.get("open_workspace_id") != workspace_id:
            continue
        # A detached checkout has no branch to leave behind.
        if tree.get("is_detached") or not tree.get("is_linked_worktree"):
            return {}
        return {"branch": tree.get("branch") or "", "repo_root": root}
    return {}


def build_agent_rows(ws_list: list, tabs: list, panes: list, agents_raw: list) -> list:
    """One row per tab, grouped under its workspace and ordered the way the
    desktop orders them - `number` is the workspace's place in Herdr's own
    strip, which is where a workspace lands when it is created and where it
    moves when anybody reorders it.

    A tab is the unit the phone picks, but a tab can be split across several
    panes and each of those can be running its own agent. Listing only the
    first would hide the rest entirely, so a split tab contributes one row per
    agent pane and says so; a tab with no agent at all still gets a single row
    for its own pane, which is what keeps an empty workspace reachable.
    """
    by_pane = {a.get("pane_id"): a for a in agents_raw}
    tabs_by_ws = {}
    for tab in tabs:
        tabs_by_ws.setdefault(tab.get("workspace_id"), []).append(tab)
    rows = []

    for ws in sorted(ws_list, key=lambda w: (w.get("number") or 0, w.get("workspace_id") or "")):
        ws_id = ws.get("workspace_id")
        ws_panes = [p for p in panes if p.get("workspace_id") == ws_id]
        if not ws_panes:
            continue
        ws_tabs = tabs_by_ws.get(ws_id) or tabs_from_panes(ws_id, ws_panes)
        ws_tabs = sorted(ws_tabs, key=lambda t: (t.get("number") or 0, t.get("tab_id") or ""))

        for tab in ws_tabs:
            tab_id = tab.get("tab_id")
            tab_panes = [p for p in ws_panes if p.get("tab_id") == tab_id]
            if not tab_panes:
                continue
            # The agents first; failing that, whichever pane the tab is on.
            chosen_panes = [p for p in tab_panes if p.get("pane_id") in by_pane]
            if not chosen_panes:
                chosen_panes = [next((p for p in tab_panes if p.get("focused")), tab_panes[0])]

            tree = ws.get("worktree") or {}
            for chosen in chosen_panes:
                pane_id = chosen.get("pane_id") or ""
                a = by_pane.get(pane_id, {})
                project, project_name = project_of(ws, chosen)
                rows.append({
                    "pane_id": pane_id,
                    "name": ws.get("label") or a.get("name") or pane_id,
                    "workspace_label": ws.get("label") or "",
                    "workspace_number": ws.get("number"),
                    # What the phone groups the flock by, and the heading it
                    # draws: the repository, so a workspace cut as a worktree
                    # sits under the project it came from.
                    "project": project,
                    "project_name": project_name,
                    # Whether the project heading can offer to cut another
                    # worktree, and which of its rows to cut from. A branch
                    # started from the project's own checkout starts where the
                    # project does; one started from a linked worktree starts
                    # on whatever that worktree was left sitting on, which is
                    # somebody else's half-finished work.
                    "repo": bool(tree.get("repo_root")),
                    "main_checkout": bool(tree.get("repo_root"))
                    and not tree.get("is_linked_worktree"),
                    "workspace_id": ws_id,
                    "tab_id": tab_id,
                    "tab_label": tab.get("label") or "",
                    "tab_number": tab.get("number"),
                    # A tab drawing more than one row is a split, and the rows
                    # need telling apart by something the tab cannot give them.
                    "split": len(chosen_panes) > 1,
                    "agent": a.get("agent"),
                    "status": a.get("agent_status", "unknown"),
                    "title": a.get("terminal_title_stripped") or a.get("terminal_title") or "",
                    "cwd": a.get("cwd") or chosen.get("cwd", ""),
                    "focused": ws.get("focused", False),
                    "has_agent": pane_id in by_pane,
                    # Monotonic; the client watches it to tell when a project
                    # last did something.
                    "state_change_seq": a.get("state_change_seq", 0),
                })
    name_agent_rows(rows)
    return rows


# A tab label Herdr has only numbered is not a name, and neither is the number
# on its own: "sheepit \u00b7 tab 2" says where to look, "sheepit \u00b7 2" reads
# like a count.
def tab_name(row: dict) -> str:
    label = (row.get("tab_label") or "").strip()
    plain = label[4:].strip() if label.lower().startswith("tab ") else label
    if label and not plain.isdigit():
        return label
    return f"tab {plain or row.get('tab_number') or '?'}"


def name_agent_rows(rows: list) -> None:
    """Give every row a name that means something on its own.

    The list on the phone draws a project once and its tabs underneath, so the
    row's `name` is the project's. Anything reading the rows flat - a
    notification naming what just finished, most of all - needs to tell two
    agents in the same project apart, and "sheepit, sheepit" tells nobody
    anything. So a project running more than one agent says which tab, and a
    split tab says which pane.
    """
    busy = {}
    for row in rows:
        if row.get("has_agent"):
            busy[row["workspace_id"]] = busy.get(row["workspace_id"], 0) + 1

    for row in rows:
        name = row["name"]
        if row.get("has_agent") and busy.get(row["workspace_id"], 0) > 1:
            name = f"{name} \u00b7 {tab_name(row)}"
            if row.get("split"):
                name = f"{name} \u00b7 {row['pane_id'].rsplit(':', 1)[-1]}"
        row["display_name"] = name


# The watcher sees the working -> stopped transition; the push that follows
# carries no payload, so what it saw is parked here for the service worker to
# come and read.
_LAST_FINISHED = {"at": 0.0, "agents": [], "title": None, "body": None}
_LAST_FINISHED_LOCK = threading.Lock()
_NOTIFICATION_INTERCEPTORS = []
_API_ROUTES = {"GET": {}, "POST": {}}


def register_api_route(method: str, path: str, handler) -> None:
    """Register a custom API route handler:
        handler(request_handler, params_or_body) -> None
    For GET: handler(self, qs: dict) -> None
    For POST: handler(self, body: dict) -> None
    """
    _API_ROUTES[method.upper()][path] = handler

def register_notification_interceptor(interceptor) -> None:
    """Register a callable:
        interceptor(pane_id: str, row: dict) -> tuple[bool, dict | None]
    Returns (should_notify, custom_metadata).
    If should_notify is False, the push is suppressed for this pane.
    If custom_metadata is returned (e.g. {"title": ..., "body": ...}), it enriches
    the parked notification.
    """
    _NOTIFICATION_INTERCEPTORS.append(interceptor)

# Initialize heartbeat routes and interceptor
heartbeat.init_heartbeat_routes(register_api_route, register_notification_interceptor)


def chat_dirs() -> list:
    """Where a chat may start: the root of every project the flock has -
    never a worktree, which comes and goes with its branch."""
    try:
        rows = agent_rows()
    except RuntimeError:
        return []
    seen = {}
    for row in rows:
        cwd = (row.get("project") or "").rstrip("/")
        if cwd.startswith("/") and cwd not in seen:
            seen[cwd] = {"cwd": cwd, "name": row.get("project_name") or cwd.rsplit("/", 1)[-1]}
    return sorted(seen.values(), key=lambda d: d["cwd"])


def chat_notify(title: str, body: str, url: str) -> None:
    """A chat finished or wants an answer: park it like a pane that stopped,
    with where the notification should open, and push."""
    record_finished([{"name": title, "title": body, "status": "done"}],
                    title=title, body=body, url=url)
    if push.load_subs():
        threading.Thread(target=push.broadcast, daemon=True).start()


chat.init_chat_routes(register_api_route, chat_dirs, chat_notify)
chat.register_kind("pane", panechat.get)


def filter_stopped_agents(stopped_panes: list, rows: dict) -> tuple[list, str | None, str | None]:
    """Pass stopped panes through registered interceptors.
    Returns (notify_rows, custom_title, custom_body).
    """
    notify_rows = []
    custom_title = None
    custom_body = None
    for pane_id in stopped_panes:
        row = rows.get(pane_id)
        if not row:
            continue
        suppress = False
        for interceptor in _NOTIFICATION_INTERCEPTORS:
            try:
                should_notify, meta = interceptor(pane_id, row)
                if not should_notify:
                    suppress = True
                    break
                if meta:
                    custom_title = meta.get("title") or custom_title
                    custom_body = meta.get("body") or custom_body
            except Exception as e:
                print(f"notification interceptor failed for {pane_id}: {e}", file=sys.stderr)
        if not suppress:
            notify_rows.append(row)
    return notify_rows, custom_title, custom_body


def record_finished(rows: list, title: str | None = None, body: str | None = None,
                    url: str | None = None) -> None:
    with _LAST_FINISHED_LOCK:
        _LAST_FINISHED["at"] = time.time()
        _LAST_FINISHED["title"] = title
        _LAST_FINISHED["body"] = body
        _LAST_FINISHED["url"] = url
        _LAST_FINISHED["agents"] = [
            {"pane_id": r.get("pane_id"),
             "name": r.get("display_name") or r.get("name"),
             "title": r.get("title", ""), "status": r.get("status")}
            for r in rows
        ]

# How long the parked transition is worth reading. The service worker applies
# the same rule, but the record should not outlive it here either: it names
# workspaces and terminal titles, and nothing else ages it out.
FINISHED_TTL = 120.0


def pane_cwd(pane_id: str) -> str:
    """Where a pane is working: the agent's foreground directory when it has
    one - an agent that has cd'd somewhere is working there - and the pane's
    own directory otherwise."""
    res = call_herdr_rpc("agent.list")
    for agent in res.get("result", {}).get("agents", []):
        if agent.get("pane_id") == pane_id:
            cwd = agent.get("foreground_cwd") or agent.get("cwd") or ""
            if cwd:
                return cwd
            break
    res = call_herdr_rpc("pane.list")
    for pane in res.get("result", {}).get("panes", []):
        if pane.get("pane_id") == pane_id:
            return pane.get("cwd") or ""
    return ""


def clamp_int(value, low: int, high: int, default: int) -> int:
    """A number the client sent, held inside what the server will act on. A
    value that is not a number at all is the default rather than an exception
    thrown out of a request handler."""
    try:
        number = int(value)
    except (TypeError, ValueError):
        return default
    return min(max(number, low), high)


# A label is typed on a phone and lands in the laptop's workspace strip, so it
# is trimmed and capped rather than passed on whole: a newline or a thousand
# characters would be the desktop's problem, not this one's.
MAX_LABEL = 80


def clean_label(value) -> str:
    """What the phone typed, fit to be a Herdr label - or "" if it is not one."""
    if not isinstance(value, str):
        return ""
    return " ".join(value.split())[:MAX_LABEL]


def last_finished() -> dict:
    with _LAST_FINISHED_LOCK:
        at = _LAST_FINISHED["at"]
        age = round(time.time() - at, 1) if at else None
        if age is not None and age > FINISHED_TTL:
            _LAST_FINISHED["at"] = 0.0
            _LAST_FINISHED["title"] = None
            _LAST_FINISHED["body"] = None
            _LAST_FINISHED["agents"] = []
            return {"at": 0.0, "age": None, "agents": []}
        res = {"at": at, "age": age, "agents": list(_LAST_FINISHED["agents"])}
        if _LAST_FINISHED.get("title"):
            res["title"] = _LAST_FINISHED["title"]
        if _LAST_FINISHED.get("body"):
            res["body"] = _LAST_FINISHED["body"]
        if _LAST_FINISHED.get("url"):
            res["url"] = _LAST_FINISHED["url"]
        return res


# ---------------------------------------------------------------- attachments
#
# A screenshot is the one thing a phone has that a laptop does not, and until
# now there was no way to hand one to an agent: Claude Code pastes images from
# the clipboard of the machine it runs on, which is not the machine you are
# holding, and the console forwards keystrokes rather than bytes.
#
# So the phone uploads the image and the gateway writes it down beside the
# work. The prompt then carries its path, which is a thing both agents already
# understand.

# What an agent can be handed, and what the file is called when it lands. The
# content type decides the extension - never the name the client sent, which is
# a string from a phone and belongs to nobody this server trusts.
ATTACH_TYPES = {
    "image/png": ".png",
    "image/jpeg": ".jpg",
    "image/webp": ".webp",
    "image/gif": ".gif",
    "image/heic": ".heic",
    "image/heif": ".heic",
}

# Three orders of magnitude above every other route, so it gets its own
# ceiling rather than lifting the one that keeps the rest small. The phone
# scales images down before sending; this is the room for one that arrives
# whole anyway.
MAX_ATTACHMENT = 16 * 1024 * 1024

# Images land in the directory the agent is already working in, because
# anywhere else costs a permission prompt per image on the desktop - and a
# question you have to answer before the agent may look at the screenshot you
# just sent is the whole problem again.
INBOX = ".sheepit"

# Long enough to still be there when you come back to the conversation, short
# enough that a project does not silently collect every screenshot ever sent.
INBOX_TTL = 7 * 86400


def _git_exclude_inbox(root: Path) -> None:
    """Keep the inbox out of the repository without touching a tracked file.

    `.git/info/exclude` is `.gitignore` for one clone only: nobody else gets it
    and it is never committed, which is exactly right for a directory this
    machine's phone writes into. `--git-path` is what finds it in a linked
    worktree, where `.git` is a file pointing elsewhere.
    """
    try:
        found = subprocess.run(
            ["git", "-C", str(root), "rev-parse", "--git-path", "info/exclude"],
            capture_output=True, text=True, timeout=5.0,
        )
        if found.returncode != 0:
            return  # not a repository; nothing to exclude it from
        exclude = Path(found.stdout.strip())
        if not exclude.is_absolute():
            exclude = root / exclude
        line = f"{INBOX}/"
        existing = exclude.read_text() if exclude.exists() else ""
        if line in existing.split():
            return
        exclude.parent.mkdir(parents=True, exist_ok=True)
        with exclude.open("a") as f:
            if existing and not existing.endswith("\n"):
                f.write("\n")
            f.write(f"# images sent from SheepIt\n{line}\n")
    except (OSError, subprocess.SubprocessError):
        pass  # an un-excluded image is untidy; a failed upload is broken


def _prune_inbox(inbox: Path) -> None:
    cutoff = time.time() - INBOX_TTL
    try:
        for old in inbox.iterdir():
            with contextlib.suppress(OSError):
                if old.is_file() and old.stat().st_mtime < cutoff:
                    old.unlink()
    except OSError:
        pass


def save_attachment(cwd: str, data: bytes, content_type: str) -> str:
    """Write an image beside the work and return the path to put in a prompt.

    The path comes back relative to the agent's own directory: shorter to read
    on a phone, and it is what the agent is already rooted at.
    """
    suffix = ATTACH_TYPES.get((content_type or "").split(";")[0].strip().lower())
    if not suffix:
        raise ValueError("that is not an image this can pass on")
    root = Path(cwd)
    if not root.is_dir():
        raise ValueError("the pane is not anywhere this can write to")
    inbox = root / INBOX
    inbox.mkdir(parents=True, exist_ok=True)
    _git_exclude_inbox(root)
    _prune_inbox(inbox)
    # Named for when it arrived, with enough randomness that two phones in the
    # same second do not land on one file.
    stamp = time.strftime("%Y%m%d-%H%M%S")
    name = f"{stamp}-{secrets.token_hex(2)}{suffix}"
    (inbox / name).write_bytes(data)
    return f"{INBOX}/{name}"


# A body large enough to be a mistake or a wedge. Every route here takes a
# handful of short fields.
MAX_BODY = 256 * 1024

# The page draws pane output through innerHTML in several places. Nothing
# here loads from anywhere else, so say so: a script tag that slips through
# the escaping then has nowhere to phone home to. Inline styles stay allowed -
# the transcript carries the terminal's own colours as style attributes.
CSP = "; ".join([
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    # blob: is the thumbnail of an image you just attached, drawn from the file
    # the phone already has rather than fetched back off the gateway.
    "img-src 'self' data: blob:",
    "connect-src 'self'",
    "media-src 'self'",
    "worker-src 'self'",
    "manifest-src 'self'",
    "frame-ancestors 'none'",
    "base-uri 'none'",
    "form-action 'none'",
])


class HerdrHandler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    # HTTP/1.1 means keep-alive, and without this a connection that goes quiet
    # holds one of the pool's threads for as long as it likes.
    timeout = 15
    # HEAD is GET without the body. Set per request, because one keep-alive
    # connection carries many and a HEAD must not silence the GET behind it.
    head_only = False

    def send_json(self, data: dict, status_code: int = 200):
        body = json.dumps(data).encode("utf-8")
        self.send_response(status_code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Cache-Control", "no-store, no-cache, must-revalidate")
        self.end_headers()
        if not self.head_only:
            self.wfile.write(body)

    def send_blob(self, data: bytes, content_type: str):
        """Bytes that are not JSON - an image out of the working tree.

        `nosniff` and a CSP of its own, because this is the one route that
        answers with a file somebody else wrote: whatever the type says it is
        is what the browser must treat it as, and nothing it contains runs.
        """
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Content-Security-Policy", "default-src 'none'; sandbox")
        # The working tree moves under it; a cached picture is the old one.
        self.send_header("Cache-Control", "no-store, no-cache, must-revalidate")
        self.end_headers()
        if not self.head_only:
            self.wfile.write(data)

    def same_origin(self) -> bool:
        """Is this request the app itself, rather than some other page?

        The gateway has no accounts and no tokens: what protects it is where
        it sits - loopback, behind `tailscale serve`. A wildcard CORS header
        gave that away, because any page in any tab could then read the
        scrollback and type into a pane. There is nothing to hand out to, so
        nothing is handed out: the PWA is served from this same origin.

        Requests with no Origin and no Sec-Fetch-Site are not from a page -
        curl, the menu bar app - and are left alone. Tailscale's proxy passes
        the browser's Host through untouched, so it is what an Origin has to
        agree with.
        """
        site = (self.headers.get("Sec-Fetch-Site") or "").lower()
        if site in ("cross-site", "same-site"):
            return False
        origin = self.headers.get("Origin")
        if not origin:
            return True
        hosts = set()
        for name in ("Host", "X-Forwarded-Host"):
            value = self.headers.get(name)
            if value:
                hosts.add(value.split(",")[0].strip().lower())
        return urlsplit(origin).netloc.lower() in hosts

    def guard_origin(self, path: str) -> bool:
        """Answer nothing but a refusal to a page on another site."""
        if not path.startswith("/api/") or self.same_origin():
            return True
        self.send_json({"ok": False, "error": "Cross-origin request refused"},
                       HTTPStatus.FORBIDDEN)
        return False

    def do_HEAD(self):
        # Mirror GET exactly - status, ETag and all - instead of answering 200
        # to every /api/ path whether it exists or not.
        self.do_GET()

    def herdr_protocol(self) -> int:
        """The wire protocol this Herdr speaks, asked fresh rather than cached:
        a live handoff can put a different build behind the socket."""
        res = call_herdr_rpc("ping")
        return res.get("result", {}).get("protocol")

    def serve_terminal_ws(self, pane_id: str, qs: dict):
        """Attach the phone to one pane's terminal for as long as it holds on.

        Nothing here is polled. Herdr streams the pane's own ANSI as it draws,
        and keystrokes go back down the same socket, so what the phone shows is
        the terminal rather than a reading of it.
        """
        # Browsers do not apply CORS to a WebSocket: without this, any page in
        # any tab could open one and type into a pane.
        if not self.same_origin():
            self.send_json({"ok": False, "error": "Cross-origin request refused"},
                           HTTPStatus.FORBIDDEN)
            return

        panes = call_herdr_rpc("pane.list").get("result", {}).get("panes", [])
        pane = next((p for p in panes if p.get("pane_id") == pane_id), None)
        terminal_id = (pane or {}).get("terminal_id")
        if not terminal_id:
            self.send_json({"ok": False, "error": "No terminal for that pane"},
                           HTTPStatus.NOT_FOUND)
            return

        protocol = self.herdr_protocol()
        # The handshake has to name a size, but it is only what this connection
        # would like; the pane keeps the size the desktop gave it until the
        # phone explicitly asks to change it, because the runtime is shared and
        # a resize here moves the window over there.
        cols = clamp_int(qs.get("cols", ["80"])[0], 20, 500, 80)
        rows = clamp_int(qs.get("rows", ["24"])[0], 5, 200, 24)

        try:
            ws = wsproto.WebSocket.accept(self)
        except (wsproto.WebSocketError, OSError):
            return

        stream = None
        try:
            def announce_size(width, height):
                # What the pane is actually drawn at, so the phone can show it
                # whole rather than guess and wrap.
                ws.send_text(json.dumps({"type": "size", "cols": width, "rows": height}))

            stream = TerminalStream(
                HERDR_CLIENT_SOCKET_PATH, protocol,
                on_data=ws.send_bytes, on_close=ws.close, on_size=announce_size)
            stream.connect(cols, rows)
            stream.attach(terminal_id)
        except (TerminalError, OSError, ValueError) as e:
            # The socket is already upgraded, so the failure has to travel as a
            # message rather than a status code.
            ws.send_text(json.dumps({"type": "error", "message": str(e)}))
            ws.close()
            if stream:
                stream.close()
            return

        try:
            while True:
                message = ws.recv()
                if message is None:
                    break
                opcode, payload = message
                if opcode == wsproto.OP_BINARY:
                    # Keystrokes travel as themselves: no framing, no encoding.
                    stream.input(payload)
                elif opcode == wsproto.OP_TEXT:
                    self.handle_terminal_control(stream, payload)
                if stream.closed:
                    break
        except (OSError, wsproto.WebSocketError):
            pass
        finally:
            stream.close()
            ws.close()

    @staticmethod
    def handle_terminal_control(stream, payload: bytes):
        """Everything that is not a keystroke: resize and scrollback."""
        try:
            msg = json.loads(payload.decode("utf-8"))
        except (ValueError, UnicodeDecodeError):
            return
        kind = msg.get("type")
        if kind == "resize":
            cols = clamp_int(msg.get("cols"), 20, 500, 80)
            rows = clamp_int(msg.get("rows"), 5, 200, 24)
            stream.resize(cols, rows)
        elif kind == "scroll":
            direction = "up" if msg.get("direction") == "up" else "down"
            stream.scroll(direction, clamp_int(msg.get("lines"), 1, 100, 3))

    def do_GET(self):
        self.head_only = self.command == "HEAD"
        parsed = urlparse(self.path)
        path = unquote(parsed.path)
        qs = parse_qs(parsed.query)

        # The console: an upgrade, so it never reaches the JSON routes below.
        if path.startswith("/ws/terminal/") and wsproto.is_websocket(self.headers):
            self.serve_terminal_ws(path[len("/ws/terminal/"):], qs)
            return

        if not self.guard_origin(path):
            return
        # Check registered custom API routes
        if path in _API_ROUTES["GET"]:
            _API_ROUTES["GET"][path](self, qs)
            return


        # API: List all active agents
        if path == "/api/agents":
            try:
                agents = agent_rows()
            except RuntimeError as e:
                self.send_json({"error": e.args[0]}, 500)
                return
            self.send_json({"ok": True, "agents": agents})
            return

        # API: Who stopped working most recently. A push carries no payload, so
        # the service worker asks this to name the agent in the notification.
        if path == "/api/push/last":
            self.send_json({"ok": True, **last_finished()})
            return

        # API: VAPID public key + whether this device is already subscribed
        if path == "/api/push/info":
            self.send_json({
                "ok": True,
                "public_key": push.public_key_b64(),
                "subscriptions": len(push.load_subs()),
            })
            return

        # API: usage windows. Free to ask - it is the same endpoint Claude Code
        # uses for its own limits and costs no tokens.
        if path == "/api/queue/quota":
            self.send_json({"ok": True, **quota_payload()})
            return

        # API: what has been spent, hour by hour, out of the agents' own logs.
        # The windows above say what is left; this says where it went.
        if path == "/api/usage":
            days = clamp_int(qs.get("days", [None])[0], 1, tokens.HORIZON_DAYS, 7)
            try:
                self.send_json(tokens.history(days))
            except OSError as e:
                # Reading somebody else's logs is allowed to fail - a home
                # directory that moved, a permission - without taking the page
                # that asked down with it.
                self.send_json({"ok": False, "error": str(e), "rows": []}, 200)
            return

        # API: queued prompts, for every chat or just one
        if path == "/api/queue":
            conn = sched_db.connect()
            try:
                prompts = [
                    vars(p) for p in sched_db.list_prompts(
                        conn, qs.get("pane_id", [None])[0], qs.get("state", [None])[0]
                    )
                ]
            finally:
                conn.close()
            self.send_json({"ok": True, "prompts": prompts})
            return

        # API: Path completion for a pane, rooted at its working directory
        # /api/agents/{pane_id}/files?q=<prefix>
        if path.startswith("/api/agents/") and path.endswith("/files"):
            parts = path.split("/")
            if len(parts) == 5:
                pane_id = unquote(parts[3])
                query = qs.get("q", [""])[0]

                cwd = pane_cwd(pane_id)
                if not cwd:
                    self.send_json({"ok": False, "error": "No cwd for pane"}, 404)
                    return

                self.send_json({"ok": True, "cwd": cwd, "entries": complete_path(cwd, query)})
                return

        # API: What the agent changed in its working tree
        # /api/agents/{pane_id}/changes
        if path.startswith("/api/agents/") and path.endswith("/changes"):
            parts = path.split("/")
            if len(parts) == 5:
                cwd = pane_cwd(unquote(parts[3]))
                if not cwd:
                    self.send_json({"ok": False, "error": "No cwd for pane"}, 404)
                    return
                try:
                    self.send_json({"ok": True, **gitdiff.changed_files(cwd)})
                except gitdiff.GitError as e:
                    self.send_json({"ok": False, "error": str(e)}, 500)
                return

        # API: One changed file, as a unified diff
        # /api/agents/{pane_id}/diff?path=...
        if path.startswith("/api/agents/") and path.endswith("/diff"):
            parts = path.split("/")
            if len(parts) == 5:
                cwd = pane_cwd(unquote(parts[3]))
                rel_path = qs.get("path", [""])[0]
                if not cwd:
                    self.send_json({"ok": False, "error": "No cwd for pane"}, 404)
                    return
                try:
                    self.send_json({"ok": True, **gitdiff.file_diff(cwd, rel_path)})
                except gitdiff.GitError as e:
                    self.send_json({"ok": False, "error": str(e)}, 400)
                return

        # API: One changed image, as the picture rather than as a patch
        # /api/agents/{pane_id}/image?path=...&side=work|head
        if path.startswith("/api/agents/") and path.endswith("/image"):
            parts = path.split("/")
            if len(parts) == 5:
                cwd = pane_cwd(unquote(parts[3]))
                rel_path = qs.get("path", [""])[0]
                side = qs.get("side", ["work"])[0]
                if not cwd:
                    self.send_json({"ok": False, "error": "No cwd for pane"}, 404)
                    return
                try:
                    data, mime = gitdiff.image_blob(cwd, rel_path, side)
                except gitdiff.GitError as e:
                    self.send_json({"ok": False, "error": str(e)}, 404)
                    return
                self.send_blob(data, mime)
                return

        # API: Get history / output for a specific agent pane
        # /api/agents/{pane_id}/history
        if path.startswith("/api/agents/") and path.endswith("/history"):
            parts = path.split("/")
            # ["", "api", "agents", "<pane_id>", "history"]
            if len(parts) == 5:
                pane_id = unquote(parts[3])
                # A wrong number is tolerated, so a value that is not a
                # number should not drop the connection either.
                lines = clamp_int(qs.get("lines", ["100"])[0], 10, 1000, 100)
                source = qs.get("source", ["recent_unwrapped"])[0]
                # "ansi" keeps the SGR sequences so the client can mirror the
                # terminal's own colours; "text" is the plain fallback.
                fmt = "ansi" if qs.get("format", ["text"])[0] == "ansi" else "text"

                read_params = {
                    "source": source,
                    "lines": lines,
                    "format": fmt,
                    "strip_ansi": fmt != "ansi",
                }

                res = call_herdr_rpc("agent.read", dict(read_params, target=pane_id))

                if "error" in res:
                    # fallback to pane.read if agent.read fails
                    res = call_herdr_rpc("pane.read", dict(read_params, pane_id=pane_id))

                if "error" in res:
                    self.send_json(res, 400)
                    return

                text = res.get("result", {}).get("read", {}).get("text", "")
                self.send_json({
                    "ok": True,
                    "pane_id": pane_id,
                    "source": source,
                    "text": text,
                })
                return

        # An unknown /api/ path is a mistake, not a deep link: without this it
        # falls through to the SPA and answers 200 with a page full of HTML,
        # which every caller then has to sniff for.
        if path.startswith("/api/"):
            self.send_json({"ok": False, "error": "Not Found"}, HTTPStatus.NOT_FOUND)
            return

        # Serve static frontend files
        self.serve_static(path, head_only=self.head_only)

    def handle_attach(self, pane_id: str) -> None:
        """Take an image from the phone and put it where the agent can read it."""
        try:
            length = int(self.headers.get("Content-Length", 0))
        except ValueError:
            length = -1
        if length <= 0:
            self.send_json({"ok": False, "error": "Nothing arrived"}, 400)
            return
        if length > MAX_ATTACHMENT:
            self.send_json({"ok": False, "error": "That image is too big to send"},
                           HTTPStatus.REQUEST_ENTITY_TOO_LARGE)
            return

        cwd = pane_cwd(pane_id)
        if not cwd:
            self.send_json({"ok": False, "error": "No such pane"}, 404)
            return

        data = self.rfile.read(length)
        if len(data) != length:
            self.send_json({"ok": False, "error": "The upload was cut short"}, 400)
            return
        try:
            rel = save_attachment(cwd, data, self.headers.get("Content-Type", ""))
        except ValueError as e:
            self.send_json({"ok": False, "error": str(e)}, 400)
            return
        except OSError as e:
            self.send_json({"ok": False, "error": f"Could not write it: {e}"}, 500)
            return
        self.send_json({"ok": True, "path": rel, "bytes": len(data)})

    def do_POST(self):
        parsed = urlparse(self.path)
        path = unquote(parsed.path)

        if not self.guard_origin(path):
            return

        # An image arrives as itself rather than as JSON, and it is far too big
        # for the ceiling the rest of these routes live under, so it is served
        # before the body is read as anything.
        # /api/agents/{pane_id}/attach
        if path.startswith("/api/agents/") and path.endswith("/attach"):
            parts = path.split("/")
            if len(parts) == 5:
                self.handle_attach(unquote(parts[3]))
                return
        if path == "/api/chat/upload":
            chat.handle_upload(self, parse_qs(parsed.query))
            return

        # Read JSON body. Content-Length is the client's claim about it, so it
        # is checked rather than believed: every route here takes a few short
        # fields, and reading whatever a header asks for is a way to be held.
        try:
            content_length = int(self.headers.get("Content-Length", 0))
        except ValueError:
            self.send_json({"ok": False, "error": "Invalid Content-Length"}, 400)
            return
        if content_length < 0 or content_length > MAX_BODY:
            self.send_json({"ok": False, "error": "Body too large"},
                           HTTPStatus.REQUEST_ENTITY_TOO_LARGE)
            return
        body_bytes = self.rfile.read(content_length) if content_length > 0 else b"{}"
        try:
            body = json.loads(body_bytes.decode("utf-8")) if body_bytes else {}
        except Exception:
            self.send_json({"ok": False, "error": "Invalid JSON"}, 400)
            return

        # Check registered custom API routes
        if path in _API_ROUTES["POST"]:
            _API_ROUTES["POST"][path](self, body)
            return

        # API: Register a Web Push subscription
        if path == "/api/push/subscribe":
            sub = body.get("subscription") or body
            try:
                count = push.add_sub(sub)
            except ValueError as e:
                self.send_json({"ok": False, "error": str(e)}, 400)
                return
            self.send_json({"ok": True, "count": count})
            return

        if path == "/api/push/unsubscribe":
            endpoint = body.get("endpoint", "")
            self.send_json({"ok": True, "count": push.remove_sub(endpoint)})
            return

        # API: Fire a push right now, to check the round trip from the phone
        if path == "/api/push/test":
            self.send_json({"ok": True, "sent": push.broadcast()})
            return

        # API: queue a prompt for a chat. The dispatcher delivers it as soon as
        # that pane is free and the subscription has room - which, for an idle
        # pane in an open window, is within the second.
        if path == "/api/queue":
            prompt = (body.get("prompt") or "").strip()
            pane_id = (body.get("pane_id") or "").strip()
            if not prompt:
                self.send_json({"ok": False, "error": "Empty prompt"}, 400)
                return
            if not pane_id:
                self.send_json({"ok": False, "error": "No chat given"}, 400)
                return

            pane = call_herdr_rpc("pane.get", {"pane_id": pane_id}).get("result", {}).get("pane")
            if not pane:
                self.send_json({"ok": False, "error": f"No such chat: {pane_id}"}, 404)
                return

            # A pane with no agent in it is a shell, and the queue has nothing
            # to deliver into: holding here waits on an agent that nothing will
            # ever start. So it goes to the terminal as typed input, which is
            # also what lets `claude` sent from the phone open the session.
            status = pane.get("agent_status")
            if not status or status == "unknown":
                res = call_herdr_rpc("pane.send_text", {"pane_id": pane_id, "text": prompt})
                if "error" not in res:
                    res = call_herdr_rpc(
                        "pane.send_keys", {"pane_id": pane_id, "keys": ["enter"]}
                    )
                if "error" in res:
                    self.send_json(res, 400)
                    return
                self.send_json({"ok": True, "delivered": "terminal"})
                return

            conn = sched_db.connect()
            try:
                prompt_id = sched_db.add(
                    conn,
                    pane_id=pane_id,
                    prompt=prompt,
                    # Recorded now so a prompt can outlive the pane it was
                    # queued for: this is what a reboot resumes from.
                    workspace_id=pane.get("workspace_id"),
                    session_uuid=(pane.get("agent_session") or {}).get("value"),
                    cwd=pane.get("cwd"),
                )
            finally:
                conn.close()
            if SCHEDULER is not None:
                SCHEDULER.wake()
            self.send_json({"ok": True, "id": prompt_id})
            return

        # API: act on a queued prompt. /api/queue/{id}/{delete|update}
        if path.startswith("/api/queue/"):
            parts = path.strip("/").split("/")
            # ["api", "queue", "<id>", "<action>"]
            if len(parts) == 4 and parts[2].isdigit():
                prompt_id, action = int(parts[2]), parts[3]
                conn = sched_db.connect()
                try:
                    queued = sched_db.get(conn, prompt_id)
                    if queued is None:
                        self.send_json({"ok": False, "error": "No such prompt"}, 404)
                        return
                    if action == "delete":
                        sched_db.delete(conn, prompt_id)
                    elif action == "update":
                        # Only while it is still ours. Once delivered it is part
                        # of a conversation, and editing the row would change
                        # what the queue claims was said.
                        if queued.state != "waiting":
                            self.send_json(
                                {"ok": False, "error": f"Already {queued.state}"}, 409
                            )
                            return
                        text = (body.get("prompt") or "").strip()
                        if not text:
                            self.send_json({"ok": False, "error": "Empty prompt"}, 400)
                            return
                        sched_db.update(conn, prompt_id, prompt=text)
                    elif action == "send":
                        if queued.state != "waiting":
                            self.send_json(
                                {"ok": False, "error": f"Already {queued.state}"}, 409
                            )
                            return
                        sent, why = send_now(queued)
                        if not sent:
                            self.send_json({"ok": False, "error": why}, 400)
                            return
                        sched_db.update(conn, prompt_id, state="sent",
                                        sent_at=sched_db.now(), last_error=None)
                    else:
                        self.send_json({"ok": False, "error": "Unknown action"}, 400)
                        return
                finally:
                    conn.close()
                self.send_json({"ok": True, "id": prompt_id, "action": action})
                return

        # API: Create a workspace
        if path == "/api/workspaces":
            res = call_herdr_rpc("workspace.create", {})
            if "error" in res:
                self.send_json(res, 400)
                return
            self.send_json({"ok": True, "result": res.get("result", {})})
            return

        # API: Cut another worktree off a project
        # One call does the whole thing - `git worktree add`, and a workspace
        # opened on the checkout - which is the same call the desktop makes
        # when you right-click a space. Naming a workspace rather than a path
        # is what makes this mean "another one of these": Herdr resolves it to
        # the repository, so any row under the project heading finds the repo
        # even when the row that was tapped is itself a worktree.
        if path == "/api/worktrees":
            params = {"focus": False}
            if workspace_id := (body.get("workspace_id") or "").strip():
                params["workspace_id"] = workspace_id
            elif cwd := (body.get("cwd") or "").strip():
                params["cwd"] = cwd
            else:
                self.send_json({"ok": False, "error": "No project to cut from"}, 400)
                return
            # Blank means Herdr picks, which it does by generating a name.
            if branch := (body.get("branch") or "").strip():
                params["branch"] = branch
            # A checkout is a copy of the tree on disk; a big repository takes
            # longer than the five seconds an RPC is normally given.
            res = call_herdr_rpc("worktree.create", params, timeout=120.0)
            if "error" in res:
                self.send_json(res, 400)
                return
            result = res.get("result", {})
            self.send_json({
                "ok": True,
                # What the phone opens next, without having to work out which
                # of the rows in the next poll was not there before.
                "workspace_id": (result.get("workspace") or {}).get("workspace_id", ""),
                "result": result,
            })
            return

        # API: Remove a worktree, checkout and all
        # /api/worktrees/{workspace_id}/remove
        #
        # Closing a workspace leaves the checkout on disk, which is right for a
        # project and wrong for a worktree: a branch that was finished with a
        # week ago is still a copy of the tree taking up room. This is the other
        # half - `git worktree remove` as well as the workspace.
        #
        # `force` is not passed unless it is asked for. Herdr refuses a checkout
        # with uncommitted work in it, and that refusal is the only thing
        # standing between a stray tap and an afternoon's work, so the phone has
        # to ask a second time before it is overridden.
        if path.startswith("/api/worktrees/") and path.endswith("/remove"):
            parts = path.split("/")
            if len(parts) == 5:
                workspace_id = unquote(parts[3])
                # Asked before the checkout goes, because afterwards there is
                # no workspace left to ask about - and the branch is what the
                # phone needs to offer next, since Herdr removes the checkout
                # and leaves the ref behind.
                left_behind = worktree_branch(workspace_id)
                params = {"workspace_id": workspace_id}
                if body.get("force"):
                    params["force"] = True
                res = call_herdr_rpc("worktree.remove", params, timeout=120.0)
                if "error" in res:
                    self.send_json(res, 400)
                    return
                self.send_json({
                    "ok": True,
                    "result": res.get("result", {}),
                    "branch": left_behind.get("branch", ""),
                    "repo_root": left_behind.get("repo_root", ""),
                })
                return

        # API: Delete a branch a removed worktree left behind
        # `-d` unless the phone has been told why it was refused and asked
        # again; the root is checked to be a working tree's top rather than
        # trusted, the same way a diff's path is.
        if path == "/api/branches/delete":
            root = (body.get("repo_root") or "").strip()
            branch = (body.get("branch") or "").strip()
            if not gitdiff.is_repo_root(root):
                self.send_json({"ok": False, "error": "Not a repository"}, 400)
                return
            try:
                gitdiff.delete_branch(root, branch, bool(body.get("force")))
            except gitdiff.GitError as e:
                self.send_json({"ok": False, "error": str(e)}, 400)
                return
            self.send_json({"ok": True, "branch": branch})
            return

        # API: Close a workspace
        # /api/workspaces/{workspace_id}/close
        if path.startswith("/api/workspaces/") and path.endswith("/close"):
            parts = path.split("/")
            if len(parts) == 5:
                res = call_herdr_rpc("workspace.close", {"workspace_id": unquote(parts[3])})
                if "error" in res:
                    self.send_json(res, 400)
                    return
                self.send_json({"ok": True})
                return

        # API: Rename a workspace, on the laptop as well as here
        # /api/workspaces/{workspace_id}/rename
        if path.startswith("/api/workspaces/") and path.endswith("/rename"):
            parts = path.split("/")
            if len(parts) == 5:
                label = clean_label(body.get("label"))
                if not label:
                    self.send_json({"ok": False, "error": "Empty label"}, 400)
                    return
                res = call_herdr_rpc("workspace.rename", {
                    "workspace_id": unquote(parts[3]),
                    "label": label,
                })
                if "error" in res:
                    self.send_json(res, 400)
                    return
                self.send_json({"ok": True, "label": label})
                return

        # API: Move a workspace to a new place in Herdr's own order
        # /api/workspaces/{workspace_id}/move
        if path.startswith("/api/workspaces/") and path.endswith("/move"):
            parts = path.split("/")
            if len(parts) == 5:
                index = body.get("insert_index")
                if not isinstance(index, int) or isinstance(index, bool) or index < 0:
                    self.send_json({"ok": False, "error": "insert_index must be a non-negative integer"}, 400)
                    return
                res = call_herdr_rpc("workspace.move", {
                    "workspace_id": unquote(parts[3]),
                    "insert_index": index,
                })
                if "error" in res:
                    self.send_json(res, 400)
                    return
                self.send_json({"ok": True})
                return

        # API: Rename a tab
        # /api/tabs/{tab_id}/rename
        if path.startswith("/api/tabs/") and path.endswith("/rename"):
            parts = path.split("/")
            if len(parts) == 5:
                label = clean_label(body.get("label"))
                if not label:
                    self.send_json({"ok": False, "error": "Empty label"}, 400)
                    return
                res = call_herdr_rpc("tab.rename", {
                    "tab_id": unquote(parts[3]),
                    "label": label,
                })
                if "error" in res:
                    self.send_json(res, 400)
                    return
                self.send_json({"ok": True, "label": label})
                return

        # API: Another tab in a workspace that is already open
        # /api/tabs   {"workspace_id": ..., "cwd": ...}
        #
        # A tab, not a workspace: the phone asks for this from inside a
        # worktree, and a second agent on the same branch belongs beside the
        # first rather than in a checkout of its own. `cwd` is the directory
        # the tab it was asked from is sitting in, so the new tab opens where
        # its neighbours are rather than wherever the workspace was created.
        if path == "/api/tabs":
            workspace_id = (body.get("workspace_id") or "").strip()
            if not workspace_id:
                self.send_json({"ok": False, "error": "No workspace to add a tab to"}, 400)
                return
            params = {"workspace_id": workspace_id, "focus": False}
            if cwd := (body.get("cwd") or "").strip():
                params["cwd"] = cwd
            res = call_herdr_rpc("tab.create", params)
            if "error" in res:
                self.send_json(res, 400)
                return
            result = res.get("result", {})
            self.send_json({
                "ok": True,
                # What the phone opens next, without waiting for a poll to
                # tell it which row is new.
                "pane_id": (result.get("root_pane") or {}).get("pane_id", ""),
                "tab_id": (result.get("tab") or {}).get("tab_id", ""),
            })
            return

        # API: Close one tab, leaving the workspace and its other tabs alone
        # /api/tabs/{tab_id}/close
        #
        # The counterpart to workspace.close, and the reason the overview lists
        # worktrees rather than tabs: closing a tab used to mean closing
        # everything the worktree was holding. Herdr takes the workspace with
        # the last tab in it, which is the one case where this does more than
        # it says - so the phone only offers it where there is another tab.
        if path.startswith("/api/tabs/") and path.endswith("/close"):
            parts = path.split("/")
            if len(parts) == 5:
                res = call_herdr_rpc("tab.close", {"tab_id": unquote(parts[3])})
                if "error" in res:
                    self.send_json(res, 400)
                    return
                self.send_json({"ok": True})
                return

        # Prompts do not have a direct route any more: everything the phone
        # sends goes through /api/queue, which is what lets a message typed at
        # 4am wait for the window instead of failing against an empty one.

        # API: Send keys (e.g. ctrl+c, esc, enter)
        # /api/agents/{pane_id}/keys
        if path.startswith("/api/agents/") and path.endswith("/keys"):
            parts = path.split("/")
            if len(parts) == 5:
                pane_id = unquote(parts[3])
                keys = body.get("keys")
                if not keys:
                    key = body.get("key")
                    keys = [key] if key else []

                if not keys:
                    self.send_json({"ok": False, "error": "Missing key(s)"}, 400)
                    return

                res = call_herdr_rpc("agent.send_keys", {
                    "target": pane_id,
                    "keys": keys,
                })

                if "error" in res:
                    res = call_herdr_rpc("pane.send_keys", {
                        "pane_id": pane_id,
                        "keys": keys,
                    })

                if "error" in res:
                    self.send_json(res, 400)
                    return

                self.send_json({"ok": True, "result": res.get("result")})
                return

        self.send_json({"error": "Not Found"}, 404)

    def serve_static(self, req_path: str, head_only: bool = False):
        if req_path == "/" or not req_path:
            rel_path = "index.html"
        else:
            rel_path = req_path.lstrip("/")

        target_file = (WEB_DIR / rel_path).resolve()

        # Prevent directory traversal. A string prefix is not a path boundary:
        # it also accepts the sibling "web-backup" next door.
        if not target_file.is_relative_to(WEB_DIR):
            self.send_error(HTTPStatus.FORBIDDEN, "Access denied")
            return

        if not target_file.is_file():
            # SPA fallback: if not an asset, serve index.html
            target_file = WEB_DIR / "index.html"
            if not target_file.is_file():
                self.send_error(HTTPStatus.NOT_FOUND, "File not found")
                return

        ctype, _ = mimetypes.guess_type(str(target_file))
        if not ctype:
            ctype = "application/octet-stream"

        try:
            with open(target_file, "rb") as f:
                content = f.read()

            # Without a validator, "no-cache" leaves iOS free to reuse a stale
            # copy, which strands home-screen installs on an old build. Serve a
            # strong ETag so revalidation is meaningful, and answer 304 to it.
            etag = '"%s"' % hashlib.sha1(content).hexdigest()[:16]
            if self.headers.get("If-None-Match") == etag:
                self.send_response(HTTPStatus.NOT_MODIFIED)
                self.send_header("ETag", etag)
                self.send_header("Cache-Control", "no-cache, must-revalidate")
                self.end_headers()
                return

            self.send_response(HTTPStatus.OK)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(content)))
            self.send_header("ETag", etag)
            self.send_header("Cache-Control", "no-cache, must-revalidate")
            self.send_header("X-Content-Type-Options", "nosniff")
            self.send_header("X-Frame-Options", "DENY")
            self.send_header("Content-Security-Policy", CSP)
            self.end_headers()
            if not head_only:
                self.wfile.write(content)
        except Exception as e:
            # The message is an absolute path more often than not.
            print(f"serving {rel_path} failed: {e}", file=sys.stderr)
            self.send_error(HTTPStatus.INTERNAL_SERVER_ERROR, "Could not read file")

    def log_message(self, format, *args):
        # Terse logging: suppress noisy polling logs
        msg = format % args
        if '"GET /api/' in msg and " 200 " in msg:
            return
        sys.stderr.write(f"[{self.log_date_time_string()}] {msg}\n")


class StatusWatcher(threading.Thread):
    """Notify when an agent stops and wants something - the transition that
    chimes on the desktop. Herdr's event stream is per-pane, so it would need
    constant re-subscription as panes come and go; polling one cheap RPC over a
    local UNIX socket is simpler and does not miss newly created panes."""

    INTERVAL = 3.0
    BUSY = {"working"}
    # Where an agent stops and cannot go on by itself: `done` is a turn that
    # ended and nobody has looked at it yet, `blocked` is a question on screen.
    # `idle` is neither - it is the prompt box, which Herdr also reports for a
    # pane you have already seen, one that was interrupted, and one nothing was
    # ever asked of. Notifying on that is what made the phone buzz for
    # everything.
    WANTS_A_PERSON = {"done", "blocked"}

    def __init__(self):
        super().__init__(daemon=True)
        # Panes that have been working since the last thing we said about them.
        self.busy_since_told = set()

    def run(self):
        # The first sweep only seeds: a restart must not fire for agents that
        # were already finished before we started watching.
        self.observe(self.snapshot(), tell=False)
        while True:
            time.sleep(self.INTERVAL)
            try:
                current = self.snapshot()
            except Exception:
                continue
            stopped = self.observe(current)
            if not stopped:
                continue
            # Name them before pushing: the notification wants to say which
            # agent stopped and what it wants, and only this side of the wire
            # knows. Interceptors may suppress clean runs or customize alerts.
            try:
                rows = {r.get("pane_id"): r for r in agent_rows()}
                notify_rows, custom_title, custom_body = filter_stopped_agents(stopped, rows)
                if not notify_rows:
                    continue
                record_finished(notify_rows, title=custom_title, body=custom_body)
            except Exception as e:
                print(f"naming finished agents failed: {e}", file=sys.stderr)
                continue
            if push.load_subs():
                try:
                    push.broadcast()
                except Exception as e:
                    print(f"push failed: {e}", file=sys.stderr)

    def observe(self, current: dict, tell: bool = True) -> list:
        """Which panes have just stopped in a state that wants a person.

        Two rules, and between them they are the whole thing:

        * The pane must have been working since the last time we said
          something about it. That is what makes one notification per piece of
          work rather than one per sweep - and it is what a phone buzzing
          every three seconds was missing.
        * It must have stopped somewhere a person is needed. `idle` is not
          that: a pane sitting at its prompt has either been seen already or
          never started, and Claude Code passes through it constantly - every
          `/clear`, every interrupt, every pane you opened and did not use.
        """
        stopped = []
        for pane, status in current.items():
            if status in self.BUSY:
                self.busy_since_told.add(pane)
                continue
            if status not in self.WANTS_A_PERSON:
                continue
            if pane not in self.busy_since_told:
                continue
            self.busy_since_told.discard(pane)
            if tell:
                stopped.append(pane)
        # A pane that is gone cannot be waiting on anybody.
        self.busy_since_told &= set(current)
        return stopped

    @staticmethod
    def snapshot() -> dict:
        res = call_herdr_rpc("agent.list")
        return {
            a.get("pane_id"): a.get("agent_status", "unknown")
            for a in res.get("result", {}).get("agents", [])
        }


# Codex only writes its usage down when the model answers, so a window that
# reset while nobody was working still reads as full on disk. What `/status`
# draws is fetched when it is asked for, so the pane is read first - and asked,
# when what we have has gone old and the pane is in a state where asking is
# free.
USAGE_PANE_LINES = 60
# How old a reading may get before a pane is asked for a fresh one.
USAGE_ASK_AFTER = 900.0
_ASKED = {}
_ASKED_LOCK = threading.Lock()

# What an empty composer looks like in the agents that have one. Anything else
# on that line is something somebody is in the middle of typing, and sending
# `/status` would submit it along with the command.
RE_COMPOSER = re.compile(r"^\s*[>›❯]\s*(.*)$")
PLACEHOLDERS = re.compile(
    r"^(?:ask (?:codex|claude) to do anything|try \".*\"|type .*|)$", re.IGNORECASE)


def pane_text(pane_id: str, lines: int = USAGE_PANE_LINES) -> str:
    res = call_herdr_rpc("pane.read", {
        "pane_id": pane_id, "lines": lines, "source": "recent_unwrapped",
    })
    read = res.get("result", {}).get("read") or {}
    return read.get("text") or ""


def composer_is_empty(text: str) -> bool:
    """Whether the pane's composer has nothing half-typed in it.

    Read from the bottom: the composer is the last prompt glyph on screen, and
    what follows it is either a placeholder the agent drew or a sentence
    somebody is still writing.
    """
    for line in reversed(strip_ansi(text).splitlines()):
        match = RE_COMPOSER.match(line)
        if match:
            return bool(PLACEHOLDERS.match(match.group(1).strip()))
    return False  # no composer found: assume something is in the way


RE_ANSI = re.compile(r"\x1b\[[0-9;?]*[a-zA-Z]")


def strip_ansi(text: str) -> str:
    return RE_ANSI.sub("", text or "")


def refresh_codex_usage() -> None:
    """Read Codex's own `/status` off the panes, and ask when it has gone old.

    Asking types a command into somebody's session, so it happens only when the
    pane is idle - not working, not stopped on a question - and its composer is
    empty. A half-written prompt on screen is a prompt that would be sent along
    with the command, so that pane is left alone and the older reading stands.
    """
    panes = [a for a in call_herdr_rpc("agent.list").get("result", {}).get("agents", [])
             if a.get("agent") == "codex"]
    for pane in panes:
        pane_id = pane.get("pane_id")
        if not pane_id:
            continue
        text = pane_text(pane_id)
        buckets = sched_quota.parse_codex_status(text)
        if buckets:
            sched_quota.note(sched_quota.Quota(
                buckets, sched_quota._now(), stale=True, agent="codex", source="pane"))
            continue

        noted = sched_quota.noted("codex")
        age = (sched_quota._now() - noted.fetched_at).total_seconds() if noted else None
        if age is not None and age < USAGE_ASK_AFTER:
            continue
        if pane.get("agent_status") != "idle" or not composer_is_empty(text):
            continue
        with _ASKED_LOCK:
            if time.monotonic() - _ASKED.get(pane_id, 0.0) < USAGE_ASK_AFTER:
                continue
            _ASKED[pane_id] = time.monotonic()
        call_herdr_rpc("agent.prompt", {"target": pane_id, "text": "/status"})
        return  # one pane is enough; the account is the same either way

_ANTIGRAVITY_REFRESH_AFTER = 900.0  # 15 minutes
_LAST_ANTIGRAVITY_REFRESH = 0.0
_ANTIGRAVITY_LOCK = threading.Lock()


def refresh_antigravity_usage() -> None:
    """Trigger background refresh of Google Antigravity usage if older than 15m."""
    global _LAST_ANTIGRAVITY_REFRESH
    now = time.monotonic()
    with _ANTIGRAVITY_LOCK:
        if now - _LAST_ANTIGRAVITY_REFRESH < _ANTIGRAVITY_REFRESH_AFTER:
            return
        _LAST_ANTIGRAVITY_REFRESH = now

    def _run():
        omp_bin = shutil.which("omp") or (Path.home() / ".local" / "bin" / "omp")
        if not omp_bin or not Path(omp_bin).exists():
            return
        try:
            subprocess.run([str(omp_bin), "usage", "-p", "google-antigravity"],
                           capture_output=True, timeout=10.0)
        except Exception:
            pass

    threading.Thread(target=_run, daemon=True).start()


def agents_running() -> list:
    """Which kinds of agent are on this machine right now.

    The strip has no business drawing a Codex window on a machine running none,
    and no way to know Codex is there except that an agent of that kind is in a
    pane. In the order they should be drawn: whatever Herdr lists, stably.
    """
    kinds = []
    for agent in call_herdr_rpc("agent.list").get("result", {}).get("agents", []):
        kind = agent.get("agent")
        if kind and kind not in kinds:
            kinds.append(kind)
    return sorted(kinds)


def agent_quota(agent: str) -> dict:
    """One agent's windows, shaped for the phone.

    `current` memoises the reading, which matters here: the phone polls this
    while the queue is open.
    """
    threshold = sched_config.load().threshold
    try:
        current = sched_quota.current(agent)
    except sched_quota.QuotaError as e:
        # Not knowing is its own state, and not a blocked one: nothing is held
        # back for an agent nobody can price.
        return {"agent": agent, "ok": False, "error": str(e), "buckets": [],
                "blocked": False}
    resume_at = current.resume_at()
    return {
        "agent": agent,
        "ok": True,
        "stale": current.stale,
        "reason": current.reason,
        # The bars still show the last reading, because it is the only one
        # there is. This is what says not to believe them.
        "expired": current.expired,
        # `api` was asked and told; `observed` is what the agent wrote down
        # itself, which is as fresh as its last turn.
        "source": current.source,
        # Spent, not merely full: a window with anything left in it is not a
        # reason to stop, and `threshold` only decides when the bar goes amber.
        "blocked": bool(current.spent()),
        "resume_at": resume_at.isoformat() if resume_at else None,
        "buckets": [
            {
                "name": b.name,
                "utilization": b.utilization,
                "resets_at": b.resets_at.isoformat() if b.resets_at else None,
                "locked_reason": b.locked_reason,
                "spent": b.is_spent(),
                "warning": not b.is_expired() and b.utilization >= threshold,
                # The window has since rolled over: the percentage describes a
                # window that is gone, so it is not worth drawing as usage.
                "expired": b.is_expired(),
            }
            for b in current.buckets
        ],
    }


def quota_payload() -> dict:
    """What every agent on this machine has left to spend."""
    agents = agents_running() or ["claude"]
    if "codex" in agents:
        try:
            refresh_codex_usage()
        except Exception as e:  # a usage reading is never worth a failed page
            log_usage_problem(e)
    if "omp" in agents or "agy" in agents:
        try:
            refresh_antigravity_usage()
        except Exception as e:
            log_usage_problem(e)
    readings = [agent_quota(agent) for agent in agents]
    return {
        "threshold": sched_config.load().threshold,
        "agents": readings,
        # What the machine itself has left, beside what the subscriptions have:
        # it rides on this poll rather than one of its own, because it is read
        # at the same moment, for the same glance.
        "machine": machine.snapshot(),
        # One line for the whole machine, for anything that wants a yes or no.
        "blocked": all(r["blocked"] for r in readings) if readings else False,
    }


def send_now(queued) -> tuple:
    """Hand a queued prompt over immediately, whatever the agent is doing.

    The queue's own timing is the polite version: wait for the turn in front to
    finish so the agent reads one thing at a time. This is the impolite one,
    for when you would rather the agent had it now - Claude Code and Codex both
    hold what arrives mid-turn and read it when they come up for air, which is
    the same thing the queue was arranging, minus the waiting.
    """
    res = call_herdr_rpc("agent.prompt", {"target": queued.pane_id, "text": queued.prompt})
    if "error" not in res:
        return True, ""
    # No agent in the pane: it is a shell, and what it wants is keystrokes.
    typed = call_herdr_rpc("pane.send_text",
                           {"pane_id": queued.pane_id, "text": queued.prompt})
    if "error" not in typed:
        call_herdr_rpc("pane.send_keys", {"pane_id": queued.pane_id, "keys": ["enter"]})
        return True, ""
    error = res.get("error") or {}
    return False, error.get("message") or str(error) or "could not send"


def log_usage_problem(err: Exception) -> None:
    print(f"[usage] could not refresh from a pane: {err}", file=sys.stderr)


def run():
    global SCHEDULER
    # The scheduler says what it is doing -- which pane it is holding, on which
    # window, until when -- entirely through `logging`, and without this none of
    # it goes anywhere. A queue that silently delivers nothing all night, with
    # not one line saying why, is most of what makes this hard to diagnose.
    logging.basicConfig(
        level=logging.INFO, stream=sys.stderr, format="%(name)s: %(message)s"
    )
    WEB_DIR.mkdir(parents=True, exist_ok=True)
    server_address = (HOST, PORT)
    httpd = ThreadingHTTPServer(server_address, HerdrHandler)
    StatusWatcher().start()
    # Config is re-read every pass, so editing scheduler.json takes effect
    # without a restart.
    SCHEDULER = Scheduler(sched_config.load)
    heartbeat.start_runner()
    SCHEDULER.start()
    print(f"SheepIt gateway listening on http://{HOST}:{PORT}")
    print(f"Herdr socket target: {HERDR_SOCKET_PATH}")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nShutting down server.")
        httpd.server_close()


if __name__ == "__main__":
    run()
