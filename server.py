#!/usr/bin/env python3
"""
herdr-mobile: Minimal mobile gateway & web server for Herdr.
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
from urllib.parse import urlparse, parse_qs, unquote
from http import HTTPStatus
from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler

import push


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
HOST = os.environ.get("HOST", "127.0.0.1")
PORT = int(os.environ.get("PORT", "3009"))
STATIC_DIR = Path(__file__).resolve().parent / "static"


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
        req = {"id": "herdr-mobile", "method": method, "params": params or {}}
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
            })
    return rows


class HerdrHandler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def send_json(self, data: dict, status_code: int = 200):
        body = json.dumps(data).encode("utf-8")
        self.send_response(status_code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS, HEAD")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Cache-Control", "no-store, no-cache, must-revalidate")
        self.end_headers()
        self.wfile.write(body)
    def do_HEAD(self):
        parsed = urlparse(self.path)
        path = parsed.path
        if path.startswith("/api/"):
            self.send_response(HTTPStatus.OK)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Cache-Control", "no-store, no-cache, must-revalidate")
            self.end_headers()
            return
        self.serve_static(path, head_only=True)


    def do_OPTIONS(self):
        self.send_response(HTTPStatus.NO_CONTENT)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.end_headers()

    def do_GET(self):
        parsed = urlparse(self.path)
        path = unquote(parsed.path)
        qs = parse_qs(parsed.query)

        # API: List all active agents
        if path == "/api/agents":
            res = call_herdr_rpc("agent.list")
            if "error" in res:
                self.send_json(res, 500)
                return

            agents_raw = res.get("result", {}).get("agents", [])

            # Drive the list from workspaces, not agents: a freshly created
            # workspace has no agent yet and would otherwise be invisible.
            # Workspace labels are also what the desktop UI shows
            # ("herdr-mobile", "ib-orbit") - agent.list only carries ids.
            ws_list = call_herdr_rpc("workspace.list").get("result", {}).get("workspaces", [])
            panes = call_herdr_rpc("pane.list").get("result", {}).get("panes", [])

            agents = build_agent_rows(ws_list, panes, agents_raw)
            self.send_json({"ok": True, "agents": agents})
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

                cwd = ""
                res = call_herdr_rpc("agent.list")
                for a in res.get("result", {}).get("agents", []):
                    if a.get("pane_id") == pane_id:
                        cwd = a.get("foreground_cwd") or a.get("cwd") or ""
                        break
                if not cwd:
                    res = call_herdr_rpc("pane.list")
                    for pane in res.get("result", {}).get("panes", []):
                        if pane.get("pane_id") == pane_id:
                            cwd = pane.get("cwd") or ""
                            break
                if not cwd:
                    self.send_json({"ok": False, "error": "No cwd for pane"}, 404)
                    return

                self.send_json({"ok": True, "cwd": cwd, "entries": complete_path(cwd, query)})
                return

        # API: Get history / output for a specific agent pane
        # /api/agents/{pane_id}/history
        if path.startswith("/api/agents/") and path.endswith("/history"):
            parts = path.split("/")
            # ["", "api", "agents", "<pane_id>", "history"]
            if len(parts) == 5:
                pane_id = unquote(parts[3])
                lines = int(qs.get("lines", ["100"])[0])
                lines = min(max(lines, 10), 1000)
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

        # Serve static frontend files
        self.serve_static(path)

    def do_POST(self):
        parsed = urlparse(self.path)
        path = unquote(parsed.path)

        # Read JSON body
        content_length = int(self.headers.get("Content-Length", 0))
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

        target_file = (STATIC_DIR / rel_path).resolve()

        # Prevent directory traversal
        if not str(target_file).startswith(str(STATIC_DIR)):
            self.send_error(HTTPStatus.FORBIDDEN, "Access denied")
            return

        if not target_file.is_file():
            # SPA fallback: if not an asset, serve index.html
            target_file = STATIC_DIR / "index.html"
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
            self.end_headers()
            if not head_only:
                self.wfile.write(content)
        except Exception as e:
            self.send_error(HTTPStatus.INTERNAL_SERVER_ERROR, str(e))

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
            if any(
                pane in self.previous
                and self.previous[pane] in self.BUSY
                and status not in self.BUSY
                for pane, status in current.items()
            ) and push.load_subs():
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
    STATIC_DIR.mkdir(parents=True, exist_ok=True)
    server_address = (HOST, PORT)
    httpd = ThreadingHTTPServer(server_address, HerdrHandler)
    StatusWatcher().start()
    print(f"herdr-mobile listening on http://{HOST}:{PORT}")
    print(f"Herdr socket target: {HERDR_SOCKET_PATH}")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nShutting down server.")
        httpd.server_close()


if __name__ == "__main__":
    run()
