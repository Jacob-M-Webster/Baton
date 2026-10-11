import { useEffect, useMemo, useState } from "react";
import clsx from "clsx";
import { Code2, Download, FileDiff, FilePlus2 } from "lucide-react";
import type { BatonEvent, CatchUp, Participant, Session, WorkspaceFile } from "../lib/types";
import { currentPlan, stats, workspaceVersion } from "../lib/derive";
import { api } from "../lib/api";
import { compact, duration, modelLabel } from "../lib/format";
import { useSession } from "../lib/session";
import { Avatar } from "../components/Avatar";
import { BatonMark } from "../components/Logo";
import { CatchUpBody } from "./CatchUp";
import { CommentsPanel } from "./Comments";
import { StepIcon, type Ctx } from "./items";
import { showCode } from "./code/store";

type Tab = "overview" | "files" | "comments";

export function RightPanel({
  session,
  events,
  participants,
  card,
  ctx,
  onJump,
}: {
  session: Session;
  events: BatonEvent[];
  participants: Participant[];
  card: CatchUp | null;
  ctx: Ctx;
  onJump: (seq: number) => void;
}) {
  const [tab, setTab] = useState<Tab>("overview");
  const commentCount = useSession((s) => Object.keys(s.comments).length);
  return (
    <aside className="hidden w-[340px] shrink-0 flex-col border-l border-line bg-panel lg:flex">
      <div className="flex h-11 shrink-0 items-center gap-1 border-b border-line px-2">
        {(["overview", "files", "comments"] as Tab[]).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={clsx(
              "relative h-11 px-2.5 text-[13px] capitalize",
              tab === t ? "font-medium text-ink" : "text-ink-3 hover:text-ink-2",
            )}
          >
            {t}
            {t === "comments" && commentCount > 0 && <span className="tnum ml-1.5 text-xs text-ink-4">{commentCount}</span>}
            {tab === t && <span className="absolute inset-x-2.5 -bottom-px h-0.5 rounded-full bg-ink" />}
          </button>
        ))}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {tab === "overview" && <Overview session={session} events={events} participants={participants} card={card} onJump={onJump} />}
        {tab === "files" && <Files session={session} events={events} />}
        {tab === "comments" && <CommentsPanel ctx={ctx} events={events} onJump={onJump} />}
      </div>
    </aside>
  );
}

function Block({ title, children, right }: { title: string; children: React.ReactNode; right?: React.ReactNode }) {
  return (
    <section className="border-b border-line px-4 py-4">
      <div className="mb-2.5 flex items-center justify-between">
        <h3 className="text-[11px] font-medium tracking-wide text-ink-4 uppercase">{title}</h3>
        {right}
      </div>
      {children}
    </section>
  );
}

function Overview({
  session,
  events,
  participants,
  card,
  onJump,
}: {
  session: Session;
  events: BatonEvent[];
  participants: Participant[];
  card: CatchUp | null;
  onJump: (seq: number) => void;
}) {
  const plan = useMemo(() => currentPlan(events), [events]);
  const st = useMemo(() => stats(events), [events]);
  const [now, setNow] = useState(Date.now() / 1000);
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now() / 1000), 1000);
    return () => window.clearInterval(t);
  }, []);
  const elapsed = st.started ? ((st.ended ?? (session.status === "running" ? now : events[events.length - 1]?.ts ?? now)) - st.started) * 1000 : 0;
  const done = plan.filter((s) => s.status === "done").length;

  return (
    <div>
      {card && (
        <Block title="Summary">
          <CatchUpBody card={{ ...card, changed: [], next: plan.length ? [] : card.next }} people={participants} onJump={onJump} compact />
        </Block>
      )}
      {plan.length > 0 && (
        <Block title="Plan" right={<span className="tnum text-xs text-ink-4">{done}/{plan.length}</span>}>
          <div className="mb-3 h-1 overflow-hidden rounded-full bg-sunken">
            <div className="h-full rounded-full bg-ink transition-all duration-500" style={{ width: `${(done / plan.length) * 100}%` }} />
          </div>
          <ol className="space-y-1.5">
            {plan.map((s, i) => (
              <li key={i} className="flex items-start gap-2 text-[13px]">
                <StepIcon status={s.status} />
                <span className={clsx("leading-snug", s.status === "done" ? "text-ink-3" : s.status === "in_progress" ? "font-medium text-ink" : "text-ink-2")}>
                  {s.title}
                </span>
              </li>
            ))}
          </ol>
        </Block>
      )}
      <Block title="People">
        <ul className="space-y-2">
          {participants.map((p) => (
            <li key={p.user_id} className="flex items-center gap-2.5 text-[13px]">
              <Avatar name={p.name} color={p.color} size={24} online={p.online} />
              <div className="min-w-0 flex-1">
                <div className="truncate font-medium text-ink">{p.name}</div>
                <div className="text-[11.5px] text-ink-4">
                  {p.typing
                    ? "typing…"
                    : p.file && p.online
                      ? `has ${p.file.split("/").pop()} open`
                      : p.viewing_seq !== null
                      ? `rewound to step #${p.viewing_seq}`
                      : p.focus_seq !== null && p.online
                        ? `reading step #${p.focus_seq}`
                        : p.online
                          ? "watching live"
                          : "away"}
                </div>
              </div>
              {p.user_id === session.driver_id ? (
                <span className="inline-flex items-center gap-1 rounded-full bg-baton-soft px-2 py-0.5 text-[11px] font-medium text-baton">
                  <BatonMark className="size-3" /> Driver
                </span>
              ) : (
                <span className="text-[11.5px] text-ink-4 capitalize">{p.role}</span>
              )}
            </li>
          ))}
        </ul>
      </Block>
      <Block
        title="Session"
        right={
          <a href={`/api/sessions/${session.id}/export`} className="inline-flex items-center gap-1 text-xs text-ink-3 hover:text-ink" title="Download the full audit log">
            <Download className="size-3" /> Export log
          </a>
        }
      >
        <dl className="grid grid-cols-2 gap-x-4 gap-y-3">
          <Stat label="Elapsed" value={duration(Math.round(elapsed))} />
          <Stat label="Agent turns" value={String(st.turns)} />
          <Stat label="Tool calls" value={String(st.toolCalls)} />
          <Stat label="Human interventions" value={String(st.interventions)} />
          <Stat
            label="Tokens in / out"
            value={st.inputTokens + st.outputTokens ? `${compact(st.inputTokens)} / ${compact(st.outputTokens)}` : "—"}
          />
          <Stat label="Files changed" value={String(st.filesChanged)} />
        </dl>
        {st.models.length > 0 && (
          <div className="mt-3 text-xs text-ink-3">
            Models: <span className="text-ink-2">{st.models.map(modelLabel).join(" → ")}</span>
          </div>
        )}
      </Block>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-[11.5px] text-ink-4">{label}</dt>
      <dd className="tnum mt-0.5 text-[15px] font-medium text-ink">{value}</dd>
    </div>
  );
}

function Files({ session, events }: { session: Session; events: BatonEvent[] }) {
  const [files, setFiles] = useState<WorkspaceFile[]>([]);
  const version = useMemo(() => workspaceVersion(events), [events]);
  useEffect(() => {
    api.files(session.id).then((r) => setFiles(r.files)).catch(() => {});
  }, [session.id, version]);
  const changed = files.filter((f) => f.state !== "same");
  const rest = files.filter((f) => f.state === "same");
  if (session.provider === "external") {
    return <p className="p-4 text-xs text-ink-4">This session's agent runs elsewhere, so its files live on its own machine.</p>;
  }
  return (
    <div className="p-2">
      <button
        onClick={() => showCode()}
        className="mb-2 flex w-full items-center justify-center gap-1.5 rounded-lg border border-line bg-panel px-3 py-2 text-[12.5px] font-medium text-ink hover:bg-sunken"
      >
        <Code2 className="size-3.5" /> Open the code view
      </button>
      <div className="px-2 pt-2 pb-1.5 text-[11px] font-medium tracking-wide text-ink-4 uppercase">Changed · {changed.length}</div>
      {changed.length === 0 && <p className="px-2 pb-2 text-xs text-ink-4">No changes yet.</p>}
      {changed.map((f) => (
        <FileRow key={f.path} f={f} onClick={() => showCode(f.path)} />
      ))}
      <div className="px-2 pt-4 pb-1.5 text-[11px] font-medium tracking-wide text-ink-4 uppercase">Repository</div>
      {rest.map((f) => (
        <FileRow key={f.path} f={f} onClick={() => showCode(f.path)} />
      ))}
    </div>
  );
}

function FileRow({ f, onClick }: { f: { path: string; state: string }; onClick: () => void }) {
  return (
    <button onClick={onClick} className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-sunken">
      {f.state === "added" ? <FilePlus2 className="size-3.5 text-live" /> : f.state === "modified" ? <FileDiff className="size-3.5 text-attn" /> : <span className="size-3.5" />}
      <span className={clsx("min-w-0 flex-1 truncate font-mono text-[12px]", f.state === "same" ? "text-ink-3" : "text-ink")}>{f.path}</span>
      {f.state !== "same" && <span className={clsx("text-[11px] font-medium", f.state === "added" ? "text-live" : "text-attn")}>{f.state === "added" ? "A" : "M"}</span>}
    </button>
  );
}
