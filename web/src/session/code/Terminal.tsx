import { useEffect, useLayoutEffect, useRef, useState } from "react";
import clsx from "clsx";
import { ChevronDown, Loader2, Square, SquareTerminal } from "lucide-react";
import type { Participant } from "../../lib/types";
import type { Run } from "../../lib/derive";
import { AgentAvatar, Avatar } from "../../components/Avatar";

/**
 * One terminal for the session's workspace. It shows everything that ran there, by the agent or by
 * people, and the driver can run commands of their own. Those land in the log, so the agent sees them.
 */
export function TerminalPanel({
  runs,
  open,
  onToggle,
  canRun,
  driverName,
  people,
  provider,
  send,
}: {
  runs: Run[];
  open: boolean;
  onToggle: () => void;
  canRun: boolean;
  driverName?: string;
  people: Record<string, Participant>;
  provider?: string;
  send: (m: Record<string, unknown>) => boolean;
}) {
  const [cmd, setCmd] = useState("");
  const [hist, setHist] = useState<number | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const mine = runs.filter((r) => r.actor !== "agent").map((r) => r.command);
  const humanRunning = runs.some((r) => r.running && r.actor !== "agent");
  const last = runs[runs.length - 1];

  useLayoutEffect(() => {
    const el = scroller.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [runs.length, last?.running, open]);

  useEffect(() => {
    if (open && canRun) input.current?.focus({ preventScroll: true });
  }, [open, canRun]);

  const submit = () => {
    const c = cmd.trim();
    if (!c || humanRunning) return;
    if (send({ type: "run_command", command: c })) {
      setCmd("");
      setHist(null);
    }
  };

  return (
    <div className={clsx("flex shrink-0 flex-col border-t border-line bg-[#111113] text-[#d6d6db]", open ? "h-[240px]" : "h-9")}>
      <button onClick={onToggle} className="flex h-9 shrink-0 items-center gap-2 px-3 text-left text-[12px] text-[#a1a1aa] hover:text-white">
        <SquareTerminal className="size-3.5" />
        <span className="font-medium">Terminal</span>
        <span className="text-[#71717a]">· shared workspace</span>
        {last?.running && (
          <span className="inline-flex items-center gap-1.5 text-[#e4e4e7]">
            <Loader2 className="size-3 animate-spin" />
            {last.actor === "agent" ? "agent" : people[last.actor]?.name || "someone"} is running <span className="max-w-[260px] truncate font-mono">{last.command}</span>
          </span>
        )}
        <ChevronDown className={clsx("ml-auto size-3.5 transition-transform", !open && "rotate-180")} />
      </button>
      {open && (
        <>
          <div ref={scroller} className="min-h-0 flex-1 overflow-y-auto px-3 pb-2 font-mono text-[11.5px] leading-[1.6]">
            {runs.length === 0 && <p className="py-1 text-[#71717a]">Nothing has run in this workspace yet.</p>}
            {runs.map((r) => {
              const who = r.actor === "agent" ? null : people[r.actor];
              return (
                <div key={r.seq} className="py-1">
                  <div className="flex items-center gap-2">
                    {who ? <Avatar name={who.name} color={who.color} size={14} /> : <AgentAvatar size={14} provider={provider} />}
                    <span className="text-[#71717a]">$</span>
                    <span className="min-w-0 flex-1 break-all text-white">{r.command}</span>
                    {r.running ? (
                      <Loader2 className="size-3 shrink-0 animate-spin text-[#a1a1aa]" />
                    ) : r.cancelled ? (
                      <span className="shrink-0 text-[#ff7b7b]">stopped</span>
                    ) : r.exitCode !== undefined ? (
                      <span className={clsx("shrink-0", r.exitCode === 0 ? "text-[#5bd28a]" : "text-[#ff7b7b]")}>exit {r.exitCode}</span>
                    ) : null}
                  </div>
                  {r.output && (
                    <pre className="mt-0.5 pl-[22px] whitespace-pre-wrap text-[#c4c4cc]">
                      {r.output.split("\n").map((l, i) => (
                        <span key={i} className={clsx(/\bok$|^OK/.test(l) && "text-[#5bd28a]", /FAIL|Error|Traceback/.test(l) && "text-[#ff7b7b]")}>
                          {l}
                          {"\n"}
                        </span>
                      ))}
                    </pre>
                  )}
                </div>
              );
            })}
          </div>
          <form
            className="flex h-9 shrink-0 items-center gap-2 border-t border-white/10 px-3"
            onSubmit={(e) => {
              e.preventDefault();
              submit();
            }}
          >
            <span className="font-mono text-[12px] text-[#71717a]">$</span>
            <input
              ref={input}
              value={cmd}
              disabled={!canRun}
              onChange={(e) => setCmd(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "ArrowUp" && mine.length) {
                  e.preventDefault();
                  const i = hist === null ? mine.length - 1 : Math.max(0, hist - 1);
                  setHist(i);
                  setCmd(mine[i]);
                } else if (e.key === "ArrowDown" && hist !== null) {
                  e.preventDefault();
                  const i = hist + 1;
                  setHist(i < mine.length ? i : null);
                  setCmd(i < mine.length ? mine[i] : "");
                }
              }}
              placeholder={
                canRun
                  ? humanRunning
                    ? "Waiting for the running command…"
                    : "Run a command in the workspace, e.g. python -m unittest"
                  : `Only the driver can run commands${driverName ? ` (${driverName})` : ""}. Ask for the baton to use the terminal.`
              }
              className="h-full min-w-0 flex-1 bg-transparent font-mono text-[12px] text-white outline-none placeholder:text-[#71717a] disabled:cursor-not-allowed"
              spellCheck={false}
              autoComplete="off"
            />
            {canRun && humanRunning && (
              <button
                type="button"
                onClick={() => send({ type: "stop_command" })}
                className="inline-flex h-6 items-center gap-1 rounded-md border border-[#ff7b7b]/40 px-2 text-[11px] text-[#ff9b9b] hover:border-[#ff7b7b]"
              >
                <Square className="size-2.5 fill-current" /> Stop
              </button>
            )}
          </form>
        </>
      )}
    </div>
  );
}
