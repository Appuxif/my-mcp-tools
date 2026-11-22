"""Durable agent registry and inbox. The server never interprets or executes messages."""
from __future__ import annotations

import hashlib
import json
import secrets
import sqlite3
import threading
import time
import uuid
from pathlib import Path

from .mcp_debug import is_secret_field, redact



MESSAGE_TTL_SECONDS = 24 * 60 * 60
NOTE_TTL_SECONDS = 48 * 60 * 60
CHAT_TOKEN_IDLE_SECONDS = 30 * 24 * 60 * 60
MAX_NOTE_BYTES = 128 * 1024
MAX_SUBNOTES = 100
MAX_CONTEXT_BYTES = 128 * 1024
MAX_INSTRUCTIONS_BYTES = 128 * 1024
MAX_TOOL_ARGUMENT_BYTES = 256 * 1024


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
            # Backfill legacy agents once, recorded transactionally after DDL.
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
                CREATE INDEX IF NOT EXISTS messages_sender_time
                  ON messages(sender_id, created_at DESC);
                CREATE INDEX IF NOT EXISTS messages_recipient_time
                  ON messages(recipient_id, created_at DESC);
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
                -- Revocable per-chat credentials, separate from the agent's
                -- original primary token. Only hashes are ever persisted.
                CREATE TABLE IF NOT EXISTS agent_chat_tokens (
                    token_id TEXT PRIMARY KEY,
                    agent_id TEXT NOT NULL REFERENCES agents(agent_id) ON DELETE CASCADE,
                    token_hash TEXT NOT NULL UNIQUE,
                    chat_url TEXT NOT NULL DEFAULT '',
                    created_at REAL NOT NULL,
                    last_used_at REAL NOT NULL DEFAULT 0
                );
                CREATE INDEX IF NOT EXISTS chat_tokens_agent ON agent_chat_tokens(agent_id);
                -- Staged migration credentials are NOT accepted by verify().
                -- The source remains authorized until an acknowledged bootstrap
                -- commits the transfer. Aborts never expose a live token to B.
                CREATE TABLE IF NOT EXISTS agent_chat_transfers (
                    transfer_id TEXT PRIMARY KEY,
                    agent_id TEXT NOT NULL UNIQUE REFERENCES agents(agent_id) ON DELETE CASCADE,
                    source_token_id TEXT NOT NULL,
                    source_chat_url TEXT NOT NULL,
                    dest_chat_url TEXT NOT NULL UNIQUE,
                    token_hash TEXT NOT NULL UNIQUE,
                    created_at REAL NOT NULL
                );
                CREATE TABLE IF NOT EXISTS teams (
                    team_id TEXT PRIMARY KEY,
                    name TEXT NOT NULL UNIQUE COLLATE NOCASE
                );
                CREATE TABLE IF NOT EXISTS agent_teams (
                    agent_id TEXT NOT NULL REFERENCES agents(agent_id) ON DELETE CASCADE,
                    team_id TEXT NOT NULL REFERENCES teams(team_id),
                    PRIMARY KEY (agent_id, team_id)
                );
                CREATE INDEX IF NOT EXISTS team_members ON agent_teams(team_id, agent_id);
                CREATE TABLE IF NOT EXISTS migrations(
                    name TEXT PRIMARY KEY
                );
                CREATE TABLE IF NOT EXISTS agent_contexts(
                    agent_id TEXT PRIMARY KEY REFERENCES agents(agent_id) ON DELETE CASCADE,
                    context TEXT NOT NULL,
                    updated_at REAL NOT NULL
                );
                CREATE TABLE IF NOT EXISTS agent_instructions(
                    agent_id TEXT PRIMARY KEY REFERENCES agents(agent_id) ON DELETE CASCADE,
                    instructions TEXT NOT NULL DEFAULT '',
                    updated_at REAL,
                    revision INTEGER NOT NULL DEFAULT 0
                );
                CREATE TABLE IF NOT EXISTS notes(
                    note_id TEXT PRIMARY KEY,
                    author_id TEXT NOT NULL REFERENCES agents(agent_id) ON DELETE CASCADE,
                    title TEXT NOT NULL,
                    description TEXT NOT NULL,
                    status TEXT NOT NULL DEFAULT 'draft'
                        CHECK(status IN ('draft','finalized')),
                    created_at REAL NOT NULL,
                    finalized_at REAL
                );
                CREATE INDEX IF NOT EXISTS notes_expiration ON notes(created_at);
                CREATE INDEX IF NOT EXISTS notes_author ON notes(author_id);
                CREATE TABLE IF NOT EXISTS subnotes(
                    subnote_id TEXT PRIMARY KEY,
                    note_id TEXT NOT NULL REFERENCES notes(note_id) ON DELETE CASCADE,
                    title TEXT NOT NULL,
                    description TEXT NOT NULL,
                    created_at REAL NOT NULL,
                    updated_at REAL NOT NULL
                );
                CREATE INDEX IF NOT EXISTS subnotes_parent ON subnotes(note_id);
            """)
            chat_columns = {row["name"] for row in self.db.execute(
                "PRAGMA table_info(agent_chat_tokens)")}
            if "chat_url" not in chat_columns:
                self.db.execute("ALTER TABLE agent_chat_tokens ADD COLUMN "
                                "chat_url TEXT NOT NULL DEFAULT ''")
            if "last_used_at" not in chat_columns:
                self.db.execute("ALTER TABLE agent_chat_tokens ADD COLUMN "
                                "last_used_at REAL NOT NULL DEFAULT 0")
                self.db.execute("UPDATE agent_chat_tokens SET last_used_at=created_at")
            # Old beta credentials lacked chat ownership; force a safe rebind.
            self.db.execute("DELETE FROM agent_chat_tokens WHERE chat_url=''")
            self.db.execute("CREATE UNIQUE INDEX IF NOT EXISTS chat_tokens_agent_unique "
                            "ON agent_chat_tokens(agent_id)")
            self.db.execute("CREATE UNIQUE INDEX IF NOT EXISTS chat_tokens_chat_unique "
                            "ON agent_chat_tokens(chat_url)")
            # PRAGMA foreign_keys cannot be enabled inside an open transaction.
            self.db.commit()
            self.db.execute("PRAGMA foreign_keys=ON")
            self.db.execute(
                "INSERT OR IGNORE INTO teams(team_id, name) VALUES ('default', 'default')"
            )
            if self.db.execute(
                "SELECT 1 FROM migrations WHERE name='agent_teams_v1'"
            ).fetchone() is None:
                # Never add default to an already-assigned agent. Orphaned
                # agents can arise if an earlier schema upgrade was interrupted.
                self.db.execute(
                    "INSERT INTO agent_teams(agent_id,team_id) "
                    "SELECT a.agent_id,'default' FROM agents a "
                    "WHERE NOT EXISTS (SELECT 1 FROM agent_teams at "
                    "WHERE at.agent_id=a.agent_id)"
                )
                self.db.execute(
                    "INSERT INTO migrations(name) VALUES('agent_teams_v1')"
                )
            # Upgrade early versions of the instructions table in place.
            instruction_columns = {r["name"] for r in self.db.execute(
                "PRAGMA table_info(agent_instructions)"
            )}
            if "revision" not in instruction_columns:
                self.db.execute(
                    "ALTER TABLE agent_instructions ADD COLUMN revision INTEGER NOT NULL DEFAULT 0"
                )
            # Every pre-existing agent starts with empty administrator instructions.
            # This does not modify the separately stored compact summaries.
            self.db.execute(
                "INSERT OR IGNORE INTO agent_instructions(agent_id,instructions,updated_at) "
                "SELECT agent_id,'',NULL FROM agents"
            )
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
            # Existing tool history rows were metadata-only. Keep them and
            # migrate in place; legacy rows have NULL arguments_json.
            columns = {r["name"] for r in self.db.execute("PRAGMA table_info(tool_calls)")}
            if "arguments_json" not in columns:
                self.db.execute("ALTER TABLE tool_calls ADD COLUMN arguments_json TEXT")
            if "arguments_truncated" not in columns:
                self.db.execute(
                    "ALTER TABLE tool_calls ADD COLUMN arguments_truncated INTEGER NOT NULL DEFAULT 0"
                )
        # Enable incremental compaction on new and existing file-backed DBs.
        # Existing databases need a one-time VACUUM to change auto_vacuum mode.
        if path != ":memory:":
            with self.lock:
                if self.db.execute("PRAGMA auto_vacuum").fetchone()[0] != 2:
                    self.db.execute("PRAGMA auto_vacuum=INCREMENTAL")
                    self.db.execute("VACUUM")

    @staticmethod
    def _team_names(teams: list[str] | None) -> list[str]:
        if teams is None:
            return ["default"]
        if not isinstance(teams, list) or not 1 <= len(teams) <= 12:
            raise ValueError("Specify 1..12 team names")
        result = []
        for team in teams:
            if (not isinstance(team, str) or not 1 <= len(team.strip()) <= 64
                    or any(ord(c) < 32 or ord(c) == 127 for c in team)):
                raise ValueError("Team name must be 1..64 printable characters")
            name = team.strip()
            if name.casefold() not in [x.casefold() for x in result]:
                result.append(name)
        return result

    def _set_teams(self, agent_id: str, names: list[str]) -> None:
        """Use inside a locked transaction. Team names are case-insensitive."""
        team_ids = []
        for name in names:
            # SQLite NOCASE handles ASCII only; use Unicode casefold so
            # Russian/Serbian team names also reuse their existing team ID.
            row = next(
                (r for r in self.db.execute("SELECT team_id,name FROM teams")
                 if r["name"].casefold() == name.casefold()), None
            )
            if row is None:
                tid = opaque_id()
                self.db.execute("INSERT INTO teams(team_id,name) VALUES(?,?)", (tid,name))
            else:
                tid = row["team_id"]
            team_ids.append(tid)
        self.db.execute("DELETE FROM agent_teams WHERE agent_id=?", (agent_id,))
        self.db.executemany(
            "INSERT INTO agent_teams(agent_id,team_id) VALUES (?,?)",
            [(agent_id, tid) for tid in team_ids],
        )

    def assign_teams(self, agent_id: str, teams: list[str]) -> dict:
        """Administrator-only entry point. Never expose via agent credentials."""
        names = self._team_names(teams)
        with self.lock, self.db:
            self._agent(agent_id)
            self._set_teams(agent_id, names)
            self.db.execute(
                "UPDATE agents SET updated_at=? WHERE agent_id=?", (now(), agent_id)
            )
            return self._public(self._agent(agent_id))

    def team_list(self) -> list[dict]:
        """Team names/IDs for authenticated administrative selectors."""
        with self.lock:
            return [dict(r) for r in self.db.execute(
                "SELECT team_id,name FROM teams ORDER BY name COLLATE NOCASE"
            )]

    def _teams(self, agent_id: str) -> list[dict]:
        return [dict(r) for r in self.db.execute(
            "SELECT t.team_id,t.name FROM teams t "
            "JOIN agent_teams a ON a.team_id=t.team_id "
            "WHERE a.agent_id=? ORDER BY t.name COLLATE NOCASE", (agent_id,)
        )]

    def _public(self, row: sqlite3.Row, *, present: bool = False,
                viewer_id: str | None = None) -> dict:
        data = public_agent(row, present=present)
        teams = self._teams(row["agent_id"])
        if viewer_id is not None and viewer_id != row["agent_id"]:
            visible = {t["team_id"] for t in self._teams(viewer_id)}
            teams = [t for t in teams if t["team_id"] in visible]
        data["teams"] = teams
        return data

    def _shared(self, first: str, second: str) -> bool:
        return self.db.execute(
            "SELECT 1 FROM agent_teams a JOIN agent_teams b "
            "ON b.team_id=a.team_id WHERE a.agent_id=? AND b.agent_id=? LIMIT 1",
            (first,second)
        ).fetchone() is not None

    def _check_shared(self, sender: str, recipient: str,
                      *, source: str = "mcp") -> None:
        if self._shared(sender, recipient):
            return
        if source == "dashboard":
            # The Basic-authenticated administrator can already see all agents
            # and their teams. Explain the mismatch; never mutate memberships.
            recipient_agent = self._agent(recipient)
            team_names = [team["name"] for team in self._teams(recipient)]
            if team_names:
                detail = "Команды получателя: " + ", ".join(team_names) + ". "
            else:
                detail = "Получателю ещё не назначена команда. "
            raise ValueError(
                f"Получатель «{recipient_agent['name']}» не найден в командах "
                f"Dashboard-агента. {detail}"
                "Добавьте Dashboard-агента в одну из команд получателя через "
                "инспектор, затем повторите отправку."
            )
        # Ordinary MCP clients must not learn whether an invisible peer exists.
        raise ValueError("Recipient agent not found")

    def maintain_storage(self) -> dict:
        """Return unused SQLite pages to the OS without compacting every sweep."""
        with self.lock:
            free = self.db.execute("PRAGMA freelist_count").fetchone()[0]
            if free:
                self.db.execute(f"PRAGMA incremental_vacuum({min(free, 2048)})")
            # Keep WAL files from retaining a peak-size journal indefinitely.
            self.db.execute("PRAGMA wal_checkpoint(TRUNCATE)")
            return {"free_pages_before": free}

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

    def prune_notes(self, *, at: float | None = None) -> dict:
        """Remove notes 48 hours after creation, regardless of draft/finalized."""
        cutoff = (now() if at is None else at) - NOTE_TTL_SECONDS
        with self.lock, self.db:
            removed = self.db.execute(
                "DELETE FROM notes WHERE created_at <= ?", (cutoff,)
            ).rowcount
            return {"expired_notes": removed}

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
            contexts = self.db.execute(
                "DELETE FROM agent_contexts WHERE agent_id=?", (agent_id,)
            ).rowcount
            instructions = self.db.execute(
                "DELETE FROM agent_instructions WHERE agent_id=?", (agent_id,)
            ).rowcount
            # Foreign-key cascade removes this author's notes and subnotes.
            # Count explicitly so the deletion report is useful to the admin.
            notes = self.db.execute(
                "SELECT count(*) FROM notes WHERE author_id=?", (agent_id,)
            ).fetchone()[0]
            self.db.execute("DELETE FROM notes WHERE author_id=?", (agent_id,))
            self.db.execute("DELETE FROM agent_teams WHERE agent_id=?", (agent_id,))
            # Keep aggregate tool telemetry but unlink it from deleted identities.
            self.db.execute("UPDATE tool_calls SET agent_id=NULL WHERE agent_id=?",
                            (agent_id,))
            self.db.execute("DELETE FROM agents WHERE agent_id=?", (agent_id,))
            return {"agent_id": agent_id, "name": agent["name"],
                    "deleted_messages": messages, "deleted_channels": channels,
                    "deleted_context": bool(contexts),
                    "deleted_instructions": bool(instructions),
                    "deleted_notes": notes}

    def prune_chat_tokens(self, *, at: float | None = None) -> int:
        """Expire orphaned leases and abandoned provisional transfers."""
        with self.lock, self.db:
            self._prune_chat_transfers()
            return self.db.execute(
                "DELETE FROM agent_chat_tokens WHERE last_used_at<=?",
                ((at or now()) - CHAT_TOKEN_IDLE_SECONDS,),
            ).rowcount

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
            agents = [self._public(r, present=r["agent_id"] in (present_ids or set()))
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
                "agents": agents, "teams": self.team_list(),
                "channels": channels,
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

    def agent_hud_snapshot(self, agent_id: str, token: str,
                           *, present_ids: set[str] | None = None) -> dict:
        """A token-scoped view for one agent's extension HUD.

        Never return bodies, other agents' tasks/statuses, global audit,
        or credentials. Does not poll the inbox or acknowledge messages.
        """
        cutoff = now() - MESSAGE_TTL_SECONDS
        with self.lock:
            own = self.verify(agent_id, token)
            result = self._public(own, present=agent_id in (present_ids or set()))
            result["pending_messages"] = self.db.execute(
                "SELECT count(*) FROM messages WHERE recipient_id=? "
                "AND status='pending' AND created_at>? "
                "AND EXISTS (SELECT 1 FROM agent_teams src "
                "JOIN agent_teams dst ON src.team_id=dst.team_id "
                "WHERE src.agent_id=messages.sender_id AND dst.agent_id=messages.recipient_id)",
                (agent_id, cutoff),
            ).fetchone()[0]
            edge_rows = self.db.execute(
                "SELECT m.sender_id AS source,m.recipient_id AS target,"
                "count(*) AS recent_count,"
                "sum(CASE WHEN m.status='pending' THEN 1 ELSE 0 END) AS pending_count,"
                "max(m.created_at) AS last_message_at "
                "FROM messages m WHERE m.created_at>? AND "
                "(m.sender_id=? OR m.recipient_id=?) "
                "AND EXISTS (SELECT 1 FROM agent_teams src "
                "JOIN agent_teams dst ON src.team_id=dst.team_id "
                "WHERE src.agent_id=m.sender_id AND dst.agent_id=m.recipient_id) "
                "GROUP BY m.sender_id,m.recipient_id "
                "ORDER BY last_message_at DESC LIMIT 101",
                (cutoff, agent_id, agent_id),
            ).fetchall()
            truncated = len(edge_rows) > 100
            edges = [dict(r) for r in edge_rows[:100]]
            peers = {agent_id}
            for edge in edges:
                peers.add(edge["source"])
                peers.add(edge["target"])
            names = [
                {"agent_id":r["agent_id"], "name":r["name"]}
                for r in self.db.execute(
                    "SELECT agent_id,name FROM agents WHERE agent_id IN ("
                    + ",".join("?" for _ in peers) + ")",
                    tuple(peers),
                ) if r["agent_id"] != agent_id and self._shared(agent_id, r["agent_id"])
            ]
            recent = [
                dict(r) for r in self.db.execute(
                    "SELECT m.message_id,m.sender_id,s.name AS sender_name,"
                    "m.recipient_id,r.name AS recipient_name,m.created_at,"
                    "m.acknowledged_at,m.status "
                    "FROM messages m JOIN agents s ON s.agent_id=m.sender_id "
                    "JOIN agents r ON r.agent_id=m.recipient_id "
                    "WHERE m.created_at>? AND "
                    "(m.sender_id=? OR m.recipient_id=?) "
                    "AND EXISTS (SELECT 1 FROM agent_teams src "
                    "JOIN agent_teams dst ON src.team_id=dst.team_id "
                    "WHERE src.agent_id=m.sender_id AND dst.agent_id=m.recipient_id) "
                    "ORDER BY m.created_at DESC,m.rowid DESC LIMIT 10",
                    (cutoff, agent_id, agent_id),
                )
            ]
            channels = [
                dict(r) for r in self.db.execute(
                    "SELECT channel_id,agent_id,kind,connected,state,"
                    "connected_at,last_seen,last_wake_result "
                    "FROM channels WHERE agent_id=? AND connected=1 "
                    "ORDER BY last_seen DESC",
                    (agent_id,),
                )
            ]
            return {
                "agents": [result, *names],
                "channels": channels, "edges": edges, "edgesTruncated": truncated,
                "recent": recent, "server": {"now": now()},
            }

    @staticmethod
    def _safe_tool_arguments(arguments: dict | None) -> tuple[str | None, int]:
        """Serialize input arguments after masking secret fields, never raw tokens.

        Text values can contain arbitrary private information: access is
        administrator-only and intentionally supports debugging message bodies.
        """
        if arguments is None:
            return None, 0
        scrubbed = redact(arguments)
        # Avoid echoing the same raw credential copied into an ordinary
        # text argument in this call (e.g. send_message(text=agent_token)).
        secrets: set[str] = set()

        def extract_secret_strings(value):
            if isinstance(value, str):
                if len(value) >= 8:
                    secrets.add(value)
            elif isinstance(value, dict):
                for nested in value.values():
                    extract_secret_strings(nested)
            elif isinstance(value, (list, tuple)):
                for nested in value:
                    extract_secret_strings(nested)

        def find_secret_fields(value):
            if isinstance(value, dict):
                for key, nested in value.items():
                    if is_secret_field(key):
                        extract_secret_strings(nested)
                    else:
                        find_secret_fields(nested)
            elif isinstance(value, (list, tuple)):
                for nested in value:
                    find_secret_fields(nested)

        find_secret_fields(arguments)

        def mask_known(value):
            if isinstance(value, str):
                for secret in secrets:
                    value = value.replace(secret, "[REDACTED]")
            elif isinstance(value, dict):
                return {k: mask_known(v) for k, v in value.items()}
            elif isinstance(value, list):
                return [mask_known(v) for v in value]
            return value

        body = json.dumps(mask_known(scrubbed), ensure_ascii=False, default=str)
        if len(body.encode("utf-8")) <= MAX_TOOL_ARGUMENT_BYTES:
            return body, 0
        # Keep valid JSON for the detail endpoint and mark incompleteness.
        # Slice UTF-8 safely without losing the redaction already performed.
        original_bytes = len(body.encode("utf-8"))
        # The preview is itself JSON-encoded; escape-heavy input can expand
        # again. Binary-search a character prefix against the FINAL size.
        lower, upper = 0, len(body)
        while lower < upper:
            length = (lower + upper + 1) // 2
            candidate = json.dumps({
                "_truncated": True,
                "_original_bytes": original_bytes,
                "_preview": body[:length],
            }, ensure_ascii=False)
            if len(candidate.encode("utf-8")) <= MAX_TOOL_ARGUMENT_BYTES:
                lower = length
            else:
                upper = length - 1
        limited = json.dumps({
            "_truncated": True,
            "_original_bytes": original_bytes,
            "_preview": body[:lower],
        }, ensure_ascii=False)
        return limited, 1

    def record_tool_call(self, tool_name: str, status: str,
                         duration_ms: float, agent_id: str = "",
                         arguments: dict | None = None) -> None:
        """Keep 100 bounded MCP call records; input arguments are redacted."""
        safe_args, truncated = self._safe_tool_arguments(arguments)
        with self.lock, self.db:
            self.db.execute(
                "INSERT INTO tool_calls(tool_name, agent_id, status, duration_ms, "
                "created_at, arguments_json, arguments_truncated) "
                "VALUES(?,?,?,?,?,?,?)",
                (tool_name[:100], agent_id[:128] or None, status[:30],
                 round(max(0.0, duration_ms), 2), now(), safe_args, truncated)
            )
            self.db.execute(
                "DELETE FROM tool_calls WHERE id NOT IN "
                "(SELECT id FROM tool_calls ORDER BY id DESC LIMIT 100)"
            )

    def tool_call_detail(self, call_id: int) -> dict:
        """Admin-only call details; list endpoints remain metadata-only."""
        with self.lock:
            row = self.db.execute(
                "SELECT t.id,t.tool_name,t.agent_id,a.name AS agent_name,"
                "t.status,t.duration_ms,t.created_at,"
                "t.arguments_json,t.arguments_truncated "
                "FROM tool_calls t LEFT JOIN agents a ON a.agent_id=t.agent_id "
                "WHERE t.id=?", (call_id,)
            ).fetchone()
            if row is None:
                raise ValueError("Tool call not found")
            data = dict(row)
            raw = data.pop("arguments_json")
            data["arguments"] = json.loads(raw) if raw is not None else None
            data["arguments_truncated"] = bool(data["arguments_truncated"])
            return data

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

    def conversations(self, agent_id: str) -> dict:
        """Admin-only list of peers with whom this agent exchanged messages.

        Read-only, restricted to unexpired messages. Does not update presence,
        consume queues or change ACK status. The caller must authorize access.
        """
        cutoff = now() - MESSAGE_TTL_SECONDS
        with self.lock:
            owner = self._agent(agent_id)
            peers = self.db.execute(
                """
                WITH exchanges AS (
                    SELECT CASE WHEN sender_id = ? THEN recipient_id
                                ELSE sender_id END AS peer_id,
                           created_at, status, recipient_id
                    FROM messages
                    WHERE (sender_id = ? OR recipient_id = ?)
                      AND created_at > ?
                )
                SELECT a.agent_id AS peer_id, a.name AS peer_name,
                       a.kind AS peer_kind,
                       COUNT(*) AS message_count,
                       SUM(CASE WHEN e.status = 'pending'
                                 AND e.recipient_id = ? THEN 1 ELSE 0 END)
                           AS pending_for_agent,
                       MAX(e.created_at) AS last_message_at
                FROM exchanges e
                JOIN agents a ON a.agent_id = e.peer_id
                GROUP BY a.agent_id
                ORDER BY last_message_at DESC, a.name ASC
                """,
                (agent_id, agent_id, agent_id, cutoff, agent_id),
            ).fetchall()
            return {"agent_id": agent_id, "agent_name": owner["name"],
                    "items": [dict(row) for row in peers]}

    def conversation_messages(
        self, agent_id: str, peer_id: str, *,
        before: str = "", limit: int = 30,
    ) -> dict:
        """Cursor-based history for one pair, newest window in ascending order.

        The cursor is the oldest message ID from the previous page. By reading
        the cursor row's (created_at, rowid), pagination remains deterministic
        even when multiple messages share the same timestamp.
        """
        if not 1 <= limit <= 50:
            raise ValueError("Conversation page size must be 1..50")
        cutoff = now() - MESSAGE_TTL_SECONDS
        with self.lock:
            owner = self._agent(agent_id)
            peer = self._agent(peer_id)
            pair_args = (agent_id, peer_id, peer_id, agent_id)
            pair_filter = ("((m.sender_id=? AND m.recipient_id=?) OR "
                           "(m.sender_id=? AND m.recipient_id=?))")
            cursor_clause = ""
            args: list = [*pair_args, cutoff]
            if before:
                cursor_row = self.db.execute(
                    "SELECT m.rowid, m.created_at FROM messages m "
                    f"WHERE m.message_id=? AND {pair_filter} AND m.created_at>?",
                    (before, *pair_args, cutoff),
                ).fetchone()
                if cursor_row is None:
                    raise ValueError("Conversation cursor is invalid or expired")
                cursor_clause = (
                    " AND (m.created_at < ? OR "
                    "(m.created_at = ? AND m.rowid < ?))"
                )
                args.extend((cursor_row["created_at"], cursor_row["created_at"],
                             cursor_row["rowid"]))
            args.append(limit + 1)
            rows = self.db.execute(
                """
                SELECT m.message_id, m.sender_id, m.recipient_id,
                       m.body, m.task_id, m.status,
                       m.created_at, m.acknowledged_at,
                       s.name AS sender_name, r.name AS recipient_name
                FROM messages m
                JOIN agents s ON s.agent_id=m.sender_id
                JOIN agents r ON r.agent_id=m.recipient_id
                WHERE """ + pair_filter + " AND m.created_at>?"
                + cursor_clause +
                " ORDER BY m.created_at DESC, m.rowid DESC LIMIT ?",
                args,
            ).fetchall()
            has_more = len(rows) > limit
            page = rows[:limit]
            return {
                "agent_id": agent_id, "agent_name": owner["name"],
                "peer_id": peer_id, "peer_name": peer["name"],
                "items": [dict(row) for row in reversed(page)],
                "has_more": has_more,
                "next_cursor": page[-1]["message_id"] if has_more else None,
            }

    def agent_conversations(self, agent_id: str, token: str) -> dict:
        """Peer list limited to the caller's own conversations, authenticated."""
        with self.lock:
            self.verify(agent_id, token)
            data = self.conversations(agent_id)
            data["items"] = [p for p in data["items"]
                             if self._shared(agent_id, p["peer_id"])]
            return data

    def agent_conversation_messages(
        self, agent_id: str, token: str, peer_id: str,
        *, before: str = "", limit: int = 30,
    ) -> dict:
        """Read ONLY messages exchanged by this authenticated agent and peer.

        An unrelated peer is not enumerable; a cursor cannot escape its pair.
        Reading does not touch presence, consume messages or acknowledge them.
        """
        with self.lock:
            self.verify(agent_id, token)
            if not self._shared(agent_id,peer_id):
                raise ValueError("Conversation not found")
            if not self.db.execute(
                "SELECT 1 FROM messages WHERE created_at > ? AND "
                "((sender_id=? AND recipient_id=?) OR "
                " (sender_id=? AND recipient_id=?)) LIMIT 1",
                (now() - MESSAGE_TTL_SECONDS,
                 agent_id, peer_id, peer_id, agent_id),
            ).fetchone():
                raise ValueError("Conversation not found")
            return self.conversation_messages(
                agent_id, peer_id, before=before, limit=limit
            )

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
            result["agent"] = self._public(self._agent(aid))
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
            return self._public(self._agent(agent_id))

    def disable_dashboard(self, agent_id: str, token: str) -> dict:
        self.dashboard_auth(agent_id, token, touch=False)
        with self.lock, self.db:
            self.db.execute(
                "UPDATE agents SET dashboard_enabled=0,task_status='idle',"
                " updated_at=? WHERE agent_id=?",
                (now(), agent_id)
            )
            return self._public(self._agent(agent_id))

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
            if not token:
                raise PermissionError("Invalid agent token")
            hashed = digest(token)
            if not secrets.compare_digest(row["token_hash"], hashed):
                scoped = self.db.execute(
                    "SELECT token_id FROM agent_chat_tokens WHERE "
                    "agent_id=? AND token_hash=? AND last_used_at>?",
                    (agent_id, hashed, now() - CHAT_TOKEN_IDLE_SECONDS),
                ).fetchone()
                if scoped is None:
                    raise PermissionError("Invalid agent token")
                with self.db:
                    self.db.execute(
                        "UPDATE agent_chat_tokens SET last_used_at=? WHERE token_id=?",
                        (now(), scoped["token_id"]),
                    )
            return row

    def issue_chat_token(self, agent_id: str, chat_url: str,
                         *, replace_existing: bool = False) -> dict:
        """Issue one revocable credential; explicit reclaim rotates the old."""
        with self.lock, self.db:
            agent = self._agent(agent_id)
            if agent["kind"] != "chatgpt":
                raise ValueError("Only ChatGPT agents can be bound to ChatGPT")
            self.db.execute(
                "DELETE FROM agent_chat_tokens WHERE last_used_at<=?",
                (now() - CHAT_TOKEN_IDLE_SECONDS,),
            )
            self._prune_chat_transfers()
            if self.db.execute(
                "SELECT 1 FROM agent_chat_transfers "
                "WHERE agent_id=? OR dest_chat_url=?",
                (agent_id, chat_url),
            ).fetchone():
                raise ValueError("Agent or chat has an in-progress transfer")
            foreign = self.db.execute(
                "SELECT agent_id FROM agent_chat_tokens WHERE chat_url=?",
                (chat_url,),
            ).fetchone()
            if foreign and foreign["agent_id"] != agent_id:
                raise ValueError("Chat is bound to another agent")
            current = self.db.execute(
                "SELECT token_id FROM agent_chat_tokens WHERE agent_id=?",
                (agent_id,),
            ).fetchone()
            if current and not replace_existing:
                raise ValueError("Agent or chat already has an active binding")
            if current:
                self.db.execute(
                    "DELETE FROM agent_chat_tokens WHERE token_id=?",
                    (current["token_id"],),
                )
            secret = secrets.token_urlsafe(32)
            token_id = opaque_id()
            stamp = now()
            self.db.execute(
                "INSERT INTO agent_chat_tokens"
                "(token_id,agent_id,token_hash,chat_url,created_at,last_used_at) "
                "VALUES(?,?,?,?,?,?)",
                (token_id, agent_id, digest(secret), chat_url, stamp, stamp),
            )
            agent_public = self._public(agent)
            return {"agent_id":agent_id, "token_id":token_id,
                    "token":secret, "agent":{key: agent_public[key] for key in (
                        "agent_id", "name", "kind", "role",
                        "purpose", "description", "teams")}}

    def _prune_chat_transfers(self) -> None:
        self.db.execute(
            "DELETE FROM agent_chat_transfers WHERE created_at<=?",
            (now() - 10 * 60,),
        )

    def prepare_chat_transfer(self, agent_id: str, source_token_id: str,
                              old_chat_url: str, new_chat_url: str,
                              *, legacy_primary_token: str = "",
                              admin_recovery: bool = False,
                              expected_source_token_id: str | None = None,
                              expected_source_chat_url: str | None = None) -> dict:
        """Reserve the destination and return an INACTIVE bearer for bootstrap."""
        if old_chat_url == new_chat_url:
            raise ValueError("Source and destination must be different")
        with self.lock, self.db:
            self._prune_chat_transfers()
            if admin_recovery:
                # A stale browser credential is not an authorization failure
                # for an authenticated admin. The CURRENT server lease is
                # authoritative; preserve it until commit, then rotate it.
                if legacy_primary_token or source_token_id:
                    raise ValueError("Invalid administrator recovery source")
                agent = self._agent(agent_id)
                if agent["kind"] != "chatgpt":
                    raise ValueError("Only ChatGPT agents can be transferred")
                current = self.db.execute(
                    "SELECT token_id,chat_url FROM agent_chat_tokens WHERE agent_id=?",
                    (agent_id,),
                ).fetchone()
                # Only migrate the EXACT lease shown in the popup preview.
                # Never silently take over chat C after confirming chat A.
                current_id = current["token_id"] if current else None
                current_url = current["chat_url"] if current else None
                if (expected_source_token_id != current_id or
                        expected_source_chat_url != current_url):
                    raise ValueError("Server chat binding changed; repeat migration preview")
                if current is not None:
                    source_token_id = current_id
                    old_chat_url = current_url
                else:
                    # A stale scoped ChatGPT credential must never rotate the
                    # agent's unrelated PRIMARY token. Bind B while preserving
                    # the PRIMARY hash, and CAS that hash on commit.
                    source_token_id = "recovery-empty:" + agent["token_hash"]
            elif legacy_primary_token:
                # v0.7 and earlier injected the identity's permanent primary
                # bearer into ChatGPT. Never copy it to another chat. Reserve
                # a fresh INACTIVE scoped destination bearer, then atomically
                # rotate that old primary only when the bootstrap succeeds.
                agent = self._agent(agent_id)
                if agent["kind"] != "chatgpt" or source_token_id:
                    raise ValueError("Invalid legacy transfer source")
                hashed = digest(legacy_primary_token)
                if not secrets.compare_digest(agent["token_hash"], hashed):
                    raise ValueError("Legacy primary credential changed")
                if self.db.execute(
                    "SELECT 1 FROM agent_chat_tokens WHERE agent_id=?",
                    (agent_id,),
                ).fetchone():
                    raise ValueError("Agent already has a scoped chat binding")
                source_token_id = "primary:" + hashed
            else:
                source = self.db.execute(
                    "SELECT token_id FROM agent_chat_tokens "
                    "WHERE agent_id=? AND token_id=? AND chat_url=?",
                    (agent_id, source_token_id, old_chat_url),
                ).fetchone()
                if source is None:
                    raise ValueError("Source binding not found or token changed")
            if self.db.execute(
                "SELECT 1 FROM agent_chat_transfers "
                "WHERE source_chat_url=? AND agent_id<>?",
                (old_chat_url, agent_id),
            ).fetchone():
                raise ValueError("Source chat already has an in-progress transfer")
            if self.db.execute(
                "SELECT 1 FROM agent_chat_tokens WHERE chat_url=?",
                (new_chat_url,),
            ).fetchone():
                raise ValueError("Destination chat already bound")
            if self.db.execute(
                "SELECT 1 FROM agent_chat_transfers "
                "WHERE agent_id=? OR dest_chat_url=?",
                (agent_id, new_chat_url),
            ).fetchone():
                raise ValueError("Agent or destination has an in-progress transfer")
            transfer_id = opaque_id()
            pending_token = secrets.token_urlsafe(32)
            self.db.execute(
                "INSERT INTO agent_chat_transfers "
                "(transfer_id,agent_id,source_token_id,source_chat_url,"
                "dest_chat_url,token_hash,created_at) VALUES(?,?,?,?,?,?,?)",
                (transfer_id, agent_id, source_token_id, old_chat_url,
                 new_chat_url, digest(pending_token), now()),
            )
            return {"agent_id":agent_id, "transfer_id":transfer_id,
                    "token_id":transfer_id, "token":pending_token,
                    "chat_url":new_chat_url, "status":"prepared",
                    "admin_recovery":admin_recovery}

    def commit_chat_transfer(self, agent_id: str, transfer_id: str) -> dict:
        """Atomically activate B's bearer and invalidate A's bearer."""
        with self.lock, self.db:
            self._prune_chat_transfers()
            pending = self.db.execute(
                "SELECT * FROM agent_chat_transfers "
                "WHERE agent_id=? AND transfer_id=?",
                (agent_id, transfer_id),
            ).fetchone()
            if pending is None:
                raise ValueError("Chat transfer missing or expired")
            legacy = pending["source_token_id"].startswith("primary:")
            empty_recovery = pending["source_token_id"].startswith("recovery-empty:")
            if legacy or empty_recovery:
                agent = self._agent(agent_id)
                # Check the *exact* primary used when the transfer was
                # prepared: an admin rotation invalidates the staged token.
                if not secrets.compare_digest(
                    agent["token_hash"],
                    pending["source_token_id"][8:] if legacy
                    else pending["source_token_id"][15:]
                ):
                    raise ValueError("Primary credential changed during transfer")
                if self.db.execute(
                    "SELECT 1 FROM agent_chat_tokens WHERE agent_id=?",
                    (agent_id,),
                ).fetchone():
                    raise ValueError("Agent acquired a new scoped binding")
            else:
                current = self.db.execute(
                    "SELECT 1 FROM agent_chat_tokens "
                    "WHERE agent_id=? AND token_id=? AND chat_url=?",
                    (agent_id, pending["source_token_id"], pending["source_chat_url"]),
                ).fetchone()
                if current is None:
                    raise ValueError("Source binding changed during transfer")
            if self.db.execute(
                "SELECT 1 FROM agent_chat_tokens WHERE chat_url=?",
                (pending["dest_chat_url"],),
            ).fetchone():
                raise ValueError("Destination chat already bound")
            if legacy or empty_recovery:
                # Rotate permanent primary only if this transfer originated
                # from an authenticated legacy PRIMARY bearer in chat A.
                # Expired SCOPED recovery must leave the global primary valid.
                if legacy:
                    self.db.execute(
                        "UPDATE agents SET token_hash=?,updated_at=? WHERE agent_id=?",
                        (digest(secrets.token_urlsafe(32)), now(), agent_id),
                    )
                stamp = now()
                self.db.execute(
                    "INSERT INTO agent_chat_tokens "
                    "(token_id,agent_id,token_hash,chat_url,created_at,last_used_at) "
                    "VALUES(?,?,?,?,?,?)",
                    (transfer_id, agent_id, pending["token_hash"],
                     pending["dest_chat_url"], stamp, stamp),
                )
            else:
                self.db.execute(
                    "UPDATE agent_chat_tokens "
                    "SET token_id=?,token_hash=?,chat_url=?,created_at=?,last_used_at=? "
                    "WHERE agent_id=? AND token_id=?",
                    (transfer_id, pending["token_hash"], pending["dest_chat_url"],
                     now(), now(), agent_id, pending["source_token_id"]),
                )
            self.db.execute(
                "DELETE FROM agent_chat_transfers WHERE transfer_id=?",
                (transfer_id,),
            )
            return {"agent_id":agent_id, "token_id":transfer_id,
                    "chat_url":pending["dest_chat_url"], "status":"committed"}

    def chat_binding(self, agent_id: str) -> dict:
        """Read authoritative lease metadata without disclosing credentials."""
        with self.lock:
            self._agent(agent_id)
            row = self.db.execute(
                "SELECT token_id,chat_url FROM agent_chat_tokens WHERE agent_id=?",
                (agent_id,),
            ).fetchone()
            return {"agent_id":agent_id, "token_id":row["token_id"] if row else None,
                    "chat_url":row["chat_url"] if row else None}

    def abort_chat_transfer(self, agent_id: str, transfer_id: str) -> bool:
        """Discard an inactive transfer credential, preserving A's bearer."""
        with self.lock, self.db:
            return bool(self.db.execute(
                "DELETE FROM agent_chat_transfers "
                "WHERE agent_id=? AND transfer_id=?",
                (agent_id, transfer_id),
            ).rowcount)

    def revoke_chat_token(self, agent_id: str, token_id: str) -> bool:
        """Revoke this chat credential and any transfer staged from it."""
        with self.lock, self.db:
            revoked = bool(self.db.execute(
                "DELETE FROM agent_chat_tokens WHERE agent_id=? AND token_id=?",
                (agent_id, token_id),
            ).rowcount)
            if revoked:
                self.db.execute(
                    "DELETE FROM agent_chat_transfers "
                    "WHERE agent_id=? AND source_token_id=?",
                    (agent_id, token_id),
                )
            return revoked

    def rotate_agent_token(self, agent_id: str) -> dict:
        """Explicit admin action; old credentials immediately stop working.

        Plaintext token is returned exactly once, never persisted or exposed
        through normal dashboard snapshots.
        """
        with self.lock, self.db:
            row = self._agent(agent_id)
            secret = secrets.token_urlsafe(32)
            self.db.execute(
                "UPDATE agents SET token_hash=?, updated_at=? WHERE agent_id=?",
                (digest(secret), now(), agent_id),
            )
            # Security rotation also invalidates all pending destination
            # credentials; neither a delayed commit nor a stale bootstrap
            # may regain agent access using a pre-rotation token.
            self.db.execute("DELETE FROM agent_chat_transfers WHERE agent_id=?", (agent_id,))
            self.db.execute("DELETE FROM agent_chat_tokens WHERE agent_id=?", (agent_id,))
            return {"agent_id": agent_id, "name": row["name"],
                    "kind": row["kind"], "token": secret}

    def register(self, name: str, role: str, kind: str, purpose: str = "",
                 description: str = "", agent_id: str = "", token: str = "",
                 *, teams: list[str] | None = None, instructions: str = "") -> dict:
        """Trusted internal registration. HTTP/MCP callers must authenticate first.

        Team assignment on creation is atomic; reconnect never changes teams.
        """
        names = self._team_names(teams)
        name = name.strip()
        if not (1 <= len(name) <= 64) or not all(c.isalnum() or c in "-_." for c in name):
            raise ValueError("Agent name must be 1..64 letters, digits, '.', '-' or '_'")
        role = role.strip()
        kind = kind.strip().lower()
        if not role or len(role) > 120 or kind not in ("chatgpt", "codex", "claude", "dashboard", "other"):
            raise ValueError("Invalid role or kind")
        if len(purpose) > 1000 or len(description) > 2000:
            raise ValueError("Profile field too long")
        self._validate_instructions(instructions)
        with self.lock, self.db:
            existing = self.db.execute("SELECT * FROM agents WHERE name=?", (name,)).fetchone()
            if existing:
                if teams is not None:
                    raise ValueError("Team assignment is not allowed on reconnect")
                if instructions:
                    raise ValueError("Instructions cannot be changed on reconnect")
                if not agent_id or existing["agent_id"] != agent_id:
                    raise ValueError("Agent name already registered; use its id and token to reconnect")
                self.verify(agent_id, token)
                self.db.execute(
                    "UPDATE agents SET last_mcp_activity=? WHERE agent_id=?",
                    (now(), agent_id),
                )
                return {"agent": self._public(self._agent(agent_id)), "token": token, "created": False}
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
            self._set_teams(agent_id, names)
            self.db.execute(
                "INSERT INTO agent_instructions(agent_id,instructions,updated_at) "
                "VALUES(?,?,?)",
                (agent_id, instructions, stamp if instructions else None),
            )
            return {"agent": self._public(self._agent(agent_id)), "token": secret, "created": True}

    def update_profile(self, agent_id: str, token: str, *, role: str = "",
                       purpose: str = "", description: str = "") -> dict:
        self.verify(agent_id, token)
        if not role.strip() or len(role) > 120 or len(purpose) > 1000 or len(description) > 2000:
            raise ValueError("Invalid profile")
        with self.lock, self.db:
            self.db.execute(
                "UPDATE agents SET role=?, purpose=?, description=?, updated_at=? WHERE agent_id=?",
                (role.strip(), purpose, description, now(), agent_id))
            return self._public(self._agent(agent_id))

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

    def agents(self, *, present_ids: set[str] | None = None,
               requester_id: str | None = None) -> list[dict]:
        with self.lock:
            if requester_id is not None:
                rows = self.db.execute(
                    "SELECT DISTINCT a.* FROM agents a "
                    "JOIN agent_teams member ON member.agent_id=a.agent_id "
                    "JOIN agent_teams mine ON mine.team_id=member.team_id "
                    "WHERE mine.agent_id=? ORDER BY a.name", (requester_id,)
                ).fetchall()
            else:
                rows = self.db.execute("SELECT * FROM agents ORDER BY name").fetchall()
            return [self._public(r, present=r["agent_id"] in (present_ids or set()),
                                 viewer_id=requester_id)
                    for r in rows]

    def resolve(self, name_or_id: str) -> sqlite3.Row:
        with self.lock:
            # UUID addressing takes precedence over agent names. A malicious
            # or accidental name equal to another agent's ID cannot redirect
            # messages intended for that identity.
            row = self.db.execute(
                "SELECT * FROM agents WHERE agent_id=?", (name_or_id,)
            ).fetchone()
            if row is None:
                row = self.db.execute(
                    "SELECT * FROM agents WHERE name=?", (name_or_id,)
                ).fetchone()
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
                    self._check_shared(sender_id, recipient["agent_id"], source=source)
                    return {"message_id": existing["message_id"], "duplicate": True}
            recipient = self.resolve(to)
            self._check_shared(sender_id, recipient["agent_id"], source=source)
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
                "AND EXISTS (SELECT 1 FROM agent_teams src "
                "JOIN agent_teams dst ON src.team_id=dst.team_id "
                "WHERE src.agent_id=m.sender_id AND dst.agent_id=m.recipient_id) "
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
            if msg is None or msg["recipient_id"] != agent_id or not self._shared(
                    msg["sender_id"], msg["recipient_id"]):
                raise ValueError("Message not found in your inbox")
            if msg["status"] == "pending":
                self.db.execute(
                    "UPDATE messages SET status='acknowledged', acknowledged_at=? WHERE message_id=?",
                    (now(), message_id))
            return {"message_id": message_id, "status": "acknowledged"}

    # Notes are short-lived handoff resources, not messages. Neither creation
    # nor finalization writes an inbox row or wakes an agent.
    @staticmethod
    def _note_fields(title: str, description: str) -> int:
        if not isinstance(title, str) or not title.strip() or len(title) > 200:
            raise ValueError("Note title must be 1..200 characters")
        if not isinstance(description, str) or len(description) > 12000:
            raise ValueError("Note description must be at most 12000 characters")
        return len(title.encode("utf-8")) + len(description.encode("utf-8"))

    def _note(self, note_id: str) -> sqlite3.Row:
        row = self.db.execute(
            "SELECT * FROM notes WHERE note_id=? AND created_at > ?",
            (note_id, now() - NOTE_TTL_SECONDS),
        ).fetchone()
        if row is None:
            raise ValueError("Note not found")
        return row

    def _editable_note(self, agent_id: str, note_id: str) -> sqlite3.Row:
        row = self._note(note_id)
        if row["author_id"] != agent_id:
            raise ValueError("Note not found")
        if row["status"] != "draft":
            raise ValueError("Note is finalized")
        return row

    def _note_usage(self, note: sqlite3.Row) -> tuple[int, int]:
        parts = self.db.execute(
            "SELECT count(*) AS total, "
            "coalesce(sum(length(cast(title as blob)) + "
            "length(cast(description as blob))), 0) AS used "
            "FROM subnotes WHERE note_id=?", (note["note_id"],)
        ).fetchone()
        used = (len(note["title"].encode("utf-8")) +
                len(note["description"].encode("utf-8")) + parts["used"])
        return parts["total"], used

    def create_note(self, agent_id: str, token: str, title: str,
                    description: str) -> dict:
        """Create a private draft; caller must separately send its ID."""
        self.touch_mcp(agent_id, token)
        size = self._note_fields(title, description)
        if size > MAX_NOTE_BYTES:
            raise ValueError("Note exceeds maximum size")
        with self.lock, self.db:
            stamp = now()
            note_id = opaque_id()
            self.db.execute(
                "INSERT INTO notes(note_id,author_id,title,description,created_at)"
                " VALUES(?,?,?,?,?)",
                (note_id, agent_id, title, description, stamp),
            )
            return {"note_id": note_id, "status": "draft",
                    "expires_at": stamp + NOTE_TTL_SECONDS}

    def add_to_note(self, agent_id: str, token: str, note_id: str,
                    title: str, description: str) -> dict:
        self.touch_mcp(agent_id, token)
        size = self._note_fields(title, description)
        with self.lock, self.db:
            note = self._editable_note(agent_id, note_id)
            count, used = self._note_usage(note)
            if count >= MAX_SUBNOTES:
                raise ValueError("Note has reached its subnote limit")
            if used + size > MAX_NOTE_BYTES:
                raise ValueError("Note exceeds maximum size")
            stamp = now()
            subnote_id = opaque_id()
            self.db.execute(
                "INSERT INTO subnotes(subnote_id,note_id,title,description,"
                "created_at,updated_at) VALUES(?,?,?,?,?,?)",
                (subnote_id, note_id, title, description, stamp, stamp),
            )
            return {"note_id": note_id, "subnote_id": subnote_id}

    def update_subnote(self, agent_id: str, token: str, note_id: str,
                       subnote_id: str, title: str, description: str) -> dict:
        self.touch_mcp(agent_id, token)
        size = self._note_fields(title, description)
        with self.lock, self.db:
            note = self._editable_note(agent_id, note_id)
            old = self.db.execute(
                "SELECT * FROM subnotes WHERE note_id=? AND subnote_id=?",
                (note_id, subnote_id),
            ).fetchone()
            if old is None:
                raise ValueError("Subnote not found")
            _, used = self._note_usage(note)
            old_size = (len(old["title"].encode("utf-8")) +
                        len(old["description"].encode("utf-8")))
            if used - old_size + size > MAX_NOTE_BYTES:
                raise ValueError("Note exceeds maximum size")
            self.db.execute(
                "UPDATE subnotes SET title=?,description=?,updated_at=? "
                "WHERE note_id=? AND subnote_id=?",
                (title, description, now(), note_id, subnote_id),
            )
            return {"note_id": note_id, "subnote_id": subnote_id,
                    "updated": True}

    def remove_from_note(self, agent_id: str, token: str, note_id: str,
                         subnote_id: str) -> dict:
        self.touch_mcp(agent_id, token)
        with self.lock, self.db:
            self._editable_note(agent_id, note_id)
            removed = self.db.execute(
                "DELETE FROM subnotes WHERE note_id=? AND subnote_id=?",
                (note_id, subnote_id),
            ).rowcount
            if not removed:
                raise ValueError("Subnote not found")
            return {"note_id": note_id, "subnote_id": subnote_id,
                    "removed": True}

    def finalize_note(self, agent_id: str, token: str, note_id: str) -> dict:
        """Lock the note permanently. Explicit send_message is still required."""
        self.touch_mcp(agent_id, token)
        with self.lock, self.db:
            note = self._note(note_id)
            if note["author_id"] != agent_id:
                raise ValueError("Note not found")
            if note["status"] == "draft":
                stamp = now()
                self.db.execute(
                    "UPDATE notes SET status='finalized',finalized_at=? "
                    "WHERE note_id=?", (stamp, note_id)
                )
            else:
                stamp = note["finalized_at"]
            count, _ = self._note_usage(note)
            return {"note_id": note_id, "status": "finalized",
                    "finalized_at": stamp,
                    "subnote_count": count,
                    "expires_at": note["created_at"] + NOTE_TTL_SECONDS}

    def read_note(self, agent_id: str, token: str, note_id: str) -> dict:
        """Read own draft or a finalized note by a currently shared-team peer."""
        self.touch_mcp(agent_id, token)
        with self.lock:
            note = self._note(note_id)
            author_id = note["author_id"]
            if author_id != agent_id:
                if note["status"] != "finalized" or not self._shared(agent_id, author_id):
                    raise ValueError("Note not found")
            author = self._agent(author_id)
            children = self.db.execute(
                "SELECT subnote_id,title,description,created_at,updated_at "
                "FROM subnotes WHERE note_id=? ORDER BY rowid",
                (note_id,),
            ).fetchall()
            return {
                "note_id": note_id,
                "author_id": author_id,
                "author_name": author["name"],
                "title": note["title"],
                "description": note["description"],
                "status": note["status"],
                "created_at": note["created_at"],
                "finalized_at": note["finalized_at"],
                "expires_at": note["created_at"] + NOTE_TTL_SECONDS,
                "subnotes": [dict(child) for child in children],
            }

    def admin_list_notes(self, *, page: int = 1, page_size: int = 20) -> dict:
        """Read-only admin listing of live drafts and finalized Notes.

        Keep description and subnotes out of this list: the administrator
        loads the selected Note separately by ID.
        """
        if not 1 <= page <= 10000 or page_size != 20:
            raise ValueError("Invalid Notes page")
        with self.lock:
            cutoff = now() - NOTE_TTL_SECONDS
            total = self.db.execute(
                "SELECT count(*) FROM notes WHERE created_at > ?", (cutoff,)
            ).fetchone()[0]
            rows = self.db.execute(
                "SELECT n.note_id,n.title,n.author_id AS agent_id,n.created_at,"
                "n.status,n.finalized_at, a.name AS agent_name,"
                "count(s.subnote_id) AS subnote_count "
                "FROM notes n JOIN agents a ON a.agent_id=n.author_id "
                "LEFT JOIN subnotes s ON s.note_id=n.note_id "
                "WHERE n.created_at > ? "
                "GROUP BY n.note_id ORDER BY n.created_at DESC,n.rowid DESC "
                "LIMIT ? OFFSET ?",
                (cutoff, page_size, (page - 1) * page_size)
            ).fetchall()
            return {"items": [dict(row) for row in rows],
                    "page": page, "page_size": page_size, "total": total}

    def admin_read_note(self, note_id: str) -> dict:
        """Read-only full Note for a Basic-authenticated administrator.

        Unlike agent-scoped read_note, administrators may inspect drafts
        and Notes from any team; this never touches agent presence.
        """
        with self.lock:
            note = self._note(note_id)
            author = self._agent(note["author_id"])
            children = self.db.execute(
                "SELECT subnote_id,title,description,created_at,updated_at "
                "FROM subnotes WHERE note_id=? ORDER BY rowid",
                (note_id,)
            ).fetchall()
            return {
                "note_id": note_id,
                "agent_id": note["author_id"],
                "agent_name": author["name"],
                "title": note["title"],
                "description": note["description"],
                "status": note["status"],
                "created_at": note["created_at"],
                "finalized_at": note["finalized_at"],
                "expires_at": note["created_at"] + NOTE_TTL_SECONDS,
                "subnotes": [dict(child) for child in children],
            }

    @staticmethod
    def _validate_instructions(instructions: str) -> int:
        if not isinstance(instructions, str):
            raise ValueError("Instructions must be text")
        try:
            size = len(instructions.encode("utf-8"))
        except UnicodeError as exc:
            raise ValueError("Instructions must be valid UTF-8 text") from exc
        if size > MAX_INSTRUCTIONS_BYTES:
            raise ValueError(f"Instructions exceed {MAX_INSTRUCTIONS_BYTES} bytes")
        return size

    def admin_read_instructions(self, agent_id: str) -> dict:
        """Dashboard-only read; never affects agent activity or public profiles."""
        with self.lock:
            agent = self._agent(agent_id)
            row = self.db.execute(
                "SELECT instructions,updated_at,revision FROM agent_instructions WHERE agent_id=?",
                (agent_id,),
            ).fetchone()
            content = row["instructions"] if row else ""
            return {"agent_id": agent_id, "agent_name": agent["name"],
                    "instructions": content,
                    "updated_at": row["updated_at"] if row else None,
                    "revision": row["revision"] if row else 0,
                    "bytes": len(content.encode("utf-8"))}

    def admin_update_instructions(self, agent_id: str, instructions: str,
                                  expected_revision: int) -> dict:
        """Compare-and-swap: reject stale Dashboard tabs without losing prompts."""
        size = self._validate_instructions(instructions)
        if type(expected_revision) is not int or expected_revision < 0:
            raise ValueError("Invalid instructions revision")
        with self.lock, self.db:
            agent = self._agent(agent_id)
            stamp = now()
            # A row is created at registration; this handles migrated or
            # previously interrupted state without abandoning optimistic locking.
            self.db.execute(
                "INSERT OR IGNORE INTO agent_instructions(agent_id,instructions,updated_at) "
                "VALUES(?, '', NULL)", (agent_id,),
            )
            updated = self.db.execute(
                "UPDATE agent_instructions SET instructions=?,updated_at=?,revision=revision+1 "
                "WHERE agent_id=? AND revision=?",
                (instructions, stamp, agent_id, expected_revision),
            ).rowcount
            if updated != 1:
                raise ValueError("Instructions revision conflict")
            return {"agent_id": agent_id, "agent_name": agent["name"],
                    "instructions": instructions, "updated_at": stamp,
                    "revision": expected_revision + 1, "bytes": size}

    def read_instructions(self, agent_id: str, token: str) -> dict:
        """An agent can read its own instructions, but never change them."""
        self.touch_mcp(agent_id, token)
        with self.lock:
            row = self.db.execute(
                "SELECT instructions,updated_at FROM agent_instructions WHERE agent_id=?",
                (agent_id,),
            ).fetchone()
            content = row["instructions"] if row else ""
            return {"instructions": content,
                    "updated_at": row["updated_at"] if row else None,
                    "bytes": len(content.encode("utf-8"))}

    def save_context(self, agent_id: str, token: str, context: str) -> dict:
        """Replace this agent's long-lived compact summary, never its credentials."""
        self.touch_mcp(agent_id, token)
        if not isinstance(context, str) or not context.strip():
            raise ValueError("Context must be nonempty text")
        size = len(context.encode("utf-8"))
        if size > MAX_CONTEXT_BYTES:
            raise ValueError(f"Context exceeds {MAX_CONTEXT_BYTES} bytes")
        with self.lock, self.db:
            stamp = now()
            self.db.execute(
                "INSERT INTO agent_contexts(agent_id,context,updated_at) VALUES(?,?,?) "
                "ON CONFLICT(agent_id) DO UPDATE SET context=excluded.context, "
                "updated_at=excluded.updated_at",
                (agent_id, context, stamp),
            )
            return {"saved": True, "updated_at": stamp, "bytes": size}

    def admin_read_context(self, agent_id: str) -> dict:
        """Read-only snapshot for the authenticated local Dashboard.

        The HTTP handler must enforce admin auth; this does not update an
        agent's activity or modify its saved context.
        """
        with self.lock:
            agent = self._agent(agent_id)
            row = self.db.execute(
                "SELECT context,updated_at FROM agent_contexts WHERE agent_id=?",
                (agent_id,),
            ).fetchone()
            if row is None:
                return {"agent_id": agent_id, "agent_name": agent["name"],
                        "exists": False, "context": "", "updated_at": None, "bytes": 0}
            return {"agent_id": agent_id, "agent_name": agent["name"],
                    "exists": True, "context": row["context"],
                    "updated_at": row["updated_at"],
                    "bytes": len(row["context"].encode("utf-8"))}

    def read_context(self, agent_id: str, token: str) -> dict:
        """Read only the caller's durable summary; no message TTL applies."""
        self.touch_mcp(agent_id, token)
        with self.lock:
            row = self.db.execute(
                "SELECT context,updated_at FROM agent_contexts WHERE agent_id=?",
                (agent_id,),
            ).fetchone()
            if row is None:
                return {"exists": False, "context": "", "updated_at": None}
            return {"exists": True, "context": row["context"],
                    "updated_at": row["updated_at"]}

    def update_task(self, agent_id: str, token: str, task: str, status: str) -> dict:
        self.touch_mcp(agent_id, token)
        if len(task) > 1000 or status not in ("idle", "working", "blocked", "done", "failed"):
            raise ValueError("Invalid task or status")
        with self.lock, self.db:
            self.db.execute(
                "UPDATE agents SET current_task=?,task_status=?,updated_at=? WHERE agent_id=?",
                (task, status, now(), agent_id))
            return self._public(self._agent(agent_id))

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
                "AND EXISTS (SELECT 1 FROM agent_teams src "
                "JOIN agent_teams dst ON src.team_id=dst.team_id "
                "WHERE src.agent_id=m.sender_id AND dst.agent_id=m.recipient_id) "
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
