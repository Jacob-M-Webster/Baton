"""Managing sessions and the server: GitHub repositories, deleting sessions, API keys from the Settings page."""
import json
import os
import shutil
import subprocess
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from baton.app import create_app
from baton.config import load_settings
from baton.github import GitHubError, GitHubRepo, clone, parse_github
from baton.keys import KeyStore
from baton.sandbox import Workspace, read_original
from baton.sessions import CommandError


needs_git = pytest.mark.skipif(not shutil.which("git"), reason="git is not installed")


# ---- GitHub ---------------------------------------------------------------------
@pytest.mark.parametrize("text,owner,name,ref", [
    ("octo/hello", "octo", "hello", None),
    ("https://github.com/octo/hello", "octo", "hello", None),
    ("https://github.com/octo/hello.git", "octo", "hello", None),
    ("github.com/octo/hello/", "octo", "hello", None),
    ("git@github.com:octo/hello.git", "octo", "hello", None),
    ("https://github.com/octo/hello/tree/feature/x", "octo", "hello", "feature/x"),
    ("https://github.com/octo/my.repo?tab=readme", "octo", "my.repo", None),
])
def test_parse_github_accepts_what_people_paste(text, owner, name, ref):
    r = parse_github(text)
    assert (r.owner, r.name, r.ref) == (owner, name, ref)


@pytest.mark.parametrize("text,ref", [
    ("notes-api", None), ("https://gitlab.com/a/b", None), ("octo/..", None), ("a/b/c/d", None),
    ("octo/hello", "--upload-pack=evil"), ("octo/hello", "a..b"),
])
def test_parse_github_rejects_anything_else(text, ref):
    with pytest.raises(GitHubError):
        parse_github(text, ref)


def make_origin(tmp_path: Path) -> Path:
    """A local git repository standing in for github.com/octo/hello."""
    src = tmp_path / "src"
    (src / "pkg").mkdir(parents=True)
    (src / "README.md").write_text("# Hello\n", encoding="utf-8")
    (src / "pkg" / "app.py").write_text("print('hi')\n", encoding="utf-8")
    secret = tmp_path / "secret.txt"
    secret.write_text("top secret", encoding="utf-8")
    if os.name != "nt":
        (src / "leak.txt").symlink_to(secret)
    env = {**os.environ, "GIT_AUTHOR_NAME": "t", "GIT_AUTHOR_EMAIL": "t@t", "GIT_COMMITTER_NAME": "t",
           "GIT_COMMITTER_EMAIL": "t@t"}
    for argv in (["init", "-q", "-b", "main"], ["add", "-A"], ["commit", "-q", "-m", "init"]):
        subprocess.run(["git", "-C", str(src), *argv], check=True, env=env)
    return src


@pytest.fixture
def fake_github(tmp_path, monkeypatch):
    src = make_origin(tmp_path)
    # clone() fetches `url + ".git"`: serve a bare copy at src.git, as GitHub would.
    subprocess.run(["git", "clone", "-q", "--bare", str(src), str(tmp_path / "src.git")], check=True)
    monkeypatch.setattr(GitHubRepo, "url", property(lambda self: src.as_uri()))
    return src


@needs_git
async def test_github_session_clones_once_and_forks_from_the_same_commit(mgr, fake_github):
    cache = mgr.settings.data_dir / "repos"
    gh = parse_github("Octo/Hello")
    cloned = await clone(gh, cache)
    again = await clone(gh, cache)
    assert cloned == again and len(cloned["sha"]) == 40
    assert cloned["path"] == f"repos/octo/hello/{cloned['sha']}"
    assert not [p for p in cache.iterdir() if p.name.startswith(".clone-")]

    s = mgr.create_session(user_id="u_alice", task="Tidy up", provider="demo", model="baton-demo",
                           repo=gh.full_name, github=cloned)
    assert s["config"]["repo"] == "Octo/Hello" and s["config"]["github"]["sha"] == cloned["sha"]
    started = mgr.db.events(s["id"], upto=1)[0]
    assert started["payload"]["github"] == {"url": gh.url, "ref": None, "sha": cloned["sha"]}
    ws = mgr.workspace(s["id"])
    assert ws.read_text("pkg/app.py") == "print('hi')\n"
    assert "leak.txt" not in ws.snapshot() and "leak.txt" not in ws.list_files()

    await mgr.runners[s["id"]].stop()
    ws.write_file("pkg/app.py", "print('bye')\n")
    mgr.append(s["id"], "u_alice", "human.edit", {"path": "pkg/app.py", "content": "print('bye')\n"})
    fork = mgr.fork(s["id"], mgr.db.get_session(s["id"])["head_seq"], "u_alice")
    assert mgr.repo_base(fork) == mgr.repo_base(s)
    assert mgr.workspace(fork["id"]).read_text("pkg/app.py") == "print('bye')\n"
    assert mgr.workspace(fork["id"]).read_text("README.md") == "# Hello\n"


@needs_git
async def test_clone_reports_missing_branches(mgr, fake_github):
    with pytest.raises(GitHubError, match="no branch or tag named nope"):
        await clone(parse_github("octo/hello", "nope"), mgr.settings.data_dir / "repos")


@pytest.mark.skipif(os.name == "nt", reason="symlinks need privileges on Windows")
def test_originals_are_never_read_through_links(tmp_path):
    base = tmp_path / "base"
    base.mkdir()
    (tmp_path / "secret.txt").write_text("top secret", encoding="utf-8")
    (base / "leak.txt").symlink_to(tmp_path / "secret.txt")
    (base / "ok.txt").write_text("fine", encoding="utf-8")
    assert read_original(base, "ok.txt") == "fine"
    assert read_original(base, "leak.txt") is None
    assert read_original(base, "../secret.txt") is None
    ws = Workspace.create_from(tmp_path / "ws", base)
    assert (tmp_path / "ws" / "leak.txt").is_symlink()
    assert ws.snapshot() == {"ok.txt": "fine"}


# ---- deleting sessions -----------------------------------------------------------
@pytest.fixture
def client(tmp_path):
    app = create_app(load_settings(data_dir=tmp_path, demo_speed=200.0, access_code=None, admin_code=None))
    with TestClient(app) as c:
        c.post("/api/users", json={"id": "u_alice", "name": "Alice"})
        c.post("/api/users", json={"id": "u_bob", "name": "Bob"})
        yield c


def test_only_the_creator_deletes_and_everything_goes(client, tmp_path):
    sid = client.post("/api/sessions", json={"user_id": "u_alice", "task": "Add rate limiting."}).json()["id"]
    m = client.app.state.mgr
    blob = tmp_path / "blobs" / sid / "x.txt"
    blob.parent.mkdir(parents=True)
    blob.write_text("out", encoding="utf-8")
    fork = client.post(f"/api/sessions/{sid}/fork", json={"user_id": "u_bob", "seq": 1}).json()["id"]
    assert m.workspace(sid).root.exists()

    with client.websocket_connect(f"/api/sessions/{sid}/stream?user_id=u_bob") as ws:
        ws.send_json({"type": "subscribe", "from_seq": 0})
        r = client.delete(f"/api/sessions/{sid}", params={"user_id": "u_bob"})
        assert r.status_code == 400 and "started" in r.json()["error"]

        assert client.delete(f"/api/sessions/{sid}", params={"user_id": "u_alice"}).json() == {"ok": True}
        for _ in range(500):
            if ws.receive_json()["type"] == "deleted":
                break
        else:
            raise AssertionError("never told the session was deleted")

    assert client.get(f"/api/sessions/{sid}").status_code == 404
    assert sid not in {s["id"] for s in client.get("/api/sessions").json()["sessions"]}
    assert m.db.events(sid) == [] and m.db.comments(sid) == [] and m.db.participants(sid) == []
    assert sid not in m.runners
    assert not m.workspace(sid).root.exists() and not blob.parent.exists()
    # The fork keeps its own log and workspace, and no longer links to a session that's gone.
    f = client.get(f"/api/sessions/{fork}").json()["session"]
    assert f["parent_session_id"] is None and f["head_seq"] > 0
    assert m.workspace(fork).root.exists()
    assert client.delete(f"/api/sessions/{sid}", params={"user_id": "u_alice"}).status_code == 404


async def test_deleting_stops_a_running_terminal(mgr):
    s = mgr.create_session(user_id="u_alice", task="x", provider="demo", model="baton-demo")
    await mgr.runners[s["id"]].stop()
    await mgr.command(s["id"], "u_alice", {"type": "run_command", "command": "python -c \"import time; time.sleep(30)\""})
    with pytest.raises(CommandError):
        await mgr.delete_session(s["id"], "u_bob")
    await mgr.delete_session(s["id"], "u_alice")
    assert s["id"] not in mgr.terminals and mgr.db.get_session(s["id"]) is None


async def test_anyone_in_it_may_delete_an_external_session(mgr):
    s, _ = mgr.create_external(task="Audit", agent="bot")
    await mgr.delete_session(s["id"], "u_bob")
    assert mgr.db.get_session(s["id"]) is None


# ---- API keys --------------------------------------------------------------------
def test_keys_can_be_changed_on_a_local_server(client, tmp_path):
    view = client.get("/api/settings").json()
    assert view["mode"] == "open"
    assert [k["name"] for k in view["keys"]] == ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GEMINI_API_KEY", "GITHUB_TOKEN"]

    key = "sk-test-0123456789abcd"
    r = client.put("/api/settings", json={"values": {"OPENAI_API_KEY": key, "GITHUB_TOKEN": "ghp_tok_123456789"}})
    assert r.status_code == 200, r.text
    keys = {k["name"]: k for k in r.json()["keys"]}
    assert keys["OPENAI_API_KEY"] == {**keys["OPENAI_API_KEY"], "set": True, "source": "saved", "hint": "…abcd"}
    assert key not in r.text and key not in client.get("/api/settings").text

    m = client.app.state.mgr
    assert m.settings.provider("openai").api_key == key and m.providers["openai"].configured
    assert m.settings.github_token == "ghp_tok_123456789"
    saved = json.loads((tmp_path / "keys.json").read_text(encoding="utf-8"))
    assert saved == {"OPENAI_API_KEY": key, "GITHUB_TOKEN": "ghp_tok_123456789"}
    if os.name != "nt":
        assert (tmp_path / "keys.json").stat().st_mode & 0o077 == 0

    # Saved keys come back after a restart, and clearing one falls back to the environment.
    again = KeyStore(load_settings(data_dir=tmp_path))
    assert again.current("OPENAI_API_KEY") == key
    client.put("/api/settings", json={"values": {"OPENAI_API_KEY": None}})
    assert m.settings.provider("openai").api_key == (m.keys.env["OPENAI_API_KEY"] or None)  # "" in .env means unset

    assert client.put("/api/settings", json={"values": {"PATH": "x"}}).status_code == 400
    assert client.put("/api/settings", json={"values": {"OPENAI_API_KEY": "two words"}}).status_code == 400


def test_hosted_servers_need_the_admin_code(tmp_path):
    settings = load_settings(data_dir=tmp_path, access_code="door", admin_code=None)
    with TestClient(create_app(settings)) as c:
        c.post("/api/access", json={"code": "door"})
        assert c.get("/api/settings").json()["mode"] == "locked"
        assert c.put("/api/settings", json={"values": {"OPENAI_API_KEY": "sk-1"}}).status_code == 403

    settings = load_settings(data_dir=tmp_path, access_code="door", admin_code="keys-please")
    with TestClient(create_app(settings)) as c:
        assert c.get("/api/settings").status_code == 401  # still behind the access code
        c.post("/api/access", json={"code": "door"})
        assert c.get("/api/settings").json()["mode"] == "code"
        body = {"values": {"OPENAI_API_KEY": "sk-1"}}
        assert c.put("/api/settings", json={**body, "admin_code": "door"}).status_code == 403
        assert c.put("/api/settings", json={**body, "admin_code": "keys-please"}).status_code == 200
