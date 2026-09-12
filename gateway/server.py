#!/usr/bin/env python3
"""
SheepIt: the gateway between the phone and a local Herdr server.
Connects directly to the Herdr UNIX socket and serves a mobile-friendly PWA.
"""

import os
import sys
import time
import json
import socket
import hashlib
import threading
import mimetypes
from pathlib import Path
from urllib.parse import urlparse, urlsplit, parse_qs, unquote
from http import HTTPStatus
from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler

import push
import gitdiff
import wsproto
from terminal import TerminalStream, TerminalError


def default_socket_path() -> str:
    """Locate herdr.sock: explicit env, then the current user's config dir, then root's."""
    candidates = [
        Path.home() / ".config/herdr/herdr.sock",
        Path("/root/.config/herdr/herdr.sock"),
    ]
    for c in candidates:
        if c.exists():
            return str(c)
    return str(candidates[0])


HERDR_SOCKET_PATH = os.environ.get("HERDR_SOCKET") or default_socket_path()
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


def call_herdr_rpc(method: str, params: dict = None, timeout: float = 5.0) -> dict:
    """Send JSON-RPC request to Herdr UNIX domain socket and return response."""
    if not os.path.exists(HERDR_SOCKET_PATH):
        return {
            "id": "",
            "error": {
                "code": "socket_not_found",
                "message": f"Herdr socket not found at {HERDR_SOCKET_PATH}",
            },
        }

    s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    s.settimeout(timeout)
    try:
        s.connect(HERDR_SOCKET_PATH)
        req = {"id": "sheepit", "method": method, "params": params or {}}
        payload = json.dumps(req).encode("utf-8") + b"\n"
        s.sendall(payload)

        chunks = []
        while True:
            chunk = s.recv(16384)
            if not chunk:
                break
            chunks.append(chunk)
            if b"\n" in chunk:
                break

        raw_data = b"".join(chunks).decode("utf-8", errors="replace")
        line = raw_data.split("\n", 1)[0].strip()
        if not line:
            return {"id": "", "error": {"code": "empty_response", "message": "Empty response from Herdr"}}
        return json.loads(line)
    except socket.timeout:
        return {"id": "", "error": {"code": "timeout", "message": "Timeout communicating with Herdr"}}
    except Exception as e:
        return {"id": "", "error": {"code": "socket_error", "message": str(e)}}
    finally:
        s.close()




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
    """Every row the phone shows, in one call. Driven from workspaces, not
    agents: a freshly created workspace has no agent yet and would otherwise be
    invisible. Workspace labels are also what the desktop UI shows ("sheepit",
    "ib-orbit") - agent.list only carries ids."""
    res = call_herdr_rpc("agent.list")
    if "error" in res:
        raise RuntimeError(res["error"])
    agents_raw = res.get("result", {}).get("agents", [])
    ws_list = call_herdr_rpc("workspace.list").get("result", {}).get("workspaces", [])
    panes = call_herdr_rpc("pane.list").get("result", {}).get("panes", [])
    return build_agent_rows(ws_list, panes, agents_raw)


def build_agent_rows(ws_list: list, panes: list, agents_raw: list) -> list:
    """One row per pane running an agent, grouped under its workspace.

    A workspace can hold several agents at once; listing only the first hides
    the rest entirely. When a workspace has no agent running, it still gets a
    single row for its active tab's pane so it stays reachable - that is what
    makes a freshly created workspace visible.
    """
    by_pane = {a.get("pane_id"): a for a in agents_raw}
    rows = []

    for ws in ws_list:
        ws_id = ws.get("workspace_id")
        ws_panes = [p for p in panes if p.get("workspace_id") == ws_id]
        if not ws_panes:
            continue

        active_tab = ws.get("active_tab_id")
        chosen_panes = [p for p in ws_panes if p.get("pane_id") in by_pane]
        if not chosen_panes:
            chosen_panes = [
                next((p for p in ws_panes if p.get("tab_id") == active_tab), ws_panes[0])
            ]

        for chosen in chosen_panes:
            pane_id = chosen.get("pane_id") or ""
            a = by_pane.get(pane_id, {})
            label = ws.get("label") or ""
            # Disambiguate only when this workspace contributes several rows.
            if label and len(chosen_panes) > 1:
                label = f"{label} \u00b7{pane_id.rsplit(':p', 1)[-1]}"
            rows.append({
                "pane_id": pane_id,
                "name": label or a.get("name") or pane_id,
                "workspace_label": ws.get("label") or "",
                "workspace_number": ws.get("number"),
                "agent": a.get("agent"),
                "status": a.get("agent_status", "unknown"),
                "title": a.get("terminal_title_stripped") or a.get("terminal_title") or "",
                "cwd": a.get("cwd") or chosen.get("cwd", ""),
                "workspace_id": ws_id,
                "tab_id": chosen.get("tab_id"),
                "focused": ws.get("focused", False),
                "has_agent": pane_id in by_pane,
                # Monotonic; the client watches it to order projects by
                # whichever one last did something.
                "state_change_seq": a.get("state_change_seq", 0),
            })
    return rows


# The watcher sees the working -> stopped transition; the push that follows
# carries no payload, so what it saw is parked here for the service worker to
# come and read.
_LAST_FINISHED = {"at": 0.0, "agents": []}
_LAST_FINISHED_LOCK = threading.Lock()


def record_finished(rows: list) -> None:
    with _LAST_FINISHED_LOCK:
        _LAST_FINISHED["at"] = time.time()
        _LAST_FINISHED["agents"] = [
            {"pane_id": r.get("pane_id"), "name": r.get("name"),
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


def last_finished() -> dict:
    with _LAST_FINISHED_LOCK:
        at = _LAST_FINISHED["at"]
        age = round(time.time() - at, 1) if at else None
        if age is not None and age > FINISHED_TTL:
            _LAST_FINISHED["at"] = 0.0
            _LAST_FINISHED["agents"] = []
            return {"at": 0.0, "age": None, "agents": []}
        return {"at": at, "age": age, "agents": list(_LAST_FINISHED["agents"])}


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
    "img-src 'self' data:",
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

    def do_POST(self):
        parsed = urlparse(self.path)
        path = unquote(parsed.path)

        if not self.guard_origin(path):
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

        # API: Create a workspace
        if path == "/api/workspaces":
            res = call_herdr_rpc("workspace.create", {})
            if "error" in res:
                self.send_json(res, 400)
                return
            self.send_json({"ok": True, "result": res.get("result", {})})
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

        # API: Send prompt to agent
        # /api/agents/{pane_id}/prompt
        if path.startswith("/api/agents/") and path.endswith("/prompt"):
            parts = path.split("/")
            if len(parts) == 5:
                pane_id = unquote(parts[3])
                text = body.get("text", "").strip()
                if not text:
                    self.send_json({"ok": False, "error": "Empty prompt text"}, 400)
                    return

                # Send prompt to agent
                res = call_herdr_rpc("agent.prompt", {
                    "target": pane_id,
                    "text": text,
                })

                if "error" in res:
                    # If agent.prompt fails (e.g. agent not recognized or blocked), try pane.send_text
                    fallback_res = call_herdr_rpc("pane.send_text", {
                        "pane_id": pane_id,
                        "text": text + "\n",
                    })
                    if "error" in fallback_res:
                        self.send_json(res, 400)
                        return
                    self.send_json({"ok": True, "method": "pane.send_text"})
                    return

                self.send_json({"ok": True, "method": "agent.prompt", "result": res.get("result")})
                return

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
    """Notify when an agent stops working - the transition that chimes on the
    desktop. Herdr's event stream is per-pane, so it would need constant
    re-subscription as panes come and go; polling one cheap RPC over a local
    UNIX socket is simpler and does not miss newly created panes."""

    INTERVAL = 3.0
    BUSY = {"working"}

    def __init__(self):
        super().__init__(daemon=True)
        self.previous = {}

    def run(self):
        # Skip the first sweep so a restart does not fire for agents that
        # were already finished before we started watching.
        self.previous = self.snapshot()
        while True:
            time.sleep(self.INTERVAL)
            try:
                current = self.snapshot()
            except Exception:
                continue
            stopped = [
                pane
                for pane, status in current.items()
                if self.previous.get(pane) in self.BUSY and status not in self.BUSY
            ]
            if stopped:
                # Name them before pushing: the notification wants to say which
                # agent finished, and only this side of the wire knows.
                try:
                    rows = {r.get("pane_id"): r for r in agent_rows()}
                    record_finished([rows[p] for p in stopped if p in rows])
                except Exception as e:
                    print(f"naming finished agents failed: {e}", file=sys.stderr)
                if push.load_subs():
                    try:
                        push.broadcast()
                    except Exception as e:
                        print(f"push failed: {e}", file=sys.stderr)
            self.previous = current

    @staticmethod
    def snapshot() -> dict:
        res = call_herdr_rpc("agent.list")
        return {
            a.get("pane_id"): a.get("agent_status", "unknown")
            for a in res.get("result", {}).get("agents", [])
        }


def run():
    WEB_DIR.mkdir(parents=True, exist_ok=True)
    server_address = (HOST, PORT)
    httpd = ThreadingHTTPServer(server_address, HerdrHandler)
    StatusWatcher().start()
    print(f"SheepIt gateway listening on http://{HOST}:{PORT}")
    print(f"Herdr socket target: {HERDR_SOCKET_PATH}")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nShutting down server.")
        httpd.server_close()


if __name__ == "__main__":
    run()
