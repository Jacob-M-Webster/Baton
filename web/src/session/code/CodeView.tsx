import { useEffect, useMemo, useRef, useState } from "react";
import clsx from "clsx";
import { Crosshair, FileDiff, GitCompare, Loader2, Lock, PanelLeft, RotateCcw, Save, X } from "lucide-react";
import type { BatonEvent, Participant, Session, WorkspaceFile } from "../../lib/types";
import { api } from "../../lib/api";
import { agentFile, lastWriters, openDecision, workspaceRuns, workspaceVersion } from "../../lib/derive";
import { useSession } from "../../lib/session";
import { AgentAvatar, Avatar } from "../../components/Avatar";
import { Button, Kbd } from "../../components/Button";
import { DiffView } from "../items";
import { Composer } from "../Composer";
import { CodeEditor } from "./Editor";
import { FileIcon, FileTree } from "./FileTree";
import { TerminalPanel } from "./Terminal";
import { AgentPane } from "./AgentPane";
import {
  closeTab, discardDraft, loadFile, newFile, openFile, saveFile, setDraft, setFollow, setView, toggleDiff, toggleTerminal, useCode,
} from "./store";

const FILE_TOOLS = new Set(["write_file", "edit_file"]);

/**
 * The session's workspace as an IDE: the same files the agent works on, live. Everyone can browse and
 * watch the agent edit; the driver can also edit, save and run commands. Saves and commands go through
 * the session's command queue and land in the log, attributed, so the agent reads them at its next turn.
 */
export default function CodeView({
  session,
  events,
  participants,
  me,
  onJump,
}: {
  session: Session;
  events: BatonEvent[];
  participants: Participant[];
  me: string;
  onJump: (seq: number) => void;
}) {
  const { tabs, active, buffers, follow, showDiff, terminalOpen } = useCode();
  const partial = useSession((s) => s.partial);
  const send = useSession((s) => s.send);
  const conn = useSession((s) => s.conn);
  const [files, setFiles] = useState<WorkspaceFile[]>([]);
  const [treeOpen, setTreeOpen] = useState(false);
  const external = session.provider === "external";
  const isDriver = session.driver_id === me;
  const canEdit = isDriver && !external;
  const people = useMemo(() => Object.fromEntries(participants.map((p) => [p.user_id, p])) as Record<string, Participant>, [participants]);
  const version = useMemo(() => workspaceVersion(events), [events]);
  const agent = useMemo(() => agentFile(events, partial.turn !== null ? partial.tool : null), [events, partial.turn, partial.tool]);
  const writers = useMemo(() => lastWriters(events), [events]);
  const runs = useMemo(() => workspaceRuns(events), [events]);
  const decision = useMemo(() => openDecision(events), [events]);
  const buf = active ? buffers[active] : undefined;
  const driverName = session.driver_id ? people[session.driver_id]?.name : undefined;

  // The file list follows everything that can change files.
  useEffect(() => {
    if (external) return;
    api.files(session.id).then((r) => setFiles(r.files)).catch(() => {});
  }, [session.id, version, external]);

  // Coming in with nothing open: show what the agent is on, else the last file anyone changed.
  useEffect(() => {
    if (useCode.getState().active || !files.length) return;
    const recent = Object.entries(writers).sort((a, b) => b[1].seq - a[1].seq)[0]?.[0];
    const pick = agent?.path || recent || files.find((f) => f.path === "README.md")?.path || files[0].path;
    openFile(pick);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [files.length]);

  // Reload open files when the agent or a teammate changes them.
  const handled = useRef(events.length ? events[events.length - 1].seq : 0);
  useEffect(() => {
    const fresh = events.filter((e) => e.seq > handled.current);
    if (!fresh.length) return;
    handled.current = fresh[fresh.length - 1].seq;
    const open = useCode.getState().buffers;
    const touched = new Set<string>();
    let anyCommand = false;
    for (const e of fresh) {
      if (e.type === "human.edit") touched.add(e.payload.path);
      else if (e.type === "human.command_result") anyCommand = true;
      else if (e.type === "tool.result" && !e.payload.is_error) {
        const call = events.find((c) => c.type === "tool.call" && c.payload.call_id === e.payload.call_id);
        if (call?.payload.name === "run_command") anyCommand = true;
        else if (call && FILE_TOOLS.has(call.payload.name)) touched.add(String(call.payload.input?.path || ""));
      }
    }
    // A command can change any file; recheck everything that's open.
    for (const path of anyCommand ? Object.keys(open) : touched) if (open[path] && !open[path].isNew) void loadFile(path);
  }, [events]);

  // Follow the agent from file to file.
  useEffect(() => {
    if (follow && agent && agent.path !== useCode.getState().active) openFile(agent.path);
  }, [follow, agent?.path]); // eslint-disable-line react-hooks/exhaustive-deps

  // Tell the others which file I have open (and again after a reconnect, which resets presence).
  useEffect(() => {
    if (conn === "open") send({ type: "open_file", path: active });
  }, [active, conn, send]);
  useEffect(() => () => void send({ type: "open_file", path: null }), [send]);

  const save = (force = false) => {
    if (!active || !canEdit) return;
    if (saveFile(active, send, force)) window.setTimeout(() => loadFile(active), 700);
  };

  // Ctrl/Cmd+S anywhere in the code view saves (and never opens the browser's save dialog).
  const saveRef = useRef(save);
  saveRef.current = save;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // The editor handles its own Ctrl+S (and marks the event handled); this covers focus anywhere else.
      if (e.defaultPrevented) return;
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        saveRef.current();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const viewers = useMemo(() => {
    const out: Record<string, Participant[]> = {};
    for (const p of participants) if (p.user_id !== me && p.online && p.file) (out[p.file] ||= []).push(p);
    return out;
  }, [participants, me]);

  const close = (path: string) => {
    const b = useCode.getState().buffers[path];
    if (b?.draft !== null && b?.draft !== undefined && !window.confirm(`Discard your unsaved changes to ${path}?`)) return;
    closeTab(path);
  };

  if (external) {
    return (
      <div className="grid flex-1 place-items-center p-8 text-center">
        <div className="max-w-sm">
          <p className="text-sm font-medium">No workspace here</p>
          <p className="mt-1 text-[13px] text-ink-3">This session's agent runs elsewhere and streams its steps in, so its files live on its own machine.</p>
          <Button className="mt-4" onClick={() => setView("timeline")}>
            Back to the timeline
          </Button>
        </div>
      </div>
    );
  }

  const writer = active ? writers[active] : undefined;
  const writerName = writer ? (writer.actor === "agent" ? "the agent" : people[writer.actor]?.name || "someone") : null;
  const agentHere = agent && agent.path === active;
  const dirty = !!buf && buf.draft !== null;
  const tree = (
    <FileTree
      files={files}
      active={active}
      onOpen={(p) => {
        openFile(p, { manual: true });
        setTreeOpen(false);
      }}
      viewers={viewers}
      agent={agent}
      canCreate={canEdit}
      onCreate={(p) => {
        if (files.some((f) => f.path === p)) openFile(p, { manual: true });
        else newFile(p);
        setTreeOpen(false);
      }}
    />
  );

  return (
    <div className="flex min-h-0 flex-1">
      <aside className="hidden w-60 shrink-0 flex-col border-r border-line bg-panel md:flex">{tree}</aside>
      {treeOpen && (
        <div className="fixed inset-0 z-30 flex md:hidden" onMouseDown={() => setTreeOpen(false)}>
          <aside onMouseDown={(e) => e.stopPropagation()} className="flex w-72 max-w-[85vw] flex-col border-r border-line bg-panel shadow-2xl">
            {tree}
          </aside>
          <div className="flex-1 bg-black/25" />
        </div>
      )}

      <div className="flex min-w-0 flex-1 flex-col bg-panel">
        {/* tabs */}
        <div className="flex h-9 shrink-0 items-stretch border-b border-line bg-canvas">
          <button onClick={() => setTreeOpen(true)} className="grid w-9 shrink-0 place-items-center border-r border-line text-ink-3 hover:text-ink md:hidden" aria-label="Files">
            <PanelLeft className="size-4" />
          </button>
          <div className="flex min-w-0 flex-1 items-stretch overflow-x-auto">
            {tabs.map((t) => {
              const b = buffers[t];
              const isActive = t === active;
              const tDirty = b?.draft !== null && b?.draft !== undefined;
              return (
                <div
                  key={t}
                  className={clsx(
                    "group/tab flex shrink-0 items-center gap-1.5 border-r border-line pr-1.5 pl-3 text-[12.5px]",
                    isActive ? "bg-panel text-ink shadow-[inset_0_1px_0_var(--color-baton)]" : "text-ink-3 hover:text-ink-2",
                  )}
                  title={t}
                >
                  <button onClick={() => openFile(t, { manual: true })} className="flex h-full items-center gap-1.5">
                    <FileIcon path={t} className="size-3.5 shrink-0 text-ink-4" />
                    <span className="font-mono text-[12px]">{t.split("/").pop()}</span>
                    {agent?.path === t && <span className="size-1.5 animate-pulse rounded-full bg-baton" title={`The agent is ${agent.verb} this file`} />}
                  </button>
                  <button
                    onClick={() => close(t)}
                    className="grid size-5 place-items-center rounded text-ink-4 hover:bg-sunken hover:text-ink"
                    aria-label={`Close ${t}`}
                    title={tDirty ? "Unsaved changes" : "Close"}
                  >
                    {tDirty ? (
                      <span className="size-2 rounded-full bg-ink-2 group-hover/tab:hidden" />
                    ) : null}
                    <X className={clsx("size-3", tDirty && "hidden group-hover/tab:block")} />
                  </button>
                </div>
              );
            })}
          </div>
          <button
            onClick={() => setFollow(!follow)}
            className={clsx(
              "flex shrink-0 items-center gap-1.5 border-l border-line px-3 text-[12px]",
              follow ? "bg-baton-soft font-medium text-baton" : "text-ink-3 hover:text-ink",
            )}
            title="Open whatever file the agent is working on"
          >
            <Crosshair className="size-3.5" />
            <span className="hidden sm:inline">{follow ? "Following agent" : "Follow agent"}</span>
          </button>
        </div>

        {/* path and actions */}
        {buf && (
          <div className="flex h-9 shrink-0 items-center gap-2 border-b border-line px-3">
            <span className="min-w-0 truncate font-mono text-[12px] text-ink-3">
              {active!.split("/").map((part, i, all) => (
                <span key={i}>
                  {i > 0 && <span className="px-1 text-ink-4">/</span>}
                  <span className={i === all.length - 1 ? "text-ink" : ""}>{part}</span>
                </span>
              ))}
            </span>
            {buf.isNew && <span className="rounded bg-live/10 px-1.5 py-0.5 text-[10.5px] font-medium text-live">new file</span>}
            {writer && !buf.isNew && (
              <button
                onClick={() => {
                  setView("timeline");
                  window.setTimeout(() => onJump(writer.seq), 80);
                }}
                className="hidden shrink-0 items-center gap-1.5 text-[11.5px] text-ink-4 hover:text-ink-2 lg:inline-flex"
                title="Show this change in the timeline"
              >
                {writer.actor === "agent" ? (
                  <AgentAvatar size={14} provider={session.provider} />
                ) : (
                  <Avatar name={writerName!} color={people[writer.actor]?.color || "#71717a"} size={14} />
                )}
                last changed by {writerName} · step #{writer.seq}
              </button>
            )}
            <div className="ml-auto flex shrink-0 items-center gap-1.5">
              {(buf.diff || buf.original === null) && !buf.isNew && (
                <Button size="sm" variant={showDiff ? "primary" : "ghost"} onClick={toggleDiff} title="Compare with the file as the session started">
                  <GitCompare className="size-3" />
                  <span className="hidden sm:inline">Changes</span>
                </Button>
              )}
              {canEdit ? (
                <>
                  {dirty && (
                    <Button size="sm" variant="ghost" onClick={() => discardDraft(active!)} title="Throw away your unsaved edits">
                      <RotateCcw className="size-3" />
                      <span className="hidden sm:inline">Discard</span>
                    </Button>
                  )}
                  <Button size="sm" variant={dirty ? "primary" : "secondary"} disabled={!dirty || buf.saving} onClick={() => save()} title="Save (Ctrl+S)">
                    <Save className="size-3" /> Save
                    <span className="hidden lg:inline">
                      <Kbd>Ctrl S</Kbd>
                    </span>
                  </Button>
                </>
              ) : (
                <span className="inline-flex items-center gap-1.5 rounded-md bg-sunken px-2 py-1 text-[11.5px] text-ink-3" title="Only the driver can change files">
                  <Lock className="size-3" />
                  Read-only{driverName ? ` · ${driverName} is driving` : ""}
                </span>
              )}
            </div>
          </div>
        )}

        {/* banners */}
        {buf?.stale && (
          <div className="flex flex-wrap items-center gap-2 border-b border-attn/30 bg-attn-soft px-3 py-1.5 text-[12px] text-ink-2">
            <FileDiff className="size-3.5 text-attn" />
            <span className="min-w-0 flex-1">
              {writerName ? `${writerName[0].toUpperCase()}${writerName.slice(1)} changed` : "Someone changed"} this file while you were editing it.
            </span>
            <Button size="sm" variant="ghost" onClick={() => discardDraft(active!)}>
              Take theirs
            </Button>
            {canEdit && (
              <Button size="sm" onClick={() => save(true)}>
                Save mine over it
              </Button>
            )}
          </div>
        )}
        {dirty && !canEdit && (
          <div className="border-b border-line bg-sunken px-3 py-1.5 text-[12px] text-ink-3">
            You're not driving any more. Your unsaved edits stay here; ask for the baton to save them.
          </div>
        )}
        {agentHere && agent!.verb !== "reading" && (
          <div className="flex items-center gap-2 border-b border-baton/20 bg-baton-soft/60 px-3 py-1.5 text-[12px]">
            <AgentAvatar size={16} provider={session.provider} />
            <span className="shimmer-text font-medium">The agent is {agent!.verb} this file</span>
            {dirty && <span className="text-ink-3">· save soon, or you may have to merge</span>}
          </div>
        )}

        {/* editor */}
        <div className="relative min-h-0 flex-1">
          {!active ? (
            <div className="grid h-full place-items-center p-6 text-center text-[13px] text-ink-3">
              <div>
                <p className="font-medium text-ink-2">Open a file to see it here</p>
                <p className="mt-1">This is the agent's workspace, live. {canEdit ? "You're driving, so you can edit, save and run commands." : "You can watch and browse; the driver can edit."}</p>
              </div>
            </div>
          ) : !buf || !buf.loaded ? (
            <div className="grid h-full place-items-center">
              <Loader2 className="size-5 animate-spin text-ink-4" />
            </div>
          ) : buf.missing ? (
            <div className="grid h-full place-items-center p-6 text-center text-[13px] text-ink-3">This file doesn't exist in the workspace any more.</div>
          ) : showDiff && !buf.isNew ? (
            <div className="h-full overflow-auto">
              {dirty && <div className="border-b border-line bg-sunken px-3 py-1.5 text-[11.5px] text-ink-3">Showing saved changes only. Your unsaved edits aren't included.</div>}
              {buf.diff ? (
                <DiffView diff={buf.diff} maxHeight={100000} />
              ) : (
                <p className="p-4 text-[12.5px] text-ink-3">{buf.original === null ? "This file was created during the session." : "No changes from the original."}</p>
              )}
            </div>
          ) : (
            <CodeEditor
              path={active}
              doc={buf.draft ?? buf.content}
              readOnly={!canEdit}
              onChange={(text) => setDraft(active, text)}
              onSave={() => save()}
            />
          )}
        </div>

        <TerminalPanel
          runs={runs}
          open={terminalOpen}
          onToggle={toggleTerminal}
          canRun={canEdit}
          driverName={driverName}
          people={people}
          provider={session.provider}
          send={send}
        />
        <div className="hidden shrink-0 border-t border-line bg-canvas px-3 pt-1 pb-2.5 md:block xl:hidden">
          <Composer session={session} me={me} participants={participants} hasDecision={!!decision} send={send} compact />
        </div>
      </div>

      <AgentPane session={session} events={events} participants={participants} me={me} onOpenFile={(p) => openFile(p, { manual: true })} />
    </div>
  );
}
