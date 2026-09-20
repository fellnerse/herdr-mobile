"""What the agents actually spent, hour by hour, out of their own logs.

The usage strip says what is *left* of a window. This says what went into it:
tokens, over days, per agent and per model and per project. The two answer
different questions -- "can I start something now" against "where did the week
go" -- and only one of them can be answered by a percentage.

Nobody has to start recording for this to work, which is the point. Both agents
already write every turn down: Claude Code keeps a JSONL per session under
`~/.claude/projects/`, with `message.usage` on each assistant entry, and Codex
keeps a rollout per session under `~/.codex/sessions/` with `token_count`
events. So the history is as old as the logs are, on the day this ships.

Reading it is the part that needs care. There are ~130MB of those logs on a
working machine and the phone polls this page, so nothing is parsed twice: a
file's totals are cached against its size, and a file that only grew is read
from where the last pass stopped. A full cold scan is a couple of seconds; every
pass after it is a handful of new lines.
"""

from __future__ import annotations

import json
import os
import re
import threading
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

from scheduler import STATE_DIR

# Claude Code's own session logs, one directory per project and one file per
# session. `CLAUDE_CONFIG_DIR` moves the lot, as it does for `.claude.json`.
CLAUDE_CONFIG_DIR = os.environ.get("CLAUDE_CONFIG_DIR")
CLAUDE_HOME = Path(CLAUDE_CONFIG_DIR) if CLAUDE_CONFIG_DIR else Path.home() / ".claude"
CLAUDE_PROJECTS = CLAUDE_HOME / "projects"
CODEX_HOME = Path(os.environ.get("CODEX_HOME") or Path.home() / ".codex")

CACHE = STATE_DIR / "token-history.json"
CACHE_VERSION = 3

# How far back the page can look. A month is more than anybody asks of it and
# still small enough that the whole history fits in one JSON file.
HORIZON_DAYS = 31

# Only lines carrying one of these are worth parsing as JSON. Nearly every line
# in a session log is a message body, and skipping those on a substring test is
# the difference between two seconds and a minute.
CLAUDE_MARK = '"usage"'
# Codex needs two kinds of line: the ones carrying a count, and the ones saying
# which model and which directory the counts that follow belong to.
CODEX_MARKS = ("token", '"cwd"', '"model"')

# The same assistant message is written more than once in a Claude session log
# (three times, as it streams), so a message counted once has to stay counted
# once. Duplicates sit within a few lines of each other, so remembering the last
# few hundred ids per file is enough - and unlike a set of every id ever seen,
# it stays the same size on a session that runs all week.
RECENT_IDS = 400

KINDS = ("input", "output", "cache_read", "cache_write")


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _hour(stamp: str) -> str:
    """The UTC hour an entry belongs to, as the key it is stored under.

    Kept in UTC, with the Z on it: the phone is the one that knows which day
    that was locally, and a gateway that guessed would be wrong for anybody
    reading it from another timezone.
    """
    if not stamp:
        return ""
    try:
        at = datetime.fromisoformat(stamp.replace("Z", "+00:00"))
    except (ValueError, AttributeError):
        return ""
    if at.tzinfo is None:
        at = at.replace(tzinfo=timezone.utc)
    return at.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:00:00Z")


# ------------------------------------------------------------- the project ---

_ROOTS: dict = {}

RE_GITDIR = re.compile(r"^gitdir:\s*(.+)$", re.MULTILINE)

# Where Herdr cuts its worktrees: `~/.herdr/worktrees/<repo>/<branch>`. The path
# says which repository the branch belongs to without anything having to be on
# disk, which is what keeps last week's tokens under the project they were spent
# on after the worktree they were spent in has been merged and removed.
WORKTREES = Path.home() / ".herdr" / "worktrees"


def repo_root(cwd: str) -> str:
    """The repository a working directory belongs to, the way the flock groups.

    The phone groups rows by `worktree.repo_root`, so the scheduler's `sheep/`
    checkouts sit under the repository they were cut from rather than becoming
    projects of their own. A log entry carries only its `cwd`, so the same
    grouping has to be found here: read it off a Herdr worktree path, or walk up
    to the checkout - and where that checkout is a linked worktree, a `.git`
    *file* pointing into the real repository's `worktrees/`, follow it home.

    Answers are memoised: a week of logs is thousands of entries across a dozen
    directories, and this touches the disk.
    """
    if not cwd:
        return ""
    if cwd in _ROOTS:
        return _ROOTS[cwd]

    root = ""
    try:
        here = Path(cwd).resolve()
    except (OSError, RuntimeError, ValueError):
        here = None
    branch = _herdr_worktree(here)
    if branch:
        _ROOTS[cwd] = branch
        return branch
    for folder in ([here] + list(here.parents) if here else []):
        dot = folder / ".git"
        if dot.is_dir():
            root = str(folder)
            break
        if dot.is_file():
            try:
                found = RE_GITDIR.search(dot.read_text())
            except OSError:
                found = None
            # "gitdir: /repo/.git/worktrees/branch" - the repository is what
            # sits above that .git, which is the same root the desktop reports.
            gitdir = found.group(1).strip() if found else ""
            marker = "/.git/"
            root = gitdir[: gitdir.index(marker)] if marker in gitdir else str(folder)
            break
    _ROOTS[cwd] = root or (str(here) if here else cwd)
    return _ROOTS[cwd]


def _herdr_worktree(here) -> str:
    """The repository a Herdr worktree was cut from, from its path alone.

    A worktree is deleted the moment its branch lands, and a path that is not
    there any more has no `.git` to follow - so the week's biggest project would
    come apart into one column per branch, all of them named after work that is
    already merged.
    """
    if here is None:
        return ""
    try:
        rest = here.relative_to(WORKTREES).parts
    except ValueError:
        return ""
    return str(WORKTREES / rest[0]) if rest else ""


def project_name(root: str) -> str:
    return root.rstrip("/").rsplit("/", 1)[-1] if root else "elsewhere"


# ---------------------------------------------------------------- the tally ---

# Hour, agent, model and project, in one string: the tally is a flat dict so
# that it survives a round trip through the cache file as JSON.
SEP = "\x1f"


def _key(hour: str, agent: str, model: str, project: str) -> str:
    return SEP.join((hour, agent, model or agent, project))


def _add(buckets: dict, key: str, counts: dict) -> None:
    row = buckets.get(key)
    if row is None:
        row = buckets[key] = {"input": 0, "output": 0, "cache_read": 0,
                              "cache_write": 0, "messages": 0}
    for name, value in counts.items():
        row[name] = row.get(name, 0) + value


def _merge(into: dict, other: dict) -> None:
    for key, row in other.items():
        _add(into, key, row)


def _int(value) -> int:
    return int(value) if isinstance(value, (int, float)) else 0


# ------------------------------------------------------------ Claude Code ---

def _claude_entry(line: str, seen: set, order: list) -> tuple:
    """One log line as (key parts, counts), or None if it carries no spend."""
    try:
        entry = json.loads(line)
    except (json.JSONDecodeError, ValueError):
        return None
    message = entry.get("message")
    if not isinstance(message, dict):
        return None
    usage = message.get("usage")
    if not isinstance(usage, dict):
        return None

    ident = f"{entry.get('requestId') or ''}|{message.get('id') or ''}"
    if ident in seen:
        return None
    seen.add(ident)
    order.append(ident)
    if len(order) > RECENT_IDS:
        seen.discard(order.pop(0))

    model = message.get("model") or "claude"
    # `<synthetic>` is Claude Code answering for itself - a refusal it composed,
    # an error it wrote down. No request was made and nothing was spent.
    if model.startswith("<"):
        return None

    hour = _hour(entry.get("timestamp"))
    if not hour:
        return None
    root = repo_root(entry.get("cwd") or "")
    counts = {
        "input": _int(usage.get("input_tokens")),
        "output": _int(usage.get("output_tokens")),
        "cache_read": _int(usage.get("cache_read_input_tokens")),
        "cache_write": _int(usage.get("cache_creation_input_tokens")),
        "messages": 1,
    }
    if not any(counts[k] for k in KINDS):
        return None
    return (hour, "claude", model, root), counts


def _scan_claude(text: str, state: dict) -> dict:
    seen = set(state.get("ids") or [])
    order = list(state.get("ids") or [])
    buckets: dict = {}
    for line in text.splitlines():
        if CLAUDE_MARK not in line:
            continue
        found = _claude_entry(line, seen, order)
        if found:
            (hour, agent, model, root), counts = found
            _add(buckets, _key(hour, agent, model, root), counts)
    state["ids"] = order[-RECENT_IDS:]
    return buckets


# ------------------------------------------------------------------ Codex ---

def _find(event, field: str):
    """Where Codex put something this time round.

    Its rollout shape has moved between releases - `rate_limits` did, and
    `token_count` sits a payload deep - so the fields are looked for rather
    than known, the same way `quota.py` finds the limits.
    """
    if isinstance(event, dict):
        if field in event:
            return event[field]
        for value in event.values():
            found = _find(value, field)
            if found is not None:
                return found
    return None


def _codex_counts(usage: dict) -> dict:
    """One turn's spend, in the four kinds everything here is counted in.

    Codex reports cached input inside the input total, so the cached part is
    taken back out: added as it stands it would count the same tokens twice,
    once as fresh input and once as a cache read. Reasoning is output that was
    paid for, so it counts as output. Nothing here writes a cache it reports.
    """
    cached = _int(usage.get("cached_input_tokens"))
    return {
        "input": max(0, _int(usage.get("input_tokens")) - cached),
        "output": _int(usage.get("output_tokens")) + _int(usage.get("reasoning_output_tokens")),
        "cache_read": cached,
        "cache_write": 0,
        "messages": 1,
    }


def _codex_delta(info: dict, state: dict) -> dict:
    """What this event added, from whichever total the rollout carries.

    `last_token_usage` is the turn on its own and is what we want. Older
    rollouts only carry the running total for the session, so the turn is the
    difference from the last total seen - which has to survive between passes,
    since the pass that reads the next line may be minutes later.
    """
    last = info.get("last_token_usage")
    if isinstance(last, dict):
        return _codex_counts(last)

    total = info.get("total_token_usage")
    if not isinstance(total, dict):
        return {}
    counts = _codex_counts(total)
    previous = state.get("total") or {}
    state["total"] = dict(counts)
    delta = {k: max(0, counts.get(k, 0) - _int(previous.get(k))) for k in KINDS}
    delta["messages"] = 1
    # A session's first event is the whole total, and a total that did not move
    # is a repeat of the event before it rather than a turn that cost nothing.
    if previous and not any(delta[k] for k in KINDS):
        return {}
    return delta


def _scan_codex(text: str, state: dict) -> dict:
    buckets: dict = {}
    for line in text.splitlines():
        if not any(mark in line for mark in CODEX_MARKS):
            continue
        try:
            event = json.loads(line)
        except (json.JSONDecodeError, ValueError):
            continue
        # A rollout says which model and which directory once, at the top, and
        # again whenever either changes; the usage events themselves say
        # neither, so the last one seen is the one they belong to.
        model = _find(event, "model")
        if isinstance(model, str) and model:
            state["model"] = model
        cwd = _find(event, "cwd")
        if isinstance(cwd, str) and cwd:
            state["cwd"] = cwd

        info = _find(event, "info")
        if not isinstance(info, dict):
            continue
        if not isinstance(info.get("last_token_usage"), dict) and \
                not isinstance(info.get("total_token_usage"), dict):
            continue
        counts = _codex_delta(info, state)
        if not counts or not any(counts.get(k) for k in KINDS):
            continue
        hour = _hour(event.get("timestamp"))
        if not hour:
            continue
        _add(buckets, _key(hour, "codex", state.get("model") or "codex",
                           repo_root(state.get("cwd") or "")), counts)
    return buckets


# ------------------------------------------------------------- the reading ---

SCANNERS = {"claude": _scan_claude, "codex": _scan_codex}


def _logs(horizon: datetime) -> list:
    """Every session log worth opening, with the agent that wrote it.

    Anything last written to before the horizon is skipped outright rather than
    read and then thrown away: most of what is on disk is older than the page
    can show, and a session that has not been touched in a month has nothing to
    add to it.
    """
    cutoff = horizon.timestamp()
    found = []
    for agent, folder, pattern in (
        ("claude", CLAUDE_PROJECTS, "*/*.jsonl"),
        ("codex", CODEX_HOME / "sessions", "*/*/*/*.jsonl"),
    ):
        try:
            paths = folder.glob(pattern)
        except OSError:
            continue
        for path in paths:
            try:
                stat = path.stat()
            except OSError:
                continue
            if stat.st_mtime >= cutoff:
                found.append((agent, path, stat))
    return found


def _read_tail(path: Path, start: int) -> tuple:
    """The part of a log that has not been read yet, and where it ends.

    A session log is appended to, so what was read last time is still true and
    only what came after it has to be parsed. If the file is shorter than it
    was it is not the same file any more - rotated, or rewritten - and the
    whole of it is read again.
    """
    try:
        with path.open("rb") as fh:
            fh.seek(0, os.SEEK_END)
            size = fh.tell()
            if start and start <= size:
                fh.seek(start)
            else:
                start = 0
                fh.seek(0)
            chunk = fh.read()
    except OSError:
        return "", start, False
    return chunk.decode("utf-8", "replace"), size, start == 0


def _load_cache() -> dict:
    try:
        body = json.loads(CACHE.read_text())
    except (FileNotFoundError, json.JSONDecodeError, OSError, ValueError):
        return {"version": CACHE_VERSION, "files": {}}
    if body.get("version") != CACHE_VERSION:
        return {"version": CACHE_VERSION, "files": {}}
    body.setdefault("files", {})
    return body


def _save_cache(cache: dict) -> None:
    try:
        STATE_DIR.mkdir(parents=True, exist_ok=True)
        tmp = CACHE.with_suffix(".tmp")
        tmp.write_text(json.dumps(cache))
        tmp.replace(CACHE)
    except OSError:
        pass  # a cache that cannot be written costs a rescan, nothing more


_lock = threading.Lock()
_memo: dict = {}
# Re-reading the logs on every poll would parse the same handful of new lines
# over and over while somebody watches the page; a minute is shorter than the
# time it takes an agent to spend anything worth seeing.
MEMO_TTL = 60.0


def refresh(cache: dict = None) -> dict:
    """Bring the tally up to date, reading only what has been written since.

    Returns the whole history: `{key: counts}` over every log still inside the
    horizon, where the key is hour, agent, model and project.
    """
    cache = _load_cache() if cache is None else cache
    files = cache["files"]
    horizon = _now() - timedelta(days=HORIZON_DAYS)

    fresh = {}
    total: dict = {}
    for agent, path, stat in _logs(horizon):
        name = str(path)
        state = files.get(name) or {}
        text, size, from_start = _read_tail(path, _int(state.get("offset")))
        if from_start:
            # Read whole again, so whatever was tallied from it is replaced
            # rather than added to.
            state = {}
        if text:
            counted = SCANNERS[agent](text, state)
            _merge(state.setdefault("buckets", {}), counted)
        state["offset"] = size
        fresh[name] = state
        _merge(total, state.get("buckets") or {})

    # Files that fell off the horizon take their cache entry with them.
    cache["files"] = fresh
    _save_cache(cache)
    return total


def history(days: int = 7) -> dict:
    """The tally, as rows the phone can draw, plus what it was read from."""
    days = max(1, min(HORIZON_DAYS, int(days or 7)))
    with _lock:
        stamped = _memo.get("at", 0.0)
        if time.monotonic() - stamped > MEMO_TTL or "total" not in _memo:
            started = time.monotonic()
            _memo["total"] = refresh()
            _memo["took"] = time.monotonic() - started
            _memo["at"] = time.monotonic()
            _memo["read_at"] = _now().isoformat()
        total = _memo["total"]
        took = _memo["took"]
        read_at = _memo["read_at"]

    since = (_now() - timedelta(days=days)).strftime("%Y-%m-%dT%H:00:00Z")
    rows = []
    for key, counts in total.items():
        hour, agent, model, root = key.split(SEP)
        if hour < since:
            continue
        rows.append({
            "hour": hour,
            "agent": agent,
            "model": model,
            "project": project_name(root),
            "input": counts.get("input", 0),
            "output": counts.get("output", 0),
            "cache_read": counts.get("cache_read", 0),
            "cache_write": counts.get("cache_write", 0),
            "messages": counts.get("messages", 0),
        })
    rows.sort(key=lambda r: (r["hour"], r["agent"], r["model"], r["project"]))
    return {
        "ok": True,
        "days": days,
        "read_at": read_at,
        "took_ms": round(took * 1000),
        "rows": rows,
    }
