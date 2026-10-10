import { useEffect, useRef, useState, type ReactNode } from "react";
import clsx from "clsx";

/** A minimal popover: click to toggle, closes on outside click or Escape. */
export function Popover({
  trigger,
  children,
  align = "right",
  width = 280,
  className,
}: {
  trigger: (open: boolean, toggle: () => void) => ReactNode;
  children: (close: () => void) => ReactNode;
  align?: "left" | "right";
  width?: number;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);
  return (
    <div ref={ref} className="relative">
      {trigger(open, () => setOpen((o) => !o))}
      {open && (
        <div
          className={clsx(
            "animate-rise absolute top-[calc(100%+6px)] z-40 rounded-xl border border-line bg-raised p-1.5 shadow-[0_16px_40px_-16px_rgb(0_0_0/0.3)]",
            align === "right" ? "right-0" : "left-0",
            className,
          )}
          style={{ width }}
        >
          {children(() => setOpen(false))}
        </div>
      )}
    </div>
  );
}

export function MenuLabel({ children }: { children: ReactNode }) {
  return <div className="px-2.5 pt-2 pb-1 text-[11px] font-medium tracking-wide text-ink-4 uppercase">{children}</div>;
}

export function MenuItem({
  children,
  onClick,
  disabled,
  active,
  hint,
}: {
  children: ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  active?: boolean;
  hint?: ReactNode;
}) {
  return (
    <button
      disabled={disabled}
      onClick={onClick}
      className={clsx(
        "flex w-full items-center gap-2.5 rounded-md px-2.5 py-1.5 text-left text-[13px]",
        disabled ? "cursor-not-allowed text-ink-4" : "text-ink hover:bg-sunken",
        active && "bg-sunken",
      )}
    >
      <span className="flex min-w-0 flex-1 items-center gap-2.5">{children}</span>
      {hint && <span className="shrink-0 text-xs text-ink-4">{hint}</span>}
    </button>
  );
}
