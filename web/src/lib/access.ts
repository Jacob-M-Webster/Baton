import { create } from "zustand";

/**
 * A hosted Baton can require a shared access code (BATON_ACCESS_CODE). The server keeps a cookie once
 * it's entered. Invite links and QR codes may carry `?code=`, so a judge scanning one gets straight in.
 */
interface AccessState {
  checked: boolean;
  required: boolean;
  ok: boolean;
  code: string | null; // known once you're in, so your invite links can include it
  check: () => Promise<void>;
  unlock: (code: string) => Promise<void>;
}

async function status() {
  const r = await fetch("/api/access");
  if (!r.ok) throw new Error(`${r.status}`);
  return (await r.json()) as { required: boolean; ok: boolean; code: string | null };
}

async function post(code: string) {
  const r = await fetch("/api/access", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code }) });
  if (!r.ok) {
    let msg = "That code didn't work";
    try {
      msg = (await r.json()).detail || msg;
    } catch {
      /* not JSON */
    }
    throw new Error(msg);
  }
}

export const useAccess = create<AccessState>((set) => ({
  checked: false,
  required: false,
  ok: false,
  code: null,
  check: async () => {
    const params = new URLSearchParams(location.search);
    const fromLink = params.get("code");
    if (fromLink) {
      // Use the code from the invite link once, then take it out of the address bar.
      params.delete("code");
      const q = params.toString();
      history.replaceState(null, "", `${location.pathname}${q ? `?${q}` : ""}${location.hash}`);
      await post(fromLink).catch(() => {});
    }
    try {
      const s = await status();
      set({ checked: true, required: s.required, ok: s.ok, code: s.code });
    } catch {
      set({ checked: true, required: false, ok: true }); // server unreachable: let the app show its own errors
    }
  },
  unlock: async (code) => {
    await post(code.trim());
    const s = await status();
    set({ checked: true, required: s.required, ok: s.ok, code: s.code });
  },
}));

// Any API call or socket that's turned away (the cookie expired, the code changed) brings the gate back.
window.addEventListener("baton:locked", () => useAccess.setState({ ok: false, code: null }));
