import { describe, expect, it } from "vitest";
import { buildItems, currentPlan, groupReads, marks, openDecision, stats } from "./derive";
import type { BatonEvent, Payload } from "./types";

let seq = 0;
function ev(type: string, payload: Payload = {}, actor = "agent"): BatonEvent {
  seq += 1;
  return { session_id: "s", seq, ts: 1000 + seq, actor, type, payload };
}

function sessionLog() {
  seq = 0;
  return [
    ev("session.started", { task: "Add rate limiting", repo: "notes-api", model: "baton-demo" }, "alice"),
    ev("agent.text", { text: "Looking around.", turn: 1 }),
    ev("tool.call", { call_id: "c1", name: "read_file", input: { path: "app/server.py" }, turn: 1 }),
    ev("agent.turn", { turn: 1, model: "baton-demo", usage: { input_tokens: 100, output_tokens: 20 } }),
    ev("tool.result", { call_id: "c1", output: "...", duration_ms: 3 }),
    ev("tool.call", { call_id: "p1", name: "update_plan", input: { steps: [{ title: "Explore", status: "in_progress" }] }, turn: 2 }),
    ev("agent.plan", { steps: [{ title: "Explore", status: "in_progress" }] }),
    ev("human.message", { text: "Use the new middleware", mode: "suggest" }, "bob"),
    ev("tool.call", { call_id: "a1", name: "ask_humans", input: { question: "Key or IP?", options: ["Key", "IP"] }, turn: 3 }),
    ev("agent.turn", { turn: 3, model: "claude-sonnet-5-5", usage: { input_tokens: 50, output_tokens: 5 } }),
    ev("agent.decision_point", { call_id: "a1", question: "Key or IP?", options: ["Key", "IP"] }),
    ev("human.message", { text: "Use the new middleware", mode: "steer", promoted_from: { seq: 8 }, suggested_by: "bob" }, "alice"),
  ];
}

describe("buildItems", () => {
  it("pairs tool calls with results and folds control tools into their own items", () => {
    const items = buildItems(sessionLog());
    const kinds = items.map((i) => i.kind);
    expect(kinds).toEqual(["start", "text", "tool", "plan", "human", "decision", "human"]);
    const tool = items[2];
    expect(tool.kind === "tool" && tool.result?.payload.call_id).toBe("c1");
    const decision = items[5];
    expect(decision.kind === "decision" && decision.point?.payload.question).toBe("Key or IP?");
    expect(decision.kind === "decision" && decision.answer).toBeUndefined();
  });

  it("marks a suggestion as promoted when the driver sends it to the agent", () => {
    const items = buildItems(sessionLog());
    const suggestion = items[4];
    expect(suggestion.kind).toBe("human");
    expect(suggestion.kind === "human" && suggestion.promotedBy?.actor).toBe("alice");
  });

  it("is a pure function of a log prefix, so the scrubber can rebuild any point in time", () => {
    const log = sessionLog();
    const early = buildItems(log.filter((e) => e.seq <= 3));
    const tool = early.find((i) => i.kind === "tool");
    expect(tool && tool.kind === "tool" && tool.result).toBeUndefined();
  });
});

describe("groupReads", () => {
  it("folds runs of finished reads into one row, but not across commentary or for commented steps", () => {
    seq = 0;
    const log = [
      ev("tool.call", { call_id: "a", name: "read_file", input: { path: "a.py" } }),
      ev("tool.result", { call_id: "a", output: "" }),
      ev("tool.call", { call_id: "b", name: "list_files", input: {} }),
      ev("tool.result", { call_id: "b", output: "" }),
      ev("tool.call", { call_id: "c", name: "read_file", input: { path: "c.py" } }),
      ev("tool.result", { call_id: "c", output: "" }),
      ev("agent.text", { text: "Now writing.", turn: 2 }),
      ev("tool.call", { call_id: "d", name: "read_file", input: { path: "d.py" } }),
      ev("tool.result", { call_id: "d", output: "" }),
    ];
    const grouped = groupReads(buildItems(log));
    expect(grouped.map((i) => i.kind)).toEqual(["group", "text", "tool"]);
    expect(grouped[0].kind === "group" && grouped[0].tools.length).toBe(3);
    const keep = groupReads(buildItems(log), new Set([3]));
    expect(keep.map((i) => i.kind)).toEqual(["tool", "tool", "tool", "text", "tool"]);
  });
});

describe("derived session state", () => {
  it("finds the open decision until someone answers it", () => {
    const log = sessionLog();
    expect(openDecision(log)?.payload.question).toBe("Key or IP?");
    const answered = [...log, ev("human.decision", { decision_seq: 11, call_id: "a1", answer: "Key" }, "bob")];
    expect(openDecision(answered)).toBeNull();
    expect(buildItems(answered).find((i) => i.kind === "decision")).toMatchObject({ answer: { actor: "bob" } });
  });

  it("tracks the latest plan, usage across models, and human interventions", () => {
    const log = sessionLog();
    expect(currentPlan(log)).toEqual([{ title: "Explore", status: "in_progress" }]);
    const s = stats(log);
    expect(s.turns).toBe(2);
    expect(s.inputTokens).toBe(150);
    expect(s.models).toEqual(["baton-demo", "claude-sonnet-5-5"]);
    expect(s.interventions).toBe(1); // the suggestion only counts once it is sent to the agent
    expect(s.toolCalls).toBe(3);
  });

  it("counts turns from the log when an external agent doesn't report them", () => {
    seq = 0;
    const log = [ev("agent.text", { text: "a", turn: 1 }), ev("tool.call", { call_id: "x", name: "read_file", turn: 1 }), ev("agent.text", { text: "b", turn: 2 })];
    expect(stats(log).turns).toBe(2);
  });

  it("puts human moments and decisions on the scrubber track", () => {
    const m = marks(sessionLog());
    expect(m.map((x) => x.type)).toEqual(["human.message", "agent.decision_point", "human.message"]);
    expect(m[0].mode).toBe("suggest");
  });
});
