"""Session lifecycle, the human command queue, and the agent runner.

Writers:
  * Humans act only through `SessionManager.command`, which validates the
    sender's role and appends human.* / control.* events.
  * The `Runner` is the only writer of agent events (agent.*, tool.*).
Every append goes through `SessionManager.append`, which stores the event and
fans it out in one synchronous step, so subscribers always see seq order.
"""
from __future__ import annotations

import asyncio
import hmac
import json
import logging
import random
import re
import secrets
import time
from pathlib import Path

import httpx

from . import context as ctx
from .billing import Billing
from .config import Settings
from .db import DB, new_id
from .hub import Hub
from .providers import build_provider
from .providers.base import ProviderError
from .sandbox import (
    CONTROL_TOOLS, TOOL_SPECS, ToolError, Workspace, content_hash, execute_tool, replay_file_changes,
)

log = logging.getLogger("baton")

COLORS = ["#2563eb", "#db2777", "#059669", "#d97706", "#7c3aed", "#0891b2", "#dc2626", "#4f46e5"]
ACTIVE = {"running"}
MAX_AUTONOMOUS_TURNS = 60
EXTERNAL = "external"  # provider id for sessions driven by an agent running elsewhere
MAX_EDIT_CHARS = 400_000  # a hand edit is stored whole in the log so forks and audits can replay it
MAX_COMMAND_CHARS = 2_000

# What an external agent may write into its session, and what it reads back from its inbox.
INGEST_TYPES = {"agent.text", "agent.thinking", "tool.call", "tool.result", "agent.plan", "agent.decision_point", "agent.turn"}
INBOX_TYPES = {"human.message", "human.interrupt", "human.decision", "control.driver_changed"}


class CommandError(Exception):
    pass


class PaymentRequired(CommandError):
    """The model needs an active subscription (HTTP 402)."""


class SessionManager:
    def __init__(self, settings: Settings, db: DB | None = None):
        self.settings = settings
        self.db = db or DB(settings.data_dir / "baton.db")
        self.hub = Hub()
        self.runners: dict[str, Runner] = {}
        self.providers = {p.id: build_provider(p, settings) for p in settings.providers}
        self._catchup_cache: dict[str, dict] = {}
        self._catchup_jobs: dict[str, asyncio.Task] = {}
        self._bg: set[asyncio.Task] = set()
        self.billing = Billing(settings, self.db)
        self.terminals: dict[str, tuple[asyncio.Task, asyncio.Task]] = {}  # session -> (work, record) of a terminal command

    # ---- helpers ---------------------------------------------------------
    def workspace(self, session_id: str) -> Workspace:
        return Workspace(self.settings.data_dir / "workspaces" / session_id, runtime=self.settings.sandbox,
                         image=self.settings.sandbox_image)

    def names(self, session_id: str) -> dict[str, str]:
        ids = {p["user_id"] for p in self.db.participants(session_id)}
        s = self.db.get_session(session_id)
        if s:
            ids.add(s["created_by"])
        return {uid: u["name"] for uid, u in self.db.users(list(ids)).items()}

    def append(self, session_id: str, actor: str, type_: str, payload: dict) -> dict:
        ev = self.db.append_event(session_id, actor, type_, payload)
        self.hub.broadcast(session_id, {"type": "event", "event": ev})
        return ev

    def session_view(self, session_id: str) -> dict:
        s = self.db.get_session(session_id)
        if not s:
            raise KeyError(session_id)
        s = dict(s)
        s["participants"] = self.participants_view(session_id)
        return s

    def participants_view(self, session_id: str) -> list[dict]:
        pres = self.hub.presence(session_id)
        s = self.db.get_session(session_id)
        out = []
        for p in self.db.participants(session_id):
            live = pres.get(p["user_id"], {})
            out.append({
                "user_id": p["user_id"], "name": p["name"], "color": p["color"], "role": p["role"],
                "is_owner": bool(s and s["created_by"] == p["user_id"]),
                "online": bool(live.get("online")), "typing": bool(live.get("typing")),
                "viewing_seq": live.get("viewing_seq"), "focus_seq": live.get("focus_seq"), "file": live.get("file"),
                "last_seen_seq": p["last_seen_seq"],
                "last_active": p["last_active"],
            })
        return out

    def broadcast_presence(self, session_id: str) -> None:
        self.hub.broadcast(session_id, {"type": "presence", "participants": self.participants_view(session_id)})

    def broadcast_session(self, session_id: str) -> None:
        s = self.db.get_session(session_id)
        if s:
            self.hub.broadcast(session_id, {"type": "session", "session": s})

    def set_status(self, session_id: str, status: str, **info) -> None:
        s = self.db.get_session(session_id)
        if not s or (s["status"] == status and not info.get("force")):
            return
        info.pop("force", None)
        self.db.update_session(session_id, status=status)
        self.append(session_id, "system", "session.status", {"status": status, **info})
        self.broadcast_session(session_id)

    def ensure_user(self, user_id: str, name: str | None = None, color: str | None = None) -> dict:
        u = self.db.get_user(user_id)
        if u and not name:
            return u
        name = (name or (u and u["name"]) or "Guest").strip()[:40] or "Guest"
        color = color or (u and u["color"]) or random.choice(COLORS)
        return self.db.upsert_user(user_id, name, color)

    def spawn(self, coro) -> asyncio.Task:
        t = asyncio.create_task(coro)
        self._bg.add(t)
        t.add_done_callback(self._bg.discard)
        return t

    # ---- lifecycle -------------------------------------------------------
    def create_session(self, *, user_id: str, task: str, provider: str, model: str,
                       repo: str = "notes-api", title: str | None = None) -> dict:
        task = task.strip()
        if not task:
            raise CommandError("Describe a task for the agent")
        pconf = self.settings.provider(provider)
        if not pconf:
            raise CommandError(f"Unknown provider: {provider}")
        self.require_plan(provider)
        title = (title or "").strip() or ctx.clip(ctx.first_sentence(task), 72)
        s = self.db.create_session(title=title, task=task, created_by=user_id, provider=provider, model=model,
                                   config={"repo": repo}, status="running")
        Workspace.create(self.workspace(s["id"]).root, repo, runtime=self.settings.sandbox, image=self.settings.sandbox_image)
        self.db.upsert_participant(s["id"], user_id, "driver")
        self.append(s["id"], user_id, "session.started", {
            "task": task, "title": title, "repo": repo, "provider": provider, "model": model,
        })
        self.start_runner(s["id"])
        return self.session_view(s["id"])

    def require_plan(self, provider: str) -> None:
        if not self.billing.allows(provider):
            label = (self.settings.provider(provider).label if self.settings.provider(provider) else provider)
            raise PaymentRequired(
                f"{label} models need a {self.settings.plan_name} subscription. Subscribe on the Billing page, "
                "or use the Offline demo model, which is free."
            )

    def wake_runner(self, session_id: str) -> None:
        s = self.db.get_session(session_id)
        if s and s["provider"] != EXTERNAL:
            self.start_runner(session_id).wake.set()

    def start_runner(self, session_id: str) -> "Runner":
        r = self.runners.get(session_id)
        if r is None or r.task is None or r.task.done():
            r = Runner(self, session_id)
            self.runners[session_id] = r
            r.start()
        return r

    async def resume_all(self) -> int:
        """On boot, pick every unfinished session back up from its log."""
        n = 0
        for s in self.db.list_sessions():
            if s["provider"] == EXTERNAL:
                continue
            events = self.db.events(s["id"])
            # A command someone was running in the terminal died with the server; say so.
            finished = {e["payload"]["call_id"] for e in events if e["type"] == "human.command_result"}
            for e in events:
                if e["type"] == "human.command" and e["payload"]["call_id"] not in finished:
                    self.append(s["id"], e["actor"], "human.command_result", {
                        "call_id": e["payload"]["call_id"], "command": e["payload"]["command"],
                        "output": "The server restarted while this command was running; it did not complete.",
                        "is_error": True, "cancelled": True, "duration_ms": 0,
                    })
            if s["status"] == "done":
                continue
            calls = {e["payload"]["call_id"]: e for e in events if e["type"] == "tool.call"}
            results = {e["payload"]["call_id"] for e in events if e["type"] == "tool.result"}
            decisions = {e["payload"]["call_id"] for e in events if e["type"] == "agent.decision_point"}
            orphans = [cid for cid in calls if cid not in results and cid not in decisions]
            if s["status"] == "running" or orphans:
                for cid in orphans:
                    self.append(s["id"], "agent", "tool.result", {
                        "call_id": cid, "output": "The server restarted while this call was running; it did not complete.",
                        "is_error": True, "cancelled": True, "duration_ms": 0,
                    })
                self.append(s["id"], "system", "session.resumed", {"after_seq": s["head_seq"], "status": s["status"]})
                n += 1
            self.start_runner(s["id"])
        return n

    async def shutdown(self) -> None:
        terminals = list(self.terminals.values())
        for work, _ in terminals:
            work.cancel()
        # Let them record that they were stopped while the log is still open.
        await asyncio.gather(*(record for _, record in terminals), return_exceptions=True)
        for r in list(self.runners.values()):
            await r.stop()
        for t in list(self._bg):
            t.cancel()

    # ---- external agents ------------------------------------------------------
    def create_external(self, *, task: str, agent: str, title: str | None = None) -> tuple[dict, str]:
        """A session whose agent runs elsewhere and streams its steps in through the ingest API."""
        task, agent = task.strip(), (agent.strip() or "External agent")[:40]
        if not task:
            raise CommandError("Describe the task the agent is working on")
        bot = "ext_" + (re.sub(r"[^a-z0-9]+", "-", agent.lower()).strip("-") or "agent")
        self.ensure_user(bot, agent, "#52525b")
        title = (title or "").strip() or ctx.clip(ctx.first_sentence(task), 72)
        s = self.db.create_session(title=title, task=task, created_by=bot, provider=EXTERNAL, model=agent,
                                   config={"external": True}, status="running", driver_id=None)
        token = secrets.token_urlsafe(24)
        self.db.set_ingest_token(s["id"], token)
        self.append(s["id"], bot, "session.started", {"task": task, "title": title, "repo": None,
                                                     "provider": EXTERNAL, "model": agent})
        return self.session_view(s["id"]), token

    def check_ingest(self, session_id: str, token: str | None) -> dict:
        s = self.db.get_session(session_id)
        expected = self.db.ingest_token(session_id) if s else None
        if not s or not expected or not token or not hmac.compare_digest(expected, token):
            raise PermissionError("Bad session id or ingest token")
        return s

    def ingest(self, session_id: str, events: list[dict]) -> list[int]:
        seqs = []
        for e in events:
            t, p = e.get("type"), e.get("payload") or {}
            if t == "session.status":
                status = p.get("status")
                if status not in ("running", "waiting_input", "done", "error"):
                    raise CommandError(f"Unsupported status: {status}")
                self.set_status(session_id, status, **{k: v for k, v in p.items() if k in ("reason", "summary")})
                seqs.append(self.db.get_session(session_id)["head_seq"])
                continue
            if t not in INGEST_TYPES:
                raise CommandError(f"Unsupported event type: {t}")
            if t in ("tool.call", "tool.result", "agent.decision_point") and not p.get("call_id"):
                raise CommandError(f"{t} needs a call_id")
            if t == "tool.call" and not p.get("name"):
                raise CommandError("tool.call needs a name")
            seqs.append(self.append(session_id, "agent", t, p)["seq"])
        return seqs

    def inbox(self, session_id: str, after: int) -> list[dict]:
        names = self.names(session_id)
        out = []
        for e in self.db.events(session_id, after=after):
            if e["type"] not in INBOX_TYPES:
                continue
            if e["type"] == "human.message" and e["payload"].get("mode") != "steer":
                continue
            out.append({**e, "author": ctx.actor_name(names, e["actor"]),
                        **({"text": ctx.steer_text(e, names)} if e["type"] == "human.message" else {})})
        return out

    # ---- joins -----------------------------------------------------------
    def join(self, session_id: str, user_id: str, role: str | None = None) -> dict:
        s = self.db.get_session(session_id)
        if not s:
            raise KeyError(session_id)
        existing = self.db.get_participant(session_id, user_id)
        if existing:
            return existing
        p = self.db.upsert_participant(session_id, user_id, "viewer" if role == "viewer" else "collaborator")
        self.append(session_id, user_id, "participant.joined", {"role": p["role"]})
        return p

    # ---- commands ---------------------------------------------------------
    async def command(self, session_id: str, user_id: str, msg: dict) -> None:
        s = self.db.get_session(session_id)
        if not s:
            raise CommandError("Session not found")
        part = self.db.get_participant(session_id, user_id) or self.join(session_id, user_id)
        kind = msg.get("type")
        is_driver = s["driver_id"] == user_id
        is_owner = s["created_by"] == user_id
        self.db.update_participant(session_id, user_id, last_active=time.time())

        def require_driver() -> None:
            if not is_driver:
                raise CommandError("Only the driver can do that. Request control first.")

        if kind == "steer":
            # On an open floor (say, judges on their phones) collaborators steer directly; otherwise only the driver.
            open_floor = bool(s["config"].get("open_floor")) and part["role"] == "collaborator"
            if not open_floor:
                require_driver()
            text = (msg.get("text") or "").strip()
            if not text:
                return
            self.append(session_id, user_id, "human.message",
                        {"text": text[:4000], "mode": "steer", **({"open_floor": True} if not is_driver else {})})
            self._after_steer(session_id)
        elif kind == "set_open_floor":
            require_driver()
            on = bool(msg.get("on"))
            if bool(s["config"].get("open_floor")) == on:
                return
            self.db.update_session(session_id, config={**s["config"], "open_floor": on})
            self.append(session_id, user_id, "control.open_floor", {"on": on})
            self.broadcast_session(session_id)
        elif kind == "suggest":
            if part["role"] == "viewer":
                raise CommandError("Viewers can comment but not suggest")
            text = (msg.get("text") or "").strip()
            if text:
                self.append(session_id, user_id, "human.message", {"text": text, "mode": "suggest"})
        elif kind == "promote":
            require_driver()
            self._promote(session_id, user_id, msg)
        elif kind == "dismiss_suggestion":
            require_driver()
            self.append(session_id, user_id, "human.suggestion_dismissed", {"seq": int(msg["seq"])})
        elif kind == "interrupt":
            require_driver()
            runner = self.runners.get(session_id)
            if s["status"] != "running":
                return
            self.append(session_id, user_id, "human.interrupt", {})
            if runner:
                await runner.interrupt(user_id)
        elif kind == "resume":
            require_driver()
            if s["status"] in ("waiting_input", "error", "paused") and not ctx.open_decisions(self.db.events(session_id)):
                self.set_status(session_id, "running", reason="resumed")
                self.wake_runner(session_id)
        elif kind == "answer_decision":
            require_driver()
            self._answer_decision(session_id, user_id, msg)
        elif kind == "request_driver":
            if part["role"] == "viewer":
                raise CommandError("Viewers cannot drive")
            if is_driver:
                return
            self.append(session_id, user_id, "control.driver_requested", {"from": user_id, "driver": s["driver_id"]})
        elif kind == "grant_driver":
            require_driver()
            to = msg.get("to")
            target = self.db.get_participant(session_id, to or "")
            if not target or target["role"] == "viewer" or to == user_id:
                raise CommandError("Pick a collaborator to hand off to")
            self._change_driver(session_id, user_id, to, reason=msg.get("reason") or "handoff", note=msg.get("note"))
        elif kind == "decline_driver":
            require_driver()
            self.append(session_id, user_id, "control.driver_declined", {"to": msg.get("to")})
        elif kind == "take_driver":
            if is_driver:
                return
            if part["role"] == "viewer":
                raise CommandError("Viewers cannot drive")
            drv = s["driver_id"]
            drv_part = self.db.get_participant(session_id, drv) if drv else None
            idle = time.time() - (drv_part["last_active"] if drv_part else 0)
            away = self.hub.offline_for(session_id, drv) if drv else 1e9
            if not (away > 20 or (is_owner and idle > self.settings.driver_idle_seconds)):
                raise CommandError("The driver is active. Ask them to hand off.")
            self._change_driver(session_id, drv, user_id, reason="force", actor=user_id)
        elif kind == "set_model":
            require_driver()
            provider, model = msg.get("provider"), (msg.get("model") or "").strip()
            if s["provider"] == EXTERNAL:
                raise CommandError("This session is driven by an external agent; its model is chosen there")
            if not self.settings.provider(provider) or not model:
                raise CommandError("Unknown model")
            if provider == s["provider"] and model == s["model"]:
                return
            self.require_plan(provider)
            self.db.update_session(session_id, provider=provider, model=model)
            self.append(session_id, user_id, "control.model_changed", {
                "from": {"provider": s["provider"], "model": s["model"]}, "to": {"provider": provider, "model": model},
            })
            self.broadcast_session(session_id)
            if s["status"] == "error":
                self.set_status(session_id, "running", reason="model changed")
                self.wake_runner(session_id)
        elif kind == "rename":
            require_driver()
            title = (msg.get("title") or "").strip()[:100]
            if title:
                self.db.update_session(session_id, title=title)
                self.broadcast_session(session_id)
        elif kind == "save_file":
            require_driver()
            self._save_file(s, user_id, msg)
        elif kind == "run_command":
            require_driver()
            self._run_command(s, user_id, msg)
        elif kind == "stop_command":
            require_driver()
            running = self.terminals.get(session_id)
            if running:
                running[0].cancel()
        else:
            raise CommandError(f"Unknown command: {kind}")

    # ---- the IDE: hand edits and the terminal --------------------------------
    def _workspace_for(self, s: dict) -> Workspace:
        if s["provider"] == EXTERNAL:
            raise CommandError("This session's agent runs elsewhere, so there is no workspace to edit here")
        ws = self.workspace(s["id"])
        if not ws.root.exists():
            raise CommandError("This session has no workspace")
        return ws

    def _save_file(self, s: dict, user_id: str, msg: dict) -> None:
        """The driver saves a file from the editor. The edit is an event, so it's attributed, replayable and
        forkable, and the agent reads it at its next turn like any other human input."""
        ws = self._workspace_for(s)
        path = str(msg.get("path") or "").strip().replace("\\", "/").lstrip("/")
        content = msg.get("content")
        if not path or not isinstance(content, str):
            raise CommandError("Bad save: a path and the file's content are required")
        if len(content) > MAX_EDIT_CHARS:
            raise CommandError("That file is too large to save from the editor")
        try:
            current = ws.read_text(path)
            base = msg.get("base")
            # `base` is the fingerprint of the text the editor started from; None means "creating a new file".
            if not msg.get("force") and base is not None and content_hash(current) != base:
                raise CommandError(f"{path} changed since you opened it. Reload it, or save anyway to overwrite.")
            if current == content:
                return
            _, diff = ws.write_file(path, content)
        except ToolError as e:
            raise CommandError(str(e)) from e
        self.append(s["id"], user_id, "human.edit", {
            "path": path, "content": content, "diff": diff, "created": current is None, "hash": content_hash(content),
        })

    def _run_command(self, s: dict, user_id: str, msg: dict) -> None:
        """The driver runs a command in the session's terminal, in the same workspace the agent uses."""
        ws = self._workspace_for(s)
        command = str(msg.get("command") or "").strip()
        if not command:
            return
        if len(command) > MAX_COMMAND_CHARS:
            raise CommandError("That command is too long")
        if s["id"] in self.terminals:
            raise CommandError("A command is already running in the terminal. Wait for it, or stop it.")
        call_id = "cmd_" + new_id()
        self.append(s["id"], user_id, "human.command", {"call_id": call_id, "command": command})
        # stop_command cancels `work`; `record` always writes the outcome, even if work never got to start.
        work = asyncio.create_task(execute_tool(ws, "run_command", {"command": command, "timeout_seconds": 120}))

        async def record() -> None:
            await asyncio.wait({work})
            self.terminals.pop(s["id"], None)
            if work.cancelled():
                res = {"output": "", "is_error": True, "cancelled": True, "duration_ms": 0}
            else:
                res = work.result()
            full = res.pop("full_output", None)
            if full is not None:
                blob = self.settings.data_dir / "blobs" / s["id"] / f"{call_id}.txt"
                blob.parent.mkdir(parents=True, exist_ok=True)
                blob.write_text(full, encoding="utf-8")
                res["truncated"] = True
            self.append(s["id"], user_id, "human.command_result", {"call_id": call_id, "command": command, **res})

        self.terminals[s["id"]] = (work, self.spawn(record()))

    def _after_steer(self, session_id: str) -> None:
        s = self.db.get_session(session_id)
        if s["status"] != "running" and not ctx.open_decisions(self.db.events(session_id)):
            self.set_status(session_id, "running", reason="steered")
        self.wake_runner(session_id)

    def _promote(self, session_id: str, user_id: str, msg: dict) -> None:
        if msg.get("comment_id"):
            c = self.db.get_comment(msg["comment_id"])
            if not c or c["session_id"] != session_id:
                raise CommandError("Comment not found")
            if c.get("promoted_seq"):
                return
            text = msg.get("text") or c["body"]
            target = self.db.events(session_id, after=c["event_seq"] - 1, upto=c["event_seq"])
            about = ""
            if target and target[0]["type"] == "tool.call":
                about = f" (re: {ctx.describe_call(target[0]['payload']['name'], target[0]['payload'].get('input') or {})})"
            ev = self.append(session_id, user_id, "human.message", {
                "text": text + about, "mode": "steer", "promoted_from": {"comment_id": c["id"], "event_seq": c["event_seq"]},
                "suggested_by": c["user_id"],
            })
            self.db.update_comment(c["id"], promoted_seq=ev["seq"], resolved=1)
            self.hub.broadcast(session_id, {"type": "comment", "comment": self.db.get_comment(c["id"])})
        else:
            seq = int(msg["seq"])
            src = self.db.events(session_id, after=seq - 1, upto=seq)
            if not src or src[0]["type"] != "human.message" or src[0]["payload"].get("mode") != "suggest":
                raise CommandError("That suggestion no longer exists")
            if any(e["type"] == "human.message" and (e["payload"].get("promoted_from") or {}).get("seq") == seq
                   for e in self.db.events(session_id, after=seq)):
                return
            self.append(session_id, user_id, "human.message", {
                "text": msg.get("text") or src[0]["payload"]["text"], "mode": "steer",
                "promoted_from": {"seq": seq}, "suggested_by": src[0]["actor"],
            })
        self._after_steer(session_id)

    def _answer_decision(self, session_id: str, user_id: str, msg: dict) -> None:
        events = self.db.events(session_id)
        pending = {d["seq"]: d for d in ctx.open_decisions(events)}
        seq = int(msg.get("seq") or (max(pending) if pending else 0))
        if seq not in pending:
            raise CommandError("That decision was already made")
        answer = (msg.get("answer") or "").strip()
        if not answer:
            raise CommandError("Pick an option or write an answer")
        dp = next(e for e in events if e["seq"] == seq)
        self.append(session_id, user_id, "human.decision", {
            "decision_seq": seq, "call_id": dp["payload"]["call_id"], "answer": answer,
        })
        self.set_status(session_id, "running", reason="decision made")
        self.wake_runner(session_id)

    def _change_driver(self, session_id: str, frm: str | None, to: str, reason: str, note: str | None = None,
                       actor: str | None = None) -> None:
        self.db.update_session(session_id, driver_id=to)
        if frm:
            self.db.update_participant(session_id, frm, role="collaborator")
        self.db.update_participant(session_id, to, role="driver", last_active=time.time())
        self.append(session_id, actor or frm or "system", "control.driver_changed",
                    {"from": frm, "to": to, "reason": reason, "note": note})
        self.broadcast_session(session_id)
        self.broadcast_presence(session_id)

    # ---- comments ----------------------------------------------------------
    def add_comment(self, session_id: str, user_id: str, event_seq: int, body: str, parent_id: str | None = None) -> dict:
        body = body.strip()
        if not body:
            raise CommandError("Comment is empty")
        s = self.db.get_session(session_id)
        if not s or not (0 < event_seq <= s["head_seq"]):
            raise CommandError("No such event")
        if not self.db.get_participant(session_id, user_id):
            self.join(session_id, user_id)
        c = self.db.add_comment(session_id, event_seq, user_id, body[:4000], parent_id)
        self.hub.broadcast(session_id, {"type": "comment", "comment": c})
        return c

    def resolve_comment(self, session_id: str, comment_id: str, resolved: bool) -> dict:
        c = self.db.get_comment(comment_id)
        if not c or c["session_id"] != session_id:
            raise CommandError("Comment not found")
        self.db.update_comment(comment_id, resolved=int(resolved))
        c = self.db.get_comment(comment_id)
        self.hub.broadcast(session_id, {"type": "comment", "comment": c})
        return c

    # ---- fork --------------------------------------------------------------
    def fork(self, session_id: str, seq: int, user_id: str) -> dict:
        s = self.db.get_session(session_id)
        if not s:
            raise KeyError(session_id)
        if s["provider"] == EXTERNAL:
            raise CommandError("Forking sessions driven by an external agent isn't supported yet")
        seq = max(1, min(seq, s["head_seq"]))
        events = self.db.events(session_id, upto=seq)
        # Never fork in the middle of a tool call: back up to before an unfinished call.
        results = {e["payload"]["call_id"] for e in events if e["type"] == "tool.result"}
        for e in events:
            if e["type"] == "tool.call" and e["payload"]["call_id"] not in results and e["payload"]["name"] != "ask_humans":
                seq = e["seq"] - 1
                events = [x for x in events if x["seq"] <= seq]
                break
        new = self.db.create_session(title=s["title"], task=s["task"], created_by=user_id, provider=s["provider"],
                                     model=s["model"], config=s["config"], status="waiting_input",
                                     parent_session_id=session_id, fork_seq=seq, driver_id=user_id)
        self.db.copy_events(session_id, new["id"], seq)
        self.db.copy_comments(session_id, new["id"], seq)
        for p in self.db.participants(session_id):
            self.db.upsert_participant(new["id"], p["user_id"], "collaborator")
        self.db.upsert_participant(new["id"], user_id, "driver")
        self.db.update_participant(new["id"], user_id, role="driver")
        ws = Workspace.create(self.workspace(new["id"]).root, s["config"].get("repo", "notes-api"),
                              runtime=self.settings.sandbox, image=self.settings.sandbox_image)
        applied = replay_file_changes(ws, events)
        self.append(new["id"], user_id, "session.forked", {
            "parent_session_id": session_id, "parent_title": s["title"], "fork_seq": seq, "files_restored": applied,
        })
        if ctx.open_decisions(events):
            self.db.update_session(new["id"], status="waiting_input")
        self.start_runner(new["id"])
        return self.session_view(new["id"])

    # ---- catch-up -----------------------------------------------------------
    def catchup(self, session_id: str, user_id: str | None = None) -> dict:
        s = self.db.get_session(session_id)
        if not s:
            raise KeyError(session_id)
        events = self.db.events(session_id)
        names = self.names(session_id)
        card = ctx.heuristic_card(s, events, names)
        cached = self._catchup_cache.get(session_id)
        if cached and cached["head_seq"] <= s["head_seq"]:
            stale = s["head_seq"] - cached["head_seq"]
            if stale <= 12:
                card.update({k: cached[k] for k in ("doing", "done", "next") if cached.get(k)})
                card["source"] = cached["source"]
                card["summary_seq"] = cached["head_seq"]
            if stale > 6:
                self._refresh_catchup(session_id)
        else:
            self._refresh_catchup(session_id)
        if user_id:
            p = self.db.get_participant(session_id, user_id)
            if p:
                since = p["last_seen_seq"]
                card["since_seq"] = since
                card["new_events"] = max(0, s["head_seq"] - since)
                card["new_interventions"] = [c for c in ctx.interventions(events, names) if c["seq"] > since][-5:]
        return card

    def _refresh_catchup(self, session_id: str) -> None:
        job = self._catchup_jobs.get(session_id)
        if job and not job.done():
            return
        self._catchup_jobs[session_id] = self.spawn(self._llm_catchup(session_id))

    async def _llm_catchup(self, session_id: str) -> None:
        s = self.db.get_session(session_id)
        pconf = self.settings.provider(s["provider"])
        provider = self.providers.get(s["provider"])
        if not pconf or not provider or pconf.kind == "scripted":
            return
        if pconf.discover_models and not pconf.summary_model:
            return  # local models: don't compete with the agent for the GPU; the log card is enough
        events = self.db.events(session_id)
        names = self.names(session_id)
        card = ctx.heuristic_card(s, events, names)
        cp = self.db.last_event_of(session_id, "agent.checkpoint")
        tail = [e for e in events if not cp or e["seq"] > cp["payload"]["covers_seq"]][-80:]
        prompt = ctx.catchup_prompt(s, cp["payload"]["summary"] if cp else "", ctx.render_events(tail, names), card)
        model = pconf.summary_model or s["model"]
        try:
            text = await asyncio.wait_for(
                provider.complete(model=model, system=ctx.CATCHUP_SYSTEM, prompt=prompt, max_tokens=600), timeout=45
            )
        except (ProviderError, asyncio.TimeoutError, Exception) as e:  # noqa: BLE001 - fall back to the log card
            log.info("catch-up summary unavailable for %s: %s", session_id, e)
            return
        data = ctx.parse_json_object(text)
        if not data:
            return
        fresh = {
            "head_seq": card["head_seq"],
            "doing": ctx.clip(str(data.get("doing", "")), 200) or card["doing"],
            "done": [ctx.clip(str(x), 120) for x in (data.get("done") or [])][:5],
            "next": [ctx.clip(str(x), 120) for x in (data.get("next") or [])][:4],
            "source": model,
        }
        self._catchup_cache[session_id] = fresh
        self.hub.broadcast(session_id, {"type": "catchup_updated", "head_seq": fresh["head_seq"]})

    def mark_seen(self, session_id: str, user_id: str, seq: int) -> None:
        p = self.db.get_participant(session_id, user_id)
        if p and seq > p["last_seen_seq"]:
            self.db.update_participant(session_id, user_id, last_seen_seq=seq)

    # ---- notifications -----------------------------------------------------
    def notify(self, session_id: str, text: str) -> None:
        if not self.settings.slack_webhook:
            return

        async def post() -> None:
            try:
                async with httpx.AsyncClient(timeout=5) as c:
                    await c.post(self.settings.slack_webhook, json={"text": text})
            except httpx.HTTPError as e:
                log.info("webhook failed: %s", e)

        self.spawn(post())


class Runner:
    """Drives one session's agent loop. Context is rebuilt from the log each turn."""

    def __init__(self, mgr: SessionManager, session_id: str):
        self.mgr = mgr
        self.sid = session_id
        self.wake = asyncio.Event()
        self.task: asyncio.Task | None = None
        self.current: asyncio.Task | None = None
        self.interrupted_by: str | None = None
        self.partial_text = ""
        self.partial_thinking = ""
        self.thinking_blocks: list[dict] = []
        self.turn_model = ""
        self.autonomous_turns = 0
        self.checkpointing = False

    def start(self) -> None:
        self.task = asyncio.create_task(self._loop(), name=f"runner-{self.sid}")

    async def stop(self) -> None:
        if self.task:
            self.task.cancel()
            try:
                await self.task
            except (asyncio.CancelledError, Exception):
                pass

    async def interrupt(self, by: str) -> None:
        self.interrupted_by = by
        if self.current and not self.current.done():
            self.current.cancel()

    # ---- loop --------------------------------------------------------------
    async def _loop(self) -> None:
        db = self.mgr.db
        while True:
            s = db.get_session(self.sid)
            if s is None:
                return
            if s["status"] not in ACTIVE:
                self.wake.clear()
                await self.wake.wait()
                continue
            try:
                await self._turn(s)
            except asyncio.CancelledError:
                raise
            except ProviderError as e:
                self.mgr.hub.clear_partial(self.sid)
                self.mgr.append(self.sid, "system", "session.error", {"message": str(e), "provider": s["provider"], "model": s["model"]})
                self.mgr.set_status(self.sid, "error", reason=str(e))
            except Exception as e:  # noqa: BLE001 - keep the session alive and visible
                log.exception("runner crashed for %s", self.sid)
                self.mgr.hub.clear_partial(self.sid)
                self.mgr.append(self.sid, "system", "session.error", {"message": f"Internal error: {e}"})
                self.mgr.set_status(self.sid, "error", reason="internal error")

    def _next_turn_no(self) -> int:
        r = self.mgr.db.conn.execute(
            "SELECT COUNT(*) FROM events WHERE session_id=? AND type='agent.turn'", (self.sid,)
        ).fetchone()
        return r[0] + 1

    async def _turn(self, s: dict) -> None:
        mgr, db = self.mgr, self.mgr.db
        self._resolve_decisions()
        events = db.events(self.sid)
        if ctx.open_decisions(events):
            mgr.set_status(self.sid, "waiting_input", reason="decision")
            return
        pconf = mgr.settings.provider(s["provider"])
        provider = mgr.providers.get(s["provider"])
        if not pconf or not provider:
            raise ProviderError(f"Provider {s['provider']} is not configured on this server")

        names = mgr.names(self.sid)
        cp = db.last_event_of(self.sid, "agent.checkpoint") if pconf.kind != "scripted" else None
        messages = ctx.build_messages(s["task"], s["created_by"], events, names, cp)
        if pconf.kind != "scripted" and ctx.estimate_tokens(messages) > 0.7 * pconf.context_window:
            cp = await self._checkpoint(s, events, names, force=True) or cp
            messages = ctx.build_messages(s["task"], s["created_by"], events, names, cp)

        if self.interrupted_by:  # an interrupt landed between steps; honor it before starting another
            self._stop_for_interrupt([])
            return
        turn = self._next_turn_no()
        head_before = s["head_seq"]
        self.partial_text = self.partial_thinking = ""
        self.thinking_blocks = []
        self.turn_model = s["model"]
        calls: list[dict] = []
        meta: dict = {}
        t0 = time.monotonic()

        async def stream_model() -> None:
            async for ev in provider.stream(model=s["model"], system=ctx.SYSTEM_PROMPT, messages=messages, tools=TOOL_SPECS,
                                            max_tokens=pconf.max_output_tokens):
                if ev.kind == "text_delta":
                    self.partial_text += ev.text
                    mgr.hub.delta(self.sid, "text", ev.text, turn)
                elif ev.kind == "thinking_delta":
                    self.partial_thinking += ev.text
                    mgr.hub.delta(self.sid, "thinking", ev.text, turn)
                elif ev.kind == "tool_call":
                    calls.append(ev.data)
                elif ev.kind == "tool_progress":
                    mgr.hub.tool_progress(self.sid, turn, ev.data)
                elif ev.kind == "thinking_block":
                    self.thinking_blocks.append(ev.data)
                elif ev.kind == "usage":
                    meta["usage"] = ev.data
                elif ev.kind == "done":
                    meta["stop_reason"] = ev.data.get("stop_reason")

        self.current = asyncio.create_task(stream_model())
        await asyncio.wait({self.current})
        cancelled = self.current.cancelled()
        if not cancelled and self.current.exception():
            mgr.hub.clear_partial(self.sid)
            self._persist_text(turn, interrupted=False)
            raise self.current.exception()  # type: ignore[misc]

        self._persist_text(turn, interrupted=cancelled)
        mgr.hub.clear_partial(self.sid)
        if cancelled:
            self._end_turn(turn, s, meta, t0, interrupted=True)
            self._stop_for_interrupt([])
            return

        # Record every call first so viewers see the whole intended step, then execute in order.
        for c in calls:
            mgr.append(self.sid, "agent", "tool.call", {
                "call_id": c["id"], "name": c["name"], "input": c.get("input") or {}, "turn": turn,
                # Gemini 3 wants its signature back on this call; only the model that made it can use it.
                **({"signature": {"model": s["model"], "value": c["signature"]}} if c.get("signature") else {}),
            })
        self._end_turn(turn, s, meta, t0)
        if calls and meta.get("stop_reason") in ("max_tokens", "length"):
            # The output was cut off, so the last call's arguments may be truncated. Never run them.
            for c in calls:
                self._result(c["id"], "Not run: your reply hit the output token limit and this call may be "
                             "incomplete. Make smaller edits (edit_file) or split large files.", error=True)
            return

        ask: dict | None = None
        finish: dict | None = None
        for i, c in enumerate(calls):
            name, args = c["name"], c.get("input") or {}
            if name == "ask_humans":
                if ask is None:
                    ask = c
                else:
                    self._result(c["id"], "Only one question can be open at a time. Ask again after this one is answered.", error=True)
                continue
            if name == "finish":
                finish = c
                continue
            if name == "update_plan":
                steps = [st for st in (args.get("steps") or []) if isinstance(st, dict) and st.get("title")]
                mgr.append(self.sid, "agent", "agent.plan", {"steps": steps, "call_id": c["id"]})
                self._result(c["id"], "Plan published to the session.")
                continue
            self.current = asyncio.create_task(execute_tool(mgr.workspace(self.sid), name, args))
            await asyncio.wait({self.current})
            if self.current.cancelled():
                self._stop_for_interrupt(calls[i:])
                return
            res = self.current.result()
            full = res.pop("full_output", None)
            if full is not None:
                blob = mgr.settings.data_dir / "blobs" / self.sid / f"{c['id']}.txt"
                blob.parent.mkdir(parents=True, exist_ok=True)
                blob.write_text(full, encoding="utf-8")
                res["truncated"] = True
            mgr.append(self.sid, "agent", "tool.result", {"call_id": c["id"], **res})
            if self.interrupted_by:
                self._stop_for_interrupt(calls[i + 1:])
                return

        if ask:
            args = ask.get("input") or {}
            options = [str(o) for o in (args.get("options") or []) if str(o).strip()][:6]
            mgr.append(self.sid, "agent", "agent.decision_point", {
                "call_id": ask["id"], "question": str(args.get("question") or "The agent needs a decision."), "options": options,
            })
            if finish:
                self._result(finish["id"], "Not finished: a decision is still open.", error=True)
            mgr.set_status(self.sid, "waiting_input", reason="decision")
            mgr.notify(self.sid, f"Baton: the agent in “{s['title']}” is waiting on a decision: {args.get('question')}")
            return
        if finish:
            summary = str((finish.get("input") or {}).get("summary") or "")
            self._result(finish["id"], "Task marked complete.")
            mgr.set_status(self.sid, "done", reason="finished", summary=summary)
            mgr.notify(self.sid, f"Baton: “{s['title']}” is done.\n{summary}")
            return

        self.autonomous_turns += 1
        humans_spoke = any(
            (e["type"] == "human.message" and e["payload"].get("mode") == "steer") or e["type"] == "human.decision"
            for e in db.events(self.sid, after=head_before)
        )
        if humans_spoke:
            self.autonomous_turns = 0
        if not calls and not humans_spoke:
            mgr.set_status(self.sid, "waiting_input", reason="agent replied")
        elif self.autonomous_turns >= MAX_AUTONOMOUS_TURNS:
            self.autonomous_turns = 0
            mgr.set_status(self.sid, "waiting_input", reason="turn limit")
        self._maybe_checkpoint(s)

    # ---- helpers -------------------------------------------------------------
    def _stop_for_interrupt(self, unfinished: list[dict]) -> None:
        by = self.interrupted_by
        for c in unfinished:
            self._result(c["id"], "", error=True, cancelled=True, cancelled_by=by)
        self.interrupted_by = None
        self.autonomous_turns = 0
        self.mgr.set_status(self.sid, "waiting_input", reason="interrupted", by=by)

    def _persist_text(self, turn: int, interrupted: bool) -> None:
        blocks = [] if interrupted else self.thinking_blocks
        if self.partial_thinking.strip() or blocks:
            text = self.partial_thinking or "\n\n".join(b.get("thinking", "") for b in blocks)
            self.mgr.append(self.sid, "agent", "agent.thinking",
                            {"text": text, "turn": turn, "blocks": blocks, "model": self.turn_model})
        self.thinking_blocks = []
        if self.partial_text.strip() or interrupted:
            if self.partial_text.strip():
                self.mgr.append(self.sid, "agent", "agent.text", {"text": self.partial_text, "turn": turn, "interrupted": interrupted})
        self.partial_text = self.partial_thinking = ""

    def _end_turn(self, turn: int, s: dict, meta: dict, t0: float, interrupted: bool = False) -> None:
        self.mgr.append(self.sid, "agent", "agent.turn", {
            "turn": turn, "provider": s["provider"], "model": s["model"], "usage": meta.get("usage") or {},
            "stop_reason": "interrupted" if interrupted else meta.get("stop_reason"),
            "duration_ms": int((time.monotonic() - t0) * 1000),
        })

    def _result(self, call_id: str, output: str, error: bool = False, **extra) -> None:
        self.mgr.append(self.sid, "agent", "tool.result", {"call_id": call_id, "output": output, "is_error": error, "duration_ms": 0, **extra})

    def _resolve_decisions(self) -> None:
        """Turn answered decision points into the tool results the model is waiting for."""
        events = self.mgr.db.events(self.sid)
        results = {e["payload"]["call_id"] for e in events if e["type"] == "tool.result"}
        names = self.mgr.names(self.sid)
        for e in events:
            if e["type"] == "human.decision" and e["payload"]["call_id"] not in results:
                who = ctx.actor_name(names, e["actor"])
                self._result(e["payload"]["call_id"], f"{who} decided: {e['payload']['answer']}", decided_by=e["actor"])

    def _maybe_checkpoint(self, s: dict) -> None:
        pconf = self.mgr.settings.provider(s["provider"])
        cp = self.mgr.db.last_event_of(self.sid, "agent.checkpoint")
        after = cp["payload"]["covers_seq"] if cp else 0
        events = self.mgr.db.events(self.sid)
        if pconf and not self.checkpointing and len(ctx.turn_starts(events, after)) >= self.mgr.settings.checkpoint_every_turns:
            self.mgr.spawn(self._checkpoint(s, events, self.mgr.names(self.sid)))

    async def _checkpoint(self, s: dict, events: list[dict], names: dict, force: bool = False) -> dict | None:
        if self.checkpointing:
            return None
        self.checkpointing = True
        try:
            return await self._write_checkpoint(s, events, names, force)
        finally:
            self.checkpointing = False

    async def _write_checkpoint(self, s: dict, events: list[dict], names: dict, force: bool) -> dict | None:
        mgr = self.mgr
        prev = mgr.db.last_event_of(self.sid, "agent.checkpoint")
        after = prev["payload"]["covers_seq"] if prev else 0
        keep = mgr.settings.keep_recent_turns if not force else max(2, mgr.settings.keep_recent_turns // 2)
        cut = ctx.checkpoint_cut(events, after, keep)
        if cut is None or cut <= after:
            return None
        chunk = [e for e in events if after < e["seq"] <= cut]
        prev_summary = prev["payload"]["summary"] if prev else ""
        pconf = mgr.settings.provider(s["provider"])
        provider = mgr.providers.get(s["provider"])
        summary, source = "", "log"
        if pconf and provider and pconf.kind != "scripted":
            prompt = (
                f"Task: {s['task']}\n\n"
                + (f"Existing summary:\n{prev_summary}\n\n" if prev_summary else "")
                + "New events to fold in:\n" + ctx.render_events(chunk, names, 16000)
                + "\n\nWrite an updated summary (under 250 words) an engineer could resume from: decisions made and "
                "by whom, files changed, test status, open problems. Plain text."
            )
            try:
                summary = await asyncio.wait_for(provider.complete(
                    model=pconf.summary_model or s["model"], system="You compress agent work logs.", prompt=prompt, max_tokens=700,
                ), timeout=60)
                source = pconf.summary_model or s["model"]
            except Exception as e:  # noqa: BLE001
                log.info("checkpoint summary fell back to log summary: %s", e)
        if not summary.strip():
            summary = ctx.heuristic_summary(s, [e for e in events if e["seq"] <= cut], names, "")
        ev = mgr.append(self.sid, "agent", "agent.checkpoint", {"summary": summary.strip(), "covers_seq": cut, "source": source})
        mgr.db.update_session(self.sid, summary_seq=cut)
        return ev
