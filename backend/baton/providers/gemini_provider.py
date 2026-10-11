"""Google Gemini via the native Gemini API (google-genai SDK): streaming, function calling, thought summaries.

Gemini 3 attaches an encrypted "thought signature" to function calls and rejects a history whose calls
don't carry theirs back (HTTP 400). The runner stores each call's signature in its tool.call event, and
this adapter returns it, but only to the model that produced it. Calls written by another model (say, after
switching a session from Claude to Gemini mid-run) get the placeholder Google documents for exactly that
case, so the switch still works.
"""
from __future__ import annotations

import base64
import json
import uuid
from typing import AsyncIterator

from .base import LazyModule, ProviderError, StreamEvent, ToolProgress

genai = LazyModule("google.genai")
types = LazyModule("google.genai.types")
genai_errors = LazyModule("google.genai.errors")

# Google's documented stand-in for function calls the API didn't generate itself.
FOREIGN_CALL_SIGNATURE = b"skip_thought_signature_validator"

# Model families that can't run an agent loop (images, speech, embeddings, realtime audio, robotics).
NOT_FOR_CHAT = ("image", "tts", "embedding", "live", "audio", "robotics", "veo", "imagen", "aqa", "learnlm", "gemma")


class GeminiProvider:
    def __init__(self, id: str, api_key: str | None, models: list[str] | None = None, base_url: str | None = None,
                 http_client=None):
        self.id = id
        self._models = models or []
        self.configured = bool(api_key)
        self._api_key = api_key
        self._base_url = base_url
        self._http_client = http_client
        self._client = None
        self._discovered: list[str] | None = None
        self._thoughts = True  # ask for thought summaries; switched off for models that don't think

    @property
    def client(self):
        if self._client is None:
            opts = {}
            if self._base_url:
                opts["base_url"] = self._base_url
            if self._http_client is not None:
                opts["httpx_async_client"] = self._http_client
            self._client = genai.Client(api_key=self._api_key or "missing", http_options=types.HttpOptions(**opts) if opts else None)
        return self._client

    async def list_models(self) -> list[str]:
        """The account's chat models, newest first; the configured list until a key is set or if listing fails."""
        if not self.configured:
            return self._models
        if self._discovered is None:
            try:
                found = []
                async for m in await self.client.aio.models.list():
                    name = (m.name or "").removeprefix("models/")
                    actions = m.supported_actions or []
                    if name.startswith("gemini") and "generateContent" in actions and not any(x in name for x in NOT_FOR_CHAT):
                        found.append(name)
                # Configured models first (they're the team's picks), then everything else, newest versions first.
                rest = sorted((n for n in found if n not in self._models), reverse=True)
                self._discovered = [m for m in self._models if m in found] + rest if found else []
            except Exception:
                self._discovered = []
        return self._discovered or self._models

    # ---- wire format ----------------------------------------------------------------
    @staticmethod
    def to_wire(messages: list[dict], model: str | None = None) -> list:
        """Neutral messages to Gemini `contents`. Function responses are matched to calls by name and order."""
        names: dict[str, str] = {}
        contents: list = []
        for m in messages:
            role = "model" if m["role"] == "assistant" else "user"
            parts = []
            for b in m["content"]:
                if b["type"] == "text" and b["text"].strip():
                    parts.append(types.Part(text=b["text"]))
                elif b["type"] == "tool_call":
                    names[b["id"]] = b["name"]
                    sig = b.get("signature") or {}
                    mine = sig.get("model") == model and sig.get("value")
                    parts.append(types.Part(
                        function_call=types.FunctionCall(name=b["name"], args=b["input"] or {}),
                        thought_signature=base64.b64decode(sig["value"]) if mine else FOREIGN_CALL_SIGNATURE,
                    ))
                elif b["type"] == "tool_result":
                    out = b["output"] or "(no output)"
                    parts.append(types.Part(function_response=types.FunctionResponse(
                        name=names.get(b["id"], "tool"),
                        response={"error": out} if b.get("is_error") else {"output": out},
                    )))
                # Other providers' signed thinking ("thinking" blocks) means nothing to Gemini; skip it.
            if not parts:
                continue
            if contents and contents[-1].role == role:
                contents[-1].parts.extend(parts)
            else:
                contents.append(types.Content(role=role, parts=parts))
        return contents

    def _config(self, system: str, tools: list[dict], max_tokens: int):
        kwargs: dict = {
            "system_instruction": system,
            "max_output_tokens": max_tokens,
            # Baton runs the tools itself, so the agent's work lands in the shared log.
            "automatic_function_calling": types.AutomaticFunctionCallingConfig(disable=True),
        }
        if tools:
            kwargs["tools"] = [types.Tool(function_declarations=[
                types.FunctionDeclaration(name=t["name"], description=t["description"], parameters_json_schema=t["input_schema"])
                for t in tools
            ])]
        if self._thoughts:
            kwargs["thinking_config"] = types.ThinkingConfig(include_thoughts=True)
        return types.GenerateContentConfig(**kwargs)

    async def stream(self, *, model, system, messages, tools, max_tokens=4096) -> AsyncIterator[StreamEvent]:
        contents = self.to_wire(messages, model)
        calls: list[dict] = []
        finish = None
        usage = None
        try:
            try:
                resp = await self.client.aio.models.generate_content_stream(
                    model=model, contents=contents, config=self._config(system, tools, max_tokens))
            except genai_errors.ClientError as e:
                if not self._thoughts or "think" not in str(e).lower():
                    raise
                self._thoughts = False  # an older model without thinking; ask again without it
                resp = await self.client.aio.models.generate_content_stream(
                    model=model, contents=contents, config=self._config(system, tools, max_tokens))
            async for chunk in resp:
                if chunk.usage_metadata:
                    usage = chunk.usage_metadata
                for cand in chunk.candidates or []:
                    if cand.finish_reason:
                        finish = cand.finish_reason
                    for part in (cand.content.parts if cand.content and cand.content.parts else []):
                        if part.function_call:
                            fc = part.function_call
                            call = {
                                # Gemini doesn't always give calls ids; Baton needs ones unique in the session.
                                "id": fc.id or f"gm_{uuid.uuid4().hex[:12]}",
                                "name": fc.name or "",
                                "input": dict(fc.args or {}),
                            }
                            if part.thought_signature:
                                call["signature"] = base64.b64encode(part.thought_signature).decode()
                            calls.append(call)
                            prog = ToolProgress(call["name"]).feed(json.dumps(call["input"]))
                            if prog is not None:
                                yield prog
                        elif part.text:
                            yield StreamEvent("thinking_delta" if part.thought else "text_delta", part.text)
        except genai_errors.APIError as e:
            raise ProviderError(f"{self.id} API error {e.code}: {e.message or e.status or e}") from e
        except ProviderError:
            raise
        except Exception as e:  # noqa: BLE001 - network failures arrive as several httpx/aiohttp types
            raise ProviderError(f"Could not reach the Gemini API: {e}") from e

        for c in calls:
            yield StreamEvent("tool_call", data=c)
        if usage:
            yield StreamEvent("usage", data={
                "input_tokens": usage.prompt_token_count or 0,
                "output_tokens": (usage.candidates_token_count or 0) + (usage.thoughts_token_count or 0),
                "cached_tokens": usage.cached_content_token_count or 0,
            })
        reason = getattr(finish, "value", finish)
        if reason == "MAX_TOKENS":
            stop = "max_tokens"
        elif calls:
            stop = "tool_use"
        elif reason in (None, "STOP", "FINISH_REASON_UNSPECIFIED"):
            stop = "end_turn"
        else:
            stop = str(reason).lower()  # safety, malformed_function_call, ...
        yield StreamEvent("done", data={"stop_reason": stop})

    async def complete(self, *, model, system, prompt, max_tokens=1024) -> str:
        # No output cap here: thinking tokens count against it and could leave no room for the answer.
        try:
            r = await self.client.aio.models.generate_content(
                model=model, contents=prompt, config=types.GenerateContentConfig(system_instruction=system))
        except genai_errors.APIError as e:
            raise ProviderError(f"{self.id} API error {e.code}: {e.message or e}") from e
        except Exception as e:  # noqa: BLE001
            raise ProviderError(f"Could not reach the Gemini API: {e}") from e
        return r.text or ""
