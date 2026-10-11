import { useEffect, useState } from "react";
import { useLocation } from "wouter";
import { AlertTriangle, CreditCard, ExternalLink, Loader2, Minus, Plus } from "lucide-react";
import clsx from "clsx";
import { money, seatPrice, total, useBilling, type PlanId } from "../lib/billing";
import { Button } from "../components/Button";
import { EVERY_PLAN, PlanTable, WHO } from "../components/PlanTable";
import { toast } from "../components/Toasts";

async function post<T>(path: string, body?: unknown): Promise<T> {
  const r = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || data.detail || `${r.status}`);
  return data as T;
}

function date(ts: number) {
  return new Date(ts * 1000).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

export function Billing() {
  const { view, load } = useBilling();
  const [busy, setBusy] = useState<"portal" | "sync" | PlanId | null>(null);
  const [pick, setPick] = useState<"free" | PlanId>("team");
  const [seats, setSeats] = useState<Record<PlanId, number>>({ team: 5, enterprise: 50 });
  const [, navigate] = useLocation();

  useEffect(() => {
    const q = new URLSearchParams(location.search);
    const session = q.get("checkout");
    if (session) {
      // Back from Stripe Checkout: confirm with Stripe (works even before the webhook arrives).
      setBusy("sync");
      post("/api/billing/sync", { session_id: session })
        .then(() => toast("You're subscribed. Every model is unlocked.", "baton"))
        .catch((e) => toast((e as Error).message, "error"))
        .finally(() => {
          setBusy(null);
          navigate("/billing", { replace: true });
          load();
        });
    } else {
      if (q.get("canceled")) {
        toast("Checkout canceled. Nothing was charged.", "info");
        navigate("/billing", { replace: true });
      }
      load();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const go = async (kind: "checkout" | "portal", plan?: PlanId) => {
    setBusy(plan ?? "portal");
    try {
      const { url } = await post<{ url: string }>(`/api/billing/${kind}`, plan ? { plan, seats: seats[plan] } : undefined);
      location.href = url; // Stripe-hosted: card details never touch Baton
    } catch (e) {
      toast((e as Error).message, "error");
      setBusy(null);
    }
  };

  const plans = view?.plans ?? [];
  const current = view?.active ? plans.find((p) => p.id === view.plan) : undefined;
  const picked = plans.find((p) => p.id === pick);

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto w-full max-w-[820px] px-4 pt-[10vh] pb-20 sm:px-6 md:px-10">
        <h1 className="text-[22px] leading-tight font-semibold tracking-[-0.015em]">Plan</h1>
        <p className="mt-1 text-[13.5px] text-ink-3">Seats are for the people who drive agents. Viewers are free on every plan, and you bring your own LLM key.</p>

        {!view ? (
          <div className="mt-6 h-64 animate-pulse rounded-lg bg-sunken" />
        ) : (
          <>
            {!view.enabled && (
              <div className="mt-6 rounded-lg border border-line bg-panel p-4 text-[13px] text-ink-3">
                Billing isn't set up on this server, so every model is available. To charge for it, set{" "}
                <code className="rounded bg-sunken px-1 font-mono text-[12px]">STRIPE_SECRET_KEY</code> (see the README).
              </div>
            )}

            {view.enabled && current && (
              <div className="mt-6 overflow-hidden rounded-lg border border-line bg-panel">
                <div className="flex flex-wrap items-center gap-4 px-4 py-4">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 text-[14px] font-semibold">
                      {current.name} <Status view={view} />
                    </div>
                    <div className="mt-0.5 text-[12.5px] text-ink-3">
                      {view.seats ?? current.min_seats} seats × {seatPrice(current, view.currency)} ·{" "}
                      <span className="tnum font-medium text-ink">{total(current, view.seats ?? current.min_seats, view.currency)}</span>
                    </div>
                  </div>
                  <Button onClick={() => go("portal")} disabled={!!busy}>
                    {busy === "portal" ? <Loader2 className="size-3.5 animate-spin" /> : <ExternalLink className="size-3.5" />}
                    Manage subscription
                  </Button>
                </div>
                {view.current_period_end && (
                  <div className="border-t border-line px-4 py-2.5 text-[12.5px] text-ink-3">
                    {view.cancel_at_period_end
                      ? `Cancels on ${date(view.current_period_end)}. Renew any time from Manage subscription.`
                      : `Renews on ${date(view.current_period_end)}`}
                    {view.email ? ` · receipts go to ${view.email}` : ""}
                  </div>
                )}
                {view.status === "past_due" && (
                  <div className="flex items-center gap-2 border-t border-attn/30 bg-attn-soft px-4 py-2.5 text-[12.5px] text-ink-2">
                    <AlertTriangle className="size-4 text-attn" />
                    The last renewal didn't go through. Stripe is retrying; update the card under Manage subscription.
                  </div>
                )}
              </div>
            )}

            {view.enabled && !view.active && (
              <div className="mt-6 overflow-hidden rounded-lg border border-line bg-panel" role="radiogroup" aria-label="Plan">
                <PlanRow id="free" name="Free" price={money(0, view.currency)} note="Current plan" selected={pick === "free"} onSelect={() => setPick("free")} />
                {plans.map((p) => (
                  <PlanRow
                    key={p.id}
                    id={p.id}
                    name={p.name}
                    price={money(p.seat, view.currency)}
                    per="/seat/mo"
                    note={p.interval === "year" ? `Billed annually · ${p.min_seats}-seat minimum` : "Billed monthly"}
                    selected={pick === p.id}
                    onSelect={() => setPick(p.id)}
                  />
                ))}
                <div className="flex flex-wrap items-center gap-3 border-t border-line bg-sunken/50 px-4 py-3">
                  {picked ? (
                    <>
                      <SeatPicker min={picked.min_seats} value={seats[picked.id]} onChange={(n) => setSeats((s) => ({ ...s, [picked.id]: n }))} />
                      <span className="text-[12.5px] text-ink-3">
                        × {seatPrice(picked, view.currency)} = <span className="tnum font-semibold text-ink">{total(picked, seats[picked.id], view.currency)}</span>
                      </span>
                      <Button
                        variant="primary"
                        onClick={() => go("checkout", picked.id)}
                        disabled={!!busy}
                        aria-label={`Subscribe to ${picked.name}`}
                        className="ml-auto h-8 px-3.5"
                      >
                        {busy ? <Loader2 className="size-3.5 animate-spin" /> : <CreditCard className="size-3.5" />}
                        {busy === "sync" ? "Confirming…" : `Continue to payment`}
                      </Button>
                    </>
                  ) : (
                    <span className="text-[12.5px] text-ink-3">You're on Free. Nothing to pay.</span>
                  )}
                  {view.has_customer && (
                    <button onClick={() => go("portal")} className={clsx("text-xs text-ink-3 hover:text-ink", !picked && "ml-auto")}>
                      Past invoices <ExternalLink className="inline size-3" />
                    </button>
                  )}
                </div>
              </div>
            )}

            <h2 className="mt-10 mb-3 text-[12px] font-semibold text-ink-3">Compare plans</h2>
            <PlanTable plans={plans} currency={view.currency} highlight={current?.id ?? (view.enabled ? pick : undefined)} />
            <p className="mt-3 text-xs leading-relaxed text-ink-4">{EVERY_PLAN}</p>
          </>
        )}
      </div>
    </div>
  );
}

function PlanRow({
  id,
  name,
  price,
  per,
  note,
  selected,
  onSelect,
}: {
  id: "free" | PlanId;
  name: string;
  price: string;
  per?: string;
  note: string;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      role="radio"
      aria-checked={selected}
      onClick={onSelect}
      className={clsx(
        "flex w-full items-center gap-3.5 border-t border-line px-4 py-3 text-left first:border-t-0",
        selected ? "bg-sunken/70" : "hover:bg-sunken/40",
      )}
    >
      <span className={clsx("size-4 shrink-0 rounded-full border", selected ? "border-[5px] border-ink" : "border-line-strong")} />
      <span className="min-w-0 flex-1">
        <span className="block text-[14px] font-medium text-ink">{name}</span>
        <span className="block text-[12.5px] text-ink-3">{WHO[id]}</span>
      </span>
      <span className="text-right">
        <span className="tnum block text-[14px] font-semibold text-ink">
          {price}
          {per && <span className="ml-0.5 text-[12px] font-normal text-ink-4">{per}</span>}
        </span>
        <span className="block text-[12px] text-ink-4">{note}</span>
      </span>
    </button>
  );
}

function SeatPicker({ min, value, onChange }: { min: number; value: number; onChange: (n: number) => void }) {
  const set = (n: number) => onChange(Math.max(min, Math.min(10_000, Math.round(n) || min)));
  const step = "grid size-8 place-items-center text-ink-3 hover:bg-sunken hover:text-ink disabled:opacity-40";
  return (
    <div className="flex items-center overflow-hidden rounded-lg border border-line bg-panel">
      <button type="button" className={step} onClick={() => set(value - 1)} disabled={value <= min} aria-label="Fewer seats">
        <Minus className="size-3.5" />
      </button>
      <input
        type="number"
        min={min}
        value={value}
        onChange={(e) => set(Number(e.target.value))}
        aria-label="Seats"
        className="tnum h-8 w-14 border-x border-line bg-transparent text-center text-[13px] text-ink outline-none [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none"
      />
      <button type="button" className={step} onClick={() => set(value + 1)} aria-label="More seats">
        <Plus className="size-3.5" />
      </button>
      <span className="px-2 text-[12px] text-ink-4">seats</span>
    </div>
  );
}

function Status({ view }: { view: NonNullable<ReturnType<typeof useBilling.getState>["view"]> }) {
  if (view.status === "past_due") return <Pill className="bg-attn-soft text-attn">Payment due</Pill>;
  if (view.active && view.cancel_at_period_end) return <Pill className="bg-sunken text-ink-3">Canceling</Pill>;
  if (view.active) return <Pill className="bg-live/10 text-live">Active</Pill>;
  if (view.status === "canceled") return <Pill className="bg-sunken text-ink-3">Canceled</Pill>;
  return <Pill className="bg-sunken text-ink-3">Not subscribed</Pill>;
}

function Pill({ children, className }: { children: React.ReactNode; className: string }) {
  return <span className={clsx("rounded-full px-2 py-0.5 text-[11px] font-medium", className)}>{children}</span>;
}
