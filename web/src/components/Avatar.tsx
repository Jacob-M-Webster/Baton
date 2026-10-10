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

export function AgentAvatar({ size = 24 }: { size?: number }) {
  return (
    <span
      className="grid shrink-0 place-items-center rounded-md bg-ink text-canvas"
      style={{ width: size, height: size }}
      aria-hidden
    >
      <svg viewBox="0 0 16 16" style={{ width: size * 0.58, height: size * 0.58 }}>
        <path d="M8 1.5 9.6 6.4 14.5 8 9.6 9.6 8 14.5 6.4 9.6 1.5 8 6.4 6.4Z" fill="currentColor" />
      </svg>
    </span>
  );
}
