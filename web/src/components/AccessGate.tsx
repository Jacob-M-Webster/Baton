import { useState } from "react";
import { KeyRound } from "lucide-react";
import { useAccess } from "../lib/access";
import { Button } from "./Button";
import { Logo } from "./Logo";

export function AccessGate() {
  const unlock = useAccess((s) => s.unlock);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  const submit = async () => {
    if (!code.trim()) return;
    setBusy(true);
    setErr("");
    try {
      await unlock(code);
    } catch (e) {
      setErr((e as Error).message);
      setBusy(false);
    }
  };

  return (
    <div className="grid min-h-full place-items-center bg-canvas p-4">
      <form
        className="animate-rise w-full max-w-sm rounded-2xl border border-line bg-raised p-6 shadow-[0_24px_64px_-24px_rgb(0_0_0/0.45)]"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <Logo />
        <h2 className="mt-5 text-lg font-semibold tracking-tight">Enter the access code</h2>
        <p className="mt-1 text-[13px] text-ink-3">
          This Baton is private. Ask whoever invited you for the code, or scan the QR code on their screen.
        </p>
        <div className="mt-5 flex items-center gap-2 rounded-lg border border-line bg-panel px-3 focus-within:border-ink-3">
          <KeyRound className="size-4 text-ink-4" />
          <input
            autoFocus
            value={code}
            onChange={(e) => setCode(e.target.value)}
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            placeholder="Access code"
            className="h-11 min-w-0 flex-1 bg-transparent text-base outline-none sm:text-sm"
          />
        </div>
        {err && <p className="mt-3 text-xs text-danger">{err}</p>}
        <Button type="submit" variant="primary" disabled={!code.trim() || busy} className="mt-5 h-10 w-full">
          Continue
        </Button>
      </form>
    </div>
  );
}
