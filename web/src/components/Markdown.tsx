import { Fragment, type ReactNode } from "react";

/** Just enough markdown for agent prose: paragraphs, bullet lists, code fences, `code`, **bold**. */
export function Markdown({ text, caret }: { text: string; caret?: boolean }) {
  const blocks: ReactNode[] = [];
  const lines = text.replace(/\r/g, "").split("\n");
  let i = 0;
  let key = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.startsWith("```")) {
      const body: string[] = [];
      i++;
      while (i < lines.length && !lines[i].startsWith("```")) body.push(lines[i++]);
      i++;
      blocks.push(
        <pre key={key++} className="overflow-x-auto rounded-lg border border-line bg-sunken px-3 py-2 font-mono text-[12px] leading-relaxed">
          <code>{body.join("\n")}</code>
        </pre>,
      );
      continue;
    }
    if (/^\s*[-*] /.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*[-*] /.test(lines[i])) items.push(lines[i++].replace(/^\s*[-*] /, ""));
      blocks.push(
        <ul key={key++}>
          {items.map((t, j) => (
            <li key={j}>{inline(t)}</li>
          ))}
        </ul>,
      );
      continue;
    }
    if (!line.trim()) {
      i++;
      continue;
    }
    const para: string[] = [];
    while (i < lines.length && lines[i].trim() && !lines[i].startsWith("```") && !/^\s*[-*] /.test(lines[i])) para.push(lines[i++]);
    blocks.push(<p key={key++}>{inline(para.join(" "))}</p>);
  }
  if (caret) {
    blocks.push(<span key="caret" className="animate-caret ml-0.5 inline-block h-[1.05em] w-[2px] translate-y-[3px] bg-ink" />);
  }
  return <div className="prose-agent">{blocks}</div>;
}

/** Inline-only rendering (code spans and bold) for short summaries. */
export function InlineMd({ text }: { text: string }) {
  return <span className="prose-agent">{inline(text)}</span>;
}

function inline(s: string): ReactNode {
  const parts = s.split(/(`[^`]+`|\*\*[^*]+\*\*)/g);
  return parts.map((p, i) => {
    if (p.startsWith("`") && p.endsWith("`") && p.length > 1) return <code key={i}>{p.slice(1, -1)}</code>;
    if (p.startsWith("**") && p.endsWith("**")) return <strong key={i} className="font-semibold">{p.slice(2, -2)}</strong>;
    return <Fragment key={i}>{p}</Fragment>;
  });
}
