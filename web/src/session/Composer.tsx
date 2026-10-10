import { useRef, useState } from "react";
import clsx from "clsx";
import { ArrowUp, Eye, Lightbulb } from "lucide-react";
import type { Participant, Session } from "../lib/types";
import { Avatar } from "../components/Avatar";
import { BatonMark } from "../components/Logo";
import { Button } from "../components/Button";

export function Composer({
  session,
  me,
  participants,
  hasDecision,
  send,
}: {
  session: Session;
  me: string;
  participants: Participant[];
  hasDecision: boolean;
  send: (m: Record<string, unknown>) => boolean;
}) {
  const [text, setText] = useState("");
  const lastTyping = useRef(0);
  const isDriver = session.driver_id === me;
  const mine = participants.find((p) => p.user_id === me);
  const viewer = mine?.role === "viewer";
  const driver = participants.find((p) => p.user_id === session.driver_id);
  const typing = participants.filter((p) => p.typing && p.user_id !== me);

  const submit = () => {
    const t = text.trim();
    if (!t) return;
    if (send({ type: isDriver ? "steer" : "suggest", text: t })) setText("");
  };

  if (viewer) {
    return (
      <div className="flex items-center gap-2 rounded-xl border border-line bg-panel px-4 py-3 text-[13px] text-ink-3">
        <Eye className="size-4" /> You're watching. Hover any step to comment on it.
      </div>
    );
  }

  const placeholder = isDriver
    ? hasDecision
      ? "Answer the decision above, or steer the agent…"
      : session.status === "done"
        ? "Ask for a follow-up…"
        : "Steer the agent. It reads this at its next step…"
    : `Suggest something to ${driver?.name || "the driver"}…`;

  return (
    <div>
      <div className="mb-1.5 h-4 px-1 text-xs text-ink-4">
        {typing.length > 0 && (
          <span className="inline-flex items-center gap-1.5">
            <Avatar name={typing[0].name} color={typing[0].color} size={14} />
            {typing.map((p) => p.name).join(", ")} {typing.length > 1 ? "are" : "is"} typing…
          </span>
        )}
      </div>
      <div
        className={clsx(
          "rounded-xl border bg-panel shadow-[0_1px_2px_rgb(0_0_0/0.04),0_8px_24px_-16px_rgb(0_0_0/0.18)] focus-within:border-ink-4",
          isDriver ? "border-line-strong" : "border-line",
        )}
      >
        <textarea
          rows={2}
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            const now = Date.now();
            if (now - lastTyping.current > 1500) {
              lastTyping.current = now;
              send({ type: "typing" });
            }
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              submit();
            }
          }}
          placeholder={placeholder}
          className="block w-full resize-none bg-transparent px-3.5 pt-3 pb-1 text-[14px] leading-relaxed outline-none placeholder:text-ink-4"
        />
        <div className="flex items-center gap-2 px-2.5 pb-2.5">
          {isDriver ? (
            <span className="inline-flex items-center gap-1.5 rounded-md bg-baton-soft px-2 py-1 text-[11.5px] font-medium text-baton">
              <BatonMark className="size-3" /> You're driving
            </span>
          ) : (
            <span className="inline-flex items-center gap-1.5 rounded-md bg-sunken px-2 py-1 text-[11.5px] font-medium text-ink-3">
              <Lightbulb className="size-3" /> <span className="sm:hidden">To {driver?.name || "the driver"}</span>
              <span className="hidden sm:inline">Suggestions go to {driver?.name || "the driver"}, not the agent</span>
            </span>
          )}
          <span className="ml-auto hidden text-[11.5px] text-ink-4 sm:inline">Enter to send · Shift+Enter for a new line</span>
          <Button variant={isDriver ? "primary" : "secondary"} onClick={submit} disabled={!text.trim()} className="ml-auto sm:ml-0">
            {isDriver ? "Steer" : "Suggest"}
            <ArrowUp className="size-3.5" />
          </Button>
        </div>
      </div>
    </div>
  );
}
