import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { Link } from "wouter";
import QRCode from "qrcode";
import clsx from "clsx";
import { ArrowRight } from "lucide-react";
import "@fontsource/instrument-serif/400.css";
import "@fontsource/instrument-serif/400-italic.css";
import { api } from "../lib/api";
import { useAccess } from "../lib/access";
import { money } from "../lib/billing";
import { Logo } from "../components/Logo";
import { DEFAULT_PLANS, WHO } from "../components/PlanTable";
import codeShot from "../assets/deck/code.webp";
import phoneJoin from "../assets/deck/phone-join.webp";
import phoneSteer from "../assets/deck/phone-steer.webp";
import commentShot from "../assets/deck/comment.webp";
import handoffShot from "../assets/deck/handoff.webp";

/* A few quiet slides to sit behind the people talking: pictures of the product, the architecture, the price and a
   QR code that drops the room into the live session. Every slide is laid out on a fixed 1280×720 stage that scales
   to whatever screen it's projected on. */

const W = 1280;
const H = 720;

/** Text in the deck's display serif. */
const serif: CSSProperties = { fontFamily: '"Instrument Serif", ui-serif, Georgia, serif', fontWeight: 400 };

function Serif({ children, className, italic }: { children: ReactNode; className?: string; italic?: boolean }) {
  return (
    <span className={className} style={{ ...serif, fontStyle: italic ? "italic" : undefined }}>
      {children}
    </span>
  );
}

/** A small typewritten label, like a figure number in the margin. */
function Mark({ children, className }: { children: ReactNode; className?: string }) {
  return <span className={clsx("font-mono text-[11px] tracking-[0.14em] text-[#8a8378] uppercase", className)}>{children}</span>;
}

/** A hand-drawn baton stroke that draws itself in. */
function Stroke({ className, d = "M4 14 C 70 6, 160 4, 296 9" }: { className?: string; d?: string }) {
  return (
    <svg viewBox="0 0 300 20" preserveAspectRatio="none" className={clsx("pointer-events-none absolute overflow-visible", className)} aria-hidden>
      <path d={d} fill="none" stroke="#f15a24" strokeWidth="7" strokeLinecap="round" pathLength={1} className="deck-draw" />
    </svg>
  );
}

/** A note written beside a picture, with a thin curved arrow pointing at it. */
function Note({ x, y, children, arrow, className }: { x: number; y: number; children: ReactNode; arrow?: string; className?: string }) {
  return (
    <>
      {arrow && (
        <svg className="pointer-events-none absolute inset-0 overflow-visible" width={W} height={H} aria-hidden>
          <path d={arrow} fill="none" stroke="#9b9387" strokeWidth="1.3" strokeLinecap="round" markerEnd="url(#deck-tip)" />
        </svg>
      )}
      <div className={clsx("absolute text-[25px] leading-tight text-[#5d574e]", className)} style={{ left: x, top: y, ...serif, fontStyle: "italic" }}>
        {children}
      </div>
    </>
  );
}

function Browser({ src, alt, className, style }: { src: string; alt: string; className?: string; style?: CSSProperties }) {
  return (
    <figure
      className={clsx("absolute overflow-hidden rounded-[11px] bg-white ring-1 ring-black/[0.07]", className)}
      style={{ boxShadow: "0 1px 2px rgb(60 50 30 / 0.06), 0 24px 60px -18px rgb(60 50 30 / 0.28)", ...style }}
    >
      <div className="flex h-[26px] items-center gap-[6px] border-b border-black/[0.06] bg-[#f6f4f0] px-3">
        {[0, 1, 2].map((i) => (
          <span key={i} className="size-[9px] rounded-full bg-[#dcd7cf]" />
        ))}
      </div>
      <img src={src} alt={alt} className="block w-full" draggable={false} />
    </figure>
  );
}

function Phone({ src, alt, width, className, style }: { src: string; alt: string; width: number; className?: string; style?: CSSProperties }) {
  return (
    <figure
      className={clsx("absolute rounded-[34px] bg-[#1d1c1a] p-[7px] pt-[22px]", className)}
      style={{ width: width + 14, boxShadow: "0 30px 60px -20px rgb(40 30 10 / 0.45), 0 2px 4px rgb(40 30 10 / 0.12)", ...style }}
    >
      <span className="absolute top-[8px] left-1/2 h-[7px] w-[52px] -translate-x-1/2 rounded-full bg-black/80" />
      <img src={src} alt={alt} className="block w-full rounded-[27px] rounded-t-[14px]" draggable={false} />
    </figure>
  );
}

/** A screenshot crop, set on the page like a print. */
function Print({ src, alt, x, y, w, tilt = 0 }: { src: string; alt: string; x: number; y: number; w: number; tilt?: number }) {
  return (
    <figure
      className="absolute overflow-hidden rounded-[9px] bg-white ring-1 ring-black/[0.07]"
      style={{ left: x, top: y, width: w, transform: `rotate(${tilt}deg)`, boxShadow: "0 1px 2px rgb(60 50 30 / 0.06), 0 22px 50px -20px rgb(60 50 30 / 0.3)" }}
    >
      <img src={src} alt={alt} className="block w-full" draggable={false} />
    </figure>
  );
}

function Caption({ n, x, y, w = 360, children }: { n: string; x: number; y: number; w?: number; children: ReactNode }) {
  return (
    <div className="absolute flex items-baseline gap-3" style={{ left: x, top: y, width: w }}>
      <Mark className="text-[#f15a24]">{n}</Mark>
      <Serif className="text-[24px] leading-tight text-[#2b2823]">{children}</Serif>
    </div>
  );
}

/* ── 1. Cover ─────────────────────────────────────────────────────────────────────────────────────────── */

function Cover() {
  return (
    <>
      <div className="absolute" style={{ left: 72, top: 172 }}>
        <h1 className="text-[#1d1b18]" style={{ ...serif, fontSize: 88, lineHeight: 0.98, letterSpacing: "-0.015em" }}>
          Multi-user
          <br />
          <span className="relative inline-block italic">
            coding agents.
            <Stroke className="-bottom-[10px] left-0 h-[20px] w-[96%]" />
          </span>
        </h1>
        <p className="mt-9 max-w-[380px] text-[18px] leading-[1.5] text-[#6f685e]">
          One coding agent, run in the open. Watch it together, steer it, and pass the baton.
        </p>
      </div>

      <Browser src={codeShot} alt="Baton's code view: the agent finished, eleven tests pass" style={{ left: 600, top: 128, width: 620 }} />
      <Phone src={phoneJoin} alt="Someone following the session on a phone" width={150} style={{ left: 540, top: 352, transform: "rotate(-4deg)" }} />

      <Note x={1034} y={66} arrow="M1100 100 C 1110 112, 1112 122, 1104 134">
        Alice, driving
      </Note>
      <Note x={292} y={604} arrow="M494 626 C 516 626, 532 612, 540 592" className="text-right">
        anyone, on their phone
      </Note>
    </>
  );
}

/* ── 2. Moments ───────────────────────────────────────────────────────────────────────────────────────── */

function Moments() {
  return (
    <>
      <div className="absolute" style={{ left: 72, top: 60 }}>
        <Serif className="text-[54px] leading-none text-[#1d1b18]">
          One agent, <Serif italic>many hands.</Serif>
        </Serif>
      </div>

      <Print src={commentShot} alt="Bob comments on the agent's plan: use a token bucket" x={72} y={196} w={470} tilt={-1.2} />
      <Caption n="01" x={84} y={448}>
        Bob flags the step he knows is wrong.
      </Caption>

      <Print src={handoffShot} alt="Bob gets a hand-off card with the open question" x={588} y={248} w={360} tilt={0.8} />
      <Caption n="02" x={600} y={524} w={340}>
        Alice hands off. The context comes with it.
      </Caption>

      <Phone src={phoneSteer} alt="Someone steers the agent from a phone on an open floor" width={190} style={{ left: 1004, top: 112, transform: "rotate(2.5deg)" }} />
      <Caption n="03" x={1000} y={472} w={220}>
        Anyone in the room steers it from a phone.
      </Caption>

      {/* the baton passing from one picture to the next */}
      <svg className="pointer-events-none absolute inset-0 overflow-visible" width={W} height={H} aria-hidden>
        <path d="M520 186 C 560 150, 620 170, 652 232" fill="none" stroke="#f15a24" strokeWidth="1.6" strokeDasharray="2 7" strokeLinecap="round" markerEnd="url(#deck-tip-baton)" />
        <path d="M930 236 C 950 178, 976 160, 1000 160" fill="none" stroke="#f15a24" strokeWidth="1.6" strokeDasharray="2 7" strokeLinecap="round" markerEnd="url(#deck-tip-baton)" />
      </svg>
    </>
  );
}

/* ── 3. Compared ──────────────────────────────────────────────────────────────────────────────────────── */

type Score = 0 | 1 | 2 | null; // none, partly, yes, doesn't apply

const KINDS = [
  { name: "Terminal agents", eg: "Claude Code, Codex CLI" },
  { name: "IDE agents", eg: "Cursor, Copilot" },
  { name: "Cloud agents", eg: "Devin, Copilot coding agent" },
  { name: "Screen share", eg: "Zoom, Meet" },
];

const ROWS_COMPARED: [string, Score[]][] = [
  ["Teammates watch it live", [0, 0, 1, 2]],
  ["Join late, catch up in seconds", [0, 0, 1, 0]],
  ["Comment on a specific step", [0, 0, 1, 0]],
  ["Several people steer it, with credit", [0, 0, 1, 0]],
  ["Hand off control mid-run", [0, 0, 0, 1]],
  ["Rewind and fork from any step", [1, 1, 0, 0]],
  ["Any model, switch mid-run", [1, 2, 1, null]],
];

function Dot({ s, baton }: { s: Score; baton?: boolean }) {
  if (s === null) return <span className="text-[16px] text-[#c9c1b4]">–</span>;
  const ink = baton ? "#f15a24" : "#2b2823";
  return (
    <svg viewBox="0 0 16 16" className="size-[15px]" aria-label={["No", "Partly", "Yes"][s]}>
      {s === 0 && <circle cx="8" cy="8" r="6.2" fill="none" stroke="#cdc5b8" strokeWidth="1.3" />}
      {s === 1 && (
        <>
          <circle cx="8" cy="8" r="6.2" fill="none" stroke={ink} strokeWidth="1.3" />
          <path d="M8 1.8 A6.2 6.2 0 0 0 8 14.2 Z" fill={ink} />
        </>
      )}
      {s === 2 && <circle cx="8" cy="8" r="6.9" fill={ink} />}
    </svg>
  );
}

function Compared() {
  const first = 330;
  const col = (1136 - first) / 5;
  const top = 178;
  const head = 70;
  const row = 50;
  return (
    <>
      <div className="absolute" style={{ left: 72, top: 56 }}>
        <Mark>Compared</Mark>
        <div className="mt-3">
          <Serif className="text-[46px] leading-none text-[#1d1b18]">
            Not another agent. <Serif italic>The room around one.</Serif>
          </Serif>
        </div>
      </div>

      {/* Baton's column, washed in its color */}
      <div
        className="absolute rounded-[14px] bg-[#f15a24]/[0.06] ring-1 ring-[#f15a24]/20"
        style={{ left: 72 + first + col * 4 + 6, top: top - 8, width: col - 12, height: head + row * ROWS_COMPARED.length + 16 }}
      />

      <div className="absolute" style={{ left: 72, top, width: 1136 }}>
        <div className="flex border-b border-[#e4ded4]" style={{ height: head }}>
          <div style={{ width: first }} />
          {KINDS.map((k) => (
            <div key={k.name} className="px-2 text-center" style={{ width: col }}>
              <div className="text-[15px] font-semibold text-[#24221e]">{k.name}</div>
              <div className="mt-1 text-[12px] leading-snug text-[#9b9387]">{k.eg}</div>
            </div>
          ))}
          <div className="relative text-center" style={{ width: col }}>
            <div className="inline-block">
              <Logo />
            </div>
            <div className="mt-1 text-[12px] text-[#c2552c]">works with any of them</div>
          </div>
        </div>
        {ROWS_COMPARED.map(([label, scores]) => (
          <div key={label} className="flex items-center border-b border-[#efe9df] last:border-0" style={{ height: row }}>
            <div className="text-[16px] text-[#3a3731]" style={{ width: first }}>
              {label}
            </div>
            {scores.map((s, j) => (
              <div key={j} className="grid place-items-center" style={{ width: col }}>
                <Dot s={s} />
              </div>
            ))}
            <div className="grid place-items-center" style={{ width: col }}>
              <Dot s={2} baton />
            </div>
          </div>
        ))}
      </div>

      <div className="absolute flex items-center gap-5 text-[12px] text-[#9b9387]" style={{ left: 72, top: top + head + row * ROWS_COMPARED.length + 24 }}>
        <span className="flex items-center gap-1.5">
          <Dot s={2} /> yes
        </span>
        <span className="flex items-center gap-1.5">
          <Dot s={1} /> partly, or only for the person who started it
        </span>
        <span className="flex items-center gap-1.5">
          <Dot s={0} /> no
        </span>
        <span>· typical out-of-the-box behavior for each kind of tool, October 2026</span>
      </div>
    </>
  );
}

/* ── 4. Architecture ──────────────────────────────────────────────────────────────────────────────────── */

const LINE = "#a59d90";

/** A labelled component box. */
function Node({ x, y, w, h, title, sub, strong }: { x: number; y: number; w: number; h: number; title: string; sub?: string; strong?: boolean }) {
  return (
    <div
      className={clsx("absolute flex flex-col justify-center rounded-[8px] border bg-white px-3", strong ? "border-[#f15a24]/50" : "border-[#d9d2c6]")}
      style={{ left: x, top: y, width: w, height: h }}
    >
      <div className="text-[14px] leading-tight font-semibold text-[#24221e]">{title}</div>
      {sub && <div className="mt-[3px] text-[11.5px] leading-snug text-[#7c756a]">{sub}</div>}
    </div>
  );
}

/** A database, drawn the traditional way. */
function Cylinder({ x, y, w, h, title, sub, strong }: { x: number; y: number; w: number; h: number; title: string; sub: string; strong?: boolean }) {
  const ry = 9;
  const stroke = strong ? "#f15a24" : "#cdc5b8";
  return (
    <>
      <svg className="absolute overflow-visible" style={{ left: x, top: y }} width={w} height={h} aria-hidden>
        <path d={`M0.5 ${ry} V${h - ry} A${w / 2 - 0.5} ${ry} 0 0 0 ${w - 0.5} ${h - ry} V${ry}`} fill="white" stroke={stroke} strokeOpacity={strong ? 0.6 : 1} />
        <ellipse cx={w / 2} cy={ry} rx={w / 2 - 0.5} ry={ry - 0.5} fill={strong ? "#fdf0ea" : "#f6f3ee"} stroke={stroke} strokeOpacity={strong ? 0.6 : 1} />
      </svg>
      <div className="absolute flex flex-col items-center justify-center text-center" style={{ left: x, top: y + ry * 2, width: w, height: h - ry * 2 }}>
        <div className="text-[14px] font-semibold text-[#24221e]">{title}</div>
        <div className="mt-[3px] text-[11.5px] leading-snug text-[#7c756a]">{sub}</div>
      </div>
    </>
  );
}

/** An arrow label that sits on its line. */
function Wire({ x, y, children }: { x: number; y: number; children: ReactNode }) {
  return (
    <div className="absolute -translate-x-1/2 -translate-y-1/2 bg-[#faf8f4] px-1.5 font-mono text-[10.5px] whitespace-nowrap text-[#8a8378]" style={{ left: x, top: y }}>
      {children}
    </div>
  );
}

function Architecture() {
  const arrow = { fill: "none", stroke: LINE, strokeWidth: 1.3, markerEnd: "url(#deck-tip)" } as const;
  const both = { ...arrow, markerStart: "url(#deck-tip)" } as const;
  return (
    <>
      <div className="absolute" style={{ left: 72, top: 56 }}>
        <Mark>Architecture</Mark>
        <div className="mt-3">
          <Serif className="text-[46px] leading-none text-[#1d1b18]">
            One server. <Serif italic>One log.</Serif>
          </Serif>
        </div>
      </div>

      {/* boundaries */}
      <div className="absolute rounded-[14px] border border-dashed border-[#cfc6b7]" style={{ left: 268, top: 168, width: 664, height: 486 }} />
      <div className="absolute" style={{ left: 320, top: 178 }}>
        <Mark className="text-[10px]">AWS Lightsail · Ubuntu · systemd</Mark>
      </div>
      <div className="absolute rounded-[10px] border border-[#d9d2c6] bg-[#f3efe8]/80" style={{ left: 436, top: 206, width: 476, height: 262 }} />
      <div className="absolute" style={{ left: 452, top: 218 }}>
        <div className="text-[14px] font-semibold text-[#24221e]">Baton server</div>
        <div className="text-[11.5px] text-[#7c756a]">Python · FastAPI · asyncio · serves the built web app</div>
      </div>

      <svg className="pointer-events-none absolute inset-0 overflow-visible" width={W} height={H} aria-hidden>
        {/* clients → Caddy */}
        {[236, 322, 408].map((y) => (
          <path key={y} d={`M232 ${y} C 262 ${y}, 262 322, 296 322`} {...both} />
        ))}
        {/* Caddy → server */}
        <path d="M394 322 L436 322" {...both} />
        {/* server → storage */}
        <path d="M560 468 L560 526" {...both} />
        <path d="M800 468 L800 526" {...arrow} />
        {/* server → outside */}
        <path d="M912 262 L976 262" {...both} />
        <path d="M912 400 L976 400" {...arrow} />
        <path d="M976 508 C 950 508, 936 448, 912 448" {...arrow} />
      </svg>

      {/* clients */}
      <Node x={72} y={204} w={160} h={64} title="Web browser" sub="React SPA · CodeMirror" />
      <Node x={72} y={290} w={160} h={64} title="Phone browser" sub="mobile view, QR join" />
      <Node x={72} y={376} w={160} h={64} title="External agent" sub="Python client, HTTP" />
      <div className="absolute" style={{ left: 72, top: 456, width: 160 }}>
        <Mark className="text-[10px] leading-relaxed">Clients</Mark>
      </div>

      <Node x={296} y={286} w={98} h={72} title="Caddy" sub="TLS, reverse proxy" />

      {/* inside the server */}
      {[
        ["REST API", "sessions, files, billing"],
        ["WebSocket hub", "live events, presence"],
        ["Sessions", "roles, the baton, comments"],
        ["Context builder", "log → prompt, compaction"],
        ["Agent runner", "one asyncio task per session"],
        ["Access & billing", "access code, Stripe"],
      ].map(([t, s], i) => (
        <Node key={t} x={452 + (i % 3) * 152} y={266 + Math.floor(i / 3) * 96} w={140} h={80} title={t} sub={s} strong={t === "Agent runner"} />
      ))}

      {/* storage */}
      <Cylinder x={468} y={526} w={184} h={104} title="SQLite (WAL)" sub="the append-only event log" strong />
      <Cylinder x={708} y={526} w={184} h={104} title="Workspaces" sub="a copy of the repo per session" />

      {/* outside */}
      <Node x={976} y={198} w={232} h={128} title="Model APIs" sub="Anthropic · Google Gemini · OpenAI · xAI Grok · local weights (Ollama, vLLM) · any OpenAI-compatible endpoint" />
      <Node x={976} y={368} w={232} h={64} title="GitHub" sub="clone a repo, push a branch, open a PR" />
      <Node x={976} y={476} w={232} h={64} title="Stripe" sub="Checkout, customer portal, webhooks" />

      {/* what travels on each wire */}
      <Wire x={262} y={192}>HTTPS · WSS</Wire>
      <Wire x={415} y={306}>:8000</Wire>
      <Wire x={560} y={497}>append · replay</Wire>
      <Wire x={800} y={497}>files · bash / Docker</Wire>
      <Wire x={944} y={246}>streaming</Wire>
      <Wire x={944} y={384}>git</Wire>
      <Wire x={944} y={492}>webhooks</Wire>
    </>
  );
}

/* ── 5. Pricing ───────────────────────────────────────────────────────────────────────────────────────── */

function Pricing() {
  const [team, ent] = [DEFAULT_PLANS.find((p) => p.id === "team")!, DEFAULT_PLANS.find((p) => p.id === "enterprise")!];
  const tiers = [
    { name: "Free", price: money(0), per: "", who: WHO.free },
    { name: team.name, price: money(team.seat), per: "per seat / month", who: WHO.team, star: true },
    { name: ent.name, price: money(ent.seat), per: "per seat / month", who: WHO.enterprise },
  ];
  return (
    <>
      <div className="absolute" style={{ left: 72, top: 56 }}>
        <Mark>Pricing</Mark>
      </div>
      <div className="absolute grid grid-cols-3" style={{ left: 72, top: 200, width: 1136 }}>
        {tiers.map((t, i) => (
          <div key={t.name} className={clsx("px-10", i > 0 && "border-l border-[#e4ded4]")}>
            <div className="text-[15px] font-semibold text-[#24221e]">{t.name}</div>
            <div className="relative mt-4 inline-block">
              <Serif className="text-[124px] leading-none text-[#1d1b18]">{t.price}</Serif>
              {t.star && <Stroke className="-bottom-[6px] left-0 h-[18px] w-full" d="M6 12 C 80 5, 200 4, 294 10" />}
            </div>
            <div className="mt-5 h-5 text-[15px] text-[#6f685e]">{t.per}</div>
            <div className="mt-6 text-[15px] text-[#9b9387]">{t.who}</div>
          </div>
        ))}
      </div>
      <div className="absolute" style={{ left: 112, top: 560 }}>
        <Serif italic className="text-[28px] text-[#5d574e]">
          Watching is always free. Teams bring their own model key.
        </Serif>
      </div>
    </>
  );
}

/* ── 6. The business (BIC Startup Challenge) ──────────────────────────────────────────────────────────── */

const CASE: [string, ReactNode][] = [
  ["Problem", "Design work moved from whiteboards into private agent chats. Pulling in an expert now means rebuilding the context from scratch."],
  [
    "Customer",
    "Fast-shipping software startups. At one, an in-house version sat on the platform roadmap for three quarters: too costly to build and maintain.",
  ],
  ["Go to market", "Free viewers see it working and convert. Free webinars, a Hacker News launch, first-month discounts for audited industries."],
  ["Edge", "Other tools let a team watch an agent. Baton puts the whole team in the loop, on any model. Docs did this to Word; Figma did it to Photoshop."],
  ["Next", "Adapters for Claude Code and Codex, then Slack, Teams and Jira, then a sales team."],
];

/** TAM, SAM and SOM as nested circles, all resting on one baseline. */
const RINGS = [
  { r: 232, fill: "#f3efe8", label: "TAM", value: "$11B", unit: "/ yr", note: "36.5M developers × $300 a year", y: 26 },
  { r: 146, fill: "#efe8dd", label: "SAM", value: "$1.3B", unit: "/ yr", note: "agent users at large companies, North America and Western Europe", y: 22 },
  { r: 64, fill: "#f15a24", label: "SOM", value: "$28M", unit: "ARR", note: "", y: 30 },
];

function Business() {
  const cx = 968;
  const base = 650;
  return (
    <>
      <div className="absolute" style={{ left: 72, top: 56 }}>
        <Mark>BIC Startup Challenge</Mark>
        <div className="mt-3">
          <Serif className="text-[46px] leading-none text-[#1d1b18]">
            Bring the team <Serif italic>back into the loop.</Serif>
          </Serif>
        </div>
      </div>

      <div className="absolute space-y-[18px]" style={{ left: 72, top: 176, width: 560 }}>
        {CASE.map(([k, v]) => (
          <div key={k} className="grid grid-cols-[112px_1fr] items-baseline gap-4">
            <Mark className="text-[10.5px] text-[#c2552c]">{k}</Mark>
            <p className="text-[15.5px] leading-[1.45] text-[#3a3731]">{v}</p>
          </div>
        ))}
      </div>

      <svg className="absolute overflow-visible" style={{ left: 0, top: 0 }} width={W} height={H} aria-hidden>
        {RINGS.map((c) => (
          <circle key={c.label} cx={cx} cy={base - c.r} r={c.r} fill={c.fill} stroke={c.label === "SOM" ? "none" : "#e2dace"} />
        ))}
      </svg>
      {RINGS.map((c) => {
        const som = c.label === "SOM";
        return (
          <div key={c.label} className="absolute text-center" style={{ left: cx - 150, top: base - 2 * c.r + c.y, width: 300 }}>
            <Mark className={clsx("text-[10px]", som && "text-white/80")}>{c.label}</Mark>
            <div className={clsx("mt-1 leading-none", som ? "text-white" : "text-[#1d1b18]")}>
              <Serif className={som ? "text-[34px]" : "text-[44px]"}>{c.value}</Serif>
              <span className={clsx("ml-1 text-[13px]", som ? "text-white/80" : "text-[#7c756a]")}>{c.unit}</span>
            </div>
            {c.note && <div className="mx-auto mt-1.5 max-w-[230px] text-[11.5px] leading-snug text-[#7c756a]">{c.note}</div>}
          </div>
        );
      })}
      <div className="absolute text-[12px] leading-snug text-[#7c756a]" style={{ left: cx + 76, top: base - 64, width: 160 }}>
        1,000 companies × 70 seats × $400 a year, in five years
      </div>
    </>
  );
}

/* ── 7. Join ──────────────────────────────────────────────────────────────────────────────────────────── */

function Join() {
  const [origin, setOrigin] = useState(location.origin);
  const [live, setLive] = useState<string | null>(null); // the session to drop the room into, if one is running
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
    QRCode.toDataURL(url, { margin: 0, width: 640, color: { dark: "#1d1b18", light: "#00000000" } }).then(setQr).catch(() => {});
  }, [url]);
  return (
    <>
      <div className="absolute grid place-items-center rounded-[22px] bg-white ring-1 ring-black/[0.06]" style={{ left: 120, top: 150, width: 420, height: 420, boxShadow: "0 30px 70px -30px rgb(60 50 30 / 0.35)" }}>
        {qr && <img src={qr} alt="QR code to join the live session" className="size-[340px]" />}
      </div>
      <div className="absolute" style={{ left: 640, top: 196 }}>
        <Mark>{live ? "Live now" : "Try it"}</Mark>
        <div className="relative mt-5">
          <Serif className="text-[88px] leading-[0.98] text-[#1d1b18]">
            {live ? "Steer it" : "Open it"}
            <br />
            <Serif italic>with us.</Serif>
          </Serif>
        </div>
        <p className="mt-8 font-mono text-[18px] text-[#5d574e]">{origin.replace(/^https?:\/\//, "")}</p>
        <Link
          href={live ? `/s/${live}` : "/"}
          className="mt-8 inline-flex h-11 items-center gap-2 rounded-full bg-[#1d1b18] px-6 text-[15px] font-medium text-[#faf8f4] hover:bg-[#1d1b18]/85"
        >
          {live ? "Open the live session" : "Start the live demo"} <ArrowRight className="size-4" />
        </Link>
      </div>
    </>
  );
}

const SLIDES: { name: string; Body: () => ReactNode }[] = [
  { name: "Baton", Body: Cover },
  { name: "In use", Body: Moments },
  { name: "Compared", Body: Compared },
  { name: "Architecture", Body: Architecture },
  { name: "Pricing", Body: Pricing },
  { name: "Business", Body: Business },
  { name: "Join", Body: Join },
];

/** Paper grain, drawn once. */
const GRAIN = `url("data:image/svg+xml,${encodeURIComponent(
  `<svg xmlns='http://www.w3.org/2000/svg' width='220' height='220'><filter id='n'><feTurbulence type='fractalNoise' baseFrequency='0.85' numOctaves='2' stitchTiles='stitch'/><feColorMatrix values='0 0 0 0 0.35  0 0 0 0 0.3  0 0 0 0 0.22  1.4 0 0 0 -0.55'/></filter><rect width='100%' height='100%' filter='url(#n)' opacity='0.12'/></svg>`,
)}")`;

/** Fit the 1280×720 stage inside its box. */
function useFit() {
  const ref = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(1);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const fit = () => setScale(Math.min(el.clientWidth / W, el.clientHeight / H));
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return { ref, scale };
}

export function Pitch() {
  const [i, setI] = useState(() => {
    const n = Number(new URLSearchParams(location.search).get("slide"));
    return Number.isFinite(n) && n > 0 ? Math.min(n - 1, SLIDES.length - 1) : 0;
  });
  const go = useCallback((d: number) => setI((x) => Math.max(0, Math.min(SLIDES.length - 1, x + d))), []);
  const { ref, scale } = useFit();

  // The deck is paper-light whatever theme the app is in; the app's theme comes back on the way out.
  useEffect(() => {
    const root = document.documentElement;
    const dark = root.classList.contains("dark");
    root.classList.remove("dark");
    return () => {
      if (dark) root.classList.add("dark");
    };
  }, []);

  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if (["ArrowRight", "PageDown", " "].includes(e.key)) go(1);
      if (["ArrowLeft", "PageUp"].includes(e.key)) go(-1);
      if (e.key === "Home") setI(0);
      if (e.key === "End") setI(SLIDES.length - 1);
      if (e.key === "f" || e.key === "F") {
        if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
        else document.documentElement.requestFullscreen().catch(() => {});
      }
    };
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [go]);

  const { Body, name } = SLIDES[i];
  return (
    <div className="fixed inset-0 z-30 flex flex-col bg-[#faf8f4] text-[#1d1b18]" style={{ backgroundImage: GRAIN }}>
      <svg width="0" height="0" className="absolute" aria-hidden>
        <defs>
          <marker id="deck-tip" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
            <path d="M1 1 L8 5 L1 9" fill="none" stroke="#9b9387" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
          </marker>
          <marker id="deck-tip-baton" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse">
            <path d="M1 1 L8 5 L1 9" fill="none" stroke="#f15a24" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
          </marker>
        </defs>
      </svg>
      <div ref={ref} className="relative min-h-0 flex-1 cursor-pointer" onClick={() => go(1)}>
        <div
          className="absolute top-1/2 left-1/2"
          style={{ width: W, height: H, transform: `translate(-50%, -50%) scale(${scale})` }}
          onClick={(e) => e.target !== e.currentTarget && e.stopPropagation()}
        >
          <div key={i} className="deck-in absolute inset-0">
            <Body />
          </div>
          <div className="absolute flex items-center" style={{ left: 72, right: 72, bottom: 34 }}>
            <Logo />
            <Mark className="ml-auto">
              {String(i + 1).padStart(2, "0")} · {name}
            </Mark>
          </div>
        </div>
      </div>
      <div className="flex items-center gap-4 px-8 pb-5">
        <Link href="/" className="text-[12px] text-[#9b9387] hover:text-[#5d574e]">
          Exit
        </Link>
        <div className="mx-auto flex gap-1.5">
          {SLIDES.map((s, j) => (
            <button
              key={s.name}
              onClick={() => setI(j)}
              className={clsx("h-1.5 rounded-full transition-all", j === i ? "w-6 bg-[#1d1b18]" : "w-1.5 bg-[#d6cfc3] hover:bg-[#9b9387]")}
              aria-label={`Slide ${j + 1}: ${s.name}`}
            />
          ))}
        </div>
        <span className="text-[12px] text-[#b3ab9f]">F for full screen</span>
      </div>
    </div>
  );
}
