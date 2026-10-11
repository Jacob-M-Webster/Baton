import { useLayoutEffect, useMemo, useRef } from "react";
import clsx from "clsx";
import { Check, FilePlus2, FileText, FolderTree, Hand, ListChecks, Loader2, PencilLine, SquareTerminal, X } from "lucide-react";
import type { BatonEvent, Participant, Session } from "../../lib/types";
import { buildItems, openDecision, type Item } from "../../lib/derive";
import { useSession } from "../../lib/session";
import { AgentAvatar, Avatar } from "../../components/Avatar";
import { Markdown } from "../../components/Markdown";
import { StatusPill } from "../../components/StatusPill";
import { Composer } from "../Composer";
import { setView } from "./store";

const FILE_TOOLS: Record<string, { icon: typeof FileText; verb: string }> = {
  read_file: { icon: FileText, verb: "Read" },
  write_file: { icon: FilePlus2, verb: "Wrote" },
  edit_file: { icon: PencilLine, verb: "Edited" },
  list_files: { icon: FolderTree, verb: "Listed" },
};

/** The agent, at a glance, next to the code: what it's doing, what it's asking, and a place to steer it. */
export function AgentPane({
  session,
  events,
  participants,
  me,
  onOpenFile,
}: {
  session: Session;
  events: BatonEvent[];
  participants: Participant[];
  me: string;
  onOpenFile: (path: string) => void;
}) {
  const partial = useSession((s) => s.partial);
  const send = useSession((s) => s.send);
  const people = useMemo(() => Object.fromEntries(participants.map((p) => [p.user_id, p])), [participants]);
  const items = useMemo(() => buildItems(events).slice(-40), [events]);
  const decision = useMemo(() => openDecision(events), [events]);
  const isDriver = session.driver_id === me;
  const scroller = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const el = scroller.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [items.length, partial.text, decision?.seq]);

  return (
    <aside className="hidden w-[330px] shrink-0 flex-col border-l border-line bg-canvas xl:flex">
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-line bg-panel px-3">
        <span className="text-[11px] font-medium tracking-wide text-ink-4 uppercase">Agent</span>
        <StatusPill status={session.status} decision={!!decision} />
        <button onClick={() => setView("timeline")} className="ml-auto text-[11.5px] text-ink-3 hover:text-ink">
          Full timeline
        </button>
      </div>
      <div ref={scroller} className="min-h-0 flex-1 space-y-2.5 overflow-y-auto px-3 py-3">
        {items.map((it) => (
          <FeedItem key={`${it.kind}-${it.seq}`} item={it} people={people} provider={session.provider} onOpenFile={onOpenFile} />
        ))}
        {partial.turn !== null && partial.text && (
          <div className="flex gap-2">
            <AgentAvatar size={18} provider={session.provider} />
            <div className="min-w-0 flex-1 text-[12.5px] leading-relaxed text-ink">
              <Markdown text={partial.text} caret />
            </div>
          </div>
        )}
        {decision && (
          <div className="rounded-lg border border-attn/45 bg-attn-soft/60 px-3 py-2.5">
            <div className="flex items-center gap-1.5 text-[11.5px] font-medium text-attn">
              <Hand className="size-3" /> Decision needed
            </div>
            <p className="mt-1 text-[13px] leading-snug font-medium text-ink">{decision.payload.question}</p>
            <div className="mt-2 flex flex-col gap-1">
              {(decision.payload.options as string[] | undefined)?.map((o) => (
                <button
                  key={o}
                  disabled={!isDriver}
                  onClick={() => send({ type: "answer_decision", seq: decision.seq, answer: o })}
                  className="rounded-md border border-line bg-panel px-2.5 py-1.5 text-left text-[12.5px] text-ink-2 enabled:hover:border-ink-3 enabled:hover:text-ink disabled:opacity-60"
                >
                  {o}
                </button>
              ))}
            </div>
            {!isDriver && <p className="mt-1.5 text-[11.5px] text-ink-3">Waiting on {people[session.driver_id || ""]?.name || "the driver"}.</p>}
          </div>
        )}
      </div>
      <div className="shrink-0 border-t border-line bg-canvas px-2.5 pt-1 pb-2.5">
        <Composer session={session} me={me} participants={participants} hasDecision={!!decision} send={send} compact />
      </div>
    </aside>
  );
}

function FeedItem({
  item,
  people,
  provider,
  onOpenFile,
}: {
  item: Item;
  people: Record<string, Participant>;
  provider: string;
  onOpenFile: (path: string) => void;
}) {
  const who = (id: string) => people[id] || { name: "Someone", color: "#71717a" };
  switch (item.kind) {
    case "text":
      return (
        <div className="flex gap-2">
          <AgentAvatar size={18} provider={provider} />
          <div className="line-clamp-6 min-w-0 flex-1 text-[12.5px] leading-relaxed text-ink">
            <Markdown text={item.ev.payload.text} />
          </div>
        </div>
      );
    case "tool":
    case "group": {
      const tools = item.kind === "group" ? item.tools : [item];
      return (
        <div className="space-y-1 pl-[26px]">
          {tools.map((t) => {
            const name = t.call.payload.name as string;
            const input = t.call.payload.input || {};
            const r = t.result?.payload;
            const meta = FILE_TOOLS[name];
            const status = !t.result ? (
              <Loader2 className="size-3 shrink-0 animate-spin text-ink-3" />
            ) : r?.is_error ? (
              <X className="size-3 shrink-0 text-danger" />
            ) : (
              <Check className="size-3 shrink-0 text-live" />
            );
            if (name === "run_command") {
              return (
                <div key={t.seq} className="flex items-center gap-1.5 text-[12px] text-ink-3">
                  <SquareTerminal className="size-3 shrink-0" />
                  <span className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-ink-2">{String(input.command || "")}</span>
                  {r?.exit_code !== undefined && <span className={clsx("font-mono text-[11px]", r.exit_code === 0 ? "text-live" : "text-danger")}>exit {r.exit_code}</span>}
                  {!t.result && status}
                </div>
              );
            }
            const Icon = meta?.icon || FileText;
            const path = String(input.path || "");
            return (
              <button
                key={t.seq}
                onClick={() => path && name !== "list_files" && onOpenFile(path)}
                className="flex w-full items-center gap-1.5 text-left text-[12px] text-ink-3 hover:text-ink"
              >
                <Icon className="size-3 shrink-0" />
                <span className="shrink-0">{meta?.verb || name}</span>
                <span className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-ink-2">{name === "list_files" ? path || "repository" : path}</span>
                {status}
              </button>
            );
          })}
        </div>
      );
    }
    case "plan": {
      const done = item.steps.filter((s) => s.status === "done").length;
      const current = item.steps.find((s) => s.status === "in_progress");
      return (
        <div className="flex items-center gap-1.5 pl-[26px] text-[12px] text-ink-3">
          <ListChecks className="size-3 shrink-0" />
          <span className="tnum shrink-0">Plan {done}/{item.steps.length}</span>
          {current && <span className="min-w-0 truncate text-ink-2">· {current.title}</span>}
        </div>
      );
    }
    case "human": {
      const p = who(item.ev.actor);
      const steer = item.ev.payload.mode === "steer";
      return (
        <div className={clsx("ml-[26px] rounded-lg border px-2.5 py-1.5", steer ? "bg-panel" : "border-dashed border-line-strong")} style={steer ? { borderColor: `${p.color}55`, boxShadow: `inset 3px 0 0 ${p.color}` } : undefined}>
          <div className="flex items-center gap-1.5 text-[11px] text-ink-4">
            <Avatar name={p.name} color={p.color} size={13} />
            <span className="font-medium text-ink-3">{p.name}</span> {steer ? "steered" : "suggested"}
          </div>
          <p className="mt-0.5 text-[12.5px] leading-snug text-ink">{item.ev.payload.text}</p>
        </div>
      );
    }
    case "edit": {
      const p = who(item.ev.actor);
      return (
        <button onClick={() => onOpenFile(item.ev.payload.path)} className="flex w-full items-center gap-1.5 pl-[26px] text-left text-[12px] text-ink-3 hover:text-ink">
          <Avatar name={p.name} color={p.color} size={13} />
          <span className="shrink-0">
            <span className="font-medium text-ink-2">{p.name}</span> {item.ev.payload.created ? "created" : "edited"}
          </span>
          <span className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-ink-2">{item.ev.payload.path}</span>
        </button>
      );
    }
    case "command": {
      const p = who(item.ev.actor);
      const r = item.result?.payload;
      return (
        <div className="flex items-center gap-1.5 pl-[26px] text-[12px] text-ink-3">
          <Avatar name={p.name} color={p.color} size={13} />
          <span className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-ink-2">$ {item.ev.payload.command}</span>
          {!item.result ? (
            <Loader2 className="size-3 shrink-0 animate-spin" />
          ) : r?.cancelled ? (
            <span className="text-[11px] text-danger">stopped</span>
          ) : (
            <span className={clsx("font-mono text-[11px]", r?.exit_code === 0 ? "text-live" : "text-danger")}>exit {r?.exit_code}</span>
          )}
        </div>
      );
    }
    case "finish":
      return (
        <div className="ml-[26px] flex items-center gap-1.5 rounded-lg border border-live/30 bg-live/[0.06] px-2.5 py-1.5 text-[12px] font-medium text-live">
          <Check className="size-3" /> Task complete
        </div>
      );
    case "error":
      return <div className="ml-[26px] rounded-lg border border-danger/35 bg-danger-soft px-2.5 py-1.5 text-[12px] text-danger">{item.ev.payload.message}</div>;
    default:
      return null;
  }
}
