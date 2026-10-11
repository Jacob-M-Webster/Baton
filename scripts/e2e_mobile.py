"""Rehearse judges joining from their phones and steering the agent.

    python scripts/e2e_mobile.py --url http://localhost:8000 --out ./shots [--code ACCESS_CODE]

Alice drives on a laptop. A judge scans the invite (a link that carries the access code, if the server
has one), picks a name on an iPhone-sized screen, and sends a request with a quick prompt; Alice sends
it to the agent with one tap and the judge hears about it. Then Alice opens the floor and the judge
steers the agent directly from the phone.
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


def sign_in(page: Page, name: str) -> None:
    page.get_by_placeholder("Your name").fill(name)
    page.get_by_role("button", name="Continue").click()


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--url", default="http://localhost:8000")
    ap.add_argument("--code", default="", help="the server's BATON_ACCESS_CODE, if it has one")
    ap.add_argument("--out", default="shots")
    args = ap.parse_args()
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    q = f"?code={args.code}" if args.code else ""
    n = [0]

    def shot(page: Page, name: str) -> None:
        n[0] += 1
        page.screenshot(path=str(out / f"mobile-{n[0]:02d}-{name}.png"))

    with sync_playwright() as p:
        browser = p.chromium.launch()
        alice = browser.new_context(viewport={"width": 1440, "height": 900}).new_page()
        phone = browser.new_context(**p.devices["iPhone 13"])
        judge = phone.new_page()
        errors: list[str] = []
        for pg in (alice, judge):
            pg.on("pageerror", lambda e: errors.append(str(e)))

        alice.goto(f"{args.url}/{q}")
        sign_in(alice, "Alice")
        alice.get_by_role("button", name="Start session").click()
        alice.wait_for_url("**/s/*")
        sid = alice.url.split("/s/")[1].split("?")[0]
        alice.get_by_text("legacy_throttle.py").first.wait_for(timeout=30000)

        # The judge scans the invite. The access code in the link is used once and dropped from the address bar.
        judge.goto(f"{args.url}/s/{sid}{q}")
        sign_in(judge, "Judge Rivera")
        judge.get_by_role("button", name="Jump in").click(timeout=15000)
        assert "code=" not in judge.url
        expect(judge.get_by_role("button", name="Add tests for the edge cases")).to_be_visible()
        shot(judge, "joined")

        # A request with a quick prompt: it goes to Alice, not the agent.
        judge.get_by_role("button", name="Add tests for the edge cases").click()
        judge.get_by_role("button", name="Request").click()
        alice.get_by_text("Judge Rivera requests: Add tests for the edge cases").wait_for(timeout=10000)
        shot(judge, "requested")
        alice.get_by_role("button", name="Send to agent").first.click()
        judge.get_by_text("Alice sent your request to the agent").wait_for(timeout=10000)
        shot(judge, "request-accepted")

        # Alice opens the floor from the Share menu; now the judge steers directly.
        alice.get_by_role("button", name="Share").click()
        alice.get_by_role("switch").click()
        alice.keyboard.press("Escape")
        judge.get_by_text("opened the floor").first.wait_for(timeout=10000)
        expect(judge.get_by_role("button", name="Steer")).to_be_visible()
        judge.get_by_placeholder("The floor is open: tell the agent what to do…").fill("Use a 60 second window")
        judge.get_by_role("button", name="Steer").click()
        alice.get_by_text("Judge Rivera steered the agent: Use a 60 second window").wait_for(timeout=10000)
        judge.wait_for_timeout(600)
        shot(judge, "steered-on-open-floor")

        with urllib.request.urlopen(urllib.request.Request(
                f"{args.url}/api/sessions/{sid}/events", headers={"X-Baton-Access": args.code} if args.code else {})) as r:
            log = json.load(r)["events"]
        steers = [e["payload"] for e in log if e["type"] == "human.message" and e["payload"].get("mode") == "steer"]
        assert any(s.get("suggested_by") and "edge cases" in s["text"] for s in steers), steers
        assert any(s.get("open_floor") and s["text"] == "Use a 60 second window" for s in steers), steers
        # Esc closed the Share menu above; it must not have interrupted the agent too.
        assert not any(e["type"] == "human.interrupt" for e in log), "closing a menu interrupted the agent"
        browser.close()
        if errors:
            print("PAGE ERRORS:", *errors, sep="\n  ", file=sys.stderr)
            return 1
    print("OK: judges join from a phone, request changes, and steer on an open floor")
    return 0


if __name__ == "__main__":
    t0 = time.time()
    rc = main()
    print(f"finished in {time.time() - t0:.1f}s")
    sys.exit(rc)
