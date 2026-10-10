"""HTTP + WebSocket API, and static hosting for the built web app."""
from __future__ import annotations

import asyncio
import json
import logging
import socket
import time
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, Header, HTTPException, Request, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse, JSONResponse, PlainTextResponse
from pydantic import BaseModel, Field

from . import context as ctx
from .config import ROOT, Settings, load_settings
from .hub import Conn
from .sandbox import SAMPLE_REPOS, list_sample_repos
from .sessions import CommandError, SessionManager

log = logging.getLogger("baton")
WEB_DIST = ROOT / "web" / "dist"


class UserIn(BaseModel):
    id: str = Field(min_length=4, max_length=64)
    name: str = Field(min_length=1, max_length=40)
    color: str | None = None


class SessionIn(BaseModel):
    user_id: str
    task: str = Field(min_length=1, max_length=8000)
    title: str | None = None
    provider: str = "demo"
    model: str = "baton-demo"
    repo: str = "notes-api"


class ForkIn(BaseModel):
    user_id: str
    seq: int | None = None


class ExternalSessionIn(BaseModel):
    task: str = Field(min_length=1, max_length=8000)
    agent: str = Field(default="External agent", max_length=40)
    title: str | None = None


class IngestIn(BaseModel):
    events: list[dict] = Field(max_length=500)


class CommentIn(BaseModel):
    user_id: str
    event_seq: int
    body: str = Field(min_length=1, max_length=4000)
    parent_id: str | None = None


def _warm_sdks(settings: Settings) -> None:
    import importlib

    kinds = {p.kind for p in settings.providers if p.api_key or p.discover_models}
    for kind, module in (("anthropic", "anthropic"), ("openai", "openai")):
        if kind in kinds:
            try:
                importlib.import_module(module)
            except ImportError:
                log.warning("%s SDK is not installed", module)


def lan_urls(port: int) -> list[str]:
    urls = []
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("10.255.255.255", 1))
        ip = s.getsockname()[0]
        s.close()
        if not ip.startswith("127."):
            urls.append(f"http://{ip}:{port}")
    except OSError:
        pass
    return urls


def create_app(settings: Settings | None = None) -> FastAPI:
    settings = settings or load_settings()

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        mgr = SessionManager(settings)
        app.state.mgr = mgr
        resumed = await mgr.resume_all()
        if resumed:
            log.info("resumed %d running session(s)", resumed)
        # Load the model SDKs off the event loop once the server is already answering.
        warm = asyncio.create_task(asyncio.to_thread(_warm_sdks, settings))
        yield
        warm.cancel()
        await mgr.shutdown()
        mgr.db.close()

    app = FastAPI(title="Baton", lifespan=lifespan)

    def mgr(request_or_ws) -> SessionManager:
        return request_or_ws.app.state.mgr

    @app.exception_handler(CommandError)
    async def _cmd_err(_: Request, e: CommandError):
        return JSONResponse({"error": str(e)}, status_code=400)

    @app.exception_handler(PermissionError)
    async def _perm_err(_: Request, e: PermissionError):
        return JSONResponse({"error": str(e)}, status_code=401)

    @app.exception_handler(KeyError)
    async def _key_err(_: Request, e: KeyError):
        return JSONResponse({"error": f"Not found: {e}"}, status_code=404)

    # ---- meta ------------------------------------------------------------------
    @app.get("/api/info")
    async def info():
        return {"name": "Baton", "lan_urls": lan_urls(settings.port), "port": settings.port}

    @app.get("/api/models")
    async def models(request: Request):
        m = mgr(request)
        out = []

        async def one(p):
            prov = m.providers[p.id]
            names = await prov.list_models()
            configured = bool(getattr(prov, "configured", True))
            if p.discover_models:
                configured = bool(names)
            return {
                "id": p.id, "label": p.label, "kind": p.kind, "models": names, "configured": configured,
                "note": p.note, "base_url": p.base_url if p.id not in ("anthropic", "openai") else None,
            }

        out = await asyncio.gather(*(one(p) for p in settings.providers))
        return {"providers": out}

    @app.get("/api/insights")
    async def insights(request: Request):
        from .insights import compute

        return compute(mgr(request).db)

    @app.get("/api/repos")
    async def repos():
        return {"repos": list_sample_repos()}

    # ---- users -----------------------------------------------------------------
    @app.post("/api/users")
    async def upsert_user(body: UserIn, request: Request):
        return mgr(request).ensure_user(body.id, body.name, body.color)

    # ---- sessions --------------------------------------------------------------
    @app.get("/api/sessions")
    async def list_sessions(request: Request):
        m = mgr(request)
        rows = []
        for s in m.db.list_sessions():
            parts = m.participants_view(s["id"])
            plan = m.db.last_event_of(s["id"], "agent.plan")
            steps = plan["payload"]["steps"] if plan else []
            rows.append({
                **{k: s[k] for k in ("id", "title", "status", "driver_id", "head_seq", "provider", "model",
                                     "created_at", "updated_at", "parent_session_id", "fork_seq", "created_by")},
                "participants": parts,
                "progress": {"done": sum(1 for x in steps if x.get("status") == "done"), "total": len(steps)},
                "needs_decision": m.db.open_decision_count(s["id"]) > 0,
            })
        return {"sessions": rows}

    @app.post("/api/sessions")
    async def create_session(body: SessionIn, request: Request):
        m = mgr(request)
        if not m.db.get_user(body.user_id):
            raise HTTPException(400, "Unknown user; sign in first")
        if body.repo not in {r["id"] for r in list_sample_repos()}:
            raise HTTPException(400, f"Unknown repo {body.repo}")
        return m.create_session(user_id=body.user_id, task=body.task, provider=body.provider, model=body.model,
                                repo=body.repo, title=body.title)

    # ---- external agents ---------------------------------------------------------
    def bearer(authorization: str | None) -> str | None:
        if authorization and authorization.lower().startswith("bearer "):
            return authorization[7:].strip()
        return None

    @app.post("/api/external/sessions")
    async def create_external(body: ExternalSessionIn, request: Request):
        session, token = mgr(request).create_external(task=body.task, agent=body.agent, title=body.title)
        return {"session": session, "ingest_token": token, "url": f"/s/{session['id']}"}

    @app.post("/api/sessions/{sid}/ingest")
    async def ingest(sid: str, body: IngestIn, request: Request, authorization: str | None = Header(None)):
        m = mgr(request)
        m.check_ingest(sid, bearer(authorization))
        seqs = m.ingest(sid, body.events)
        return {"seqs": seqs, "head_seq": m.db.get_session(sid)["head_seq"]}

    @app.get("/api/sessions/{sid}/inbox")
    async def inbox(sid: str, request: Request, after: int = 0, wait: float = 20.0,
                    authorization: str | None = Header(None)):
        """Long-poll for what the humans said: steering, interrupts, decisions, hand-offs."""
        m = mgr(request)
        m.check_ingest(sid, bearer(authorization))
        deadline = asyncio.get_running_loop().time() + max(0.0, min(wait, 30.0))
        while True:
            items = m.inbox(sid, after)
            head = m.db.get_session(sid)["head_seq"]
            if items or asyncio.get_running_loop().time() >= deadline:
                return {"events": items, "head_seq": head}
            await asyncio.sleep(0.25)

    @app.get("/api/sessions/{sid}")
    async def get_session(sid: str, request: Request, user_id: str | None = None):
        m = mgr(request)
        return {"session": m.session_view(sid), "catchup": m.catchup(sid, user_id), "comments": m.db.comments(sid)}

    @app.get("/api/sessions/{sid}/catchup")
    async def catchup(sid: str, request: Request, user_id: str | None = None):
        return mgr(request).catchup(sid, user_id)

    @app.get("/api/sessions/{sid}/events")
    async def events(sid: str, request: Request, after: int = 0, upto: int | None = None):
        m = mgr(request)
        if not m.db.get_session(sid):
            raise KeyError(sid)
        return {"events": m.db.events(sid, after, upto)}

    @app.post("/api/sessions/{sid}/fork")
    async def fork(sid: str, body: ForkIn, request: Request, seq: int | None = None):
        at = body.seq if body.seq is not None else seq
        if at is None:
            raise HTTPException(400, "Pass the step to fork from as ?seq=N or in the body")
        return mgr(request).fork(sid, at, body.user_id)

    @app.get("/api/sessions/{sid}/comments")
    async def comments(sid: str, request: Request):
        return {"comments": mgr(request).db.comments(sid)}

    @app.post("/api/sessions/{sid}/comments")
    async def add_comment(sid: str, body: CommentIn, request: Request):
        return mgr(request).add_comment(sid, body.user_id, body.event_seq, body.body, body.parent_id)

    @app.get("/api/sessions/{sid}/files")
    async def files(sid: str, request: Request):
        m = mgr(request)
        s = m.db.get_session(sid)
        if not s:
            raise KeyError(sid)
        ws = m.workspace(sid)
        base = SAMPLE_REPOS / s["config"].get("repo", "notes-api")
        now = ws.snapshot() if ws.root.exists() else {}
        out = []
        for path in sorted(now):
            orig = base / path
            state = "added" if not orig.exists() else ("modified" if orig.read_text(errors="replace") != now[path] else "same")
            out.append({"path": path, "state": state, "size": len(now[path])})
        return {"files": out}

    @app.get("/api/sessions/{sid}/files/{path:path}")
    async def file_content(sid: str, path: str, request: Request):
        m = mgr(request)
        s = m.db.get_session(sid)
        if not s:
            raise KeyError(sid)
        ws = m.workspace(sid)
        try:
            text = ws.read_text(path)
        except Exception:
            text = None
        if text is None:
            raise HTTPException(404, "No such file")
        base = SAMPLE_REPOS / s["config"].get("repo", "notes-api") / path
        original = base.read_text(errors="replace") if base.is_file() else None
        from .sandbox import make_diff

        return {"path": path, "content": text, "diff": make_diff(path, original or "", text) if original != text else ""}

    @app.get("/api/sessions/{sid}/blobs/{call_id}")
    async def blob(sid: str, call_id: str, request: Request):
        p = mgr(request).settings.data_dir / "blobs" / sid / f"{call_id}.txt"
        if not p.resolve().is_relative_to((mgr(request).settings.data_dir / "blobs").resolve()) or not p.exists():
            raise HTTPException(404, "No full output stored")
        return PlainTextResponse(p.read_text())

    @app.get("/api/sessions/{sid}/export")
    async def export(sid: str, request: Request):
        m = mgr(request)
        data = {
            "session": m.db.get_session(sid), "participants": m.db.participants(sid),
            "events": m.db.events(sid), "comments": m.db.comments(sid), "exported_at": time.time(),
        }
        if not data["session"]:
            raise KeyError(sid)
        return JSONResponse(data, headers={"Content-Disposition": f'attachment; filename="baton-{sid}.json"'})

    # ---- live stream -----------------------------------------------------------
    @app.websocket("/api/sessions/{sid}/stream")
    async def stream(ws: WebSocket, sid: str):
        m: SessionManager = ws.app.state.mgr
        user_id = ws.query_params.get("user_id") or ""
        await ws.accept()
        s = m.db.get_session(sid)
        user = m.db.get_user(user_id) if user_id else None
        if not s or not user:
            await ws.send_json({"type": "error", "message": "Session or user not found", "fatal": True})
            await ws.close(code=4404)
            return
        m.join(sid, user_id, ws.query_params.get("role"))
        conn = Conn(user_id=user_id)
        writer: asyncio.Task | None = None

        async def write_loop() -> None:
            while True:
                msg = await conn.queue.get()
                if conn.overflowed:
                    await ws.close(code=4008)
                    return
                await ws.send_text(json.dumps(msg))

        try:
            subscribed = False
            while True:
                raw = await ws.receive_text()
                try:
                    msg = json.loads(raw)
                except json.JSONDecodeError:
                    continue
                kind = msg.get("type")
                if kind == "subscribe":
                    if subscribed:
                        continue
                    subscribed = True
                    from_seq = max(0, int(msg.get("from_seq") or 0))
                    # Snapshot the backlog, session and in-flight text and register for live
                    # events in one synchronous step (no await): nothing can be appended in
                    # between, so the client sees no gaps and no duplicates. Live messages
                    # queue up while the backlog is sent and are flushed after it.
                    backlog = m.db.events(sid, after=from_seq)
                    snap = m.db.get_session(sid)
                    part = dict(m.hub.partial[sid]) if sid in m.hub.partial else None
                    m.hub.add(sid, conn)
                    for i in range(0, len(backlog), 250):
                        await ws.send_text(json.dumps({"type": "events", "events": backlog[i:i + 250]}))
                    await ws.send_json({"type": "replay_done", "head_seq": snap["head_seq"]})
                    await ws.send_json({"type": "session", "session": snap})
                    if part:
                        await ws.send_json({"type": "partial", **part})
                    writer = asyncio.create_task(write_loop())
                    m.broadcast_presence(sid)
                elif kind == "ping":
                    await ws.send_json({"type": "pong"})
                elif not isinstance(kind, str):
                    continue
                elif kind == "typing":
                    conn.typing_until = time.time() + 3
                    m.broadcast_presence(sid)
                elif kind == "viewing":
                    v = msg.get("seq")
                    conn.viewing_seq = int(v) if isinstance(v, (int, float)) else None
                    m.broadcast_presence(sid)
                elif kind == "focus":
                    v = msg.get("seq")
                    new = int(v) if isinstance(v, (int, float)) else None
                    if new != conn.focus_seq:
                        conn.focus_seq = new
                        m.broadcast_presence(sid)
                elif kind == "seen":
                    if isinstance(msg.get("seq"), int):
                        m.mark_seen(sid, user_id, msg["seq"])
                elif kind == "comment":
                    try:
                        m.add_comment(sid, user_id, int(msg.get("event_seq") or 0), str(msg.get("body") or ""), msg.get("parent_id"))
                    except CommandError as e:
                        await ws.send_json({"type": "error", "message": str(e), "ref": msg.get("ref")})
                    except (ValueError, TypeError):
                        await ws.send_json({"type": "error", "message": "Bad comment"})
                elif kind == "resolve_comment":
                    try:
                        m.resolve_comment(sid, str(msg.get("id") or ""), bool(msg.get("resolved", True)))
                    except CommandError as e:
                        await ws.send_json({"type": "error", "message": str(e)})
                else:
                    try:
                        await m.command(sid, user_id, msg)
                    except CommandError as e:
                        await ws.send_json({"type": "error", "message": str(e), "ref": msg.get("ref")})
                    except (KeyError, ValueError, TypeError) as e:
                        await ws.send_json({"type": "error", "message": f"Bad request: {e}", "ref": msg.get("ref")})
        except WebSocketDisconnect:
            pass
        finally:
            m.hub.remove(sid, conn)
            if writer:
                writer.cancel()
            m.broadcast_presence(sid)

    # ---- web app ---------------------------------------------------------------
    @app.get("/{full_path:path}")
    async def spa(full_path: str):
        if full_path.startswith("api/"):
            raise HTTPException(404)
        target = (WEB_DIST / full_path).resolve()
        if full_path and target.is_file() and target.is_relative_to(WEB_DIST.resolve()):
            return FileResponse(target)
        index = WEB_DIST / "index.html"
        if index.exists():
            return FileResponse(index, headers={"Cache-Control": "no-cache"})
        return PlainTextResponse("Web app not built. Run: cd web && npm install && npm run build", status_code=503)

    return app
