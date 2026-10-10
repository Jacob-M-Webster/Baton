import { useEffect, useState } from "react";
import { useLocation } from "wouter";
import { ArrowRight, ArrowUpRight, Cpu, History, Users } from "lucide-react";
import { api } from "../lib/api";
import { useIdentity } from "../lib/identity";
import { refreshSessions, useSessionList } from "../lib/sessions";
import { ago, modelLabel } from "../lib/format";
import { Button, Kbd } from "../components/Button";
import { ModelPicker, ProviderGlyph, useModelCatalog } from "../components/ModelPicker";
import { StatusPill } from "../components/StatusPill";
import { Avatar } from "../components/Avatar";
import { toast } from "../components/Toasts";

const EXAMPLES = [
  "Add rate limiting to this API and write tests.",
  "Add pagination to GET /notes with tests.",
  "Find and fix any input validation gaps in POST /notes.",
];

export function Home() {
  const { user } = useIdentity();
  const [, navigate] = useLocation();
  const providers = useModelCatalog();
  const { sessions } = useSessionList();
  const [task, setTask] = useState(EXAMPLES[0]);
  const [repo, setRepo] = useState("notes-api");
  const [repos, setRepos] = useState<{ id: string; description: string }[]>([]);
  const [choice, setChoice] = useState<{ provider: string; model: string } | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.repos().then((r) => setRepos(r.repos)).catch(() => {});
  }, []);

  // Default to the best configured model: Claude, then OpenAI, then local, then the offline demo.
  useEffect(() => {
    if (choice || !providers.length) return;
    const order = ["anthropic", "openai", "local", "demo"];
    for (const id of order) {
      const p = providers.find((x) => x.id === id && x.configured && x.models.length);
      if (p) {
        const preferred = p.models.find((m) => m.includes("sonnet")) || p.models[0];
        setChoice({ provider: p.id, model: preferred });
        return;
      }
    }
  }, [providers, choice]);

  const start = async () => {
    if (!user || !choice || !task.trim()) return;
    setBusy(true);
    try {
      const s = await api.createSession({ user_id: user.id, task, repo, ...choice });
      refreshSessions();
      navigate(`/s/${s.id}`);
    } catch (e) {
      toast((e as Error).message, "error");
      setBusy(false);
    }
  };

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto w-full max-w-[880px] px-6 pt-16 pb-20 md:px-10">
        <p className="text-[13px] font-medium text-baton">Shared agent sessions</p>
        <h1 className="mt-2 text-[34px] leading-[1.1] font-semibold tracking-[-0.025em] text-ink">
          Multiplayer for AI agents.
        </h1>
        <p className="mt-3 max-w-[600px] text-[15px] leading-relaxed text-ink-3">
          Agents run on the server, not in one person's terminal. Share a link and your team can watch the work live,
          steer it, and hand off the baton, on any model.
        </p>

        <div className="mt-9 rounded-2xl border border-line bg-panel shadow-[0_1px_2px_rgb(0_0_0/0.04),0_12px_32px_-20px_rgb(0_0_0/0.18)]">
          <textarea
            value={task}
            onChange={(e) => setTask(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) start();
            }}
            rows={3}
            placeholder="What should the agent do?"
            className="block w-full resize-none rounded-t-2xl bg-transparent px-5 pt-4 pb-2 text-[15px] leading-relaxed outline-none placeholder:text-ink-4"
          />
          <div className="flex flex-wrap gap-1.5 px-5 pb-3">
            {EXAMPLES.map((ex) => (
              <button
                key={ex}
                onClick={() => setTask(ex)}
                className="rounded-full border border-line px-2.5 py-1 text-xs text-ink-3 hover:border-line-strong hover:text-ink"
              >
                {ex}
              </button>
            ))}
          </div>
          <div className="flex flex-wrap items-center gap-2 border-t border-line px-3 py-2.5">
            <label className="inline-flex h-9 items-center gap-2 rounded-lg border border-line bg-panel pr-1 pl-2.5 text-[13px]">
              <span className="text-ink-4">Repo</span>
              <select
                value={repo}
                onChange={(e) => setRepo(e.target.value)}
                className="h-7 rounded-md bg-transparent font-mono text-[12.5px] text-ink outline-none"
              >
                {(repos.length ? repos : [{ id: "notes-api", description: "" }]).map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.id}
                  </option>
                ))}
              </select>
            </label>
            {choice && <ModelPicker provider={choice.provider} model={choice.model} onChange={(provider, model) => setChoice({ provider, model })} />}
            <div className="ml-auto flex items-center gap-3">
              <span className="hidden text-xs text-ink-4 sm:inline">
                <Kbd>⌘</Kbd> <Kbd>Enter</Kbd>
              </span>
              <Button variant="primary" className="h-9 px-4" onClick={start} disabled={busy || !choice || !task.trim()}>
                Start session
                <ArrowRight className="size-4" />
              </Button>
            </div>
          </div>
        </div>

        <div className="mt-8 grid gap-6 sm:grid-cols-3">
          <Feature icon={<History className="size-4" />} title="Live and replayable">
            Every token, tool call and human decision is an event. Join late, scrub back, fork from any step.
          </Feature>
          <Feature icon={<Users className="size-4" />} title="One driver, many hands">
            Collaborators suggest and comment. The driver steers, approves decisions, and hands off in one click.
          </Feature>
          <Feature icon={<Cpu className="size-4" />} title="Any model">
            Claude, GPT or local weights through one adapter layer. Switch mid-session; the log carries the context.
          </Feature>
        </div>

        {sessions.length > 0 && (
          <section className="mt-14">
            <div className="mb-3 flex items-baseline justify-between">
              <h2 className="text-[13px] font-semibold text-ink">Recent sessions</h2>
              <span className="text-xs text-ink-4">{sessions.length} total</span>
            </div>
            <div className="overflow-hidden rounded-xl border border-line bg-panel">
              {sessions.slice(0, 8).map((s, i) => (
                <button
                  key={s.id}
                  onClick={() => navigate(`/s/${s.id}`)}
                  className={`group flex w-full items-center gap-4 px-4 py-3 text-left hover:bg-sunken/60 ${i ? "border-t border-line" : ""}`}
                >
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[13.5px] font-medium text-ink">{s.title}</div>
                    <div className="mt-1 flex items-center gap-2 text-xs text-ink-4">
                      <ProviderGlyph provider={s.provider} className="size-4 text-[9px]" />
                      <span>{modelLabel(s.model)}</span>
                      <span>·</span>
                      <span className="tnum">{ago(s.updated_at)}</span>
                      {s.progress.total > 0 && (
                        <>
                          <span>·</span>
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
                  <div className="w-[150px] text-right">
                    <StatusPill status={s.status} />
                  </div>
                  <ArrowUpRight className="size-4 text-ink-4 opacity-0 group-hover:opacity-100" />
                </button>
              ))}
            </div>
          </section>
        )}
      </div>
    </div>
  );
}

function Feature({ icon, title, children }: { icon: React.ReactNode; title: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="flex items-center gap-2 text-[13px] font-semibold text-ink">
        <span className="grid size-7 place-items-center rounded-lg border border-line bg-panel text-ink-2">{icon}</span>
        {title}
      </div>
      <p className="mt-2 text-[13px] leading-relaxed text-ink-3">{children}</p>
    </div>
  );
}
