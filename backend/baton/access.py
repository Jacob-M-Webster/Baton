"""An optional shared access code for hosted deployments (BATON_ACCESS_CODE).

Identity in Baton is just a typed-in name, and a session's driver (and its agent) can run commands on the
server. So anything reachable from the internet sits behind one shared code. Entering it once sets a
signed cookie; the browser sends that on every request and on WebSocket handshakes. External agents keep
their per-session ingest token, or send the code in an `X-Baton-Access` header.
"""
from __future__ import annotations

import hashlib
import hmac
import json
import re
import time

from starlette.requests import cookie_parser

COOKIE = "baton_access"
# The unlock endpoint, and Stripe's webhook (verified by its own signature instead).
OPEN = {"/api/access", "/api/billing/webhook"}
# External agents already authenticate these with their session's ingest token.
TOKEN_AUTH = re.compile(r"^/api/sessions/[^/]+/(ingest|inbox)$")


def token_for(code: str) -> str:
    return hmac.new(code.encode(), b"baton-access-v1", hashlib.sha256).hexdigest()


def granted(scope: dict, code: str) -> bool:
    headers = {k.decode("latin-1").lower(): v.decode("latin-1") for k, v in scope.get("headers", [])}
    sent = headers.get("x-baton-access")
    if sent and hmac.compare_digest(sent, code):
        return True
    cookie = cookie_parser(headers.get("cookie", "")).get(COOKIE, "")
    return bool(cookie) and hmac.compare_digest(cookie, token_for(code))


class AccessGate:
    """ASGI middleware: every /api route except the unlock endpoint needs the code (the static web app doesn't)."""

    def __init__(self, app, code: str | None):
        self.app = app
        self.code = code or None

    async def __call__(self, scope, receive, send):
        if not self.code or scope["type"] not in ("http", "websocket"):
            return await self.app(scope, receive, send)
        path = scope["path"]
        if not path.startswith("/api/") or path in OPEN or TOKEN_AUTH.match(path) or granted(scope, self.code):
            return await self.app(scope, receive, send)
        if scope["type"] == "websocket":
            await send({"type": "websocket.close", "code": 4401, "reason": "access code required"})
            return
        body = json.dumps({"error": "Enter the access code to use Baton", "access_required": True}).encode()
        await send({"type": "http.response.start", "status": 401,
                    "headers": [(b"content-type", b"application/json"), (b"content-length", str(len(body)).encode())]})
        await send({"type": "http.response.body", "body": body})


class Attempts:
    """Slows down guessing: at most `limit` wrong codes per client address per window."""

    def __init__(self, limit: int = 10, window: float = 300.0):
        self.limit, self.window = limit, window
        self.failures: dict[str, list[float]] = {}

    def blocked(self, who: str) -> bool:
        now = time.monotonic()
        recent = [t for t in self.failures.get(who, []) if now - t < self.window]
        self.failures[who] = recent
        return len(recent) >= self.limit

    def fail(self, who: str) -> None:
        self.failures.setdefault(who, []).append(time.monotonic())
