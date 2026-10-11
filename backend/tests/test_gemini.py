"""The Gemini adapter against a fake server speaking the Gemini API's wire format (REST + SSE)."""
import base64
import json

import httpx
from starlette.applications import Starlette
from starlette.requests import Request
from starlette.responses import JSONResponse, Response
from starlette.routing import Route

from baton import context as ctx
from baton.providers.gemini_provider import FOREIGN_CALL_SIGNATURE, GeminiProvider
from conftest import wait_for

SIG = base64.b64encode(b"sig-from-gemini").decode()


def gemini_turn(text: str, tool: tuple[str, dict] | None, thought: str = "") -> Response:
    chunks = []
    if thought:
        chunks.append({"candidates": [{"content": {"role": "model", "parts": [{"text": thought, "thought": True}]}}]})
    if text:
        chunks.append({"candidates": [{"content": {"role": "model", "parts": [{"text": text[:4]}]}}]})
        chunks.append({"candidates": [{"content": {"role": "model", "parts": [{"text": text[4:]}]}}]})
    if tool:
        name, args = tool
        chunks.append({"candidates": [{"content": {"role": "model", "parts": [
            {"functionCall": {"name": name, "args": args}, "thoughtSignature": SIG}]}}]})
    chunks.append({"candidates": [{"content": {"role": "model", "parts": []}, "finishReason": "STOP"}],
                   "usageMetadata": {"promptTokenCount": 30, "candidatesTokenCount": 7, "thoughtsTokenCount": 5}})
    return Response("".join(f"data: {json.dumps(c)}\n\n" for c in chunks), media_type="text/event-stream")


class FakeGemini:
    def __init__(self, turns: list):
        self.turns = list(turns)
        self.requests: list[dict] = []
        self.app = Starlette(routes=[
            Route("/v1beta/models", self.models, methods=["GET"]),
            Route("/v1beta/models/{rest:path}", self.generate, methods=["POST"]),
        ])

    async def models(self, request: Request):
        return JSONResponse({"models": [
            {"name": "models/gemini-9-pro", "supportedGenerationMethods": ["generateContent", "countTokens"]},
            {"name": "models/gemini-9-flash", "supportedGenerationMethods": ["generateContent"]},
            {"name": "models/gemini-9-flash-image", "supportedGenerationMethods": ["generateContent"]},
            {"name": "models/gemini-embedding-9", "supportedGenerationMethods": ["embedContent"]},
        ]})

    async def generate(self, request: Request):
        body = await request.json()
        self.requests.append(body)
        if request.path_params["rest"].endswith(":generateContent"):
            return JSONResponse({"candidates": [{"content": {"role": "model", "parts": [
                {"text": '{"doing": "Writing tests", "done": [], "next": []}'}]}, "finishReason": "STOP"}]})
        text, tool = self.turns.pop(0) if self.turns else ("All set.", None)
        return gemini_turn(text, tool, thought="Planning the next step." if tool else "")

    def provider(self, models=None) -> GeminiProvider:
        client = httpx.AsyncClient(transport=httpx.ASGITransport(app=self.app), base_url="http://fake")
        return GeminiProvider("gemini", "test-key", models or ["gemini-9-flash"], base_url="http://fake/", http_client=client)


async def test_streams_text_thoughts_and_signed_tool_calls():
    srv = FakeGemini([("Looking around.", ("list_files", {"path": "."}))])
    p = srv.provider()
    evs = []
    async for ev in p.stream(model="gemini-9-flash", system="sys", messages=[{"role": "user", "content": [{"type": "text", "text": "hi"}]}],
                             tools=[{"name": "list_files", "description": "List", "input_schema": {"type": "object", "properties": {"path": {"type": "string"}}}}]):
        evs.append(ev)
    assert "".join(e.text for e in evs if e.kind == "text_delta") == "Looking around."
    assert "".join(e.text for e in evs if e.kind == "thinking_delta") == "Planning the next step."
    call = [e.data for e in evs if e.kind == "tool_call"][0]
    assert call["name"] == "list_files" and call["input"] == {"path": "."} and call["signature"] == SIG
    assert call["id"].startswith("gm_")
    assert [e.data for e in evs if e.kind == "usage"][0] == {"input_tokens": 30, "output_tokens": 12, "cached_tokens": 0}
    assert [e.data for e in evs if e.kind == "done"][0]["stop_reason"] == "tool_use"
    req = srv.requests[0]
    assert req["systemInstruction"]["parts"][0]["text"] == "sys"
    assert req["tools"][0]["functionDeclarations"][0]["name"] == "list_files"
    thinking = req["generationConfig"]["thinkingConfig"]
    assert thinking.get("includeThoughts", thinking.get("include_thoughts")) is True


async def test_lists_chat_models_with_the_configured_ones_first():
    p = FakeGemini([]).provider(models=["gemini-9-flash"])
    assert await p.list_models() == ["gemini-9-flash", "gemini-9-pro"]
    assert await GeminiProvider("gemini", None, ["gemini-x"]).list_models() == ["gemini-x"]  # no key: the configured list


async def test_session_on_gemini_returns_signatures_only_to_the_model_that_made_them(mgr):
    srv = FakeGemini([
        ("Reading the server.", ("read_file", {"path": "app/server.py"})),
        ("Done.", ("finish", {"summary": "ok"})),
    ])
    mgr.providers["gemini"] = srv.provider()
    sid = mgr.create_session(user_id="u_alice", task="Look around", provider="gemini", model="gemini-9-flash")["id"]
    await wait_for(lambda: mgr.db.get_session(sid)["status"] == "done", timeout=10)

    call = next(e for e in mgr.db.events(sid) if e["type"] == "tool.call")["payload"]
    assert call["signature"] == {"model": "gemini-9-flash", "value": SIG}
    second = srv.requests[1]["contents"]
    fc_part = next(p for c in second for p in c["parts"] if "functionCall" in p)
    assert fc_part["thoughtSignature"] == SIG
    fr_part = next(p for c in second for p in c["parts"] if "functionResponse" in p)
    assert fr_part["functionResponse"]["name"] == "read_file"
    assert [c["role"] for c in second] == ["user", "model", "user"]

    # Another model (or a call another provider wrote) gets Google's documented placeholder instead.
    msgs = ctx.build_messages("Look around", "u_alice", mgr.db.events(sid), mgr.names(sid))
    other = GeminiProvider.to_wire(msgs, "gemini-9-pro")
    sigs = [p.thought_signature for c in other for p in c.parts if p.function_call]
    assert sigs and all(s == FOREIGN_CALL_SIGNATURE for s in sigs)
