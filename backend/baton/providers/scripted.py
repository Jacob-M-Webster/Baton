"""A deterministic stand-in model for rehearsals and offline demos.

It speaks the same provider contract as the real adapters, so every tool call
it makes runs for real in the sandbox and every event flows through the same
runner. It follows one scripted task: starting from the empty sample-repos/demo,
it builds a small notes API with per-client rate limiting and tests. It reacts
to what humans say: feedback against its fixed-window plan (use a token bucket)
changes its approach, and the answer to its decision point picks the key
strategy. Progress is derived from the conversation itself (tool-call ids carry
the beat name), so it survives interrupts and server restarts.
"""
from __future__ import annotations

import asyncio
import json
import re
import uuid
from typing import AsyncIterator

from .base import ProviderError, StreamEvent

TEST_CMD = "python -m unittest -v"
UNSUPPORTED = (
    "I'm the offline demo model. I can only run the rehearsed task (a small notes API with rate limiting), so I "
    "won't pretend to do this one. Switch this session to Claude, Gemini, an OpenAI model or a local model from the "
    "model menu, and the next turn picks up from here."
)

BEATS = [
    "explore", "plan", "scaffold", "scaffold_tests", "baseline",
    "ask", "adjust", "write_mw", "wire", "wire_import", "write_tests", "run_tests", "wrap_up", "finish",
]
FIXED_MARK = "(fixed window)"  # in the limiter's docstring: lets a later turn see which one it wrote


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
        task = "".join(b.get("text", "") for b in messages[0]["content"]) if messages else ""
        if not re.search(r"rate.?limit", task, re.I):
            # Be honest rather than pretend: this model only knows the rehearsed task.
            await self._pause(0.6)
            for chunk in _chunks(UNSUPPORTED, 4):
                yield StreamEvent("text_delta", chunk)
                await self._pause(0.03)
            yield StreamEvent("done", data={"stop_reason": "end_turn"})
            return
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
            if name in ("write_file", "edit_file"):
                # Like a real model writing out a long tool call: viewers see what's being drafted.
                size = len(json.dumps(args))
                for frac in (0.2, 0.45, 0.7, 0.95):
                    yield StreamEvent("tool_progress", data={"name": name, "chars": int(size * frac), "target": args.get("path", "")})
                    await self._pause(0.35)
            yield StreamEvent("tool_call", data={"id": f"call_demo_{beat}_{uuid.uuid4().hex[:8]}", "name": name, "input": args})
        n_in = sum(len(str(m["content"])) for m in messages) // 4
        yield StreamEvent("usage", data={"input_tokens": n_in, "output_tokens": (len(text) + len(think)) // 4 + 40, "cached_tokens": 0})
        yield StreamEvent("done", data={"stop_reason": "tool_use" if calls else "end_turn"})

    async def _pause(self, seconds: float) -> None:
        await asyncio.sleep(seconds / self.speed)

    # ------------------------------------------------------------------
    def _beat(self, beat: str, st: "_State") -> tuple[str, str, tuple[str, dict] | list[tuple[str, dict]] | None]:
        fixed = not st.algorithm_feedback
        if beat == "explore":
            return "I'll start by getting oriented in the repository.", "", ("list_files", {"path": "."})
        if beat == "plan":
            return (
                "The repository is empty apart from a README, so I'll build from scratch: a small WSGI notes API "
                "on the standard library, tests that call it in-process, then a fixed-window rate limiter (a request "
                "counter per client per window), the simplest thing that works. Here's my plan.",
                "",
                ("update_plan", {"steps": _plan(0, fixed=True)}),
            )
        if beat == "scaffold":
            return (
                "Starting with the app: an in-memory note store and a `build_app()` that composes the WSGI app, "
                "so middleware has one place to go.",
                "",
                [("write_file", {"path": "app/__init__.py", "content": ""}),
                 ("write_file", {"path": "app/store.py", "content": STORE}),
                 ("write_file", {"path": "app/server.py", "content": SERVER})],
            )
        if beat == "scaffold_tests":
            return (
                "Now a test helper that calls the app in-process, and tests for the notes endpoints.",
                "",
                [("write_file", {"path": "tests/__init__.py", "content": ""}),
                 ("write_file", {"path": "tests/helpers.py", "content": HELPERS}),
                 ("write_file", {"path": "tests/test_notes.py", "content": NOTES_TESTS})],
            )
        if beat == "baseline":
            return "Running the suite for a baseline before adding the limiter.", "", ("run_command", {"command": TEST_CMD})
        if beat == "ask":
            return (
                "Baseline is green: 5 tests pass. One product decision before I write the limiter.",
                "The task doesn't say who a 'client' is. Keying on the API key is standard for authenticated "
                "APIs, but anonymous traffic would then share one bucket. IP-based limits are simpler but "
                "punish users behind a shared NAT. This is the team's call, not mine.",
                [
                    ("update_plan", {"steps": _plan(1, fixed=True)}),
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
            if st.algorithm_feedback:
                who = st.algorithm_feedback
                text = (
                    f"Thanks {who}, that changes the approach. A fixed window resets all at once, so a client can "
                    "send its whole limit just before the boundary and again just after it: twice the limit in a "
                    f"moment. I'll write a token bucket instead, keyed {label}, returning `429` with `Retry-After`."
                )
            else:
                text = f"Going with {label}. I'll write a fixed-window counter per client."
            ack = st.acknowledgement(skip_algorithm=True)
            if ack:
                text = f"{ack}\n\n{text}"
            return text, "", ("update_plan", {"steps": _plan(2, fixed=fixed)})
        if beat == "write_mw":
            return "", "", ("write_file", {"path": "app/middleware.py", "content": _middleware(fixed)})
        if beat == "rework":
            who = st.algorithm_feedback
            calls = [("update_plan", {"steps": _plan(2, fixed=False)}),
                     ("write_file", {"path": "app/middleware.py", "content": _middleware(False)})]
            if "write_tests" in st.done:
                calls.append(("write_file", {"path": "tests/test_rate_limit.py", "content": _tests(st.strategy, False)}))
            return (
                f"Thanks {who}, I'd already written a fixed-window counter. Reworking: the limiter becomes a token "
                "bucket that refills smoothly, so there's no window boundary to burst across.",
                "",
                calls,
            )
        if beat == "rerun":
            return "Re-running the full suite after the rework.", "", ("run_command", {"command": TEST_CMD})
        if beat == "refinish":
            return (
                "Still green.",
                "",
                [("update_plan", {"steps": _plan(5, fixed=False)}),
                 ("finish", {"summary": "Reworked the rate limiter as a token bucket, so clients can't burst across a "
                                        "window boundary. Full suite green (11 tests)."})],
            )
        if beat == "wire":
            return (
                "Wiring it into `build_app()` as the outermost middleware, so rejected requests never reach the app.",
                "",
                [("update_plan", {"steps": _plan(3, fixed=fixed)}), ("edit_file", {
                    "path": "app/server.py",
                    "old_str": "    app = notes_app(store or NoteStore())\n    return app\n",
                    "new_str": "    app = notes_app(store or NoteStore())\n"
                    f"    app = RateLimiter(app, limit=60, per=60.0, key_func={_key_func(st.strategy)})\n"
                    "    return app\n",
                })],
            )
        if beat == "wire_import":
            return (
                "",
                "",
                ("edit_file", {
                    "path": "app/server.py",
                    "old_str": "from app.store import NoteStore\n",
                    "new_str": f"from app.middleware import RateLimiter, {_key_func(st.strategy)}\n"
                    "from app.store import NoteStore\n",
                }),
            )
        if beat == "write_tests":
            return (
                "Now tests: under the limit, over the limit, isolation between clients, the limit recovering over "
                "time, the health-check exemption, and that the real app is wired up.",
                "",
                [("update_plan", {"steps": _plan(4, fixed=fixed)}),
                 ("write_file", {"path": "tests/test_rate_limit.py", "content": _tests(st.strategy, fixed)})],
            )
        if beat == "run_tests":
            return "", "", ("run_command", {"command": TEST_CMD})
        if beat == "wrap_up":
            return "All 11 tests pass, including 6 new ones for rate limiting.", "", ("update_plan", {"steps": _plan(5, fixed=fixed)})
        if beat == "finish":
            algo = "fixed-window" if fixed else "token-bucket"
            summary = (
                "Built a small notes API with per-client rate limiting.\n"
                "- `app/server.py`, `app/store.py`: GET/POST /notes and /health on the standard library\n"
                f"- `app/middleware.py`: {algo} `RateLimiter` ({st.strategy} strategy), 429 + Retry-After, "
                "X-RateLimit headers, /health exempt, wired as the outermost middleware\n"
                "- `tests/`: 5 tests for the notes endpoints, 6 for rate limiting; full suite green (11 tests)"
            )
            if st.algorithm_feedback:
                summary += f"\n- Token bucket rather than a fixed window, per {st.algorithm_feedback}'s note: no burst at the window boundary"
            return "Done. Summary below.", "", ("finish", {"summary": summary})
        # Past the end of the script: acknowledge and hand control back.
        return (
            "I'm the offline demo model, so I can only run the rehearsed rate-limiting task. Switch this "
            "session to Claude, Gemini, an OpenAI model, or a local model from the model menu and I'll pick up from here "
            "with the full history.",
            "",
            None,
        )


class _State:
    """What the scripted agent can infer from the conversation so far."""

    def __init__(self, messages: list[dict]):
        self.done: set[str] = set()
        self.human: list[tuple[str, str]] = []  # (author, text)
        self.answer = ""
        self.trailing: list[tuple[str, str]] = []
        ask_ids: set[str] = set()
        self.wrote_fixed = False
        for i, m in enumerate(messages):
            for b in m["content"]:
                if b["type"] == "tool_call" and b["name"] == "write_file" and FIXED_MARK in str(b["input"].get("content", "")):
                    self.wrote_fixed = True
                if b["type"] == "tool_call":
                    mm = re.match(r"call_demo_([a-z_]+?)_[0-9a-f]{8}$", b["id"])
                    if mm:
                        self.done.add(mm.group(1))
                    if b["name"] == "ask_humans":
                        ask_ids.add(b["id"])
                elif b["type"] == "tool_result" and b["id"] in ask_ids:
                    self.answer = b["output"]
                elif b["type"] == "text" and m["role"] == "user" and i > 0 and not _WORKSPACE_NOTE.match(b["text"]):
                    # Hand edits and terminal runs aren't instructions; their diffs and output shouldn't steer the script.
                    self.human.append(_author(b["text"]))
        last = messages[-1] if messages else None
        if last and last["role"] == "user" and len(messages) > 1:
            self.trailing = [_author(b["text"]) for b in last["content"] if b["type"] == "text"]

    def next_beat(self) -> str:
        # Feedback that lands after the agent already wrote the fixed-window limiter triggers a rework,
        # wherever the run is; if the run had finished, it re-verifies and finishes again.
        rework = "write_mw" in self.done and self.wrote_fixed and bool(self.algorithm_feedback)
        if rework and "rework" not in self.done:
            return "rework"
        for b in BEATS:
            if b not in self.done:
                return b
        if rework:
            for b in ("rerun", "refinish"):
                if b not in self.done:
                    return b
        return "after"

    @property
    def algorithm_feedback(self) -> str:
        for who, text in self.human:
            if re.search(ALGORITHM_FEEDBACK, text, re.I):
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

    def acknowledgement(self, skip_algorithm: bool = False) -> str:
        notes = []
        for who, text in self.trailing:
            m = _WORKSPACE_NOTE.match(text)
            if m and m.group("verb"):
                notes.append(f"Noted, {m.group('who')} {m.group('verb')} `{m.group('path')}` by hand; I'll work from your version.")
                continue
            if m:
                notes.append(f"I see {m.group('who')} ran `{_clip(m.group('cmd'), 60)}` in the terminal.")
                continue
            if skip_algorithm and re.search(ALGORITHM_FEEDBACK, text, re.I):
                continue
            if text.startswith("(") or not text.strip():
                continue
            notes.append(f"Noted, {who}: “{_clip(text)}”")
        return "\n".join(notes)


# How hand edits and terminal runs from the code view read in the conversation (see context.py).
_WORKSPACE_NOTE = re.compile(
    r"\[(?P<who>.+?) (?:(?P<verb>edited|created) (?P<path>\S+) by hand in the editor"
    r"|ran `(?P<cmd>.*?)` in the terminal)"
)


def _author(text: str) -> tuple[str, str]:
    if _WORKSPACE_NOTE.match(text):
        return ("", text)  # keep the whole note; acknowledgement() recognizes it
    m = re.match(r"\[([^,\]]+)([^\]]*)\]:\s*(.*)", text, re.S)
    if not m:
        return ("you", text)
    src = re.search(r"promoting a suggestion from (.+)$", m.group(2))
    return (src.group(1) if src else m.group(1), m.group(3))  # credit whoever made a promoted suggestion


def _clip(s: str, n: int = 120) -> str:
    s = " ".join(s.split())
    return s if len(s) <= n else s[: n - 1] + "…"


def _chunks(s: str, n: int):
    words = re.findall(r"\S+\s*|\s+", s)
    for i in range(0, len(words), n):
        yield "".join(words[i : i + n])




# What counts as "don't use a fixed window" from a person.
ALGORITHM_FEEDBACK = r"token.?bucket|fixed.?window|burst|boundar"


def _plan(stage: int, fixed: bool) -> list[dict]:
    impl = "Write a fixed-window rate limiter" if fixed else "Write a token-bucket rate limiter"
    titles = [
        "Scaffold the notes API and its tests",
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


STORE = '''"""In-memory note storage. Thread-safe, so the API can run under a threaded server."""
import threading


class NoteStore:
    def __init__(self):
        self._notes = []
        self._lock = threading.Lock()

    def add(self, text):
        with self._lock:
            note = {"id": len(self._notes) + 1, "text": text}
            self._notes.append(note)
            return note

    def all(self):
        with self._lock:
            return list(self._notes)
'''

SERVER = '''"""A small JSON notes API on the standard library (WSGI)."""
import json

from app.store import NoteStore


def respond(start_response, status, payload):
    body = json.dumps(payload).encode()
    start_response(status, [("Content-Type", "application/json"), ("Content-Length", str(len(body)))])
    return [body]


def notes_app(store):
    def app(environ, start_response):
        method, path = environ["REQUEST_METHOD"], environ.get("PATH_INFO", "/")
        if path == "/health":
            return respond(start_response, "200 OK", {"ok": True})
        if path != "/notes":
            return respond(start_response, "404 Not Found", {"error": "not found"})
        if method == "GET":
            return respond(start_response, "200 OK", {"notes": store.all()})
        if method == "POST":
            try:
                size = int(environ.get("CONTENT_LENGTH") or 0)
                data = json.loads(environ["wsgi.input"].read(size) or b"{}")
            except ValueError:
                return respond(start_response, "400 Bad Request", {"error": "invalid JSON"})
            text = data.get("text") if isinstance(data, dict) else None
            if not isinstance(text, str) or not text.strip():
                return respond(start_response, "400 Bad Request", {"error": "text is required"})
            return respond(start_response, "201 Created", store.add(text.strip()))
        return respond(start_response, "405 Method Not Allowed", {"error": "method not allowed"})

    return app


def build_app(store=None):
    app = notes_app(store or NoteStore())
    return app


if __name__ == "__main__":
    from wsgiref.simple_server import make_server

    make_server("127.0.0.1", 8080, build_app()).serve_forever()
'''

HELPERS = '''import io
import json


def call(app, method, path, body=None, headers=None):
    """Call a WSGI app in-process. Returns (status code, headers, decoded JSON body)."""
    raw = json.dumps(body).encode() if body is not None else b""
    environ = {
        "REQUEST_METHOD": method,
        "PATH_INFO": path,
        "CONTENT_LENGTH": str(len(raw)),
        "wsgi.input": io.BytesIO(raw),
        "REMOTE_ADDR": "127.0.0.1",
    }
    environ.update(headers or {})
    seen = {}

    def start_response(status, response_headers, exc_info=None):
        seen["status"] = int(status.split()[0])
        seen["headers"] = dict(response_headers)

    payload = b"".join(app(environ, start_response))
    return seen["status"], seen["headers"], json.loads(payload) if payload else None
'''

NOTES_TESTS = '''import unittest

from app.server import build_app
from tests.helpers import call


class NotesTests(unittest.TestCase):
    def setUp(self):
        self.app = build_app()

    def test_health(self):
        status, _, body = call(self.app, "GET", "/health")
        self.assertEqual((status, body), (200, {"ok": True}))

    def test_starts_empty(self):
        status, _, body = call(self.app, "GET", "/notes")
        self.assertEqual((status, body), (200, {"notes": []}))

    def test_create_then_list(self):
        status, _, note = call(self.app, "POST", "/notes", {"text": "  buy milk "})
        self.assertEqual((status, note), (201, {"id": 1, "text": "buy milk"}))
        _, _, body = call(self.app, "GET", "/notes")
        self.assertEqual(body["notes"], [note])

    def test_rejects_empty_text(self):
        status, _, body = call(self.app, "POST", "/notes", {"text": " "})
        self.assertEqual(status, 400)
        self.assertEqual(body["error"], "text is required")

    def test_unknown_path_is_404(self):
        status, _, _ = call(self.app, "GET", "/nope")
        self.assertEqual(status, 404)
'''


def _middleware(fixed: bool) -> str:
    if fixed:
        title = f"Per-client rate limiting {FIXED_MARK}."
        doc = (
            "Each client may make `limit` requests in each `per`-second window; the\n"
            "count resets when the next window starts."
        )
        state = "        self._windows = {}\n"
        take = '''        now = self.clock()
        window = int(now // self.per)
        with self._lock:
            start, count = self._windows.get(key, (window, 0))
            if start != window:
                start, count = window, 0
            if count < self.limit:
                self._windows[key] = (start, count + 1)
                return True, self.limit - count - 1, 0.0
            return False, 0, (window + 1) * self.per - now
'''
    else:
        title = "Per-client rate limiting (token bucket)."
        doc = (
            "Each client gets a bucket of `limit` tokens that refills smoothly, `limit`\n"
            "tokens every `per` seconds. There is no window boundary, so a client can't\n"
            "send twice its limit by straddling one."
        )
        state = "        self._buckets = {}\n"
        take = '''        now = self.clock()
        rate = self.limit / self.per
        with self._lock:
            tokens, last = self._buckets.get(key, (self.limit, now))
            tokens = min(self.limit, tokens + (now - last) * rate)
            if tokens >= 1:
                self._buckets[key] = (tokens - 1, now)
                return True, tokens - 1, 0.0
            self._buckets[key] = (tokens, now)
            return False, tokens, (1 - tokens) / rate
'''
    return f'''"""{title}

{doc}
A request over the limit gets 429 Too Many Requests with a Retry-After
header; workers are never blocked.
"""
import math
import threading
import time


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


class RateLimiter:
    def __init__(self, app, limit=60, per=60.0, key_func=client_key,
                 clock=time.monotonic, exempt_paths=("/health",)):
        self.app = app
        self.limit = limit
        self.per = per
        self.key_func = key_func
        self.clock = clock
        self.exempt_paths = set(exempt_paths)
{state}        self._lock = threading.Lock()

    def _take(self, key):
        """Spend one request. Returns (allowed, requests_left, seconds_until_allowed)."""
{take}
    def __call__(self, environ, start_response):
        if environ.get("PATH_INFO") in self.exempt_paths:
            return self.app(environ, start_response)
        allowed, remaining, wait = self._take(self.key_func(environ))
        limit_headers = [
            ("X-RateLimit-Limit", str(self.limit)),
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


def _tests(strategy: str, fixed: bool) -> str:
    if strategy == "ip":
        a, b = '{"REMOTE_ADDR": "10.0.0.1"}', '{"REMOTE_ADDR": "10.0.0.2"}'
        iso = "test_limits_are_per_client_ip"
        iso_assert = "self.assertEqual(status, 200)"
    elif strategy == "global":
        a, b = '{"REMOTE_ADDR": "10.0.0.1"}', '{"REMOTE_ADDR": "10.0.0.2"}'
        iso = "test_limit_is_shared_by_all_clients"
        iso_assert = "self.assertEqual(status, 429)"
    else:
        a, b = '{"HTTP_X_API_KEY": "alice"}', '{"HTTP_X_API_KEY": "bob"}'
        iso = "test_limits_are_per_api_key"
        iso_assert = "self.assertEqual(status, 200)"
    # The limiter allows 3 requests per 3 seconds. A token bucket gets one back each second; a fixed window
    # (the clock starts 1 second into one) resets 2 seconds later, all at once.
    retry, recover, wait = ("2", "test_limit_resets_with_the_next_window", 2.0) if fixed else ("1", "test_tokens_refill_over_time", 1.0)
    return f'''import unittest

from app.middleware import RateLimiter, {_key_func(strategy)}
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
        self.app = RateLimiter(ok_app, limit=3, per=3.0, key_func={_key_func(strategy)}, clock=self.clock)

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
        self.assertEqual(headers["Retry-After"], "{retry}")
        self.assertEqual(body["error"], "rate limit exceeded")

    def {iso}(self):
        self.exhaust(A)
        status, _, _ = call(self.app, "GET", "/notes", headers=B)
        {iso_assert}

    def {recover}(self):
        self.exhaust(A)
        self.clock.now += {wait}
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
