"""A deterministic stand-in model for rehearsals and offline demos.

It speaks the same provider contract as the real adapters, so every tool call
it makes runs for real in the sandbox and every event flows through the same
runner. It follows one scripted task (rate limiting for sample-repos/notes-api)
and reacts to what humans say: a steer mentioning the deprecated throttle
changes its approach, and the answer to its decision point picks the key
strategy. Progress is derived from the conversation itself (tool-call ids carry
the beat name), so it survives interrupts and server restarts.
"""
from __future__ import annotations

import asyncio
import re
import uuid
from typing import AsyncIterator

from .base import ProviderError, StreamEvent

TEST_CMD = "python -m unittest -v"

BEATS = [
    "explore", "plan", "read_server", "read_throttle", "read_tests", "baseline",
    "ask", "adjust", "write_mw", "wire", "wire_import", "write_tests", "run_tests", "wrap_up", "finish",
]


class ScriptedProvider:
    def __init__(self, id: str = "demo", speed: float = 1.0):
        self.id = id
        self.speed = max(0.05, speed)
        self.configured = True

    async def list_models(self) -> list[str]:
        return ["baton-demo"]

    async def complete(self, *, model, system, prompt, max_tokens=1024) -> str:
        raise ProviderError("the offline demo model does not summarize; using the built-in summarizer")

    # ------------------------------------------------------------------
    async def stream(self, *, model, system, messages, tools, max_tokens=4096) -> AsyncIterator[StreamEvent]:
        st = _State(messages)
        beat = st.next_beat()
        await self._pause(0.9)

        text, think, call = self._beat(beat, st)
        calls = call if isinstance(call, list) else ([call] if call else [])
        prefix = st.acknowledgement()
        if prefix and beat not in ("adjust",):
            text = f"{prefix}\n\n{text}" if text else prefix

        if think:
            for chunk in _chunks(think, 7):
                yield StreamEvent("thinking_delta", chunk)
                await self._pause(0.035)
        for chunk in _chunks(text, 4):
            yield StreamEvent("text_delta", chunk)
            await self._pause(0.03)
        for name, args in calls:
            yield StreamEvent("tool_call", data={"id": f"call_demo_{beat}_{uuid.uuid4().hex[:8]}", "name": name, "input": args})
        n_in = sum(len(str(m["content"])) for m in messages) // 4
        yield StreamEvent("usage", data={"input_tokens": n_in, "output_tokens": (len(text) + len(think)) // 4 + 40, "cached_tokens": 0})
        yield StreamEvent("done", data={"stop_reason": "tool_use" if calls else "end_turn"})

    async def _pause(self, seconds: float) -> None:
        await asyncio.sleep(seconds / self.speed)

    # ------------------------------------------------------------------
    def _beat(self, beat: str, st: "_State") -> tuple[str, str, tuple[str, dict] | list[tuple[str, dict]] | None]:
        legacy = not st.deprecated_feedback
        if beat == "explore":
            return "I'll start by getting oriented in the repository.", "", ("list_files", {"path": "."})
        if beat == "plan":
            return (
                "This is a small WSGI service: `app/server.py` composes middleware around the core app, "
                "and tests call the app in-process. Here's my plan.",
                "",
                ("update_plan", {"steps": _plan(0, legacy=True)}),
            )
        if beat == "read_server":
            return "", "", ("read_file", {"path": "app/server.py"})
        if beat == "read_throttle":
            return (
                "Middleware is composed in `build_app()`. There's already a throttle module in "
                "`app/middleware/`; checking whether it can be reused.",
                "",
                ("read_file", {"path": "app/middleware/legacy_throttle.py"}),
            )
        if beat == "read_tests":
            return (
                "`LegacyThrottle` already counts requests per window, so the shortest path is to extend it "
                "with per-client buckets. First, how are tests structured?",
                "",
                ("read_file", {"path": "tests/test_notes.py"}),
            )
        if beat == "baseline":
            return "Tests use a shared `call()` helper. Running the suite for a baseline.", "", ("run_command", {"command": TEST_CMD})
        if beat == "ask":
            return (
                "Baseline is green: 5 tests pass. One product decision before I write code.",
                "The task doesn't say who a 'client' is. Keying on the API key is standard for authenticated "
                "APIs, but anonymous traffic would then share one bucket. IP-based limits are simpler but "
                "punish users behind a shared NAT. This is the team's call, not mine.",
                [
                    ("update_plan", {"steps": _plan(1, legacy=True)}),
                    ("ask_humans", {
                        "question": "How should clients be identified for rate limiting?",
                        "options": [
                            "Per API key (X-API-Key), falling back to client IP",
                            "Per client IP only",
                            "One global limit for the whole service",
                        ],
                    }),
                ],
            )
        if beat == "adjust":
            strategy = st.strategy
            label = {"key": "per API key, falling back to IP", "ip": "per client IP", "global": "one global limit"}[strategy]
            if st.deprecated_feedback:
                who = st.deprecated_feedback
                text = (
                    f"Thanks {who}, that changes the approach. `LegacyThrottle` holds one global lock and sleeps "
                    "the worker, so building on it would inherit both problems. I'll leave it untouched and write "
                    f"a standalone token-bucket middleware instead, keyed {label}, returning `429` with `Retry-After`."
                )
            else:
                text = f"Going with {label}. I'll extend `LegacyThrottle` with per-client token buckets."
            ack = st.acknowledgement(skip_deprecated=True)
            if ack:
                text = f"{ack}\n\n{text}"
            return text, "", ("update_plan", {"steps": _plan(2, legacy=legacy)})
        if beat == "write_mw":
            return "", "", ("write_file", {"path": "app/middleware/rate_limit.py", "content": _middleware(legacy)})
        if beat == "wire":
            return (
                "Wiring it in as the outermost middleware, so rejected requests never reach the app.",
                "",
                [("update_plan", {"steps": _plan(3, legacy=not st.deprecated_feedback)}), ("edit_file", {
                    "path": "app/server.py",
                    "old_str": "    app = RequestLogger(app)\n    return app\n",
                    "new_str": "    app = RequestLogger(app)\n"
                    f"    app = RateLimiter(app, capacity=60, refill_rate=1.0, key_func={_key_func(st.strategy)})\n"
                    "    return app\n",
                })],
            )
        if beat == "wire_import":
            return (
                "",
                "",
                ("edit_file", {
                    "path": "app/server.py",
                    "old_str": "from app.middleware.logging import RequestLogger\n",
                    "new_str": "from app.middleware.logging import RequestLogger\n"
                    f"from app.middleware.rate_limit import RateLimiter, {_key_func(st.strategy)}\n",
                }),
            )
        if beat == "write_tests":
            return (
                "Now tests: under the limit, over the limit, isolation between clients, refill over time, "
                "the health-check exemption, and that the real app is wired up.",
                "",
                [("update_plan", {"steps": _plan(4, legacy=legacy)}),
                 ("write_file", {"path": "tests/test_rate_limit.py", "content": _tests(st.strategy)})],
            )
        if beat == "run_tests":
            return "", "", ("run_command", {"command": TEST_CMD})
        if beat == "wrap_up":
            return "All 11 tests pass, including 6 new ones for rate limiting.", "", ("update_plan", {"steps": _plan(5, legacy=legacy)})
        if beat == "finish":
            summary = (
                "Added per-client rate limiting to the Notes API.\n"
                f"- `app/middleware/rate_limit.py`: token-bucket `RateLimiter` ({st.strategy} strategy), 429 + Retry-After, "
                "X-RateLimit headers, /health exempt\n"
                "- `app/server.py`: limiter wired as the outermost middleware\n"
                "- `tests/test_rate_limit.py`: 6 new tests; full suite green (11 tests)"
            )
            if st.deprecated_feedback:
                summary += "\n- Left `LegacyThrottle` untouched per ADR 0007"
            return "Done. Summary below.", "", ("finish", {"summary": summary})
        # Past the end of the script: acknowledge and hand control back.
        return (
            "I'm the offline demo model, so I can only run the rehearsed rate-limiting task. Switch this "
            "session to Claude, an OpenAI model, or a local model from the model menu and I'll pick up from here "
            "with the full history.",
            "",
            None,
        )


# ----------------------------------------------------------------------
class _State:
    """What the scripted agent can infer from the conversation so far."""

    def __init__(self, messages: list[dict]):
        self.done: set[str] = set()
        self.human: list[tuple[str, str]] = []  # (author, text)
        self.answer = ""
        self.trailing: list[tuple[str, str]] = []
        ask_ids: set[str] = set()
        for i, m in enumerate(messages):
            for b in m["content"]:
                if b["type"] == "tool_call":
                    mm = re.match(r"call_demo_([a-z_]+?)_[0-9a-f]{8}$", b["id"])
                    if mm:
                        self.done.add(mm.group(1))
                    if b["name"] == "ask_humans":
                        ask_ids.add(b["id"])
                elif b["type"] == "tool_result" and b["id"] in ask_ids:
                    self.answer = b["output"]
                elif b["type"] == "text" and m["role"] == "user" and i > 0:
                    self.human.append(_author(b["text"]))
        last = messages[-1] if messages else None
        if last and last["role"] == "user" and len(messages) > 1:
            self.trailing = [_author(b["text"]) for b in last["content"] if b["type"] == "text"]

    def next_beat(self) -> str:
        for b in BEATS:
            if b not in self.done:
                return b
        return "after"

    @property
    def deprecated_feedback(self) -> str:
        for who, text in self.human:
            if re.search(r"deprecat|legacy|adr|don'?t (use|build)", text, re.I):
                return who
        return ""

    @property
    def strategy(self) -> str:
        a = self.answer.lower()
        if "global" in a:
            return "global"
        if "ip" in a and "key" not in a:
            return "ip"
        return "key"

    def acknowledgement(self, skip_deprecated: bool = False) -> str:
        notes = []
        for who, text in self.trailing:
            if skip_deprecated and re.search(r"deprecat|legacy|adr", text, re.I):
                continue
            if text.startswith("(") or not text.strip():
                continue
            notes.append(f"Noted, {who}: “{_clip(text)}”")
        return "\n".join(notes)


def _author(text: str) -> tuple[str, str]:
    m = re.match(r"\[([^,\]]+)[^\]]*\]:\s*(.*)", text, re.S)
    return (m.group(1), m.group(2)) if m else ("you", text)


def _clip(s: str, n: int = 120) -> str:
    s = " ".join(s.split())
    return s if len(s) <= n else s[: n - 1] + "…"


def _chunks(s: str, n: int):
    words = re.findall(r"\S+\s*|\s+", s)
    for i in range(0, len(words), n):
        yield "".join(words[i : i + n])


def _plan(stage: int, legacy: bool) -> list[dict]:
    impl = "Extend LegacyThrottle with per-client buckets" if legacy else "Write a new token-bucket middleware"
    titles = [
        "Explore the codebase and middleware chain",
        "Decide how clients are identified",
        impl,
        "Wire the limiter into build_app()",
        "Write tests and run the full suite",
    ]
    steps = []
    for i, t in enumerate(titles):
        status = "done" if i < stage else ("in_progress" if i == stage else "pending")
        steps.append({"title": t, "status": status})
    return steps


def _key_func(strategy: str) -> str:
    return {"key": "client_key", "ip": "ip_key", "global": "global_key"}[strategy]


def _middleware(legacy: bool) -> str:
    base_import = "from app.middleware.legacy_throttle import LegacyThrottle\n\n\n" if legacy else "\n"
    cls = "class RateLimiter(LegacyThrottle):" if legacy else "class RateLimiter:"
    init_super = "        super().__init__(app)\n" if legacy else ""
    doc = (
        "Builds on LegacyThrottle and replaces its global counter with per-client buckets."
        if legacy
        else "Standalone: does not share state or locking with LegacyThrottle (see ADR 0007)."
    )
    return f'''"""Per-client rate limiting (token bucket).

Each client gets a bucket of `capacity` tokens that refills at `refill_rate`
tokens per second. A request that finds its bucket empty gets 429 Too Many
Requests with a Retry-After header; workers are never blocked.

{doc}
"""
import math
import threading
import time
{base_import}
def client_key(environ):
    """Identify the caller by API key, falling back to client IP."""
    api_key = environ.get("HTTP_X_API_KEY")
    if api_key:
        return "key:" + api_key
    return ip_key(environ)


def ip_key(environ):
    return "ip:" + environ.get("REMOTE_ADDR", "unknown")


def global_key(environ):
    return "global"


{cls}
    def __init__(self, app, capacity=60, refill_rate=1.0, key_func=client_key,
                 clock=time.monotonic, exempt_paths=("/health",)):
{init_super}        self.app = app
        self.capacity = capacity
        self.refill_rate = refill_rate
        self.key_func = key_func
        self.clock = clock
        self.exempt_paths = set(exempt_paths)
        self._buckets = {{}}
        self._bucket_lock = threading.Lock()

    def _take(self, key):
        """Spend one token. Returns (allowed, tokens_left, seconds_until_next_token)."""
        now = self.clock()
        with self._bucket_lock:
            tokens, last = self._buckets.get(key, (self.capacity, now))
            tokens = min(self.capacity, tokens + (now - last) * self.refill_rate)
            if tokens >= 1:
                self._buckets[key] = (tokens - 1, now)
                return True, tokens - 1, 0.0
            self._buckets[key] = (tokens, now)
            return False, tokens, (1 - tokens) / self.refill_rate

    def __call__(self, environ, start_response):
        if environ.get("PATH_INFO") in self.exempt_paths:
            return self.app(environ, start_response)
        allowed, remaining, wait = self._take(self.key_func(environ))
        limit_headers = [
            ("X-RateLimit-Limit", str(self.capacity)),
            ("X-RateLimit-Remaining", str(int(remaining))),
        ]
        if not allowed:
            body = b'{{"error": "rate limit exceeded"}}'
            start_response("429 Too Many Requests", [
                ("Content-Type", "application/json"),
                ("Content-Length", str(len(body))),
                ("Retry-After", str(max(1, math.ceil(wait)))),
            ] + limit_headers)
            return [body]

        def _start_response(status, headers, exc_info=None):
            return start_response(status, list(headers) + limit_headers, exc_info)

        return self.app(environ, _start_response)
'''


def _tests(strategy: str) -> str:
    if strategy == "ip":
        a, b = '{"REMOTE_ADDR": "10.0.0.1"}', '{"REMOTE_ADDR": "10.0.0.2"}'
        iso = "test_buckets_are_per_client_ip"
        iso_assert = "self.assertEqual(status, 200)"
    elif strategy == "global":
        a, b = '{"REMOTE_ADDR": "10.0.0.1"}', '{"REMOTE_ADDR": "10.0.0.2"}'
        iso = "test_limit_is_shared_by_all_clients"
        iso_assert = "self.assertEqual(status, 429)"
    else:
        a, b = '{"HTTP_X_API_KEY": "alice"}', '{"HTTP_X_API_KEY": "bob"}'
        iso = "test_buckets_are_per_api_key"
        iso_assert = "self.assertEqual(status, 200)"
    return f'''import unittest

from app.middleware.rate_limit import RateLimiter, {_key_func(strategy)}
from app.server import build_app
from tests.helpers import call

A = {a}
B = {b}


class FakeClock:
    def __init__(self):
        self.now = 1000.0

    def __call__(self):
        return self.now


def ok_app(environ, start_response):
    start_response("200 OK", [("Content-Type", "application/json")])
    return [b'{{"ok": true}}']


class RateLimiterTests(unittest.TestCase):
    def setUp(self):
        self.clock = FakeClock()
        self.app = RateLimiter(ok_app, capacity=3, refill_rate=1.0, key_func={_key_func(strategy)}, clock=self.clock)

    def exhaust(self, headers):
        for _ in range(3):
            call(self.app, "GET", "/notes", headers=headers)

    def test_allows_requests_under_the_limit(self):
        for remaining in (2, 1, 0):
            status, headers, _ = call(self.app, "GET", "/notes", headers=A)
            self.assertEqual(status, 200)
            self.assertEqual(headers["X-RateLimit-Remaining"], str(remaining))

    def test_rejects_with_429_and_retry_after(self):
        self.exhaust(A)
        status, headers, body = call(self.app, "GET", "/notes", headers=A)
        self.assertEqual(status, 429)
        self.assertEqual(headers["Retry-After"], "1")
        self.assertEqual(body["error"], "rate limit exceeded")

    def {iso}(self):
        self.exhaust(A)
        status, _, _ = call(self.app, "GET", "/notes", headers=B)
        {iso_assert}

    def test_tokens_refill_over_time(self):
        self.exhaust(A)
        self.clock.now += 1.0
        status, _, _ = call(self.app, "GET", "/notes", headers=A)
        self.assertEqual(status, 200)

    def test_health_check_is_exempt(self):
        self.exhaust(A)
        status, _, _ = call(self.app, "GET", "/health", headers=A)
        self.assertEqual(status, 200)

    def test_app_is_rate_limited(self):
        status, headers, _ = call(build_app(), "GET", "/notes")
        self.assertEqual(status, 200)
        self.assertIn("X-RateLimit-Limit", headers)
'''
