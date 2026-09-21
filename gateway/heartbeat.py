"""Heartbeat runner and conditional notification for SheepIt.

Periodically runs health/status checks (e.g. /live-web-stats-check) in an agent
session. If the agent finishes with the OK sentinel (default HEARTBEAT_OK), the
push notification is suppressed (silence is golden). If an anomaly or issue is
reported, an alert push notification is sent to the phone.
"""

from __future__ import annotations

import json
import logging
import os
import re
import threading
import time
from dataclasses import asdict, dataclass, field
from pathlib import Path

from herdr_rpc import Herdr, HerdrError, call_herdr_rpc

log = logging.getLogger("heartbeat")

STATE_DIR = Path(os.environ.get("SHEEPIT_STATE_DIR") or Path.home() / ".config/sheepit")
CONFIG_PATH = STATE_DIR / "heartbeat.json"

DEFAULT_PROMPT = (
    "Run /live-web-stats-check.\n\n"
    "Evaluate the findings:\n"
    "- If all checks pass (no unresolved critical Sentry crashes, GA4 tracking operational, endpoints 200), output ONLY:\n"
    "  HEARTBEAT_OK\n\n"
    "- If anything anomalous, critical, or broken turns up:\n"
    "  Provide a concise summary of the issue, affected URL/file, and root cause."
)

DEFAULT_SENTINEL = "HEARTBEAT_OK"


@dataclass
class HeartbeatConfig:
    enabled: bool = False
    interval_hours: float = 24.0
    target_pane: str = ""
    target_workspace: str = ""
    prompt: str = DEFAULT_PROMPT
    ok_sentinel: str = DEFAULT_SENTINEL
    last_run_at: float | None = None
    last_status: str | None = None  # "ok", "alert", "error"
    last_summary: str | None = None

    def to_dict(self) -> dict:
        return asdict(self)

    def save(self, path: Path | None = None) -> None:
        path = path or CONFIG_PATH
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(self.to_dict(), indent=2) + "\n")

    @classmethod
    def load(cls, path: Path | None = None) -> HeartbeatConfig:
        path = path or CONFIG_PATH
        try:
            raw = json.loads(path.read_text())
        except (FileNotFoundError, json.JSONDecodeError):
            return cls()
        known = {f.name for f in cls.__dataclass_fields__.values()}
        return cls(**{k: v for k, v in raw.items() if k in known})


# In-memory tracking of active heartbeat turns: pane_id -> {started_at, sentinel}
_ACTIVE_HEARTBEATS: dict[str, dict] = {}
_ACTIVE_LOCK = threading.Lock()


def mark_heartbeat_started(pane_id: str, sentinel: str) -> None:
    with _ACTIVE_LOCK:
        _ACTIVE_HEARTBEATS[pane_id] = {
            "started_at": time.time(),
            "sentinel": sentinel,
        }


def pop_heartbeat(pane_id: str) -> dict | None:
    with _ACTIVE_LOCK:
        return _ACTIVE_HEARTBEATS.pop(pane_id, None)


def is_heartbeat_active(pane_id: str) -> bool:
    with _ACTIVE_LOCK:
        return pane_id in _ACTIVE_HEARTBEATS


def extract_summary(text: str, max_length: int = 140) -> str:
    """Extract a concise alert summary from pane output."""
    lines = [line.strip() for line in text.splitlines() if line.strip()]
    # Filter out common agent banner / prompt noise
    meaningful = []
    for line in lines:
        if line.startswith(("> ", "❯ ", "$ ", "#", "╭", "╰", "│")):
            continue
        meaningful.append(line)
    if not meaningful:
        return "Anomalies detected in heartbeat check"
    # Take the first 1-2 sentences or up to max_length
    summary = " ".join(meaningful[:3])
    if len(summary) > max_length:
        summary = summary[: max_length - 1].rstrip() + "…"
    return summary


def heartbeat_notification_interceptor(pane_id: str, row: dict) -> tuple[bool, dict | None]:
    """Intercept stopped panes to suppress clean heartbeats or format alerts."""
    info = pop_heartbeat(pane_id)
    if not info:
        # Not a tracked heartbeat turn, let default notification policy proceed
        return True, None

    sentinel = info.get("sentinel", DEFAULT_SENTINEL)
    herdr = Herdr()
    try:
        output = herdr.pane_read(pane_id, lines=40)
    except Exception as e:
        log.warning("could not read pane %s for heartbeat: %s", pane_id, e)
        output = ""

    cfg = HeartbeatConfig.load()
    status = row.get("status")

    # If the output ends with or clearly contains the OK sentinel, and is done:
    if sentinel in output and status != "blocked":
        cfg.last_status = "ok"
        cfg.last_summary = f"All checks passed ({sentinel})"
        cfg.save()
        log.info("heartbeat on pane %s finished clean (%s); suppressing push", pane_id, sentinel)
        # Suppress push notification!
        return False, None

    # Anomaly, failure, or blocked on a question
    summary = extract_summary(output)
    cfg.last_status = "alert"
    cfg.last_summary = summary
    cfg.save()

    display_name = row.get("display_name") or row.get("name") or "Agent"
    alert_title = f"Heartbeat Alert: {display_name}"
    log.warning("heartbeat alert on pane %s: %s", pane_id, summary)

    return True, {
        "title": alert_title,
        "body": summary,
    }


def find_target_pane(cfg: HeartbeatConfig) -> str | None:
    """Resolve a target pane to run the heartbeat in."""
    herdr = Herdr()
    try:
        agents = herdr.agent_list()
    except Exception as e:
        log.warning("failed to list agents: %s", e)
        return None

    if not agents:
        return None

    # 1. Explicit pane_id if active
    if cfg.target_pane:
        for a in agents:
            if a.get("pane_id") == cfg.target_pane:
                return cfg.target_pane

    # 2. Match target workspace if specified
    if cfg.target_workspace:
        for a in agents:
            if a.get("workspace_id") == cfg.target_workspace:
                return a.get("pane_id")

    # 3. Default to first idle or done agent
    for a in agents:
        if a.get("agent_status") in ("idle", "done"):
            return a.get("pane_id")

    # Fallback to any agent pane
    return agents[0].get("pane_id")


def trigger_heartbeat(cfg: HeartbeatConfig | None = None) -> dict:
    """Trigger a heartbeat check immediately."""
    cfg = cfg or HeartbeatConfig.load()
    pane_id = find_target_pane(cfg)
    if not pane_id:
        return {"ok": False, "error": "No suitable agent pane found to run heartbeat"}

    prompt = (cfg.prompt or DEFAULT_PROMPT).strip()
    sentinel = (cfg.ok_sentinel or DEFAULT_SENTINEL).strip()

    herdr = Herdr()
    try:
        # Mark active before prompting so the interceptor catches it
        mark_heartbeat_started(pane_id, sentinel)
        herdr.agent_prompt(pane_id, prompt)
    except HerdrError as e:
        pop_heartbeat(pane_id)
        return {"ok": False, "error": f"Failed to send prompt to {pane_id}: {e}"}

    cfg.last_run_at = time.time()
    cfg.last_status = "running"
    cfg.last_summary = "Check in progress…"
    cfg.save()

    return {
        "ok": True,
        "pane_id": pane_id,
        "sentinel": sentinel,
        "prompt": prompt,
    }


class HeartbeatRunner(threading.Thread):
    """Background daemon checking if a scheduled heartbeat should run."""

    def __init__(self, check_interval_sec: int = 60):
        super().__init__(daemon=True, name="heartbeat-runner")
        self.check_interval_sec = check_interval_sec
        self.running = True

    def run(self) -> None:
        # Give the server a few seconds to start up before checking
        time.sleep(5)
        while self.running:
            try:
                cfg = HeartbeatConfig.load()
                if cfg.enabled and cfg.interval_hours > 0:
                    now = time.time()
                    interval_sec = cfg.interval_hours * 3600.0
                    last_run = cfg.last_run_at or 0.0
                    if (now - last_run) >= interval_sec:
                        log.info("triggering scheduled heartbeat (interval: %.1fh)", cfg.interval_hours)
                        trigger_heartbeat(cfg)
            except Exception as e:
                log.exception("heartbeat runner error: %s", e)

            time.sleep(self.check_interval_sec)


# API Handlers for server.py route registry


def handle_get_heartbeat(handler, qs: dict) -> None:
    cfg = HeartbeatConfig.load()
    handler.send_json({
        "ok": True,
        "config": cfg.to_dict(),
    })


def handle_post_heartbeat(handler, body: dict) -> None:
    cfg = HeartbeatConfig.load()
    if "enabled" in body:
        cfg.enabled = bool(body["enabled"])
    if "interval_hours" in body:
        try:
            val = float(body["interval_hours"])
            if val > 0:
                cfg.interval_hours = val
        except (ValueError, TypeError):
            pass
    if "target_pane" in body:
        cfg.target_pane = str(body["target_pane"]).strip()
    if "target_workspace" in body:
        cfg.target_workspace = str(body["target_workspace"]).strip()
    if "prompt" in body:
        prompt_val = str(body["prompt"]).strip()
        if prompt_val:
            cfg.prompt = prompt_val
    if "ok_sentinel" in body:
        sentinel_val = str(body["ok_sentinel"]).strip()
        if sentinel_val:
            cfg.ok_sentinel = sentinel_val

    cfg.save()
    handler.send_json({
        "ok": True,
        "config": cfg.to_dict(),
    })


def handle_post_heartbeat_run(handler, body: dict) -> None:
    cfg = HeartbeatConfig.load()
    res = trigger_heartbeat(cfg)
    status_code = 200 if res.get("ok") else 400
    handler.send_json(res, status_code)


def init_heartbeat_routes(register_route_fn, register_interceptor_fn) -> None:
    """Register heartbeat routes and notification interceptor."""
    register_route_fn("GET", "/api/heartbeat", handle_get_heartbeat)
    register_route_fn("POST", "/api/heartbeat", handle_post_heartbeat)
    register_route_fn("POST", "/api/heartbeat/run", handle_post_heartbeat_run)
    register_interceptor_fn(heartbeat_notification_interceptor)


def start_runner() -> HeartbeatRunner:
    """Start the background heartbeat runner thread."""
    runner = HeartbeatRunner()
    runner.start()
    return runner


def init_heartbeat(register_route_fn, register_interceptor_fn) -> HeartbeatRunner:
    """Initialize heartbeat routes, interceptors, and background runner."""
    init_heartbeat_routes(register_route_fn, register_interceptor_fn)
    return start_runner()
