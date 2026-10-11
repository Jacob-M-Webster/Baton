import clsx from "clsx";

/** The baton: a short bar held at an angle. Whoever drives the agent "holds the baton". */
export function BatonMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 20 20" className={clsx("text-baton", className)} aria-hidden>
      <rect x="2.5" y="8.25" width="15" height="3.5" rx="1.75" transform="rotate(-35 10 10)" fill="currentColor" />
    </svg>
  );
}

export function Logo({ className }: { className?: string }) {
  return (
    <span className={clsx("inline-flex items-center gap-2 select-none", className)}>
      <span className="grid size-6 place-items-center rounded-[7px] bg-ink">
        <svg viewBox="0 0 24 24" className="size-[18px]" aria-hidden>
          <circle cx="8" cy="8.5" r="2.4" fill="var(--canvas)" />
          <rect x="5" y="12.6" width="14" height="3.8" rx="1.9" transform="rotate(-35 12 14.5)" fill="#f15a24" />
        </svg>
      </span>
      <span className="text-[15px] font-semibold tracking-[-0.01em] text-ink">Baton</span>
    </span>
  );
}
