import { create } from "zustand";
import type { BatonEvent, Comment, Participant, Session } from "./types";
import { toast } from "../components/Toasts";

type Conn = "connecting" | "open" | "reconnecting" | "closed";
export type ToolProgress = { name: string; chars: number; target: string };

interface SessionState {
  sid: string | null;
  session: Session | null;
  events: BatonEvent[];
  lastSeq: number;
  replayed: boolean;
  participants: Participant[];
  comments: Record<string, Comment>;
  partial: { turn: number | null; text: string; thinking: string; tool?: ToolProgress | null };
  conn: Conn;
  catchupTick: number;
  viewSeq: number | null; // null = live
  setViewSeq: (seq: number | null) => void;
  send: (msg: Record<string, unknown>) => boolean;
}

export const useSession = create<SessionState>(() => ({
  sid: null,
  session: null,
  events: [],
  lastSeq: 0,
  replayed: false,
  participants: [],
  comments: {},
  partial: { turn: null, text: "", thinking: "" },
  conn: "closed",
  catchupTick: 0,
  viewSeq: null,
  setViewSeq: (seq) => {
    useSession.setState({ viewSeq: seq });
    socket?.raw({ type: "viewing", seq });
  },
  send: (msg) => socket?.raw(msg) ?? false,
}));

const set = useSession.setState;
const get = useSession.getState;

class SessionSocket {
  ws: WebSocket | null = null;
  closed = false;
  retry = 0;
  ping: number | undefined;
  seenTimer: number | undefined;
  pendingEvents: BatonEvent[] = [];
  flushQueued = false;

  constructor(
    public sid: string,
    public userId: string,
    public role: string | null,
  ) {}

  open() {
    const proto = location.protocol === "https:" ? "wss" : "ws";
    const q = new URLSearchParams({ user_id: this.userId });
    if (this.role) q.set("role", this.role);
    const ws = new WebSocket(`${proto}://${location.host}/api/sessions/${this.sid}/stream?${q}`);
    this.ws = ws;
    set({ conn: this.retry ? "reconnecting" : "connecting" });
    ws.onopen = () => {
      this.retry = 0;
      set({ conn: "open" });
      // Resume exactly where we left off: no gaps, no duplicates.
      ws.send(JSON.stringify({ type: "subscribe", from_seq: get().lastSeq }));
      const v = get().viewSeq;
      if (v !== null) ws.send(JSON.stringify({ type: "viewing", seq: v }));
    };
    ws.onmessage = (m) => this.handle(JSON.parse(m.data));
    ws.onclose = (e) => {
      if (this.ws !== ws) return;
      this.ws = null;
      if (this.closed || e.code === 4404) {
        set({ conn: "closed" });
        return;
      }
      set({ conn: "reconnecting" });
      const delay = Math.min(5000, 300 * 2 ** this.retry++);
      window.setTimeout(() => !this.closed && this.open(), delay);
    };
    window.clearInterval(this.ping);
    this.ping = window.setInterval(() => this.raw({ type: "ping" }), 25000);
  }

  close() {
    this.closed = true;
    window.clearInterval(this.ping);
    window.clearTimeout(this.seenTimer);
    this.ws?.close();
  }

  raw(msg: Record<string, unknown>) {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
      return true;
    }
    return false;
  }

  addEvents(evs: BatonEvent[]) {
    this.pendingEvents.push(...evs);
    if (!this.flushQueued) {
      this.flushQueued = true;
      queueMicrotask(() => this.flush());
    }
  }

  flush() {
    this.flushQueued = false;
    const incoming = this.pendingEvents;
    this.pendingEvents = [];
    const s = get();
    let last = s.lastSeq;
    const fresh = incoming.filter((e) => {
      if (e.seq <= last) return false;
      last = e.seq;
      return true;
    });
    if (!fresh.length) return;
    let partial = s.partial;
    // A persisted agent text replaces the streamed preview of the same turn.
    if (fresh.some((e) => (e.type === "agent.text" || e.type === "agent.thinking") && e.payload.turn === partial.turn)) {
      partial = { turn: null, text: "", thinking: "" };
    }
    set({ events: [...s.events, ...fresh], lastSeq: last, partial });
    if (s.replayed) {
      for (const e of fresh) notify(e, this.userId);
    }
    window.clearTimeout(this.seenTimer);
    this.seenTimer = window.setTimeout(() => this.raw({ type: "seen", seq: get().lastSeq }), 1500);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  handle(msg: any) {
    switch (msg.type) {
      case "events":
        this.addEvents(msg.events);
        break;
      case "event":
        this.addEvents([msg.event]);
        break;
      case "replay_done":
        this.flush();
        set({ replayed: true });
        break;
      case "session":
        set({ session: msg.session });
        break;
      case "presence":
        set({ participants: msg.participants });
        break;
      case "partial":
        set({ partial: { turn: msg.turn, text: msg.text || "", thinking: msg.thinking || "", tool: msg.tool ?? null } });
        break;
      case "tool_progress": {
        const p = get().partial;
        const base = p.turn === msg.turn ? p : { turn: msg.turn, text: "", thinking: "" };
        set({ partial: { ...base, tool: msg.tool } });
        break;
      }
      case "delta": {
        const p = get().partial;
        const base = p.turn === msg.turn ? p : { turn: msg.turn, text: "", thinking: "" };
        set({ partial: { ...base, [msg.kind]: base[msg.kind as "text" | "thinking"] + msg.text } });
        break;
      }
      case "comment": {
        const isNew = !get().comments[msg.comment.id];
        set({ comments: { ...get().comments, [msg.comment.id]: msg.comment } });
        const c = msg.comment;
        if (isNew && c.user_id !== this.userId) {
          const iDrive = get().session?.driver_id === this.userId;
          toast(
            `${c.author_name} commented on step #${c.event_seq}: “${c.body.length > 90 ? c.body.slice(0, 89) + "…" : c.body}”`,
            "info",
            undefined,
            { label: iDrive ? "View and send to agent" : "View", run: () => jumpTo(c.event_seq, true) },
          );
        }
        break;
      }
      case "catchup_updated":
        set({ catchupTick: get().catchupTick + 1 });
        break;
      case "error":
        toast(msg.message, "error");
        break;
    }
  }
}

let socket: SessionSocket | null = null;

/** Ask the session page to scroll to a step (and optionally open its comments). */
export function jumpTo(seq: number, openThread = false) {
  window.dispatchEvent(new CustomEvent("baton:jump", { detail: { seq, openThread } }));
}

export function connectSession(sid: string, userId: string, role: string | null, comments: Comment[]) {
  socket?.close();
  set({
    sid,
    session: null,
    events: [],
    lastSeq: 0,
    replayed: false,
    participants: [],
    comments: Object.fromEntries(comments.map((c) => [c.id, c])),
    partial: { turn: null, text: "", thinking: "" },
    viewSeq: null,
  });
  socket = new SessionSocket(sid, userId, role);
  socket.open();
  return () => {
    socket?.close();
    socket = null;
    set({ sid: null, conn: "closed" });
  };
}

function nameOf(id: string) {
  return get().participants.find((p) => p.user_id === id)?.name || "Someone";
}

/** Toasts for things that need a human's attention while they look elsewhere. */
function notify(e: BatonEvent, me: string) {
  const s = get().session;
  const iDrive = s?.driver_id === me;
  if (e.type === "control.driver_requested" && iDrive && e.actor !== me) {
    toast(`${nameOf(e.actor)} is asking for the baton`, "request", { userId: e.actor, seq: e.seq });
  } else if (e.type === "agent.decision_point" && iDrive) {
    toast("The agent needs your decision", "attn");
  } else if (e.type === "human.message" && e.payload.mode === "suggest" && iDrive && e.actor !== me) {
    toast(`${nameOf(e.actor)} suggested: ${e.payload.text}`, "info", undefined, { label: "View", run: () => jumpTo(e.seq) });
  }
}
