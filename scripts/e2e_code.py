"""Rehearse the code view in two real browsers: edit, save, run tests, follow the agent.

    python scripts/e2e_code.py --url http://localhost:8000 --out ./shots

Alice drives: she opens the code view, edits README.md by hand, saves, and runs the test suite in the
terminal. Bob watches the same workspace read-only and sees where Alice is. Then Alice answers the
agent's question from the agent pane and the editor follows the agent into the file it writes.
Requires: pip install playwright && python -m playwright install chromium
"""
from __future__ import annotations

import argparse
import json
import sys
import time
import urllib.request
from pathlib import Path

from playwright.sync_api import Page, expect, sync_playwright

NOTE = "Rate limits apply per API key."


def sign_in(page: Page, name: str) -> None:
    page.get_by_placeholder("Your name").fill(name)
    page.get_by_role("button", name="Continue").click()


def events(url: str, sid: str) -> list[dict]:
    with urllib.request.urlopen(f"{url}/api/sessions/{sid}/events") as r:
        return json.load(r)["events"]


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--url", default="http://localhost:8000")
    ap.add_argument("--out", default="shots")
    ap.add_argument("--dark", action="store_true")
    ap.add_argument("--headed", action="store_true")
    args = ap.parse_args()
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    n = [0]

    def shot(page: Page, name: str) -> None:
        n[0] += 1
        page.screenshot(path=str(out / f"code-{n[0]:02d}-{name}.png"))

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=not args.headed)
        scheme = "dark" if args.dark else "light"
        alice = browser.new_context(viewport={"width": 1600, "height": 960}, color_scheme=scheme).new_page()
        bob = browser.new_context(viewport={"width": 1440, "height": 900}, color_scheme=scheme).new_page()
        errors: list[str] = []
        for pg in (alice, bob):
            pg.on("pageerror", lambda e: errors.append(str(e)))

        # Alice starts a session and waits for the agent's question, so files hold still for a moment.
        alice.goto(args.url)
        sign_in(alice, "Alice")
        alice.get_by_role("button", name="Start session").click()
        alice.wait_for_url("**/s/*")
        sid = alice.url.rstrip("/").split("/")[-1]
        alice.get_by_text("Decision needed").first.wait_for(timeout=60000)

        # The code view: tree, editor, terminal, agent pane.
        alice.get_by_role("tab", name="Code").click()
        alice.locator(".cm-editor").wait_for(timeout=20000)
        alice.get_by_role("button", name="Following agent").click()  # stop following while she works
        alice.get_by_title("README.md").first.click()
        alice.locator(".cm-content").wait_for()
        expect(alice.locator(".cm-content")).to_contain_text("Notes API")
        shot(alice, "alice-code-view")

        # Bob joins and opens the code view too: read-only, and he can see which file Alice has open.
        bob.goto(f"{args.url}/s/{sid}")
        sign_in(bob, "Bob")
        bob.get_by_role("button", name="Jump in").click(timeout=10000)  # past the catch-up card
        bob.get_by_role("tab", name="Code").click()
        bob.locator(".cm-editor").wait_for(timeout=20000)
        expect(bob.get_by_text("Read-only").first).to_be_visible()
        expect(bob.get_by_title("Alice has this open")).to_be_visible(timeout=10000)
        shot(bob, "bob-read-only-sees-alice")

        # Alice types at the end of README.md and saves with Ctrl+S.
        alice.locator(".cm-content").click()
        alice.keyboard.press("Control+End")
        alice.keyboard.press("Enter")
        alice.keyboard.type(NOTE)
        expect(alice.get_by_role("button", name="Save")).to_be_enabled()
        alice.keyboard.press("Control+s")
        expect(alice.get_by_role("button", name="Save")).to_be_disabled(timeout=10000)
        edit = next(e for e in events(args.url, sid) if e["type"] == "human.edit")
        assert edit["payload"]["path"] == "README.md" and NOTE in edit["payload"]["diff"], edit
        expect(bob.locator(".cm-content")).to_contain_text(NOTE, timeout=10000)  # Bob's copy updates live
        shot(alice, "alice-saved")

        # Alice runs the tests in the terminal; Bob sees the run and its output.
        term = alice.get_by_placeholder("Run a command in the workspace, e.g. python -m unittest")
        term.fill("python -m unittest -q")
        term.press("Enter")
        deadline = time.time() + 60
        while not any(e["type"] == "human.command_result" for e in events(args.url, sid)):
            assert time.time() < deadline, "the terminal command never finished"
            time.sleep(0.3)
        run = next(e for e in events(args.url, sid) if e["type"] == "human.command_result")
        assert run["payload"]["exit_code"] == 0 and run["actor"] != "agent", run
        expect(bob.get_by_text("python -m unittest -q").first).to_be_visible(timeout=10000)
        shot(alice, "alice-ran-tests")

        # Back to the agent: answer its question from the agent pane and follow it into the file it writes.
        alice.get_by_role("button", name="Follow agent").click()
        alice.get_by_role("button", name="Per API key (X-API-Key), falling back to client IP").click()
        # The editor opens the middleware as the agent writes it.
        expect(alice.get_by_role("button", name="rate_limit.py", exact=True)).to_be_visible(timeout=60000)
        alice.wait_for_timeout(600)
        shot(alice, "alice-following-agent")
        alice.get_by_text("Task complete").first.wait_for(timeout=120000)
        alice.wait_for_timeout(800)
        shot(alice, "alice-done-in-code-view")

        # The timeline credits the hand edit and the terminal run to Alice.
        alice.get_by_role("tab", name="Timeline").click()
        expect(alice.get_by_text("README.md").first).to_be_visible()
        alice.wait_for_timeout(600)
        shot(alice, "alice-timeline")
        browser.close()
        if errors:
            print("PAGE ERRORS:", *errors, sep="\n  ", file=sys.stderr)
            return 1
    print("OK: edit, save, terminal, presence and follow-the-agent work in the browser")
    return 0


if __name__ == "__main__":
    t0 = time.time()
    rc = main()
    print(f"finished in {time.time() - t0:.1f}s")
    sys.exit(rc)
