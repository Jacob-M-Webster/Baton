import { useEffect, useState } from "react";
import clsx from "clsx";
import { ArrowRight, Hand, Sparkles, X } from "lucide-react";
import type { CatchUp, Participant } from "../lib/types";
import { api } from "../lib/api";
import { modelLabel } from "../lib/format";
import { useSession } from "../lib/session";
import { Avatar } from "../components/Avatar";
import { InlineMd } from "../components/Markdown";
import { Button } from "../components/Button";
import { BatonMark } from "../components/Logo";

export function useCatchUp(sid: string, me: string, headSeq: number) {
  const tick = useSession((s) => s.catchupTick);
  const [card, setCard] = useState<CatchUp | null>(null);
  // Refresh when the server says a fresh summary exists, and every few events.
  const bucket = Math.floor(headSeq / 4);
  useEffect(() => {
    let alive = true;
    api
      .catchup(sid, me)
      .then((c) => alive && setCard(c))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [sid, me, tick, bucket]);
  return card;
}

function Section({ label, children, className }: { label: string; children: React.ReactNode; className?: string }) {
  return (
    <div className={className}>
      <div className="mb-1.5 text-[11px] font-medium tracking-wide text-ink-4 uppercase">{label}</div>
      {children}
    </div>
  );
}

export function CatchUpBody({
  card,
  people,
  onJump,
  compact,
}: {
  card: CatchUp;
  people: Participant[];
  onJump?: (seq: number) => void;
  compact?: boolean;
}) {
  const colorOf = (name: string) => people.find((p) => p.name === name)?.color || "#71717a";
  // Returning visitors see only what changed while they were away.
  const sinceYouLeft = card.since_seq && card.new_interventions ? card.new_interventions : [];
  return (
    <div className={clsx("space-y-4", compact && "space-y-3.5")}>
      <Section label="Doing now">
        <p className={clsx("leading-snug text-ink", compact ? "text-[13.5px]" : "text-[15px] font-medium")}>
          <InlineMd text={card.doing} />
        </p>
      </Section>
      {card.questions.length > 0 && (
        <button
          onClick={() => onJump?.(card.questions[0].seq)}
          className="flex w-full items-start gap-2 rounded-lg border border-attn/40 bg-attn-soft px-3 py-2 text-left"
        >
          <Hand className="mt-0.5 size-3.5 shrink-0 text-attn" />
          <span className="text-[13px] leading-snug">
            <span className="font-medium text-attn">Open question: </span>
            <span className="text-ink">{card.questions[0].question}</span>
          </span>
        </button>
      )}
      <div className={clsx("grid gap-4", !compact && card.done.length > 0 && card.next.length > 0 && "sm:grid-cols-2")}>
        {card.done.length > 0 && (
          <Section label="Done">
            <ul className="space-y-1">
              {card.done.map((d, i) => (
                <li key={i} className="flex gap-2 text-[13px] leading-snug text-ink-2">
                  <span className="mt-[7px] size-1 shrink-0 rounded-full bg-ink-4" />
                  <span>
                    <InlineMd text={d} />
                  </span>
                </li>
              ))}
            </ul>
          </Section>
        )}
        {card.next.length > 0 && (
          <Section label="Next">
            <ul className="space-y-1">
              {card.next.map((d, i) => (
                <li key={i} className="flex gap-2 text-[13px] leading-snug text-ink-2">
                  <span className="mt-[7px] size-1 shrink-0 rounded-full border border-ink-4" />
                  <span>
                    <InlineMd text={d} />
                  </span>
                </li>
              ))}
            </ul>
          </Section>
        )}
      </div>
      {(sinceYouLeft.length > 0 || card.changed.length > 0) && (
        <Section label={sinceYouLeft.length ? "Since you left" : "What people changed"}>
          <ul className="space-y-1.5">
            {(sinceYouLeft.length ? sinceYouLeft : card.changed).map((c) => (
              <li key={c.seq}>
                <button onClick={() => onJump?.(c.seq)} className="flex w-full items-start gap-2 text-left text-[13px] leading-snug hover:text-ink">
                  <Avatar name={c.who} color={colorOf(c.who)} size={16} className="mt-px" />
                  <span className="text-ink-2">
                    <span className="font-medium text-ink">{c.who}</span> {c.what}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </Section>
      )}
    </div>
  );
}

export function CatchUpModal({
  card,
  people,
  onClose,
  onJump,
  driverName,
  handoff,
}: {
  card: CatchUp;
  people: Participant[];
  onClose: () => void;
  onJump: (seq: number) => void;
  driverName?: string;
  handoff?: string;
}) {
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [onClose]);
  const fresh = card.new_events && card.since_seq ? card.new_events : 0;
  return (
    <div className="fixed inset-0 z-40 grid place-items-center bg-black/25 p-4 backdrop-blur-[1.5px]" onMouseDown={onClose}>
      <div
        onMouseDown={(e) => e.stopPropagation()}
        className="animate-rise w-full max-w-[600px] overflow-hidden rounded-2xl border border-line bg-raised shadow-[0_32px_80px_-24px_rgb(0_0_0/0.45)]"
      >
        <div className="flex items-start gap-3 border-b border-line px-6 pt-5 pb-4">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 text-xs font-medium text-baton">
              {handoff ? (
                <>
                  <BatonMark className="size-3.5" /> {handoff} handed you the baton
                </>
              ) : (
                <>
                  <Sparkles className="size-3.5" /> Catch up
                </>
              )}
            </div>
            <h2 className="mt-1.5 text-[17px] leading-snug font-semibold tracking-tight text-ink">{card.goal}</h2>
            <p className="mt-1 text-xs text-ink-3">
              {fresh ? `${fresh} new events since you last looked` : `${card.head_seq} events so far`}
              {handoff ? " · you're driving now" : driverName ? ` · ${driverName} is driving` : ""}
            </p>
          </div>
          <button onClick={onClose} className="rounded-md p-1 text-ink-4 hover:bg-sunken hover:text-ink" aria-label="Close">
            <X className="size-4" />
          </button>
        </div>
        <div className="max-h-[60vh] overflow-y-auto px-6 py-5">
          <CatchUpBody
            card={card}
            people={people}
            onJump={(s) => {
              onJump(s);
              onClose();
            }}
          />
        </div>
        <div className="flex items-center gap-2 border-t border-line bg-sunken/50 px-6 py-3">
          <span className="text-[11.5px] text-ink-4">
            {card.source === "log" ? "Built from the session log" : `Summarized by ${modelLabel(card.source)}`}
          </span>
          <Button variant="primary" className="ml-auto" onClick={onClose}>
            {handoff ? "Take it from here" : "Jump in"} <ArrowRight className="size-3.5" />
          </Button>
        </div>
      </div>
    </div>
  );
}
