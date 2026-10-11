"""Cross-session analytics, computed straight from the event logs."""
from __future__ import annotations

import statistics

from .db import DB

KINDS = [
    ("steer", "Steered directly"),
    ("promoted", "Sent a teammate's note"),
    ("decision", "Answered a decision"),
    ("interrupt", "Interrupted"),
    ("edit", "Edited code by hand"),
    ("command", "Ran a command"),
    ("handoff", "Handed off the baton"),
    ("model", "Switched models"),
]


def classify(ev: dict) -> str | None:
    t, p = ev["type"], ev["payload"]
    if t == "human.message" and p.get("mode") == "steer":
        return "promoted" if p.get("promoted_from") else "steer"
    if t == "human.decision":
        return "decision"
    if t == "human.interrupt":
        return "interrupt"
    if t == "human.edit":
        return "edit"
    if t == "human.command":
        return "command"
    if t == "control.driver_changed" and p.get("from"):
        return "handoff"
    if t == "control.model_changed":
        return "model"
    return None


def compute(db: DB) -> dict:
    counts = {k: 0 for k, _ in KINDS}
    bins = [0] * 10
    first_gaps: list[float] = []
    people: set[str] = set()
    models: dict[tuple[str, str], dict] = {}
    sessions = db.list_sessions()
    done = active = 0
    for s in sessions:
        done += s["status"] == "done"
        active += s["status"] in ("running", "waiting_input")
        events = db.events(s["id"])
        if not events:
            continue
        head, start = events[-1]["seq"], events[0]["ts"]
        first = None
        for ev in events:
            kind = classify(ev)
            if kind:
                counts[kind] += 1
                bins[min(9, int(10 * (ev["seq"] - 1) / max(1, head)))] += 1
                if first is None:
                    first = ev["ts"] - start
            if ev["type"] == "agent.turn":
                key = (ev["payload"].get("provider", ""), ev["payload"].get("model", ""))
                m = models.setdefault(key, {"provider": key[0], "model": key[1], "sessions": set(), "turns": 0,
                                            "tokens_in": 0, "tokens_out": 0})
                m["sessions"].add(s["id"])
                m["turns"] += 1
                m["tokens_in"] += (ev["payload"].get("usage") or {}).get("input_tokens", 0)
                m["tokens_out"] += (ev["payload"].get("usage") or {}).get("output_tokens", 0)
        if first is not None:
            first_gaps.append(first)
        people.update(p["user_id"] for p in db.participants(s["id"]))
    total = sum(counts.values())
    return {
        "sessions": len(sessions),
        "done": done,
        "active": active,
        "people": len(people),
        "interventions": total,
        "per_session": round(total / len(sessions), 1) if sessions else 0,
        "median_first_intervention_s": round(statistics.median(first_gaps), 1) if first_gaps else None,
        "by_kind": [{"kind": k, "label": label, "count": counts[k]} for k, label in KINDS],
        "position": bins,
        "models": sorted(
            ({**m, "sessions": len(m["sessions"])} for m in models.values()),
            key=lambda m: -m["turns"],
        ),
    }
