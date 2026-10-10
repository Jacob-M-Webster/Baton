# Shared Agent Sessions: Technical Plan

*Working title. Hackathon scope: 24–36 hours, 2–4 people.*

## 1. Goal

Let anyone on a team join a running agent session, watch it work, redirect it, and hand it off to someone else. The agent's work becomes a shared, live object instead of one person's private thread.

**Hackathon thesis:** Build the collaboration layer, not the agent. Use an off-the-shelf agent loop with a narrow, reliable task, and put the effort into the shared-session experience.

## 2. Core idea

The agent loop runs on a **server**, not in anyone's terminal or browser tab. Everything that happens is written to an **append-only event log** for the session. Clients subscribe to that log.

```
 ┌──────────┐  ┌──────────┐  ┌──────────┐
 │ Client A │  │ Client B │  │ Client C │   (browser, React)
 └────┬─────┘  └────┬─────┘  └────┬─────┘
      │ WebSocket: replay + live events, send commands
 ┌────▼─────────────▼─────────────▼─────┐
 │            Session Server            │
 │  ┌────────────┐   ┌───────────────┐  │
 │  │ Command    │──▶│ Agent Runner  │  │
 │  │ Queue      │   │ (tool loop)   │  │
 │  └────────────┘   └──────┬────────┘  │
 │         ┌────────────────▼────────┐  │
 │         │ Event Log (append-only) │  │
 │         └─────────────────────────┘  │
 └──────────────────┬───────────────────┘
          ┌─────────▼──────────┐
          │ SQLite / Redis     │   ┌──────────────┐
          │ (events, sessions) │   │ Sandbox (code │
          └────────────────────┘   │ exec, files) │
                                   └──────────────┘
```

Each product feature maps onto the log:

| Feature | Mechanism |
|---|---|
| Watch live | Stream new events over WebSocket |
| Drop in late | Replay the log from event 0 (or from the latest snapshot), then go live |
| Redirect | Queue a human message; the runner injects it at the next turn boundary |
| Interrupt | Cancel the in-flight tool call or model request; the runner waits for input |
| Hand off | Transfer the driver token and generate a catch-up summary for the new driver |
| Fork | Create a new session whose log is a copy of the original's up to event N |

## 3. Data model

```ts
Session {
  id, title, created_by, created_at,
  status: "running" | "paused" | "waiting_input" | "done" | "error",
  driver_id,            // user who can steer directly
  head_seq,             // last event sequence number
  summary_seq,          // log position covered by the rolling summary
  parent_session_id?, fork_seq?   // set if this session is a fork
}

Event {
  session_id, seq,      // monotonic per session; (session_id, seq) is the primary key
  ts, actor,            // "agent" | "system" | user_id
  type, payload (JSON)
}

Participant { session_id, user_id, role: "driver" | "collaborator" | "viewer", joined_at, last_seen_seq }

Comment { id, session_id, event_seq, user_id, body, resolved }
```

### Event types

| Type | Payload |
|---|---|
| `session.started` | task prompt, config |
| `agent.thinking` / `agent.text` | streamed text chunks (merged into one event when the turn finishes) |
| `tool.call` | tool name, input, call_id |
| `tool.result` | call_id, output (truncated, with the full copy in blob storage), duration |
| `human.message` | text, author, `mode: "steer" \| "suggest"` |
| `human.interrupt` | author |
| `control.driver_changed` | from, to |
| `agent.checkpoint` | rolling summary text, `seq` covered |
| `agent.decision_point` | question for humans; the agent pauses for input |
| `session.status` | new status |

## 4. Agent runner

Use the **Claude Agent SDK**, or a plain Messages API tool-use loop, wrapped in a runner that does three things on each iteration:

1. **Before each model call:** drain the command queue.
   - A `steer` message from the driver is appended as a user turn, attributed: `[Alice, steering]: focus on the auth module instead`.
   - A `suggest` message from another collaborator is shown to the driver, who can promote it. The agent never acts on it directly.
2. **Stream output:** write deltas to the log as they arrive, so viewers see tokens live.
3. **After each tool result:** check for an interrupt flag. If it is set, stop and set the status to `waiting_input`.

Interrupting mid-tool means:
- Run tools as cancellable tasks (`asyncio.Task` / `AbortController`).
- Record `tool.result` with `cancelled: true` so the model sees what happened.

The runner is the **only writer** of agent events. Humans write only through the command queue, which keeps ordering deterministic.

## 5. Concurrency and control

The **driver/viewer model** avoids conflicting instructions:

| Role | Permissions |
|---|---|
| Driver (one at a time) | Steer, interrupt, approve decision points, hand off |
| Collaborator | Suggest, comment on events, request the driver role |
| Viewer | Watch, comment |

Handoff is a single atomic `control.driver_changed` event:
- **Request flow:** a collaborator requests the driver role and the driver accepts.
- **Force-take:** an owner can take over a session whose driver has been idle for more than N minutes.

Every human event carries the author, so the timeline shows who changed the agent's course and when.

## 6. Catch-up and context management

### Catch-up card (the demo's key moment)

When someone joins, show a card generated from the latest `agent.checkpoint` plus events since then:
- **What it's doing:** the current goal
- **What's done:** completed steps
- **What changed:** human interventions, with author
- **What's next:** the agent's plan
- **Open questions:** pending decision points

Generate it with a cheap model call over the summary plus recent events. Cache it per `head_seq`.

### Context compaction

Long sessions overflow the context window. Every K turns, or when the context passes about 70% of the window:
1. Summarize events older than the last N turns into a checkpoint.
2. Rebuild the model context as: system prompt + task + checkpoint summary + last N turns.
3. Write an `agent.checkpoint` event. The same summary feeds the catch-up card.

Use prompt caching on the stable prefix (system prompt, task, summary) to keep costs down.

## 7. Durability (hackathon version)

Multi-day runs are out of scope. Fake the essentials:
- The event log is in SQLite with WAL, which survives process restarts.
- **Resume:** on startup, find sessions with `status = running`, rebuild context from the latest checkpoint plus the event tail, and continue.
- **Demo:** kill the server on stage, restart it, and the session picks up where it left off.

**Production path:** move the runner to a durable workflow engine (Temporal, Inngest) or a job queue with heartbeats. Use Postgres for events and S3 for large tool outputs.

## 8. Sandbox and credentials

- The agent runs tools in an isolated sandbox per session: a Docker container or a hosted sandbox such as E2B or Modal, holding the repo clone and a shell.
- The hackathon uses one service account with a scoped GitHub token and an API key held on the server. No user credentials touch the agent.
- **Production question to raise in the pitch:** whose credentials does a shared agent use? Options are a per-session service identity, the driver's delegated credentials, or bring-your-own-key at the org level.

## 9. API surface

### REST

```
POST   /sessions                    create + start (task, repo, config)
GET    /sessions                    list (status, participants, last activity)
GET    /sessions/:id                metadata + latest catch-up card
POST   /sessions/:id/fork?seq=N     fork at event N
POST   /sessions/:id/comments       comment on an event
```

### WebSocket `/sessions/:id/stream`

```
→ client: { type: "subscribe", from_seq }      // 0 = full replay
← server: { type: "event", event }             // replay, then live
→ client: { type: "steer" | "suggest", text }
→ client: { type: "interrupt" }
→ client: { type: "request_driver" } | { type: "grant_driver", to }
← server: { type: "presence", participants }
```

Clients track the last `seq` they received and resubscribe from it on reconnect, so there are no gaps or duplicates.

## 10. Frontend

A single-page React app (Vite, Tailwind).

| Area | Contents |
|---|---|
| Left rail | Session list with live status dots and participant avatars |
| Main timeline | Event stream: agent text, collapsible tool calls with input and output, human interventions highlighted with an avatar |
| Top bar | Status, driver badge, participant presence, interrupt button, hand-off button |
| Composer | "Steer" for the driver, "Suggest" for everyone else |
| Catch-up card | Shown on join; dismissible and re-openable |
| Timeline scrubber | Drag to any `seq` to view the session as of then; "fork from here" |
| Comments | Threaded comments pinned to individual events |

## 11. Tech stack

| Layer | Choice | Why |
|---|---|---|
| Agent | Claude Agent SDK (Python or TS) | Tool loop, streaming, and compaction hooks out of the box |
| Server | FastAPI + `websockets`, or Node + Fastify + `ws` | Match the team's strongest language |
| Storage | SQLite (WAL) | Zero ops; enough for a demo |
| Fan-out | In-process pub/sub (Redis pub/sub if running more than one server) | Simple |
| Sandbox | Docker container per session | Local, fast, isolated enough |
| Frontend | React + Vite + Tailwind | Fast to build |
| Auth | Magic-link or name-only login | Good enough for a demo |

## 12. Build plan (about 30 hours)

| Block | Hours | Deliverable |
|---|---|---|
| 1 | 0–4 | Repo skeleton, event schema, SQLite log, WebSocket replay and live stream with fake events |
| 2 | 4–10 | Agent runner wired to the log: real streaming, tool calls, sandbox |
| 3 | 10–15 | Command queue: steer, interrupt, turn-boundary injection |
| 4 | 15–19 | Roles: driver/viewer, handoff, presence |
| 5 | 19–23 | Checkpoints, compaction, catch-up card |
| 6 | 23–26 | Resume after restart; timeline polish |
| 7 | 26–30 | Demo hardening, scripted demo task, pitch deck |
| Stretch | — | Fork from here, comments on events, decision-point notifications (Slack webhook) |

### Team split (4 people)

- **Runner and agent:** loop, tools, sandbox, compaction
- **Server:** event log, WebSocket, command queue, roles, resume
- **Frontend:** timeline, composer, presence, catch-up card
- **Demo:** pitch, scripted task, catch-up summary prompt, test runs; helps wherever needed

## 13. Demo script (3 minutes)

1. Alice starts a session: "Add rate limiting to this API and write tests." The agent begins exploring the repo.
2. Bob opens the link on a second laptop. The catch-up card shows the goal, the steps so far, and the plan.
3. Bob scrubs the timeline and comments on a tool call: "This middleware is deprecated."
4. Alice, the driver, promotes Bob's suggestion. The agent adjusts its plan, and the timeline shows the intervention attributed to both.
5. Alice hands off to Bob and leaves. Bob approves a decision point and the agent finishes.
6. *(Optional)* Kill the server mid-run, restart it, and the session resumes.

## 14. Risks and mitigations

| Risk | Mitigation |
|---|---|
| The agent derails during the demo | Narrow, rehearsed task on a small prepared repo; a recorded fallback video |
| The context window fills during a long run | Compaction every K turns; a demo task short enough to stay under the limit |
| WebSocket reconnect bugs | Sequence-number resume; test with network throttling |
| Sandbox setup eats time | Pre-built Docker image; no network access for the sandbox |
| Scope creep into building a "better agent" | Agent quality is explicitly out of scope; all extra time goes to the collaboration UX |

## 15. Beyond the hackathon

- **Agent-agnostic adapters:** ingest events from Claude Code, Codex, Devin, or in-house agents through a common event schema, so this becomes a collaboration layer over any agent rather than a competing agent.
- Durable execution for runs that last days or weeks.
- Org-level permissions, SSO, audit log export, retention policies.
- Notifications on decision points and failures (Slack, email).
- Session analytics: where humans intervened, time to intervention, cost per session.
