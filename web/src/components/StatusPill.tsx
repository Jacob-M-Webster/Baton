import clsx from "clsx";
import type { Status } from "../lib/types";

const LABEL: Record<Status, string> = {
  running: "Running",
  waiting_input: "Waiting for input",
  paused: "Paused",
  done: "Done",
  error: "Error",
};

export function StatusDot({ status, className }: { status: Status; className?: string }) {
  return (
    <span
      className={clsx(
        "inline-block size-2 shrink-0 rounded-full",
        status === "running" && "animate-pulse-dot bg-live",
        status === "waiting_input" && "bg-attn",
        status === "paused" && "bg-ink-4",
        status === "done" && "bg-ink-3",
        status === "error" && "bg-danger",
        className,
      )}
    />
  );
}

export function StatusPill({ status, decision }: { status: Status; decision?: boolean }) {
  return (
    <span
      className={clsx(
        "inline-flex h-[22px] shrink-0 items-center gap-1.5 rounded-md border px-1.5 text-[11.5px] font-medium whitespace-nowrap sm:px-2",
        status === "running" && "border-live/25 bg-live/8 text-live",
        status === "waiting_input" && "border-attn/30 bg-attn-soft text-attn",
        status === "done" && "border-line bg-sunken text-ink-2",
        status === "error" && "border-danger/30 bg-danger-soft text-danger",
        status === "paused" && "border-line bg-sunken text-ink-3",
      )}
    >
      <StatusDot status={status} />
      <span className="hidden sm:inline">{decision && status === "waiting_input" ? "Needs a decision" : LABEL[status]}</span>
    </span>
  );
}
