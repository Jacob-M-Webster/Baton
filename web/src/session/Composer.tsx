import { useRef, useState } from "react";
import clsx from "clsx";
import { ArrowUp, Eye, Lightbulb, Megaphone } from "lucide-react";
import type { Participant, Session } from "../lib/types";
import { Avatar } from "../components/Avatar";
import { BatonMark } from "../components/Logo";
import { Button } from "../components/Button";
import { toast } from "../components/Toasts";

// One tap to a useful request: what someone watching on a phone most often wants to say.
const QUICK = [
  "What are you doing right now, and why?",
  "Add tests for the edge cases",
  "Keep it simpler",
  "Try a different approach",
  "Run the tests and show me",
];

export function Composer({
  session,
  me,
  participants,
  hasDecision,
  send,
  compact = false,
}: {
  session: Session;
  me: string;
  participants: Participant[];
  hasDecision: boolean;
  send: (m: Record<string, unknown>) => boolean;
  compact?: boolean; // the narrow agent pane in the code view
}) {
  const [text, setText] = useState("");
  const input = useRef<HTMLTextAreaElement>(null);
  const lastTyping = useRef(0);
  const isDriver = session.driver_id === me;
  const mine = participants.find((p) => p.user_id === me);
  const viewer = mine?.role === "viewer";
  const driver = participants.find((p) => p.user_id === session.driver_id);
  const driverName = driver?.name || "the driver";
  const typing = participants.filter((p) => p.typing && p.user_id !== me);
  // On an open floor every collaborator's message goes straight to the agent.
  const openFloor = !!session.config?.open_floor;
  const steers = isDriver || openFloor;

  const submit = () => {
    const t = text.trim();
    if (!t) return;
    if (send({ type: steers ? "steer" : "suggest", text: t })) {
      setText("");
      if (!steers) toast(`Sent to ${driverName}. You'll see here when it reaches the agent.`, "info");
    }
  };

  if (viewer) {
    return (
      <div className="flex items-center gap-2 rounded-xl border border-line bg-panel px-4 py-3 text-[13px] text-ink-3">
        <Eye className="size-4" /> You're watching. Tap the speech bubble on any step to comment on it.
      </div>
    );
  }

  const placeholder = isDriver
    ? hasDecision
      ? "Answer the decision above, or steer the agent…"
      : session.status === "done"
        ? "Ask for a follow-up…"
        : "Steer the agent. It reads this at its next step…"
    : openFloor
      ? "The floor is open: tell the agent what to do…"
      : `Request a change. ${driverName} sends it to the agent…`;

  return (
    <div>
      <div className="mb-1.5 flex h-4 items-center px-1 text-xs text-ink-4">
        {typing.length > 0 && (
          <span className="inline-flex items-center gap-1.5">
            <Avatar name={typing[0].name} color={typing[0].color} size={14} />
            {typing.map((p) => p.name).join(", ")} {typing.length > 1 ? "are" : "is"} typing…
          </span>
        )}
      </div>
      {!isDriver && !text && !compact && session.status !== "done" && (
        <div className="-mx-1 mb-2 flex gap-1.5 overflow-x-auto px-1 pb-0.5 [scrollbar-width:none]">
          {QUICK.map((q) => (
            <button
              key={q}
              onClick={() => {
                setText(q);
                input.current?.focus();
              }}
              className="shrink-0 rounded-full border border-line bg-panel px-3 py-1.5 text-[12.5px] whitespace-nowrap text-ink-2 hover:border-ink-4 hover:text-ink"
            >
              {q}
            </button>
          ))}
        </div>
      )}
      <div
        className={clsx(
          "rounded-xl border bg-panel focus-within:border-ink-4",
          steers ? "border-line-strong" : "border-line",
        )}
      >
        <textarea
          ref={input}
          rows={2}
          value={text}
          enterKeyHint="send"
          onChange={(e) => {
            setText(e.target.value);
            const now = Date.now();
            if (now - lastTyping.current > 1500) {
              lastTyping.current = now;
              send({ type: "typing" });
            }
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              submit();
            }
          }}
          placeholder={placeholder}
          // 16px on phones: smaller text makes iOS zoom the page when the box is focused.
          className="block w-full resize-none bg-transparent px-3.5 pt-3 pb-1 text-base leading-relaxed outline-none placeholder:text-ink-4 sm:text-[14px]"
        />
        <div className="flex items-center gap-2 px-2.5 pb-2.5">
          {isDriver ? (
            <span className="inline-flex items-center gap-1.5 rounded-md bg-baton-soft px-2 py-1 text-[11.5px] font-medium text-baton">
              <BatonMark className="size-3" /> You're driving
              {openFloor && <span className="font-normal text-baton/80">· floor open</span>}
            </span>
          ) : openFloor ? (
            <span className="inline-flex items-center gap-1.5 rounded-md bg-live/10 px-2 py-1 text-[11.5px] font-medium text-live">
              <Megaphone className="size-3" /> Open floor{compact ? "" : <span className="hidden sm:inline">: goes straight to the agent</span>}
            </span>
          ) : (
            <span className="inline-flex items-center gap-1.5 rounded-md bg-sunken px-2 py-1 text-[11.5px] font-medium text-ink-3">
              <Lightbulb className="size-3" />
              {compact ? (
                <span>To {driverName}</span>
              ) : (
                <>
                  <span className="sm:hidden">To {driverName}</span>
                  <span className="hidden sm:inline">Requests go to {driverName}, who sends them to the agent</span>
                </>
              )}
            </span>
          )}
          {!compact && <span className="ml-auto hidden text-[11.5px] text-ink-4 lg:inline">Enter to send · Shift+Enter for a new line</span>}
          <Button
            variant={steers ? "primary" : "secondary"}
            onClick={submit}
            disabled={!text.trim()}
            className={clsx("h-9 sm:h-8", compact ? "ml-auto" : "ml-auto lg:ml-0")}
          >
            {steers ? "Steer" : "Request"}
            <ArrowUp className="size-3.5" />
          </Button>
        </div>
      </div>
    </div>
  );
}
