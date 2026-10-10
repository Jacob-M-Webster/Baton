import asyncio

import pytest

from baton.config import load_settings
from baton.sessions import SessionManager


@pytest.fixture
def settings(tmp_path):
    return load_settings(data_dir=tmp_path, demo_speed=200.0)


@pytest.fixture
async def mgr(settings):
    m = SessionManager(settings)
    m.ensure_user("u_alice", "Alice", "#2563eb")
    m.ensure_user("u_bob", "Bob", "#db2777")
    yield m
    await m.shutdown()
    m.db.close()


async def wait_for(pred, timeout=20.0, step=0.02):
    deadline = asyncio.get_running_loop().time() + timeout
    while asyncio.get_running_loop().time() < deadline:
        v = pred()
        if v:
            return v
        await asyncio.sleep(step)
    raise AssertionError("condition not met in time")
