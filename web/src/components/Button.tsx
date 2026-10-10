import clsx from "clsx";
import type { ButtonHTMLAttributes } from "react";

type Variant = "primary" | "secondary" | "ghost" | "danger" | "baton";

export function Button({
  variant = "secondary",
  size = "md",
  className,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: "sm" | "md" }) {
  return (
    <button
      {...rest}
      className={clsx(
        "inline-flex shrink-0 items-center justify-center gap-1.5 rounded-lg font-medium whitespace-nowrap transition-colors disabled:cursor-not-allowed disabled:opacity-45",
        size === "sm" ? "h-7 px-2.5 text-xs" : "h-8 px-3 text-[13px]",
        variant === "primary" && "bg-ink text-canvas hover:bg-ink/88",
        variant === "secondary" && "border border-line bg-panel text-ink hover:bg-sunken",
        variant === "ghost" && "text-ink-2 hover:bg-sunken hover:text-ink",
        variant === "danger" && "border border-danger/30 bg-danger-soft text-danger hover:border-danger/50",
        variant === "baton" && "bg-baton text-white hover:bg-baton/90",
        className,
      )}
    />
  );
}

export function Kbd({ children }: { children: string }) {
  return (
    <kbd className="rounded border border-current/20 px-1 font-sans text-[10px] leading-4 font-medium opacity-70">{children}</kbd>
  );
}
