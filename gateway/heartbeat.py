"""Heartbeat runner and conditional notification for SheepIt.

Periodically runs health/status checks (e.g. /live-web-stats-check) in agent
sessions. Supports multiple independent heartbeats, each with its own schedule,
target, and prompt. If an agent finishes with the OK sentinel (default
HEARTBEAT_OK), the push notification is suppressed (silence is golden). If an
anomaly or issue is reported, an alert push notification is sent to the phone.
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
class HeartbeatItem:
    id: str = ""
    name: str = "Live Web Stats"
    enabled: bool = True
    interval_hours: float = 24.0
    target_type: str = "new_agent"  # "new_agent" | "existing_agent"
    target_pane: str = ""
    target_workspace: str = ""
    agent_kind: str = "claude"  # "claude" | "codex"
    model: str = ""  # empty for default, or model name e.g. "claude-3-7-sonnet"
    clear_session: bool = True
    auto_close: bool = True  # auto-close tab on clean completion (keep open on alert)
    prompt: str = DEFAULT_PROMPT
    ok_sentinel: str = DEFAULT_SENTINEL
    last_run_at: float | None = None
    last_status: str | None = None  # "ok", "alert", "running", "error"
    last_summary: str | None = None

    def to_dict(self) -> dict:
        return asdict(self)

    @classmethod
    def from_dict(cls, data: dict) -> HeartbeatItem:
        known = {f.name for f in cls.__dataclass_fields__.values()}
        filtered = {k: v for k, v in data.items() if k in known}
        if not filtered.get("id"):
            filtered["id"] = f"hb_{int(time.time() * 1000)}"
        return cls(**filtered)


@dataclass
class HeartbeatConfig:
    heartbeats: list[HeartbeatItem]

    def __init__(self, heartbeats: list[HeartbeatItem] | None = None, **kwargs):
        if heartbeats is not None:
            self.heartbeats = heartbeats
        elif "heartbeats" in kwargs:
            self.heartbeats = kwargs.pop("heartbeats")
        elif kwargs:
            self.heartbeats = [HeartbeatItem.from_dict({"id": "hb_default", "name": "Live Web Stats", **kwargs})]
        else:
            self.heartbeats = [HeartbeatItem(id="hb_default", name="Live Web Stats", enabled=False)]
    def to_dict(self) -> dict:
        data = {
            "heartbeats": [hb.to_dict() for hb in self.heartbeats],
        }
        if self.heartbeats:
            first = self.heartbeats[0].to_dict()
            for k in ("enabled", "interval_hours", "target_pane", "target_workspace",
                      "prompt", "ok_sentinel", "last_run_at", "last_status", "last_summary"):
                data[k] = first.get(k)
        return data

    def save(self, path: Path | None = None) -> None:
        path = path or CONFIG_PATH
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps({"heartbeats": [hb.to_dict() for hb in self.heartbeats]}, indent=2) + "\n")

    @classmethod
    def load(cls, path: Path | None = None) -> HeartbeatConfig:
        path = path or CONFIG_PATH
        try:
            raw = json.loads(path.read_text())
        except (FileNotFoundError, json.JSONDecodeError):
            return cls(heartbeats=[HeartbeatItem(id="hb_default", name="Live Web Stats", enabled=False)])

        if isinstance(raw, dict) and "heartbeats" in raw and isinstance(raw["heartbeats"], list):
            items = [HeartbeatItem.from_dict(item) for item in raw["heartbeats"] if isinstance(item, dict)]
            return cls(heartbeats=items)

        # Migration from legacy single-heartbeat format
        if isinstance(raw, dict):
            legacy_item = HeartbeatItem.from_dict({
                "id": "hb_default",
                "name": "Live Web Stats",
                "enabled": raw.get("enabled", False),
                "interval_hours": raw.get("interval_hours", 24.0),
                "target_pane": raw.get("target_pane", ""),
                "target_workspace": raw.get("target_workspace", ""),
                "prompt": raw.get("prompt", DEFAULT_PROMPT),
                "ok_sentinel": raw.get("ok_sentinel", DEFAULT_SENTINEL),
                "last_run_at": raw.get("last_run_at"),
                "last_status": raw.get("last_status"),
                "last_summary": raw.get("last_summary"),
            })
            return cls(heartbeats=[legacy_item])

        return cls(heartbeats=[HeartbeatItem(id="hb_default", name="Live Web Stats", enabled=False)])

    # Compatibility properties for single-heartbeat callers
    @property
    def enabled(self) -> bool:
        return any(hb.enabled for hb in self.heartbeats) if self.heartbeats else False

    @enabled.setter
    def enabled(self, val: bool) -> None:
        if self.heartbeats:
            self.heartbeats[0].enabled = val

    @property
    def interval_hours(self) -> float:
        return self.heartbeats[0].interval_hours if self.heartbeats else 24.0

    @interval_hours.setter
    def interval_hours(self, val: float) -> None:
        if self.heartbeats:
            self.heartbeats[0].interval_hours = val

    @property
    def ok_sentinel(self) -> str:
        return self.heartbeats[0].ok_sentinel if self.heartbeats else DEFAULT_SENTINEL

    @ok_sentinel.setter
    def ok_sentinel(self, val: str) -> None:
        if self.heartbeats:
            self.heartbeats[0].ok_sentinel = val

    @property
    def prompt(self) -> str:
        return self.heartbeats[0].prompt if self.heartbeats else DEFAULT_PROMPT

    @prompt.setter
    def prompt(self, val: str) -> None:
        if self.heartbeats:
            self.heartbeats[0].prompt = val


# In-memory tracking of active heartbeat turns: pane_id -> {started_at, sentinel, heartbeat_id, heartbeat_name}
_ACTIVE_HEARTBEATS: dict[str, dict] = {}
_ACTIVE_LOCK = threading.Lock()


def mark_heartbeat_started(pane_id: str, sentinel: str, heartbeat_id: str = "", heartbeat_name: str = "") -> None:
    with _ACTIVE_LOCK:
        _ACTIVE_HEARTBEATS[pane_id] = {
            "started_at": time.time(),
            "sentinel": sentinel,
            "heartbeat_id": heartbeat_id,
            "heartbeat_name": heartbeat_name,
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
    meaningful = []
    for line in lines:
        if line.startswith(("> ", "❯ ", "$ ", "#", "╭", "╰", "│")):
            continue
        meaningful.append(line)
    if not meaningful:
        return "Anomalies detected in heartbeat check"
    summary = " ".join(meaningful[:3])
    if len(summary) > max_length:
        summary = summary[: max_length - 1].rstrip() + "…"
    return summary


def heartbeat_notification_interceptor(pane_id: str, row: dict) -> tuple[bool, dict | None]:
    """Intercept stopped panes to suppress clean heartbeats or format alerts."""
    info = pop_heartbeat(pane_id)
    if not info:
        return True, None

    sentinel = info.get("sentinel", DEFAULT_SENTINEL)
    hb_id = info.get("heartbeat_id")
    hb_name = info.get("heartbeat_name") or row.get("display_name") or row.get("name") or "Agent"

    herdr = Herdr()
    try:
        output = herdr.pane_read(pane_id, lines=40)
    except Exception as e:
        log.warning("could not read pane %s for heartbeat: %s", pane_id, e)
        output = ""

    cfg = HeartbeatConfig.load()
    target_hb = None
    if hb_id:
        for hb in cfg.heartbeats:
            if hb.id == hb_id:
                target_hb = hb
                break
    if not target_hb and cfg.heartbeats:
        target_hb = cfg.heartbeats[0]

    status = row.get("status")

    if sentinel in output and status != "blocked":
        if target_hb:
            target_hb.last_status = "ok"
            target_hb.last_summary = f"All checks passed ({sentinel})"
            if target_hb.auto_close:
                tab_id = row.get("tab_id")
                if not tab_id:
                    try:
                        panes = call_herdr_rpc("pane.list").get("result", {}).get("panes", [])
                        for p in panes:
                            if p.get("pane_id") == pane_id:
                                tab_id = p.get("tab_id")
                                break
                    except Exception:
                        pass
                if tab_id:
                    try:
                        call_herdr_rpc("tab.close", {"tab_id": tab_id})
                        log.info("heartbeat [%s] auto-closed tab %s on clean completion", hb_name, tab_id)
                        target_hb.target_pane = ""
                    except Exception as e:
                        log.warning("failed to auto-close tab %s: %s", tab_id, e)
            cfg.save()
        log.info("heartbeat [%s] on pane %s finished clean (%s); suppressing push", hb_name, pane_id, sentinel)
        return False, None
    summary = extract_summary(output)
    if target_hb:
        target_hb.last_status = "alert"
        target_hb.last_summary = summary
        cfg.save()

    alert_title = f"Heartbeat Alert: {hb_name}"
    log.warning("heartbeat alert [%s] on pane %s: %s", hb_name, pane_id, summary)

    return True, {
        "title": alert_title,
        "body": summary,
    }


def find_target_pane(hb: HeartbeatItem) -> str | None:
    """Resolve a target pane to run the heartbeat in."""
    herdr = Herdr()
    try:
        agents = herdr.agent_list()
    except Exception as e:
        log.warning("failed to list agents: %s", e)
        return None

    if not agents:
        return None

    # 1. Existing agent mode
    if hb.target_type == "existing_agent":
        if hb.target_pane:
            for a in agents:
                if a.get("pane_id") == hb.target_pane:
                    return hb.target_pane
        return None

    # 2. New dedicated agent mode (in target_workspace)
    if hb.target_workspace:
        target_tab_label = f"hb-{hb.name[:10].lower().replace(' ', '-')}"

        # Fetch all tabs and panes for this workspace
        try:
            tab_res = call_herdr_rpc("tab.list", {"workspace_id": hb.target_workspace})
            tabs = tab_res.get("result", {}).get("tabs", [])
            pane_res = call_herdr_rpc("pane.list")
            panes = [p for p in pane_res.get("result", {}).get("panes", []) if p.get("workspace_id") == hb.target_workspace]
        except Exception as e:
            log.warning("failed to inspect tabs/panes in %s: %s", hb.target_workspace, e)
            tabs, panes = [], []

        # Look for existing tab matching our heartbeat label
        for t in tabs:
            label = t.get("label") or ""
            if label == target_tab_label or label.startswith("hb-") or label == "heartbeat":
                tab_id = t.get("tab_id")
                matching_panes = [p for p in panes if p.get("tab_id") == tab_id]
                if matching_panes:
                    p = matching_panes[0]
                    p_id = p.get("pane_id")
                    current_agent = p.get("agent")
                    # If pane has no agent yet (shell), start the agent in this existing tab!
                    if not current_agent or current_agent == "unknown":
                        args = ["--model", hb.model] if hb.model else None
                        try:
                            herdr.agent_start(f"hb-{hb.id[:8]}", p_id, kind=hb.agent_kind or "claude", args=args)
                        except Exception as e:
                            log.warning("failed to start agent in existing shell pane %s: %s", p_id, e)
                        hb.target_pane = p_id
                        return p_id
                    # If agent kind matches, reuse this existing tab!
                    if not hb.agent_kind or current_agent == hb.agent_kind:
                        hb.target_pane = p_id
                        return p_id
                    # If agent kind changed, close the old tab and create a fresh one
                    try:
                        call_herdr_rpc("tab.close", {"tab_id": tab_id})
                    except Exception:
                        pass
                    break

        # No dedicated tab found; create one in this workspace
        cwd = ""
        for a in agents:
            if a.get("workspace_id") == hb.target_workspace:
                cwd = a.get("cwd") or a.get("foreground_cwd") or ""
                break
        if not cwd:
            try:
                ws_res = call_herdr_rpc("workspace.list").get("result", {}).get("workspaces", [])
                for w in ws_res:
                    if w.get("workspace_id") == hb.target_workspace:
                        cwd = w.get("cwd") or ""
                        break
            except Exception:
                pass

        if cwd:
            try:
                new_pane = herdr.open_pane(cwd, workspace_id=hb.target_workspace, label=target_tab_label)
                if new_pane:
                    args = ["--model", hb.model] if hb.model else None
                    herdr.agent_start(f"hb-{hb.id[:8]}", new_pane, kind=hb.agent_kind or "claude", args=args)
                    hb.target_pane = new_pane
                    return new_pane
            except Exception as e:
                log.warning("failed to create dedicated heartbeat tab in %s: %s", hb.target_workspace, e)
    # Fallback to target_pane if set
    if hb.target_pane:
        for a in agents:
            if a.get("pane_id") == hb.target_pane:
                return hb.target_pane

    return None


def send_agent_prompt(herdr: Herdr, pane_id: str, text: str) -> None:
    """Send a prompt or command to an agent pane.

    Tries Herdr's `agent.prompt` first. If the target is not recognized by
    Herdr's agent RPC (e.g. omp, which raises agent_not_ready or agent_not_found),
    falls back to typing it into the pane with enter (`send_line`).
    """
    try:
        herdr.agent_prompt(pane_id, text)
    except HerdrError as e:
        if e.code in ("agent_not_found", "agent_not_ready", "no_agent", "unknown_agent", "not_supported"):
            herdr.send_line(pane_id, text)
        else:
            raise

def trigger_heartbeat(hb_or_cfg: HeartbeatItem | HeartbeatConfig | None = None,
                      heartbeat_id: str | None = None) -> dict:
    """Trigger a heartbeat check immediately."""
    cfg = HeartbeatConfig.load()
    target_hb = None

    if isinstance(hb_or_cfg, HeartbeatItem):
        target_hb = hb_or_cfg
    elif heartbeat_id:
        for hb in cfg.heartbeats:
            if hb.id == heartbeat_id:
                target_hb = hb
                break
    elif cfg.heartbeats:
        for hb in cfg.heartbeats:
            if hb.enabled:
                target_hb = hb
                break
        if not target_hb:
            target_hb = cfg.heartbeats[0]

    if not target_hb:
        return {"ok": False, "error": "No heartbeat configured"}

    prompt = (target_hb.prompt or DEFAULT_PROMPT).strip()
    sentinel = (target_hb.ok_sentinel or DEFAULT_SENTINEL).strip()
    herdr = Herdr()

    # Mode A: New dedicated agent in target_workspace (Inline harness start)
    if target_hb.target_type != "existing_agent" and target_hb.target_workspace:
        target_tab_label = f"hb-{target_hb.name[:10].lower().replace(' ', '-')}"

        # Check if an existing dedicated tab exists for this check
        try:
            tab_res = call_herdr_rpc("tab.list", {"workspace_id": target_hb.target_workspace})
            tabs = tab_res.get("result", {}).get("tabs", [])
            for t in tabs:
                label = t.get("label") or ""
                if label == target_tab_label or label.startswith("hb-") or label == "heartbeat":
                    if t.get("agent_status") == "working":
                        msg = f"Heartbeat '{target_hb.name}' is already running in {t.get('tab_id')}"
                        target_hb.last_status = "busy"
                        target_hb.last_summary = msg
                        cfg.save()
                        return {"ok": False, "error": msg}
                    try:
                        call_herdr_rpc("tab.close", {"tab_id": t.get("tab_id")})
                    except Exception:
                        pass
        except Exception as e:
            log.warning("failed to check existing tabs in %s: %s", target_hb.target_workspace, e)

        cwd = ""
        try:
            agents = herdr.agent_list()
            for a in agents:
                if a.get("workspace_id") == target_hb.target_workspace:
                    cwd = a.get("cwd") or a.get("foreground_cwd") or ""
                    break
        except Exception:
            pass
        if not cwd:
            try:
                ws_res = call_herdr_rpc("workspace.list").get("result", {}).get("workspaces", [])
                for w in ws_res:
                    if w.get("workspace_id") == target_hb.target_workspace:
                        cwd = w.get("cwd") or ""
                        break
            except Exception:
                pass

        if not cwd:
            msg = f"Target workspace '{target_hb.target_workspace}' not found or has no cwd"
            target_hb.last_status = "error"
            target_hb.last_summary = msg
            cfg.save()
            return {"ok": False, "error": msg}

        try:
            pane_id = herdr.open_pane(cwd, workspace_id=target_hb.target_workspace, label=target_tab_label)
        except Exception as e:
            msg = f"Failed to create tab in {target_hb.target_workspace}: {e}"
            target_hb.last_status = "error"
            target_hb.last_summary = msg
            cfg.save()
            return {"ok": False, "error": msg}

        args = []
        if target_hb.model:
            args.extend(["--model", target_hb.model])
        clean_prompt = " ".join(line.strip() for line in prompt.splitlines() if line.strip())
        args.append(clean_prompt)
        mark_heartbeat_started(pane_id, sentinel, target_hb.id, target_hb.name)
        try:
            herdr.agent_start(f"hb-{target_hb.id[:8]}", pane_id, kind=target_hb.agent_kind or "claude", args=args)
        except HerdrError as e:
            pop_heartbeat(pane_id)
            msg = f"Failed to start {target_hb.agent_kind} in {pane_id}: {e}"
            target_hb.last_status = "error"
            target_hb.last_summary = msg
            cfg.save()
            return {"ok": False, "error": msg}

        target_hb.target_pane = pane_id
        target_hb.last_run_at = time.time()
        target_hb.last_status = "running"
        target_hb.last_summary = "Check in progress…"
        for i, hb in enumerate(cfg.heartbeats):
            if hb.id == target_hb.id:
                cfg.heartbeats[i] = target_hb
                break
        cfg.save()
        return {
            "ok": True,
            "id": target_hb.id,
            "name": target_hb.name,
            "pane_id": pane_id,
            "sentinel": sentinel,
            "prompt": prompt,
        }

    # Mode B: Existing agent mode (fallback)
    pane_id = find_target_pane(target_hb)
    if not pane_id:
        msg = f"No target agent configured or online for '{target_hb.name}'. Please select a project in Settings."
        target_hb.last_status = "error"
        target_hb.last_summary = msg
        cfg.save()
        return {"ok": False, "error": msg}

    status = herdr.status(pane_id)
    if status == "working":
        msg = f"Target agent in {pane_id} is currently busy doing other work"
        target_hb.last_status = "busy"
        target_hb.last_summary = msg
        cfg.save()
        return {"ok": False, "error": msg}

    if target_hb.clear_session and status in ("idle", "done"):
        clear_cmd = "/new" if target_hb.agent_kind == "omp" else "/clear"
        try:
            send_agent_prompt(herdr, pane_id, clear_cmd)
            time.sleep(1.0)
        except Exception as e:
            log.warning("failed to clear session in %s: %s", pane_id, e)

    try:
        mark_heartbeat_started(pane_id, sentinel, target_hb.id, target_hb.name)
        send_agent_prompt(herdr, pane_id, prompt)
    except HerdrError as e:
        pop_heartbeat(pane_id)
        return {"ok": False, "error": f"Failed to send prompt to {pane_id}: {e}"}
    target_hb.last_run_at = time.time()
    target_hb.last_status = "running"
    target_hb.last_summary = "Check in progress…"

    # Sync back to config and save
    for i, hb in enumerate(cfg.heartbeats):
        if hb.id == target_hb.id:
            cfg.heartbeats[i] = target_hb
            break
    cfg.save()

    return {
        "ok": True,
        "id": target_hb.id,
        "name": target_hb.name,
        "pane_id": pane_id,
        "sentinel": sentinel,
        "prompt": prompt,
    }


class HeartbeatRunner(threading.Thread):
    """Background daemon checking if any scheduled heartbeats should run."""

    def __init__(self, check_interval_sec: int = 60):
        super().__init__(daemon=True, name="heartbeat-runner")
        self.check_interval_sec = check_interval_sec
        self.running = True

    def run(self) -> None:
        time.sleep(5)
        while self.running:
            try:
                cfg = HeartbeatConfig.load()
                now = time.time()
                for hb in cfg.heartbeats:
                    if hb.enabled and hb.interval_hours > 0:
                        interval_sec = hb.interval_hours * 3600.0
                        last_run = hb.last_run_at or 0.0
                        if (now - last_run) >= interval_sec:
                            log.info("triggering scheduled heartbeat '%s' (interval: %.1fh)",
                                     hb.name, hb.interval_hours)
                            trigger_heartbeat(hb)
            except Exception as e:
                log.exception("heartbeat runner error: %s", e)

            time.sleep(self.check_interval_sec)


# API Handlers for server.py route registry


def handle_get_heartbeat(handler, qs: dict) -> None:
    cfg = HeartbeatConfig.load()
    handler.send_json({
        "ok": True,
        "heartbeats": [hb.to_dict() for hb in cfg.heartbeats],
        "config": cfg.to_dict(),
    })


def handle_post_heartbeat(handler, body: dict) -> None:
    cfg = HeartbeatConfig.load()

    # Full list update
    if "heartbeats" in body and isinstance(body["heartbeats"], list):
        cfg.heartbeats = [HeartbeatItem.from_dict(item) for item in body["heartbeats"] if isinstance(item, dict)]
        cfg.save()
        handler.send_json({"ok": True, "heartbeats": [hb.to_dict() for hb in cfg.heartbeats], "config": cfg.to_dict()})
        return

    # Single heartbeat update or create
    item_data = body.get("heartbeat") or body
    hb_id = item_data.get("id")

    target_hb = None
    if hb_id:
        for hb in cfg.heartbeats:
            if hb.id == hb_id:
                target_hb = hb
                break

    if not target_hb:
        target_hb = HeartbeatItem.from_dict(item_data)
        cfg.heartbeats.append(target_hb)
    else:
        if "name" in item_data:
            target_hb.name = str(item_data["name"]).strip() or target_hb.name
        if "enabled" in item_data:
            target_hb.enabled = bool(item_data["enabled"])
        if "interval_hours" in item_data:
            try:
                val = float(item_data["interval_hours"])
                if val > 0:
                    target_hb.interval_hours = val
            except (ValueError, TypeError):
                pass
        if "target_pane" in item_data:
            target_hb.target_pane = str(item_data["target_pane"]).strip()
        if "target_workspace" in item_data:
            target_hb.target_workspace = str(item_data["target_workspace"]).strip()
        if "prompt" in item_data:
            val = str(item_data["prompt"]).strip()
            if val:
                target_hb.prompt = val
        if "ok_sentinel" in item_data:
            val = str(item_data["ok_sentinel"]).strip()
            if val:
                target_hb.ok_sentinel = val
        if "target_type" in item_data:
            target_hb.target_type = str(item_data["target_type"]).strip()
        if "clear_session" in item_data:
            target_hb.clear_session = bool(item_data["clear_session"])
        if "agent_kind" in item_data:
            target_hb.agent_kind = str(item_data["agent_kind"]).strip() or "claude"
        if "model" in item_data:
            target_hb.model = str(item_data["model"]).strip()
        if "auto_close" in item_data:
            target_hb.auto_close = bool(item_data["auto_close"])

    cfg.save()
    handler.send_json({
        "ok": True,
        "heartbeats": [hb.to_dict() for hb in cfg.heartbeats],
        "config": cfg.to_dict(),
    })


def handle_post_heartbeat_delete(handler, body: dict) -> None:
    hb_id = body.get("id")
    if not hb_id:
        handler.send_json({"ok": False, "error": "Missing heartbeat id"}, 400)
        return
    cfg = HeartbeatConfig.load()
    cfg.heartbeats = [hb for hb in cfg.heartbeats if hb.id != hb_id]
    cfg.save()
    handler.send_json({"ok": True, "heartbeats": [hb.to_dict() for hb in cfg.heartbeats]})


def handle_post_heartbeat_run(handler, body: dict) -> None:
    hb_id = body.get("id")
    res = trigger_heartbeat(heartbeat_id=hb_id)
    status_code = 200 if res.get("ok") else 400
    handler.send_json(res, status_code)


def init_heartbeat_routes(register_route_fn, register_interceptor_fn) -> None:
    """Register heartbeat routes and notification interceptor."""
    register_route_fn("GET", "/api/heartbeat", handle_get_heartbeat)
    register_route_fn("POST", "/api/heartbeat", handle_post_heartbeat)
    register_route_fn("POST", "/api/heartbeat/delete", handle_post_heartbeat_delete)
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
