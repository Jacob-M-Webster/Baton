export type Status = "running" | "paused" | "waiting_input" | "done" | "error";

export interface Session {
  id: string;
  title: string;
  task: string;
  created_by: string;
  created_at: number;
  updated_at: number;
  status: Status;
  driver_id: string | null;
  head_seq: number;
  summary_seq: number;
  parent_session_id: string | null;
  fork_seq: number | null;
  provider: string;
  model: string;
  config: { repo?: string };
}

export interface Participant {
  user_id: string;
  name: string;
  color: string;
  role: "driver" | "collaborator" | "viewer";
  is_owner: boolean;
  online: boolean;
  typing: boolean;
  viewing_seq: number | null;
  focus_seq: number | null;
  last_seen_seq: number;
  last_active: number;
}

export interface SessionSummary {
  id: string;
  title: string;
  status: Status;
  driver_id: string | null;
  head_seq: number;
  provider: string;
  model: string;
  created_at: number;
  updated_at: number;
  created_by: string;
  parent_session_id: string | null;
  fork_seq: number | null;
  participants: Participant[];
  progress: { done: number; total: number };
  needs_decision: boolean;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Payload = Record<string, any>;

export interface BatonEvent {
  session_id: string;
  seq: number;
  ts: number;
  actor: string;
  type: string;
  payload: Payload;
}

export interface Comment {
  id: string;
  session_id: string;
  event_seq: number;
  parent_id: string | null;
  user_id: string;
  body: string;
  resolved: boolean;
  promoted_seq: number | null;
  created_at: number;
  author_name: string;
  author_color: string;
}

export interface Intervention {
  seq: number;
  who: string;
  with?: string;
  what: string;
}

export interface CatchUp {
  goal: string;
  doing: string;
  done: string[];
  changed: Intervention[];
  next: string[];
  questions: { seq: number; question: string; options: string[] }[];
  head_seq: number;
  source: string;
  since_seq?: number;
  new_events?: number;
  new_interventions?: Intervention[];
}

export interface ProviderInfo {
  id: string;
  label: string;
  kind: "anthropic" | "openai" | "scripted";
  models: string[];
  configured: boolean;
  note: string;
  base_url: string | null;
}

export interface User {
  id: string;
  name: string;
  color: string;
}
