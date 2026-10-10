import { useMemo, useState } from "react";
import clsx from "clsx";
import { ArrowRightLeft, Check, CornerDownLeft, MessageSquare } from "lucide-react";
import { useShallow } from "zustand/react/shallow";
import { useSession } from "../lib/session";
import type { BatonEvent, Comment } from "../lib/types";
import { ago } from "../lib/format";
import { Avatar } from "../components/Avatar";
import { Button } from "../components/Button";
import type { Ctx } from "./items";

export function useCommentsFor(seq: number): Comment[] {
  return useSession(
    useShallow((s) =>
      Object.values(s.comments)
        .filter((c) => c.event_seq === seq)
        .sort((a, b) => a.created_at - b.created_at),
    ),
  );
}

export function CommentThread({ seq, ctx }: { seq: number; ctx: Ctx }) {
  const comments = useCommentsFor(seq);
  const [body, setBody] = useState("");
  const submit = () => {
    if (!body.trim()) return;
    ctx.send({ type: "comment", event_seq: seq, body: body.trim() });
    setBody("");
  };
  return (
    <div className="animate-rise mt-2 ml-[34px] rounded-xl border border-line bg-panel shadow-[0_8px_24px_-16px_rgb(0_0_0/0.2)]">
      {comments.length > 0 && (
        <div className="divide-y divide-line">
          {comments.map((c) => (
            <CommentRow key={c.id} c={c} ctx={ctx} />
          ))}
        </div>
      )}
      <form
        className={clsx("flex items-end gap-2 p-2", comments.length > 0 && "border-t border-line")}
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <textarea
          autoFocus
          rows={1}
          value={body}
          onChange={(e) => setBody(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              submit();
            }
            if (e.key === "Escape") ctx.setOpenThread(null);
          }}
          placeholder={comments.length ? "Reply…" : "Comment on this step…"}
          className="max-h-32 min-h-8 flex-1 resize-none bg-transparent px-1.5 py-1.5 text-[13px] outline-none placeholder:text-ink-4"
        />
        <Button size="sm" type="submit" variant="primary" disabled={!body.trim()}>
          <CornerDownLeft className="size-3" />
          Comment
        </Button>
      </form>
    </div>
  );
}

function CommentRow({ c, ctx }: { c: Comment; ctx: Ctx }) {
  const canPromote = ctx.isDriver && ctx.live && !c.promoted_seq;
  return (
    <div className={clsx("px-3 py-2.5", c.resolved && !c.promoted_seq && "opacity-60")}>
      <div className="flex items-center gap-2 text-xs text-ink-4">
        <Avatar name={c.author_name} color={c.author_color} size={18} />
        <span className="font-medium text-ink-2">{c.author_name}</span>
        <span className="tnum">{ago(c.created_at)}</span>
        {c.promoted_seq && (
          <span className="ml-auto inline-flex items-center gap-1 rounded-full bg-baton-soft px-2 py-0.5 text-[11px] font-medium text-baton">
            <ArrowRightLeft className="size-3" /> Sent to agent
          </span>
        )}
      </div>
      <p className="mt-1 pl-[26px] text-[13.5px] leading-relaxed text-ink">{c.body}</p>
      {(canPromote || !c.promoted_seq) && (
        <div className="mt-1.5 flex gap-1 pl-[22px]">
          {canPromote && (
            <Button size="sm" variant="ghost" className="h-6 text-ink-2" onClick={() => ctx.send({ type: "promote", comment_id: c.id })}>
              <ArrowRightLeft className="size-3" /> Send to agent
            </Button>
          )}
          {!c.promoted_seq && (
            <Button size="sm" variant="ghost" className="h-6 text-ink-3" onClick={() => ctx.send({ type: "resolve_comment", id: c.id, resolved: !c.resolved })}>
              <Check className="size-3" /> {c.resolved ? "Reopen" : "Resolve"}
            </Button>
          )}
        </div>
      )}
    </div>
  );
}

export function CommentsPanel({ ctx, events, onJump }: { ctx: Ctx; events: BatonEvent[]; onJump: (seq: number) => void }) {
  const all = useSession((s) => s.comments);
  const groups = useMemo(() => {
    const by = new Map<number, Comment[]>();
    for (const c of Object.values(all).sort((a, b) => a.created_at - b.created_at)) {
      by.set(c.event_seq, [...(by.get(c.event_seq) || []), c]);
    }
    return [...by.entries()].sort((a, b) => b[0] - a[0]);
  }, [all]);
  if (!groups.length)
    return (
      <div className="px-4 py-10 text-center">
        <MessageSquare className="mx-auto size-5 text-ink-4" />
        <p className="mt-2 text-[13px] font-medium text-ink-2">No comments yet</p>
        <p className="mt-1 text-xs leading-relaxed text-ink-4">Hover any step in the timeline to leave a comment pinned to it.</p>
      </div>
    );
  return (
    <div className="space-y-3 p-3">
      {groups.map(([seq, list]) => {
        const ev = events.find((e) => e.seq === seq);
        return (
          <div key={seq} className="rounded-xl border border-line bg-panel">
            <button onClick={() => onJump(seq)} className="flex w-full items-center gap-2 border-b border-line px-3 py-2 text-left text-xs text-ink-3 hover:text-ink">
              <span className="tnum font-mono text-ink-4">#{seq}</span>
              <span className="truncate">{ev ? describe(ev) : "event"}</span>
            </button>
            <div className="divide-y divide-line">
              {list.map((c) => (
                <CommentRow key={c.id} c={c} ctx={ctx} />
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function describe(ev: BatonEvent) {
  const p = ev.payload;
  if (ev.type === "tool.call") {
    const i = p.input || {};
    return `${p.name.replace("_", " ")} ${i.path || i.command || ""}`.trim();
  }
  if (ev.type === "agent.text") return p.text.slice(0, 80);
  if (ev.type === "agent.decision_point") return p.question;
  if (ev.type === "human.message") return p.text.slice(0, 80);
  return ev.type;
}
