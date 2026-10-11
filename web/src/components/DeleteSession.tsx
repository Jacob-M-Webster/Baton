import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { useLocation } from "wouter";
import clsx from "clsx";
import { Trash2 } from "lucide-react";
import { api } from "../lib/api";
import { refreshSessions } from "../lib/sessions";
import { Button } from "./Button";
import { toast } from "./Toasts";

/** The server lets the person who started a session delete it, and anyone delete an external agent's session. */
export function canDelete(s: { created_by: string; provider: string }, me: string | undefined) {
  return !!me && (s.created_by === me || (s.provider === "external" && s.created_by.startsWith("ext_")));
}

/** A trash button that asks before deleting a session for good. */
export function DeleteSessionButton({ session, me, className }: { session: { id: string; title: string }; me: string; className?: string }) {
  const [asking, setAsking] = useState(false);
  return (
    <>
      <span
        role="button"
        tabIndex={0}
        aria-label={`Delete ${session.title}`}
        title="Delete session"
        onClick={(e) => {
          // Rows are links; deleting must not also open the session.
          e.preventDefault();
          e.stopPropagation();
          setAsking(true);
        }}
        onKeyDown={(e) => {
          if (e.key !== "Enter" && e.key !== " ") return;
          e.preventDefault();
          e.stopPropagation();
          setAsking(true);
        }}
        className={clsx("grid size-6 shrink-0 place-items-center rounded-md text-ink-4 hover:bg-danger-soft hover:text-danger", className)}
      >
        <Trash2 className="size-3.5" />
      </span>
      {asking && <ConfirmDelete session={session} me={me} onClose={() => setAsking(false)} />}
    </>
  );
}

function ConfirmDelete({ session, me, onClose }: { session: { id: string; title: string }; me: string; onClose: () => void }) {
  const [loc, navigate] = useLocation();
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault(); // closing this dialog must not also interrupt the agent
      onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const remove = async () => {
    setBusy(true);
    try {
      await api.deleteSession(session.id, me);
      await refreshSessions();
      toast(`Deleted “${session.title}”`, "info");
      if (loc === `/s/${session.id}`) navigate("/");
      onClose();
    } catch (e) {
      toast((e as Error).message, "error");
      setBusy(false);
    }
  };

  // Portaled out of the row it was opened from; React still bubbles its clicks up there, hence stopPropagation.
  return createPortal(
    <div
      className="fixed inset-0 z-50 grid place-items-center bg-black/30 p-4 backdrop-blur-[2px]"
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="delete-title"
        className="animate-rise w-full max-w-sm rounded-2xl border border-line bg-raised p-6 text-left shadow-[0_24px_64px_-24px_rgb(0_0_0/0.45)]"
      >
        <h2 id="delete-title" className="text-lg font-semibold tracking-tight text-ink">
          Delete this session?
        </h2>
        <p className="mt-2 text-[13px] leading-relaxed text-ink-3">
          <span className="font-medium text-ink-2">{session.title}</span> will be gone for everyone: its timeline, comments and workspace.
          Forks made from it are kept. This can't be undone.
        </p>
        <div className="mt-6 flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button type="button" variant="danger" autoFocus onClick={remove} disabled={busy}>
            <Trash2 className="size-3.5" />
            {busy ? "Deleting…" : "Delete"}
          </Button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
