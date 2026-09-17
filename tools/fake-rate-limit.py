#!/usr/bin/env python3
"""Stand in for the API, with nothing left in the window.

The wall is the one part of the queue that cannot be rehearsed by using the
app: a session limit arrives every few days, at whatever hour it likes. This
serves Claude Code the same thing the real API serves when a subscription runs
out -- 429, `anthropic-ratelimit-unified-status: rejected`, and a reset -- so
the agent draws its real limit banner and its real menu, on demand.

    python3 tools/fake-rate-limit.py --port 3011
    claude   # with ANTHROPIC_BASE_URL=http://127.0.0.1:3011

Nothing here talks to Anthropic; it is a wall with a door painted on it.
Standard library only, like the rest of the gateway.
"""

import argparse
import json
import time
from http.server import BaseHTTPRequestHandler, HTTPServer

RESET_IN = 90 * 60  # what the banner will say it is waiting for


class OutOfWindow(BaseHTTPRequestHandler):
    """Every model call is refused; everything else is waved through.

    Claude Code pings a few endpoints on startup and none of them are what is
    being tested, so only `/v1/messages` gets the wall. Answering the rest with
    an empty object keeps startup from failing for an unrelated reason and
    sending somebody off to debug the wrong thing.
    """

    protocol_version = "HTTP/1.1"

    def _send(self, code: int, body: dict, headers: dict = None) -> None:
        payload = json.dumps(body).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        for key, value in (headers or {}).items():
            self.send_header(key, value)
        self.end_headers()
        self.wfile.write(payload)

    def do_POST(self) -> None:
        length = int(self.headers.get("Content-Length") or 0)
        self.rfile.read(length)
        if "/v1/messages" not in self.path:
            return self._send(200, {})

        reset = int(time.time()) + RESET_IN
        self._send(429, {
            "type": "error",
            "error": {
                "type": "rate_limit_error",
                "message": "You have exceeded your account's rate limit.",
            },
        }, {
            # The subscription contract, read straight out of the agent's own
            # bundle: a status, the window it belongs to, and when it comes back.
            "anthropic-ratelimit-unified-status": "rejected",
            "anthropic-ratelimit-unified-reset": str(reset),
            "anthropic-ratelimit-unified-5h-status": "rejected",
            "anthropic-ratelimit-unified-5h-reset": str(reset),
            "anthropic-ratelimit-unified-fallback-status": "rejected",
            "retry-after": str(RESET_IN),
        })

    def do_GET(self) -> None:
        self._send(200, {})

    def log_message(self, fmt, *args):
        print(f"{self.command} {self.path} -> refused", flush=True)


def main() -> int:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--port", type=int, default=3011)
    args = p.parse_args()
    print(f"out of window on http://127.0.0.1:{args.port}", flush=True)
    HTTPServer(("127.0.0.1", args.port), OutOfWindow).serve_forever()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
