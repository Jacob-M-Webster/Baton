"""Rehearse the durability beat: kill the server mid-run, restart it, watch the session resume.

    python scripts/e2e_restart.py --out ./shots

Starts its own server on a spare port with a throwaway data directory.
"""
from __future__ import annotations

import argparse
import os
import signal
import subprocess
import sys
import tempfile
import time
import urllib.request
from pathlib import Path

from playwright.sync_api import expect, sync_playwright

ROOT = Path(__file__).resolve().parents[1]


def start_server(port: int, data: str) -> subprocess.Popen:
    env = {**os.environ, "BATON_PORT": str(port), "BATON_DATA_DIR": data, "BATON_DEMO_SPEED": "1.5",
           "PYTHONPATH": str(ROOT / "backend")}
    proc = subprocess.Popen([sys.executable, "-m", "baton"], cwd=ROOT, env=env,
                            stdout=subprocess.DEVNULL, stderr=subprocess.STDOUT)
    for _ in range(50):
        try:
            urllib.request.urlopen(f"http://127.0.0.1:{port}/api/info", timeout=1)
            return proc
        except OSError:
            time.sleep(0.2)
    proc.kill()
    raise SystemExit("server did not start")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=8010)
    ap.add_argument("--out", default="shots")
    args = ap.parse_args()
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    data = tempfile.mkdtemp(prefix="baton-restart-")
    url = f"http://127.0.0.1:{args.port}"
    server = start_server(args.port, data)
    try:
        with sync_playwright() as p:
            browser = p.chromium.launch()
            page = browser.new_context(viewport={"width": 1440, "height": 900}).new_page()
            page.goto(url + "/?as=Alice")
            page.get_by_role("button", name="Start session").click()
            page.wait_for_url("**/s/*")
            page.get_by_text("app/server.py").first.wait_for(timeout=20000)

            # Kill the server hard, mid-run.
            server.send_signal(signal.SIGKILL)
            server.wait()
            page.get_by_text("Reconnecting…").wait_for(timeout=10000)
            page.screenshot(path=str(out / "restart-1-down.png"))

            server = start_server(args.port, data)
            page.get_by_text("Session resumed from event").wait_for(timeout=20000)
            expect(page.get_by_text("Reconnecting…")).to_have_count(0)
            page.get_by_text("Decision needed").wait_for(timeout=40000)
            page.screenshot(path=str(out / "restart-2-resumed.png"))
            # No duplicated steps after the reconnect.
            assert page.get_by_text("app/middleware/legacy_throttle.py").count() == 1
            print("OK: session resumed after a hard restart")
            browser.close()
    finally:
        server.terminate()
        server.wait()
    return 0


if __name__ == "__main__":
    sys.exit(main())
