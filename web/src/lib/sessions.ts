import { useEffect } from "react";
import { create } from "zustand";
import { api } from "./api";
import type { SessionSummary } from "./types";

const useList = create<{ sessions: SessionSummary[]; loaded: boolean }>(() => ({ sessions: [], loaded: false }));
let timer: number | undefined;
let subscribers = 0;

async function refresh() {
  try {
    const r = await api.sessions();
    useList.setState({ sessions: r.sessions, loaded: true });
  } catch {
    useList.setState({ loaded: true });
  }
}

export function refreshSessions() {
  return refresh();
}

/** Session list with light polling; good enough for a left rail. */
export function useSessionList() {
  const state = useList();
  useEffect(() => {
    subscribers++;
    if (subscribers === 1) {
      refresh();
      timer = window.setInterval(refresh, 3000);
    }
    return () => {
      subscribers--;
      if (subscribers === 0) window.clearInterval(timer);
    };
  }, []);
  return state;
}
