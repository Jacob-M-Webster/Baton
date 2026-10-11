"""The shared access code that guards hosted deployments."""
import pytest
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from baton.app import create_app
from baton.config import load_settings

CODE = "palmetto-42"


@pytest.fixture
def client(tmp_path):
    app = create_app(load_settings(data_dir=tmp_path, demo_speed=200.0, access_code=CODE))
    with TestClient(app) as c:
        yield c


def test_api_is_locked_until_the_code_is_entered(client):
    assert client.get("/api/sessions").status_code == 401
    assert client.get("/api/access").json() == {"required": True, "ok": False, "code": None}
    # The web app itself loads, so it can ask for the code.
    assert client.get("/").status_code in (200, 503)

    assert client.post("/api/access", json={"code": "nope"}).status_code == 403
    r = client.post("/api/access", json={"code": CODE})
    assert r.status_code == 200 and "baton_access" in r.cookies
    assert client.get("/api/sessions").status_code == 200
    assert client.get("/api/access").json() == {"required": True, "ok": True, "code": CODE}


def test_websockets_need_the_cookie_too(client):
    with pytest.raises(WebSocketDisconnect) as e:
        with client.websocket_connect("/api/sessions/x/stream?user_id=u") as ws:
            ws.receive_json()
    assert e.value.code == 4401

    client.post("/api/access", json={"code": CODE})
    with client.websocket_connect("/api/sessions/x/stream?user_id=u") as ws:
        assert ws.receive_json()["fatal"]  # past the gate: the app answers "session not found"


def test_guessing_is_rate_limited(client):
    for _ in range(10):
        assert client.post("/api/access", json={"code": "guess"}).status_code == 403
    assert client.post("/api/access", json={"code": CODE}).status_code == 429


def test_external_agents_use_a_header_or_their_ingest_token(client):
    assert client.post("/api/external/sessions", json={"task": "Audit"}).status_code == 401
    r = client.post("/api/external/sessions", json={"task": "Audit"}, headers={"X-Baton-Access": CODE})
    assert r.status_code == 200
    sid, token = r.json()["session"]["id"], r.json()["ingest_token"]
    # Ingest is authenticated by the session's own token, without the shared code.
    fresh = TestClient(client.app)
    ok = fresh.post(f"/api/sessions/{sid}/ingest", json={"events": [{"type": "agent.text", "payload": {"text": "hi"}}]},
                    headers={"Authorization": f"Bearer {token}"})
    assert ok.status_code == 200


def test_no_code_means_no_gate(tmp_path):
    with TestClient(create_app(load_settings(data_dir=tmp_path, access_code=None))) as c:
        assert c.get("/api/sessions").status_code == 200
        assert c.get("/api/access").json() == {"required": False, "ok": True, "code": None}
