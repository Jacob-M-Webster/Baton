import { useEffect, useState } from "react";
import clsx from "clsx";
import { compact, duration, modelLabel } from "../lib/format";
import { ProviderGlyph } from "../components/ModelPicker";

interface InsightsData {
  sessions: number;
  done: number;
  active: number;
  people: number;
  interventions: number;
  per_session: number;
  median_first_intervention_s: number | null;
  by_kind: { kind: string; label: string; count: number }[];
  position: number[];
  models: { provider: string; model: string; sessions: number; turns: number; tokens_in: number; tokens_out: number }[];
}

/* Single-series charts use one validated hue (blue 450 light / 400 dark); text stays in ink tokens. */
const BAR = "var(--viz-1)";

export function Insights() {
  const [data, setData] = useState<InsightsData | null>(null);
  useEffect(() => {
    const load = () =>
      fetch("/api/insights")
        .then((r) => r.json())
        .then(setData)
        .catch(() => {});
    load();
    const t = window.setInterval(load, 5000);
    return () => window.clearInterval(t);
  }, []);

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto w-full max-w-[960px] px-6 pt-12 pb-20 md:px-10">
        <p className="text-[13px] font-medium text-baton">Insights</p>
        <h1 className="mt-2 text-[28px] leading-tight font-semibold tracking-[-0.02em]">How your team works with agents</h1>
        <p className="mt-2 max-w-[620px] text-[14px] leading-relaxed text-ink-3">
          Every steer, decision and hand-off is in the log, so you can see where people step in, how fast, and on which
          models. Computed live from all sessions on this server.
        </p>

        {!data ? (
          <div className="mt-10 h-40 animate-pulse rounded-xl bg-sunken" />
        ) : data.sessions === 0 ? (
          <p className="mt-10 text-sm text-ink-3">No sessions yet. Start one and come back.</p>
        ) : (
          <>
            <div className="mt-9 grid grid-cols-2 gap-px overflow-hidden rounded-xl border border-line bg-line sm:grid-cols-4">
              <Tile label="Sessions" value={String(data.sessions)} note={`${data.done} done · ${data.active} active`} />
              <Tile label="Human interventions" value={String(data.interventions)} note={`${data.per_session} per session`} />
              <Tile
                label="Time to first intervention"
                value={data.median_first_intervention_s === null ? "—" : duration(Math.round(data.median_first_intervention_s * 1000))}
                note="median, from session start"
              />
              <Tile label="People" value={String(data.people)} note="across all sessions" />
            </div>

            <div className="mt-6 grid gap-6 lg:grid-cols-2">
              <Card title="How people steered" subtitle="Interventions by kind, all sessions">
                <KindBars rows={data.by_kind} />
              </Card>
              <Card title="When people step in" subtitle="Interventions by how far into the session they happened">
                <PositionColumns bins={data.position} />
              </Card>
            </div>

            <Card title="Models" subtitle="Agent turns and tokens per model. Sessions can use more than one." className="mt-6">
              <table className="w-full text-[13px]">
                <thead>
                  <tr className="text-left text-[11.5px] text-ink-4">
                    <th className="pb-2 font-medium">Model</th>
                    <th className="pb-2 text-right font-medium">Sessions</th>
                    <th className="pb-2 text-right font-medium">Agent turns</th>
                    <th className="pb-2 text-right font-medium">Tokens in</th>
                    <th className="pb-2 text-right font-medium">Tokens out</th>
                  </tr>
                </thead>
                <tbody className="tnum">
                  {data.models.map((m) => (
                    <tr key={`${m.provider}-${m.model}`} className="border-t border-line">
                      <td className="py-2">
                        <span className="inline-flex items-center gap-2">
                          <ProviderGlyph provider={m.provider} />
                          {modelLabel(m.model)}
                        </span>
                      </td>
                      <td className="py-2 text-right">{m.sessions}</td>
                      <td className="py-2 text-right">{m.turns}</td>
                      <td className="py-2 text-right">{compact(m.tokens_in)}</td>
                      <td className="py-2 text-right">{compact(m.tokens_out)}</td>
                    </tr>
                  ))}
                  {data.models.length === 0 && (
                    <tr>
                      <td colSpan={5} className="py-3 text-ink-4">
                        No model turns recorded yet.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </Card>
          </>
        )}
      </div>
    </div>
  );
}

function Tile({ label, value, note }: { label: string; value: string; note: string }) {
  return (
    <div className="bg-panel px-5 py-4">
      <div className="text-[12px] text-ink-3">{label}</div>
      <div className="mt-1 text-[26px] font-semibold tracking-tight text-ink">{value}</div>
      <div className="mt-0.5 text-[12px] text-ink-4">{note}</div>
    </div>
  );
}

function Card({ title, subtitle, children, className }: { title: string; subtitle: string; children: React.ReactNode; className?: string }) {
  return (
    <section className={clsx("rounded-xl border border-line bg-panel p-5", className)}>
      <h2 className="text-[14px] font-semibold text-ink">{title}</h2>
      <p className="mt-0.5 text-[12px] text-ink-4">{subtitle}</p>
      <div className="mt-5">{children}</div>
    </section>
  );
}

/** Horizontal bars, values at the tip. Labels are long, so bars run left to right. */
function KindBars({ rows }: { rows: InsightsData["by_kind"] }) {
  const max = Math.max(1, ...rows.map((r) => r.count));
  return (
    <div className="space-y-2.5">
      {rows.map((r) => (
        <div key={r.kind} className="group grid grid-cols-[minmax(0,190px)_1fr] items-center gap-3" title={`${r.label}: ${r.count}`}>
          <span className="truncate text-[12.5px] text-ink-2">{r.label}</span>
          <span className="flex items-center gap-2">
            <span
              className="h-[14px] rounded-r-[4px] transition-opacity group-hover:opacity-80"
              style={{ width: `${(r.count / max) * 82}%`, minWidth: r.count ? 3 : 0, background: BAR }}
            />
            <span className="tnum text-[12px] text-ink-3">{r.count}</span>
          </span>
        </div>
      ))}
    </div>
  );
}

/** Ten columns from the start to the end of a session; hover for exact counts, or switch to the table. */
function PositionColumns({ bins }: { bins: number[] }) {
  const [hover, setHover] = useState<number | null>(null);
  const [table, setTable] = useState(false);
  const max = Math.max(1, ...bins);
  const top = Math.max(1, Math.ceil(max));
  const label = (i: number) => `${i * 10}–${(i + 1) * 10}%`;
  if (table) {
    return (
      <div>
        <table className="tnum w-full text-[12.5px]">
          <tbody>
            {bins.map((b, i) => (
              <tr key={i} className="border-t border-line first:border-0">
                <td className="py-1 text-ink-3">{label(i)} of the way through</td>
                <td className="py-1 text-right text-ink">{b}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <button onClick={() => setTable(false)} className="mt-3 text-xs text-ink-3 hover:text-ink">
          Show chart
        </button>
      </div>
    );
  }
  return (
    <div>
      <div className="relative h-[150px] border-b border-line">
        <div className="absolute inset-x-0 top-0 border-t border-line/70" />
        <span className="tnum absolute -top-2 right-0 bg-panel pl-1 text-[11px] text-ink-4">{top}</span>
        <div className="absolute inset-0 flex items-end gap-[2px]">
          {bins.map((b, i) => (
            <div
              key={i}
              className="relative flex h-full flex-1 items-end justify-center"
              onMouseEnter={() => setHover(i)}
              onMouseLeave={() => setHover(null)}
            >
              <div
                className="w-full max-w-[24px] rounded-t-[4px]"
                style={{ height: `${(b / top) * 100}%`, minHeight: b ? 3 : 0, background: BAR, opacity: hover === null || hover === i ? 1 : 0.55 }}
              />
              {hover === i && (
                <div
                  className="pointer-events-none absolute z-10 rounded-md border border-line bg-raised px-2 py-1 text-[11.5px] whitespace-nowrap shadow-md"
                  style={{ bottom: `calc(${(b / top) * 100}% + 6px)` }}
                >
                  <span className="text-ink-3">{label(i)}:</span> <span className="tnum font-medium text-ink">{b}</span>
                </div>
              )}
            </div>
          ))}
        </div>
      </div>
      <div className="mt-1.5 flex justify-between text-[11px] text-ink-4">
        <span>Start</span>
        <span>Middle</span>
        <span>End</span>
      </div>
      <button onClick={() => setTable(true)} className="mt-3 text-xs text-ink-3 hover:text-ink">
        Show as table
      </button>
    </div>
  );
}
