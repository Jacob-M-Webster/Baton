import { create } from "zustand";
import { X } from "lucide-react";
import clsx from "clsx";
import { useSession } from "../lib/session";
import { BatonMark } from "./Logo";

type Kind = "info" | "error" | "attn" | "baton" | "request";
interface Toast {
  id: number;
  text: string;
  kind: Kind;
  data?: { userId: string; seq: number };
}

const useToasts = create<{ items: Toast[] }>(() => ({ items: [] }));
let next = 1;

export function toast(text: string, kind: Kind = "info", data?: Toast["data"]) {
  const id = next++;
  useToasts.setState((s) => ({ items: [...s.items.slice(-3), { id, text, kind, data }] }));
  if (kind !== "request") window.setTimeout(() => dismiss(id), kind === "error" ? 6000 : 4500);
}

function dismiss(id: number) {
  useToasts.setState((s) => ({ items: s.items.filter((t) => t.id !== id) }));
}

export function Toasts() {
  const items = useToasts((s) => s.items);
  const send = useSession((s) => s.send);
  return (
    <div className="pointer-events-none fixed right-4 bottom-4 z-50 flex w-[340px] flex-col gap-2">
      {items.map((t) => (
        <div
          key={t.id}
          className={clsx(
            "animate-rise pointer-events-auto flex items-start gap-3 rounded-lg border bg-raised px-3.5 py-3 text-[13px] shadow-[0_8px_24px_-12px_rgb(0_0_0/0.25)]",
            t.kind === "error" ? "border-danger/40" : t.kind === "attn" ? "border-attn/50" : t.kind === "baton" || t.kind === "request" ? "border-baton/50" : "border-line",
          )}
        >
          {(t.kind === "baton" || t.kind === "request") && <BatonMark className="mt-0.5 size-4 shrink-0" />}
          <div className="min-w-0 flex-1">
            <p className="leading-snug text-ink">{t.text}</p>
            {t.kind === "request" && t.data && (
              <div className="mt-2.5 flex gap-2">
                <button
                  className="rounded-md bg-ink px-2.5 py-1 text-xs font-medium text-canvas hover:opacity-90"
                  onClick={() => {
                    send({ type: "grant_driver", to: t.data!.userId, reason: "request" });
                    dismiss(t.id);
                  }}
                >
                  Hand over
                </button>
                <button
                  className="rounded-md border border-line px-2.5 py-1 text-xs font-medium text-ink-2 hover:bg-sunken"
                  onClick={() => {
                    send({ type: "decline_driver", to: t.data!.userId });
                    dismiss(t.id);
                  }}
                >
                  Not now
                </button>
              </div>
            )}
          </div>
          <button className="text-ink-4 hover:text-ink-2" onClick={() => dismiss(t.id)} aria-label="Dismiss">
            <X className="size-3.5" />
          </button>
        </div>
      ))}
    </div>
  );
}
