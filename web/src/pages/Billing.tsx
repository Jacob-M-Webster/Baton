import { useEffect, useState } from "react";
import { useLocation } from "wouter";
import { AlertTriangle, CreditCard, ExternalLink, FlaskConical, Loader2, Minus, Plus } from "lucide-react";
import clsx from "clsx";
import { seatPrice, total, useBilling, type Plan, type PlanId } from "../lib/billing";
import { Button } from "../components/Button";
import { EVERY_PLAN, PlanTable } from "../components/PlanTable";
import { toast } from "../components/Toasts";

// Stripe's published test cards: they only work with test-mode keys and never charge anything.
const TEST_CARDS = [
  { number: "4242 4242 4242 4242", what: "Succeeds" },
  { number: "4000 0025 0000 3155", what: "Asks for 3D Secure authentication" },
  { number: "4000 0000 0000 9995", what: "Declined: insufficient funds" },
  { number: "4000 0000 0000 0002", what: "Declined" },
];

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
  const subscribe = (p: Plan) => (
    <div className="flex flex-col items-center gap-2">
      <SeatPicker min={p.min_seats} value={seats[p.id]} onChange={(n) => setSeats((s) => ({ ...s, [p.id]: n }))} />
      <span className="tnum text-[12px] text-ink-4">{total(p, seats[p.id], view?.currency)}</span>
      <Button
        variant={p.id === "team" ? "primary" : "secondary"}
        onClick={() => go("checkout", p.id)}
        disabled={!!busy}
        aria-label={`Subscribe to ${p.name}`}
        className="h-9 w-full max-w-[200px]"
      >
        {busy === p.id || busy === "sync" ? <Loader2 className="size-4 animate-spin" /> : <CreditCard className="size-4" />}
        {busy === "sync" ? "Confirming…" : "Subscribe"}
      </Button>
    </div>
  );

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto w-full max-w-[880px] px-4 pt-12 pb-20 sm:px-6 md:px-10">
        <p className="text-[13px] font-medium text-baton">Billing</p>
        <h1 className="mt-2 text-[28px] leading-tight font-semibold tracking-[-0.02em]">Priced per seat. Viewers are always free.</h1>
        <p className="mt-2 max-w-[640px] text-[14px] leading-relaxed text-ink-3">
          Pay for the people who drive agents. Everyone who joins, watches, comments and sends requests is free on every plan, and you
          bring your own LLM key.
        </p>

        {!view ? (
          <div className="mt-10 grid place-items-center">
            <Loader2 className="size-5 animate-spin text-ink-4" />
          </div>
        ) : (
          <>
            {!view.enabled && (
              <div className="mt-8 rounded-xl border border-line bg-panel p-5 text-[13.5px] text-ink-3">
                Billing isn't set up on this server, so every model is available. To charge for it, set{" "}
                <code className="rounded bg-sunken px-1 font-mono text-[12px]">STRIPE_SECRET_KEY</code> (see the README).
              </div>
            )}

            {view.enabled && current && (
              <div className="mt-8 overflow-hidden rounded-2xl border border-line bg-panel">
                <div className="flex flex-wrap items-start gap-4 p-5 sm:p-6">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <h2 className="text-[17px] font-semibold">{current.name}</h2>
                      <Status view={view} />
                    </div>
                    <p className="mt-1 text-[28px] font-semibold tracking-tight">
                      {total(current, view.seats ?? current.min_seats, view.currency)}
                      <span className="ml-1.5 text-[13px] font-normal text-ink-4">
                        {view.seats ?? current.min_seats} seats × {seatPrice(current, view.currency)}
                      </span>
                    </p>
                  </div>
                  <Button onClick={() => go("portal")} disabled={!!busy} className="h-10 px-4">
                    {busy === "portal" ? <Loader2 className="size-4 animate-spin" /> : <CreditCard className="size-4" />}
                    Manage subscription
                  </Button>
                </div>
                {view.current_period_end && (
                  <div className="border-t border-line bg-sunken/50 px-5 py-3 text-[12.5px] text-ink-3 sm:px-6">
                    {view.cancel_at_period_end
                      ? `Cancels on ${date(view.current_period_end)}. Renew any time from Manage subscription.`
                      : `Renews on ${date(view.current_period_end)}`}
                    {view.email ? ` · receipts go to ${view.email}` : ""}
                  </div>
                )}
                {view.status === "past_due" && (
                  <div className="flex items-center gap-2 border-t border-attn/30 bg-attn-soft px-5 py-3 text-[12.5px] text-ink-2 sm:px-6">
                    <AlertTriangle className="size-4 text-attn" />
                    The last renewal didn't go through. Stripe is retrying; update the card under Manage subscription.
                  </div>
                )}
              </div>
            )}

            {view.enabled && !view.active && (
              <div className="mt-8 flex items-center gap-2 text-[13px] text-ink-3">
                Current plan: <span className="font-medium text-ink">Free</span> <Status view={view} />
                {view.has_customer && (
                  <button onClick={() => go("portal")} className="ml-auto text-xs text-ink-3 hover:text-ink">
                    Past invoices <ExternalLink className="inline size-3" />
                  </button>
                )}
              </div>
            )}

            <div className={view.enabled && !view.active ? "mt-3" : "mt-8"}>
              <PlanTable
                plans={plans}
                currency={view.currency}
                highlight={current?.id ?? "team"}
                actions={
                  !view.enabled
                    ? undefined
                    : current
                      ? { [current.id]: <Pill className="bg-live/10 text-live">Your plan</Pill> }
                      : view.active
                        ? undefined
                        : Object.fromEntries(plans.map((p) => [p.id, subscribe(p)]))
                }
              />
              <p className="mt-3 text-[12.5px] text-ink-4">{EVERY_PLAN}</p>
            </div>

            {view.enabled && view.test_mode && (
              <div className="mt-6 rounded-xl border border-dashed border-line-strong p-5">
                <div className="flex items-center gap-2 text-[13px] font-semibold">
                  <FlaskConical className="size-4 text-baton" /> Test mode: no real money moves
                </div>
                <p className="mt-1 text-[12.5px] text-ink-3">
                  Use any of Stripe's test cards with any future expiry date, any CVC and any postal code.
                </p>
                <ul className="mt-3 divide-y divide-line overflow-hidden rounded-lg border border-line bg-panel">
                  {TEST_CARDS.map((c) => (
                    <li key={c.number} className="flex items-center gap-3 px-3 py-2">
                      <button
                        onClick={() => {
                          navigator.clipboard?.writeText(c.number.replace(/ /g, "")).catch(() => {});
                          toast("Card number copied", "info");
                        }}
                        className="font-mono text-[13px] text-ink hover:text-baton"
                        title="Copy"
                      >
                        {c.number}
                      </button>
                      <span className={clsx("ml-auto text-right text-[12px]", c.what === "Succeeds" ? "text-live" : "text-ink-3")}>{c.what}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </>
        )}
      </div>
    </div>
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
