"""Stream any agent's work into a Baton session. Standard library only.

    from baton_client import BatonSession

    s = BatonSession.create("http://localhost:8000", task="Fix the flaky test", agent="my-agent")
    print("watch at", s.url)
    s.plan(["Reproduce", "Fix", "Verify"])
    s.say("Reproducing the failure first.")
    call = s.tool("run_command", {"command": "pytest -x"})
    s.result(call, output, is_error=code != 0)
    for msg in s.poll():            # what the humans said since last time
        ...                         # msg["type"]: human.message (steer) | human.interrupt | human.decision
    answer = s.ask("Retry or quarantine the test?", ["Retry", "Quarantine"])   # blocks until the driver decides
    s.done("Quarantined test_upload; filed a ticket.")

Each call becomes an event in the session's log, so people in the browser see the
steps live, can comment on them, and steer the agent from the composer.
"""
from __future__ import annotations

import json
import time
import urllib.error
import urllib.request
import uuid


class BatonError(RuntimeError):
    pass


class BatonSession:
    def __init__(self, base_url: str, session_id: str, token: str):
        self.base = base_url.rstrip("/")
        self.id = session_id
        self.token = token
        self.cursor = 0  # last seq seen by poll()
        self.turn = 0
        self._held: list[dict] = []  # messages that arrived while ask() was waiting

    # ---- setup ---------------------------------------------------------
    @classmethod
    def create(cls, base_url: str, task: str, agent: str = "External agent", title: str | None = None) -> "BatonSession":
        r = _request("POST", base_url.rstrip("/") + "/api/external/sessions", {"task": task, "agent": agent, "title": title})
        s = cls(base_url, r["session"]["id"], r["ingest_token"])
        s.cursor = r["session"]["head_seq"]
        return s

    @property
    def url(self) -> str:
        return f"{self.base}/s/{self.id}"

    # ---- writing -------------------------------------------------------
    def send(self, *events: dict) -> list[int]:
        r = _request("POST", f"{self.base}/api/sessions/{self.id}/ingest", {"events": list(events)}, self.token)
        return r["seqs"]

    def say(self, text: str) -> None:
        self.turn += 1
        self.send({"type": "agent.text", "payload": {"text": text, "turn": self.turn}})

    def tool(self, name: str, args: dict) -> str:
        call_id = "call_" + uuid.uuid4().hex[:12]
        self.send({"type": "tool.call", "payload": {"call_id": call_id, "name": name, "input": args, "turn": self.turn}})
        return call_id

    def result(self, call_id: str, output: str, is_error: bool = False, duration_ms: int = 0, **extra) -> None:
        self.send({"type": "tool.result", "payload": {"call_id": call_id, "output": output, "is_error": is_error,
                                                      "duration_ms": duration_ms, **extra}})

    def plan(self, steps: list[str] | list[dict]) -> None:
        norm = [s if isinstance(s, dict) else {"title": s, "status": "pending"} for s in steps]
        call = self.tool("update_plan", {"steps": norm})
        self.send({"type": "agent.plan", "payload": {"steps": norm, "call_id": call}},
                  {"type": "tool.result", "payload": {"call_id": call, "output": "Plan published", "duration_ms": 0}})

    def done(self, summary: str) -> None:
        call = self.tool("finish", {"summary": summary})
        self.result(call, "Task marked complete.")
        self.send({"type": "session.status", "payload": {"status": "done", "summary": summary}})

    # ---- reading what the humans said ---------------------------------------
    def poll(self, wait: float = 0.0) -> list[dict]:
        held, self._held = self._held, []
        return held + self._fetch(0 if held else wait)

    def _fetch(self, wait: float) -> list[dict]:
        r = _request("GET", f"{self.base}/api/sessions/{self.id}/inbox?after={self.cursor}&wait={wait}", None, self.token)
        self.cursor = r["head_seq"]
        return r["events"]

    def ask(self, question: str, options: list[str] | None = None, timeout: float = 3600) -> str:
        """Pause for a human decision. Returns the driver's answer."""
        call = self.tool("ask_humans", {"question": question, "options": options or []})
        self.send({"type": "agent.decision_point", "payload": {"call_id": call, "question": question, "options": options or []}},
                  {"type": "session.status", "payload": {"status": "waiting_input", "reason": "decision"}})
        deadline = time.time() + timeout
        while time.time() < deadline:
            for e in self._fetch(wait=20):
                if e["type"] == "human.decision" and e["payload"].get("call_id") == call:
                    answer = e["payload"]["answer"]
                    self.result(call, f"{e['author']} decided: {answer}")
                    self.send({"type": "session.status", "payload": {"status": "running"}})
                    return answer
                self._held.append(e)  # steering that arrived meanwhile; the next poll() returns it
        raise BatonError("No decision before the timeout")


def _request(method: str, url: str, body: dict | None = None, token: str | None = None) -> dict:
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method, headers={"Content-Type": "application/json"})
    if token:
        req.add_header("Authorization", f"Bearer {token}")
    try:
        with urllib.request.urlopen(req, timeout=40) as r:
            return json.load(r)
    except urllib.error.HTTPError as e:
        raise BatonError(f"{e.code}: {e.read().decode(errors='replace')[:300]}") from None
