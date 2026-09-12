"""Herdr UNIX socket client, shared by the gateway and the scheduler.

`call_herdr_rpc` returns the raw envelope and never raises, which is what the
HTTP handlers want - they forward Herdr's own error straight to the client.
`Herdr` wraps it for the scheduler, where a failed call is an exception and the
caller only ever wants `result`.
"""

import json
import os
import socket
import time
from pathlib import Path


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


class HerdrError(RuntimeError):
    def __init__(self, code: str, message: str):
        super().__init__(f"{code}: {message}")
        self.code = code
        self.message = message


class Herdr:
    """Raising wrapper used by the scheduler."""

    def call(self, method: str, params: dict = None, timeout: float = 15.0) -> dict:
        resp = call_herdr_rpc(method, params, timeout)
        err = resp.get("error")
        if err:
            raise HerdrError(err.get("code", "unknown"), err.get("message", ""))
        return resp.get("result", {})

    # --- execution -----------------------------------------------------

    def worktree_create(self, cwd: str, branch: str, base: str = None, label: str = None) -> dict:
        """Create and open a worktree workspace.

        Returns `workspace`, `tab`, `root_pane` and `worktree`. The root pane is
        already at a shell prompt in the worktree, so no extra split is needed.
        """
        params = {"cwd": cwd, "branch": branch, "focus": False}
        if base:
            params["base"] = base
        if label:
            params["label"] = label
        return self.call("worktree.create", params, timeout=60.0)

    def worktree_remove(self, workspace_id: str, force: bool = False) -> dict:
        return self.call(
            "worktree.remove", {"workspace_id": workspace_id, "force": force}, timeout=60.0
        )

    def agent_start(self, name: str, pane_id: str, kind: str = "claude", args: list = None) -> str:
        """Launch an agent in a pane and return its ready status.

        `agent_not_ready` is tolerated: it means the agent is up but still
        drawing its startup UI, so we fall through to polling the pane rather
        than treating it as a failure.
        """
        params = {"name": name, "kind": kind, "pane_id": pane_id, "timeout_ms": 120_000}
        if args:
            params["args"] = args
        try:
            self.call("agent.start", params, timeout=140.0)
        except HerdrError as e:
            if e.code not in ("agent_not_ready", "agent_blocked"):
                raise
        return self.await_agent(pane_id)

    def agent_prompt(self, target: str, text: str, timeout_ms: int = None) -> dict:
        """Submit a prompt and wait for the agent to settle."""
        wait = {}
        if timeout_ms:
            wait["timeout_ms"] = timeout_ms
        budget = (timeout_ms / 1000 + 30) if timeout_ms else 3600.0
        return self.call(
            "agent.prompt", {"target": target, "text": text, "wait": wait}, timeout=budget
        )

    def agent_send_keys(self, target: str, keys: list) -> dict:
        return self.call("agent.send_keys", {"target": target, "keys": keys})

    def agent_list(self) -> list:
        return self.call("agent.list").get("agents", [])

    def pane_read(self, pane_id: str, lines: int = 80, source: str = "visible") -> str:
        """Read pane text.

        Two shape traps: the socket spells the source with an underscore
        (`recent_unwrapped`) where the CLI takes a hyphen, and the payload is
        nested under `read` rather than sitting on the result.
        """
        result = self.call(
            "pane.read",
            {"pane_id": pane_id, "source": source, "format": "text", "lines": lines},
        )
        return (result.get("read") or {}).get("text", "")

    def notify(self, title: str, body: str = None) -> None:
        try:
            self.call("notification.show", {"title": title, "body": body})
        except HerdrError:
            pass  # a missed toast must never fail a task

    # --- helpers -------------------------------------------------------

    def session_uuid(self, pane_id: str):
        """The Claude Code session UUID of the agent in a pane.

        This is what makes pause/resume work: `claude --resume <uuid>` picks the
        conversation back up after a usage window reset.

        Keyed on pane_id rather than agent name on purpose - herdr reports the
        auto-detected kind (`claude`) as the name unless an explicit one binds,
        so names are not reliably unique while pane IDs always are.
        """
        for agent in self.agent_list():
            if agent.get("pane_id") == pane_id:
                session = agent.get("agent_session") or {}
                if session.get("kind") == "id":
                    return session.get("value")
        return None

    def status(self, pane_id: str):
        """Agent lifecycle state for a pane, or None if no agent is present."""
        pane = self.call("pane.get", {"pane_id": pane_id}).get("pane", {})
        status = pane.get("agent_status")
        return None if status in (None, "unknown") else status

    def await_agent(self, pane_id: str, timeout: float = 120.0) -> str:
        """Poll until an agent in the pane has settled.

        `agent.start` reports `agent_not_ready` while an agent is still painting
        its startup UI even though it launched fine; the pane's own status is the
        more reliable readiness signal.

        `blocked` counts as settled. An agent stopped on a question is up and
        listening -- accepting only idle/done made a startup dialog
        indistinguishable from a dead pane, so it timed out after two minutes.
        """
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            status = self.status(pane_id)
            if status in ("idle", "done", "blocked"):
                return status
            time.sleep(2.0)
        raise HerdrError("agent_never_ready", f"no ready agent in {pane_id} after {timeout:.0f}s")
