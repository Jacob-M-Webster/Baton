"""A small agent that runs on your machine and streams its work into Baton.

    python integrations/example_agent.py --url http://localhost:8000

It audits Baton's own client (integrations/baton_client.py) for error handling,
runs a real check on it, asks the humans one question, and listens for steering
the whole time. Open the printed
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

REPO = Path(__file__).resolve().parent  # integrations/: the code this agent audits


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--url", default="http://localhost:8000")
    ap.add_argument("--agent", default="audit-bot")
    ap.add_argument("--pace", type=float, default=1.5, help="seconds between steps")
    args = ap.parse_args()

    s = BatonSession.create(args.url, task="Audit the Baton client for error handling gaps and report.", agent=args.agent)
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

    titles = ["Read the client", "Check that it compiles", "List error-handling gaps", "Report"]

    def progress(done: int) -> None:
        s.plan([{"title": t, "status": "done" if i < done else "in_progress" if i == done else "pending"}
                for i, t in enumerate(titles)])

    progress(0)
    s.say("Starting with the client's request helper.")
    call = s.tool("read_file", {"path": "baton_client.py"})
    s.result(call, (REPO / "baton_client.py").read_text(encoding="utf-8"))
    step()

    progress(1)
    s.say("Byte-compiling it to rule out syntax errors before reading closer.")
    call = s.tool("run_command", {"command": "python -m py_compile baton_client.py"})
    t0 = time.time()
    proc = subprocess.run([sys.executable, "-m", "py_compile", "baton_client.py"], cwd=REPO, capture_output=True, text=True)
    s.result(call, proc.stdout + proc.stderr + f"\n[exit code {proc.returncode}]", is_error=proc.returncode != 0,
             duration_ms=int((time.time() - t0) * 1000), exit_code=proc.returncode)
    step()

    progress(2)
    s.say("Gaps: `_request` turns HTTP errors into `BatonError`, but a refused connection or a timeout escapes as a "
          "raw urllib exception; nothing is retried; and `ask()` blocks for up to an hour by default.")
    answer = s.ask("How should the client handle a dropped connection?",
                   ["Retry with backoff, then raise BatonError", "Raise BatonError right away"])
    step()

    progress(3)
    s.say(f"Going with: {answer}. Writing up the report.")
    progress(4)
    s.done(f"Found 3 error-handling gaps in baton_client.py (network errors, no retries, long default wait). "
           f"Recommended for dropped connections: {answer}.")
    print("Done.", flush=True)


if __name__ == "__main__":
    main()
