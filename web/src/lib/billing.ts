import { create } from "zustand";

export type PlanId = "team" | "enterprise";

export interface Plan {
  id: PlanId;
  name: string;
  seat: number; // cents per seat per month
  interval: "month" | "year"; // how often it's charged
  min_seats: number;
}

export interface BillingView {
  enabled: boolean;
  required: boolean;
  test_mode: boolean;
  currency: string;
  plans: Plan[];
  plan: PlanId | null; // the subscribed plan
  seats: number | null;
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

export function money(cents: number, currency = "usd") {
  return new Intl.NumberFormat(undefined, {
    style: "currency",
    currency: currency.toUpperCase(),
    minimumFractionDigits: cents % 100 ? 2 : 0,
  }).format(cents / 100);
}

/** "$25/seat/mo" */
export function seatPrice(plan: Plan, currency = "usd") {
  return `${money(plan.seat, currency)}/seat/mo`;
}

/** What `seats` seats cost per charge: "$750/mo" for Team, "$30,000/yr" for Enterprise. */
export function total(plan: Plan, seats: number, currency = "usd") {
  const year = plan.interval === "year";
  return `${money(plan.seat * seats * (year ? 12 : 1), currency)}/${year ? "yr" : "mo"}`;
}

/** Paid models are locked when billing is required and the workspace has no active plan. */
export function locked(view: BillingView | null, provider: string | undefined) {
  return !!view?.required && !view.active && !!provider && provider !== "demo" && provider !== "external";
}
