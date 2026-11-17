"""Durable agent registry and inbox. The server never interprets or executes messages."""
from __future__ import annotations

import hashlib
import secrets
import sqlite3
import threading
import time
import uuid
from pathlib import Path


MESSAGE_TTL_SECONDS = 24 * 60 * 60


def now() -> float:
    return time.time()


def opaque_id() -> str:
    return str(uuid.uuid4())


def digest(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def public_agent(row: sqlite3.Row, *, present: bool = False, active_window: float = 90.0) -> dict:
    data = dict(row)
    data.pop("token_hash", None)
    last_mcp = data.get("last_mcp_activity") or 0
    last_channel = data.get("last_channel_activity") or 0
    if data["kind"] == "dashboard":
        data["online"] = bool(data["dashboard_enabled"] and
                              (data["last_dashboard_seen"] or 0) > now() - 35)
    else:
        data["online"] = bool(present or max(last_mcp, last_channel) > now() - active_window)
    data["active_mcp"] = bool(last_mcp > now() - 60)
    return data


class Store:
    def __init__(self, path: str | Path):
        path = str(path)
        if path != ":memory:":
            Path(path).parent.mkdir(parents=True, exist_ok=True)
        self.db = sqlite3.connect(path, check_same_thread=False, timeout=5)
        self.db.row_factory = sqlite3.Row
        self.lock = threading.RLock()
        with self.lock, self.db:
            self.db.executescript("""
                PRAGMA journal_mode=WAL;
                PRAGMA busy_timeout=5000;
                CREATE TABLE IF NOT EXISTS agents(
                    agent_id TEXT PRIMARY KEY,
                    name TEXT NOT NULL UNIQUE,
                    kind TEXT NOT NULL,
                    role TEXT NOT NULL,
                    purpose TEXT NOT NULL DEFAULT '',
                    description TEXT NOT NULL DEFAULT '',
                    current_task TEXT NOT NULL DEFAULT '',
                    task_status TEXT NOT NULL DEFAULT 'idle',
                    token_hash TEXT NOT NULL,
                    created_at REAL NOT NULL,
                    updated_at REAL NOT NULL,
                    last_mcp_activity REAL,
                    last_poll_at REAL,
                    last_channel_activity REAL,
                    last_wake_at REAL,
                    last_wake_result TEXT NOT NULL DEFAULT ''
                );
                CREATE TABLE IF NOT EXISTS messages(
                    message_id TEXT PRIMARY KEY,
                    sender_id TEXT NOT NULL REFERENCES agents(agent_id),
                    recipient_id TEXT NOT NULL REFERENCES agents(agent_id),
                    body TEXT NOT NULL,
                    task_id TEXT NOT NULL DEFAULT '',
                    client_message_id TEXT,
                    created_at REAL NOT NULL,
                    acknowledged_at REAL,
                    status TEXT NOT NULL DEFAULT 'pending'
                );
                CREATE UNIQUE INDEX IF NOT EXISTS msg_dedup
                  ON messages(sender_id, client_message_id)
                  WHERE client_message_id IS NOT NULL;
                CREATE INDEX IF NOT EXISTS inbox_pending
                  ON messages(recipient_id, status, created_at);
                CREATE INDEX IF NOT EXISTS messages_expiration
                  ON messages(created_at);
                -- Remove indexes used by the previous per-status retention policy.
                DROP INDEX IF EXISTS pending_expiration;
                DROP INDEX IF EXISTS acknowledged_by_recipient;
                CREATE TABLE IF NOT EXISTS channels(
                    channel_id TEXT PRIMARY KEY,
                    agent_id TEXT NOT NULL REFERENCES agents(agent_id),
                    kind TEXT NOT NULL,
                    connected INTEGER NOT NULL DEFAULT 0,
                    state TEXT NOT NULL DEFAULT 'unknown',
                    connected_at REAL NOT NULL,
                    last_seen REAL NOT NULL,
                    last_wake_result TEXT NOT NULL DEFAULT ''
                );
                CREATE INDEX IF NOT EXISTS channels_agent ON channels(agent_id, connected);
            """)
            self.db.execute("PRAGMA foreign_keys=ON")
            # Compatible migration for existing agent-network.db files.
            columns = {r["name"] for r in self.db.execute("PRAGMA table_info(agents)")}
            if "dashboard_enabled" not in columns:
                self.db.execute("ALTER TABLE agents ADD COLUMN dashboard_enabled INTEGER NOT NULL DEFAULT 0")
            if "last_dashboard_seen" not in columns:
                self.db.execute("ALTER TABLE agents ADD COLUMN last_dashboard_seen REAL")
            self.db.execute("""
                CREATE TABLE IF NOT EXISTS tool_calls (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    tool_name TEXT NOT NULL,
                    agent_id TEXT,
                    status TEXT NOT NULL,
                    duration_ms REAL NOT NULL,
                    created_at REAL NOT NULL
                )
            """)
        # Enable incremental compaction on new and existing file-backed DBs.
        # Existing databases need a one-time VACUUM to change auto_vacuum mode.
        if path != ":memory:":
            with self.lock:
                if self.db.execute("PRAGMA auto_vacuum").fetchone()[0] != 2:
                    self.db.execute("PRAGMA auto_vacuum=INCREMENTAL")
                    self.db.execute("VACUUM")

    def maintain_storage(self) -> dict:
        """Return unused SQLite pages to the OS without compacting every sweep."""
        with self.lock:
            free = self.db.execute("PRAGMA freelist_count").fetchone()[0]
            if free:
                self.db.execute(f"PRAGMA incremental_vacuum({min(free, 2048)})")
            # Keep WAL files from retaining a peak-size journal indefinitely.
            self.db.execute("PRAGMA wal_checkpoint(TRUNCATE)")
            return {"free_pages_before": free}

    @staticmethod
    def _last_activity(agent: sqlite3.Row) -> float:
        return max(agent["created_at"], agent["updated_at"],
                   agent["last_mcp_activity"] or 0,
                   agent["last_channel_activity"] or 0,
                   agent["last_dashboard_seen"] or 0)

    def _has_live_channel(self, agent_id: str) -> bool:
        return self.db.execute(
            "SELECT 1 FROM channels WHERE agent_id=? AND connected=1 LIMIT 1",
            (agent_id,),
        ).fetchone() is not None

    def _has_pending_messages(self, agent_id: str, at: float) -> bool:
        return self.db.execute(
            "SELECT 1 FROM messages WHERE recipient_id=? AND status='pending' "
            "AND created_at>? LIMIT 1",
            (agent_id, at - MESSAGE_TTL_SECONDS),
        ).fetchone() is not None

    def prune_messages(self, *, at: float | None = None) -> dict:
        """Delete ALL messages older than 24 hours, independent of status.

        Expiration is based on creation, not acknowledgment. The maintenance
        loop calls this on startup and periodically; send/ACK also respect TTL.
        """
        cutoff = (now() if at is None else at) - MESSAGE_TTL_SECONDS
        with self.lock, self.db:
            removed = self.db.execute(
                "DELETE FROM messages WHERE created_at <= ?", (cutoff,)
            ).rowcount
            return {"expired_messages": removed}

    def delete_agent(self, agent_id: str) -> dict:
        """Delete one identity and its dependent queue/channel records atomically.

        Existing tokens become invalid immediately; the freed name can be reused
        by a fresh registration. Callers authorize this operation separately.
        """
        with self.lock, self.db:
            agent = self._agent(agent_id)
            messages = self.db.execute(
                "DELETE FROM messages WHERE sender_id=? OR recipient_id=?",
                (agent_id, agent_id)
            ).rowcount
            channels = self.db.execute(
                "DELETE FROM channels WHERE agent_id=?", (agent_id,)
            ).rowcount
            # Keep aggregate tool telemetry but unlink it from deleted identities.
            self.db.execute("UPDATE tool_calls SET agent_id=NULL WHERE agent_id=?",
                            (agent_id,))
            self.db.execute("DELETE FROM agents WHERE agent_id=?", (agent_id,))
            return {"agent_id": agent_id, "name": agent["name"],
                    "deleted_messages": messages, "deleted_channels": channels}

    def prune_agents(self, *, at: float | None = None,
                     exclude_ids: set[str] | None = None) -> list[dict]:
        """Expire identities with no activity for >24h, freeing their names.

        Live sidecars supplied by Broker are excluded even if no ping has been
        observed recently. A recent inbound message does not reset recipient
        activity, so an abandoned identity can still expire.
        """
        cutoff = (now() if at is None else at) - MESSAGE_TTL_SECONDS
        excluded = exclude_ids or set()
        deleted = []
        with self.lock, self.db:
            rows = self.db.execute(
                """SELECT agent_id FROM agents
                   WHERE max(created_at, updated_at,
                             coalesce(last_mcp_activity,0),
                             coalesce(last_channel_activity,0),
                             coalesce(last_dashboard_seen,0)) < ?
                   ORDER BY agent_id""",
                (cutoff,)
            ).fetchall()
            for row in rows:
                agent_id = row["agent_id"]
                if agent_id in excluded:
                    continue
                if self._has_live_channel(agent_id):
                    continue
                # Preserve the full 24-hour TTL of previously accepted messages.
                # New messages to already-expired recipients are rejected.
                if self._has_pending_messages(agent_id, now() if at is None else at):
                    continue
                deleted.append(self.delete_agent(agent_id))
        return deleted

    def prune_channels(self, *, at: float | None = None) -> int:
        """Discard old disconnected wake-channel sessions (not registered agents)."""
        cutoff = (now() if at is None else at) - MESSAGE_TTL_SECONDS
        with self.lock, self.db:
            return self.db.execute(
                "DELETE FROM channels WHERE connected=0 AND last_seen <= ?",
                (cutoff,)
            ).rowcount

    def dashboard_snapshot(self, *, present_ids: set[str] | None = None,
                           window_seconds: int = 86400) -> dict:
        """Public LOCAL dashboard metadata. Never return credentials or bodies."""
        cutoff = now() - window_seconds
        with self.lock:
            agents = [public_agent(r, present=r["agent_id"] in (present_ids or set()))
                      for r in self.db.execute("SELECT * FROM agents ORDER BY name")]
            pending = {
                row["recipient_id"]: row["total"]
                for row in self.db.execute(
                    "SELECT recipient_id, count(*) AS total FROM messages "
                    "WHERE status='pending' AND created_at>? GROUP BY recipient_id",
                    (cutoff,)
                )
            }
            for agent in agents:
                agent["pending_messages"] = pending.get(agent["agent_id"], 0)

            channels = [dict(r) for r in self.db.execute(
                "SELECT c.channel_id, c.agent_id, a.name AS agent_name, c.kind,"
                " c.connected, c.state, c.connected_at, c.last_seen, c.last_wake_result"
                " FROM channels c JOIN agents a ON a.agent_id=c.agent_id"
                " WHERE c.connected=1 ORDER BY c.last_seen DESC"
            )]
            edges = [dict(r) for r in self.db.execute(
                "SELECT sender_id AS source, recipient_id AS target,"
                " count(*) AS recent_count,"
                " sum(CASE WHEN status='pending' THEN 1 ELSE 0 END) AS pending_count,"
                " max(created_at) AS last_message_at "
                "FROM messages WHERE created_at>? "
                "GROUP BY sender_id,recipient_id "
                "ORDER BY last_message_at DESC LIMIT 100",
                (cutoff,)
            )]
            recent = self.message_history(page=1)["items"]
            totals = self.db.execute(
                "SELECT count(*) AS all_messages,"
                " sum(CASE WHEN status='pending' THEN 1 ELSE 0 END) AS pending_messages,"
                " count(*) AS messages_24h "
                "FROM messages WHERE created_at>?",
                (cutoff,)
            ).fetchone()
            return {
                "agents": agents, "channels": channels,
                "edges": edges, "recent": recent,
                "metrics": {
                    "agents_total": len(agents),
                    "agents_online": sum(a["online"] for a in agents),
                    "agents_working": sum(a["task_status"] == "working" for a in agents),
                    "pending_messages": totals["pending_messages"] or 0,
                    "messages_24h": totals["messages_24h"] or 0,
                    "messages_total": totals["all_messages"] or 0,
                    "channels_connected": len(channels),
                },
            }

    def record_tool_call(self, tool_name: str, status: str,
                         duration_ms: float, agent_id: str = "") -> None:
        """Keep only 100 safe MCP invocation summaries, no args or message bodies."""
        with self.lock, self.db:
            self.db.execute(
                "INSERT INTO tool_calls(tool_name, agent_id, status, duration_ms, created_at) "
                "VALUES(?,?,?,?,?)",
                (tool_name[:100], agent_id[:128] or None, status[:30],
                 round(max(0.0, duration_ms), 2), now())
            )
            self.db.execute(
                "DELETE FROM tool_calls WHERE id NOT IN "
                "(SELECT id FROM tool_calls ORDER BY id DESC LIMIT 100)"
            )

    def tool_history(self, page: int = 1, page_size: int = 10) -> dict:
        if not 1 <= page <= 10 or page_size != 10:
            raise ValueError("Tool history supports pages 1..10, 10 rows each")
        with self.lock:
            total = self.db.execute("SELECT count(*) FROM tool_calls").fetchone()[0]
            rows = self.db.execute(
                "SELECT t.id,t.tool_name,t.agent_id,a.name AS agent_name,"
                " t.status,t.duration_ms,t.created_at "
                "FROM tool_calls t LEFT JOIN agents a ON a.agent_id=t.agent_id "
                "ORDER BY t.id DESC LIMIT ? OFFSET ?",
                (page_size, (page - 1) * page_size)
            ).fetchall()
            stats = self.db.execute(
                "SELECT avg(duration_ms) AS avg_ms,max(duration_ms) AS max_ms "
                "FROM tool_calls"
            ).fetchone()
            return {
                "items": [dict(r) for r in rows],
                "page": page, "page_size": page_size, "total": total,
                "pages": max(1, (total + page_size - 1) // page_size),
                "avg_ms": round(stats["avg_ms"] or 0, 2),
                "max_ms": round(stats["max_ms"] or 0, 2),
            }

    def message_history(self, page: int = 1, page_size: int = 10) -> dict:
        if page < 1 or page_size != 10:
            raise ValueError("Message history supports pages >= 1, 10 rows each")
        with self.lock:
            cutoff = now() - MESSAGE_TTL_SECONDS
            total = self.db.execute(
                "SELECT count(*) FROM messages WHERE created_at>?",
                (cutoff,)
            ).fetchone()[0]
            rows = self.db.execute(
                "SELECT m.message_id, m.sender_id, s.name AS sender_name,"
                " m.recipient_id, r.name AS recipient_name, m.created_at,"
                " m.acknowledged_at,m.status "
                "FROM messages m JOIN agents s ON s.agent_id=m.sender_id "
                "JOIN agents r ON r.agent_id=m.recipient_id "
                "WHERE m.created_at>? "
                "ORDER BY m.created_at DESC,m.rowid DESC LIMIT ? OFFSET ?",
                (cutoff, page_size, (page-1)*page_size)
            ).fetchall()
            return {
                "items": [dict(row) for row in rows],
                "page": page, "page_size": page_size, "total": total,
                "pages": max(1, (total + page_size - 1) // page_size),
            }

    def enable_dashboard(self, name: str, agent_id: str = "", token: str = "") -> dict:
        result = self.register(
            name=name, role="Dashboard operator", kind="dashboard",
            purpose="Debugging agent messaging and delivery",
            description="Human-operated dashboard agent", agent_id=agent_id, token=token
        )
        aid = result["agent"]["agent_id"]
        with self.lock, self.db:
            agent = self._agent(aid)
            if agent["kind"] != "dashboard":
                raise ValueError("Agent identity is not a dashboard")
            self.db.execute(
                "UPDATE agents SET dashboard_enabled=1,last_dashboard_seen=?,"
                " task_status='idle',updated_at=? WHERE agent_id=?",
                (now(), now(), aid)
            )
            result["agent"] = public_agent(self._agent(aid))
        return result

    def dashboard_auth(self, agent_id: str, token: str, *, touch: bool = True) -> dict:
        with self.lock, self.db:
            agent = self.verify(agent_id, token)
            if agent["kind"] != "dashboard":
                raise PermissionError("Dashboard agent credentials required")
            if not agent["dashboard_enabled"]:
                raise PermissionError("Dashboard agent is switched off")
            if touch:
                self.db.execute(
                    "UPDATE agents SET last_dashboard_seen=? WHERE agent_id=?",
                    (now(), agent_id)
                )
            return public_agent(self._agent(agent_id))

    def disable_dashboard(self, agent_id: str, token: str) -> dict:
        self.dashboard_auth(agent_id, token, touch=False)
        with self.lock, self.db:
            self.db.execute(
                "UPDATE agents SET dashboard_enabled=0,task_status='idle',"
                " updated_at=? WHERE agent_id=?",
                (now(), agent_id)
            )
            return public_agent(self._agent(agent_id))

    def _activity(self, agent_id: str, token: str, polled: bool,
                  source: str) -> None:
        if source == "dashboard":
            self.dashboard_auth(agent_id, token)
        else:
            self.touch_mcp(agent_id, token, polled=polled)

    def close(self):
        with self.lock:
            self.db.close()

    def _agent(self, agent_id: str) -> sqlite3.Row:
        row = self.db.execute("SELECT * FROM agents WHERE agent_id=?", (agent_id,)).fetchone()
        if row is None:
            raise ValueError("Unknown agent_id")
        return row

    def verify(self, agent_id: str, token: str) -> sqlite3.Row:
        with self.lock:
            row = self._agent(agent_id)
            if not token or not secrets.compare_digest(row["token_hash"], digest(token)):
                raise PermissionError("Invalid agent token")
            return row

    def register(self, name: str, role: str, kind: str, purpose: str = "",
                 description: str = "", agent_id: str = "", token: str = "") -> dict:
        name = name.strip()
        if not (1 <= len(name) <= 64) or not all(c.isalnum() or c in "-_." for c in name):
            raise ValueError("Agent name must be 1..64 letters, digits, '.', '-' or '_'")
        role = role.strip()
        kind = kind.strip().lower()
        if not role or len(role) > 120 or kind not in ("chatgpt", "codex", "claude", "dashboard", "other"):
            raise ValueError("Invalid role or kind")
        if len(purpose) > 1000 or len(description) > 2000:
            raise ValueError("Profile field too long")
        with self.lock, self.db:
            existing = self.db.execute("SELECT * FROM agents WHERE name=?", (name,)).fetchone()
            if existing:
                if not agent_id or existing["agent_id"] != agent_id:
                    raise ValueError("Agent name already registered; use its id and token to reconnect")
                self.verify(agent_id, token)
                self.db.execute(
                    "UPDATE agents SET last_mcp_activity=? WHERE agent_id=?",
                    (now(), agent_id),
                )
                return {"agent": public_agent(self._agent(agent_id)), "token": token, "created": False}
            if agent_id:
                raise ValueError("Unknown agent identity; omit id to create a new agent")
            agent_id = opaque_id()
            secret = secrets.token_urlsafe(32)
            stamp = now()
            self.db.execute(
                "INSERT INTO agents(agent_id,name,kind,role,purpose,description,token_hash,created_at,updated_at,last_mcp_activity) "
                "VALUES(?,?,?,?,?,?,?,?,?,?)",
                (agent_id, name, kind, role, purpose, description, digest(secret), stamp, stamp, stamp)
            )
            return {"agent": public_agent(self._agent(agent_id)), "token": secret, "created": True}

    def update_profile(self, agent_id: str, token: str, *, role: str = "",
                       purpose: str = "", description: str = "") -> dict:
        self.verify(agent_id, token)
        if not role.strip() or len(role) > 120 or len(purpose) > 1000 or len(description) > 2000:
            raise ValueError("Invalid profile")
        with self.lock, self.db:
            self.db.execute(
                "UPDATE agents SET role=?, purpose=?, description=?, updated_at=? WHERE agent_id=?",
                (role.strip(), purpose, description, now(), agent_id))
            return public_agent(self._agent(agent_id))

    def touch_mcp(self, agent_id: str, token: str, *, polled: bool = False) -> None:
        self.verify(agent_id, token)
        with self.lock, self.db:
            stamp = now()
            if polled:
                self.db.execute(
                    "UPDATE agents SET last_mcp_activity=?, last_poll_at=? WHERE agent_id=?",
                    (stamp, stamp, agent_id))
            else:
                self.db.execute("UPDATE agents SET last_mcp_activity=? WHERE agent_id=?",
                                (stamp, agent_id))

    def agents(self, *, present_ids: set[str] | None = None) -> list[dict]:
        with self.lock:
            rows = self.db.execute("SELECT * FROM agents ORDER BY name").fetchall()
            return [public_agent(r, present=r["agent_id"] in (present_ids or set()))
                    for r in rows]

    def resolve(self, name_or_id: str) -> sqlite3.Row:
        with self.lock:
            row = self.db.execute("SELECT * FROM agents WHERE agent_id=? OR name=?",
                                  (name_or_id, name_or_id)).fetchone()
            if row is None:
                raise ValueError("Recipient agent not found")
            return row

    def send(self, sender_id: str, token: str, to: str, body: str,
             task_id: str = "", client_message_id: str = "",
             source: str = "mcp") -> dict:
        self._activity(sender_id, token, polled=False, source=source)
        body = body.strip()
        if not body or len(body) > 16000 or len(task_id) > 128 or len(client_message_id) > 128:
            raise ValueError("Invalid message length or identifier")
        with self.lock, self.db:
            # Expired idempotency keys must not block new messages.
            self.db.execute(
                "DELETE FROM messages WHERE created_at <= ?",
                (now() - MESSAGE_TTL_SECONDS,)
            )
            if client_message_id:
                existing = self.db.execute(
                    "SELECT * FROM messages WHERE sender_id=? AND client_message_id=?",
                    (sender_id, client_message_id)).fetchone()
                if existing:
                    # Repeated request must agree with the first request.
                    recipient = self.resolve(to)
                    if (existing["recipient_id"] != recipient["agent_id"] or
                        existing["body"] != body or existing["task_id"] != task_id):
                        raise ValueError("Idempotency key reused with different message")
                    return {"message_id": existing["message_id"], "duplicate": True}
            recipient = self.resolve(to)
            # An expired identity must not accept messages that maintenance
            # will immediately destroy. This check is atomic with the insert.
            stamp = now()
            if (self._last_activity(recipient) <= stamp - MESSAGE_TTL_SECONDS
                    and not self._has_live_channel(recipient["agent_id"])):
                raise ValueError("Recipient agent has expired; refresh the agent list")
            message_id = opaque_id()
            self.db.execute(
                "INSERT INTO messages(message_id,sender_id,recipient_id,body,task_id,client_message_id,created_at) "
                "VALUES(?,?,?,?,?,?,?)",
                (message_id, sender_id, recipient["agent_id"], body, task_id,
                 client_message_id or None, now()))
            return {"message_id": message_id, "duplicate": False}

    def inbox(self, agent_id: str, token: str, limit: int = 30,
              source: str = "mcp") -> list[dict]:
        if not 1 <= limit <= 100:
            raise ValueError("limit must be 1..100")
        self._activity(agent_id, token, polled=True, source=source)
        with self.lock:
            rows = self.db.execute(
                "SELECT m.*, a.name AS sender_name FROM messages m "
                "JOIN agents a ON a.agent_id=m.sender_id "
                "WHERE m.recipient_id=? AND m.status='pending' AND m.created_at > ? "
                "ORDER BY m.created_at,m.message_id LIMIT ?",
                (agent_id, now() - MESSAGE_TTL_SECONDS, limit)).fetchall()
            return [dict(x) for x in rows]

    def acknowledge(self, agent_id: str, token: str, message_id: str,
                    source: str = "mcp") -> dict:
        self._activity(agent_id, token, polled=False, source=source)
        with self.lock, self.db:
            self.db.execute(
                "DELETE FROM messages WHERE created_at <= ?",
                (now() - MESSAGE_TTL_SECONDS,)
            )
            msg = self.db.execute("SELECT * FROM messages WHERE message_id=?", (message_id,)).fetchone()
            if msg is None or msg["recipient_id"] != agent_id:
                raise ValueError("Message not found in your inbox")
            if msg["status"] == "pending":
                self.db.execute(
                    "UPDATE messages SET status='acknowledged', acknowledged_at=? WHERE message_id=?",
                    (now(), message_id))
            return {"message_id": message_id, "status": "acknowledged"}

    def update_task(self, agent_id: str, token: str, task: str, status: str) -> dict:
        self.touch_mcp(agent_id, token)
        if len(task) > 1000 or status not in ("idle", "working", "blocked", "done", "failed"):
            raise ValueError("Invalid task or status")
        with self.lock, self.db:
            self.db.execute(
                "UPDATE agents SET current_task=?,task_status=?,updated_at=? WHERE agent_id=?",
                (task, status, now(), agent_id))
            return public_agent(self._agent(agent_id))

    def connect_channel(self, agent_id: str, token: str, kind: str, channel_id: str,
                        state: str) -> None:
        self.verify(agent_id, token)
        if kind not in ("chatgpt", "codex", "other"):
            raise ValueError("Unsupported channel kind")
        if state not in ("idle", "busy", "draft", "unknown"):
            raise ValueError("Invalid adapter state")
        with self.lock, self.db:
            stamp = now()
            self.db.execute(
                "INSERT INTO channels(channel_id,agent_id,kind,connected,state,connected_at,last_seen) "
                "VALUES(?,?,?,1,?,?,?)",
                (channel_id, agent_id, kind, state, stamp, stamp))
            self.db.execute("UPDATE agents SET last_channel_activity=? WHERE agent_id=?",
                            (stamp, agent_id))

    def update_channel(self, channel_id: str, state: str):
        if state not in ("idle", "busy", "draft", "unknown"):
            raise ValueError("Invalid adapter state")
        with self.lock, self.db:
            stamp = now()
            self.db.execute("UPDATE channels SET last_seen=?, state=? WHERE channel_id=? AND connected=1",
                            (stamp, state, channel_id))
            self.db.execute(
                "UPDATE agents SET last_channel_activity=? "
                "WHERE agent_id=(SELECT agent_id FROM channels WHERE channel_id=?)",
                (stamp, channel_id))

    def disconnect_channel(self, channel_id: str):
        with self.lock, self.db:
            self.db.execute("UPDATE channels SET connected=0 WHERE channel_id=?", (channel_id,))

    def disconnect_all_channels(self):
        # Channels from a previous server process must not show as connected.
        with self.lock, self.db:
            self.db.execute("UPDATE channels SET connected=0")

    def channel_result(self, channel_id: str, result: str):
        with self.lock, self.db:
            self.db.execute("UPDATE channels SET last_wake_result=? WHERE channel_id=?",
                            (result[:256], channel_id))

    def candidates(self, inactive_seconds: float, cooldown_seconds: float) -> list[dict]:
        stamp = now()
        with self.lock:
            rows = self.db.execute(
                "SELECT a.agent_id,a.name,a.kind,a.last_wake_at,a.last_mcp_activity,"
                " COUNT(m.message_id) AS pending_count FROM agents a "
                "JOIN messages m ON m.recipient_id=a.agent_id AND m.status='pending' "
                "AND m.created_at>? "
                "GROUP BY a.agent_id HAVING pending_count > 0",
                (stamp - MESSAGE_TTL_SECONDS,)).fetchall()
            return [
                dict(r) for r in rows
                if (r["last_mcp_activity"] or 0) <= stamp-inactive_seconds
                and (r["last_wake_at"] or 0) <= stamp-cooldown_seconds
            ]

    def mark_wake(self, agent_id: str, result: str = "dispatched"):
        with self.lock, self.db:
            self.db.execute("UPDATE agents SET last_wake_at=?,last_wake_result=? WHERE agent_id=?",
                            (now(), result, agent_id))

    def wake_result(self, agent_id: str, result: str):
        with self.lock, self.db:
            self.db.execute("UPDATE agents SET last_wake_result=? WHERE agent_id=?",
                            (result[:256], agent_id))
