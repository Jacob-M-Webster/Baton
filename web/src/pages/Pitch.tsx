import { useCallback, useEffect, useState, type ReactNode } from "react";
import { Link } from "wouter";
import QRCode from "qrcode";
import clsx from "clsx";
import { ArrowLeft, ArrowRight, Check, Cpu, Eye, GitFork, Lightbulb, MessageSquare, Radio, RotateCcw, Sparkles } from "lucide-react";
import { api } from "../lib/api";
import { useAccess } from "../lib/access";
import { Logo, BatonMark } from "../components/Logo";
import { Avatar, AgentAvatar } from "../components/Avatar";

/* A short deck that lives inside the product, so the pitch flows straight into the live demo. */

function Slide({ eyebrow, title, children }: { eyebrow?: string; title: ReactNode; children?: ReactNode }) {
  return (
    <div className="flex h-full flex-col justify-center">
      {eyebrow && <p className="text-[15px] font-medium text-baton">{eyebrow}</p>}
      <h2 className="mt-3 max-w-[1100px] text-[52px] leading-[1.05] font-semibold tracking-[-0.03em] text-ink">{title}</h2>
      {children && <div className="mt-12">{children}</div>}
    </div>
  );
}

function Point({ icon, title, children }: { icon: ReactNode; title: string; children: ReactNode }) {
  return (
    <div>
      <div className="grid size-10 place-items-center rounded-xl border border-line bg-panel text-ink-2">{icon}</div>
      <h3 className="mt-4 text-[19px] font-semibold tracking-tight text-ink">{title}</h3>
      <p className="mt-2 text-[16px] leading-relaxed text-ink-3">{children}</p>
    </div>
  );
}

function LogDiagram() {
  const rows = [
    { seq: 14, who: "agent", text: "read_file app/middleware/legacy_throttle.py" },
    { seq: 15, who: "Bob", color: "#db2777", text: "comment: “this middleware is deprecated”" },
    { seq: 16, who: "Alice", color: "#2563eb", text: "steer (from Bob): don't build on LegacyThrottle" },
    { seq: 17, who: "agent", text: "plan updated: write a new token-bucket middleware" },
    { seq: 18, who: "Alice", color: "#2563eb", text: "handed the baton to Bob" },
  ];
  return (
    <div className="grid grid-cols-[1fr_auto_1.4fr] items-center gap-8">
      <div className="space-y-3">
        {[
          ["Alice", "#2563eb", "driving"],
          ["Bob", "#db2777", "suggesting"],
          ["Carol", "#059669", "watching"],
        ].map(([n, c, r]) => (
          <div key={n} className="flex items-center gap-3 rounded-xl border border-line bg-panel px-4 py-3">
            <Avatar name={n} color={c} size={28} />
            <span className="text-[15px] font-medium">{n}</span>
            <span className="ml-auto text-[13px] text-ink-4">{r}</span>
          </div>
        ))}
      </div>
      <div className="flex flex-col items-center gap-2 text-ink-4">
        <span className="text-xs">replay + live</span>
        <ArrowLeft className="size-5" />
        <ArrowRight className="size-5" />
        <span className="text-xs">commands</span>
      </div>
      <div className="overflow-hidden rounded-xl border border-line bg-panel">
        <div className="flex items-center gap-2 border-b border-line px-4 py-2.5 text-[13px] font-medium text-ink-3">
          <Radio className="size-4 text-live" /> Append-only session log
        </div>
        {rows.map((r) => (
          <div key={r.seq} className="flex items-center gap-3 border-b border-line px-4 py-2.5 last:border-0">
            <span className="tnum w-8 font-mono text-[12px] text-ink-4">#{r.seq}</span>
            {r.who === "agent" ? <AgentAvatar size={20} /> : <Avatar name={r.who} color={r.color!} size={20} />}
            <span className="truncate font-mono text-[13px] text-ink-2">{r.text}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function Join() {
  const [origin, setOrigin] = useState(location.origin);
  const [live, setLive] = useState<string | null>(null); // the session to drop judges into, if one is running
  const [qr, setQr] = useState("");
  const code = useAccess((s) => s.code);
  useEffect(() => {
    api
      .info()
      .then((i) => {
        if ((location.hostname === "localhost" || location.hostname === "127.0.0.1") && i.lan_urls[0]) {
          const u = new URL(i.lan_urls[0]);
          u.port = location.port;
          setOrigin(u.origin);
        }
      })
      .catch(() => {});
    // Scanning should land people in the live demo, not on the home page.
    api
      .sessions()
      .then((r) => {
        const active = r.sessions
          .filter((s) => s.status === "running" || s.status === "waiting_input")
          .sort((a, b) => b.updated_at - a.updated_at)[0];
        if (active) setLive(active.id);
      })
      .catch(() => {});
  }, []);
  // With an access code, the link carries it, so one scan gets someone all the way in.
  const url = `${origin}${live ? `/s/${live}` : "/"}${code ? `?code=${encodeURIComponent(code)}` : ""}`;
  useEffect(() => {
    const dark = document.documentElement.classList.contains("dark");
    QRCode.toDataURL(url, { margin: 1, width: 400, color: { dark: dark ? "#ececef" : "#17171a", light: "#00000000" } }).then(setQr).catch(() => {});
  }, [url]);
  return (
    <div className="flex items-center gap-10">
      {qr && <img src={qr} alt="QR code to open Baton" className="size-44 rounded-xl border border-line bg-panel p-3" />}
      <div>
        <p className="text-[16px] text-ink-3">{live ? "Scan to join the live session on your phone and steer it with us" : "Scan to open Baton on your phone or laptop"}</p>
        <p className="mt-2 font-mono text-[20px] text-ink">{origin.replace(/^https?:\/\//, "")}</p>
        <Link href="/" className="mt-6 inline-flex h-11 items-center gap-2 rounded-xl bg-ink px-5 text-[15px] font-medium text-canvas hover:bg-ink/88">
          Start the live demo <ArrowRight className="size-4" />
        </Link>
      </div>
    </div>
  );
}

const SLIDES: (() => ReactNode)[] = [
  () => (
    <div className="flex h-full flex-col justify-center">
      <Logo className="scale-[1.6] origin-left" />
      <h1 className="mt-14 max-w-[880px] text-[76px] leading-[1.0] font-semibold tracking-[-0.04em] text-ink">
        Multiplayer for AI agents.
      </h1>
      <p className="mt-6 max-w-[860px] text-[22px] leading-snug text-ink-3">
        Watch a running agent together, steer it, and pass the baton, on any model.
      </p>
    </div>
  ),
  () => (
    <Slide eyebrow="The problem" title="Agents are single-player.">
      <div className="grid grid-cols-3 gap-10">
        <Point icon={<Eye className="size-5" />} title="Invisible">
          The work lives in one person's terminal tab. Teammates find out what happened from a pull request, after the fact.
        </Point>
        <Point icon={<MessageSquare className="size-5" />} title="Unsteerable">
          The colleague who knows “that middleware is deprecated” has no way to tell the agent before it builds on it.
        </Point>
        <Point icon={<BatonMark className="size-5" />} title="Stranded">
          When the person who started it logs off, the run stalls. There is no hand-off, only a transcript.
        </Point>
      </div>
    </Slide>
  ),
  () => (
    <Slide eyebrow="The insight" title="Make the agent's work a shared, live object.">
      <LogDiagram />
    </Slide>
  ),
  () => (
    <Slide eyebrow="The product" title="Everything a team needs to work with one agent.">
      <div className="grid grid-cols-2 gap-x-14 gap-y-10">
        <Point icon={<Sparkles className="size-5" />} title="Catch up in seconds">
          Join late and get a card: the goal, what's done, what people changed, the open question.
        </Point>
        <Point icon={<Lightbulb className="size-5" />} title="Steer without collisions">
          One driver steers. Everyone else suggests or comments on any step; the driver sends the good ones to the agent.
        </Point>
        <Point icon={<BatonMark className="size-5" />} title="Hand off the baton">
          Pass control in one click. The new driver gets a summary and the decision waiting for them.
        </Point>
        <Point icon={<GitFork className="size-5" />} title="Rewind and fork">
          Scrub to any step to see the session as it was, then fork a new branch of the work from there.
        </Point>
      </div>
    </Slide>
  ),
  () => (
    <Slide eyebrow="Model-agnostic" title="Same log, any model.">
      <div className="grid grid-cols-[1.2fr_1fr] gap-14">
        <div className="space-y-3">
          {[
            ["A", "Claude", "Anthropic Messages API, prompt caching"],
            ["G", "Gemini", "Native Gemini API, thought summaries and signatures"],
            ["O", "OpenAI", "Chat Completions, streaming tool calls"],
            ["L", "Local weights", "Ollama, vLLM, LM Studio, llama.cpp"],
            ["+", "Any compatible endpoint", "OpenRouter, Groq, a team GPU box"],
          ].map(([g, n, d]) => (
            <div key={n} className="flex items-center gap-4 rounded-xl border border-line bg-panel px-4 py-3.5">
              <span className="grid size-8 place-items-center rounded-lg border border-line bg-sunken font-mono text-sm font-semibold text-ink-2">{g}</span>
              <span className="text-[16px] font-medium">{n}</span>
              <span className="ml-auto text-[14px] text-ink-4">{d}</span>
            </div>
          ))}
        </div>
        <div className="space-y-6 text-[17px] leading-relaxed text-ink-3">
          <p>
            <span className="font-medium text-ink">Switch models mid-session.</span> Context is rebuilt from the log every turn, so a run can start on a
            local model and hand the hard part to Claude.
          </p>
          <p>
            <span className="font-medium text-ink">The same mechanism gives us</span> resume after a crash and automatic compaction of long sessions.
          </p>
        </div>
      </div>
    </Slide>
  ),
  () => (
    <Slide eyebrow="Why now" title="The bottleneck moved from writing code to coordinating agents.">
      <div className="grid grid-cols-3 gap-10">
        <Point icon={<RotateCcw className="size-5" />} title="Runs got long">
          Agents now work for many minutes on real repositories. Long runs need checkpoints, hand-offs and review.
        </Point>
        <Point icon={<Cpu className="size-5" />} title="Models got interchangeable">
          Teams mix frontier APIs and local weights for cost and privacy. The collaboration layer can't belong to one vendor.
        </Point>
        <Point icon={<Check className="size-5" />} title="Oversight became a requirement">
          Every human decision is attributed and exportable, which is what security and compliance teams ask for first.
        </Point>
      </div>
    </Slide>
  ),
  () => (
    <Slide eyebrow="Business model" title="Seats for collaborators. Bring your own model.">
      <div className="grid grid-cols-3 gap-6">
        {[
          ["Free", "Individuals", ["Unlimited solo sessions", "Up to 3 collaborators", "Any model, your keys"]],
          ["Team", "Per collaborator seat", ["Shared workspaces and history", "Slack hand-offs and decision alerts", "Session analytics"]],
          ["Enterprise", "Annual contract", ["SSO, roles, audit log export", "Self-hosted runners and sandboxes", "Retention and data controls"]],
        ].map(([name, unit, items]) => (
          <div key={name as string} className={clsx("rounded-2xl border bg-panel p-6", name === "Team" ? "border-ink" : "border-line")}>
            <div className="text-[20px] font-semibold">{name}</div>
            <div className="mt-1 text-[14px] text-ink-4">{unit}</div>
            <ul className="mt-5 space-y-2.5">
              {(items as string[]).map((i) => (
                <li key={i} className="flex gap-2.5 text-[15px] text-ink-2">
                  <Check className="mt-1 size-4 shrink-0 text-ink-3" /> {i}
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
      <p className="mt-8 text-[16px] text-ink-3">We don't resell tokens, so our margins don't depend on any model provider's pricing.</p>
    </Slide>
  ),
  () => (
    <Slide eyebrow="Where it goes" title="The system of record for human and agent work.">
      <div className="grid grid-cols-3 gap-10">
        <Point icon={<Radio className="size-5" />} title="Ingest any agent">
          Any agent can already stream into a session through the ingest API. Adapters for Claude Code and Codex are next.
        </Point>
        <Point icon={<Sparkles className="size-5" />} title="Learn from interventions">
          Where do humans step in, and how fast? Insights already answers it from the log, per team and per model.
        </Point>
        <Point icon={<RotateCcw className="size-5" />} title="Durable by default">
          Multi-day runs on a workflow engine, with the same replay and hand-off semantics.
        </Point>
      </div>
    </Slide>
  ),
  () => (
    <Slide eyebrow="Live demo" title="Two laptops. One agent. Pass the baton.">
      <Join />
    </Slide>
  ),
];

export function Pitch() {
  const [i, setI] = useState(() => {
    const n = Number(new URLSearchParams(location.search).get("slide"));
    return Number.isFinite(n) && n > 0 ? Math.min(n - 1, SLIDES.length - 1) : 0;
  });
  const go = useCallback((d: number) => setI((x) => Math.max(0, Math.min(SLIDES.length - 1, x + d))), []);
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if (["ArrowRight", "PageDown", " "].includes(e.key)) go(1);
      if (["ArrowLeft", "PageUp"].includes(e.key)) go(-1);
    };
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [go]);
  const Current = SLIDES[i];
  return (
    <div className="fixed inset-0 z-30 flex flex-col bg-canvas">
      <div className="flex min-h-0 flex-1 items-center justify-center p-10" onClick={() => go(1)}>
        <div className="aspect-[16/9] w-full max-w-[1280px]" onClick={(e) => e.stopPropagation()}>
          <div key={i} className="animate-rise h-full px-16">
            <Current />
          </div>
        </div>
      </div>
      <div className="flex items-center gap-4 px-8 pb-6">
        <Link href="/" className="text-[13px] text-ink-4 hover:text-ink-2">
          Exit
        </Link>
        <div className="mx-auto flex gap-1.5">
          {SLIDES.map((_, j) => (
            <button
              key={j}
              onClick={() => setI(j)}
              className={clsx("h-1.5 rounded-full transition-all", j === i ? "w-6 bg-ink" : "w-1.5 bg-line-strong hover:bg-ink-4")}
              aria-label={`Slide ${j + 1}`}
            />
          ))}
        </div>
        <span className="tnum text-[13px] text-ink-4">
          {i + 1} / {SLIDES.length}
        </span>
      </div>
    </div>
  );
}
