import type {
  CatchUp, Comment, FileContent, KeySettings, ProviderInfo, Session, SessionSummary, User, Participant, WorkspaceFile,
} from "./types";

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const r = await fetch(path, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers || {}) },
  });
  if (!r.ok) {
    let msg = `${r.status} ${r.statusText}`;
    if (r.status === 401) window.dispatchEvent(new Event("baton:locked")); // needs the access code again
    try {
      const body = await r.json();
      msg = body.error || body.detail || msg;
      if (Array.isArray(msg)) msg = "Please check the form and try again";
    } catch {
      /* not JSON */
    }
    throw new Error(String(msg));
  }
  return r.json();
}

export const api = {
  info: () => req<{ lan_urls: string[]; port: number }>("/api/info"),
  models: () => req<{ providers: ProviderInfo[] }>("/api/models"),
  repos: () => req<{ repos: { id: string; description: string }[] }>("/api/repos"),
  upsertUser: (u: User) => req<User>("/api/users", { method: "POST", body: JSON.stringify(u) }),
  sessions: () => req<{ sessions: SessionSummary[] }>("/api/sessions"),
  createSession: (body: {
    user_id: string;
    task: string;
    provider: string;
    model: string;
    repo: string;
    github?: string; // owner/name or a github.com URL; the server clones it
    ref?: string;
    title?: string;
  }) => req<Session & { participants: Participant[] }>("/api/sessions", { method: "POST", body: JSON.stringify(body) }),
  deleteSession: (id: string, userId: string) =>
    req<{ ok: true }>(`/api/sessions/${id}?user_id=${encodeURIComponent(userId)}`, { method: "DELETE" }),
  settings: () => req<KeySettings>("/api/settings"),
  saveKeys: (values: Record<string, string | null>) =>
    req<KeySettings>("/api/settings", { method: "PUT", body: JSON.stringify({ values }) }),
  session: (id: string, userId?: string) =>
    req<{ session: Session & { participants: Participant[] }; catchup: CatchUp; comments: Comment[] }>(
      `/api/sessions/${id}${userId ? `?user_id=${encodeURIComponent(userId)}` : ""}`,
    ),
  catchup: (id: string, userId?: string) =>
    req<CatchUp>(`/api/sessions/${id}/catchup${userId ? `?user_id=${encodeURIComponent(userId)}` : ""}`),
  fork: (id: string, seq: number, userId: string) =>
    req<Session>(`/api/sessions/${id}/fork`, { method: "POST", body: JSON.stringify({ seq, user_id: userId }) }),
  preview: (id: string) => req<{ base: string }>(`/api/sessions/${id}/preview`),
  files: (id: string) => req<{ files: WorkspaceFile[] }>(`/api/sessions/${id}/files`),
  file: (id: string, path: string) =>
    req<FileContent>(`/api/sessions/${id}/files/${path.split("/").map(encodeURIComponent).join("/")}`),
};
