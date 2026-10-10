"""External agents: stream steps in over HTTP, get steering and decisions back."""
import asyncio
import json
import socket
import sys
import threading
import time
from pathlib import Path

import pytest
import uvicorn
import websockets

from baton.app import create_app
from baton.config import load_settings

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "integrations"))
from baton_client import BatonError, BatonSession  # noqa: E402


@pytest.fixture
def server(tmp_path):
    sock = socket.socket()
    sock.bind(("127.0.0.1", 0))
    port = sock.getsockname()[1]
    sock.close()
    srv = uvicorn.Server(uvicorn.Config(create_app(load_settings(data_dir=tmp_path)), host="127.0.0.1", port=port, log_level="warning"))
    t = threading.Thread(target=srv.run, daemon=True)
    t.start()
    while not srv.started:
        time.sleep(0.05)
    yield f"http://127.0.0.1:{port}"
    srv.should_exit = srv.force_exit = True
    t.join(timeout=5)


async def recv_until(ws, pred, limit=200):
    for _ in range(limit):
        msg = json.loads(await asyncio.wait_for(ws.recv(), 5))
        if pred(msg):
            return msg
    raise AssertionError("message not seen")


async def test_external_agent_round_trip(server):
    s = await asyncio.to_thread(BatonSession.create, server, "Audit POST /notes", "audit-bot")
    await asyncio.to_thread(s.plan, ["Read handler", "Report"])
    await asyncio.to_thread(s.say, "Reading the handler.")
    call = await asyncio.to_thread(s.tool, "read_file", {"path": "app/server.py"})
    await asyncio.to_thread(s.result, call, "def notes_app(): ...")

    # A human joins in the browser, takes the baton (nobody drives an external session at first) and steers.
    await asyncio.to_thread(_post, server + "/api/users", {"id": "u_alice", "name": "Alice"})
    ws_url = server.replace("http", "ws") + f"/api/sessions/{s.id}/stream?user_id=u_alice"
    async with websockets.connect(ws_url) as ws:
        await ws.send(json.dumps({"type": "subscribe", "from_seq": 0}))
        await recv_until(ws, lambda m: m["type"] == "replay_done")
        await ws.send(json.dumps({"type": "take_driver"}))
        await recv_until(ws, lambda m: m["type"] == "session" and m["session"]["driver_id"] == "u_alice")
        await ws.send(json.dumps({"type": "steer", "text": "Check the length limit too."}))
        inbox = await asyncio.to_thread(s.poll, 5)
        steer = [e for e in inbox if e["type"] == "human.message"]
        assert steer and steer[0]["text"] == "[Alice, steering]: Check the length limit too."

        # Decisions block the agent until the driver answers in the browser. Steering that
        # arrives meanwhile is kept for the agent's next poll rather than lost.
        asking = asyncio.create_task(asyncio.to_thread(s.ask, "400 or 422?", ["400", "422"]))
        dp = await recv_until(ws, lambda m: m["type"] == "event" and m["event"]["type"] == "agent.decision_point")
        await ws.send(json.dumps({"type": "steer", "text": "And a 10 MB body."}))
        await recv_until(ws, lambda m: m["type"] == "event" and m["event"]["type"] == "human.message")
        await asyncio.sleep(0.6)  # let the agent's long-poll pick the steer up before the answer lands
        await ws.send(json.dumps({"type": "answer_decision", "seq": dp["event"]["seq"], "answer": "422"}))
        assert await asyncio.wait_for(asking, 10) == "422"
        later = await asyncio.to_thread(s.poll)
        assert [e["text"] for e in later if e["type"] == "human.message"] == ["[Alice, steering]: And a 10 MB body."]

    await asyncio.to_thread(s.done, "Three gaps found.")
    detail = await asyncio.to_thread(_get, server + f"/api/sessions/{s.id}")
    assert detail["session"]["status"] == "done"
    assert detail["session"]["provider"] == "external"
    assert "ingest_token" not in json.dumps(detail)
    types = [e["type"] for e in (await asyncio.to_thread(_get, server + f"/api/sessions/{s.id}/events"))["events"]]
    assert types.count("tool.call") == 4  # plan, read_file, ask_humans, finish
    assert "human.decision" in types and "control.driver_changed" in types


async def test_ingest_requires_the_session_token(server):
    s = await asyncio.to_thread(BatonSession.create, server, "Anything", "bot")
    s.token = "wrong"
    with pytest.raises(BatonError, match="401"):
        await asyncio.to_thread(s.say, "hello")
    s2 = BatonSession(server, s.id, "")
    with pytest.raises(BatonError, match="401"):
        await asyncio.to_thread(s2.poll)


def _post(url, body):
    import urllib.request
    req = urllib.request.Request(url, data=json.dumps(body).encode(), headers={"Content-Type": "application/json"})
    return json.load(urllib.request.urlopen(req))


def _get(url):
    import urllib.request
    return json.load(urllib.request.urlopen(url))
