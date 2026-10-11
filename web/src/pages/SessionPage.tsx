import { Fragment, Suspense, lazy, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useLocation } from "wouter";
import clsx from "clsx";
import { ArrowDown, History, Loader2, Megaphone } from "lucide-react";
import { api } from "../lib/api";
import { useIdentity } from "../lib/identity";
import { connectSession, useSession, type ToolProgress } from "../lib/session";
import { compact } from "../lib/format";
import { buildItems, currentPlan, groupReads, openDecision } from "../lib/derive";
import type { BatonEvent, CatchUp, Participant, Session } from "../lib/types";
import { refreshSessions } from "../lib/sessions";
import { AgentAvatar } from "../components/Avatar";
import { StatusDot } from "../components/StatusPill";
import { Button } from "../components/Button";
import { toast } from "../components/Toasts";
import { SessionHeader } from "../session/Header";
import { Composer } from "../session/Composer";
import { Scrubber } from "../session/Scrubber";
import { RightPanel } from "../session/RightPanel";
import { CatchUpModal, useCatchUp } from "../session/CatchUp";
import { AgentText, ThinkingItem, TimelineItem, type Ctx } from "../session/items";
import { resetCode, setView, useCode } from "../session/code/store";

// The editor is the heaviest part of the app; load it the first time someone opens the code view.
const CodeView = lazy(() => import("../session/code/CodeView"));

export function SessionPage({ id }: { id: string }) {
  const me = useIdentity((s) => s.user!.id);
  const [, navigate] = useLocation();
  const [initialCard, setInitialCard] = useState<CatchUp | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [showCatchUp, setShowCatchUp] = useState<false | "join" | "handoff">(false);
  const [handoffFrom, setHandoffFrom] = useState("");
  const [openThread, setOpenThread] = useState<number | null>(null);
  const [highlight, setHighlight] = useState<number | null>(null);
  const [atBottom, setAtBottom] = useState(true);
  const scroller = useRef<HTMLDivElement>(null);
  const [liveSince] = useState(() => Date.now() / 1000 + 1);
  const [newSince, setNewSince] = useState<number | null>(null); // last step this person saw before coming back

  const { session, events, participants, partial, conn, replayed, viewSeq, setViewSeq, send } = useSession();
  const view = useCode((s) => s.view);

  useEffect(() => resetCode(id), [id]);

  useEffect(() => {
    let disconnect: (() => void) | undefined;
    let alive = true;
    const role = new URLSearchParams(location.search).get("role");
    api
      .session(id, me)
      .then((r) => {
        if (!alive) return;
        setInitialCard(r.catchup);
        disconnect = connectSession(id, me, role, r.comments);
        const isCreator = r.session.created_by === me;
        const stale = r.catchup.since_seq === undefined || (r.catchup.new_events ?? 0) >= (isCreator ? 12 : 6);
        if (stale && r.session.head_seq > 4) setShowCatchUp("join");
        const seen = r.catchup.since_seq;
        if (seen && (r.catchup.new_events ?? 0) >= 3) setNewSince(seen);
      })
      .catch(() => alive && setNotFound(true));
    return () => {
      alive = false;
      disconnect?.();
    };
  }, [id, me]);

  const liveCard = useCatchUp(id, me, events.length ? events[events.length - 1].seq : 0);
  const card = liveCard || initialCard;

  const people = useMemo(() => Object.fromEntries(participants.map((p) => [p.user_id, p])) as Record<string, Participant>, [participants]);
  const visible = useMemo(() => (viewSeq === null ? events : events.filter((e) => e.seq <= viewSeq)), [events, viewSeq]);
  const comments = useSession((s) => s.comments);
  const items = useMemo(() => {
    // Steps someone commented on, or that a jump points at, stay visible on their own.
    const keep = new Set(Object.values(comments).map((c) => c.event_seq));
    if (highlight) keep.add(highlight);
    if (openThread) keep.add(openThread);
    return groupReads(buildItems(visible), keep);
  }, [visible, comments, highlight, openThread]);
  const decision = useMemo(() => openDecision(events), [events]);
  const isDriver = session?.driver_id === me;
  const live = viewSeq === null;

  const [modelOfTurn, providerOfTurn] = useMemo(() => {
    const m: Record<number, string> = {};
    const p: Record<number, string> = {};
    for (const e of events) {
      if (e.type === "agent.turn") {
        m[e.payload.turn] = e.payload.model;
        p[e.payload.turn] = e.payload.provider;
      }
    }
    return [m, p];
  }, [events]);

  // Which step each other person is looking at, snapped to a rendered item.
  const focusBySeq = useMemo(() => {
    const out: Record<number, Participant[]> = {};
    const rowKinds = new Set(["text", "tool", "plan", "decision", "finish", "human", "edit", "command"]);
    const seqs = items.filter((it) => rowKinds.has(it.kind)).map((it) => (it.kind === "decision" ? it.point?.seq ?? it.seq : it.seq));
    for (const p of participants) {
      if (p.user_id === me || !p.online) continue;
      const f = p.viewing_seq ?? p.focus_seq;
      if (f == null) continue;
      let best: number | null = null;
      for (const s of seqs) if (s <= f && (best === null || s > best)) best = s;
      if (best !== null) (out[best] ||= []).push(p);
    }
    return out;
  }, [participants, items, me]);

  const ctx: Ctx = {
    me,
    liveSince,
    focusBySeq,
    modelOfTurn,
    providerOfTurn,
    isDriver,
    driverId: session?.driver_id ?? null,
    people,
    live,
    send,
    openThread,
    setOpenThread,
    highlight,
  };

  const jump = useCallback(
    (seq: number) => {
      if (viewSeq !== null && seq > viewSeq) setViewSeq(null);
      // Highlight first: it also unfolds a collapsed group that contains the step.
      setHighlight(seq);
      window.setTimeout(() => {
        const el = document.getElementById(`ev-${seq}`) || nearest(seq);
        el?.scrollIntoView({ behavior: "smooth", block: "center" });
      }, 60);
      window.setTimeout(() => setHighlight((h) => (h === seq ? null : h)), 2000);
    },
    [viewSeq, setViewSeq],
  );

  useEffect(() => {
    const onJump = (e: Event) => {
      const { seq, openThread: open } = (e as CustomEvent<{ seq: number; openThread: boolean }>).detail;
      if (open) setOpenThread(seq);
      jump(seq);
    };
    window.addEventListener("baton:jump", onJump);
    return () => window.removeEventListener("baton:jump", onJump);
  }, [jump]);

  // Stick to the bottom while live, unless the reader scrolled up.
  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && live && atBottom) el.scrollTop = el.scrollHeight;
  }, [items.length, partial.text, partial.thinking, live, atBottom, replayed, !!session, view]); // view: back from the code view

  // Tell others which step I'm reading (null while following live at the bottom).
  const focusTimer = useRef<number | undefined>(undefined);
  const lastFocus = useRef<number | null>(null);
  const reportFocus = (el: HTMLElement, bottom: boolean) => {
    window.clearTimeout(focusTimer.current);
    focusTimer.current = window.setTimeout(() => {
      let seq: number | null = null;
      if (!bottom) {
        const mid = el.getBoundingClientRect().top + el.clientHeight * 0.4;
        let bestDist = Infinity;
        el.querySelectorAll<HTMLElement>("[data-seq]").forEach((n) => {
          const r = n.getBoundingClientRect();
          const d = r.top <= mid && r.bottom >= mid ? 0 : Math.min(Math.abs(r.top - mid), Math.abs(r.bottom - mid));
          if (d < bestDist) {
            bestDist = d;
            seq = Number(n.dataset.seq);
          }
        });
      }
      if (seq !== lastFocus.current) {
        lastFocus.current = seq;
        send({ type: "focus", seq });
      }
    }, 200);
  };

  // Follow my own actions, and the moments that need me, even if I had scrolled up.
  // Look at every event that arrived since the last render, not just the newest one.
  const lastEv = events[events.length - 1];
  const handled = useRef(0);
  useEffect(() => {
    if (!lastEv) return;
    if (!replayed) {
      handled.current = lastEv.seq;
      return;
    }
    const fresh = events.filter((e) => e.seq > handled.current);
    handled.current = lastEv.seq;
    if (!live || !fresh.length) return;
    let follow = false;
    for (const e of fresh) {
      if (e.type === "control.driver_changed" && e.payload.to === me && e.actor !== me) {
        // Handing off the baton comes with a catch-up for the new driver.
        setHandoffFrom(participants.find((p) => p.user_id === e.actor)?.name || "A teammate");
        setShowCatchUp("handoff");
      }
      if (e.actor === me || (e.type === "agent.decision_point" && session?.driver_id === me) || (e.type === "control.driver_changed" && e.payload.to === me)) {
        follow = true;
      }
    }
    if (follow) {
      setAtBottom(true);
      requestAnimationFrame(() => {
        const el = scroller.current;
        if (el) el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lastEv?.seq, replayed]);

  // While scrubbing, keep the step being inspected in view.
  useEffect(() => {
    if (viewSeq === null) return;
    const el = document.getElementById(`ev-${viewSeq}`) || nearest(viewSeq);
    el?.scrollIntoView({ block: "end" });
  }, [viewSeq]);

  // The tab title flags work that's waiting on you, and counts steps you missed while away.
  const [hiddenAt, setHiddenAt] = useState<number | null>(null);
  useEffect(() => {
    const onVis = () => setHiddenAt(document.hidden ? useSession.getState().lastSeq : null);
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, []);
  const unseen = hiddenAt === null ? 0 : events.filter((e) => e.seq > hiddenAt && VISIBLE_TYPES.has(e.type)).length;
  useEffect(() => {
    if (!session) return;
    const waitingOnMe = !!decision && session.driver_id === me;
    document.title = `${unseen ? `(${unseen}) ` : ""}${waitingOnMe ? "● Decision needed · " : ""}${session.title} · Baton`;
    return () => {
      document.title = "Baton";
    };
  }, [session, decision, me, unseen]);

  // Esc interrupts (driver only), unless you're mid-sentence somewhere.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented || !isDriver || session?.status !== "running" || showCatchUp) return;
      const t = e.target as HTMLElement;
      if ((t.tagName === "TEXTAREA" || t.tagName === "INPUT") && (t as HTMLInputElement).value) return;
      if (t.closest?.(".cm-editor")) return; // Esc in the code editor closes its search or completions

      send({ type: "interrupt" });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [isDriver, session?.status, showCatchUp, send]);

  const fork = async (seq: number) => {
    try {
      const s = await api.fork(id, seq, me);
      refreshSessions();
      toast(`Forked at step #${s.fork_seq}. You're driving the new branch.`, "baton");
      navigate(`/s/${s.id}`);
    } catch (e) {
      toast((e as Error).message, "error");
    }
  };

  if (notFound) {
    return (
      <div className="grid flex-1 place-items-center text-center">
        <div>
          <p className="text-sm font-medium">This session doesn't exist.</p>
          <Button className="mt-3" onClick={() => navigate("/")}>
            Back to sessions
          </Button>
        </div>
      </div>
    );
  }
  if (!session) {
    return (
      <div className="grid flex-1 place-items-center">
        <Loader2 className="size-5 animate-spin text-ink-4" />
      </div>
    );
  }

  const pendingTool = items.some((it) => it.kind === "tool" && !it.result);
  const drafting = live && partial.turn !== null && partial.tool ? partial.tool : null;
  const streaming = live && partial.turn !== null && (partial.text || partial.thinking);
  const working = live && session.status === "running" && !streaming && !pendingTool && !drafting;
  const driverName = session.driver_id ? people[session.driver_id]?.name : undefined;
  const codeView = view === "code" && session.provider !== "external";

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <SessionHeader
        session={session}
        participants={participants}
        me={me}
        hasDecision={!!decision}
        send={send}
        conn={conn}
        onCatchUp={() => setShowCatchUp("join")}
        view={codeView ? "code" : "timeline"}
        onView={setView}
      />
      {!codeView && <MobileStatus session={session} events={events} decision={decision} card={card} onOpen={() => setShowCatchUp("join")} />}
      {codeView ? (
        <Suspense
          fallback={
            <div className="grid flex-1 place-items-center">
              <Loader2 className="size-5 animate-spin text-ink-4" />
            </div>
          }
        >
          <CodeView session={session} events={events} participants={participants} me={me} onJump={jump} />
        </Suspense>
      ) : (
        <div className="flex min-h-0 flex-1">
          <div className="flex min-w-0 flex-1 flex-col">
            {!live && (
              <div className="flex items-center gap-2 border-b border-attn/30 bg-attn-soft px-4 py-1.5 text-xs text-ink-2">
                <History className="size-3.5 text-attn" />
                Viewing the session as it was at step #{viewSeq}. New activity keeps arriving in the background.
              </div>
            )}
            <div
              ref={scroller}
              className="min-h-0 flex-1 overflow-y-auto"
              onScroll={(e) => {
                const el = e.currentTarget;
                const bottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
                setAtBottom(bottom);
                reportFocus(el, bottom);
              }}
            >
              <div className="mx-auto w-full max-w-[760px] pt-8 pr-12 pb-6 pl-4 sm:pr-16 sm:pl-6">
                <div className="space-y-3.5">
                  {items.map((it, i) => (
                    <Fragment key={`${it.kind}-${it.seq}`}>
                      {newSince !== null && it.seq > newSince && (i === 0 || items[i - 1].seq <= newSince) && (
                        <div className="flex items-center gap-3 py-1 text-[11px] font-medium tracking-wide text-baton uppercase">
                          <span className="h-px flex-1 bg-baton/40" />
                          New since you were last here
                          <span className="h-px flex-1 bg-baton/40" />
                        </div>
                      )}
                      <TimelineItem item={it} ctx={ctx} events={events} />
                    </Fragment>
                  ))}
                  {streaming && partial.thinking && !partial.text && <ThinkingItem streaming={partial.thinking} />}
                  {streaming && partial.text && <AgentText streaming={partial.text} model={session.model} provider={session.provider} />}
                  {drafting && <Drafting tool={drafting} />}
                  {working && (
                    <div className="flex items-center gap-3 py-1">
                      <AgentAvatar size={22} provider={session.provider} />
                      <span className="shimmer-text text-[13.5px] font-medium">Thinking</span>
                    </div>
                  )}
                  {live && session.status === "waiting_input" && !decision && items.length > 1 && (
                    <p className="pl-[34px] text-xs text-ink-4">
                      The agent is waiting. {isDriver ? "Send a message to steer it, or press Resume." : `${driverName || "The driver"} can steer it next.`}
                    </p>
                  )}
                </div>
              </div>
            </div>
            {live && !atBottom && (
              <div className="pointer-events-none relative">
                <button
                  onClick={() => {
                    const el = scroller.current;
                    if (el) el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
                  }}
                  className="pointer-events-auto absolute -top-12 right-8 inline-flex items-center gap-1.5 rounded-full border border-line bg-raised px-3 py-1.5 text-xs font-medium shadow-md hover:bg-sunken"
                >
                  <ArrowDown className="size-3.5" /> Latest
                </button>
              </div>
            )}
            <div className="mx-auto w-full max-w-[760px] px-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] sm:px-6 sm:pb-4 md:pr-16">
              <Composer session={session} me={me} participants={participants} hasDecision={!!decision} send={send} />
            </div>
            <div className="hidden sm:block">
              <Scrubber events={events} viewSeq={viewSeq} setViewSeq={setViewSeq} participants={participants} me={me} onFork={fork} />
            </div>
          </div>
          <RightPanel session={session} events={events} participants={participants} card={card} ctx={ctx} onJump={jump} />
        </div>
      )}
      {showCatchUp && card && (
        <CatchUpModal
          card={card}
          people={participants}
          driverName={driverName}
          handoff={showCatchUp === "handoff" ? handoffFrom : undefined}
          onClose={() => setShowCatchUp(false)}
          onJump={jump}
        />
      )}
    </div>
  );
}

/**
 * Phones don't have room for the overview panel, so a one-line strip says what the agent is doing and how far
 * along the plan is. Tapping it opens the catch-up card.
 */
function MobileStatus({
  session,
  events,
  decision,
  card,
  onOpen,
}: {
  session: Session;
  events: BatonEvent[];
  decision: BatonEvent | null;
  card: CatchUp | null;
  onOpen: () => void;
}) {
  const plan = useMemo(() => currentPlan(events), [events]);
  const done = plan.filter((s) => s.status === "done").length;
  const current = plan.find((s) => s.status === "in_progress");
  const text = decision
    ? `Waiting on a decision: ${decision.payload.question}`
    : session.status === "done"
      ? "Finished"
      : current?.title || card?.doing || "Getting started";
  return (
    <button onClick={onOpen} className="flex shrink-0 items-center gap-2.5 border-b border-line bg-panel px-3 py-2 text-left lg:hidden">
      <StatusDot status={session.status} />
      <span className={clsx("min-w-0 flex-1 truncate text-[12.5px]", decision ? "font-medium text-attn" : "text-ink-2")}>{text}</span>
      {plan.length > 0 && (
        <span className="flex shrink-0 items-center gap-1.5">
          <span className="h-1 w-12 overflow-hidden rounded-full bg-sunken">
            <span className="block h-full rounded-full bg-ink transition-all duration-500" style={{ width: `${(done / plan.length) * 100}%` }} />
          </span>
          <span className="tnum text-[11px] text-ink-4">
            {done}/{plan.length}
          </span>
        </span>
      )}
      {session.config?.open_floor && (
        <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-live/10 px-1.5 py-0.5 text-[10.5px] font-medium text-live">
          <Megaphone className="size-3" /> Open
        </span>
      )}
    </button>
  );
}

/** The model is still writing out a tool call, e.g. a whole file. Show what, and how much so far. */
function Drafting({ tool }: { tool: ToolProgress }) {
  const verb: Record<string, string> = { write_file: "Writing", edit_file: "Editing", run_command: "Preparing", read_file: "Opening" };
  return (
    <div className="pl-[34px]">
      <div className="flex h-9 items-center gap-2.5 rounded-lg border border-dashed border-line-strong bg-panel px-3">
        <Loader2 className="size-3.5 animate-spin text-ink-3" />
        <span className="shimmer-text shrink-0 text-[13px] font-medium">{verb[tool.name] || `Preparing ${tool.name}`}</span>
        <span className="min-w-0 flex-1 truncate font-mono text-[12.5px] text-ink-2">{tool.target}</span>
        {tool.chars > 0 && <span className="tnum shrink-0 text-[11.5px] text-ink-4">{compact(tool.chars)} chars</span>}
      </div>
    </div>
  );
}

const VISIBLE_TYPES = new Set(["agent.text", "tool.call", "human.message", "agent.decision_point", "control.driver_changed", "session.error"]);

function nearest(seq: number): HTMLElement | null {
  const all = Array.from(document.querySelectorAll<HTMLElement>("[data-seq], [id^='ev-']"));
  let best: HTMLElement | null = null;
  let bestSeq = -1;
  for (const el of all) {
    const s = Number(el.dataset.seq ?? el.id.replace("ev-", ""));
    if (s <= seq && s > bestSeq) {
      best = el;
      bestSeq = s;
    }
  }
  return best;
}
