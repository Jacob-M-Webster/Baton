"""SQLite storage: sessions, the append-only event log, participants, comments.

Everything runs on one asyncio loop in one process, so a single connection is
shared. WAL mode keeps the log durable across restarts (the resume demo).
"""
from __future__ import annotations

import json
import sqlite3
import time
import uuid
from pathlib import Path
from typing import Any

SCHEMA = """
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  task TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at REAL NOT NULL,
  updated_at REAL NOT NULL,
  status TEXT NOT NULL,
  driver_id TEXT,
  head_seq INTEGER NOT NULL DEFAULT 0,
  summary_seq INTEGER NOT NULL DEFAULT 0,
  parent_session_id TEXT,
  fork_seq INTEGER,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  config TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS events (
  session_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  ts REAL NOT NULL,
  actor TEXT NOT NULL,
  type TEXT NOT NULL,
  payload TEXT NOT NULL,
  PRIMARY KEY (session_id, seq)
);

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  color TEXT NOT NULL,
  created_at REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS participants (
  session_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  role TEXT NOT NULL,
  joined_at REAL NOT NULL,
  last_seen_seq INTEGER NOT NULL DEFAULT 0,
  last_active REAL NOT NULL,
  PRIMARY KEY (session_id, user_id)
);

CREATE TABLE IF NOT EXISTS comments (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  event_seq INTEGER NOT NULL,
  parent_id TEXT,
  user_id TEXT NOT NULL,
  body TEXT NOT NULL,
  resolved INTEGER NOT NULL DEFAULT 0,
  promoted_seq INTEGER,
  created_at REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS comments_by_session ON comments(session_id, event_seq);
"""

SESSION_FIELDS = (
    "id", "title", "task", "created_by", "created_at", "updated_at", "status", "driver_id",
    "head_seq", "summary_seq", "parent_session_id", "fork_seq", "provider", "model", "config",
)


def new_id(prefix: str = "") -> str:
    return prefix + uuid.uuid4().hex[:12]


class DB:
    def __init__(self, path: str | Path):
        self.path = str(path)
        if self.path != ":memory:":
            Path(self.path).parent.mkdir(parents=True, exist_ok=True)
        self.conn = sqlite3.connect(self.path, isolation_level=None, check_same_thread=False)
        self.conn.row_factory = sqlite3.Row
        self.conn.execute("PRAGMA journal_mode=WAL")
        self.conn.execute("PRAGMA synchronous=NORMAL")
        self.conn.executescript(SCHEMA)

    def close(self) -> None:
        self.conn.close()

    # ---- sessions -------------------------------------------------------
    def create_session(self, **fields: Any) -> dict:
        now = time.time()
        row = {
            "id": fields.get("id") or new_id("s_"),
            "title": fields["title"],
            "task": fields["task"],
            "created_by": fields["created_by"],
            "created_at": now,
            "updated_at": now,
            "status": fields.get("status", "running"),
            "driver_id": fields.get("driver_id", fields["created_by"]),
            "head_seq": 0,
            "summary_seq": 0,
            "parent_session_id": fields.get("parent_session_id"),
            "fork_seq": fields.get("fork_seq"),
            "provider": fields["provider"],
            "model": fields["model"],
            "config": json.dumps(fields.get("config") or {}),
        }
        cols = ",".join(row)
        self.conn.execute(
            f"INSERT INTO sessions ({cols}) VALUES ({','.join('?' * len(row))})", tuple(row.values())
        )
        return self.get_session(row["id"])  # type: ignore[return-value]

    def get_session(self, session_id: str) -> dict | None:
        r = self.conn.execute("SELECT * FROM sessions WHERE id=?", (session_id,)).fetchone()
        return _session(r) if r else None

    def list_sessions(self) -> list[dict]:
        rows = self.conn.execute("SELECT * FROM sessions ORDER BY updated_at DESC").fetchall()
        return [_session(r) for r in rows]

    def update_session(self, session_id: str, **fields: Any) -> None:
        if "config" in fields and not isinstance(fields["config"], str):
            fields["config"] = json.dumps(fields["config"])
        fields["updated_at"] = time.time()
        sets = ",".join(f"{k}=?" for k in fields)
        self.conn.execute(f"UPDATE sessions SET {sets} WHERE id=?", (*fields.values(), session_id))

    # ---- events ---------------------------------------------------------
    def append_event(self, session_id: str, actor: str, type_: str, payload: dict) -> dict:
        """Append one event and bump head_seq atomically. Returns the stored event."""
        ts = time.time()
        cur = self.conn.cursor()
        cur.execute("BEGIN IMMEDIATE")
        try:
            head = cur.execute("SELECT head_seq FROM sessions WHERE id=?", (session_id,)).fetchone()
            if head is None:
                raise KeyError(session_id)
            seq = head[0] + 1
            cur.execute(
                "INSERT INTO events (session_id, seq, ts, actor, type, payload) VALUES (?,?,?,?,?,?)",
                (session_id, seq, ts, actor, type_, json.dumps(payload)),
            )
            cur.execute("UPDATE sessions SET head_seq=?, updated_at=? WHERE id=?", (seq, ts, session_id))
            cur.execute("COMMIT")
        except Exception:
            cur.execute("ROLLBACK")
            raise
        return {"session_id": session_id, "seq": seq, "ts": ts, "actor": actor, "type": type_, "payload": payload}

    def events(self, session_id: str, after: int = 0, upto: int | None = None) -> list[dict]:
        q = "SELECT * FROM events WHERE session_id=? AND seq>?"
        args: list[Any] = [session_id, after]
        if upto is not None:
            q += " AND seq<=?"
            args.append(upto)
        q += " ORDER BY seq"
        return [_event(r) for r in self.conn.execute(q, args).fetchall()]

    def last_event_of(self, session_id: str, type_: str) -> dict | None:
        r = self.conn.execute(
            "SELECT * FROM events WHERE session_id=? AND type=? ORDER BY seq DESC LIMIT 1",
            (session_id, type_),
        ).fetchone()
        return _event(r) if r else None

    def open_decision_count(self, session_id: str) -> int:
        r = self.conn.execute(
            "SELECT SUM(type='agent.decision_point') - SUM(type='human.decision') FROM events "
            "WHERE session_id=? AND type IN ('agent.decision_point', 'human.decision')",
            (session_id,),
        ).fetchone()
        return int(r[0] or 0)

    def copy_events(self, src: str, dst: str, upto: int) -> int:
        """Copy src events 1..upto into dst (used for forks). Returns new head."""
        rows = self.conn.execute(
            "SELECT seq, ts, actor, type, payload FROM events WHERE session_id=? AND seq<=? ORDER BY seq",
            (src, upto),
        ).fetchall()
        cur = self.conn.cursor()
        cur.execute("BEGIN IMMEDIATE")
        cur.executemany(
            "INSERT INTO events (session_id, seq, ts, actor, type, payload) VALUES (?,?,?,?,?,?)",
            [(dst, r["seq"], r["ts"], r["actor"], r["type"], r["payload"]) for r in rows],
        )
        head = rows[-1]["seq"] if rows else 0
        cur.execute("UPDATE sessions SET head_seq=? WHERE id=?", (head, dst))
        cur.execute("COMMIT")
        return head

    # ---- users & participants ------------------------------------------
    def upsert_user(self, user_id: str, name: str, color: str) -> dict:
        self.conn.execute(
            "INSERT INTO users (id, name, color, created_at) VALUES (?,?,?,?) "
            "ON CONFLICT(id) DO UPDATE SET name=excluded.name, color=excluded.color",
            (user_id, name, color, time.time()),
        )
        return {"id": user_id, "name": name, "color": color}

    def get_user(self, user_id: str) -> dict | None:
        r = self.conn.execute("SELECT id, name, color FROM users WHERE id=?", (user_id,)).fetchone()
        return dict(r) if r else None

    def users(self, ids: list[str]) -> dict[str, dict]:
        if not ids:
            return {}
        q = f"SELECT id, name, color FROM users WHERE id IN ({','.join('?' * len(ids))})"
        return {r["id"]: dict(r) for r in self.conn.execute(q, ids).fetchall()}

    def upsert_participant(self, session_id: str, user_id: str, role: str) -> dict:
        now = time.time()
        self.conn.execute(
            "INSERT INTO participants (session_id, user_id, role, joined_at, last_active) VALUES (?,?,?,?,?) "
            "ON CONFLICT(session_id, user_id) DO NOTHING",
            (session_id, user_id, role, now, now),
        )
        return self.get_participant(session_id, user_id)  # type: ignore[return-value]

    def get_participant(self, session_id: str, user_id: str) -> dict | None:
        r = self.conn.execute(
            "SELECT * FROM participants WHERE session_id=? AND user_id=?", (session_id, user_id)
        ).fetchone()
        return dict(r) if r else None

    def participants(self, session_id: str) -> list[dict]:
        rows = self.conn.execute(
            "SELECT p.*, u.name, u.color FROM participants p JOIN users u ON u.id=p.user_id "
            "WHERE p.session_id=? ORDER BY p.joined_at",
            (session_id,),
        ).fetchall()
        return [dict(r) for r in rows]

    def update_participant(self, session_id: str, user_id: str, **fields: Any) -> None:
        sets = ",".join(f"{k}=?" for k in fields)
        self.conn.execute(
            f"UPDATE participants SET {sets} WHERE session_id=? AND user_id=?",
            (*fields.values(), session_id, user_id),
        )

    # ---- comments -------------------------------------------------------
    def add_comment(self, session_id: str, event_seq: int, user_id: str, body: str, parent_id: str | None) -> dict:
        cid = new_id("c_")
        self.conn.execute(
            "INSERT INTO comments (id, session_id, event_seq, parent_id, user_id, body, created_at) "
            "VALUES (?,?,?,?,?,?,?)",
            (cid, session_id, event_seq, parent_id, user_id, body, time.time()),
        )
        return self.get_comment(cid)  # type: ignore[return-value]

    def get_comment(self, comment_id: str) -> dict | None:
        r = self.conn.execute(
            "SELECT c.*, u.name AS author_name, u.color AS author_color FROM comments c "
            "LEFT JOIN users u ON u.id=c.user_id WHERE c.id=?",
            (comment_id,),
        ).fetchone()
        return _comment(r) if r else None

    def comments(self, session_id: str) -> list[dict]:
        rows = self.conn.execute(
            "SELECT c.*, u.name AS author_name, u.color AS author_color FROM comments c "
            "LEFT JOIN users u ON u.id=c.user_id WHERE c.session_id=? ORDER BY c.created_at",
            (session_id,),
        ).fetchall()
        return [_comment(r) for r in rows]

    def update_comment(self, comment_id: str, **fields: Any) -> None:
        sets = ",".join(f"{k}=?" for k in fields)
        self.conn.execute(f"UPDATE comments SET {sets} WHERE id=?", (*fields.values(), comment_id))

    def copy_comments(self, src: str, dst: str, upto: int) -> None:
        id_map: dict[str, str] = {}
        for c in self.comments(src):  # ordered by created_at, so parents come first
            if c["event_seq"] > upto:
                continue
            id_map[c["id"]] = new_id("c_")
            self.conn.execute(
                "INSERT INTO comments (id, session_id, event_seq, parent_id, user_id, body, resolved, created_at) "
                "VALUES (?,?,?,?,?,?,?,?)",
                (id_map[c["id"]], dst, c["event_seq"], id_map.get(c["parent_id"] or ""), c["user_id"],
                 c["body"], int(c["resolved"]), c["created_at"]),
            )


def _session(r: sqlite3.Row) -> dict:
    d = {k: r[k] for k in SESSION_FIELDS}
    d["config"] = json.loads(d["config"] or "{}")
    return d


def _event(r: sqlite3.Row) -> dict:
    return {
        "session_id": r["session_id"],
        "seq": r["seq"],
        "ts": r["ts"],
        "actor": r["actor"],
        "type": r["type"],
        "payload": json.loads(r["payload"]),
    }


def _comment(r: sqlite3.Row) -> dict:
    d = dict(r)
    d["resolved"] = bool(d["resolved"])
    return d
