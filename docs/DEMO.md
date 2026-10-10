# Demo runbook

Two presenters, two laptops. **Alice** runs the server and starts the session; **Bob** joins from
the second laptop. Total stage time: about 4 minutes (1 minute of slides, 3 minutes live).

## Ten minutes before

- [ ] Both laptops on the same network. Venue Wi-Fi often blocks device-to-device traffic, so a
      phone hotspot is the safer bet.
- [ ] On Alice's laptop, start with a clean sidebar: `BATON_DATA_DIR=data/stage ./run.sh`.
      Note the "Teammates on your network can join at http://…" line it prints.
- [ ] Pick the model. With internet and `ANTHROPIC_API_KEY` set, Claude is the default. The
      **Offline demo** model needs no network and always follows the rehearsed path; keep it as
      the fallback. Pacing: `BATON_DEMO_SPEED=0.8 ./run.sh` if you like to talk over it.
- [ ] Alice: open `http://localhost:8000/pitch` and sign in with her real name.
- [ ] Bob: open the LAN address and sign in. Leave it on the home page.
- [ ] One full dry run: `python scripts/e2e_demo.py --url http://localhost:8000` (about 25 s).

## Talk track

| Time | Who | Do | Say |
|---|---|---|---|
| 0:00 | Alice | Slides 1–3 with arrow keys | "Agents are single-player. The work lives in one person's terminal; nobody else can see it, steer it, or pick it up when they log off. Baton makes an agent's work a shared, live object." |
| 0:50 | Alice | Last slide, **Start the live demo**, then **Start session** with the prefilled task | "I'm asking an agent to add rate limiting to our API. It runs on the server, not on my laptop." |
| 1:05 | Alice | Point at the plan and the streaming steps | "Everything it does is an event in a shared log: every token, every tool call." |
| 1:15 | Bob | Opens the session from the sidebar, or scans the QR in **Share** | "I'm joining late. Instead of scrolling a transcript, I get a catch-up card: the goal, what's done, and that it's about to ask us something." |
| 1:35 | Bob | **Jump in**, drag the scrubber back, hover the `legacy_throttle.py` step, comment: *"This middleware is deprecated (ADR 0007). Don't build on it."* | "I know something the agent doesn't. I'm not driving, so my comment goes to Alice, not the agent. No two people shouting instructions at it." |
| 2:00 | Alice | Click **View and send to agent** on the toast, then **Send to agent** | "Bob's right. One click and it's an instruction, attributed to both of us." |
| 2:15 | Alice | **Hand off**, pick Bob, close the laptop lid | "I have to run. I hand Bob the baton." |
| 2:25 | Bob | Read the hand-off card, **Take it from here**, choose *Per API key* | "I get a summary of where things stand and the decision waiting for me. I make the call." |
| 2:35 | Both | Watch the plan change and the tests run | "Notice it changed its plan because of Bob's note: a new middleware instead of the deprecated one. Eleven tests pass." |
| 2:55 | Bob | Optional: open **Files** to show the diff, or switch the model in the header | "Same log, any model: Claude, OpenAI or local weights. Switch mid-session and the next model picks up from the log." |
| 3:10 | — | Back to the audience | "Baton is the collaboration layer for agents: seats for collaborators, bring your own model." |

Optional durability beat (adds 20 s): while the agent is working, press `Ctrl+C` in Alice's
terminal and run `./run.sh` again. Both browsers show *Reconnecting…*, then *Server restarted.
Session resumed from event #N, nothing lost.*

## If something goes wrong

- **Network between laptops fails:** Bob joins on Alice's laptop in a private window with
  `?as=Bob` appended to the URL. Everything else is identical.
- **Claude is slow or erroring:** the error appears in the timeline. Start a fresh session on
  **Offline demo** (model menu on the home page); it follows the rehearsed path without network.
- **Bob is late:** no rush. The agent stops at its decision point and waits for the driver.
- **Browser shows a stale build:** hard refresh. To rebuild the web app: `REBUILD=1 ./run.sh`.

## Likely questions

- **"Isn't this a shared chat log?"** It's an event log with roles. Late joiners replay it,
  the scrubber rewinds it, forks branch from it, and model context is rebuilt from it every turn,
  which is why resume after a crash and switching models mid-session both work.
- **"Why not just screen-share?"** Screen-sharing is synchronous and view-only. Baton is
  asynchronous: people join late, comment on specific steps, and take over without the original
  person present.
- **"Whose credentials does the agent use?"** In the demo, a server-held key and a sandboxed
  workspace; no user credentials touch the agent. In production: a per-session service identity,
  the driver's delegated credentials, or org-level bring-your-own-key.
- **"What about Claude Code, Codex, or our in-house agent?"** The adapter layer is the product
  boundary. Next step is ingest adapters so existing agents stream into the same event schema.
- **"How do you make money?"** Seats for collaborators, enterprise for SSO, audit export and
  self-hosted runners. We don't resell tokens.
- **"Is running agent code safe?"** Each session gets its own workspace. `BATON_SANDBOX=docker`
  runs every command in a throwaway container with no network.
