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
import ssl
import http.client
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


def _public_addresses(host: str, port: int) -> list:
    """Every address this name resolves to, or [] if any of them is not on the
    public internet.

    A name is not one address: it can resolve to several, and to different
    ones next time. Rejecting on any private answer is the conservative
    reading, and a real push service never has one.

    The addresses are handed back rather than just a verdict because checking
    a name and then connecting to it resolves it twice: whoever owns the
    domain can answer the check with a public address and the connection with
    127.0.0.1. Only an address that was actually checked may be dialled. All
    of them are kept so a host whose first answer is unreachable - an AAAA on
    a network with no v6 route - still has the others to fall back on."""
    try:
        infos = socket.getaddrinfo(host, port, proto=socket.IPPROTO_TCP)
    except OSError:
        return []
    if not infos:
        return []
    addresses = []
    for info in infos:
        address = info[4][0]
        try:
            ip = ipaddress.ip_address(address)
        except ValueError:
            return []
        if (ip.is_private or ip.is_loopback or ip.is_link_local
                or ip.is_reserved or ip.is_multicast or ip.is_unspecified):
            return []
        if address not in addresses:
            addresses.append(address)
    return addresses


def checked_target(endpoint: str):
    """The host, path and approved address to send to, or None to refuse.

    Endpoints arrive as client JSON and are later fetched by the server, so an
    unvalidated one is an SSRF primitive: anything that can POST to
    /api/push/subscribe could aim the gateway at a loopback or LAN address and
    have it fire on every agent completion - and /api/push/test hands back the
    status code it got, which is a port scanner with extra steps.

    So: https, a default port, and a host that resolves only to the public
    internet. `https` alone let 127.0.0.1, 10.0.0.5 and 169.254.169.254
    straight through."""
    try:
        parsed = urlparse(endpoint)
    except Exception:
        return None
    if parsed.scheme != "https" or not parsed.hostname:
        return None
    try:
        port = parsed.port or 443
    except ValueError:
        return None
    if port != 443:
        return None
    addresses = _public_addresses(parsed.hostname, port)
    if not addresses:
        return None
    path = parsed.path or "/"
    if parsed.query:
        path += "?" + parsed.query
    return parsed.hostname, port, path, addresses


def valid_endpoint(endpoint: str) -> bool:
    """Whether an endpoint is one this gateway is willing to fetch."""
    return checked_target(endpoint) is not None


class _PinnedHTTPSConnection(http.client.HTTPSConnection):
    """Dial the address the check approved, while still presenting the name:
    the Host header and the SNI stay the push service's, so its certificate
    verifies as usual, but a second DNS answer never gets a say in where the
    socket goes."""

    def __init__(self, host: str, address: str, **kwargs):
        super().__init__(host, **kwargs)
        self._address = address

    def connect(self):
        self.sock = socket.create_connection(
            (self._address, self.port), self.timeout, self.source_address)
        self.sock = self._context.wrap_socket(self.sock, server_hostname=self.host)


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
    target = checked_target(endpoint)
    if target is None:
        return 0
    host, port, path, addresses = target
    headers = {
        "Authorization": _vapid_header(endpoint),
        "TTL": str(ttl),
        "Urgency": "high",
        "Content-Length": "0",
    }
    context = ssl.create_default_context()
    for address in addresses:
        conn = _PinnedHTTPSConnection(
            host, address, port=port, timeout=10, context=context)
        try:
            conn.request("POST", path, body=b"", headers=headers)
            # The response is read here rather than followed: a 302 is the way
            # back in, and replaying the VAPID header at whatever it names -
            # plain http to something on this machine, say - is what the
            # address check above is for. Push services answer the endpoint
            # they gave us.
            return conn.getresponse().status
        except (OSError, http.client.HTTPException, TimeoutError):
            # An unreachable push service must not abort the whole broadcast
            # and strand every subscriber queued behind this one. Another
            # address for the same name might still answer.
            continue
        finally:
            conn.close()
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
