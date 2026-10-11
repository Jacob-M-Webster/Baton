"""In-process fan-out: live events, streaming deltas and presence per session."""
from __future__ import annotations

import asyncio
import time
from dataclasses import dataclass, field
from typing import Any


@dataclass(eq=False)
class Conn:
    user_id: str
    queue: asyncio.Queue = field(default_factory=lambda: asyncio.Queue(maxsize=5000))
    viewing_seq: int | None = None  # scrubbed back to this step
    focus_seq: int | None = None  # scrolled up and reading this step
    file: str | None = None  # file open in the code view
    typing_until: float = 0.0
    connected_at: float = field(default_factory=time.time)
    overflowed: bool = False

    def send(self, msg: dict[str, Any]) -> None:
        if self.overflowed:
            return
        try:
            self.queue.put_nowait(msg)
        except asyncio.QueueFull:
            # A stuck client must not stall the session. Its socket gets closed and the
            # client resubscribes from the last seq it saw, so nothing is lost.
            self.overflowed = True


class Hub:
    def __init__(self) -> None:
        self.conns: dict[str, set[Conn]] = {}
        # In-flight streamed text per session, so late joiners see the sentence being written.
        self.partial: dict[str, dict] = {}
        self.last_seen_online: dict[tuple[str, str], float] = {}

    def add(self, session_id: str, conn: Conn) -> None:
        self.conns.setdefault(session_id, set()).add(conn)

    def remove(self, session_id: str, conn: Conn) -> None:
        self.conns.get(session_id, set()).discard(conn)
        self.last_seen_online[(session_id, conn.user_id)] = time.time()

    def broadcast(self, session_id: str, msg: dict) -> None:
        for c in list(self.conns.get(session_id, ())):
            c.send(msg)

    def online_users(self, session_id: str) -> set[str]:
        return {c.user_id for c in self.conns.get(session_id, ())}

    def offline_for(self, session_id: str, user_id: str) -> float:
        if user_id in self.online_users(session_id):
            return 0.0
        return time.time() - self.last_seen_online.get((session_id, user_id), 0.0)

    def presence(self, session_id: str) -> dict[str, dict]:
        now = time.time()
        out: dict[str, dict] = {}
        for c in self.conns.get(session_id, ()):
            p = out.setdefault(c.user_id, {"online": True, "typing": False, "viewing_seq": None, "focus_seq": None, "file": None, "tabs": 0})
            p["tabs"] += 1
            p["typing"] = p["typing"] or c.typing_until > now
            if c.viewing_seq is not None:
                p["viewing_seq"] = c.viewing_seq
            if c.focus_seq is not None:
                p["focus_seq"] = c.focus_seq
            if c.file is not None:
                p["file"] = c.file
        return out

    # ---- streaming partials --------------------------------------------
    def delta(self, session_id: str, kind: str, text: str, turn: int) -> None:
        part = self.partial.get(session_id)
        if not part or part["turn"] != turn:
            part = self.partial[session_id] = {"turn": turn, "text": "", "thinking": "", "tool": None}
        part[kind] += text
        self.broadcast(session_id, {"type": "delta", "kind": kind, "text": text, "turn": turn})

    def tool_progress(self, session_id: str, turn: int, data: dict) -> None:
        """The model is still writing a tool call (say, a long file); show what and how much."""
        part = self.partial.get(session_id)
        if not part or part["turn"] != turn:
            part = self.partial[session_id] = {"turn": turn, "text": "", "thinking": "", "tool": None}
        part["tool"] = data
        self.broadcast(session_id, {"type": "tool_progress", "turn": turn, "tool": data})

    def clear_partial(self, session_id: str) -> None:
        if self.partial.pop(session_id, None) is not None:
            self.broadcast(session_id, {"type": "partial", "turn": None, "text": "", "thinking": ""})
