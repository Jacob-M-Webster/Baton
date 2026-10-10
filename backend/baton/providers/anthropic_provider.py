"""Claude via the Anthropic Messages API (streaming, tool use, prompt caching)."""
from __future__ import annotations

import json
from typing import AsyncIterator

import anthropic

from .base import ProviderError, StreamEvent, safe_tool_id


class AnthropicProvider:
    def __init__(self, id: str, api_key: str | None, base_url: str | None = None, models: list[str] | None = None,
                 http_client=None):
        self.id = id
        self._models = models or []
        self.client = anthropic.AsyncAnthropic(api_key=api_key or "missing", base_url=base_url or None, max_retries=2,
                                               http_client=http_client)
        self.configured = bool(api_key)

    async def list_models(self) -> list[str]:
        return self._models

    @staticmethod
    def to_wire(messages: list[dict], model: str | None = None) -> list[dict]:
        out = []
        for m in messages:
            content = []
            for b in m["content"]:
                if b["type"] == "thinking":
                    # Signed thinking must be returned verbatim during a tool loop, and only to the model that wrote it.
                    if model and b.get("model") == model:
                        content.append(dict(b["raw"]))
                elif b["type"] == "text":
                    if b["text"].strip():
                        content.append({"type": "text", "text": b["text"]})
                elif b["type"] == "tool_call":
                    content.append({"type": "tool_use", "id": safe_tool_id(b["id"]), "name": b["name"], "input": b["input"]})
                elif b["type"] == "tool_result":
                    content.append({
                        "type": "tool_result",
                        "tool_use_id": safe_tool_id(b["id"]),
                        "content": b["output"] or "(no output)",
                        "is_error": bool(b.get("is_error")),
                    })
            if not content:
                continue
            if out and out[-1]["role"] == m["role"]:
                out[-1]["content"].extend(content)
            else:
                out.append({"role": m["role"], "content": content})
        # Cache the whole conversation prefix so each turn only pays for what's new.
        if out:
            last = out[-1]["content"][-1]
            last["cache_control"] = {"type": "ephemeral"}
        return out

    async def stream(self, *, model, system, messages, tools, max_tokens=4096) -> AsyncIterator[StreamEvent]:
        if not self.configured:
            raise ProviderError("ANTHROPIC_API_KEY is not set on the server")
        wire_tools = [{"name": t["name"], "description": t["description"], "input_schema": t["input_schema"]} for t in tools]
        try:
            async with self.client.messages.stream(
                model=model,
                max_tokens=max_tokens,
                system=[{"type": "text", "text": system, "cache_control": {"type": "ephemeral"}}],
                messages=self.to_wire(messages, model),
                tools=wire_tools,
            ) as stream:
                async for ev in stream:
                    if ev.type == "content_block_delta":
                        d = ev.delta
                        if d.type == "text_delta":
                            yield StreamEvent("text_delta", d.text)
                        elif d.type == "thinking_delta":
                            yield StreamEvent("thinking_delta", d.thinking)
                final = await stream.get_final_message()
        except anthropic.APIStatusError as e:
            raise ProviderError(f"Anthropic API error {e.status_code}: {_msg(e)}") from e
        except anthropic.APIConnectionError as e:
            raise ProviderError(f"Could not reach the Anthropic API: {e}") from e

        for block in final.content:
            if block.type == "thinking":
                yield StreamEvent("thinking_block", data={"type": "thinking", "thinking": block.thinking, "signature": block.signature})
            elif block.type == "redacted_thinking":
                yield StreamEvent("thinking_block", data={"type": "redacted_thinking", "data": block.data})
        for block in final.content:
            if block.type == "tool_use":
                yield StreamEvent("tool_call", data={"id": block.id, "name": block.name, "input": block.input or {}})
        u = final.usage
        yield StreamEvent("usage", data={
            "input_tokens": (u.input_tokens or 0) + (getattr(u, "cache_read_input_tokens", 0) or 0)
            + (getattr(u, "cache_creation_input_tokens", 0) or 0),
            "output_tokens": u.output_tokens or 0,
            "cached_tokens": getattr(u, "cache_read_input_tokens", 0) or 0,
        })
        yield StreamEvent("done", data={"stop_reason": final.stop_reason})

    async def complete(self, *, model, system, prompt, max_tokens=1024) -> str:
        if not self.configured:
            raise ProviderError("ANTHROPIC_API_KEY is not set on the server")
        try:
            msg = await self.client.messages.create(
                model=model, max_tokens=max_tokens, system=system,
                messages=[{"role": "user", "content": prompt}],
            )
        except anthropic.APIError as e:
            raise ProviderError(f"Anthropic API error: {e}") from e
        return "".join(b.text for b in msg.content if b.type == "text")


def _msg(e: anthropic.APIStatusError) -> str:
    try:
        body = e.response.json()
        return body.get("error", {}).get("message") or json.dumps(body)[:300]
    except Exception:
        return str(e)[:300]
