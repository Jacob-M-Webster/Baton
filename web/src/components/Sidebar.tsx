import { useEffect, useState } from "react";
import { Link, useLocation } from "wouter";
import { BarChart3, CreditCard, GitFork, Moon, Plus, Presentation, Sun } from "lucide-react";
import clsx from "clsx";
import { useSessionList } from "../lib/sessions";
import { useBilling } from "../lib/billing";
import { useIdentity } from "../lib/identity";
import { useTheme } from "../lib/theme";
import { ago } from "../lib/format";
import { Logo } from "./Logo";
import { StatusDot } from "./StatusPill";
import { Avatar } from "./Avatar";
import { IdentityModal } from "./IdentityModal";

export function Sidebar() {
  const { sessions, loaded } = useSessionList();
  const [loc] = useLocation();
  const { user } = useIdentity();
  const { dark, toggle } = useTheme();
  const billing = useBilling((s) => s.view);
  const loadBilling = useBilling((s) => s.load);
  useEffect(() => {
    loadBilling();
  }, [loadBilling, loc]);
  const [editing, setEditing] = useState(false);

  return (
    <aside className="hidden w-[248px] shrink-0 flex-col border-r border-line bg-panel md:flex">
      <div className="flex h-12 items-center px-4">
        <Link href="/" className="rounded-md outline-offset-4">
          <Logo />
        </Link>
      </div>
      <div className="px-3 pt-1 pb-3">
        <Link
          href="/"
          className="flex h-8 items-center gap-2 rounded-lg border border-line bg-panel px-2.5 text-[13px] font-medium text-ink shadow-[0_1px_0_rgb(0_0_0/0.03)] hover:bg-sunken"
        >
          <Plus className="size-4 text-ink-3" />
          New session
        </Link>
        <Link
          href="/insights"
          className={clsx(
            "mt-1 flex h-8 items-center gap-2 rounded-lg px-2.5 text-[13px] text-ink-2 hover:bg-sunken",
            loc === "/insights" && "bg-sunken font-medium text-ink",
          )}
        >
          <BarChart3 className="size-4 text-ink-3" />
          Insights
        </Link>
        {billing?.enabled && (
          <Link
            href="/billing"
            className={clsx(
              "mt-1 flex h-8 items-center gap-2 rounded-lg px-2.5 text-[13px] text-ink-2 hover:bg-sunken",
              loc === "/billing" && "bg-sunken font-medium text-ink",
            )}
          >
            <CreditCard className="size-4 text-ink-3" />
            Billing
            {billing.required && !billing.active && <span className="ml-auto rounded-full bg-baton-soft px-1.5 text-[10.5px] font-medium text-baton">Free plan</span>}
            {billing.status === "past_due" && <span className="ml-auto size-2 rounded-full bg-attn" title="Payment due" />}
          </Link>
        )}
      </div>
      <div className="px-4 pb-1.5 text-[11px] font-medium tracking-wide text-ink-4 uppercase">Sessions</div>
      <nav className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
        {loaded && sessions.length === 0 && <p className="px-2 py-2 text-xs text-ink-4">No sessions yet.</p>}
        {sessions.map((s) => {
          const active = loc === `/s/${s.id}`;
          const online = s.participants.filter((p) => p.online);
          return (
            <Link
              key={s.id}
              href={`/s/${s.id}`}
              className={clsx(
                "group mb-px flex flex-col gap-1 rounded-lg px-2.5 py-2",
                active ? "bg-sunken" : "hover:bg-sunken/70",
              )}
            >
              <span className="flex items-center gap-2">
                <StatusDot status={s.status} />
                <span className={clsx("min-w-0 flex-1 truncate text-[13px]", active ? "font-medium text-ink" : "text-ink-2")}>
                  {s.title}
                </span>
              </span>
              <span className="flex items-center gap-2 pl-4 text-[11.5px] text-ink-4">
                {s.parent_session_id && (
                  <span className="inline-flex items-center gap-0.5">
                    <GitFork className="size-3" />@{s.fork_seq}
                  </span>
                )}
                <span className="tnum">{ago(s.updated_at)}</span>
                {online.length > 0 && (
                  <span className="ml-auto flex -space-x-1">
                    {online.slice(0, 3).map((p) => (
                      <Avatar key={p.user_id} name={p.name} color={p.color} size={16} />
                    ))}
                  </span>
                )}
              </span>
            </Link>
          );
        })}
      </nav>
      <div className="flex items-center gap-2 border-t border-line px-3 py-2.5">
        {user && (
          <button onClick={() => setEditing(true)} className="flex min-w-0 flex-1 items-center gap-2 rounded-md px-1 py-1 hover:bg-sunken">
            <Avatar name={user.name} color={user.color} size={22} />
            <span className="truncate text-[13px] font-medium">{user.name}</span>
          </button>
        )}
        <Link href="/pitch" className="grid size-7 place-items-center rounded-md text-ink-3 hover:bg-sunken hover:text-ink" aria-label="Pitch deck" title="Pitch deck">
          <Presentation className="size-4" />
        </Link>
        <button onClick={toggle} className="grid size-7 place-items-center rounded-md text-ink-3 hover:bg-sunken hover:text-ink" aria-label="Toggle theme">
          {dark ? <Sun className="size-4" /> : <Moon className="size-4" />}
        </button>
      </div>
      {editing && <IdentityModal onClose={() => setEditing(false)} />}
    </aside>
  );
}
