import { useEffect, useMemo, useState } from "react";
import clsx from "clsx";
import { ExternalLink, Globe, Loader2, RefreshCw } from "lucide-react";
import type { WorkspaceFile } from "../../lib/types";
import { api } from "../../lib/api";
import { siteRoots } from "../../lib/derive";
import { Button } from "../../components/Button";
import { setPreviewRoot, useCode } from "./store";

// The served pages are sandboxed by their own CSP too; this keeps the frame's origin opaque either way,
// so code in the workspace can't call Baton's API as whoever is looking at it.
const SANDBOX = "allow-scripts allow-forms allow-popups allow-modals allow-downloads";

/** "dist" -> "dist", "web/dist" -> "web~dist", the repository root -> "~" (see backend/baton/preview.py). */
function segment(root: string) {
  return root ? root.replace(/\//g, "~") : "~";
}

/**
 * The workspace's web page, live: any folder with an index.html (plain HTML, or a build in dist/). It reloads
 * when the agent or a teammate changes files, so you watch the frontend take shape as it's written.
 */
export function PreviewPane({ sid, files, version }: { sid: string; files: WorkspaceFile[]; version: number }) {
  const chosen = useCode((s) => s.previewRoot);
  const [base, setBase] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [auto, setAuto] = useState(true);
  const [nonce, setNonce] = useState(0);
  const [loading, setLoading] = useState(true);
  const roots = useMemo(() => siteRoots(files.map((f) => f.path)), [files]);
  const root = chosen !== null && roots.includes(chosen) ? chosen : roots[0];

  useEffect(() => {
    setFailed(false);
    api.preview(sid).then((r) => setBase(r.base)).catch(() => setFailed(true));
  }, [sid]);

  // Reload a moment after files change; a burst of edits (or a build) reloads once.
  useEffect(() => {
    if (!auto || !version) return;
    const t = window.setTimeout(() => setNonce((n) => n + 1), 700);
    return () => window.clearTimeout(t);
  }, [version, auto]);

  const url = base && root !== undefined ? `${base}${segment(root)}/` : null;
  useEffect(() => setLoading(true), [url, nonce]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-line px-3">
        <Globe className="size-3.5 shrink-0 text-ink-3" />
        {roots.length > 1 ? (
          <select
            value={root}
            onChange={(e) => setPreviewRoot(e.target.value)}
            className="h-6 min-w-0 rounded border border-line bg-canvas px-1.5 font-mono text-[12px] text-ink outline-none focus:border-ink-3"
            aria-label="Which index.html to preview"
          >
            {roots.map((r) => (
              <option key={r} value={r}>
                {r ? `${r}/index.html` : "index.html"}
              </option>
            ))}
          </select>
        ) : (
          <span className="min-w-0 truncate font-mono text-[12px] text-ink-2">{root !== undefined ? (root ? `${root}/index.html` : "index.html") : "Preview"}</span>
        )}
        {loading && url && <Loader2 className="size-3 shrink-0 animate-spin text-ink-4" />}
        <div className="ml-auto flex shrink-0 items-center gap-1.5">
          <label className="flex cursor-pointer items-center gap-1.5 text-[11.5px] text-ink-3" title="Reload when files change">
            <input type="checkbox" checked={auto} onChange={(e) => setAuto(e.target.checked)} className="accent-[var(--color-baton)]" />
            <span className="hidden sm:inline">Auto-reload</span>
          </label>
          <Button size="sm" variant="ghost" disabled={!url} onClick={() => setNonce((n) => n + 1)} title="Reload the preview">
            <RefreshCw className="size-3" />
            <span className="hidden sm:inline">Reload</span>
          </Button>
          {url && (
            <a href={url} target="_blank" rel="noopener noreferrer" title="Open in a new tab" className="grid size-7 place-items-center rounded-md text-ink-3 hover:bg-sunken hover:text-ink">
              <ExternalLink className="size-3.5" />
            </a>
          )}
        </div>
      </div>

      <div className={clsx("relative min-h-0 flex-1", url && "bg-white")}>
        {failed ? (
          <p className="grid h-full place-items-center p-6 text-center text-[13px] text-ink-3">Couldn't load the preview.</p>
        ) : root === undefined ? (
          <div className="grid h-full place-items-center p-6 text-center text-[13px] text-ink-3">
            <div className="max-w-sm">
              <p className="font-medium text-ink-2">No web page to show yet</p>
              <p className="mt-1">
                The preview shows any folder in the workspace with an <code className="font-mono text-[12px]">index.html</code>. Ask the agent to make
                one, or run your build (for example <code className="font-mono text-[12px]">npm run build</code>) in the terminal.
              </p>
            </div>
          </div>
        ) : url ? (
          <iframe
            key={`${url}#${nonce}`}
            src={url}
            sandbox={SANDBOX}
            title="Preview"
            onLoad={() => setLoading(false)}
            className="absolute inset-0 size-full border-0"
          />
        ) : null}
      </div>
    </div>
  );
}
