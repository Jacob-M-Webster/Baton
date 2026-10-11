export function clock(ts: number) {
  return new Date(ts * 1000).toLocaleTimeString([], { hour: "numeric", minute: "2-digit", second: "2-digit" });
}

export function shortClock(ts: number) {
  return new Date(ts * 1000).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

export function ago(ts: number, now = Date.now() / 1000) {
  const s = Math.max(0, Math.round(now - ts));
  if (s < 45) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

export function duration(ms: number) {
  if (ms < 1000) return `${ms}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(s < 10 ? 1 : 0)}s`;
  const m = Math.floor(s / 60);
  return `${m}m ${Math.round(s % 60)}s`;
}

export function compact(n: number) {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

export function initials(name: string) {
  const parts = name.trim().split(/\s+/);
  return ((parts[0]?.[0] || "?") + (parts.length > 1 ? parts[parts.length - 1][0] : "")).toUpperCase();
}

export function modelLabel(model: string) {
  const known: Record<string, string> = {
    "baton-demo": "Offline demo",
    "claude-opus-5-5": "Claude Opus 5.5",
    "claude-sonnet-5-5": "Claude Sonnet 5.5",
    "claude-haiku-5-5": "Claude Haiku 5.5",
    "gpt-5": "GPT-5",
    "gpt-5-mini": "GPT-5 mini",
  };
  if (known[model]) return known[model];
  // gemini-3.8-flash-lite -> Gemini 3.8 Flash Lite; gemini-3.1-pro-preview -> Gemini 3.1 Pro (preview)
  const g = /^gemini-(.+?)(-preview)?$/.exec(model);
  if (g) return `Gemini ${g[1].split("-").map((w) => w[0].toUpperCase() + w.slice(1)).join(" ")}${g[2] ? " (preview)" : ""}`;
  // grok-4 -> Grok 4; grok-code-fast-1 -> Grok Code Fast 1
  if (model.startsWith("grok-")) return model.split("-").map((w) => w[0].toUpperCase() + w.slice(1)).join(" ");
  return model;
}
