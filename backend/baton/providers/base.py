"""The provider-neutral contract every model adapter implements.

Conversation format (what the runner builds from the event log):

    {"role": "user" | "assistant", "content": [block, ...]}

    block = {"type": "text", "text": str}
          | {"type": "tool_call", "id": str, "name": str, "input": dict}
          | {"type": "tool_result", "id": str, "output": str, "is_error": bool}
          | {"type": "thinking", "model": str, "raw": dict}   # signed reasoning, replayed only to the same model

Adapters translate this to their wire format and stream back StreamEvents.
"""
from __future__ import annotations

import importlib
import re
from dataclasses import dataclass, field
from typing import Any, AsyncIterator, Literal, Protocol

StreamKind = Literal["text_delta", "thinking_delta", "thinking_block", "tool_progress", "tool_call", "usage", "done"]


@dataclass
class StreamEvent:
    kind: StreamKind
    text: str = ""
    data: dict[str, Any] = field(default_factory=dict)


class ProviderError(Exception):
    pass


class Provider(Protocol):
    id: str

    def stream(
        self,
        *,
        model: str,
        system: str,
        messages: list[dict],
        tools: list[dict],
        max_tokens: int = 4096,
    ) -> AsyncIterator[StreamEvent]: ...

    async def complete(self, *, model: str, system: str, prompt: str, max_tokens: int = 1024) -> str: ...

    async def list_models(self) -> list[str]: ...


class LazyModule:
    """Import a heavy SDK on first use, so the server (and a restart mid-demo) comes up fast."""

    def __init__(self, name: str):
        self._name = name

    def __getattr__(self, attr: str):
        return getattr(importlib.import_module(self._name), attr)


class ToolProgress:
    """Turns streamed tool-call JSON into occasional progress updates for viewers."""

    TARGET = re.compile(r'"(path|command)"\s*:\s*"((?:[^"\\]|\\.)*)')  # value may still be streaming

    def __init__(self, name: str):
        self.name, self.raw, self.sent = name, "", -1

    def feed(self, chunk: str) -> StreamEvent | None:
        self.raw += chunk
        if self.sent >= 0 and len(self.raw) - self.sent < 240:
            return None
        self.sent = len(self.raw)
        m = self.TARGET.search(self.raw)
        return StreamEvent("tool_progress", data={"name": self.name, "chars": len(self.raw), "target": m.group(2)[:120] if m else ""})


def text_of(blocks: list[dict]) -> str:
    return "".join(b["text"] for b in blocks if b["type"] == "text")


def safe_tool_id(raw: str) -> str:
    """Tool-call ids cross providers when a session switches models; keep them valid everywhere."""
    cleaned = "".join(c if c.isalnum() or c in "_-" else "_" for c in raw)[:40]
    return cleaned or "call_0"
