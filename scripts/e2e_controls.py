"""Browser check for driver controls: interrupt, steer, switch model mid-session, fork.

    python scripts/e2e_controls.py --out ./shots

Starts its own Baton server plus a tiny OpenAI-compatible test fixture on spare
ports, registered as the "Local" provider, so the model switch is exercised over
real HTTP and SSE without needing an API key or a GPU.
"""
from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import tempfile
import threading
import time
import urllib.request
from pathlib import Path

import uvicorn
from playwright.sync_api import expect, sync_playwright
from starlette.applications import Starlette
from starlette.requests import Request
from starlette.responses import JSONResponse, Response
from starlette.routing import Route

ROOT = Path(__file__).resolve().parents[1]
FIXTURE_MODEL = "fixture-llama"


def chunk(delta: dict, finish: str | None = None) -> str:
    body = {"id": "c", "object": "chat.completion.chunk", "created": 1, "model": FIXTURE_MODEL,
            "choices": [{"index": 0, "delta": delta, "finish_reason": finish}]}
    return f"data: {json.dumps(body)}\n\n"


async def completions(request: Request):
    body = await request.json()
    msgs = body["messages"]
    ran_tests = any(m.get("role") == "tool" and "Ran " in (m.get("content") or "") for m in msgs[-3:])
    if not ran_tests:
        text = "Picking up from the shared log on a local model. Running the suite to confirm where we are."
        call = {"index": 0, "id": "call_fx1", "type": "function",
                "function": {"name": "run_command", "arguments": json.dumps({"command": "python -m unittest -q"})}}
    else:
        text = "Suite is green. Wrapping up."
        call = {"index": 0, "id": "call_fx2", "type": "function",
                "function": {"name": "finish", "arguments": json.dumps({"summary": "Verified on the local model."})}}
    out = chunk({"role": "assistant", "content": text}) + chunk({"tool_calls": [call]}) + chunk({}, "tool_calls") + "data: [DONE]\n\n"
    return Response(out, media_type="text/event-stream")


async def models(_: Request):
    return JSONResponse({"object": "list", "data": [{"id": FIXTURE_MODEL, "object": "model", "created": 1, "owned_by": "test"}]})


def start_fixture(port: int) -> None:
    app = Starlette(routes=[Route("/v1/chat/completions", completions, methods=["POST"]), Route("/v1/models", models)])
    server = uvicorn.Server(uvicorn.Config(app, host="127.0.0.1", port=port, log_level="warning"))
    threading.Thread(target=server.run, daemon=True).start()


def start_server(port: int, fixture_port: int, data: str) -> subprocess.Popen:
    env = {**os.environ, "BATON_PORT": str(port), "BATON_DATA_DIR": data, "BATON_DEMO_SPEED": "0.6",
           "LOCAL_BASE_URL": f"http://127.0.0.1:{fixture_port}/v1", "PYTHONPATH": str(ROOT / "backend")}
    proc = subprocess.Popen([sys.executable, "-m", "baton"], cwd=ROOT, env=env, stdout=subprocess.DEVNULL, stderr=subprocess.STDOUT)
    for _ in range(300):  # first start on a cold disk can be slow
        try:
            urllib.request.urlopen(f"http://127.0.0.1:{port}/api/info", timeout=1)
            return proc
        except OSError:
            time.sleep(0.2)
    proc.kill()
    raise SystemExit("server did not start")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=8011)
    ap.add_argument("--fixture-port", type=int, default=8012)
    ap.add_argument("--out", default="shots")
    args = ap.parse_args()
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    start_fixture(args.fixture_port)
    server = start_server(args.port, args.fixture_port, tempfile.mkdtemp(prefix="baton-controls-"))
    url = f"http://127.0.0.1:{args.port}"
    try:
        with sync_playwright() as p:
            browser = p.chromium.launch()
            page = browser.new_context(viewport={"width": 1440, "height": 900}).new_page()
            page.on("pageerror", lambda e: print("PAGE ERROR:", e, file=sys.stderr))
            try:
                run(page, url, out)
            except Exception:
                page.screenshot(path=str(out / "controls-failure.png"))
                raise
            print("OK: interrupt, steer, model switch and fork all work in the browser")
            browser.close()
    finally:
        server.terminate()
        server.wait()
    return 0


def run(page, url: str, out: Path) -> None:
    if True:
        if True:
            page.goto(url + "/?as=Alice")
            page.get_by_title("Switch model").click()
            page.get_by_role("button", name="Offline demo").last.click()
            page.get_by_placeholder("What should the agent do?").fill("Build a small notes API with rate limiting, and write tests.")
            page.get_by_role("button", name="Start session").click()
            page.wait_for_url("**/s/*")

            # Interrupt with Esc while the agent is mid-step.
            page.get_by_role("button", name="Interrupt").wait_for(timeout=15000)
            page.get_by_text("Plan", exact=True).first.wait_for(timeout=20000)
            page.keyboard.press("Escape")
            page.get_by_text("interrupted the agent").wait_for(timeout=10000)
            expect(page.get_by_text("Waiting for input")).to_be_visible()
            page.screenshot(path=str(out / "controls-1-interrupted.png"))

            # Steer to resume.
            page.get_by_placeholder("Steer the agent. It reads this at its next step…").fill("Carry on. Keep the change small.")
            page.keyboard.press("Enter")
            page.get_by_text("Noted, Alice").wait_for(timeout=20000)
            page.get_by_text("Decision needed").wait_for(timeout=60000)

            # Switch to the local model mid-session, then answer the decision.
            page.locator("header").get_by_title("Switch model").click()
            page.get_by_role("button", name=FIXTURE_MODEL).click()
            page.get_by_text("switched the model from").wait_for(timeout=10000)
            page.get_by_role("button", name="Per API key (X-API-Key), falling back to client IP").click()
            page.get_by_text("Picking up from the shared log on a local model").wait_for(timeout=20000)
            page.get_by_text("Task complete").wait_for(timeout=20000)
            page.screenshot(path=str(out / "controls-2-switched-model.png"))
            models_used = page.get_by_text("Offline demo → fixture-llama")
            expect(models_used).to_be_visible()

            # Fork from an earlier step.
            page.locator("input.scrubber").focus()
            for _ in range(10):
                page.keyboard.press("ArrowLeft")
            page.get_by_role("button", name="Fork from here").click()
            page.get_by_text("forked this from").wait_for(timeout=10000)
            expect(page.locator("header").get_by_text("fork @")).to_be_visible()
            page.screenshot(path=str(out / "controls-3-forked.png"))


if __name__ == "__main__":
    sys.exit(main())
