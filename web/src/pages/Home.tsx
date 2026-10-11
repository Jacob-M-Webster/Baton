import { useEffect, useState } from "react";
import { useLocation } from "wouter";
import { GitBranch, Lock } from "lucide-react";
import { api } from "../lib/api";
import { locked, price, useBilling } from "../lib/billing";
import { useIdentity } from "../lib/identity";
import { refreshSessions, useSessionList } from "../lib/sessions";
import { ago, modelLabel } from "../lib/format";
import { Button, Kbd } from "../components/Button";
import { ModelPicker, ProviderGlyph, useModelCatalog } from "../components/ModelPicker";
import { StatusPill } from "../components/StatusPill";
import { Avatar } from "../components/Avatar";
import { toast } from "../components/Toasts";
import { DeleteSessionButton, canDelete } from "../components/DeleteSession";

const GITHUB = "__github"; // the repo menu's "GitHub repository…" entry
const LAST_GITHUB = "baton:last-github";

function remembered(): string {
  try {
    return localStorage.getItem(LAST_GITHUB) || "";
  } catch {
    return "";
  }
}

const DEMO_REPO = "notes-api"; // where the offline demo model's rehearsed task lives

export function Home() {
  const { user } = useIdentity();
  const [, navigate] = useLocation();
  const providers = useModelCatalog();
  const { sessions } = useSessionList();
  const [task, setTask] = useState("");
  const [repo, setRepo] = useState("demo");
  const [github, setGithub] = useState(remembered);
  const [branch, setBranch] = useState("");
  const [repos, setRepos] = useState<{ id: string; description: string }[]>([]);
  const [choice, setChoice] = useState<{ provider: string; model: string } | null>(null);
  const demoLocked = choice?.provider === "demo" && repos.some((r) => r.id === DEMO_REPO);
  const onGithub = repo === GITHUB && !demoLocked; // the offline demo can't run on a GitHub clone
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api
      .repos()
      .then((r) => {
        setRepos(r.repos);
        // Keep the selection on a repo the server actually has.
        setRepo((cur) => (cur === GITHUB || r.repos.some((x) => x.id === cur) ? cur : r.repos[0]?.id ?? cur));
      })
      .catch(() => {});
  }, []);

  // Default to the best configured model: Claude, then Gemini, then OpenAI, then local, then the offline demo.
  // Without a subscription (when billing is on), start on the free offline demo instead.
  const billing = useBilling((s) => s.view);
  const billingLoaded = useBilling((s) => s.loaded);
  const loadBilling = useBilling((s) => s.load);
  useEffect(() => {
    loadBilling();
  }, [loadBilling]);
  const paywalled = locked(billing, choice?.provider);
  useEffect(() => {
    if (choice || !providers.length || !billingLoaded) return;
    const order = billing?.required && !billing.active ? ["demo"] : ["anthropic", "gemini", "openai", "local", "demo"];
    for (const id of order) {
      const p = providers.find((x) => x.id === id && x.configured && x.models.length);
      if (p) {
        const preferred = p.models.find((m) => m.includes("sonnet")) || p.models[0];
        setChoice({ provider: p.id, model: preferred });
        return;
      }
    }
  }, [providers, choice, billing, billingLoaded]);

  const ready = !!choice && !!task.trim() && (!onGithub || !!github.trim());
  const start = async () => {
    if (!user || !choice || !ready) return;
    setBusy(true);
    try {
      const where = onGithub ? { repo: "", github: github.trim(), ref: branch.trim() || undefined } : { repo: demoLocked ? DEMO_REPO : repo };
      const s = await api.createSession({ user_id: user.id, task, ...where, ...choice });
      if (onGithub) {
        try {
          localStorage.setItem(LAST_GITHUB, github.trim());
        } catch {
          /* private window: nothing to remember */
        }
      }
      refreshSessions();
      navigate(`/s/${s.id}`);
    } catch (e) {
      toast((e as Error).message, "error");
      setBusy(false);
    }
  };

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto w-full max-w-[760px] px-4 pt-[14vh] pb-20 sm:px-6">
        <h1 className="text-[22px] leading-tight font-semibold tracking-[-0.015em] text-ink">New session</h1>
        <p className="mt-1 text-[13.5px] text-ink-3">The agent runs on the server. Share the link to work on it together.</p>

        <div className="mt-5 rounded-xl border border-line bg-panel focus-within:border-line-strong">
          <textarea
            value={task}
            onChange={(e) => setTask(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) start();
            }}
            rows={3}
            placeholder="What should the agent do?"
            className="block w-full resize-none rounded-t-xl bg-transparent px-4 pt-3.5 pb-2 text-base leading-relaxed outline-none placeholder:text-ink-4 sm:text-[14.5px]"
          />
          {choice?.provider === "demo" && (
            <p className="px-4 pb-3 text-xs text-ink-4">The offline demo only runs its rehearsed task: rate limiting for notes-api.</p>
          )}
          <div className="flex flex-wrap items-center gap-2 border-t border-line px-2.5 py-2">
            <label className="inline-flex h-8 items-center gap-2 rounded-md border border-line bg-canvas pr-1 pl-2.5 text-[13px]">
              <span className="text-ink-4">Repo</span>
              <select
                // The offline demo model always runs its rehearsed task on notes-api (the server enforces it too).
                value={demoLocked ? DEMO_REPO : repo}
                disabled={demoLocked}
                title={demoLocked ? "The offline demo model runs on notes-api" : undefined}
                onChange={(e) => setRepo(e.target.value)}
                className="h-7 rounded-md bg-transparent font-mono text-[12.5px] text-ink outline-none disabled:opacity-100"
              >
                {(repos.length ? repos : [{ id: "demo", description: "" }]).map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.id}
                  </option>
                ))}
                <option value={GITHUB}>GitHub repository…</option>
              </select>
            </label>
            {onGithub && (
              <div className="flex h-8 min-w-[260px] flex-1 items-center rounded-md border border-line bg-canvas text-[13px] focus-within:border-ink-3">
                <input
                  autoFocus
                  value={github}
                  onChange={(e) => setGithub(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") start();
                  }}
                  placeholder="owner/repo or https://github.com/owner/repo"
                  aria-label="GitHub repository"
                  spellCheck={false}
                  className="h-full min-w-0 flex-1 bg-transparent px-2.5 font-mono text-[12.5px] text-ink outline-none placeholder:font-sans placeholder:text-ink-4"
                />
                <label className="flex h-full items-center gap-1 border-l border-line pl-2 text-ink-4" title="Branch or tag (default branch if empty)">
                  <GitBranch className="size-3.5 shrink-0" />
                  <input
                    value={branch}
                    onChange={(e) => setBranch(e.target.value)}
                    placeholder="default"
                    aria-label="Branch or tag"
                    spellCheck={false}
                    className="h-full w-[84px] bg-transparent pr-2 font-mono text-[12.5px] text-ink outline-none placeholder:font-sans placeholder:text-ink-4"
                  />
                </label>
              </div>
            )}
            {choice && <ModelPicker provider={choice.provider} model={choice.model} onChange={(provider, model) => setChoice({ provider, model })} />}
            <div className="ml-auto flex items-center gap-3">
              <span className="hidden text-xs text-ink-4 sm:inline">
                <Kbd>⌘</Kbd> <Kbd>Enter</Kbd>
              </span>
              <Button variant="primary" className="h-8 px-3.5" onClick={start} disabled={busy || !ready || paywalled}>
                {busy && onGithub ? "Cloning…" : "Start session"}
              </Button>
            </div>
          </div>
        </div>

        {paywalled && billing && (
          <div className="mt-3 flex flex-wrap items-center gap-3 rounded-xl border border-baton/30 bg-baton-soft/60 px-4 py-2.5 text-[13px]">
            <Lock className="size-4 text-baton" />
            <span className="min-w-0 flex-1 text-ink-2">
              {modelLabel(choice!.model)} is part of <span className="font-medium text-ink">{billing.plan.name}</span> ({price(billing.plan)}). The
              offline demo model is free.
            </span>
            <Button size="sm" variant="baton" onClick={() => navigate("/billing")}>
              Subscribe
            </Button>
          </div>
        )}

        {sessions.length > 0 && (
          <section className="mt-12">
            <h2 className="mb-2 px-1 text-[12px] font-semibold text-ink-3">Recent</h2>
            <div className="overflow-hidden rounded-lg border border-line bg-panel">
              {sessions.slice(0, 8).map((s, i) => (
                <div key={s.id} className={`group flex items-center hover:bg-sunken/60 ${i ? "border-t border-line" : ""}`}>
                <button
                  onClick={() => navigate(`/s/${s.id}`)}
                  className="flex min-w-0 flex-1 items-center gap-4 py-2.5 pl-3.5 text-left"
                >
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[13px] font-medium text-ink">{s.title}</div>
                    <div className="mt-0.5 flex items-center gap-2 text-[11.5px] text-ink-4">
                      <ProviderGlyph provider={s.provider} className="size-4 text-[9px]" />
                      <span>{modelLabel(s.model)}</span>
                      <span className="tnum">{ago(s.updated_at)}</span>
                      {s.progress.total > 0 && (
                        <>
                          <span className="tnum">
                            {s.progress.done}/{s.progress.total} steps
                          </span>
                        </>
                      )}
                    </div>
                  </div>
                  <div className="flex -space-x-1.5">
                    {s.participants.slice(0, 4).map((p) => (
                      <Avatar key={p.user_id} name={p.name} color={p.color} size={22} online={p.online} />
                    ))}
                  </div>
                  <div className="hidden w-[150px] text-right sm:block">
                    <StatusPill status={s.status} decision={s.needs_decision} />
                  </div>
                </button>
                <div className="w-10 shrink-0 pr-3 pl-1">
                  {user && canDelete(s, user.id) && (
                    <DeleteSessionButton session={s} me={user.id} className="opacity-0 group-hover:opacity-100 focus:opacity-100" />
                  )}
                </div>
                </div>
              ))}
            </div>
          </section>
        )}
      </div>
    </div>
  );
}

