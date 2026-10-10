import type { BatonEvent, Payload } from "./types";

export type Item =
  | { kind: "start"; seq: number; ev: BatonEvent }
  | { kind: "text"; seq: number; ev: BatonEvent }
  | { kind: "thinking"; seq: number; ev: BatonEvent }
  | { kind: "tool"; seq: number; call: BatonEvent; result?: BatonEvent }
  | { kind: "group"; seq: number; tools: ToolItem[] }
  | { kind: "plan"; seq: number; call: BatonEvent; steps: PlanStep[]; prev: PlanStep[] }
  | { kind: "decision"; seq: number; call: BatonEvent; point?: BatonEvent; answer?: BatonEvent }
  | { kind: "finish"; seq: number; call: BatonEvent; summary: string }
  | { kind: "human"; seq: number; ev: BatonEvent; promotedBy?: BatonEvent; dismissed?: BatonEvent }
  | { kind: "request"; seq: number; ev: BatonEvent; resolved?: BatonEvent }
  | { kind: "system"; seq: number; ev: BatonEvent }
  | { kind: "error"; seq: number; ev: BatonEvent };

export type ToolItem = { kind: "tool"; seq: number; call: BatonEvent; result?: BatonEvent };

const READ_ONLY = new Set(["read_file", "list_files"]);

/** Fold runs of finished, read-only steps (reading files, listing folders) into one row. */
export function groupReads(items: Item[], keepOpen: Set<number> = new Set()): Item[] {
  const out: Item[] = [];
  let run: ToolItem[] = [];
  const flush = () => {
    if (run.length >= 2) out.push({ kind: "group", seq: run[0].seq, tools: run });
    else out.push(...run);
    run = [];
  };
  for (const it of items) {
    const foldable =
      it.kind === "tool" && READ_ONLY.has(it.call.payload.name) && !!it.result && !it.result.payload.is_error && !keepOpen.has(it.seq);
    if (foldable) run.push(it as ToolItem);
    else {
      flush();
      out.push(it);
    }
  }
  flush();
  return out;
}

export interface PlanStep {
  title: string;
  status: "pending" | "in_progress" | "done";
}

const SYSTEM = new Set([
  "participant.joined",
  "control.driver_changed",
  "control.model_changed",
  "human.interrupt",
  "session.resumed",
  "session.forked",
  "agent.checkpoint",
  "control.driver_declined",
]);

/** Fold the flat event log into timeline items. Pure, so the scrubber can call it with a prefix. */
export function buildItems(events: BatonEvent[]): Item[] {
  const items: Item[] = [];
  const byCall = new Map<string, Item>();
  const bySeq = new Map<number, Item>();
  const openRequests: Item[] = [];
  let plan: PlanStep[] = [];

  for (const ev of events) {
    const p = ev.payload;
    switch (ev.type) {
      case "session.started":
        items.push({ kind: "start", seq: ev.seq, ev });
        break;
      case "agent.text":
        if (p.text?.trim()) items.push({ kind: "text", seq: ev.seq, ev });
        break;
      case "agent.thinking":
        items.push({ kind: "thinking", seq: ev.seq, ev });
        break;
      case "tool.call": {
        let it: Item;
        if (p.name === "ask_humans") it = { kind: "decision", seq: ev.seq, call: ev };
        else if (p.name === "update_plan") {
          const steps = (p.input?.steps || []) as PlanStep[];
          it = { kind: "plan", seq: ev.seq, call: ev, steps, prev: plan };
          plan = steps;
        } else if (p.name === "finish") it = { kind: "finish", seq: ev.seq, call: ev, summary: p.input?.summary || "" };
        else it = { kind: "tool", seq: ev.seq, call: ev };
        byCall.set(p.call_id, it);
        items.push(it);
        break;
      }
      case "tool.result": {
        const it = byCall.get(p.call_id);
        if (it && it.kind === "tool") it.result = ev;
        break;
      }
      case "agent.decision_point": {
        const it = byCall.get(p.call_id);
        if (it && it.kind === "decision") it.point = ev;
        break;
      }
      case "human.decision": {
        const it = byCall.get(p.call_id);
        if (it && it.kind === "decision") it.answer = ev;
        break;
      }
      case "human.message": {
        const it: Item = { kind: "human", seq: ev.seq, ev };
        items.push(it);
        bySeq.set(ev.seq, it);
        const from = p.promoted_from as Payload | undefined;
        if (from?.seq) {
          const src = bySeq.get(from.seq);
          if (src && src.kind === "human") src.promotedBy = ev;
        }
        break;
      }
      case "human.suggestion_dismissed": {
        const src = bySeq.get(p.seq);
        if (src && src.kind === "human") src.dismissed = ev;
        break;
      }
      case "control.driver_requested": {
        const it: Item = { kind: "request", seq: ev.seq, ev };
        openRequests.push(it);
        items.push(it);
        break;
      }
      case "session.error":
        items.push({ kind: "error", seq: ev.seq, ev });
        break;
      default:
        if (SYSTEM.has(ev.type)) items.push({ kind: "system", seq: ev.seq, ev });
    }
    if (ev.type === "control.driver_changed" || ev.type === "control.driver_declined") {
      for (const r of openRequests) {
        if (r.kind === "request" && !r.resolved && (r.ev.actor === ev.payload.to || ev.type === "control.driver_changed")) {
          r.resolved = ev;
        }
      }
    }
  }
  return items;
}

export function currentPlan(events: BatonEvent[]): PlanStep[] {
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i].type === "agent.plan") return events[i].payload.steps || [];
  }
  return [];
}

export function openDecision(events: BatonEvent[]) {
  const answered = new Set(events.filter((e) => e.type === "human.decision").map((e) => e.payload.decision_seq));
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e.type === "agent.decision_point" && !answered.has(e.seq)) return e;
  }
  return null;
}

export interface Stats {
  turns: number;
  toolCalls: number;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  interventions: number;
  models: string[];
  started: number | null;
  ended: number | null;
  filesChanged: number;
}

export function stats(events: BatonEvent[]): Stats {
  const s: Stats = {
    turns: 0, toolCalls: 0, inputTokens: 0, outputTokens: 0, cachedTokens: 0, interventions: 0,
    models: [], started: events[0]?.ts ?? null, ended: null, filesChanged: 0,
  };
  const files = new Set<string>();
  const turnsSeen = new Set<number>(); // for agents that don't report agent.turn (external agents)
  for (const e of events) {
    if ((e.type === "agent.text" || e.type === "tool.call") && typeof e.payload.turn === "number") turnsSeen.add(e.payload.turn);
    if (e.type === "agent.turn") {
      s.turns++;
      s.inputTokens += e.payload.usage?.input_tokens || 0;
      s.outputTokens += e.payload.usage?.output_tokens || 0;
      s.cachedTokens += e.payload.usage?.cached_tokens || 0;
      if (!s.models.includes(e.payload.model)) s.models.push(e.payload.model);
    } else if (e.type === "tool.call") {
      s.toolCalls++;
      if (e.payload.name === "write_file" || e.payload.name === "edit_file") files.add(e.payload.input?.path);
    } else if (
      (e.type === "human.message" && e.payload.mode === "steer") ||
      e.type === "human.decision" ||
      e.type === "human.interrupt"
    ) {
      s.interventions++;
    } else if (e.type === "session.status" && e.payload.status === "done") {
      s.ended = e.ts;
    }
  }
  s.filesChanged = files.size;
  if (!s.turns) s.turns = turnsSeen.size;
  return s;
}

/** Marks for the scrubber track: where humans stepped in, decisions, errors. */
export function marks(events: BatonEvent[]) {
  return events
    .filter((e) =>
      ["human.message", "human.decision", "human.interrupt", "agent.decision_point", "control.driver_changed", "session.error", "control.model_changed"].includes(e.type),
    )
    .map((e) => ({ seq: e.seq, type: e.type, actor: e.actor, mode: e.payload.mode as string | undefined }));
}
