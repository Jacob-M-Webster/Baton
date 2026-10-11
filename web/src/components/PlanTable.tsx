
import { Check, Minus } from "lucide-react";
import clsx from "clsx";
import { money, type Plan, type PlanId } from "../lib/billing";

type Tier = "free" | PlanId;
const TIERS: Tier[] = ["free", "team", "enterprise"];

// Defaults for when the server's plans aren't known (the pitch deck, billing off); the server's win when present.
export const DEFAULT_PLANS: Plan[] = [
  { id: "team", name: "Team", seat: 2500, interval: "month", min_seats: 1 },
  { id: "enterprise", name: "Enterprise", seat: 5000, interval: "year", min_seats: 50 },
];

export const WHO: Record<Tier, string> = {
  free: "Individuals and side projects",
  team: "Engineering teams using agents",
  enterprise: "Larger orgs, multiple agents",
};

// Only what differs between tiers; what every tier shares goes in the line under the table.
const ROWS: [string, Record<Tier, string | boolean>][] = [
  ["Active sessions", { free: "1–2", team: "Unlimited", enterprise: "Unlimited" }],
  ["Catch-up cards, comments, forks", { free: "Basic", team: true, enterprise: true }],
  ["Log retention", { free: "7 days", team: "1 year", enterprise: "Custom" }],
  ["Slack notifications", { free: false, team: true, enterprise: true }],
  ["SSO, audit log export", { free: false, team: false, enterprise: true }],
  ["Self-host / VPC, custom agent adapters", { free: false, team: false, enterprise: true }],
];

export const EVERY_PLAN = "Every plan: unlimited viewers for free; steer, interrupt and hand off; bring your own LLM key.";

function Cell({ v }: { v: string | boolean }) {
  if (v === true) return <Check className="mx-auto size-4 text-live" aria-label="Included" />;
  if (v === false) return <Minus className="mx-auto size-4 text-ink-4/60" aria-label="Not included" />;
  return <>{v}</>;
}

/** Free, Team and Enterprise side by side: one row per perk, so the differences read across. */
export function PlanTable({
  plans,
  currency = "usd",
  highlight = "team",
  dense,
}: {
  plans?: Plan[];
  currency?: string;
  highlight?: Tier;
  dense?: boolean;
}) {
  const byId = Object.fromEntries((plans?.length ? plans : DEFAULT_PLANS).map((p) => [p.id, p])) as Record<PlanId, Plan>;
  const col = (t: Tier) => clsx("px-4 text-center", t === highlight && "bg-sunken/60");
  const pad = dense ? "py-2.5" : "py-3";
  const head = (t: Tier) => {
    const p = t === "free" ? null : byId[t];
    return (
      <>
        <div className={clsx("font-semibold text-ink", dense ? "text-[18px]" : "text-[16px]")}>{p ? p.name : "Free"}</div>
        <div className={clsx("mt-1 font-semibold tracking-tight text-ink", dense ? "text-[26px]" : "text-[24px]")}>
          {p ? money(p.seat, currency) : money(0, currency)}
          {p && <span className="ml-1 text-[12px] font-normal text-ink-4">/seat/mo</span>}
        </div>
        <div className="mt-0.5 text-[12px] text-ink-4">
          {!p ? "Forever" : p.interval === "year" ? `Billed annually · ${p.min_seats}-seat min.` : "Billed monthly"}
        </div>
        <div className="mt-2 text-[12px] leading-snug text-ink-3">{WHO[t]}</div>
      </>
    );
  };
  return (
    <>
      {/* Phones: one card per tier, the same rows as label and value. The deck (dense) is always wide. */}
      {!dense && (
        <div className="space-y-4 sm:hidden">
          {TIERS.map((t) => (
            <div key={t} className={clsx("overflow-hidden rounded-xl border bg-panel", t === highlight ? "border-ink/40" : "border-line")}>
              <div className={clsx("p-4 text-center", t === highlight && "bg-sunken/60")}>{head(t)}</div>
              <dl className="divide-y divide-line border-t border-line">
                {ROWS.map(([label, v]) => (
                  <div key={label} className="flex items-center gap-4 px-4 py-2.5 text-[13.5px]">
                    <dt className="min-w-0 flex-1 text-ink-3">{label}</dt>
                    <dd className="shrink-0 text-right text-ink-2">
                      <Cell v={v[t]} />
                    </dd>
                  </div>
                ))}
              </dl>
            </div>
          ))}
        </div>
      )}
      <div className={clsx("overflow-x-auto rounded-xl border border-line bg-panel", !dense && "hidden sm:block")}>
        <table className="w-full min-w-[600px] table-fixed border-collapse text-left">
          <thead>
            <tr className="align-top">
              <th className="w-[28%] px-4 py-4" />
              {TIERS.map((t) => (
                <th key={t} scope="col" className={clsx(col(t), "py-4 font-normal", t === highlight && "border-t-2 border-t-ink")}>
                  {head(t)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {ROWS.map(([label, v]) => (
              <tr key={label} className="border-t border-line">
                <th scope="row" className={clsx("px-4 font-normal text-ink-2", pad, dense ? "text-[15px]" : "text-[13.5px]")}>
                  {label}
                </th>
                {TIERS.map((t) => (
                  <td key={t} className={clsx(col(t), pad, "text-ink-2", dense ? "text-[15px]" : "text-[13.5px]")}>
                    <Cell v={v[t]} />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
