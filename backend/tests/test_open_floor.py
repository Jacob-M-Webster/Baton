"""Open floor: the driver lets every collaborator (say, judges on their phones) steer the agent directly."""
import pytest

from baton import context as ctx
from baton.sessions import CommandError
from conftest import wait_for


async def parked(mgr):
    sid = mgr.create_session(user_id="u_alice", task="Add rate limiting", provider="demo", model="baton-demo")["id"]
    await wait_for(lambda: ctx.open_decisions(mgr.db.events(sid)))
    mgr.join(sid, "u_bob")
    return sid


async def test_collaborators_steer_only_when_the_floor_is_open(mgr):
    sid = await parked(mgr)
    with pytest.raises(CommandError, match="driver"):
        await mgr.command(sid, "u_bob", {"type": "steer", "text": "Add a test for bursts"})
    with pytest.raises(CommandError, match="driver"):
        await mgr.command(sid, "u_bob", {"type": "set_open_floor", "on": True})

    await mgr.command(sid, "u_alice", {"type": "set_open_floor", "on": True})
    assert mgr.db.get_session(sid)["config"]["open_floor"] is True
    await mgr.command(sid, "u_bob", {"type": "steer", "text": "Add a test for bursts"})
    ev = mgr.db.last_event_of(sid, "human.message")
    assert ev["actor"] == "u_bob" and ev["payload"] == {"text": "Add a test for bursts", "mode": "steer", "open_floor": True}

    msgs = ctx.build_messages("Add rate limiting", "u_alice", mgr.db.events(sid), mgr.names(sid))
    texts = [b.get("text", "") for m in msgs for b in m["content"] if b["type"] == "text"]
    assert any("Alice opened the floor" in t for t in texts)
    assert "[Bob, steering]: Add a test for bursts" in texts
    assert any(c["what"].startswith("opened the floor") for c in mgr.catchup(sid)["changed"])

    # Driver-only controls stay with the driver, and viewers still can't steer.
    with pytest.raises(CommandError, match="driver"):
        await mgr.command(sid, "u_bob", {"type": "interrupt"})
    mgr.ensure_user("u_vic", "Vic")
    mgr.join(sid, "u_vic", "viewer")
    with pytest.raises(CommandError, match="driver"):
        await mgr.command(sid, "u_vic", {"type": "steer", "text": "hi"})

    await mgr.command(sid, "u_alice", {"type": "set_open_floor", "on": False})
    with pytest.raises(CommandError, match="driver"):
        await mgr.command(sid, "u_bob", {"type": "steer", "text": "one more"})
