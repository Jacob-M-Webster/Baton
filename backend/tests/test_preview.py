"""The workspace preview: the session's web pages, served sandboxed and behind a per-session key."""
import pytest
from fastapi.testclient import TestClient

from baton.app import create_app
from baton.config import load_settings

CODE = "palmetto-42"


def make_client(tmp_path, code):
    app = create_app(load_settings(data_dir=tmp_path, demo_speed=200.0, access_code=code, stripe_secret_key=None))
    return TestClient(app)


def start(c):
    if c.app.state.mgr.settings.access_code:
        c.post("/api/access", json={"code": CODE})
    c.post("/api/users", json={"id": "u_alice", "name": "Alice"})
    sid = c.post("/api/sessions", json={"user_id": "u_alice", "task": "Make a page", "provider": "demo",
                                        "model": "baton-demo"}).json()["id"]
    ws = c.app.state.mgr.workspace(sid)
    ws.write_file("dist/index.html", '<link href="/assets/app.css"><script type="module" src="/assets/app.js"></script>'
                                     '<a href="//cdn.example.com/x.js">cdn</a>')
    ws.write_file("dist/assets/app.css", "body { background: url('/assets/bg.png') }")
    ws.write_file("dist/assets/app.js", "console.log('hi')")
    ws.write_file("index.html", "<h1>root</h1>")
    return sid, c.get(f"/api/sessions/{sid}/preview").json()["base"]


@pytest.fixture
def client(tmp_path):
    with make_client(tmp_path, None) as c:
        yield c


def test_serves_a_folder_as_a_sandboxed_site(client):
    sid, base = start(client)
    r = client.get(base + "dist/")
    assert r.status_code == 200 and r.headers["content-type"].startswith("text/html")
    assert r.headers["content-security-policy"].startswith("sandbox allow-scripts")
    assert "allow-same-origin" not in r.headers["content-security-policy"]
    # Root-relative URLs stay inside the preview; protocol-relative ones are left alone.
    assert f'href="{base}dist/assets/app.css"' in r.text and f'src="{base}dist/assets/app.js"' in r.text
    assert 'href="//cdn.example.com/x.js"' in r.text

    css = client.get(base + "dist/assets/app.css")
    assert css.headers["content-type"].startswith("text/css") and f"url('{base}dist/assets/bg.png')" in css.text
    js = client.get(base + "dist/assets/app.js")
    assert js.headers["content-type"].startswith("text/javascript") and js.headers["access-control-allow-origin"] == "*"

    assert "<h1>root</h1>" in client.get(base + "~/").text
    # No trailing slash: redirected, so the page's relative URLs resolve inside its folder.
    r = client.get(base + "dist", follow_redirects=False)
    assert r.status_code == 307 and r.headers["location"] == base + "dist/"


def test_client_side_routes_fall_back_to_index_and_missing_files_404(client):
    sid, base = start(client)
    assert "app.css" in client.get(base + "dist/notes/42").text
    assert client.get(base + "dist/assets/missing.js").status_code == 404


def test_cannot_leave_the_workspace_or_guess_the_key(client):
    sid, base = start(client)
    assert client.get(base + "~/../../baton.db").status_code == 404
    assert client.get(base + "..~..~/baton.db").status_code == 404
    assert client.get(f"/api/preview/{sid}/{'0' * 24}/~/").status_code == 404
    assert client.get(f"/api/preview/nope/{'0' * 24}/~/").status_code == 404


def test_the_key_gets_past_the_access_code_without_the_cookie(tmp_path):
    with make_client(tmp_path, CODE) as c:
        sid, base = start(c)
        assert "/api/preview/" in base
        c.cookies.clear()  # the sandboxed frame doesn't send Baton's cookie
        assert c.get(f"/api/sessions/{sid}/preview").status_code == 401
        assert c.get(base + "dist/").status_code == 200
        assert c.get(f"/api/preview/{sid}/{'0' * 24}/dist/").status_code == 401
