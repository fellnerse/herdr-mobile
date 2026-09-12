"""The scheduling loop: admit work only when the subscription has room."""

from __future__ import annotations

import logging
import re
import sqlite3
import sys
import threading
import time
from datetime import datetime, timezone

import push
from herdr_rpc import Herdr, HerdrError

from . import db, quota
from .config import Config

log = logging.getLogger("scheduler")


def _push(reason: str) -> None:
    """Wake the phone. Payload-less by design, same as the gateway's own pushes."""
    if not push.load_subs():
        return
    try:
        push.broadcast()
    except Exception as e:
        log.warning("push failed (%s): %s", reason, e)

# Claude Code prints its own wall message before going idle. Catching it in the
# pane is more reliable than inferring exhaustion from a utilization number that
# may lag by up to a poll interval.
LIMIT_RE = re.compile(
    r"(usage limit reached|limit reached|out of (?:usage|credits)|"
    r"limit will reset|upgrade to increase your usage limit)",
    re.IGNORECASE,
)

RESUME_PROMPT = (
    "Your previous turn was interrupted because the usage window ran out. "
    "The window has reset. Continue exactly where you left off."
)


class BlockedOnHuman(Exception):
    """A task cannot proceed without a person answering something.

    Distinct from a failure: nothing is wrong, and retrying unattended will hit
    exactly the same prompt, so it must not burn an attempt.
    """


# Claude Code asks this once per directory it has never seen. Worktree-per-task
# means every task runs somewhere brand new, so without handling it every single
# task blocks here forever.
TRUST_RE = re.compile(
    r"Is this a project you created or one you trust|"
    r"Yes, I trust this folder",
    re.IGNORECASE,
)


def agent_name(task: db.Task) -> str:
    """Unique live-agent name.

    Includes the attempt because a failed attempt's agent can still hold the
    name while its pane is being torn down, and herdr rejects a duplicate with
    `agent_name_taken`.
    """
    return f"sheep{task.id}" if task.attempts <= 1 else f"sheep{task.id}a{task.attempts}"


def _stopped_on_folder_trust(herdr: Herdr, pane_id: str) -> bool:
    """Is the agent sitting on the folder-trust dialog?

    Detection only. Answering it is a human decision: it is the gate that asks
    whether Claude may read, edit and execute in a directory, and the scheduler
    is not entitled to click through it on your behalf.
    """
    try:
        return bool(TRUST_RE.search(herdr.pane_read(pane_id, lines=40)))
    except HerdrError:
        return False


def branch_name(task: db.Task, cfg: Config) -> str:
    """Branch for this attempt.

    Later attempts get a suffix. A retry after a failed provision would
    otherwise collide with the branch the failed attempt already created, and
    `worktree.create` rejects an existing branch -- so every retry was
    guaranteed to fail for the same reason the first one did.
    """
    base = task.explicit_branch or f"{cfg.branch_prefix}task-{task.id}"
    return base if task.attempts <= 1 else f"{base}-a{task.attempts}"


def _sleep(seconds: float, cfg: Config) -> None:
    """Sleep in poll-sized chunks so Ctrl+C stays responsive."""
    deadline = time.monotonic() + seconds
    while (remaining := deadline - time.monotonic()) > 0:
        time.sleep(min(remaining, cfg.poll_seconds))


def _hit_the_wall(herdr: Herdr, task: db.Task, cfg: Config) -> bool:
    """Did this task stop because the subscription ran out?"""
    if task.pane_id:
        try:
            if LIMIT_RE.search(herdr.pane_read(task.pane_id, lines=60)):
                return True
        except HerdrError:
            pass
    try:
        return bool(quota.fetch().blockers(cfg.threshold))
    except quota.QuotaError:
        return False


def _pause(conn: sqlite3.Connection, herdr: Herdr, task: db.Task, reason: str) -> None:
    """Checkpoint a task so the next window can pick it up.

    The agent keeps its pane and its conversation; `esc` only halts the current
    turn. Resuming is then just another prompt. The session UUID is recorded as
    a fallback for when the pane does not survive (reboot, crash).
    """
    try:
        herdr.agent_send_keys(task.pane_id, ["esc"])
    except HerdrError:
        pass
    db.update(
        conn,
        task.id,
        state="paused",
        session_uuid=herdr.session_uuid(task.pane_id) or task.session_uuid,
        last_error=reason,
    )
    log.info("task %s paused: %s", task.id, reason)


def _provision(conn: sqlite3.Connection, herdr: Herdr, task: db.Task, cfg: Config) -> db.Task:
    """Give a fresh task a worktree, a pane, and a live agent."""
    branch = branch_name(task, cfg)
    result = herdr.worktree_create(
        cwd=task.repo_path,
        branch=branch,
        base=task.base_ref,
        label=f"sheep #{task.id}",
    )
    pane_id = (result.get("root_pane") or {}).get("pane_id")
    workspace_id = (result.get("workspace") or {}).get("workspace_id")
    worktree_path = (result.get("worktree") or {}).get("path")
    if not pane_id:
        raise HerdrError("no_pane", "worktree.create returned no root pane")

    # Record the workspace before starting the agent. If agent.start fails we
    # still own the worktree and can clean it up or retry into it; otherwise it
    # leaks with nothing pointing at it.
    db.update(
        conn,
        task.id,
        branch=branch,
        pane_id=pane_id,
        workspace_id=workspace_id,
        worktree_path=worktree_path,
        agent_name=agent_name(task),
    )

    status = herdr.agent_start(
        agent_name(task), pane_id, kind=cfg.agent_kind, args=cfg.agent_args
    )
    if status == "blocked" and _stopped_on_folder_trust(herdr, pane_id):
        db.update(conn, task.id, session_uuid=herdr.session_uuid(pane_id))
        raise BlockedOnHuman(
            "waiting for you to trust the worktree folder in Claude Code"
        )

    db.update(conn, task.id, session_uuid=herdr.session_uuid(pane_id))
    return db.get(conn, task.id)


def _revive(conn: sqlite3.Connection, herdr: Herdr, task: db.Task, cfg: Config) -> db.Task:
    """Bring a paused task back.

    Warm path: the agent is still sitting in its pane, so we just prompt it.
    Cold path: the pane died, so start a new agent on the recorded session with
    `--resume` and carry on in the same worktree.
    """
    if task.pane_id and herdr.status(task.pane_id) is not None:
        return task

    if not (task.session_uuid and task.worktree_path and task.workspace_id):
        raise HerdrError("unrecoverable", "paused task lost its pane and session")

    split = herdr.call(
        "pane.split",
        {
            "workspace_id": task.workspace_id,
            "direction": "right",
            "cwd": task.worktree_path,
            "focus": False,
        },
    )
    pane_id = (split.get("pane") or {}).get("pane_id")
    if not pane_id:
        raise HerdrError("no_pane", "pane.split returned no pane")

    herdr.agent_start(
        agent_name(task),
        pane_id,
        kind=cfg.agent_kind,
        args=[*cfg.agent_args, "--resume", task.session_uuid],
    )
    db.update(conn, task.id, pane_id=pane_id)
    return db.get(conn, task.id)


def run_task(conn: sqlite3.Connection, herdr: Herdr, task: db.Task, cfg: Config) -> None:
    resuming = task.state == "paused"
    db.update(
        conn,
        task.id,
        state="running",
        # Resuming after a quota pause is not an attempt. Counting it would let
        # a task that simply spans three windows exhaust max_attempts and get
        # marked failed for doing exactly what it is supposed to do.
        attempts=task.attempts if resuming else task.attempts + 1,
        started_at=task.started_at or db.now(),
        last_error=None,
    )
    task = db.get(conn, task.id)

    try:
        task = _revive(conn, herdr, task, cfg) if resuming else _provision(conn, herdr, task, cfg)
        prompt = RESUME_PROMPT if resuming else task.prompt
        herdr.agent_prompt(task.pane_id, prompt, timeout_ms=cfg.task_timeout_ms)
    except BlockedOnHuman as e:
        # Leave the pane alive so the question is still there to answer.
        db.update(conn, task.id, state="blocked", attempts=task.attempts - 1, last_error=str(e))
        herdr.notify(f"task #{task.id} needs you", str(e))
        _push("blocked")
        log.info("task %s blocked: %s", task.id, e)
        return
    except HerdrError as e:
        task = db.get(conn, task.id)
        if _hit_the_wall(herdr, task, cfg):
            _pause(conn, herdr, task, f"usage window exhausted ({e.code})")
            return
        _fail(conn, herdr, task, cfg, str(e))
        return

    task = db.get(conn, task.id)
    status = herdr.status(task.pane_id)

    if _hit_the_wall(herdr, task, cfg):
        _pause(conn, herdr, task, "usage window exhausted")
        return

    if status == "blocked":
        db.update(conn, task.id, state="blocked", last_error="agent is waiting on input")
        herdr.notify(f"task #{task.id} blocked", "The agent is asking a question.")
        _push("blocked")
        log.info("task %s blocked, needs a human", task.id)
        return

    db.update(conn, task.id, state="done", finished_at=db.now(), last_error=None)
    herdr.notify(f"task #{task.id} done", task.prompt[:120])
    _push("done")
    log.info("task %s done on branch %s", task.id, task.branch)


def _fail(conn: sqlite3.Connection, herdr: Herdr, task: db.Task, cfg: Config, error: str) -> None:
    if task.attempts < cfg.max_attempts:
        # Tear the workspace down before requeueing. Leaving it up kept the old
        # agent alive holding this task's agent name, so the retry died on
        # `agent_name_taken` instead of the thing it was retrying.
        if task.workspace_id:
            try:
                herdr.worktree_remove(task.workspace_id, force=True)
            except HerdrError as e:
                log.warning("could not remove %s: %s", task.workspace_id, e)
        # Drop the provisioning state so the retry builds a clean worktree
        # rather than reviving a half-made one.
        db.update(
            conn,
            task.id,
            state="queued",
            last_error=error,
            pane_id=None,
            workspace_id=None,
            worktree_path=None,
            session_uuid=None,
        )
        log.warning("task %s errored, will retry: %s", task.id, error)
        return
    db.update(conn, task.id, state="failed", finished_at=db.now(), last_error=error)
    herdr.notify(f"task #{task.id} failed", error[:120])
    _push("failed")
    log.error("task %s failed: %s", task.id, error)


def tick(conn: sqlite3.Connection, herdr: Herdr, cfg: Config) -> float:
    """One scheduling decision. Returns how long to wait before the next."""
    task = db.next_runnable(conn)
    if task is None:
        return cfg.poll_seconds

    if db.count_running(conn) >= cfg.max_concurrent:
        return cfg.poll_seconds

    try:
        current = quota.fetch()
    except quota.QuotaError as e:
        log.warning("cannot read quota, holding: %s", e)
        return cfg.poll_seconds

    if blockers := current.blockers(cfg.threshold):
        resume_at = current.resume_at(cfg.threshold)
        names = ", ".join(f"{b.name} {b.utilization:.0f}%" for b in blockers)
        log.info("holding on quota (%s); next window at %s", names, resume_at)
        return max(0.0, (resume_at - datetime.now(timezone.utc)).total_seconds())

    run_task(conn, herdr, task, cfg)
    return 0.0


class Scheduler(threading.Thread):
    """Runs the dispatch loop alongside the gateway.

    Its own thread because `agent.prompt --wait` blocks for as long as a task
    takes -- up to task_timeout_ms, two hours by default. In a request handler
    or in StatusWatcher that would stall the phone UI.

    Its own SQLite connection too: sqlite3 objects are not safe to share across
    threads, and the HTTP handlers open their own per request.
    """

    def __init__(self, config_loader):
        super().__init__(daemon=True, name="scheduler")
        self._load_config = config_loader

    def run(self) -> None:
        conn = db.connect()
        herdr = Herdr()
        recovered = db.reset_orphans(conn)
        if recovered:
            log.info("recovered %d task(s) interrupted by a restart", recovered)

        while True:
            cfg = self._load_config()  # re-read each pass so edits apply live
            try:
                delay = tick(conn, herdr, cfg)
            except HerdrError as e:
                log.warning("herdr unavailable: %s", e)
                delay = cfg.poll_seconds
            except Exception as e:
                # Never let one bad task kill the loop and silently stop the
                # queue -- that is the failure mode where nothing resumes.
                log.exception("scheduler tick failed: %s", e)
                delay = cfg.poll_seconds
            if delay:
                _sleep(delay, cfg)
