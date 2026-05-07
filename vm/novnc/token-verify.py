#!/usr/bin/env python3
"""HMAC-SHA256 token verifier for noVNC URLs.

Tiny stdlib-only HTTP service that nginx delegates to via
`auth_request`. The dashboard signs URLs with the same shared secret
(see lib/interactive/signed-vnc-url.ts); this script verifies them
before nginx allows the WebSocket upgrade through to websockify.

We chose this over an in-nginx Lua HMAC because lua-resty-hmac
depends on luacrypto, which doesn't build against OpenSSL 3 on
modern Ubuntu. Pure Python keeps the whole thing buildless.

Usage (systemd unit):
    Environment=INTERACTIVE_VNC_HMAC_SECRET=<hex>
    ExecStart=/usr/bin/python3 /home/ubuntu/vnc-token-verify.py

The service listens on 127.0.0.1:8765 only — no network exposure.
"""

import base64
import hashlib
import hmac
import json
import os
import sys
import time
from http.server import BaseHTTPRequestHandler, HTTPServer
from urllib.parse import parse_qs, urlparse

SECRET_HEX = os.environ.get("INTERACTIVE_VNC_HMAC_SECRET", "")
SECRET = SECRET_HEX.encode("utf-8") if SECRET_HEX else b""
LISTEN_HOST = "127.0.0.1"
LISTEN_PORT = 8765


def b64url_decode(s: str) -> bytes:
    """Base64-URL decode without padding requirements."""
    s = s.replace("-", "+").replace("_", "/")
    pad = (4 - len(s) % 4) % 4
    return base64.b64decode(s + "=" * pad)


class VerifyHandler(BaseHTTPRequestHandler):
    # Don't spam stderr — this gets pulled by nginx auth_request on
    # every connection request, journalctl is verbose enough.
    def log_message(self, *args, **kwargs):
        pass

    def do_GET(self):
        if not SECRET:
            self._reply(500, "secret not set")
            return

        parsed = urlparse(self.path)
        if parsed.path != "/verify":
            self._reply(404, "not found")
            return

        params = parse_qs(parsed.query)
        token = (params.get("token") or [""])[0]
        port = (params.get("port") or [""])[0]
        if not token or not port:
            self._reply(401, "missing token or port")
            return

        try:
            header_b64, payload_b64, sig_b64 = token.split(".")
        except ValueError:
            self._reply(401, "malformed token")
            return

        signing_input = f"{header_b64}.{payload_b64}".encode("utf-8")
        expected = hmac.new(SECRET, signing_input, hashlib.sha256).digest()
        try:
            actual = b64url_decode(sig_b64)
        except Exception:
            self._reply(401, "bad signature encoding")
            return
        if not hmac.compare_digest(expected, actual):
            self._reply(401, "bad signature")
            return

        try:
            payload = json.loads(b64url_decode(payload_b64))
        except Exception:
            self._reply(401, "bad payload")
            return

        exp = int(payload.get("exp", 0) or 0)
        tok_port = payload.get("port")
        if exp < int(time.time()):
            self._reply(401, "expired")
            return
        if str(tok_port) != port:
            self._reply(401, "port mismatch")
            return

        # All checks passed — nginx proceeds with the proxy_pass to
        # websockify. We don't echo the token back; the body is
        # ignored by auth_request anyway.
        self._reply(200, "ok")

    def _reply(self, code: int, msg: str):
        self.send_response(code)
        self.send_header("Content-Type", "text/plain")
        self.send_header("Content-Length", str(len(msg)))
        self.end_headers()
        self.wfile.write(msg.encode("utf-8"))


def main():
    if not SECRET:
        print("INTERACTIVE_VNC_HMAC_SECRET not set in environment", file=sys.stderr)
        sys.exit(1)
    server = HTTPServer((LISTEN_HOST, LISTEN_PORT), VerifyHandler)
    print(f"vnc-token-verify listening on {LISTEN_HOST}:{LISTEN_PORT}")
    server.serve_forever()


if __name__ == "__main__":
    main()
