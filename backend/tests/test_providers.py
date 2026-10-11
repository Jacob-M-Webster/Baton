"""Adapters against fake servers that speak the real Anthropic and OpenAI wire formats.

The last test runs a session on an OpenAI-compatible "local" model, switches it
to Claude mid-run, and checks the Anthropic request carries the whole history.
"""
import json

import httpx2
from starlette.applications import Starlette
from starlette.requests import Request
from starlette.responses import JSONResponse, Response
from starlette.routing import Route

from baton import context as ctx
from baton.providers.anthropic_provider import AnthropicProvider
from baton.providers.openai_provider import OpenAIProvider
from baton.providers.xai_provider import XAIProvider
from conftest import wait_for


def sse(events: list[tuple[str | None, dict | str]]) -> Response:
    body = ""
    for name, data in events:
        if name:
            body += f"event: {name}\n"
        body += f"data: {data if isinstance(data, str) else json.dumps(data)}\n\n"
    return Response(body, media_type="text/event-stream")


def anthropic_turn(text: str, tool: tuple[str, str, dict] | None) -> Response:
    ev = [("message_start", {"type": "message_start", "message": {
        "id": "msg_1", "type": "message", "role": "assistant", "model": "claude-test", "content": [],
        "stop_reason": None, "stop_sequence": None, "usage": {"input_tokens": 50, "output_tokens": 1}}})]
    idx = 0
    if text:
        ev += [
            ("content_block_start", {"type": "content_block_start", "index": 0, "content_block": {"type": "text", "text": ""}}),
            ("content_block_delta", {"type": "content_block_delta", "index": 0, "delta": {"type": "text_delta", "text": text[:5]}}),
            ("content_block_delta", {"type": "content_block_delta", "index": 0, "delta": {"type": "text_delta", "text": text[5:]}}),
            ("content_block_stop", {"type": "content_block_stop", "index": 0}),
        ]
        idx = 1
    if tool:
        tid, name, args = tool
        raw = json.dumps(args)
        ev += [
            ("content_block_start", {"type": "content_block_start", "index": idx,
                                     "content_block": {"type": "tool_use", "id": tid, "name": name, "input": {}}}),
            ("content_block_delta", {"type": "content_block_delta", "index": idx, "delta": {"type": "input_json_delta", "partial_json": raw[:4]}}),
            ("content_block_delta", {"type": "content_block_delta", "index": idx, "delta": {"type": "input_json_delta", "partial_json": raw[4:]}}),
            ("content_block_stop", {"type": "content_block_stop", "index": idx}),
        ]
    ev += [
        ("message_delta", {"type": "message_delta", "delta": {"stop_reason": "tool_use" if tool else "end_turn", "stop_sequence": None},
                           "usage": {"output_tokens": 20}}),
        ("message_stop", {"type": "message_stop"}),
    ]
    return sse(ev)


def openai_turn(text: str, tool: tuple[str, str, dict] | None) -> Response:
    base = {"id": "c1", "object": "chat.completion.chunk", "created": 1, "model": "llama-test"}
    ev = []
    if text:
        ev.append((None, {**base, "choices": [{"index": 0, "delta": {"role": "assistant", "content": text}, "finish_reason": None}]}))
    if tool:
        tid, name, args = tool
        raw = json.dumps(args)
        ev.append((None, {**base, "choices": [{"index": 0, "delta": {"tool_calls": [
            {"index": 0, "id": tid, "type": "function", "function": {"name": name, "arguments": ""}}]}, "finish_reason": None}]}))
        ev.append((None, {**base, "choices": [{"index": 0, "delta": {"tool_calls": [
            {"index": 0, "function": {"arguments": raw[:3]}}]}, "finish_reason": None}]}))
        ev.append((None, {**base, "choices": [{"index": 0, "delta": {"tool_calls": [
            {"index": 0, "function": {"arguments": raw[3:]}}]}, "finish_reason": None}]}))
    ev.append((None, {**base, "choices": [{"index": 0, "delta": {}, "finish_reason": "tool_calls" if tool else "stop"}]}))
    ev.append((None, {**base, "choices": [], "usage": {"prompt_tokens": 40, "completion_tokens": 9, "total_tokens": 49}}))
    ev.append((None, "[DONE]"))
    return sse(ev)


class FakeServer:
    """Replays a list of turns, recording every request body it receives."""

    def __init__(self, kind: str, turns: list):
        self.kind = kind
        self.turns = list(turns)
        self.requests: list[dict] = []
        routes = [
            Route("/v1/messages", self.handle, methods=["POST"]),
            Route("/v1/chat/completions", self.handle, methods=["POST"]),
            Route("/v1/models", self.models, methods=["GET"]),
        ]
        self.app = Starlette(routes=routes)

    async def handle(self, request: Request):
        body = await request.json()
        self.requests.append(body)
        if not body.get("stream"):
            if self.kind == "anthropic":
                return JSONResponse({"id": "m", "type": "message", "role": "assistant", "model": "x",
                                     "content": [{"type": "text", "text": '{"doing": "Writing tests", "done": ["Explored"], "next": ["Run tests"]}'}],
                                     "stop_reason": "end_turn", "stop_sequence": None, "usage": {"input_tokens": 1, "output_tokens": 1}})
            return JSONResponse({"id": "c", "object": "chat.completion", "created": 1, "model": "x", "choices": [
                {"index": 0, "message": {"role": "assistant", "content": '{"doing": "Writing tests", "done": [], "next": []}'}, "finish_reason": "stop"}]})
        text, tool = self.turns.pop(0) if self.turns else ("All set.", None)
        return anthropic_turn(text, tool) if self.kind == "anthropic" else openai_turn(text, tool)

    async def models(self, request: Request):
        return JSONResponse({"object": "list", "data": [{"id": "llama-test", "object": "model", "created": 1, "owned_by": "me"}]})

    def client(self) -> httpx2.AsyncClient:
        return httpx2.AsyncClient(transport=httpx2.ASGITransport(app=self.app), base_url="http://fake")


async def collect(provider, messages, tools=None):
    out = []
    async for ev in provider.stream(model="m", system="sys", messages=messages, tools=tools or []):
        out.append(ev)
    return out


async def test_anthropic_stream_text_and_tool_call():
    srv = FakeServer("anthropic", [("Looking around.", ("toolu_01", "list_files", {"path": "."}))])
    p = AnthropicProvider("anthropic", "sk-test", "http://fake", http_client=srv.client())
    evs = await collect(p, [{"role": "user", "content": [{"type": "text", "text": "hi"}]}])
    assert "".join(e.text for e in evs if e.kind == "text_delta") == "Looking around."
    calls = [e.data for e in evs if e.kind == "tool_call"]
    assert calls == [{"id": "toolu_01", "name": "list_files", "input": {"path": "."}}]
    assert [e.data["name"] for e in evs if e.kind == "tool_progress"][:1] == ["list_files"]
    assert [e for e in evs if e.kind == "done"][0].data["stop_reason"] == "tool_use"
    req = srv.requests[0]
    assert req["system"][0]["cache_control"] == {"type": "ephemeral"}


async def test_openai_compatible_stream_assembles_tool_arguments():
    srv = FakeServer("openai", [("Checking.", ("call_9", "read_file", {"path": "app/server.py"}))])
    p = OpenAIProvider("local", "local", "http://fake/v1", discover=True, http_client=srv.client())
    evs = await collect(p, [{"role": "user", "content": [{"type": "text", "text": "hi"}]}])
    calls = [e.data for e in evs if e.kind == "tool_call"]
    assert calls == [{"id": "call_9", "name": "read_file", "input": {"path": "app/server.py"}}]
    assert [e.data["name"] for e in evs if e.kind == "tool_progress"][:1] == ["read_file"]
    usage = [e.data for e in evs if e.kind == "usage"][0]
    assert usage["input_tokens"] == 40
    assert await p.list_models() == ["llama-test"]


async def test_xai_lists_grok_chat_models_with_configured_ones_first():
    ids = ["grok-2-image", "grok-3-mini", "grok-imagine-video", "grok-4", "grok-4.3", "text-embedding"]

    async def models(_: Request):
        return JSONResponse({"object": "list", "data": [{"id": i, "object": "model", "created": 1, "owned_by": "xai"} for i in ids]})

    app = Starlette(routes=[Route("/v1/models", models, methods=["GET"])])
    client = httpx2.AsyncClient(transport=httpx2.ASGITransport(app=app), base_url="http://fake")
    p = XAIProvider("xai", "xai-key", "http://fake/v1", ["grok-4", "grok-gone"], http_client=client)
    assert await p.list_models() == ["grok-4", "grok-4.3", "grok-3-mini"]
    # Without a key the menu shows the configured list, and nothing is fetched.
    assert await XAIProvider("xai", None, models=["grok-4"]).list_models() == ["grok-4"]


def test_wire_formats_keep_tool_results_before_human_text():
    events = [
        {"seq": 1, "type": "session.started", "actor": "u_a", "payload": {}},
        {"seq": 2, "type": "agent.text", "actor": "agent", "payload": {"text": "Reading.", "turn": 1}},
        {"seq": 3, "type": "tool.call", "actor": "agent", "payload": {"call_id": "call.x/1", "name": "read_file", "input": {"path": "a"}, "turn": 1}},
        {"seq": 4, "type": "human.message", "actor": "u_b", "payload": {"text": "use b instead", "mode": "steer"}},
        {"seq": 5, "type": "tool.result", "actor": "agent", "payload": {"call_id": "call.x/1", "output": "contents"}},
        {"seq": 6, "type": "tool.call", "actor": "agent", "payload": {"call_id": "c2", "name": "run_command", "input": {"command": "ls"}, "turn": 2}},
    ]
    msgs = ctx.build_messages("do it", "u_a", events, {"u_a": "Alice", "u_b": "Bob"})
    assert [m["role"] for m in msgs] == ["user", "assistant", "user", "assistant", "user"]
    assert [b["type"] for b in msgs[2]["content"]] == ["tool_result", "text"]
    assert msgs[2]["content"][1]["text"] == "[Bob, steering]: use b instead"
    # c2 never got a result (e.g. crash): it is closed out so every API accepts the history.
    assert msgs[4]["content"][0]["type"] == "tool_result" and msgs[4]["content"][0]["is_error"]

    wire = AnthropicProvider.to_wire(msgs)
    assert wire[1]["content"][1]["id"] == "call_x_1"  # sanitized for Anthropic's id pattern
    assert wire[2]["content"][0]["tool_use_id"] == "call_x_1"
    oa = OpenAIProvider.to_wire("sys", msgs)
    assert [m["role"] for m in oa] == ["system", "user", "assistant", "tool", "user", "assistant", "tool"]
    assert oa[2]["tool_calls"][0]["function"]["arguments"] == json.dumps({"path": "a"})


async def test_switch_from_local_model_to_claude_mid_session(mgr):
    local = FakeServer("openai", [
        ("I'll look at the layout first.", ("call_l1", "list_files", {"path": "."})),
        ("Now the server.", ("call_l2", "read_file", {"path": "app/server.py"})),
        ("Need a decision.", ("call_l3", "ask_humans", {"question": "Key or IP?", "options": ["Key", "IP"]})),
    ])
    claude = FakeServer("anthropic", [
        ("Picking up from the local model.", ("toolu_c1", "run_command", {"command": "python -m unittest -q"})),
        ("Tests pass. Wrapping up.", ("toolu_c2", "finish", {"summary": "done"})),
    ])
    mgr.providers["local"] = OpenAIProvider("local", "local", "http://fake/v1", http_client=local.client())
    mgr.providers["anthropic"] = AnthropicProvider("anthropic", "sk-test", "http://fake", http_client=claude.client())

    sid = mgr.create_session(user_id="u_alice", task="Rate limit it", provider="local", model="llama-test")["id"]
    await wait_for(lambda: ctx.open_decisions(mgr.db.events(sid)))
    await mgr.command(sid, "u_alice", {"type": "set_model", "provider": "anthropic", "model": "claude-sonnet-5-5"})
    await mgr.command(sid, "u_alice", {"type": "answer_decision", "answer": "Key"})
    await wait_for(lambda: mgr.db.get_session(sid)["status"] == "done", timeout=10)

    first_claude = claude.requests[0]
    assert first_claude["model"] == "claude-sonnet-5-5"
    msgs = first_claude["messages"]
    tool_uses = [b["id"] for m in msgs for b in m["content"] if b["type"] == "tool_use"]
    assert tool_uses == ["call_l1", "call_l2", "call_l3"]
    last = msgs[-1]["content"]
    assert last[0]["type"] == "tool_result" and "Alice decided: Key" in last[0]["content"]
    assert any("switched to claude-sonnet-5-5" in b.get("text", "") for b in last)
    roles = [m["role"] for m in msgs]
    assert all(a != b for a, b in zip(roles, roles[1:])), roles

    turns = [e["payload"] for e in mgr.db.events(sid) if e["type"] == "agent.turn"]
    assert {t["provider"] for t in turns} == {"local", "anthropic"}
    # The catch-up card can be summarized by the session's own model family.
    mgr.catchup(sid)
    await wait_for(lambda: sid in mgr._catchup_cache, timeout=5)
    assert mgr.catchup(sid)["doing"] == "Writing tests"


async def test_truncated_tool_call_is_never_executed(mgr):
    """A reply cut off at the token limit must not run its (possibly partial) tool call."""
    from starlette.responses import Response as R

    class Truncating(FakeServer):
        async def handle(self, request):
            body = await request.json()
            self.requests.append(body)
            if len(self.requests) == 1:
                raw = "".join(
                    f"data: {json.dumps(x)}\n\n" for x in [
                        {"id": "c", "object": "chat.completion.chunk", "created": 1, "model": "m", "choices": [{"index": 0, "delta": {"tool_calls": [
                            {"index": 0, "id": "call_w", "type": "function", "function": {"name": "write_file", "arguments": '{"path": "app/x.py", "content": "def f(): ret'}}]}, "finish_reason": None}]},
                        {"id": "c", "object": "chat.completion.chunk", "created": 1, "model": "m", "choices": [{"index": 0, "delta": {}, "finish_reason": "length"}]},
                    ]
                ) + "data: [DONE]\n\n"
                return R(raw, media_type="text/event-stream")
            return openai_turn("Okay, stopping here.", None)

    srv = Truncating("openai", [])
    mgr.providers["local"] = OpenAIProvider("local", "local", "http://fake/v1", http_client=srv.client())
    sid = mgr.create_session(user_id="u_alice", task="t", provider="local", model="m")["id"]
    await wait_for(lambda: mgr.db.get_session(sid)["status"] == "waiting_input", timeout=10)
    assert mgr.workspace(sid).read_text("app/x.py") is None
    res = [e for e in mgr.db.events(sid) if e["type"] == "tool.result"][0]["payload"]
    assert res["is_error"] and "token limit" in res["output"]
    assert srv.requests[0]["max_tokens"] == 4096


async def test_signed_thinking_round_trips_to_the_same_model_only(mgr):
    """If Claude returns thinking during a tool loop, the next request must carry it back verbatim."""
    from starlette.responses import Response as R

    def thinking_turn(tool):
        tid, name, args = tool
        ev = [
            ("message_start", {"type": "message_start", "message": {"id": "m", "type": "message", "role": "assistant", "model": "x",
                               "content": [], "stop_reason": None, "stop_sequence": None, "usage": {"input_tokens": 5, "output_tokens": 1}}}),
            ("content_block_start", {"type": "content_block_start", "index": 0, "content_block": {"type": "thinking", "thinking": "", "signature": ""}}),
            ("content_block_delta", {"type": "content_block_delta", "index": 0, "delta": {"type": "thinking_delta", "thinking": "Check the layout first."}}),
            ("content_block_delta", {"type": "content_block_delta", "index": 0, "delta": {"type": "signature_delta", "signature": "sig-abc"}}),
            ("content_block_stop", {"type": "content_block_stop", "index": 0}),
            ("content_block_start", {"type": "content_block_start", "index": 1, "content_block": {"type": "tool_use", "id": tid, "name": name, "input": {}}}),
            ("content_block_delta", {"type": "content_block_delta", "index": 1, "delta": {"type": "input_json_delta", "partial_json": json.dumps(args)}}),
            ("content_block_stop", {"type": "content_block_stop", "index": 1}),
            ("message_delta", {"type": "message_delta", "delta": {"stop_reason": "tool_use", "stop_sequence": None}, "usage": {"output_tokens": 9}}),
            ("message_stop", {"type": "message_stop"}),
        ]
        return sse(ev)

    class Thinker(FakeServer):
        async def handle(self, request):
            body = await request.json()
            self.requests.append(body)
            if len(self.requests) == 1:
                return thinking_turn(("toolu_t1", "list_files", {"path": "."}))
            return anthropic_turn("Done looking.", ("toolu_t2", "finish", {"summary": "ok"}))

    srv = Thinker("anthropic", [])
    mgr.providers["anthropic"] = AnthropicProvider("anthropic", "sk-test", "http://fake", http_client=srv.client())
    sid = mgr.create_session(user_id="u_alice", task="t", provider="anthropic", model="claude-opus-5-5")["id"]
    await wait_for(lambda: mgr.db.get_session(sid)["status"] == "done", timeout=10)

    th = [e for e in mgr.db.events(sid) if e["type"] == "agent.thinking"][0]["payload"]
    assert th["text"] == "Check the layout first." and th["blocks"][0]["signature"] == "sig-abc"
    second = srv.requests[1]["messages"]
    assistant = [m for m in second if m["role"] == "assistant"][0]["content"]
    assert assistant[0] == {"type": "thinking", "thinking": "Check the layout first.", "signature": "sig-abc"}
    assert assistant[1]["type"] == "tool_use"

    # A different model never receives another model's signed thinking.
    msgs = ctx.build_messages("t", "u_alice", mgr.db.events(sid), mgr.names(sid))
    wire = AnthropicProvider.to_wire(msgs, "claude-sonnet-5-5")
    assert not any(b["type"] == "thinking" for m in wire for b in m["content"])
    assert all(m.get("content") or m.get("tool_calls") for m in OpenAIProvider.to_wire("s", msgs) if m["role"] == "assistant")


async def test_interleaved_thinking_replays_in_its_original_order(mgr):
    """Thinking between tool calls must go back exactly where the model put it, or the API returns 400."""
    def block(i, start, *deltas):
        return [("content_block_start", {"type": "content_block_start", "index": i, "content_block": start}),
                *[("content_block_delta", {"type": "content_block_delta", "index": i, "delta": d}) for d in deltas],
                ("content_block_stop", {"type": "content_block_stop", "index": i})]

    def interleaved():
        ev = [("message_start", {"type": "message_start", "message": {"id": "m", "type": "message", "role": "assistant", "model": "x",
                                 "content": [], "stop_reason": None, "stop_sequence": None, "usage": {"input_tokens": 5, "output_tokens": 1}}})]
        ev += block(0, {"type": "thinking", "thinking": "", "signature": ""},
                    {"type": "thinking_delta", "thinking": "List first."}, {"type": "signature_delta", "signature": "sig-1"})
        ev += block(1, {"type": "text", "text": ""}, {"type": "text_delta", "text": "Looking around."})
        ev += block(2, {"type": "tool_use", "id": "toolu_a", "name": "list_files", "input": {}},
                    {"type": "input_json_delta", "partial_json": json.dumps({"path": "."})})
        ev += block(3, {"type": "thinking", "thinking": "", "signature": ""},
                    {"type": "thinking_delta", "thinking": "Then the app folder."}, {"type": "signature_delta", "signature": "sig-2"})
        ev += block(4, {"type": "tool_use", "id": "toolu_b", "name": "list_files", "input": {}},
                    {"type": "input_json_delta", "partial_json": json.dumps({"path": "app"})})
        ev += [("message_delta", {"type": "message_delta", "delta": {"stop_reason": "tool_use", "stop_sequence": None}, "usage": {"output_tokens": 9}}),
               ("message_stop", {"type": "message_stop"})]
        return sse(ev)

    class Thinker(FakeServer):
        async def handle(self, request):
            self.requests.append(await request.json())
            if len(self.requests) == 1:
                return interleaved()
            return anthropic_turn("Done looking.", ("toolu_c", "finish", {"summary": "ok"}))

    srv = Thinker("anthropic", [])
    mgr.providers["anthropic"] = AnthropicProvider("anthropic", "sk-test", "http://fake", http_client=srv.client())
    sid = mgr.create_session(user_id="u_alice", task="t", provider="anthropic", model="claude-opus-5-5")["id"]
    await wait_for(lambda: mgr.db.get_session(sid)["status"] == "done", timeout=10)

    assistant = [m for m in srv.requests[1]["messages"] if m["role"] == "assistant"][0]["content"]
    assert [b["type"] for b in assistant] == ["thinking", "text", "tool_use", "thinking", "tool_use"]
    assert assistant[3] == {"type": "thinking", "thinking": "Then the app folder.", "signature": "sig-2"}
    assert [b["id"] for b in assistant if b["type"] == "tool_use"] == ["toolu_a", "toolu_b"]
    results = [b["tool_use_id"] for m in srv.requests[1]["messages"] if m["role"] == "user"
               for b in m["content"] if b["type"] == "tool_result"]
    assert results == ["toolu_a", "toolu_b"]

    # Another model gets the turn rebuilt from the log: text and both calls, no thinking.
    msgs = ctx.build_messages("t", "u_alice", mgr.db.events(sid), mgr.names(sid))
    other = [m for m in AnthropicProvider.to_wire(msgs, "claude-sonnet-5-5") if m["role"] == "assistant"][0]["content"]
    assert [b["type"] for b in other] == ["text", "tool_use", "tool_use"]

    # Forking right after that response must not keep it without its calls: it would replay unanswered tool_use.
    thinking = next(e for e in mgr.db.events(sid) if e["type"] == "agent.thinking" and e["payload"].get("content"))
    fork = mgr.fork(sid, thinking["seq"], "u_alice")
    assert fork["fork_seq"] < thinking["seq"]


def test_every_tool_use_is_answered_on_the_wire():
    """A log cut between a response and its calls still sends the API a tool_result for each tool_use."""
    native = [{"type": "thinking", "thinking": "Look first.", "signature": "sig"},
              {"type": "tool_use", "id": "toolu_a", "name": "list_files", "input": {}}]
    events = [{"seq": 1, "type": "agent.thinking", "actor": "agent", "payload": {
        "text": "Look first.", "turn": 1, "blocks": [native[0]], "model": "claude-haiku-5-5", "content": native}}]
    wire = AnthropicProvider.to_wire(ctx.build_messages("t", "u_alice", events, {}), "claude-haiku-5-5")
    assert [m["role"] for m in wire] == ["user", "assistant", "user"]
    first = wire[2]["content"][0]
    assert first["type"] == "tool_result" and first["tool_use_id"] == "toolu_a" and first["is_error"]


async def test_steer_during_a_tool_reaches_the_next_model_call(mgr):
    """Redirect: a steer sent mid-step is injected at the next turn boundary, after the tool result."""
    srv = FakeServer("openai", [
        ("Running a slow check.", ("call_s1", "run_command", {"command": "sleep 0.6; echo done"})),
        ("Adjusting as asked.", ("call_s2", "finish", {"summary": "ok"})),
    ])
    mgr.providers["local"] = OpenAIProvider("local", "local", "http://fake/v1", http_client=srv.client())
    sid = mgr.create_session(user_id="u_alice", task="t", provider="local", model="m")["id"]
    await wait_for(lambda: any(e["type"] == "tool.call" for e in mgr.db.events(sid)))
    await mgr.command(sid, "u_alice", {"type": "steer", "text": "Use the token bucket instead."})
    await wait_for(lambda: mgr.db.get_session(sid)["status"] == "done", timeout=10)
    second = srv.requests[1]["messages"]
    roles = [m["role"] for m in second]
    assert roles[-2:] == ["tool", "user"], roles
    assert second[-2]["content"].startswith("done")
    assert second[-1]["content"] == "[Alice, steering]: Use the token bucket instead."


def test_tool_progress_reports_target_and_throttles():
    from baton.providers.base import ToolProgress

    p = ToolProgress("write_file")
    chunk = '{"path": "app/middleware/rate'
    first = p.feed(chunk)
    assert first.data == {"name": "write_file", "chars": len(chunk), "target": "app/middleware/rate"}
    assert p.feed('_limit.py", "content": "') is None  # throttled until ~240 more chars
    later = p.feed("x" * 300)
    assert later.data["target"] == "app/middleware/rate_limit.py" and later.data["chars"] > 300


async def test_catchup_summary_is_throttled(mgr):
    """Tabs poll the catch-up card on every few events; that must not turn into a model call each time."""
    from baton.providers.base import StreamEvent

    class Quiet:
        id = "anthropic"
        summaries = 0

        async def stream(self, **_):
            yield StreamEvent("text_delta", "Hello.")
            yield StreamEvent("done", data={"stop_reason": "end_turn"})

        async def complete(self, **_):
            Quiet.summaries += 1
            return "not json"  # an unusable summary must not be retried on the next poll either

    mgr.providers["anthropic"] = Quiet()
    sid = mgr.create_session(user_id="u_alice", task="Say hi", provider="anthropic", model="claude-sonnet-5-5")["id"]
    await wait_for(lambda: mgr.db.get_session(sid)["status"] == "waiting_input")
    for _ in range(5):
        mgr.catchup(sid)
        await wait_for(lambda: mgr._catchup_jobs[sid].done())
    assert Quiet.summaries == 1

    mgr._catchup_asked[sid] -= mgr.settings.catchup_min_seconds  # the window has passed
    mgr.catchup(sid)
    await wait_for(lambda: Quiet.summaries == 2)
