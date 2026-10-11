import { create } from "zustand";
import type { User } from "./types";
import { api } from "./api";

export const PALETTE = ["#2563eb", "#db2777", "#059669", "#d97706", "#7c3aed", "#0891b2", "#dc2626", "#4f46e5"];

const KEY = "baton.user";

function randomId() {
  return "u_" + Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
}

/**
 * Identity is a name and a color, kept in localStorage. `?as=Name` in the URL pins a
 * per-tab identity (sessionStorage), which makes it easy to rehearse a two-person demo
 * on one machine.
 */
function load(): User | null {
  try {
    const as = new URLSearchParams(location.search).get("as");
    if (as) {
      const existing = sessionStorage.getItem(KEY);
      const parsed: User | null = existing ? JSON.parse(existing) : null;
      if (parsed && parsed.name === as) return parsed;
      const u = { id: randomId(), name: as, color: PALETTE[Math.floor(Math.random() * PALETTE.length)] };
      sessionStorage.setItem(KEY, JSON.stringify(u));
      return u;
    }
    const tab = sessionStorage.getItem(KEY);
    if (tab) return JSON.parse(tab);
    const raw = localStorage.getItem(KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

interface IdentityState {
  user: User | null;
  ready: boolean;
  setUser: (name: string, color: string) => Promise<User>;
  sync: () => Promise<void>;
}

export const useIdentity = create<IdentityState>((set, get) => ({
  user: load(),
  ready: false,
  setUser: async (name, color) => {
    const prev = get().user;
    const u = await api.upsertUser({ id: prev?.id || randomId(), name: name.trim(), color });
    try {
      if (sessionStorage.getItem(KEY)) sessionStorage.setItem(KEY, JSON.stringify(u));
      else localStorage.setItem(KEY, JSON.stringify(u));
    } catch {
      /* storage unavailable: identity lasts for this page only */
    }
    set({ user: u, ready: true });
    return u;
  },
  sync: async () => {
    const u = get().user;
    if (u) {
      try {
        await api.upsertUser(u);
      } catch {
        /* server offline; the socket will retry */
      }
    }
    set({ ready: true });
  },
}));
