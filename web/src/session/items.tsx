import { useMemo, useState, type ReactNode } from "react";
import clsx from "clsx";
import {
  AlertTriangle, ArrowRightLeft, Ban, Check, ChevronRight, CircleDashed, CircleDot, Cpu, FileText,
  FolderTree, GitFork, ListChecks, Loader2, MessageSquare, PencilLine, FilePlus2, RotateCcw, Square,
  Terminal, UserPlus, Archive, X, Hand,
} from "lucide-react";
import type { BatonEvent, Participant } from "../lib/types";
import type { Item, PlanStep } from "../lib/derive";
import { clock, duration, modelLabel, shortClock } from "../lib/format";
import { Avatar, AgentAvatar } from "../components/Avatar";
import { BatonMark } from "../components/Logo";
import { Markdown } from "../components/Markdown";
import { Button } from "../components/Button";
import { CommentThread, useCommentsFor } from "./Comments";

export interface Ctx {
  me: string;
  focusBySeq: Record<number, Participant[]>;
  modelOfTurn: Record<number, string>;
  isDriver: boolean;
  driverId: string | null;
  people: Record<string, Participant>;
  live: boolean;
  send: (m: Record<string, unknown>) => boolean;
  openThread: number | null;
  setOpenThread: (seq: number | null) => void;
  highlight: number | null;
}

export function person(ctx: Ctx, id: string) {
  return ctx.people[id] || { user_id: id, name: id === "agent" ? "Agent" : "Someone", color: "#71717a" };
}

/* ---------------------------------------------------------------- shell */

function Row({
  seq,
  ctx,
  children,
  commentable = true,
  className,
}: {
  seq: number;
  ctx: Ctx;
  children: ReactNode;
  commentable?: boolean;
  className?: string;
}) {
  const comments = useCommentsFor(seq);
  const open = ctx.openThread === seq;
  const unresolved = comments.filter((c) => !c.resolved).length;
  return (
    <div
      id={`ev-${seq}`}
      data-seq={seq}
      className={clsx(
        "group/row relative scroll-mt-24 rounded-xl transition-colors",
        ctx.highlight === seq && "bg-baton-soft/60 ring-1 ring-baton/30",
        className,
      )}
    >
      {children}
      {ctx.focusBySeq[seq]?.length ? (
        <div className="absolute top-0.5 -left-1 flex -translate-x-full flex-col gap-0.5 pr-1.5 sm:pr-2">
          {ctx.focusBySeq[seq].map((p) => (
            <span key={p.user_id} className="animate-rise" title={`${p.name} is looking at this`}>
              <Avatar name={p.name} color={p.color} size={16} />
            </span>
          ))}
        </div>
      ) : null}
      {commentable && (
        <div className="absolute top-0 -right-10 flex flex-col items-center gap-1 sm:-right-11">
          <button
            onClick={() => ctx.setOpenThread(open ? null : seq)}
            className={clsx(
              "flex h-7 min-w-7 items-center justify-center gap-1 rounded-md px-1.5 text-xs",
              comments.length
                ? "border border-line bg-panel text-ink-2 hover:text-ink"
                : "text-ink-4 opacity-0 group-hover/row:opacity-100 pointer-coarse:opacity-60 hover:bg-sunken hover:text-ink-2",
              open && "opacity-100",
            )}
            title="Comment on this step"
            aria-label="Comment on this step"
          >
            <MessageSquare className="size-3.5" />
            {comments.length > 0 && <span className="tnum font-medium">{comments.length}</span>}
            {unresolved > 0 && <span className="absolute -top-0.5 -right-0.5 size-2 rounded-full bg-baton" />}
          </button>
        </div>
      )}
      {open && <CommentThread seq={seq} ctx={ctx} />}
    </div>
  );
}

function Meta({ children }: { children: ReactNode }) {
  return <div className="flex items-center gap-2 text-xs text-ink-4">{children}</div>;
}

/* ---------------------------------------------------------------- items */

export function TimelineItem({ item, ctx, events }: { item: Item; ctx: Ctx; events: BatonEvent[] }) {
  switch (item.kind) {
    case "start":
      return <StartItem ev={item.ev} ctx={ctx} />;
    case "text":
      return (
        <Row seq={item.seq} ctx={ctx}>
          <AgentText ev={item.ev} model={ctx.modelOfTurn[item.ev.payload.turn]} />
        </Row>
      );
    case "thinking":
      return <ThinkingItem ev={item.ev} />;
    case "tool":
      return (
        <Row seq={item.seq} ctx={ctx}>
          <ToolCard call={item.call} result={item.result} ctx={ctx} />
        </Row>
      );
    case "plan":
      return (
        <Row seq={item.seq} ctx={ctx}>
          <PlanItem steps={item.steps} prev={item.prev} />
        </Row>
      );
    case "decision":
      return (
        <Row seq={item.point?.seq ?? item.seq} ctx={ctx}>
          <DecisionCard item={item} ctx={ctx} />
        </Row>
      );
    case "finish":
      return (
        <Row seq={item.seq} ctx={ctx}>
          <FinishCard summary={item.summary} ts={item.call.ts} />
        </Row>
      );
    case "human":
      return (
        <Row seq={item.seq} ctx={ctx}>
          <HumanItem item={item} ctx={ctx} events={events} />
        </Row>
      );
    case "request":
      return <RequestItem item={item} ctx={ctx} />;
    case "error":
      return <ErrorItem ev={item.ev} ctx={ctx} />;
    case "system":
      return <SystemItem ev={item.ev} ctx={ctx} />;
  }
}

function StartItem({ ev, ctx }: { ev: BatonEvent; ctx: Ctx }) {
  const who = person(ctx, ev.actor);
  return (
    <div id={`ev-${ev.seq}`} className="pb-2">
      <Meta>
        <Avatar name={who.name} color={who.color} size={18} />
        <span>
          <span className="font-medium text-ink-2">{who.name}</span> started this session
        </span>
        <span>·</span>
        <span className="tnum">{shortClock(ev.ts)}</span>
      </Meta>
      <div className="mt-3 rounded-xl border border-line bg-panel px-4 py-3.5">
        <div className="text-[11px] font-medium tracking-wide text-ink-4 uppercase">Task</div>
        <p className="mt-1 text-[15px] leading-relaxed text-ink">{ev.payload.task}</p>
        <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-ink-3">
          <span className="inline-flex items-center gap-1.5 rounded-md border border-line bg-sunken px-2 py-0.5 font-mono text-[11.5px]">
            <FolderTree className="size-3" /> {ev.payload.repo}
          </span>
          <span className="inline-flex items-center gap-1.5 rounded-md border border-line bg-sunken px-2 py-0.5">
            <Cpu className="size-3" /> {modelLabel(ev.payload.model)}
          </span>
        </div>
      </div>
    </div>
  );
}

export function AgentText({ ev, streaming, model }: { ev?: BatonEvent; streaming?: string; model?: string }) {
  const text = streaming ?? ev?.payload.text ?? "";
  return (
    <div className="flex gap-3 py-1">
      <span title={[model && modelLabel(model), ev && clock(ev.ts)].filter(Boolean).join(" · ")}>
        <AgentAvatar size={22} />
      </span>
      <div className="min-w-0 flex-1 pt-px text-[14px] leading-[1.65] text-ink">
        <Markdown text={text} caret={streaming !== undefined} />
        {ev?.payload.interrupted && (
          <div className="mt-1.5 inline-flex items-center gap-1 text-xs text-danger">
            <Square className="size-3" /> Interrupted
          </div>
        )}
      </div>
    </div>
  );
}

export function ThinkingItem({ ev, streaming }: { ev?: BatonEvent; streaming?: string }) {
  const [open, setOpen] = useState(false);
  const text = streaming ?? ev?.payload.text ?? "";
  return (
    <div className="pl-[34px]">
      <button onClick={() => setOpen(!open)} className="flex items-center gap-1.5 text-xs text-ink-3 hover:text-ink-2">
        <ChevronRight className={clsx("size-3 transition-transform", open && "rotate-90")} />
        {streaming !== undefined ? <span className="shimmer-text font-medium">Thinking</span> : <span className="font-medium">Reasoning</span>}
      </button>
      {(open || streaming !== undefined) && (
        <p className="mt-1.5 border-l-2 border-line pl-3 text-[13px] leading-relaxed text-ink-3 italic">{text}</p>
      )}
    </div>
  );
}

/* ---------------------------------------------------------------- tools */

const TOOL_META: Record<string, { icon: ReactNode; verb: string }> = {
  list_files: { icon: <FolderTree className="size-3.5" />, verb: "Listed" },
  read_file: { icon: <FileText className="size-3.5" />, verb: "Read" },
  write_file: { icon: <FilePlus2 className="size-3.5" />, verb: "Wrote" },
  edit_file: { icon: <PencilLine className="size-3.5" />, verb: "Edited" },
  run_command: { icon: <Terminal className="size-3.5" />, verb: "Ran" },
};

function toolTitle(name: string, input: Record<string, unknown>) {
  if (name === "run_command") return String(input.command || "");
  if (name === "list_files") return String(input.path || ".") === "." ? "repository" : String(input.path);
  return String(input.path || "");
}

export function ToolCard({ call, result }: { call: BatonEvent; result?: BatonEvent; ctx: Ctx }) {
  const name = call.payload.name as string;
  const input = (call.payload.input || {}) as Record<string, unknown>;
  const meta = TOOL_META[name] || { icon: <CircleDot className="size-3.5" />, verb: name };
  const r = result?.payload;
  const isDiff = !!r?.diff;
  const [open, setOpen] = useState(isDiff || name === "run_command");
  const running = !result;
  const failed = r && r.is_error && !r.cancelled;
  const stats = useMemo(() => (r?.diff ? diffStats(r.diff) : null), [r?.diff]);

  return (
    <div className="pl-[34px]">
      <div className={clsx("overflow-hidden rounded-lg border bg-panel", failed ? "border-danger/35" : "border-line")}>
        <button onClick={() => setOpen(!open)} className="flex h-9 w-full items-center gap-2.5 px-3 text-left hover:bg-sunken/60">
          <span className={clsx("grid size-5 place-items-center rounded text-ink-3", running && "text-ink")}>{meta.icon}</span>
          <span className="shrink-0 text-[13px] text-ink-3">{meta.verb}</span>
          <span className={clsx("min-w-0 flex-1 truncate font-mono text-[12.5px]", name === "run_command" ? "text-ink" : "text-ink")}>
            {toolTitle(name, input)}
          </span>
          {stats && (
            <span className="tnum shrink-0 font-mono text-[11.5px]">
              <span className="text-live">+{stats.add}</span> <span className="text-danger">−{stats.del}</span>
            </span>
          )}
          {r?.exit_code !== undefined && (
            <span className={clsx("tnum shrink-0 font-mono text-[11.5px]", r.exit_code === 0 ? "text-live" : "text-danger")}>
              exit {r.exit_code}
            </span>
          )}
          <span className="tnum w-12 shrink-0 text-right text-[11.5px] text-ink-4">
            {running || r?.cancelled || (r?.duration_ms || 0) < 5 ? "" : duration(r!.duration_ms)}
          </span>
          <span className="grid size-4 shrink-0 place-items-center">
            {running ? (
              <Loader2 className="size-3.5 animate-spin text-ink-3" />
            ) : r?.cancelled ? (
              <Ban className="size-3.5 text-danger" />
            ) : failed ? (
              <X className="size-3.5 text-danger" />
            ) : (
              <Check className="size-3.5 text-live" />
            )}
          </span>
        </button>
        {open && result && (
          <div className="border-t border-line">
            {r?.cancelled ? (
              <div className="px-3 py-2 text-xs text-danger">Cancelled before it finished.</div>
            ) : isDiff ? (
              <DiffView diff={r!.diff} />
            ) : name === "run_command" ? (
              <TerminalView command={String(input.command)} output={r?.output || ""} />
            ) : (
              <pre className="max-h-[320px] overflow-auto bg-sunken px-3 py-2.5 font-mono text-[11.5px] leading-[1.6] whitespace-pre text-ink-2">
                {r?.output}
              </pre>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function diffStats(diff: string) {
  let add = 0;
  let del = 0;
  for (const l of diff.split("\n")) {
    if (l.startsWith("+") && !l.startsWith("+++")) add++;
    else if (l.startsWith("-") && !l.startsWith("---")) del++;
  }
  return { add, del };
}

export function DiffView({ diff, maxHeight = 380 }: { diff: string; maxHeight?: number }) {
  const lines = diff.split("\n").filter((l) => !l.startsWith("---") && !l.startsWith("+++"));
  return (
    <div className="overflow-auto bg-panel font-mono text-[11.5px] leading-[1.6]" style={{ maxHeight }}>
      {lines.map((l, i) => (
        <div
          key={i}
          className={clsx(
            "px-3 whitespace-pre",
            l.startsWith("+") && "bg-add text-ink",
            l.startsWith("-") && "bg-del text-ink",
            l.startsWith("@@") && "bg-sunken py-0.5 text-ink-4",
            !l.startsWith("+") && !l.startsWith("-") && !l.startsWith("@@") && "text-ink-3",
          )}
        >
          <span className="mr-3 inline-block w-2 text-ink-4 select-none">{l.startsWith("@@") ? "" : l[0] === "+" || l[0] === "-" ? l[0] : ""}</span>
          {l.startsWith("@@") ? l : l.slice(1)}
        </div>
      ))}
    </div>
  );
}

function TerminalView({ command, output }: { command: string; output: string }) {
  const body = output.replace(/\n?\[exit code \d+\]\s*$/, "");
  return (
    <pre className="max-h-[320px] overflow-auto bg-[#111113] px-3 py-2.5 font-mono text-[11.5px] leading-[1.6] whitespace-pre-wrap text-[#d6d6db]">
      <span className="text-[#7d7d86]">$ </span>
      <span className="text-white">{command}</span>
      {"\n"}
      {body.split("\n").map((l, i) => (
        <span key={i} className={clsx(/\bok$|^OK/.test(l) && "text-[#5bd28a]", /FAIL|Error|Traceback/.test(l) && "text-[#ff7b7b]")}>
          {l}
          {"\n"}
        </span>
      ))}
    </pre>
  );
}

/* ---------------------------------------------------------------- plan */

function PlanItem({ steps, prev }: { steps: PlanStep[]; prev: PlanStep[] }) {
  const prevTitles = new Set(prev.map((s) => s.title));
  const prevStatus = Object.fromEntries(prev.map((s) => [s.title, s.status]));
  const sameShape = prev.length === steps.length && steps.every((s) => prevTitles.has(s.title));
  if (sameShape) {
    // Progress only: one quiet line naming the steps that moved.
    const moved = steps.filter((s) => prevStatus[s.title] !== s.status);
    if (!moved.length) return null;
    return (
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 pl-[34px] text-xs text-ink-3">
        <span className="inline-flex items-center gap-1.5 font-medium">
          <ListChecks className="size-3.5" /> Plan
        </span>
        {moved.map((s) => (
          <span key={s.title} className="inline-flex items-center gap-1.5">
            <StepIcon status={s.status} />
            <span className={s.status === "done" ? "text-ink-3" : "text-ink-2"}>{s.title}</span>
          </span>
        ))}
      </div>
    );
  }
  return (
    <div className="pl-[34px]">
      <div className="rounded-lg border border-line bg-panel px-3 py-2.5">
        <div className="mb-1.5 flex items-center gap-2 text-xs font-medium text-ink-3">
          <ListChecks className="size-3.5" /> {prev.length ? "Plan updated" : "Plan"}
        </div>
        <ol className="space-y-1">
          {steps.map((s, i) => {
            const changed = prev.length > 0 && (!prevTitles.has(s.title) || prevStatus[s.title] !== s.status);
            return (
              <li key={i} className="flex items-start gap-2 text-[13px]">
                <StepIcon status={s.status} />
                <span className={clsx("leading-snug", s.status === "done" ? "text-ink-3 line-through decoration-ink-4/60" : "text-ink", changed && !prevTitles.has(s.title) && "font-medium")}>
                  {s.title}
                </span>
                {prev.length > 0 && !prevTitles.has(s.title) && (
                  <span className="mt-px rounded bg-baton-soft px-1.5 text-[10.5px] font-medium text-baton">changed</span>
                )}
              </li>
            );
          })}
        </ol>
      </div>
    </div>
  );
}

export function StepIcon({ status }: { status: string }) {
  if (status === "done")
    return (
      <span className="mt-[3px] grid size-3.5 shrink-0 place-items-center rounded-full bg-ink text-canvas">
        <Check className="size-2.5" strokeWidth={3} />
      </span>
    );
  if (status === "in_progress") return <CircleDashed className="mt-[3px] size-3.5 shrink-0 animate-[spin_3s_linear_infinite] text-baton" />;
  return <span className="mt-[3px] size-3.5 shrink-0 rounded-full border border-line-strong" />;
}

/* ---------------------------------------------------------------- decisions */

function DecisionCard({ item, ctx }: { item: Extract<Item, { kind: "decision" }>; ctx: Ctx }) {
  const input = item.call.payload.input || {};
  const question = item.point?.payload.question || input.question;
  const options: string[] = item.point?.payload.options || input.options || [];
  const [other, setOther] = useState("");
  const answered = item.answer;
  const who = answered ? person(ctx, answered.actor) : null;
  const driver = ctx.driverId ? person(ctx, ctx.driverId) : null;
  const canAnswer = ctx.isDriver && ctx.live && !answered && !!item.point;
  const answer = (text: string) => ctx.send({ type: "answer_decision", seq: item.point!.seq, answer: text });

  return (
    <div className="pl-[34px]">
      <div className={clsx("rounded-xl border px-4 py-3.5", answered ? "border-line bg-panel" : "border-attn/45 bg-attn-soft/60")}>
        <div className="flex items-center gap-2 text-xs font-medium">
          <Hand className={clsx("size-3.5", answered ? "text-ink-3" : "text-attn")} />
          <span className={answered ? "text-ink-3" : "text-attn"}>{answered ? "Decision" : "Decision needed"}</span>
          {!answered && driver && (
            <span className="font-normal text-ink-3">
              · {ctx.isDriver ? "you're driving, so it's your call" : `waiting on ${driver.name}`}
            </span>
          )}
        </div>
        <p className="mt-1.5 text-[15px] leading-snug font-medium text-ink">{question}</p>
        <div className="mt-3 flex flex-col gap-1.5">
          {options.map((o) => {
            const chosen = answered?.payload.answer === o;
            return (
              <button
                key={o}
                disabled={!canAnswer}
                onClick={() => answer(o)}
                className={clsx(
                  "flex items-center gap-2.5 rounded-lg border px-3 py-2 text-left text-[13.5px] transition-colors",
                  chosen ? "border-ink bg-panel font-medium text-ink" : "border-line bg-panel text-ink-2",
                  canAnswer && "hover:border-ink-3 hover:text-ink",
                  answered && !chosen && "opacity-55",
                )}
              >
                <span className={clsx("grid size-4 shrink-0 place-items-center rounded-full border", chosen ? "border-ink bg-ink text-canvas" : "border-line-strong")}>
                  {chosen && <Check className="size-2.5" strokeWidth={3} />}
                </span>
                {o}
              </button>
            );
          })}
        </div>
        {canAnswer && (
          <form
            className="mt-2 flex gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              if (other.trim()) answer(other.trim());
            }}
          >
            <input
              value={other}
              onChange={(e) => setOther(e.target.value)}
              placeholder="Or answer in your own words"
              className="h-9 min-w-0 flex-1 rounded-lg border border-line bg-panel px-3 text-[13px] outline-none focus:border-ink-3"
            />
            <Button type="submit" disabled={!other.trim()}>
              Answer
            </Button>
          </form>
        )}
        {answered && who && (
          <div className="mt-3 flex items-center gap-2 text-xs text-ink-3">
            <Avatar name={who.name} color={who.color} size={16} />
            <span>
              <span className="font-medium text-ink-2">{who.name}</span> decided
              {options.includes(answered.payload.answer) ? "" : `: “${answered.payload.answer}”`}
            </span>
            <span>·</span>
            <span className="tnum">{shortClock(answered.ts)}</span>
          </div>
        )}
      </div>
    </div>
  );
}

function FinishCard({ summary, ts }: { summary: string; ts: number }) {
  return (
    <div className="pl-[34px]">
      <div className="rounded-xl border border-live/30 bg-live/[0.06] px-4 py-3.5">
        <div className="flex items-center gap-2 text-xs font-medium text-live">
          <span className="grid size-4 place-items-center rounded-full bg-live text-white">
            <Check className="size-2.5" strokeWidth={3} />
          </span>
          Task complete
          <span className="font-normal text-ink-4">· {shortClock(ts)}</span>
        </div>
        <div className="mt-2 text-[13.5px] leading-relaxed text-ink">
          <Markdown text={summary} />
        </div>
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------- humans */

function HumanItem({ item, ctx, events }: { item: Extract<Item, { kind: "human" }>; ctx: Ctx; events: BatonEvent[] }) {
  const ev = item.ev;
  const p = ev.payload;
  const who = person(ctx, ev.actor);
  if (p.mode === "suggest") {
    const promoter = item.promotedBy ? person(ctx, item.promotedBy.actor) : null;
    const canAct = ctx.isDriver && ctx.live && !item.promotedBy && !item.dismissed;
    return (
      <div className={clsx("ml-[34px] rounded-xl border border-dashed px-3.5 py-2.5", item.dismissed ? "border-line opacity-60" : "border-line-strong bg-panel")}>
        <Meta>
          <Avatar name={who.name} color={who.color} size={16} />
          <span>
            <span className="font-medium text-ink-2">{who.name}</span> suggested
          </span>
          <span>·</span>
          <span className="tnum">{shortClock(ev.ts)}</span>
        </Meta>
        <p className="mt-1.5 text-[14px] leading-relaxed text-ink">{p.text}</p>
        {canAct && (
          <div className="mt-2.5 flex gap-2">
            <Button size="sm" variant="primary" onClick={() => ctx.send({ type: "promote", seq: ev.seq })}>
              <ArrowRightLeft className="size-3" /> Send to agent
            </Button>
            <Button size="sm" variant="ghost" onClick={() => ctx.send({ type: "dismiss_suggestion", seq: ev.seq })}>
              Dismiss
            </Button>
          </div>
        )}
        {promoter && (
          <div className="mt-2 text-xs text-ink-3">
            Sent to the agent by <span className="font-medium text-ink-2">{promoter.name}</span>
          </div>
        )}
        {item.dismissed && <div className="mt-2 text-xs text-ink-4">Dismissed by {person(ctx, item.dismissed.actor).name}</div>}
      </div>
    );
  }
  // steer
  const fromId = p.suggested_by as string | undefined;
  const from = fromId ? person(ctx, fromId) : null;
  const sourceSeq = p.promoted_from?.event_seq ?? p.promoted_from?.seq;
  const source = sourceSeq ? events.find((e) => e.seq === sourceSeq) : null;
  return (
    <div className="ml-[34px] rounded-xl border bg-panel px-3.5 py-2.5" style={{ borderColor: `${who.color}55`, boxShadow: `inset 3px 0 0 ${who.color}` }}>
      <Meta>
        {from ? (
          <span className="flex -space-x-1.5">
            <Avatar name={from.name} color={from.color} size={16} />
            <Avatar name={who.name} color={who.color} size={16} />
          </span>
        ) : (
          <Avatar name={who.name} color={who.color} size={16} />
        )}
        <span>
          {from ? (
            <>
              <span className="font-medium text-ink-2">{who.name}</span> sent <span className="font-medium text-ink-2">{from.name}</span>'s
              {p.promoted_from?.comment_id ? " comment" : " suggestion"} to the agent
            </>
          ) : (
            <>
              <span className="font-medium text-ink-2">{who.name}</span> steered
            </>
          )}
        </span>
        <span>·</span>
        <span className="tnum">{shortClock(ev.ts)}</span>
      </Meta>
      <p className="mt-1.5 text-[14px] leading-relaxed text-ink">{p.text}</p>
      {source && source.type === "tool.call" && (
        <a href={`#ev-${source.seq}`} className="mt-1.5 inline-flex items-center gap-1 text-xs text-ink-3 hover:text-ink">
          <MessageSquare className="size-3" /> on step #{source.seq}
        </a>
      )}
    </div>
  );
}

function RequestItem({ item, ctx }: { item: Extract<Item, { kind: "request" }>; ctx: Ctx }) {
  const who = person(ctx, item.ev.actor);
  const pending = !item.resolved;
  return (
    <div id={`ev-${item.seq}`} className="flex items-center gap-2 py-1 pl-[34px] text-xs text-ink-3">
      <BatonMark className="size-3.5" />
      <span>
        <span className="font-medium text-ink-2">{who.name}</span> asked for the baton
      </span>
      <span className="tnum text-ink-4">{shortClock(item.ev.ts)}</span>
      {pending && ctx.isDriver && ctx.live && (
        <span className="ml-1 flex gap-1.5">
          <Button size="sm" variant="primary" onClick={() => ctx.send({ type: "grant_driver", to: item.ev.actor, reason: "request" })}>
            Hand over
          </Button>
          <Button size="sm" variant="ghost" onClick={() => ctx.send({ type: "decline_driver", to: item.ev.actor })}>
            Not now
          </Button>
        </span>
      )}
    </div>
  );
}

function ErrorItem({ ev, ctx }: { ev: BatonEvent; ctx: Ctx }) {
  return (
    <div id={`ev-${ev.seq}`} className="ml-[34px] rounded-xl border border-danger/35 bg-danger-soft px-3.5 py-2.5">
      <div className="flex items-center gap-2 text-xs font-medium text-danger">
        <AlertTriangle className="size-3.5" /> The agent hit an error
      </div>
      <p className="mt-1 font-mono text-[12px] leading-relaxed break-words text-ink-2">{ev.payload.message}</p>
      {ctx.isDriver && ctx.live && (
        <p className="mt-2 text-xs text-ink-3">Switch models from the header, or send a message to retry.</p>
      )}
    </div>
  );
}

function SystemItem({ ev, ctx }: { ev: BatonEvent; ctx: Ctx }) {
  const p = ev.payload;
  const who = person(ctx, ev.actor);
  let icon: ReactNode = <CircleDot className="size-3.5" />;
  let body: ReactNode = ev.type;
  let tone = "text-ink-3";
  const [open, setOpen] = useState(false);
  switch (ev.type) {
    case "participant.joined":
      icon = <UserPlus className="size-3.5" />;
      body = (
        <>
          <span className="font-medium text-ink-2">{who.name}</span> joined{p.role === "viewer" ? " as a viewer" : ""}
        </>
      );
      break;
    case "control.driver_changed": {
      const to = person(ctx, p.to);
      icon = <BatonMark className="size-3.5" />;
      tone = "text-ink-2";
      body =
        p.reason === "force" ? (
          <>
            <span className="font-medium">{to.name}</span> took the baton
          </>
        ) : (
          <>
            <span className="font-medium">{p.from ? person(ctx, p.from).name : "System"}</span> handed the baton to{" "}
            <span className="font-medium">{to.name}</span>
          </>
        );
      break;
    }
    case "control.driver_declined":
      icon = <BatonMark className="size-3.5 opacity-50" />;
      body = (
        <>
          <span className="font-medium text-ink-2">{who.name}</span> kept the baton for now
        </>
      );
      break;
    case "control.model_changed":
      icon = <Cpu className="size-3.5" />;
      tone = "text-ink-2";
      body = (
        <>
          <span className="font-medium">{who.name}</span> switched the model from {modelLabel(p.from.model)} to{" "}
          <span className="font-medium">{modelLabel(p.to.model)}</span>
        </>
      );
      break;
    case "human.interrupt":
      icon = <Square className="size-3.5 fill-current" />;
      tone = "text-danger";
      body = (
        <>
          <span className="font-medium">{who.name}</span> interrupted the agent
        </>
      );
      break;
    case "session.resumed":
      icon = <RotateCcw className="size-3.5" />;
      tone = "text-ink-2";
      body = <>Server restarted. Session resumed from event #{p.after_seq}, nothing lost.</>;
      break;
    case "session.forked":
      icon = <GitFork className="size-3.5" />;
      tone = "text-ink-2";
      body = (
        <>
          <span className="font-medium">{who.name}</span> forked this from “{p.parent_title}” at step #{p.fork_seq}
          {p.files_restored ? ` (${p.files_restored} file changes restored)` : ""}
        </>
      );
      break;
    case "agent.checkpoint":
      icon = <Archive className="size-3.5" />;
      body = (
        <button onClick={() => setOpen(!open)} className="hover:text-ink-2">
          Checkpoint: history up to #{p.covers_seq} summarized{p.source && p.source !== "log" ? ` by ${modelLabel(p.source)}` : ""}
        </button>
      );
      break;
  }
  return (
    <div id={`ev-${ev.seq}`} data-seq={ev.seq} className="py-0.5">
      <div className={clsx("flex items-center gap-2 pl-[34px] text-xs", tone)}>
        <span className="opacity-80">{icon}</span>
        <span>{body}</span>
        <span className="tnum text-ink-4" title={clock(ev.ts)}>
          {shortClock(ev.ts)}
        </span>
      </div>
      {open && ev.type === "agent.checkpoint" && (
        <p className="mt-1.5 ml-[34px] rounded-lg border border-line bg-panel px-3 py-2 text-xs leading-relaxed whitespace-pre-wrap text-ink-2">{p.summary}</p>
      )}
    </div>
  );
}
