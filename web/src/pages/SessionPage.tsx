import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useLocation } from "wouter";
import { ArrowDown, History, Loader2 } from "lucide-react";
import { api } from "../lib/api";
import { useIdentity } from "../lib/identity";
import { connectSession, useSession } from "../lib/session";
import { buildItems, openDecision } from "../lib/derive";
import type { CatchUp, Participant } from "../lib/types";
import { refreshSessions } from "../lib/sessions";
import { AgentAvatar } from "../components/Avatar";
import { Button } from "../components/Button";
import { toast } from "../components/Toasts";
import { SessionHeader } from "../session/Header";
import { Composer } from "../session/Composer";
import { Scrubber } from "../session/Scrubber";
import { RightPanel } from "../session/RightPanel";
import { CatchUpModal, useCatchUp } from "../session/CatchUp";
import { AgentText, ThinkingItem, TimelineItem, type Ctx } from "../session/items";

export function SessionPage({ id }: { id: string }) {
  const me = useIdentity((s) => s.user!.id);
  const [, navigate] = useLocation();
  const [initialCard, setInitialCard] = useState<CatchUp | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [showCatchUp, setShowCatchUp] = useState<false | "join" | "handoff">(false);
  const [openThread, setOpenThread] = useState<number | null>(null);
  const [highlight, setHighlight] = useState<number | null>(null);
  const [atBottom, setAtBottom] = useState(true);
  const scroller = useRef<HTMLDivElement>(null);

  const { session, events, participants, partial, conn, replayed, viewSeq, setViewSeq, send } = useSession();

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
      })
      .catch(() => alive && setNotFound(true));
    return () => {
      alive = false;
      disconnect?.();
    };
  }, [id, me]);

  const liveCard = useCatchUp(id, me, session?.head_seq ?? 0);
  const card = liveCard || initialCard;

  const people = useMemo(() => Object.fromEntries(participants.map((p) => [p.user_id, p])) as Record<string, Participant>, [participants]);
  const visible = useMemo(() => (viewSeq === null ? events : events.filter((e) => e.seq <= viewSeq)), [events, viewSeq]);
  const items = useMemo(() => buildItems(visible), [visible]);
  const decision = useMemo(() => openDecision(events), [events]);
  const isDriver = session?.driver_id === me;
  const live = viewSeq === null;

  const modelOfTurn = useMemo(() => {
    const m: Record<number, string> = {};
    for (const e of events) if (e.type === "agent.turn") m[e.payload.turn] = e.payload.model;
    return m;
  }, [events]);

  const ctx: Ctx = {
    me,
    modelOfTurn,
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
      window.setTimeout(() => {
        const el = document.getElementById(`ev-${seq}`) || nearest(seq);
        el?.scrollIntoView({ behavior: "smooth", block: "center" });
        setHighlight(seq);
        window.setTimeout(() => setHighlight(null), 1800);
      }, 30);
    },
    [viewSeq, setViewSeq],
  );

  // Stick to the bottom while live, unless the reader scrolled up.
  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && live && atBottom) el.scrollTop = el.scrollHeight;
  }, [items.length, partial.text, partial.thinking, live, atBottom, replayed, !!session]);

  // Follow my own actions, and the moments that need me, even if I had scrolled up.
  const lastEv = events[events.length - 1];
  useEffect(() => {
    if (!lastEv || !replayed || !live) return;
    const needsMe =
      (lastEv.type === "agent.decision_point" && session?.driver_id === me) ||
      (lastEv.type === "control.driver_changed" && lastEv.payload.to === me);
    // Handing off the baton comes with a catch-up for the new driver.
    if (lastEv.type === "control.driver_changed" && lastEv.payload.to === me && lastEv.actor !== me) setShowCatchUp("handoff");
    if (lastEv.actor === me || needsMe) {
      setAtBottom(true);
      requestAnimationFrame(() => {
        const el = scroller.current;
        if (el) el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lastEv?.seq]);

  // While scrubbing, keep the step being inspected in view.
  useEffect(() => {
    if (viewSeq === null) return;
    const el = document.getElementById(`ev-${viewSeq}`) || nearest(viewSeq);
    el?.scrollIntoView({ block: "end" });
  }, [viewSeq]);

  // The tab title flags work that's waiting on you.
  useEffect(() => {
    if (!session) return;
    const waitingOnMe = !!decision && session.driver_id === me;
    document.title = `${waitingOnMe ? "● Decision needed · " : ""}${session.title} · Baton`;
    return () => {
      document.title = "Baton";
    };
  }, [session, decision, me]);

  // Esc interrupts (driver only), unless you're mid-sentence somewhere.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || !isDriver || session?.status !== "running" || showCatchUp) return;
      const t = e.target as HTMLElement;
      if ((t.tagName === "TEXTAREA" || t.tagName === "INPUT") && (t as HTMLInputElement).value) return;
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
  const streaming = live && partial.turn !== null && (partial.text || partial.thinking);
  const working = live && session.status === "running" && !streaming && !pendingTool;
  const driverName = session.driver_id ? people[session.driver_id]?.name : undefined;

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
      />
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
              setAtBottom(el.scrollHeight - el.scrollTop - el.clientHeight < 80);
            }}
          >
            <div className="mx-auto w-full max-w-[760px] px-6 pt-8 pb-6 md:pr-16">
              <div className="space-y-3.5">
                {items.map((it) => (
                  <TimelineItem key={`${it.kind}-${it.seq}`} item={it} ctx={ctx} events={events} />
                ))}
                {streaming && partial.thinking && !partial.text && <ThinkingItem streaming={partial.thinking} />}
                {streaming && partial.text && <AgentText streaming={partial.text} model={session.model} />}
                {working && (
                  <div className="flex items-center gap-3 py-1">
                    <AgentAvatar size={22} />
                    <span className="shimmer-text text-[13.5px] font-medium">Working</span>
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
          <div className="mx-auto w-full max-w-[760px] px-6 pb-4 md:pr-16">
            <Composer session={session} me={me} participants={participants} hasDecision={!!decision} send={send} />
          </div>
          <Scrubber events={events} viewSeq={viewSeq} setViewSeq={setViewSeq} participants={participants} me={me} onFork={fork} />
        </div>
        <RightPanel session={session} events={events} participants={participants} card={card} ctx={ctx} onJump={jump} />
      </div>
      {showCatchUp && card && (
        <CatchUpModal
          card={card}
          people={participants}
          driverName={driverName}
          handoff={showCatchUp === "handoff" ? people[lastEv?.actor ?? ""]?.name || "A teammate" : undefined}
          onClose={() => setShowCatchUp(false)}
          onJump={jump}
        />
      )}
    </div>
  );
}

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
