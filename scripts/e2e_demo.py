"""Play the two-person demo in two real browsers and screenshot each beat.

    python scripts/e2e_demo.py --url http://localhost:8000 --out ./shots

Alice and Bob get separate browser contexts (separate storage), exactly like two
laptops. Requires: pip install playwright && python -m playwright install chromium
"""
from __future__ import annotations

import argparse
import subprocess
import sys
import time
from pathlib import Path

from playwright.sync_api import Page, expect, sync_playwright


def sign_in(page: Page, name: str) -> None:
    page.get_by_placeholder("Your name").fill(name)
    page.get_by_role("button", name="Continue").click()


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--url", default="http://localhost:8000")
    ap.add_argument("--out", default="shots")
    ap.add_argument("--dark", action="store_true")
    ap.add_argument("--headed", action="store_true")
    ap.add_argument("--size", default="1440x900", help="viewport, e.g. 1280x800")
    ap.add_argument("--video", help="record both browsers into this folder and compose a side-by-side MP4")
    args = ap.parse_args()
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    shot_n = [0]

    def shot(page: Page, name: str) -> None:
        shot_n[0] += 1
        page.screenshot(path=str(out / f"{shot_n[0]:02d}-{name}.png"))
        if args.video:
            page.wait_for_timeout(1800)  # give viewers of the recording a moment on each beat

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=not args.headed)
        scheme = "dark" if args.dark else "light"
        w, h = (int(x) for x in args.size.split("x"))
        rec = {"record_video_dir": args.video, "record_video_size": {"width": w, "height": h}} if args.video else {}
        alice_ctx = browser.new_context(viewport={"width": w, "height": h}, color_scheme=scheme, **rec)
        bob_ctx = browser.new_context(viewport={"width": w, "height": h}, color_scheme=scheme, **rec)
        alice, bob = alice_ctx.new_page(), bob_ctx.new_page()
        for pg in (alice, bob):
            pg.on("pageerror", lambda e: print("PAGE ERROR:", e, file=sys.stderr))

        # 1. Alice starts a session.
        alice.goto(args.url)
        sign_in(alice, "Alice")
        expect(alice.get_by_role("button", name="Start session")).to_be_enabled()
        shot(alice, "home")
        alice.get_by_role("button", name="Start session").click()
        alice.wait_for_url("**/s/*")
        session_url = alice.url
        alice.get_by_text("Plan", exact=True).first.wait_for(timeout=20000)
        alice.wait_for_timeout(1500)
        shot(alice, "alice-agent-exploring")

        # 2. Bob opens the link: the catch-up card shows the goal, steps so far and the plan.
        alice.get_by_text("legacy_throttle.py").first.wait_for(timeout=30000)
        bob.goto(session_url)
        sign_in(bob, "Bob")
        bob.get_by_text("Catch up", exact=True).first.wait_for(timeout=10000)
        bob.wait_for_timeout(600)
        shot(bob, "bob-catch-up")
        bob.get_by_role("button", name="Jump in").click()

        # 3. Bob scrubs back and comments on the tool call that read the legacy middleware.
        bob.locator("input.scrubber").focus()
        for _ in range(6):
            bob.keyboard.press("ArrowLeft")
        bob.wait_for_timeout(400)
        shot(bob, "bob-scrubbing")
        bob.get_by_role("button", name="Back to live").click()
        row = bob.locator("[data-seq]").filter(has=bob.get_by_text("app/middleware/legacy_throttle.py")).first
        row.hover()
        row.get_by_role("button", name="Comment on this step").click()
        bob.get_by_placeholder("Comment on this step…").fill(
            "Heads up: this middleware is deprecated (ADR 0007). It holds a global lock. Please don't build on it."
        )
        bob.get_by_role("button", name="Comment", exact=True).click()
        bob.wait_for_timeout(500)
        shot(bob, "bob-commented")

        # 4. Alice gets a notification, jumps to Bob's comment, and sends it to the agent.
        alice.get_by_role("button", name="View and send to agent").click()
        alice.wait_for_timeout(900)
        shot(alice, "alice-sees-bob-comment")
        alice.get_by_role("button", name="Send to agent").first.click()
        alice.get_by_text("Decision needed").wait_for(timeout=40000)
        alice.wait_for_timeout(800)
        shot(alice, "alice-promoted")

        # 5. Alice hands off to Bob and leaves; Bob approves the decision and the agent finishes.
        alice.get_by_role("button", name="Hand off").click()
        alice.get_by_role("button", name="Bob").click()
        bob.get_by_role("button", name="Take it from here").wait_for(timeout=10000)
        bob.wait_for_timeout(500)
        shot(bob, "bob-handoff-catch-up")
        bob.get_by_role("button", name="Take it from here").click()
        bob.get_by_text("You're driving", exact=True).wait_for(timeout=10000)
        bob.wait_for_timeout(400)
        shot(bob, "bob-has-baton")
        alice_ctx.close()
        bob.get_by_role("button", name="Per API key (X-API-Key), falling back to client IP").click()
        bob.get_by_text("Task complete").wait_for(timeout=90000)
        bob.wait_for_timeout(1200)
        shot(bob, "bob-done")
        bob.get_by_role("button", name="Files").click()
        bob.wait_for_timeout(500)
        shot(bob, "bob-files")
        print("OK", session_url)
        videos = (alice.video, bob.video) if args.video else None
        bob_ctx.close()
        browser.close()
        if videos:
            compose(Path(videos[0].path()), Path(videos[1].path()), Path(args.video) / "baton-demo.mp4")
    return 0


def compose(alice: Path, bob: Path, out: Path) -> None:
    """Alice's and Bob's screens side by side. Alice leaves early, so her last frame holds."""
    try:
        import imageio_ffmpeg
    except ImportError:
        print("pip install imageio-ffmpeg to compose the side-by-side video; raw recordings are in", out.parent)
        return
    graph = ("[0:v]tpad=stop_mode=clone:stop_duration=300,scale=1280:-2[a];"
             "[1:v]scale=1280:-2[b];[a][b]hstack=inputs=2:shortest=1[v]")
    subprocess.run([imageio_ffmpeg.get_ffmpeg_exe(), "-y", "-loglevel", "error", "-i", str(alice), "-i", str(bob),
                    "-filter_complex", graph, "-map", "[v]", "-c:v", "libx264", "-crf", "30", "-preset", "veryfast",
                    "-pix_fmt", "yuv420p", "-movflags", "+faststart", str(out)], check=True)
    print("Side-by-side recording:", out)


if __name__ == "__main__":
    t0 = time.time()
    rc = main()
    print(f"finished in {time.time() - t0:.1f}s")
    sys.exit(rc)
