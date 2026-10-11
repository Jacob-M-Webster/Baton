"""The code view: hand edits and terminal commands are driver-only events the agent reads next turn."""
import pytest

from baton import context as ctx
from baton.sandbox import content_hash
from baton.sessions import CommandError
from conftest import wait_for

TASK = "Add rate limiting to this API and write tests."
README = "README.md"


async def waiting_session(mgr):
    """A demo session parked on its decision point, so the agent isn't touching files during the test."""
    sid = mgr.create_session(user_id="u_alice", task=TASK, provider="demo", model="baton-demo")["id"]
    await wait_for(lambda: ctx.open_decisions(mgr.db.events(sid)))
    await wait_for(lambda: mgr.db.get_session(sid)["status"] == "waiting_input")
    return sid


def last(mgr, sid, type_):
    return mgr.db.last_event_of(sid, type_)


async def test_driver_saves_a_file_and_the_agent_sees_the_diff(mgr):
    sid = await waiting_session(mgr)
    ws = mgr.workspace(sid)
    before = ws.read_text(README)
    after = before + "\nRate limits are per API key.\n"

    await mgr.command(sid, "u_alice", {"type": "save_file", "path": README, "content": after, "base": content_hash(before)})

    ev = last(mgr, sid, "human.edit")
    assert ev["actor"] == "u_alice" and ev["payload"]["path"] == README and not ev["payload"]["created"]
    assert "+Rate limits are per API key." in ev["payload"]["diff"]
    assert ws.read_text(README) == after

    msgs = ctx.build_messages(TASK, "u_alice", mgr.db.events(sid), mgr.names(sid))
    texts = [b.get("text", "") for m in msgs for b in m["content"] if b["type"] == "text"]
    assert any(t.startswith(f"[Alice edited {README} by hand in the editor]") for t in texts)

    card = mgr.catchup(sid)
    assert any("edited `README.md` by hand" in c["what"] for c in card["changed"])


async def test_offline_agent_acknowledges_hand_work_without_quoting_it(mgr):
    sid = await waiting_session(mgr)
    ws = mgr.workspace(sid)
    before = ws.read_text(README)
    await mgr.command(sid, "u_alice", {"type": "save_file", "path": README, "content": before + "\nNote.\n", "base": content_hash(before)})
    dp = ctx.open_decisions(mgr.db.events(sid))[0]
    await mgr.command(sid, "u_alice", {"type": "answer_decision", "seq": dp["seq"], "answer": dp["options"][0]})
    await wait_for(lambda: mgr.db.get_session(sid)["status"] == "done", timeout=30)
    said = "\n".join(e["payload"]["text"] for e in mgr.db.events(sid) if e["type"] == "agent.text")
    assert "Noted, Alice edited `README.md` by hand" in said
    assert "```diff" not in said and "+Note." not in said


async def test_saving_is_driver_only_and_detects_conflicts(mgr):
    sid = await waiting_session(mgr)
    mgr.join(sid, "u_bob")
    ws = mgr.workspace(sid)
    original = ws.read_text(README)

    with pytest.raises(CommandError, match="driver"):
        await mgr.command(sid, "u_bob", {"type": "save_file", "path": README, "content": "x", "base": content_hash(original)})

    # Someone (here, the agent) changed the file after Alice opened it.
    ws.write_file(README, original + "agent line\n")
    with pytest.raises(CommandError, match="changed since you opened it"):
        await mgr.command(sid, "u_alice", {"type": "save_file", "path": README, "content": "mine\n", "base": content_hash(original)})
    assert ws.read_text(README).endswith("agent line\n")

    await mgr.command(sid, "u_alice", {"type": "save_file", "path": README, "content": "mine\n", "base": content_hash(original), "force": True})
    assert ws.read_text(README) == "mine\n"

    # Saving unchanged text records nothing.
    n = mgr.db.get_session(sid)["head_seq"]
    await mgr.command(sid, "u_alice", {"type": "save_file", "path": README, "content": "mine\n", "base": content_hash("mine\n")})
    assert mgr.db.get_session(sid)["head_seq"] == n

    with pytest.raises(CommandError, match="escapes"):
        await mgr.command(sid, "u_alice", {"type": "save_file", "path": "../outside.txt", "content": "x"})


async def test_new_files_and_forks_keep_hand_edits(mgr):
    sid = await waiting_session(mgr)
    await mgr.command(sid, "u_alice", {"type": "save_file", "path": "docs/limits.md", "content": "# Limits\n"})
    ev = last(mgr, sid, "human.edit")
    assert ev["payload"]["created"]

    fork = mgr.fork(sid, ev["seq"], "u_alice")
    assert mgr.workspace(fork["id"]).read_text("docs/limits.md") == "# Limits\n"


async def test_terminal_runs_in_the_workspace(mgr):
    sid = await waiting_session(mgr)
    await mgr.command(sid, "u_alice", {"type": "run_command", "command": "python -m unittest -q"})
    res = await wait_for(lambda: last(mgr, sid, "human.command_result"))
    cmd = last(mgr, sid, "human.command")
    assert res["payload"]["call_id"] == cmd["payload"]["call_id"] and res["actor"] == "u_alice"
    assert res["payload"]["exit_code"] == 0, res["payload"]["output"]
    assert "OK" in res["payload"]["output"]
    assert sid not in mgr.terminals

    msgs = ctx.build_messages(TASK, "u_alice", mgr.db.events(sid), mgr.names(sid))
    texts = [b.get("text", "") for m in msgs for b in m["content"] if b["type"] == "text"]
    assert any(t.startswith("[Alice ran `python -m unittest -q` in the terminal, exit code 0]") for t in texts)


async def test_terminal_is_driver_only_one_at_a_time_and_stoppable(mgr):
    sid = await waiting_session(mgr)
    mgr.join(sid, "u_bob")
    with pytest.raises(CommandError, match="driver"):
        await mgr.command(sid, "u_bob", {"type": "run_command", "command": "ls"})

    await mgr.command(sid, "u_alice", {"type": "run_command", "command": "python -c \"import time; time.sleep(30)\""})
    with pytest.raises(CommandError, match="already running"):
        await mgr.command(sid, "u_alice", {"type": "run_command", "command": "ls"})
    await mgr.command(sid, "u_alice", {"type": "stop_command"})
    res = await wait_for(lambda: last(mgr, sid, "human.command_result"), timeout=10)
    assert res["payload"]["cancelled"]

    # Obvious foot-guns are refused in the terminal too.
    await mgr.command(sid, "u_alice", {"type": "run_command", "command": "rm -rf /"})
    res = await wait_for(lambda: (r := last(mgr, sid, "human.command_result")) and not r["payload"].get("cancelled") and r)
    assert res["payload"]["is_error"] and res["payload"]["output"].startswith("Error:")


async def test_restart_closes_a_command_that_was_running(mgr):
    sid = await waiting_session(mgr)
    mgr.append(sid, "u_alice", "human.command", {"call_id": "cmd_x", "command": "sleep 100"})
    await mgr.resume_all()
    res = last(mgr, sid, "human.command_result")
    assert res["payload"]["call_id"] == "cmd_x" and res["payload"]["cancelled"]


async def test_external_sessions_have_no_workspace(mgr):
    s, _ = mgr.create_external(task="Audit", agent="bot")
    mgr.join(s["id"], "u_alice")
    mgr._change_driver(s["id"], None, "u_alice", reason="force")
    with pytest.raises(CommandError, match="runs elsewhere"):
        await mgr.command(s["id"], "u_alice", {"type": "save_file", "path": "x.py", "content": "x"})
