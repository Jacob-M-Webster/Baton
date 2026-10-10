"""The scripted demo, end to end, through the same code paths the UI uses."""
from baton import context as ctx
from conftest import wait_for

TASK = "Add rate limiting to this API and write tests."


def types(mgr, sid):
    return [e["type"] for e in mgr.db.events(sid)]


def status(mgr, sid):
    return mgr.db.get_session(sid)["status"]


def find_call(mgr, sid, name, path=None):
    for e in mgr.db.events(sid):
        if e["type"] == "tool.call" and e["payload"]["name"] == name:
            if path is None or e["payload"]["input"].get("path") == path:
                return e
    return None


async def run_to_decision(mgr):
    s = mgr.create_session(user_id="u_alice", task=TASK, provider="demo", model="baton-demo")
    sid = s["id"]
    await wait_for(lambda: ctx.open_decisions(mgr.db.events(sid)))
    await wait_for(lambda: status(mgr, sid) == "waiting_input")
    return sid


async def test_full_demo_with_comment_promotion_and_handoff(mgr):
    sid = await run_to_decision(mgr)
    mgr.join(sid, "u_bob")

    # Bob comments on the tool call that read the legacy throttle.
    call = find_call(mgr, sid, "read_file", "app/middleware/legacy_throttle.py")
    assert call is not None
    c = mgr.add_comment(sid, "u_bob", call["seq"], "This middleware is deprecated (ADR 0007). Don't build on it.")

    # Only the driver may promote; Bob is not the driver yet.
    import pytest
    from baton.sessions import CommandError
    with pytest.raises(CommandError):
        await mgr.command(sid, "u_bob", {"type": "promote", "comment_id": c["id"]})

    await mgr.command(sid, "u_alice", {"type": "promote", "comment_id": c["id"]})
    promoted = [e for e in mgr.db.events(sid) if e["type"] == "human.message" and e["payload"].get("promoted_from")]
    assert promoted and promoted[0]["payload"]["suggested_by"] == "u_bob"
    # A steer while a decision is open is queued, not acted on.
    assert status(mgr, sid) == "waiting_input"

    await mgr.command(sid, "u_alice", {"type": "grant_driver", "to": "u_bob"})
    assert mgr.db.get_session(sid)["driver_id"] == "u_bob"

    dp = ctx.open_decisions(mgr.db.events(sid))[0]
    await mgr.command(sid, "u_bob", {"type": "answer_decision", "seq": dp["seq"], "answer": dp["options"][0]})
    await wait_for(lambda: status(mgr, sid) == "done", timeout=30)

    ws = mgr.workspace(sid)
    mw = ws.read_text("app/middleware/rate_limit.py")
    assert "class RateLimiter:" in mw and "LegacyThrottle" in mw  # mentioned in docstring only
    assert "import LegacyThrottle" not in mw
    assert "RateLimiter(app" in ws.read_text("app/server.py")

    runs = [e for e in mgr.db.events(sid) if e["type"] == "tool.result" and "exit_code" in e["payload"]]
    assert runs[-1]["payload"]["exit_code"] == 0, runs[-1]["payload"]["output"]
    assert "Ran 11 tests" in runs[-1]["payload"]["output"]

    card = mgr.catchup(sid, "u_bob")
    whos = {c["who"] for c in card["changed"]}
    assert {"Alice", "Bob"} <= whos
    assert card["doing"].startswith("Finished")


async def test_without_feedback_agent_builds_on_legacy(mgr):
    sid = await run_to_decision(mgr)
    dp = ctx.open_decisions(mgr.db.events(sid))[0]
    await mgr.command(sid, "u_alice", {"type": "answer_decision", "seq": dp["seq"], "answer": "Per client IP only"})
    await wait_for(lambda: status(mgr, sid) == "done", timeout=30)
    mw = mgr.workspace(sid).read_text("app/middleware/rate_limit.py")
    assert "import LegacyThrottle" in mw
    assert "key_func=ip_key" in mgr.workspace(sid).read_text("app/server.py")
    runs = [e for e in mgr.db.events(sid) if e["type"] == "tool.result" and "exit_code" in e["payload"]]
    assert runs[-1]["payload"]["exit_code"] == 0, runs[-1]["payload"]["output"]


async def test_suggestion_needs_promotion(mgr):
    sid = await run_to_decision(mgr)
    mgr.join(sid, "u_bob")
    from baton.sessions import CommandError
    import pytest
    with pytest.raises(CommandError):
        await mgr.command(sid, "u_bob", {"type": "steer", "text": "go faster"})
    await mgr.command(sid, "u_bob", {"type": "suggest", "text": "Use the new middleware base, legacy is deprecated"})
    sug = [e for e in mgr.db.events(sid) if e["type"] == "human.message"][-1]
    assert sug["payload"]["mode"] == "suggest"
    # Suggestions never reach the model.
    msgs = ctx.build_messages("t", "u_alice", mgr.db.events(sid), mgr.names(sid))
    assert "go faster" not in str(msgs) and "new middleware base" not in str(msgs)
    await mgr.command(sid, "u_alice", {"type": "promote", "seq": sug["seq"]})
    msgs = ctx.build_messages("t", "u_alice", mgr.db.events(sid), mgr.names(sid))
    assert "promoting a suggestion from Bob" in str(msgs)


async def test_interrupt_mid_stream_then_steer(settings):
    from baton.sessions import SessionManager
    settings.demo_speed = 1.0
    m = SessionManager(settings)
    m.ensure_user("u_alice", "Alice", "#000")
    try:
        sid = m.create_session(user_id="u_alice", task=TASK, provider="demo", model="baton-demo")["id"]
        await wait_for(lambda: m.hub.partial.get(sid, {}).get("text"), timeout=10)
        await m.command(sid, "u_alice", {"type": "interrupt"})
        await wait_for(lambda: status(m, sid) == "waiting_input")
        texts = [e for e in m.db.events(sid) if e["type"] == "agent.text"]
        assert texts and texts[-1]["payload"]["interrupted"] is True
        assert "human.interrupt" in types(m, sid)
        await m.command(sid, "u_alice", {"type": "steer", "text": "Carry on, but keep it small."})
        assert status(m, sid) == "running"
    finally:
        await m.shutdown()
        m.db.close()


async def test_resume_after_restart(settings):
    from baton.sessions import SessionManager
    m1 = SessionManager(settings)
    m1.ensure_user("u_alice", "Alice", "#000")
    sid = m1.create_session(user_id="u_alice", task=TASK, provider="demo", model="baton-demo")["id"]
    await wait_for(lambda: find_call(m1, sid, "read_file", "app/server.py"))
    await m1.shutdown()  # simulated crash: runner stops mid-session
    head = m1.db.get_session(sid)["head_seq"]
    m1.db.close()

    m2 = SessionManager(settings)
    try:
        n = await m2.resume_all()
        assert n == 1
        await wait_for(lambda: ctx.open_decisions(m2.db.events(sid)), timeout=20)
        evs = m2.db.events(sid)
        assert any(e["type"] == "session.resumed" for e in evs)
        # The log is gap-free and strictly increasing.
        assert [e["seq"] for e in evs] == list(range(1, len(evs) + 1))
        assert len(evs) > head
    finally:
        await m2.shutdown()
        m2.db.close()


async def test_fork_restores_files(mgr):
    sid = await run_to_decision(mgr)
    dp = ctx.open_decisions(mgr.db.events(sid))[0]
    await mgr.command(sid, "u_alice", {"type": "answer_decision", "seq": dp["seq"], "answer": "Per API key"})
    await wait_for(lambda: status(mgr, sid) == "done", timeout=30)
    write = find_call(mgr, sid, "write_file", "app/middleware/rate_limit.py")
    tests_call = find_call(mgr, sid, "write_file", "tests/test_rate_limit.py")
    fork_at = tests_call["seq"] - 1
    f = mgr.fork(sid, fork_at, "u_alice")
    assert f["parent_session_id"] == sid and f["fork_seq"] <= fork_at
    ws = mgr.workspace(f["id"])
    assert ws.read_text("app/middleware/rate_limit.py") is not None
    assert ws.read_text("tests/test_rate_limit.py") is None
    assert f["status"] == "waiting_input"
    assert write["seq"] < fork_at


async def test_take_the_baton_from_an_absent_driver(mgr):
    sid = await run_to_decision(mgr)
    mgr.join(sid, "u_bob")
    # Alice never connected a socket in this test, so she counts as away.
    await mgr.command(sid, "u_bob", {"type": "take_driver"})
    ev = [e for e in mgr.db.events(sid) if e["type"] == "control.driver_changed"][-1]
    assert ev["actor"] == "u_bob" and ev["payload"]["reason"] == "force"
    assert mgr.db.get_session(sid)["driver_id"] == "u_bob"
    card = mgr.catchup(sid)
    assert any(c["who"] == "Bob" and c["what"] == "took the baton" for c in card["changed"])


async def test_offline_model_declines_tasks_it_cannot_do(mgr):
    sid = mgr.create_session(user_id="u_alice", task="Add pagination to GET /notes with tests.", provider="demo", model="baton-demo")["id"]
    await wait_for(lambda: status(mgr, sid) == "waiting_input")
    evs = mgr.db.events(sid)
    assert not [e for e in evs if e["type"] == "tool.call"]
    assert "only run the rehearsed task" in [e for e in evs if e["type"] == "agent.text"][0]["payload"]["text"]
