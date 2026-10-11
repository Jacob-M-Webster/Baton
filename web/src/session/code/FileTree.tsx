import { useMemo, useState } from "react";
import clsx from "clsx";
import { ChevronRight, FileCode2, FilePlus2, FileText, Folder, FolderOpen } from "lucide-react";
import type { Participant, WorkspaceFile } from "../../lib/types";
import type { FileActivity } from "../../lib/derive";
import { Avatar } from "../../components/Avatar";

interface Node {
  name: string;
  path: string;
  file?: WorkspaceFile;
  children: Node[];
  changed: boolean; // this file, or something inside this folder, differs from the original repo
}

export function buildTree(files: WorkspaceFile[]): Node[] {
  const root: Node = { name: "", path: "", children: [], changed: false };
  for (const f of files) {
    const parts = f.path.split("/");
    let at = root;
    parts.forEach((name, i) => {
      const path = parts.slice(0, i + 1).join("/");
      let next = at.children.find((c) => c.name === name && (i === parts.length - 1 ? !!c.file : !c.file));
      if (!next) {
        next = { name, path, children: [], changed: false, ...(i === parts.length - 1 ? { file: f } : {}) };
        at.children.push(next);
      }
      if (f.state !== "same") next.changed = true;
      at = next;
    });
  }
  const sort = (n: Node) => {
    n.children.sort((a, b) => Number(!!a.file) - Number(!!b.file) || a.name.localeCompare(b.name));
    n.children.forEach(sort);
  };
  sort(root);
  return root.children;
}

export function FileIcon({ path, className }: { path: string; className?: string }) {
  const ext = path.split(".").pop()?.toLowerCase();
  return ext === "md" || ext === "txt" ? <FileText className={className} /> : <FileCode2 className={className} />;
}

export function FileTree({
  files,
  active,
  onOpen,
  viewers,
  agent,
  canCreate,
  onCreate,
}: {
  files: WorkspaceFile[];
  active: string | null;
  onOpen: (path: string) => void;
  viewers: Record<string, Participant[]>; // other people, by the file they have open
  agent: FileActivity | null;
  canCreate: boolean;
  onCreate: (path: string) => void;
}) {
  const tree = useMemo(() => buildTree(files), [files]);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [creating, setCreating] = useState<string | null>(null);
  const changed = files.filter((f) => f.state !== "same").length;

  const toggle = (path: string) => {
    const next = new Set(collapsed);
    if (next.has(path)) next.delete(path);
    else next.add(path);
    setCollapsed(next);
  };

  const row = (n: Node, depth: number): React.ReactNode => {
    const pad = { paddingLeft: 8 + depth * 12 };
    if (!n.file) {
      const open = !collapsed.has(n.path);
      return (
        <div key={n.path}>
          <button onClick={() => toggle(n.path)} style={pad} className="flex h-7 w-full items-center gap-1.5 pr-2 text-left text-[12.5px] text-ink-2 hover:bg-sunken">
            <ChevronRight className={clsx("size-3 shrink-0 text-ink-4 transition-transform", open && "rotate-90")} />
            {open ? <FolderOpen className="size-3.5 shrink-0 text-ink-3" /> : <Folder className="size-3.5 shrink-0 text-ink-3" />}
            <span className="min-w-0 flex-1 truncate">{n.name}</span>
            {!open && n.changed && <span className="size-1.5 rounded-full bg-attn" title="Contains changes" />}
          </button>
          {open && n.children.map((c) => row(c, depth + 1))}
        </div>
      );
    }
    const f = n.file;
    const here = viewers[n.path] || [];
    const agentHere = agent?.path === n.path;
    return (
      <button
        key={n.path}
        onClick={() => onOpen(n.path)}
        style={{ paddingLeft: 8 + depth * 12 + 16 }}
        className={clsx(
          "flex h-7 w-full items-center gap-1.5 pr-2 text-left text-[12.5px]",
          active === n.path ? "bg-sunken font-medium text-ink" : "text-ink-2 hover:bg-sunken/70",
        )}
        title={n.path}
      >
        <FileIcon path={n.path} className={clsx("size-3.5 shrink-0", f.state === "same" ? "text-ink-4" : f.state === "added" ? "text-live" : "text-attn")} />
        <span className={clsx("min-w-0 flex-1 truncate font-mono text-[12px]", f.state === "added" && "text-live", f.state === "modified" && "text-attn")}>{n.name}</span>
        {agentHere && (
          <span className="relative flex size-2 shrink-0" title={`The agent is ${agent!.verb} this file`}>
            <span className="absolute inset-0 animate-ping rounded-full bg-baton/60" />
            <span className="relative size-2 rounded-full bg-baton" />
          </span>
        )}
        {here.length > 0 && (
          <span className="flex shrink-0 -space-x-1">
            {here.slice(0, 3).map((p) => (
              <span key={p.user_id} title={`${p.name} has this open`}>
                <Avatar name={p.name} color={p.color} size={14} />
              </span>
            ))}
          </span>
        )}
        {f.state !== "same" && <span className={clsx("w-3 shrink-0 text-right text-[10.5px] font-semibold", f.state === "added" ? "text-live" : "text-attn")}>{f.state === "added" ? "A" : "M"}</span>}
      </button>
    );
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-line px-3">
        <span className="text-[11px] font-medium tracking-wide text-ink-4 uppercase">Files</span>
        {changed > 0 && <span className="tnum text-[11px] text-attn">{changed} changed</span>}
        {canCreate && (
          <button onClick={() => setCreating("")} className="ml-auto rounded-md p-1 text-ink-4 hover:bg-sunken hover:text-ink" title="New file" aria-label="New file">
            <FilePlus2 className="size-3.5" />
          </button>
        )}
      </div>
      {creating !== null && (
        <form
          className="border-b border-line p-2"
          onSubmit={(e) => {
            e.preventDefault();
            const p = creating.trim().replace(/\\/g, "/").replace(/^\/+/, "");
            if (p && !p.endsWith("/")) onCreate(p);
            setCreating(null);
          }}
        >
          <input
            autoFocus
            value={creating}
            onChange={(e) => setCreating(e.target.value)}
            onKeyDown={(e) => e.key === "Escape" && setCreating(null)}
            onBlur={() => !creating.trim() && setCreating(null)}
            placeholder="path/to/new_file.py"
            className="h-7 w-full rounded-md border border-line bg-panel px-2 font-mono text-[12px] outline-none focus:border-ink-3"
          />
        </form>
      )}
      <div className="min-h-0 flex-1 overflow-y-auto py-1">
        {tree.map((n) => row(n, 0))}
        {files.length === 0 && <p className="px-3 py-2 text-xs text-ink-4">No files yet.</p>}
      </div>
    </div>
  );
}
