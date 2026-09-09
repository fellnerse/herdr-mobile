#!/usr/bin/env python3
"""
Web Push (VAPID) for SheepIt, using only the standard library plus the
openssl binary.

Two deliberate constraints shape this module:

* Python's stdlib has no ECDSA, so the ES256 signature for the VAPID JWT is
  produced by shelling out to `openssl` and converting its DER output to the
  raw r||s form JWT requires.
* Encrypting a push payload needs ECDH + AES-GCM, which the stdlib also
  cannot do. Payload-less pushes are legal, so we send none: the service
  worker fetches /api/agents when it wakes and builds the notification from
  live data. That removes the encryption problem entirely.
"""

import os
import json
import time
import base64
import socket
import ipaddress
import threading
import contextlib
import subprocess
import urllib.request
import urllib.error
from pathlib import Path
from urllib.parse import urlparse

STATE_DIR = Path(os.environ.get("SHEEPIT_STATE_DIR", Path.home() / ".config/sheepit"))
KEY_PATH = STATE_DIR / "vapid_private.pem"
SUBS_PATH = STATE_DIR / "subscriptions.json"
# RFC 8292 wants a contact for the push service; a URL is as valid as a mailto.
VAPID_SUB = os.environ.get("SHEEPIT_PUSH_SUB", "https://github.com/mowolf/herdr-mobile")

# subscriptions.json is touched by request threads and the status watcher, so
# every read-modify-write goes through this lock.
_LOCK = threading.Lock()


def _is_public_host(host: str) -> bool:
    """Does every address this name resolves to sit on the public internet?

    A name is not one address: it can resolve to several, and to different
    ones next time. Rejecting on any private answer is the conservative
    reading, and a real push service never has one."""
    try:
        infos = socket.getaddrinfo(host, 443, proto=socket.IPPROTO_TCP)
    except OSError:
        return False
    if not infos:
        return False
    for info in infos:
        try:
            ip = ipaddress.ip_address(info[4][0])
        except ValueError:
            return False
        if (ip.is_private or ip.is_loopback or ip.is_link_local
                or ip.is_reserved or ip.is_multicast or ip.is_unspecified):
            return False
    return True


def valid_endpoint(endpoint: str) -> bool:
    """Endpoints arrive as client JSON and are later fetched by the server, so
    an unvalidated one is an SSRF primitive: anything that can POST to
    /api/push/subscribe could aim the gateway at a loopback or LAN address and
    have it fire on every agent completion - and /api/push/test hands back the
    status code it got, which is a port scanner with extra steps.

    So: https, a default port, and a host that resolves only to the public
    internet. `https` alone let 127.0.0.1, 10.0.0.5 and 169.254.169.254
    straight through."""
    try:
        parsed = urlparse(endpoint)
    except Exception:
        return False
    if parsed.scheme != "https" or not parsed.hostname:
        return False
    try:
        if parsed.port not in (None, 443):
            return False
    except ValueError:
        return False
    return _is_public_host(parsed.hostname)


class _NoRedirects(urllib.request.HTTPRedirectHandler):
    """A 302 is the way back in: urlopen would follow it without re-checking
    the target and replay the VAPID Authorization header at whatever it names,
    including plain http to something on this machine. Push services answer
    the endpoint they gave us, so nothing legitimate is lost."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


_OPENER = urllib.request.build_opener(_NoRedirects)


@contextlib.contextmanager
def _private_umask():
    """Create files private from the first byte. chmod() afterwards leaves a
    window - short, but it recurs on every subscription write."""
    old = os.umask(0o077)
    try:
        yield
    finally:
        os.umask(old)


def _ensure_state_dir() -> None:
    STATE_DIR.mkdir(parents=True, exist_ok=True)
    with contextlib.suppress(OSError):
        STATE_DIR.chmod(0o700)


def b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


def ensure_keys() -> None:
    """Generate the VAPID keypair once, readable only by this user."""
    _ensure_state_dir()
    if KEY_PATH.exists():
        return
    with _private_umask():
        subprocess.run(
            ["openssl", "ecparam", "-genkey", "-name", "prime256v1", "-noout", "-out", str(KEY_PATH)],
            check=True, capture_output=True,
        )
    KEY_PATH.chmod(0o600)


def public_key_b64() -> str:
    """The uncompressed P-256 point (0x04||X||Y) the browser needs."""
    ensure_keys()
    der = subprocess.run(
        ["openssl", "ec", "-in", str(KEY_PATH), "-pubout", "-outform", "DER"],
        check=True, capture_output=True,
    ).stdout
    return b64url(der[-65:])


def _der_to_raw(der: bytes) -> bytes:
    """SEQUENCE{INTEGER r, INTEGER s} -> r||s, each left-padded to 32 bytes."""
    if not der or der[0] != 0x30:
        raise ValueError("not a DER sequence")
    idx = 2 if der[1] < 0x80 else 2 + (der[1] & 0x7F)
    out = b""
    for _ in range(2):
        if der[idx] != 0x02:
            raise ValueError("expected INTEGER")
        length = der[idx + 1]
        value = der[idx + 2: idx + 2 + length].lstrip(b"\x00")
        out += value.rjust(32, b"\x00")
        idx += 2 + length
    return out


def _sign_es256(message: bytes) -> bytes:
    ensure_keys()
    der = subprocess.run(
        ["openssl", "dgst", "-sha256", "-sign", str(KEY_PATH)],
        input=message, check=True, capture_output=True,
    ).stdout
    return _der_to_raw(der)


def _vapid_header(endpoint: str) -> str:
    origin = urlparse(endpoint)
    header = b64url(json.dumps({"typ": "JWT", "alg": "ES256"}, separators=(",", ":")).encode())
    claims = b64url(json.dumps({
        "aud": f"{origin.scheme}://{origin.netloc}",
        "exp": int(time.time()) + 12 * 3600,
        "sub": VAPID_SUB,
    }, separators=(",", ":")).encode())
    signing_input = f"{header}.{claims}".encode()
    jwt = f"{header}.{claims}.{b64url(_sign_es256(signing_input))}"
    return f"vapid t={jwt}, k={public_key_b64()}"


def _read_subs() -> list:
    try:
        data = json.loads(SUBS_PATH.read_text())
        return data if isinstance(data, list) else []
    except Exception:
        return []


def _write_subs(subs: list) -> None:
    """Atomic swap: a crash mid-write must not leave a truncated file behind."""
    _ensure_state_dir()
    tmp = SUBS_PATH.with_suffix(".json.tmp")
    with contextlib.suppress(FileNotFoundError):
        os.unlink(tmp)
    fd = os.open(tmp, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
    with os.fdopen(fd, "w") as f:
        f.write(json.dumps(subs, indent=2))
    os.replace(tmp, SUBS_PATH)


def load_subs() -> list:
    with _LOCK:
        return _read_subs()


def save_subs(subs: list) -> None:
    with _LOCK:
        _write_subs(subs)


def add_sub(sub: dict) -> int:
    if not valid_endpoint(sub.get("endpoint", "")):
        raise ValueError("endpoint must be an https URL on the public internet")
    with _LOCK:
        subs = [s for s in _read_subs() if s.get("endpoint") != sub.get("endpoint")]
        subs.append(sub)
        _write_subs(subs)
        return len(subs)


def remove_sub(endpoint: str) -> int:
    with _LOCK:
        subs = [s for s in _read_subs() if s.get("endpoint") != endpoint]
        _write_subs(subs)
        return len(subs)


def send_one(sub: dict, ttl: int = 120) -> int:
    """Return the push service's status code; 404/410 mean the sub is dead.
    0 means the request never completed, which says nothing about the
    subscription's validity - so it is never treated as a reason to drop it."""
    endpoint = sub.get("endpoint", "")
    if not valid_endpoint(endpoint):
        return 0
    req = urllib.request.Request(endpoint, data=b"", method="POST")
    req.add_header("Authorization", _vapid_header(endpoint))
    req.add_header("TTL", str(ttl))
    req.add_header("Urgency", "high")
    req.add_header("Content-Length", "0")
    try:
        with _OPENER.open(req, timeout=10) as res:
            return res.status
    except urllib.error.HTTPError as e:
        return e.code
    except (urllib.error.URLError, TimeoutError, OSError):
        # An unreachable push service must not abort the whole broadcast and
        # strand every subscriber queued behind this one.
        return 0


def broadcast() -> dict:
    """Push to every subscription, dropping only the ones the service says are
    gone. Network failures leave the subscription in place."""
    subs = load_subs()
    results = {}
    dead = set()
    for sub in subs:
        endpoint = sub.get("endpoint", "")
        code = send_one(sub)
        results[endpoint[-24:]] = code
        if code in (404, 410):
            dead.add(endpoint)
    if dead:
        with _LOCK:
            _write_subs([s for s in _read_subs() if s.get("endpoint") not in dead])
    return results
