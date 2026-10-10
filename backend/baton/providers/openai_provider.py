"""OpenAI Chat Completions, which doubles as the adapter for any OpenAI-compatible
server: Ollama, vLLM, LM Studio, llama.cpp, OpenRouter, Groq, Together, ..."""
from __future__ import annotations

import json
from typing import AsyncIterator

import openai

from .base import ProviderError, StreamEvent, safe_tool_id


class OpenAIProvider:
    def __init__(self, id: str, api_key: str | None, base_url: str | None = None,
                 models: list[str] | None = None, discover: bool = False, http_client=None):
        self.id = id
        self._models = models or []
        self.discover = discover
        self.base_url = base_url
        self.configured = bool(api_key)
        self.client = openai.AsyncOpenAI(api_key=api_key or "missing", base_url=base_url or None, max_retries=1,
                                         timeout=300, http_client=http_client)
        self._stream_usage = True  # some local servers reject stream_options

    async def list_models(self) -> list[str]:
        if not self.discover:
            return self._models
        try:
            page = await self.client.with_options(timeout=2.0, max_retries=0).models.list()
            found = sorted(m.id for m in page.data)
            return found or self._models
        except Exception:
            return self._models

    @staticmethod
    def to_wire(system: str, messages: list[dict]) -> list[dict]:
        out: list[dict] = [{"role": "system", "content": system}]
        for m in messages:
            texts = [b["text"] for b in m["content"] if b["type"] == "text" and b["text"]]
            if m["role"] == "assistant":
                calls = [b for b in m["content"] if b["type"] == "tool_call"]
                msg: dict = {"role": "assistant", "content": "\n\n".join(texts) or None}
                if calls:
                    msg["tool_calls"] = [
                        {"id": safe_tool_id(c["id"]), "type": "function",
                         "function": {"name": c["name"], "arguments": json.dumps(c["input"])}}
                        for c in calls
                    ]
                out.append(msg)
            else:
                for b in m["content"]:
                    if b["type"] == "tool_result":
                        out.append({"role": "tool", "tool_call_id": safe_tool_id(b["id"]), "content": b["output"] or "(no output)"})
                if texts:
                    out.append({"role": "user", "content": "\n\n".join(texts)})
        return out

    async def stream(self, *, model, system, messages, tools, max_tokens=4096) -> AsyncIterator[StreamEvent]:
        wire_tools = [
            {"type": "function", "function": {"name": t["name"], "description": t["description"], "parameters": t["input_schema"]}}
            for t in tools
        ]
        kwargs: dict = {"model": model, "messages": self.to_wire(system, messages), "tools": wire_tools, "stream": True}
        if self._stream_usage:
            kwargs["stream_options"] = {"include_usage": True}
        try:
            try:
                resp = await self.client.chat.completions.create(**kwargs)
            except openai.BadRequestError as e:
                if "stream_options" not in str(e):
                    raise
                self._stream_usage = False
                kwargs.pop("stream_options")
                resp = await self.client.chat.completions.create(**kwargs)

            calls: dict[int, dict] = {}
            finish = None
            usage = None
            async for chunk in resp:
                if chunk.usage:
                    usage = chunk.usage
                if not chunk.choices:
                    continue
                ch = chunk.choices[0]
                d = ch.delta
                extra = getattr(d, "model_extra", None) or {}
                reasoning = extra.get("reasoning_content") or extra.get("reasoning")
                if isinstance(reasoning, str) and reasoning:
                    yield StreamEvent("thinking_delta", reasoning)
                if d.content:
                    yield StreamEvent("text_delta", d.content)
                for tc in d.tool_calls or []:
                    slot = calls.setdefault(tc.index if tc.index is not None else len(calls), {"id": "", "name": "", "args": ""})
                    if tc.id:
                        slot["id"] = tc.id
                    if tc.function and tc.function.name:
                        slot["name"] += tc.function.name
                    if tc.function and tc.function.arguments:
                        slot["args"] += tc.function.arguments
                if ch.finish_reason:
                    finish = ch.finish_reason
        except openai.APIStatusError as e:
            raise ProviderError(f"{self.id} API error {e.status_code}: {_msg(e)}") from e
        except openai.APIConnectionError as e:
            where = self.base_url or "api.openai.com"
            raise ProviderError(f"Could not reach {where}. Is the server running?") from e

        for i, slot in sorted(calls.items()):
            try:
                args = json.loads(slot["args"]) if slot["args"].strip() else {}
            except json.JSONDecodeError:
                args = {"_raw": slot["args"]}
            if not isinstance(args, dict):
                args = {"value": args}
            yield StreamEvent("tool_call", data={"id": slot["id"] or f"call_{i}", "name": slot["name"], "input": args})
        if usage:
            cached = 0
            details = getattr(usage, "prompt_tokens_details", None)
            if details is not None:
                cached = getattr(details, "cached_tokens", 0) or 0
            yield StreamEvent("usage", data={
                "input_tokens": usage.prompt_tokens or 0,
                "output_tokens": usage.completion_tokens or 0,
                "cached_tokens": cached,
            })
        yield StreamEvent("done", data={"stop_reason": "tool_use" if calls else (finish or "stop")})

    async def complete(self, *, model, system, prompt, max_tokens=1024) -> str:
        try:
            r = await self.client.chat.completions.create(
                model=model,
                messages=[{"role": "system", "content": system}, {"role": "user", "content": prompt}],
            )
        except openai.APIError as e:
            raise ProviderError(f"{self.id} API error: {e}") from e
        return r.choices[0].message.content or ""


def _msg(e: openai.APIStatusError) -> str:
    try:
        body = e.response.json()
        err = body.get("error")
        if isinstance(err, dict):
            return err.get("message") or json.dumps(body)[:300]
        return str(err or body)[:300]
    except Exception:
        return str(e)[:300]
