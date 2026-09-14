"""Live Claude subscription usage, read from the same endpoint Claude Code uses.

Claude Code resolves its own limits via `fetchUtilization: GET /api/oauth/usage`.
Calling it costs no tokens, so we can poll it freely and schedule against real
reset timestamps instead of inferring windows from failures.
"""

from __future__ import annotations

import json
import threading
import time
import urllib.error
import urllib.request
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path

USAGE_URL = "https://api.anthropic.com/api/oauth/usage"
CREDENTIALS = Path.home() / ".claude" / ".credentials.json"
from . import STATE_DIR

CACHE = STATE_DIR / "quota-cache.json"

# How full a window may get before we stop admitting new work. Leaves headroom
# so a task that starts just under the line can still finish its turn.
DEFAULT_THRESHOLD = 85.0

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

    def is_blocking(self, threshold: float) -> bool:
        if self.locked_reason is not None:
            return True
        # A utilization figure describes one window. Once that window's reset
        # has passed, the number is about a window that no longer exists, and a
        # full one says nothing about the empty one that replaced it. This is
        # only ever true of a cached reading -- and it is the reading a queue
        # gets stuck on, because "100%, reset an hour ago" blocks forever while
        # being the exact shape of a window that has already reopened.
        if self.resets_at is not None and self.resets_at <= _now():
            return False
        return self.utilization >= threshold


@dataclass(frozen=True)
class Quota:
    buckets: tuple[Bucket, ...]
    fetched_at: datetime
    stale: bool
    """True when served from cache because the API was unreachable."""

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

    def blockers(self, threshold: float = DEFAULT_THRESHOLD) -> list[Bucket]:
        """The windows that are full, as best we can tell.

        An expired cache blocks nothing. Holding on a reading we know is too old
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
        return [b for b in self.buckets if b.is_blocking(threshold)]

    def resume_at(self, threshold: float = DEFAULT_THRESHOLD) -> datetime | None:
        """When the earliest blocking window frees up.

        None means nothing is blocking. A blocking bucket with no reset time
        yields a blind backoff instead, so we never wait forever on one.
        """
        blockers = self.blockers(threshold)
        if not blockers:
            return None
        resets = [b.resets_at for b in blockers if b.resets_at]
        if not resets:
            return _now() + _seconds(BLIND_BACKOFF_SECONDS)
        return max(min(resets), _now())


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


def _access_token() -> str:
    try:
        creds = json.loads(CREDENTIALS.read_text())
    except FileNotFoundError as e:
        raise QuotaError(f"no Claude credentials at {CREDENTIALS}") from e
    except json.JSONDecodeError as e:
        raise QuotaError(f"malformed credentials at {CREDENTIALS}") from e

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
    return Quota(_parse(body.get("payload", {})), fetched, stale=True, reason=reason)


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
    return Quota(_parse(payload), _now(), stale=False)


_memo: tuple[float, Quota] | None = None
_memo_lock = threading.Lock()
MEMO_TTL = 30.0


def current(ttl: float = MEMO_TTL) -> Quota:
    """`fetch` with a short in-process memo.

    Every fetch is an HTTPS round trip. The phone polls this while the queue is
    open and the dispatcher asks before every delivery, so without a memo an
    active queue would hammer the endpoint. Utilization does not move fast
    enough for 30s to matter.
    """
    global _memo
    with _memo_lock:
        if _memo is not None and time.monotonic() - _memo[0] < ttl:
            return _memo[1]
        quota = fetch()
        _memo = (time.monotonic(), quota)
        return quota
