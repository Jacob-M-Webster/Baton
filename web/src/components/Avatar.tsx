import clsx from "clsx";
import { initials } from "../lib/format";
import { BatonMark } from "./Logo";

export function Avatar({
  name,
  color,
  size = 24,
  online,
  driver,
  className,
  title,
}: {
  name: string;
  color: string;
  size?: number;
  online?: boolean;
  driver?: boolean;
  className?: string;
  title?: string;
}) {
  return (
    <span className={clsx("relative inline-flex shrink-0", className)} title={title ?? name} style={{ width: size, height: size }}>
      <span
        className="grid size-full place-items-center rounded-full font-semibold text-white ring-2 ring-panel"
        style={{ background: color, fontSize: Math.max(9, size * 0.4) }}
      >
        {initials(name)}
      </span>
      {online !== undefined && (
        <span
          className={clsx(
            "absolute -right-0.5 -bottom-0.5 rounded-full ring-2 ring-panel",
            online ? "bg-live" : "bg-ink-4",
          )}
          style={{ width: Math.max(7, size * 0.3), height: Math.max(7, size * 0.3) }}
        />
      )}
      {driver && (
        <span className="absolute -top-1.5 -right-1.5 grid size-3.5 place-items-center rounded-full bg-panel ring-1 ring-line">
          <BatonMark className="size-3" />
        </span>
      )}
    </span>
  );
}

const PROVIDER_MARK: Record<string, string> = { anthropic: "A", openai: "O", gemini: "G", local: "L", demo: "D", external: "E" };

/** The agent's avatar carries the mark of the provider whose model wrote the message. */
export function AgentAvatar({ size = 24, provider }: { size?: number; provider?: string }) {
  const mark = provider ? PROVIDER_MARK[provider] ?? provider[0]?.toUpperCase() : null;
  return (
    <span
      className="grid shrink-0 place-items-center rounded-md bg-ink font-mono font-semibold text-canvas"
      style={{ width: size, height: size, fontSize: size * 0.48 }}
      aria-hidden
    >
      {mark ?? (
        <svg viewBox="0 0 24 24" style={{ width: size * 0.62, height: size * 0.62 }}>
          <rect x="4" y="10.2" width="16" height="3.6" rx="1.8" transform="rotate(-35 12 12)" fill="currentColor" />
        </svg>
      )}
    </span>
  );
}
