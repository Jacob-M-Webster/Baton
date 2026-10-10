import { useMemo } from "react";
import clsx from "clsx";
import { GitFork, Radio } from "lucide-react";
import type { BatonEvent, Participant } from "../lib/types";
import { marks } from "../lib/derive";
import { clock } from "../lib/format";
import { Avatar } from "../components/Avatar";
import { Button } from "../components/Button";

export function Scrubber({
  events,
  viewSeq,
  setViewSeq,
  participants,
  me,
  onFork,
}: {
  events: BatonEvent[];
  viewSeq: number | null;
  setViewSeq: (s: number | null) => void;
  participants: Participant[];
  me: string;
  onFork: (seq: number) => void;
}) {
  const head = events.length ? events[events.length - 1].seq : 0;
  const value = viewSeq ?? head;
  const ms = useMemo(() => marks(events), [events]);
  const colorOf = (id: string) => participants.find((p) => p.user_id === id)?.color || "var(--ink-3)";
  const pos = (seq: number) => (head <= 1 ? 100 : ((seq - 1) / (head - 1)) * 100);
  const at = events.find((e) => e.seq === value);
  const watchers = participants.filter((p) => p.user_id !== me && p.online && p.viewing_seq !== null);
  if (head < 2) return null;

  return (
    <div className="flex items-center gap-3 border-t border-line bg-panel px-4 py-2">
      <div className="w-[150px] shrink-0">
        {viewSeq === null ? (
          <span className="inline-flex items-center gap-1.5 text-xs font-medium text-live">
            <Radio className="size-3.5" /> Live
            <span className="tnum font-normal text-ink-4">· {head} events</span>
          </span>
        ) : (
          <span className="tnum text-xs text-ink-2">
            <span className="font-medium">Step #{value}</span>
            <span className="text-ink-4"> · {at ? clock(at.ts) : ""}</span>
          </span>
        )}
      </div>
      <div className="relative min-w-0 flex-1">
        <div className="absolute inset-x-0 top-1/2 h-[3px] -translate-y-1/2 rounded-full bg-sunken" />
        <div className="absolute top-1/2 left-0 h-[3px] -translate-y-1/2 rounded-full bg-line-strong" style={{ width: `${pos(value)}%` }} />
        {ms.map((m) => (
          <span
            key={m.seq}
            title={m.type}
            className={clsx(
              "absolute top-1/2 -translate-x-1/2 -translate-y-1/2 rounded-full",
              m.type === "agent.decision_point" ? "h-3 w-1.5 rounded-sm bg-attn" : m.type === "session.error" ? "size-2 bg-danger" : "size-2",
            )}
            style={{
              left: `${pos(m.seq)}%`,
              background: m.type.startsWith("human") || m.type.startsWith("control") ? colorOf(m.actor) : undefined,
              opacity: m.mode === "suggest" ? 0.45 : 1,
            }}
          />
        ))}
        {watchers.map((p) => (
          <span key={p.user_id} className="absolute -top-3.5 -translate-x-1/2" style={{ left: `${pos(p.viewing_seq!)}%` }} title={`${p.name} is looking at step #${p.viewing_seq}`}>
            <Avatar name={p.name} color={p.color} size={14} />
          </span>
        ))}
        <input
          type="range"
          className="scrubber outline-none"
          min={1}
          max={head}
          value={value}
          onChange={(e) => {
            const v = Number(e.target.value);
            setViewSeq(v >= head ? null : v);
          }}
          aria-label="Scrub through the session"
        />
      </div>
      <div className="flex w-[220px] shrink-0 justify-end gap-1.5">
        {viewSeq !== null ? (
          <>
            <Button size="sm" variant="ghost" onClick={() => onFork(value)}>
              <GitFork className="size-3" /> Fork from here
            </Button>
            <Button size="sm" onClick={() => setViewSeq(null)}>
              Back to live
            </Button>
          </>
        ) : (
          <span className="text-[11.5px] text-ink-4">Drag to rewind</span>
        )}
      </div>
    </div>
  );
}
