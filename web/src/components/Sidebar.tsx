import { useState } from "react";
import { Link, useLocation } from "wouter";
import { BarChart3, GitFork, Moon, Plus, Presentation, Settings, Sun } from "lucide-react";
import clsx from "clsx";
import { useSessionList } from "../lib/sessions";
import { useIdentity } from "../lib/identity";
import { useTheme } from "../lib/theme";
import { ago } from "../lib/format";
import { Logo } from "./Logo";
import { StatusDot } from "./StatusPill";
import { Avatar } from "./Avatar";
import { IdentityModal } from "./IdentityModal";
import { DeleteSessionButton, canDelete } from "./DeleteSession";

export function Sidebar() {
  const { sessions, loaded } = useSessionList();
  const [loc] = useLocation();
  const { user } = useIdentity();
  const { dark, toggle } = useTheme();
  const [editing, setEditing] = useState(false);

  return (
    <aside className="hidden w-[240px] shrink-0 flex-col border-r border-line bg-panel md:flex">
      <div className="flex h-11 items-center justify-between border-b border-line pr-2 pl-3.5">
        <Link href="/" className="rounded-md">
          <Logo />
        </Link>
        <Link
          href="/"
          className={clsx(
            "grid size-7 place-items-center rounded-md text-ink-3 hover:bg-sunken hover:text-ink",
            loc === "/" && "text-ink",
          )}
          aria-label="New session"
          title="New session"
        >
          <Plus className="size-4" />
        </Link>
      </div>
      <div className="px-2 pt-2">
        <NavRow href="/insights" active={loc === "/insights"}>
          <BarChart3 className="size-3.5 text-ink-3" />
          Insights
        </NavRow>
      </div>
      <div className="flex items-baseline justify-between px-3.5 pt-4 pb-1">
        <span className="text-[11.5px] font-semibold text-ink-3">Sessions</span>
        {sessions.length > 0 && <span className="tnum text-[11px] text-ink-4">{sessions.length}</span>}
      </div>
      <nav className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
        {loaded && sessions.length === 0 && <p className="px-2.5 py-1.5 text-xs text-ink-4">None yet</p>}
        {sessions.map((s) => {
          const active = loc === `/s/${s.id}`;
          const online = s.participants.filter((p) => p.online);
          return (
            <Link
              key={s.id}
              href={`/s/${s.id}`}
              className={clsx(
                "group relative flex flex-col gap-0.5 rounded-md px-2.5 py-1.5",
                active ? "bg-sunken" : "hover:bg-sunken/60",
              )}
            >
              {active && <span className="absolute inset-y-1.5 left-0 w-[2px] rounded-full bg-baton" aria-hidden />}
              <span className="flex items-center gap-2">
                <StatusDot status={s.status} className="size-1.5" />
                <span className={clsx("min-w-0 flex-1 truncate text-[13px]", active ? "text-ink" : "text-ink-2")}>{s.title}</span>
                {canDelete(s, user?.id) && (
                  <DeleteSessionButton session={s} me={user!.id} className="-my-1 -mr-1 opacity-0 group-hover:opacity-100 focus:opacity-100" />
                )}
              </span>
              <span className="flex items-center gap-2 pl-3.5 text-[11px] text-ink-4">
                {s.parent_session_id && (
                  <span className="inline-flex items-center gap-0.5">
                    <GitFork className="size-3" />@{s.fork_seq}
                  </span>
                )}
                <span className="tnum">{ago(s.updated_at)}</span>
                {online.length > 0 && (
                  <span className="ml-auto flex -space-x-1">
                    {online.slice(0, 3).map((p) => (
                      <Avatar key={p.user_id} name={p.name} color={p.color} size={14} />
                    ))}
                  </span>
                )}
              </span>
            </Link>
          );
        })}
      </nav>
      <div className="flex items-center gap-1 border-t border-line px-2 py-1.5">
        {user && (
          <button onClick={() => setEditing(true)} className="flex min-w-0 flex-1 items-center gap-2 rounded-md px-1 py-1 hover:bg-sunken">
            <Avatar name={user.name} color={user.color} size={22} />
            <span className="truncate text-[13px] font-medium">{user.name}</span>
          </button>
        )}
        <Link
          href="/settings"
          className={clsx(
            "grid size-7 place-items-center rounded-md text-ink-3 hover:bg-sunken hover:text-ink",
            loc === "/settings" && "bg-sunken text-ink",
          )}
          aria-label="Settings"
          title="Settings"
        >
          <Settings className="size-4" />
        </Link>
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

function NavRow({ href, active, children }: { href: string; active: boolean; children: React.ReactNode }) {
  return (
    <Link
      href={href}
      className={clsx(
        "relative flex h-7 items-center gap-2 rounded-md px-2.5 text-[13px]",
        active ? "bg-sunken text-ink" : "text-ink-2 hover:bg-sunken/60",
      )}
    >
      {active && <span className="absolute inset-y-1.5 left-0 w-[2px] rounded-full bg-baton" aria-hidden />}
      {children}
    </Link>
  );
}
