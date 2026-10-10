import { useState } from "react";
import clsx from "clsx";
import { PALETTE, useIdentity } from "../lib/identity";
import { Avatar } from "./Avatar";
import { Button } from "./Button";
import { Logo } from "./Logo";

export function IdentityModal({ onClose }: { onClose?: () => void }) {
  const { user, setUser } = useIdentity();
  const [name, setName] = useState(user?.name || "");
  const [color, setColor] = useState(user?.color || PALETTE[0]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  const submit = async () => {
    if (!name.trim()) return;
    setBusy(true);
    try {
      await setUser(name, color);
      onClose?.();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/30 p-4 backdrop-blur-[2px]">
      <form
        className="animate-rise w-full max-w-sm rounded-2xl border border-line bg-raised p-6 shadow-[0_24px_64px_-24px_rgb(0_0_0/0.45)]"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <Logo />
        <h2 className="mt-5 text-lg font-semibold tracking-tight">{user ? "Your profile" : "Who's joining?"}</h2>
        <p className="mt-1 text-[13px] text-ink-3">Teammates see this name next to everything you do in a session.</p>
        <div className="mt-5 flex items-center gap-3">
          <Avatar name={name || "?"} color={color} size={40} />
          <input
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={40}
            placeholder="Your name"
            className="h-10 flex-1 rounded-lg border border-line bg-panel px-3 text-sm outline-none focus:border-ink-3"
          />
        </div>
        <div className="mt-4 flex gap-2">
          {PALETTE.map((c) => (
            <button
              type="button"
              key={c}
              onClick={() => setColor(c)}
              className={clsx("size-6 rounded-full ring-offset-2 ring-offset-raised", color === c && "ring-2 ring-ink")}
              style={{ background: c }}
              aria-label={`Color ${c}`}
            />
          ))}
        </div>
        {err && <p className="mt-3 text-xs text-danger">{err}</p>}
        <div className="mt-6 flex justify-end gap-2">
          {onClose && user && (
            <Button type="button" variant="ghost" onClick={onClose}>
              Cancel
            </Button>
          )}
          <Button type="submit" variant="primary" disabled={!name.trim() || busy}>
            {user ? "Save" : "Continue"}
          </Button>
        </div>
      </form>
    </div>
  );
}
