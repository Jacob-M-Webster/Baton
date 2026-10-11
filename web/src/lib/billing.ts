import { create } from "zustand";

export interface BillingView {
  enabled: boolean;
  required: boolean;
  test_mode: boolean;
  plan: { name: string; amount: number; currency: string; interval: string };
  active: boolean;
  status: string | null;
  current_period_end: number | null;
  cancel_at_period_end: boolean;
  email: string | null;
  has_customer: boolean;
}

interface BillingState {
  view: BillingView | null;
  loaded: boolean; // tried at least once, whether or not it worked
  load: () => Promise<void>;
}

/** The workspace's subscription, as the server sees it (Stripe is the source of truth). */
export const useBilling = create<BillingState>((set) => ({
  view: null,
  loaded: false,
  load: async () => {
    try {
      const r = await fetch("/api/billing");
      if (r.ok) set({ view: await r.json() });
    } catch {
      /* offline: leave as is */
    }
    set({ loaded: true });
  },
}));

export function price(plan: BillingView["plan"]) {
  const amount = new Intl.NumberFormat(undefined, {
    style: "currency",
    currency: plan.currency.toUpperCase(),
    minimumFractionDigits: plan.amount % 100 ? 2 : 0,
  }).format(plan.amount / 100);
  return `${amount}/${plan.interval === "month" ? "mo" : plan.interval}`;
}

/** Paid models are locked when billing is required and the workspace has no active plan. */
export function locked(view: BillingView | null, provider: string | undefined) {
  return !!view?.required && !view.active && !!provider && provider !== "demo" && provider !== "external";
}
