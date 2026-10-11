# Instructions for AI coding agents

These rules apply to any AI assistant working in this repository (Claude Code, Codex, Cursor, Copilot and
the like).

## Commits and attribution

- **Do not attribute commits to an AI.** Never add `Co-Authored-By:` trailers naming Claude or any other
  assistant, and never add "Generated with Claude Code" or similar lines to commit messages, pull request
  descriptions, code comments or docs.
- **Commits come from the people on the team.** Author and commit only as the human user's own git
  identity. Don't change `user.name`/`user.email`, and don't pass `--author`.
- **Don't commit or push unless the user asks.** Leave changes in the working tree for the user to
  review and commit themselves.
- Never skip hooks (`--no-verify`) or rewrite published history unless the user explicitly asks.

## The project

Baton runs a coding agent on a server and makes its work a shared, live session: an append-only event
log that everyone subscribes to, with roles (one driver at a time), hand-offs, comments, a scrubber,
forks, and a code view (editor and terminal on the session's workspace). See `README.md` for the
feature tour and `technical-plan.md` for the original design.

```
backend/baton/       FastAPI app, event store, runner, context builder, sandbox, model adapters
backend/tests/       pytest suite
web/                 React + Vite + Tailwind single-page app (built output committed in web/dist)
sample-repos/        the small repos agents work on in demos
scripts/             browser-driven rehearsals of the demo (Playwright)
```

Ground rules the code depends on:

- **The log is the source of truth.** Model context, catch-up cards, forks and resume are all rebuilt
  from events. Anything a person does that the agent should know about must be an event.
- **Humans act only through `SessionManager.command`**, which checks roles and appends `human.*` and
  `control.*` events. The `Runner` is the only writer of `agent.*` and `tool.*` events.
- **Driver-only actions** (steer, interrupt, decisions, saving files, running terminal commands) must
  call `require_driver()`.
- Keep it cross-platform: the team develops on Windows and macOS. Use `pathlib`, `.as_posix()` for paths
  that reach clients, explicit `encoding="utf-8"`, and no POSIX-only calls without a fallback.

## Checks before you hand work back

```bash
.venv/bin/python -m pytest          # Windows: .venv\Scripts\python -m pytest
cd web && npm test && npx tsc -b
cd web && npm run build             # web/dist is committed; rebuild it when the frontend changes
python scripts/e2e_demo.py --url http://localhost:8000   # optional: full two-browser rehearsal
python scripts/e2e_code.py --url http://localhost:8000   # optional: the code view
python scripts/e2e_mobile.py --url http://localhost:8000 # optional: judges on phones, open floor
```

Deploying: `deploy/lightsail/` (see its README). Never commit `deploy/lightsail/server.env` or anything
in `deploy/lightsail/.ssh/`; both are gitignored and hold secrets.

Building the web app needs Node 20.19+ or 22.12+. A portable Node unzipped into `.tools/node` (gitignored)
is picked up by `run.sh` and `run.ps1`.
