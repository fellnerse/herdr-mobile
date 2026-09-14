"""What a subscription has left, per agent, from whoever will say.

Claude Code resolves its own limits via `fetchUtilization: GET /api/oauth/usage`.
Calling it costs no tokens, so we can poll it freely and schedule against real
reset timestamps instead of inferring windows from failures.

That endpoint needs a token, and a token is the one thing that may be missing:
on a Mac it lives in the Keychain rather than a file, and Codex has no such
endpoint at all. But both agents already write their own usage down --
Claude Code caches its last reading in `.claude.json`, Codex records the rate
limits of every turn in its session rollout -- and reading that costs nothing
and needs no credentials. So each agent has two sources: what it was told, and
what it wrote down. The first is authoritative, the second always available,
and a reading says which it is.
"""

from __future__ import annotations

import json
import os
import re
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path

USAGE_URL = "https://api.anthropic.com/api/oauth/usage"
CREDENTIALS = Path.home() / ".claude" / ".credentials.json"
# On macOS Claude Code keeps the same JSON in the login Keychain and writes no
# credentials file at all, so reading only the file holds every prompt on a Mac
# forever: the sweep cannot price the window, so it never delivers.
KEYCHAIN_SERVICE = "Claude Code-credentials"
# Where Claude Code parks its own last reading. It carries the account it
# belongs to, which is what makes it worth reading rather than guessing.
CLAUDE_CONFIG_DIR = os.environ.get("CLAUDE_CONFIG_DIR")
CLAUDE_STATE = (Path(CLAUDE_CONFIG_DIR) if CLAUDE_CONFIG_DIR else Path.home()) / ".claude.json"
# Codex writes a line per event; the ones we want carry `rate_limits`.
CODEX_HOME = Path(os.environ.get("CODEX_HOME") or Path.home() / ".codex")
# How far back to look for the session that is running now. A rollout lands in
# the directory of the day it started, so a session opened last night and still
# going is not in today's.
CODEX_DAYS = 4
# The last of a rollout worth reading to find the newest rate limit line.
CODEX_TAIL = 256 * 1024

AGENTS = ("claude", "codex")
from . import STATE_DIR

CACHE = STATE_DIR / "quota-cache.json"

# The line the strip turns amber at. It is a warning and nothing else: a prompt
# somebody typed is never held back for it, because the window is theirs to
# spend down to the last percent.
DEFAULT_THRESHOLD = 85.0

# What counts as actually out. The endpoint reports a locked window outright;
# short of that, a percentage this high means the next turn is the one that
# gets cut off, and only then is there anything worth waiting for.
EXHAUSTED = 99.0

# Backoff when a bucket is exhausted but reports no reset time.
BLIND_BACKOFF_SECONDS = 15 * 60


class QuotaError(RuntimeError):
    pass


@dataclass(frozen=True)
class Bucket:
    name: str
    utilization: float
    resets_at: datetime | None
    locked_reason: str | None

    def is_expired(self, now: datetime = None) -> bool:
        """Whether this window has since rolled over.

        A reading an agent wrote down is only true until the window it
        describes resets. Past that the percentage is not stale, it is wrong:
        a Codex pane that finished a turn at 98% an hour before its window
        reopened would otherwise read as full all afternoon, and hold every
        prompt behind a wall that is no longer there.
        """
        return self.resets_at is not None and self.resets_at <= (now or _now())

    def is_expired(self, now: datetime = None) -> bool:
        """Whether this window has since rolled over.

        A utilization figure describes one window. Once that window's reset has
        passed the number is about a window that no longer exists, and a full
        one says nothing about the empty one that replaced it - a Codex pane
        that finished a turn at 98% an hour before its window reopened would
        otherwise read as full all afternoon, and "100%, reset an hour ago"
        blocks forever while being the exact shape of a window that has already
        come back.
        """
        return self.resets_at is not None and self.resets_at <= (now or _now())

    def is_spent(self) -> bool:
        """Whether this window has nothing left in it.

        Not "nearly full": a window at 87% has 13% to give, and a queue that
        will not spend it is a queue that has stopped working for you. Only a
        window the provider has locked, or one within a percent of the top, is
        worth waiting out.
        """
        # A lock that was earned does not roll over on its own, so it is exempt
        # from expiry: an account shut off for going over stays shut off until
        # somebody sees to it. A window the plan never included is locked from
        # the day it was born and has nothing to do with what anybody spent,
        # which is why the usage on it is what tells the two apart.
        if self.locked_reason is not None:
            return self.utilization > 0
        if self.is_expired():
            return False
        return self.utilization >= EXHAUSTED

    def is_blocking(self, threshold: float = EXHAUSTED) -> bool:
        return self.is_spent()


@dataclass(frozen=True)
class Quota:
    buckets: tuple[Bucket, ...]
    fetched_at: datetime
    stale: bool
    """True when nobody asked the API just now: a cache, or the agent's own note."""

    agent: str = "claude"
    source: str = "api"
    """`api` asked and was told; `cache` is our own last answer; `observed` is
    what the agent itself wrote down, which is as fresh as its last turn."""

    account: str | None = None
    """Which account the reading is about, when the source says so."""

    reason: str | None = None
    """Why the live read failed, when `stale`. Worth showing: the usual cause is
    a signed-out token, which nothing here can fix and a person can."""

    def get(self, name: str) -> Bucket | None:
        return next((b for b in self.buckets if b.name == name), None)

    @property
    def expired(self) -> bool:
        """True when this is a cached reading too old to decide anything with.

        Only ever true while the endpoint is unreachable, which is the one case
        where the cache has no way of catching up. A bucket that never reported
        a reset time cannot age out on its own, so the cache as a whole has to.
        """
        return self.stale and _now() - self.fetched_at > _seconds(BLIND_BACKOFF_SECONDS)

    def spent(self) -> list[Bucket]:
        """The windows with nothing left in them, as best we can tell.

        An expired cache says nothing. Holding on a reading we know is too old
        to be true is the failure that has no way out: usage cannot be re-read
        to clear it, so the queue stays frozen until a person notices -- which
        is the entire thing it exists not to need. Admitting work on a stale
        all-clear costs one prompt that hits the wall and parks itself again,
        and that is the cheaper of the two mistakes by a very long way.
        """
        if self.expired:
            # A lock outlives the reading that found it. Unlike a full window it
            # does not come back on its own -- a plan limit or a billing problem
            # is still there in the morning -- so it is the one thing an old
            # reading is still allowed to say.
            return [b for b in self.buckets if b.locked_reason is not None]
        return [b for b in self.buckets if b.is_spent()]

    def blockers(self, threshold: float = DEFAULT_THRESHOLD) -> list[Bucket]:
        return self.spent()

    def resume_at(self, threshold: float = DEFAULT_THRESHOLD) -> datetime | None:
        """When the earliest spent window comes back, if it says.

        None means there is nothing to wait for - either nothing is spent, or
        what is spent never said when it reopens, and the caller has its own
        backoff for that. It used to answer "fifteen minutes from now" instead,
        which is a time that moves every time anybody asks: the phone showed
        22:40, then 22:41 a minute later, for a window that was not out at all.
        """
        resets = [b.resets_at for b in self.spent() if b.resets_at]
        return min(resets) if resets else None


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _seconds(n: float):
    from datetime import timedelta

    return timedelta(seconds=n)


def _parse_ts(raw: str | None) -> datetime | None:
    if not raw:
        return None
    try:
        return datetime.fromisoformat(raw).astimezone(timezone.utc)
    except ValueError:
        return None


def _keychain_credentials() -> str:
    """The credentials blob out of the login Keychain.

    `security` is the one doing the reading, so the first attempt raises a
    Keychain prompt; answering "Always Allow" is what makes this unattended.
    Until it is answered the read simply times out, which holds the queue for a
    sweep rather than failing it.
    """
    try:
        found = subprocess.run(
            ["security", "find-generic-password", "-s", KEYCHAIN_SERVICE, "-w"],
            capture_output=True, text=True, timeout=10,
        )
    except subprocess.TimeoutExpired as e:
        raise QuotaError("the Keychain did not answer; allow access to "
                         f"{KEYCHAIN_SERVICE!r}") from e
    except OSError as e:
        raise QuotaError(f"cannot run security(1): {e}") from e
    if found.returncode != 0 or not found.stdout.strip():
        raise QuotaError(f"no Claude credentials in {CREDENTIALS} or the "
                         f"Keychain item {KEYCHAIN_SERVICE!r}; run `claude` to sign in")
    return found.stdout


def _credentials() -> str:
    """Wherever Claude Code put its OAuth token on this machine."""
    try:
        return CREDENTIALS.read_text()
    except FileNotFoundError:
        if sys.platform == "darwin":
            return _keychain_credentials()
        raise QuotaError(f"no Claude credentials at {CREDENTIALS}") from None


def _access_token() -> str:
    try:
        creds = json.loads(_credentials())
    except json.JSONDecodeError as e:
        raise QuotaError("malformed credentials; run `claude` to sign in") from e

    token = creds.get("claudeAiOauth", {}).get("accessToken")
    if not token:
        raise QuotaError("no OAuth access token; run `claude` to sign in")
    return token


def _parse(payload: dict) -> tuple[Bucket, ...]:
    """Pull every window bucket out of the response.

    Buckets come and go by plan and by release (`seven_day_opus` is null on Pro
    but real elsewhere), so we take whatever has a `utilization` rather than
    hardcoding names. `extra_usage` has a different shape and is skipped.
    """
    buckets = []
    for name, value in sorted(payload.items()):
        if not isinstance(value, dict) or "utilization" not in value:
            continue
        util = value.get("utilization")
        if not isinstance(util, (int, float)):
            continue
        buckets.append(
            Bucket(
                name=name,
                utilization=float(util),
                resets_at=_parse_ts(value.get("resets_at")),
                locked_reason=value.get("locked_reason"),
            )
        )
    return tuple(buckets)


def _claude_observed(path: Path | None = None) -> Quota:
    """Claude Code's own last reading, out of `.claude.json`.

    It keeps `cachedUsageUtilization` in the same shape the endpoint answers
    with, stamped with the account it belongs to and when it was taken, and
    refreshes it as the session works. No token, no request, no Keychain.
    """
    path = path or CLAUDE_STATE
    try:
        blob = json.loads(path.read_text())
    except FileNotFoundError as e:
        raise QuotaError(f"no Claude state at {path}") from e
    except json.JSONDecodeError as e:
        raise QuotaError(f"unreadable Claude state at {path}") from e

    cached = blob.get("cachedUsageUtilization")
    if not isinstance(cached, dict) or not isinstance(cached.get("utilization"), dict):
        raise QuotaError("Claude has written down no usage yet")

    ms = cached.get("fetchedAtMs")
    fetched = (datetime.fromtimestamp(ms / 1000, timezone.utc)
               if isinstance(ms, (int, float)) else _now())
    return Quota(_parse(cached["utilization"]), fetched, stale=True,
                 agent="claude", source="observed", account=cached.get("accountUuid"))


# Codex measures in minutes; these are the two windows a subscription has, and
# naming them the way Claude's buckets are named keeps one vocabulary on screen.
CODEX_WINDOWS = {300: "five_hour", 10080: "seven_day"}


def _codex_window_name(minutes) -> str:
    if not isinstance(minutes, (int, float)) or minutes <= 0:
        return "window"
    minutes = int(minutes)
    if minutes in CODEX_WINDOWS:
        return CODEX_WINDOWS[minutes]
    if minutes % 1440 == 0:
        return f"{minutes // 1440}_day"
    if minutes % 60 == 0:
        return f"{minutes // 60}_hour"
    return f"{minutes}_minute"


def _codex_buckets(limits: dict) -> tuple[Bucket, ...]:
    buckets = []
    for key in ("primary", "secondary"):
        window = limits.get(key)
        if not isinstance(window, dict):
            continue
        used = window.get("used_percent")
        if not isinstance(used, (int, float)):
            continue
        resets = window.get("resets_at")
        buckets.append(Bucket(
            name=_codex_window_name(window.get("window_minutes")),
            utilization=float(used),
            resets_at=(datetime.fromtimestamp(resets, timezone.utc)
                       if isinstance(resets, (int, float)) else None),
            # Codex says what kind of wall it hit rather than that it is locked;
            # the percentage is what decides, so nothing is read as a lock.
            locked_reason=None,
        ))
    return tuple(buckets)


# What `/status` draws in a Codex pane. The percentage it prints is what is
# *left*, which is the opposite of everywhere else, and the reset is a wall
# clock time with no year on it.
RE_CODEX_LIMIT = re.compile(
    r"(?P<window>5h|weekly)\s+limit:.*?(?P<left>\d+(?:\.\d+)?)%\s*left"
    r"(?:.*?resets\s+(?P<at>\d{1,2}:\d{2})(?:\s+on\s+(?P<day>\d{1,2})\s+(?P<month>\w{3}))?)?",
    re.IGNORECASE)

CODEX_STATUS_WINDOWS = {"5h": "five_hour", "weekly": "seven_day"}

MONTHS = {m: i + 1 for i, m in enumerate(
    ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"])}


def _status_reset(at: str, day: str, month: str, now: datetime = None) -> datetime | None:
    """The wall clock time Codex prints, as an instant.

    It says "03:36 on 15 Sep" with no year and in local time. The year is
    whichever one makes the date near today, which is the only reading that is
    ever meant - a reset is days away at most.
    """
    if not at:
        return None
    now = now or datetime.now().astimezone()
    hour, minute = (int(part) for part in at.split(":"))
    if day and month and month[:3].lower() in MONTHS:
        when = now.replace(month=MONTHS[month[:3].lower()], day=int(day),
                           hour=hour, minute=minute, second=0, microsecond=0)
        # A December reset read in January belongs to the year just gone.
        if (when - now).days > 180:
            when = when.replace(year=when.year - 1)
        elif (now - when).days > 180:
            when = when.replace(year=when.year + 1)
    else:
        when = now.replace(hour=hour, minute=minute, second=0, microsecond=0)
        if when < now:
            when += timedelta(days=1)  # a time already past today is tomorrow's
    return when.astimezone(timezone.utc)


def parse_codex_status(text: str, now: datetime = None) -> tuple[Bucket, ...]:
    """The windows out of a `/status` breakdown on screen.

    This is the only reading of Codex that is current rather than as-of-a-turn:
    its rollout is only written when the model actually answers, so a window
    that reset while nobody was working still reads as full on disk. What the
    pane is showing was fetched when somebody asked for it.
    """
    buckets = {}
    for match in RE_CODEX_LIMIT.finditer(text or ""):
        name = CODEX_STATUS_WINDOWS[match.group("window").lower()]
        # "100% left" is an empty window, not a full one.
        left = float(match.group("left"))
        buckets[name] = Bucket(
            name=name,
            utilization=max(0.0, min(100.0, 100.0 - left)),
            resets_at=_status_reset(match.group("at"), match.group("day"),
                                    match.group("month"), now),
            locked_reason=None,
        )
    order = list(CODEX_STATUS_WINDOWS.values())
    return tuple(buckets[name] for name in order if name in buckets)


def _codex_rollouts(home: Path, days: int = CODEX_DAYS) -> list[Path]:
    """The rollouts worth looking in, newest first.

    A rollout is filed under the day its session started, so a session opened
    last night and still running is not in today's directory. Walking the whole
    tree would be thousands of files, so this walks back a few days and sorts
    what it finds by when it was last written to."""
    sessions = home / "sessions"
    found = []
    for day in sorted((d for d in sessions.glob("*/*/*") if d.is_dir()), reverse=True)[:days]:
        found.extend(f for f in day.glob("*.jsonl") if f.is_file())
    return sorted(found, key=lambda f: f.stat().st_mtime, reverse=True)


def _last_rate_limits(path: Path) -> tuple[dict, datetime] | None:
    """The newest `rate_limits` in a rollout, with the file's own timestamp.

    Read from the end: a long session is megabytes, and the line wanted is
    always near the bottom."""
    try:
        size = path.stat().st_size
        with path.open("rb") as fh:
            if size > CODEX_TAIL:
                fh.seek(size - CODEX_TAIL)
                fh.readline()  # drop the half line the seek landed in
            tail = fh.read().decode("utf-8", "replace")
    except OSError:
        return None

    for line in reversed(tail.splitlines()):
        if '"rate_limits"' not in line:
            continue
        try:
            event = json.loads(line)
        except json.JSONDecodeError:
            continue
        limits = _find_rate_limits(event)
        if limits:
            return limits, datetime.fromtimestamp(path.stat().st_mtime, timezone.utc)
    return None


def _find_rate_limits(event):
    """`rate_limits` moved between Codex versions, so look for it rather than
    knowing where it is."""
    if isinstance(event, dict):
        if isinstance(event.get("rate_limits"), dict):
            return event["rate_limits"]
        for value in event.values():
            found = _find_rate_limits(value)
            if found:
                return found
    return None


def _codex_observed(home: Path | None = None) -> Quota:
    """What Codex was told on its last turn, out of its session rollout."""
    home = home or CODEX_HOME
    for rollout in _codex_rollouts(home):
        found = _last_rate_limits(rollout)
        if not found:
            continue
        limits, written = found
        buckets = _codex_buckets(limits)
        if buckets:
            return Quota(buckets, written, stale=True, agent="codex",
                         source="observed", account=limits.get("limit_id"))
    raise QuotaError("no Codex session has reported a usage window yet")


def _write_cache(payload: dict) -> None:
    STATE_DIR.mkdir(parents=True, exist_ok=True)
    body = {"fetched_at": _now().isoformat(), "payload": payload}
    tmp = CACHE.with_suffix(".tmp")
    tmp.write_text(json.dumps(body))
    tmp.replace(CACHE)


def _read_cache(reason: str | None = None) -> Quota | None:
    try:
        body = json.loads(CACHE.read_text())
    except (FileNotFoundError, json.JSONDecodeError):
        return None
    fetched = _parse_ts(body.get("fetched_at")) or _now()
    return Quota(_parse(body.get("payload", {})), fetched, stale=True,
                 reason=reason, agent="claude", source="cache")


def fetch(timeout: float = 10.0) -> Quota:
    """Fetch live usage, falling back to the last good response.

    The access token lives ~6h. If the queue idles overnight the token can
    expire and this 401s. We deliberately do not refresh it ourselves --
    rewriting .credentials.json races with Claude Code. The cached reset
    timestamps stay valid across a pause, which is exactly when we need them,
    and the next launched session refreshes the token for us.

    That pause is also the trap: a token that expires overnight means every read
    from here on is the same cached reading, and if it happened to be taken at a
    full window then that full window is the answer forever. `Quota.expired` is
    what stops the queue believing it -- the fallback is only ever a stopgap,
    never a verdict that can outlive its own window.
    """
    req = urllib.request.Request(
        USAGE_URL,
        headers={
            "Authorization": f"Bearer {_access_token()}",
            "anthropic-beta": "oauth-2025-04-20",
            "Content-Type": "application/json",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            payload = json.loads(resp.read().decode())
    except urllib.error.HTTPError as e:
        # 401 is the overnight case and the only one a person can act on, so it
        # is named rather than folded in with "unreachable".
        reason = ("signed out -- run `claude` to sign in again"
                  if e.code in (401, 403) else f"usage endpoint said {e.code}")
        cached = _read_cache(reason)
        if cached is None:
            raise QuotaError(f"{reason} and no cached usage") from e
        return cached
    except (urllib.error.URLError, TimeoutError, json.JSONDecodeError, OSError) as e:
        cached = _read_cache(f"could not reach the usage endpoint: {e}")
        if cached is None:
            raise QuotaError(f"usage endpoint unreachable and no cache: {e}") from e
        return cached

    _write_cache(payload)
    return Quota(_parse(payload), _now(), stale=False, agent="claude", source="api")


def claude() -> Quota:
    """Ask Anthropic; fall back to what Claude Code wrote down.

    The endpoint is worth the round trip - it is current to the second and it
    is what the agent itself is priced against. But a missing token is not a
    reason to know nothing: Claude Code's own cached reading is the same
    numbers, as fresh as that account's last turn."""
    try:
        return fetch()
    except QuotaError as api_error:
        try:
            return _claude_observed()
        except QuotaError:
            raise api_error


def codex() -> Quota:
    """Codex publishes no usage endpoint, so it has to be watched instead.

    Two places to watch, and the fresher wins. Its rollout is written whenever
    the model answers, which makes it right about a session that is working and
    silent about one that is not. What a `/status` on screen says was fetched
    when somebody asked, which is the only reading that survives a window
    resetting while nobody was typing.
    """
    candidates = [q for q in (_noted.get("codex"), _rollout_or_none()) if q]
    live = [q for q in candidates if not all(b.is_expired() for b in q.buckets)]
    if not (live or candidates):
        return _codex_observed()  # raises the error worth reporting
    return max(live or candidates, key=lambda q: q.fetched_at)


def _rollout_or_none() -> Quota | None:
    try:
        return _codex_observed()
    except QuotaError:
        return None


# Readings somebody else obtained - parsed off a pane, which the gateway can
# reach and this module cannot.
_noted: dict = {}


def note(quota: Quota) -> None:
    """Remember a reading taken elsewhere, and let it be seen at once."""
    _noted[quota.agent] = quota
    with _memo_lock:
        _memo.pop(quota.agent, None)


def noted(agent: str) -> Quota | None:
    return _noted.get(agent)


SOURCES = {"claude": claude, "codex": codex}

_memo: dict[str, tuple[float, Quota]] = {}
_memo_lock = threading.Lock()
MEMO_TTL = 30.0


def current(agent: str = "claude", ttl: float = MEMO_TTL) -> Quota:
    """One agent's usage, with a short in-process memo.

    Every reading is an HTTPS round trip or a walk of a session directory. The
    phone polls this while the queue is open and the dispatcher asks before
    every delivery, so without a memo an active queue would hammer both.
    Utilization does not move fast enough for 30s to matter.
    """
    source = SOURCES.get(agent)
    if source is None:
        raise QuotaError(f"no usage to read for {agent or 'this agent'}")
    with _memo_lock:
        memo = _memo.get(agent)
        if memo is not None and time.monotonic() - memo[0] < ttl:
            return memo[1]
    quota = source()
    with _memo_lock:
        _memo[agent] = (time.monotonic(), quota)
    return quota
