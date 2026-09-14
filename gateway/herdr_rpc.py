"""Herdr UNIX socket client, shared by the gateway and the scheduler.

`call_herdr_rpc` returns the raw envelope and never raises, which is what the
HTTP handlers want - they forward Herdr's own error straight to the client.
`Herdr` wraps it for the scheduler, where a failed call is an exception and the
caller only ever wants `result`.
"""

# The gateway runs on whatever python3 the machine has - the menubar app
# launches it with the one Xcode ships, which is 3.9 - so annotations are
# strings here rather than types the interpreter has to understand.
from __future__ import annotations

import json
import os
import select
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

    def agent_prompt(self, target: str, text: str) -> dict:
        """Hand a prompt to an agent and return immediately.

        Deliberately not `--wait`: the dispatcher learns what happened next from
        the event stream, so blocking here for the length of a turn would only
        tie up the loop that every other pane's queue is waiting on.
        """
        return self.call("agent.prompt", {"target": target, "text": text})

    def agent_send_keys(self, target: str, keys: list) -> dict:
        return self.call("agent.send_keys", {"target": target, "keys": keys})

    def send_line(self, pane_id: str, text: str) -> None:
        """Type text into a pane and press enter.

        For a pane with no agent in it, which is a shell: what you send goes to
        whatever is sitting there instead of waiting on an agent that is never
        going to appear. It is also how `claude` typed from the phone starts the
        session everything after it is delivered into.
        """
        self.call("pane.send_text", {"pane_id": pane_id, "text": text})
        self.call("pane.send_keys", {"pane_id": pane_id, "keys": ["enter"]})

    def agent_list(self) -> list:
        return self.call("agent.list").get("agents", [])

    def pane_read(self, pane_id: str, lines: int = 60,
                  source: str = "recent_unwrapped") -> str:
        """Recent output from a pane, as plain text.

        Two traps here, both found the hard way, and both of which fail by
        quietly returning nothing rather than by raising:

        - The socket spells the source `recent_unwrapped`. The CLI takes the
          hyphenated `recent-unwrapped`, and the socket does not accept it.
        - The payload is nested under `read`. Reading `result["text"]` directly
          returns empty every single time, which silently disables whatever was
          searching the output and looks exactly like a pane with nothing in it.
        """
        result = self.call("pane.read", {
            "pane_id": pane_id,
            "source": source,
            "lines": lines,
            "strip_ansi": True,
        })
        return (result.get("read") or {}).get("text", "")

    def notify(self, title: str, body: str = None) -> None:
        try:
            self.call("notification.show", {"title": title, "body": body})
        except HerdrError:
            pass  # a missed toast must never fail a delivery

    def report_queued(self, pane_id: str, count: int) -> None:
        """Show the queue depth on the pane itself.

        Automatic is not the same as invisible: this is what puts a badge on the
        pane in Herdr's own UI, so work waiting on a window is visible from the
        desktop without the phone. A null token value clears it.
        """
        try:
            self.call(
                "pane.report_metadata",
                {
                    "pane_id": pane_id,
                    "source": "sheepit",
                    "tokens": {"queued": str(count) if count else None},
                },
            )
        except HerdrError:
            pass  # a missing badge must never fail a delivery

    def open_pane(self, cwd: str, workspace_id: str = None, label: str = None) -> str:
        """Somewhere to put a conversation back, as close to home as possible.

        A new tab beside its old neighbours when the workspace survived; a new
        workspace when it did not. Closing the last pane in a workspace takes
        the workspace with it, so after a reboot the second path is the only
        one left -- which is why `cwd` matters more than `workspace_id` here.
        """
        if workspace_id:
            try:
                result = self.call(
                    "tab.create",
                    {"workspace_id": workspace_id, "cwd": cwd, "focus": False, "label": label},
                )
                if pane_id := (result.get("root_pane") or {}).get("pane_id"):
                    return pane_id
            except HerdrError:
                pass

        result = self.call("workspace.create", {"cwd": cwd, "focus": False, "label": label})
        pane_id = (result.get("root_pane") or {}).get("pane_id")
        if not pane_id:
            raise HerdrError("no_pane", "nowhere to put the resumed session")
        return pane_id

    # --- helpers -------------------------------------------------------

    def agents_by_pane(self) -> dict:
        """Every pane with an agent in it, keyed by pane id.

        One call answers both things the dispatcher wants to know about a pane
        it has no queue for: that there is a conversation in it at all, and --
        from `workspace_id`, `cwd` and `agent_session` -- everything needed to
        put that conversation back if the pane does not survive the night.
        """
        return {a["pane_id"]: a for a in self.agent_list() if a.get("pane_id")}

    def session_uuid(self, pane_id: str):
        """The Claude Code session UUID of the agent in a pane.

        This is what makes pause/resume work: `claude --resume <uuid>` picks the
        conversation back up after a usage window reset.

        Keyed on pane_id rather than agent name on purpose - herdr reports the
        auto-detected kind (`claude`) as the name unless an explicit one binds,
        so names are not reliably unique while pane IDs always are.
        """
        session = (self.agents_by_pane().get(pane_id) or {}).get("agent_session") or {}
        return session.get("value") if session.get("kind") == "id" else None

    def agent_kind(self, pane_id: str) -> str | None:
        """Which agent is in a pane - "claude", "codex" - or None for a shell.

        Which one it is decides whose usage window the pane spends, so the
        queue has to ask before it can price a delivery.
        """
        try:
            pane = self.call("pane.get", {"pane_id": pane_id}).get("pane", {})
        except HerdrError:
            return None
        return pane.get("agent") or None

    def status(self, pane_id: str) -> str:
        """What is in a pane: an agent's lifecycle state, or why there isn't one.

        `gone` and `no-agent` are kept apart because they need opposite
        recoveries: a pane that no longer exists has to be split fresh, while
        one whose agent exited can be relaunched where it stands.
        """
        try:
            pane = self.call("pane.get", {"pane_id": pane_id}).get("pane", {})
        except HerdrError:
            return "gone"
        status = pane.get("agent_status")
        return status if status and status != "unknown" else "no-agent"

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
            if (status := self.status(pane_id)) in ("idle", "done", "blocked"):
                return status
            time.sleep(2.0)
        raise HerdrError("agent_never_ready", f"no ready agent in {pane_id} after {timeout:.0f}s")


class Events:
    """A live subscription to Herdr's event stream.

    Herdr keeps the connection open after `events.subscribe` and writes one JSON
    line per event: `{"data": {...}, "event": "pane.output_matched"}`.

    Pane subscriptions are per-pane and fixed at subscribe time, so the set has
    to be re-sent whenever the panes we care about change; there is no way to
    amend a live subscription, so the connection is replaced instead.

    Events are a latency optimisation, never a source of truth. Every caller
    here re-reads state after being woken, so a stream that drops silently costs
    responsiveness and nothing else.
    """

    def __init__(self, socket_path: str = None):
        self._path = socket_path or HERDR_SOCKET_PATH
        self._sock = None
        self._buf = b""
        self._key = None
        self.started_at = 0.0
        # Queueing a prompt is not something Herdr knows about, so it produces
        # no event to wake us. This pipe is how the HTTP side says "look now"
        # instead of a prompt typed into an idle chat waiting out a poll.
        self._wake_r, self._wake_w = os.pipe()
        os.set_blocking(self._wake_r, False)
        os.set_blocking(self._wake_w, False)

    @property
    def connected(self) -> bool:
        return self._sock is not None

    def close(self) -> None:
        if self._sock is not None:
            try:
                self._sock.close()
            except OSError:
                pass
        self._sock = None
        self._buf = b""
        self._key = None

    def ensure(self, subscriptions: list) -> None:
        """Subscribe to exactly `subscriptions`, reconnecting if they changed."""
        key = json.dumps(subscriptions, sort_keys=True)
        if self._sock is not None and key == self._key:
            return
        self.close()
        if not subscriptions:
            return
        sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        sock.settimeout(5.0)
        try:
            sock.connect(self._path)
            req = {"id": "sheepit-events", "method": "events.subscribe",
                   "params": {"subscriptions": subscriptions}}
            sock.sendall(json.dumps(req).encode("utf-8") + b"\n")
        except OSError as e:
            sock.close()
            raise HerdrError("subscribe_failed", str(e))
        self._sock = sock
        self._key = key
        self.started_at = time.monotonic()

    def wake(self) -> None:
        """Cut short whatever `poll` is waiting for. Safe from any thread."""
        try:
            os.write(self._wake_w, b"\x01")
        except BlockingIOError:
            pass  # a pipe already full of wakeups is still a wakeup

    def poll(self, timeout: float) -> list:
        """Events arriving within `timeout` seconds; returns as soon as any do.

        With no subscription this waits on the wake pipe alone, which keeps the
        caller's loop identical whether or not Herdr is reachable.
        """
        deadline = time.monotonic() + timeout
        events = []
        while (remaining := deadline - time.monotonic()) > 0:
            sources = [self._wake_r] + ([self._sock] if self._sock is not None else [])
            ready, _, _ = select.select(sources, [], [], remaining)
            if not ready:
                break
            if self._wake_r in ready:
                try:
                    os.read(self._wake_r, 4096)
                except BlockingIOError:
                    pass
                break
            try:
                chunk = self._sock.recv(65536)
            except OSError:
                chunk = b""
            if not chunk:  # server closed the stream
                self.close()
                break
            self._buf += chunk
            while b"\n" in self._buf:
                line, _, self._buf = self._buf.partition(b"\n")
                try:
                    msg = json.loads(line)
                except ValueError:
                    continue
                # The subscribe acknowledgement, and any error, are replies
                # rather than events; a failed subscribe leaves us polling.
                if "result" in msg or "error" in msg:
                    continue
                events.append(msg)
            if events:
                break
        return events
