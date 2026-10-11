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
  | { kind: "edit"; seq: number; ev: BatonEvent }
  | { kind: "command"; seq: number; ev: BatonEvent; result?: BatonEvent }
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
  "control.open_floor",
  "github.pushed",
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
      case "human.edit":
        items.push({ kind: "edit", seq: ev.seq, ev });
        break;
      case "human.command": {
        const it: Item = { kind: "command", seq: ev.seq, ev };
        byCall.set(p.call_id, it);
        items.push(it);
        break;
      }
      case "human.command_result": {
        const it = byCall.get(p.call_id);
        if (it && it.kind === "command") it.result = ev;
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
      e.type === "human.interrupt" ||
      e.type === "human.edit" ||
      e.type === "human.command"
    ) {
      s.interventions++;
      if (e.type === "human.edit") files.add(e.payload.path);
    } else if (e.type === "session.status" && e.payload.status === "done") {
      s.ended = e.ts;
    }
  }
  s.filesChanged = files.size;
  if (!s.turns) s.turns = turnsSeen.size;
  return s;
}

/* ---------------------------------------------------------------- the code view */

const FILE_VERBS: Record<string, FileActivity["verb"]> = { read_file: "reading", write_file: "writing", edit_file: "editing" };

export interface FileActivity {
  path: string;
  verb: "reading" | "writing" | "editing";
}

/** The file the agent is working on right now: one it's still writing out, or a file call still running. */
export function agentFile(events: BatonEvent[], drafting?: { name: string; target: string } | null): FileActivity | null {
  if (drafting?.target && (drafting.name === "write_file" || drafting.name === "edit_file")) {
    return { path: drafting.target, verb: FILE_VERBS[drafting.name] };
  }
  // A turn appends all its calls first and then runs them in order, so the earliest unfinished one is running.
  const finished = new Set<string>();
  let running: FileActivity | null = null;
  for (let i = events.length - 1; i >= 0 && i >= events.length - 60; i--) {
    const e = events[i];
    if (e.type === "tool.result") finished.add(e.payload.call_id);
    else if (e.type === "tool.call" && !finished.has(e.payload.call_id) && FILE_VERBS[e.payload.name] && e.payload.input?.path) {
      running = { path: String(e.payload.input.path), verb: FILE_VERBS[e.payload.name] };
    }
  }
  return running;
}

/** Who last changed each file, the agent or a person, and at which step. */
export function lastWriters(events: BatonEvent[]): Record<string, { actor: string; seq: number }> {
  const out: Record<string, { actor: string; seq: number }> = {};
  const calls = new Map<string, BatonEvent>();
  for (const e of events) {
    if (e.type === "tool.call") calls.set(e.payload.call_id, e);
    else if (e.type === "tool.result" && !e.payload.is_error) {
      const c = calls.get(e.payload.call_id);
      const name = c?.payload.name;
      if (c && (name === "write_file" || name === "edit_file") && c.payload.input?.path) {
        out[String(c.payload.input.path)] = { actor: "agent", seq: c.seq };
      }
    } else if (e.type === "human.edit") {
      out[e.payload.path] = { actor: e.actor, seq: e.seq };
    }
  }
  return out;
}

export interface Run {
  seq: number;
  actor: string; // "agent" or the person who ran it
  command: string;
  running: boolean;
  output: string;
  exitCode?: number;
  cancelled: boolean;
}

/** Everything that ran in the workspace, by the agent or in the terminal, oldest first. */
export function workspaceRuns(events: BatonEvent[]): Run[] {
  const runs: Run[] = [];
  const byCall = new Map<string, Run>();
  for (const e of events) {
    const p = e.payload;
    if ((e.type === "tool.call" && p.name === "run_command") || e.type === "human.command") {
      const r: Run = {
        seq: e.seq, actor: e.type === "tool.call" ? "agent" : e.actor, running: true, output: "", cancelled: false,
        command: String(e.type === "tool.call" ? p.input?.command ?? "" : p.command),
      };
      byCall.set(p.call_id, r);
      runs.push(r);
    } else if (e.type === "tool.result" || e.type === "human.command_result") {
      const r = byCall.get(p.call_id);
      if (!r) continue;
      r.running = false;
      r.cancelled = !!p.cancelled;
      r.exitCode = p.exit_code;
      r.output = String(p.output || "").replace(/\n?\[exit code -?\d+\]\s*$/, "");
    }
  }
  return runs;
}

/** Bumps whenever something may have changed files in the workspace, so file lists know to refresh. */
export function workspaceVersion(events: BatonEvent[]): number {
  let n = 0;
  for (const e of events) if (e.type === "tool.result" || e.type === "human.edit" || e.type === "human.command_result") n++;
  return n;
}

/** Bumps only when files may actually have changed (writes, edits, commands), not on reads, so a live preview
 * reloads when there's something new to show. */
export function fileChangeVersion(events: BatonEvent[]): number {
  const names = new Map<string, string>();
  let n = 0;
  for (const e of events) {
    if (e.type === "tool.call") names.set(e.payload.call_id, e.payload.name);
    else if (e.type === "human.edit" || e.type === "human.command_result") n++;
    else if (e.type === "tool.result" && !e.payload.cancelled) {
      const name = names.get(e.payload.call_id);
      if (name === "run_command" || ((name === "write_file" || name === "edit_file") && !e.payload.is_error)) n++;
    }
  }
  return n;
}

/** Folders that hold an index.html, most likely site first: build output, then public/, then anything else. */
export function siteRoots(paths: string[]): string[] {
  const rank = (d: string) => {
    const i = ["dist", "build", "out", "public", ""].indexOf(d);
    return i >= 0 ? i : 10 + d.split("/").length;
  };
  return paths
    .filter((p) => p === "index.html" || p.endsWith("/index.html"))
    .map((p) => p.slice(0, -"index.html".length).replace(/\/$/, ""))
    .sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
}

/** Marks for the scrubber track: where humans stepped in, decisions, errors. */
export function marks(events: BatonEvent[]) {
  return events
    .filter((e) =>
      [
        "human.message", "human.decision", "human.interrupt", "human.edit", "human.command", "agent.decision_point",
        "control.driver_changed", "session.error", "control.model_changed",
      ].includes(e.type),
    )
    .map((e) => ({ seq: e.seq, type: e.type, actor: e.actor, mode: e.payload.mode as string | undefined }));
}
