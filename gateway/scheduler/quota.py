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
        return self.locked_reason is not None or self.utilization >= threshold


@dataclass(frozen=True)
class Quota:
    buckets: tuple[Bucket, ...]
    fetched_at: datetime
    stale: bool
    """True when served from cache because the API was unreachable."""

    def get(self, name: str) -> Bucket | None:
        return next((b for b in self.buckets if b.name == name), None)

    def blockers(self, threshold: float = DEFAULT_THRESHOLD) -> list[Bucket]:
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


def _read_cache() -> Quota | None:
    try:
        body = json.loads(CACHE.read_text())
    except (FileNotFoundError, json.JSONDecodeError):
        return None
    fetched = _parse_ts(body.get("fetched_at")) or _now()
    return Quota(_parse(body.get("payload", {})), fetched, stale=True)


def fetch(timeout: float = 10.0) -> Quota:
    """Fetch live usage, falling back to the last good response.

    The access token lives ~6h. If the queue idles overnight the token can
    expire and this 401s. We deliberately do not refresh it ourselves --
    rewriting .credentials.json races with Claude Code. The cached reset
    timestamps stay valid across a pause, which is exactly when we need them,
    and the next launched session refreshes the token for us.
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
    except (urllib.error.URLError, TimeoutError, json.JSONDecodeError, OSError) as e:
        cached = _read_cache()
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
