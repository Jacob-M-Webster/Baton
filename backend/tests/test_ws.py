"""WebSocket protocol: replay-then-live, resubscribe from a seq, roles, presence."""
import time

from fastapi.testclient import TestClient

from baton.app import create_app
from baton.config import load_settings


def drain_until(ws, pred, limit=500):
    seen = []
    for _ in range(limit):
        msg = ws.receive_json()
        seen.append(msg)
        if pred(msg):
            return seen
    raise AssertionError("never saw expected message")


def test_two_clients_share_a_session(tmp_path):
    app = create_app(load_settings(data_dir=tmp_path, demo_speed=200.0))
    with TestClient(app) as client:
        client.post("/api/users", json={"id": "u_alice", "name": "Alice"})
        client.post("/api/users", json={"id": "u_bob", "name": "Bob"})
        r = client.post("/api/sessions", json={"user_id": "u_alice", "task": "Add rate limiting to this API and write tests."})
        assert r.status_code == 200, r.text
        sid = r.json()["id"]

        with client.websocket_connect(f"/api/sessions/{sid}/stream?user_id=u_alice") as a:
            a.send_json({"type": "subscribe", "from_seq": 0})
            msgs = drain_until(a, lambda m: m["type"] == "event" and m["event"]["type"] == "agent.decision_point")
            seqs = [m["event"]["seq"] for m in msgs if m["type"] == "event"]
            seqs += [e["seq"] for m in msgs if m["type"] == "events" for e in m["events"]]
            assert sorted(seqs) == list(range(1, max(seqs) + 1))

            with client.websocket_connect(f"/api/sessions/{sid}/stream?user_id=u_bob") as b:
                b.send_json({"type": "subscribe", "from_seq": 5})
                first = b.receive_json()
                assert first["type"] == "events" and first["events"][0]["seq"] == 6
                drain_until(b, lambda m: m["type"] == "replay_done")

                b.send_json({"type": "steer", "text": "do it differently"})
                err = drain_until(b, lambda m: m["type"] == "error")[-1]
                assert "driver" in err["message"].lower()

                pres = drain_until(a, lambda m: m["type"] == "presence" and len(m["participants"]) == 2)[-1]
                online = {p["name"]: p["online"] for p in pres["participants"]}
                assert online == {"Alice": True, "Bob": True}

                a.send_json({"type": "grant_driver", "to": "u_bob"})
                drain_until(b, lambda m: m["type"] == "event" and m["event"]["type"] == "control.driver_changed")
                b.send_json({"type": "answer_decision", "answer": "Per API key"})
                drain_until(b, lambda m: m["type"] == "session" and m["session"]["status"] == "done", limit=2000)

        detail = client.get(f"/api/sessions/{sid}", params={"user_id": "u_bob"}).json()
        assert detail["session"]["driver_id"] == "u_bob"
        assert detail["catchup"]["doing"].startswith("Finished")
        files = {f["path"]: f["state"] for f in client.get(f"/api/sessions/{sid}/files").json()["files"]}
        assert files["app/middleware/rate_limit.py"] == "added"
        assert files["app/server.py"] == "modified"
        listing = client.get("/api/sessions").json()["sessions"]
        assert listing[0]["progress"]["done"] == listing[0]["progress"]["total"] > 0
        assert client.get("/api/models").json()["providers"][-1]["id"] == "demo"
