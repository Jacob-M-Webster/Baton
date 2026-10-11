import { create } from "zustand";
import { api } from "../../lib/api";

/** One open file. `content` is the server's copy; `draft` is unsaved text typed in the editor. */
export interface Buffer {
  path: string;
  content: string;
  hash: string; // fingerprint of `content`, sent with a save so the server can refuse to clobber newer work
  original: string | null; // the file when the session started (null if created during it)
  diff: string; // against `original`
  draft: string | null;
  stale: boolean; // the server copy changed while this buffer had unsaved edits
  missing: boolean;
  isNew: boolean; // created in the editor and not saved yet
  loaded: boolean;
  saving: boolean; // a save is on its way; don't send another until the file reloads
}

interface CodeState {
  sid: string | null;
  view: "timeline" | "code";
  tabs: string[];
  active: string | null;
  buffers: Record<string, Buffer>;
  follow: boolean; // open whatever file the agent is working on
  showDiff: boolean;
  terminalOpen: boolean;
  preview: boolean; // show the workspace's web page instead of the editor
  previewRoot: string | null; // the folder whose index.html is previewed ("" for the repository root)
}

export const useCode = create<CodeState>(() => ({
  sid: null,
  view: "timeline",
  tabs: [],
  active: null,
  buffers: {},
  follow: true,
  showDiff: false,
  terminalOpen: true,
  preview: false,
  previewRoot: null,
}));

const set = useCode.setState;
const get = useCode.getState;

function patch(path: string, p: Partial<Buffer>) {
  const b = get().buffers[path];
  if (b) set({ buffers: { ...get().buffers, [path]: { ...b, ...p } } });
}

/** A new session starts with no open files; which view you prefer carries over. */
export function resetCode(sid: string) {
  if (get().sid === sid) return;
  set({ sid, tabs: [], active: null, buffers: {}, follow: true, showDiff: false, preview: false, previewRoot: null });
}

export function setView(view: CodeState["view"]) {
  set({ view });
}

/** Switch to the code view, optionally opening a file there (used by links in the timeline). */
export function showCode(path?: string) {
  set({ view: "code" });
  if (path) openFile(path, { manual: true });
}

export function openFile(path: string, opts: { manual?: boolean } = {}) {
  const s = get();
  const tabs = s.tabs.includes(path) ? s.tabs : [...s.tabs, path];
  const buffers = s.buffers[path]
    ? s.buffers
    : {
        ...s.buffers,
        [path]: { path, content: "", hash: "", original: null, diff: "", draft: null, stale: false, missing: false, isNew: false, loaded: false, saving: false },
      };
  // Picking a file yourself stops following the agent around (and leaves the preview for the editor).
  set({ tabs, active: path, buffers, ...(opts.manual ? { follow: false, preview: false } : {}) });
  if (!buffers[path].loaded && !buffers[path].isNew) void loadFile(path);
}

export function closeTab(path: string) {
  const s = get();
  const i = s.tabs.indexOf(path);
  const tabs = s.tabs.filter((t) => t !== path);
  const buffers = { ...s.buffers };
  delete buffers[path];
  const active = s.active === path ? (tabs[Math.min(i, tabs.length - 1)] ?? null) : s.active;
  set({ tabs, buffers, active });
}

/** Fetch the server's copy. Unsaved edits are kept; if the file changed underneath them, flag it. */
export async function loadFile(path: string) {
  const sid = get().sid;
  if (!sid) return;
  try {
    const f = await api.file(sid, path);
    if (get().sid !== sid) return;
    const b = get().buffers[path];
    if (!b) return;
    let { draft, stale } = b;
    if (draft !== null && draft === f.content) {
      draft = null;
      stale = false;
    } else if (draft !== null && b.loaded && f.hash !== b.hash) {
      stale = true;
    }
    patch(path, {
      content: f.content, hash: f.hash, original: f.original, diff: f.diff, draft, stale, missing: false, isNew: false, loaded: true, saving: false,
    });
  } catch {
    if (get().sid === sid) patch(path, { missing: !get().buffers[path]?.isNew, loaded: true, saving: false });
  }
}

export function setDraft(path: string, text: string) {
  const b = get().buffers[path];
  if (!b) return;
  const draft = !b.isNew && text === b.content ? null : text;
  if (draft !== b.draft) patch(path, { draft, ...(draft === null ? { stale: false } : {}) });
}

export function discardDraft(path: string) {
  const b = get().buffers[path];
  if (!b) return;
  if (b.isNew) closeTab(path);
  else patch(path, { draft: null, stale: false });
}

/** A file that doesn't exist yet: it's created on the server the first time it's saved. */
export function newFile(path: string) {
  const s = get();
  set({
    tabs: s.tabs.includes(path) ? s.tabs : [...s.tabs, path],
    active: path,
    follow: false,
    preview: false,
    buffers: {
      ...s.buffers,
      [path]: { path, content: "", hash: "", original: null, diff: "", draft: "", stale: false, missing: false, isNew: true, loaded: true, saving: false },
    },
  });
}

/** Save goes through the session's command queue, like every other human action, so it lands in the log. */
export function saveFile(path: string, send: (m: Record<string, unknown>) => boolean, force = false) {
  const b = get().buffers[path];
  if (!b || b.draft === null || b.saving) return false;
  // A new file's base is "nothing there yet": the server refuses the save if someone created it meanwhile.
  const sent = send({ type: "save_file", path, content: b.draft, base: b.isNew ? "" : b.hash, force });
  if (sent) patch(path, { saving: true });
  return sent;
}

export function setFollow(follow: boolean) {
  set({ follow });
}

export function toggleDiff() {
  set({ showDiff: !get().showDiff });
}

export function toggleTerminal() {
  set({ terminalOpen: !get().terminalOpen });
}

export function setPreview(preview: boolean) {
  set({ preview });
}

export function setPreviewRoot(previewRoot: string) {
  set({ previewRoot });
}
