"""Turn the event log into model context, summaries and catch-up cards.

The log is the source of truth. Model context is rebuilt from it before every
turn, which is what makes resume-after-restart, compaction and switching
models mid-session all fall out of the same code path.
"""
from __future__ import annotations

import json
import re
from typing import Callable

SYSTEM_PROMPT = """You are a software engineering agent working in a shared Baton session. Several people may be watching your work live, and they can steer you at any time.

You are working in a repository checked out as your working directory. Use the tools to explore, edit and test it. Commands run without network access.

How to work:
- Early on, call update_plan with 3-6 concrete steps, and call it again whenever a step's status or the plan changes.
- Messages from people arrive as "[Name, steering]: ...". The latest steering message is authoritative: acknowledge it in one short sentence and adapt.
- If the task leaves a product decision open (who a limit applies to, defaults, error formats, naming), ask with ask_humans before you implement it, offering 2-4 concrete options. Don't ask about things you can settle from the code.
- Between tool calls, write one or two plain sentences on what you are doing and why. Do not repeat file contents back.
- Run the tests before you call finish. Call finish with a short summary of what changed."""

UserLookup = Callable[[str], str]


def actor_name(names: dict[str, str], actor: str) -> str:
    return names.get(actor, actor if actor in ("agent", "system") else "Someone")


def steer_text(ev: dict, names: dict[str, str]) -> str:
    p = ev["payload"]
    who = actor_name(names, ev["actor"])
    if p.get("promoted_from"):
        src = names.get(p.get("suggested_by", ""), "a collaborator")
        return f"[{who}, steering, promoting a suggestion from {src}]: {p['text']}"
    return f"[{who}, steering]: {p['text']}"


def build_messages(task: str, created_by: str, events: list[dict], names: dict[str, str],
                   checkpoint: dict | None = None) -> list[dict]:
    """Rebuild provider-neutral messages from the log (optionally after a checkpoint)."""
    intro = f"Task from {actor_name(names, created_by)}:\n{task}"
    after = 0
    if checkpoint:
        after = checkpoint["payload"]["covers_seq"]
        intro += (
            "\n\nEarlier history has been compacted. Summary of the work so far:\n"
            + checkpoint["payload"]["summary"]
        )
    msgs: list[dict] = [{"role": "user", "content": [{"type": "text", "text": intro}]}]
    pending: list[str] = []
    open_calls: dict[str, str] = {}

    def add(role: str, block: dict) -> None:
        if msgs[-1]["role"] == role:
            msgs[-1]["content"].append(block)
        else:
            msgs.append({"role": role, "content": [block]})

    def close_open_calls() -> None:
        for cid in list(open_calls):
            add("user", {"type": "tool_result", "id": cid, "output": "(no result was recorded for this call)", "is_error": True})
        open_calls.clear()

    def flush() -> None:
        if not pending:
            return
        close_open_calls()
        for t in pending:
            add("user", {"type": "text", "text": t})
        pending.clear()

    for ev in events:
        if ev["seq"] <= after:
            continue
        t, p = ev["type"], ev["payload"]
        if t == "agent.thinking" and p.get("blocks"):
            flush()
            if open_calls:
                close_open_calls()
            for raw in p["blocks"]:
                add("assistant", {"type": "thinking", "model": p.get("model", ""), "raw": raw})
        elif t == "agent.text":
            flush()
            if open_calls:
                close_open_calls()
            if p.get("text", "").strip():
                add("assistant", {"type": "text", "text": p["text"]})
        elif t == "tool.call":
            flush()
            add("assistant", {"type": "tool_call", "id": p["call_id"], "name": p["name"], "input": p.get("input") or {}})
            open_calls[p["call_id"]] = p["name"]
        elif t == "tool.result":
            if p["call_id"] not in open_calls:
                continue
            open_calls.pop(p["call_id"])
            out = p.get("output", "")
            if p.get("cancelled"):
                out = f"Cancelled: {actor_name(names, p.get('cancelled_by', ''))} interrupted this call before it finished."
            add("user", {"type": "tool_result", "id": p["call_id"], "output": out, "is_error": bool(p.get("is_error"))})
        elif t == "human.message" and p.get("mode") == "steer":
            pending.append(steer_text(ev, names))
        elif t == "human.interrupt":
            pending.append(f"(system note: {actor_name(names, ev['actor'])} interrupted you mid-step. Wait for their direction.)")
        elif t == "control.driver_changed":
            pending.append(f"(system note: {actor_name(names, p['to'])} is now driving this session.)")
        elif t == "control.model_changed":
            pending.append(f"(system note: this session switched to {p['to']['model']}; the history above came from {p['from']['model']}.)")
    # A decision still awaiting an answer keeps its call open; anything else gets closed out.
    if pending:
        flush()
    elif open_calls and not any(n == "ask_humans" for n in open_calls.values()):
        close_open_calls()
    if msgs[-1]["role"] == "assistant":
        msgs.append({"role": "user", "content": [{"type": "text", "text": "(system note: continue.)"}]})
    return msgs


def estimate_tokens(messages: list[dict]) -> int:
    return sum(len(json.dumps(m["content"])) for m in messages) // 4 + len(SYSTEM_PROMPT) // 4


# ---------------------------------------------------------------------------
# Turns and checkpoints

def turn_starts(events: list[dict], after: int = 0) -> list[int]:
    """Seq of the first event of each agent turn after `after`."""
    seen: set[int] = set()
    starts = []
    for ev in events:
        if ev["seq"] <= after or ev["type"] not in ("agent.thinking", "agent.text", "tool.call"):
            continue
        turn = ev["payload"].get("turn")
        if turn is not None and turn not in seen:
            seen.add(turn)
            starts.append(ev["seq"])
    return starts


def checkpoint_cut(events: list[dict], after: int, keep_turns: int) -> int | None:
    """Pick the seq a new checkpoint should cover up to, keeping the last N turns verbatim."""
    starts = turn_starts(events, after)
    if len(starts) <= keep_turns:
        return None
    return starts[-keep_turns] - 1


# ---------------------------------------------------------------------------
# Plain-language rendering, used for summaries and catch-up prompts

def clip(s: str, n: int = 140) -> str:
    s = " ".join(str(s).split())
    return s if len(s) <= n else s[: n - 1] + "…"


def describe_call(name: str, args: dict) -> str:
    if name in ("read_file", "write_file", "edit_file"):
        verb = {"read_file": "Read", "write_file": "Wrote", "edit_file": "Edited"}[name]
        return f"{verb} {args.get('path', '?')}"
    if name == "list_files":
        return f"Listed files in {args.get('path') or '.'}"
    if name == "run_command":
        return f"Ran `{clip(args.get('command', ''), 60)}`"
    if name == "update_plan":
        return "Updated the plan"
    if name == "ask_humans":
        return f"Asked: {clip(args.get('question', ''), 80)}"
    if name == "finish":
        return "Marked the task complete"
    return f"Called {name}"


def render_events(events: list[dict], names: dict[str, str], limit_chars: int = 12000) -> str:
    lines = []
    calls: dict[str, dict] = {}
    for ev in events:
        t, p = ev["type"], ev["payload"]
        who = actor_name(names, ev["actor"])
        if t == "agent.text" and p.get("text"):
            lines.append(f"#{ev['seq']} agent: {clip(p['text'], 300)}")
        elif t == "tool.call":
            calls[p["call_id"]] = p
            lines.append(f"#{ev['seq']} agent tool: {describe_call(p['name'], p.get('input') or {})}")
        elif t == "tool.result":
            c = calls.get(p["call_id"], {})
            status = "cancelled" if p.get("cancelled") else ("error" if p.get("is_error") else "ok")
            if c.get("name") == "run_command":
                lines.append(f"#{ev['seq']} result ({status}): {clip(p.get('output', ''), 200)}")
            elif status != "ok":
                lines.append(f"#{ev['seq']} result ({status}): {clip(p.get('output', ''), 120)}")
        elif t == "human.message":
            lines.append(f"#{ev['seq']} {who} ({p.get('mode')}): {clip(p.get('text', ''), 200)}")
        elif t == "human.interrupt":
            lines.append(f"#{ev['seq']} {who} interrupted the agent")
        elif t == "human.decision":
            lines.append(f"#{ev['seq']} {who} decided: {clip(p.get('answer', ''), 120)}")
        elif t == "control.driver_changed":
            lines.append(f"#{ev['seq']} driver changed to {actor_name(names, p['to'])}")
        elif t == "control.model_changed":
            lines.append(f"#{ev['seq']} model switched to {p['to']['model']} by {who}")
        elif t == "agent.plan":
            plan = "; ".join(f"[{s.get('status')}] {s.get('title')}" for s in p.get("steps", []))
            lines.append(f"#{ev['seq']} plan: {plan}")
        elif t == "session.status":
            lines.append(f"#{ev['seq']} status -> {p.get('status')}")
    text = "\n".join(lines)
    return text[-limit_chars:]


# ---------------------------------------------------------------------------
# Heuristic summaries (always available, instant, exact attributions)

def latest_plan(events: list[dict]) -> list[dict]:
    for ev in reversed(events):
        if ev["type"] == "agent.plan":
            return ev["payload"].get("steps", [])
    return []


def open_decisions(events: list[dict]) -> list[dict]:
    answered = {ev["payload"].get("decision_seq") for ev in events if ev["type"] == "human.decision"}
    return [
        {"seq": ev["seq"], "question": ev["payload"]["question"], "options": ev["payload"].get("options", [])}
        for ev in events
        if ev["type"] == "agent.decision_point" and ev["seq"] not in answered
    ]


def interventions(events: list[dict], names: dict[str, str]) -> list[dict]:
    out = []
    for ev in events:
        t, p = ev["type"], ev["payload"]
        who = actor_name(names, ev["actor"])
        if t == "human.message" and p.get("mode") == "steer":
            if p.get("promoted_from"):
                src = names.get(p.get("suggested_by", ""), "a collaborator")
                out.append({"seq": ev["seq"], "who": who, "with": src, "what": f"sent {src}'s note to the agent: “{clip(p['text'], 90)}”"})
            else:
                out.append({"seq": ev["seq"], "who": who, "what": f"steered: “{clip(p['text'], 90)}”"})
        elif t == "human.interrupt":
            out.append({"seq": ev["seq"], "who": who, "what": "interrupted the agent"})
        elif t == "human.decision":
            out.append({"seq": ev["seq"], "who": who, "what": f"decided: {clip(p.get('answer', ''), 90)}"})
        elif t == "control.driver_changed" and p.get("reason") == "force":
            out.append({"seq": ev["seq"], "who": actor_name(names, p["to"]), "what": "took the baton"})
        elif t == "control.driver_changed" and p.get("from"):
            out.append({"seq": ev["seq"], "who": actor_name(names, p["from"]), "what": f"handed off to {actor_name(names, p['to'])}"})
        elif t == "control.model_changed":
            out.append({"seq": ev["seq"], "who": who, "what": f"switched the model to {p['to']['model']}"})
    return out


def heuristic_card(session: dict, events: list[dict], names: dict[str, str]) -> dict:
    plan = latest_plan(events)
    questions = open_decisions(events)
    plan_done: list[str] = [s["title"] for s in plan if s.get("status") == "done"]
    done: list[str] = []  # concrete facts from the log first, then completed plan steps
    nxt: list[str] = [s["title"] for s in plan if s.get("status") != "done"]
    calls = {ev["payload"]["call_id"]: ev["payload"] for ev in events if ev["type"] == "tool.call"}
    touched: list[str] = []
    last_test = None
    for ev in events:
        if ev["type"] != "tool.result" or ev["payload"].get("is_error"):
            if ev["type"] == "tool.result" and calls.get(ev["payload"]["call_id"], {}).get("name") == "run_command":
                last_test = ev["payload"]
            continue
        c = calls.get(ev["payload"]["call_id"], {})
        if c.get("name") in ("write_file", "edit_file"):
            path = (c.get("input") or {}).get("path")
            if path and path not in touched:
                touched.append(path)
        if c.get("name") == "run_command":
            last_test = ev["payload"]
    read = []
    for c in calls.values():
        path = (c.get("input") or {}).get("path")
        if c.get("name") == "read_file" and path and path not in read and path not in touched:
            read.append(path)
    if touched:
        done.append("Changed " + ", ".join(f"`{p}`" for p in touched[:4]))
    if read:
        names_ = [r.rsplit("/", 1)[-1] for r in read]
        more = f" and {len(names_) - 3} more" if len(names_) > 3 else ""
        done.append(f"Read {len(read)} file{'s' if len(read) != 1 else ''}: " + ", ".join(names_[:3]) + more)
    if last_test is not None:
        ok = last_test.get("exit_code", 1) == 0
        m = re.search(r"Ran (\d+) tests?", last_test.get("output", ""))
        n = f"{m.group(1)} tests" if m else "the test suite"
        done.insert(0, f"Ran {n}: {'passing' if ok else 'failing'}")
    done += plan_done

    status = session["status"]
    last_text = next((ev["payload"]["text"] for ev in reversed(events) if ev["type"] == "agent.text" and ev["payload"].get("text")), "")
    if status == "done":
        fin = next((ev["payload"] for ev in reversed(events) if ev["type"] == "session.status" and ev["payload"].get("status") == "done"), {})
        doing = "Finished. " + clip((fin.get("summary") or last_text).splitlines()[0] if (fin.get("summary") or last_text) else "", 160)
    elif questions:
        doing = f"Paused on a decision: {questions[-1]['question']}"
    elif status == "error":
        err = next((ev["payload"].get("message", "") for ev in reversed(events) if ev["type"] == "session.error"), "")
        doing = "Stopped on an error: " + clip(err, 140)
    elif status == "waiting_input" and last_text:
        doing = "Waiting for direction. Last update: " + clip(first_sentence(last_text), 120)
    else:
        current = next((s["title"] for s in plan if s.get("status") == "in_progress"), None)
        doing = current or clip(first_sentence(last_text) or session["task"], 160)
    return {
        "goal": clip(session["task"], 200),
        "doing": doing,
        "done": done[:6],
        "changed": interventions(events, names)[-5:],
        "next": nxt[:5],
        "questions": questions,
        "head_seq": events[-1]["seq"] if events else 0,
        "source": "log",
    }


def first_sentence(text: str) -> str:
    m = re.match(r"(.+?[.!?])(\s|$)", text.strip(), re.S)
    return (m.group(1) if m else text).strip()


def heuristic_summary(session: dict, events: list[dict], names: dict[str, str], previous: str = "") -> str:
    card = heuristic_card(session, events, names)
    parts = []
    if previous:
        parts.append(previous.strip())
    if card["done"]:
        parts.append("Done so far: " + "; ".join(card["done"]))
    if card["changed"]:
        parts.append("Human input: " + "; ".join(f"{c['who']} {c['what']}" for c in card["changed"]))
    plan = latest_plan(events)
    if plan:
        parts.append("Plan: " + "; ".join(f"[{s.get('status')}] {s.get('title')}" for s in plan))
    return "\n".join(parts)


CATCHUP_SYSTEM = (
    "You write catch-up cards for people joining a live AI agent session. Be concrete and brief. "
    "Reply with JSON only."
)


def catchup_prompt(session: dict, checkpoint_summary: str, rendered: str, card: dict) -> str:
    return (
        f"Task: {session['task']}\n\n"
        + (f"Summary of earlier work:\n{checkpoint_summary}\n\n" if checkpoint_summary else "")
        + f"Recent events (most recent last):\n{rendered}\n\n"
        + f"Current status: {session['status']}. Current plan: {json.dumps(card['next'])}\n\n"
        + 'Return JSON: {"doing": "one sentence on what the agent is doing right now", '
        '"done": ["up to 4 short completed steps"], "next": ["up to 3 short next steps"]}'
    )


def parse_json_object(text: str) -> dict | None:
    m = re.search(r"\{.*\}", text, re.S)
    if not m:
        return None
    try:
        v = json.loads(m.group(0))
        return v if isinstance(v, dict) else None
    except json.JSONDecodeError:
        return None
