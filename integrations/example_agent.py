"""A small agent that runs on your machine and streams its work into Baton.

    python integrations/example_agent.py --url http://localhost:8000

It audits the sample notes-api for input validation, runs its tests for real, asks
the humans one question, and listens for steering the whole time. Open the printed
link, take the baton, and talk to it from the browser.
"""
from __future__ import annotations

import argparse
import subprocess
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from baton_client import BatonSession  # noqa: E402

REPO = Path(__file__).resolve().parents[1] / "sample-repos" / "notes-api"


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--url", default="http://localhost:8000")
    ap.add_argument("--agent", default="audit-bot")
    ap.add_argument("--pace", type=float, default=1.5, help="seconds between steps")
    args = ap.parse_args()

    s = BatonSession.create(args.url, task="Audit POST /notes for input validation gaps and report.", agent=args.agent)
    print(f"Session: {s.url}\nOpen it, take the baton, and steer from the browser.", flush=True)

    def step() -> None:
        time.sleep(args.pace)
        for msg in s.poll():
            if msg["type"] == "human.message":
                s.say(f"Got it, {msg['author']}: “{msg['payload']['text']}”. Folding that into the audit.")
            elif msg["type"] == "human.interrupt":
                s.say(f"{msg['author']} interrupted me. Pausing until someone steers.")
                while not any(m["type"] == "human.message" for m in s.poll(wait=20)):
                    pass

    titles = ["Read the request handler", "Run the existing tests", "List validation gaps", "Report"]

    def progress(done: int) -> None:
        s.plan([{"title": t, "status": "done" if i < done else "in_progress" if i == done else "pending"}
                for i, t in enumerate(titles)])

    progress(0)
    s.say("Starting with the handler for POST /notes.")
    call = s.tool("read_file", {"path": "app/server.py"})
    s.result(call, (REPO / "app/server.py").read_text())
    step()

    progress(1)
    s.say("Running the existing suite to see what's covered.")
    call = s.tool("run_command", {"command": "python -m unittest -v"})
    t0 = time.time()
    proc = subprocess.run([sys.executable, "-m", "unittest", "-v"], cwd=REPO, capture_output=True, text=True)
    s.result(call, proc.stdout + proc.stderr + f"\n[exit code {proc.returncode}]", is_error=proc.returncode != 0,
             duration_ms=int((time.time() - t0) * 1000), exit_code=proc.returncode)
    step()

    progress(2)
    s.say("Gaps: `text` isn't type-checked, there's no length limit, and invalid JSON raises a 500.")
    answer = s.ask("What should invalid input return?", ["400 with an error message", "422 with field-level errors"])
    step()

    progress(3)
    s.say(f"Going with: {answer}. Writing up the report.")
    progress(4)
    s.done(f"Found 3 validation gaps in POST /notes (type, length, malformed JSON). Recommended response: {answer}.")
    print("Done.", flush=True)


if __name__ == "__main__":
    main()
