"""Regression tests for code-review findings: expiry, token security, audit and SQLite."""
import json
import os
import stat
import tempfile
import time
import unittest
from pathlib import Path

from fastapi.testclient import TestClient

from agent_network.server import Config, create_app
from agent_network.store import MESSAGE_TTL_SECONDS, Store
from agent_network.codex_adapter import LocalOnlyConnect, validate_server_url
from websockets.exceptions import InvalidStatus
from websockets.http11 import Response
from websockets.datastructures import Headers
from agent_network.codex_state import detect_state, rollout_state


class StoreSafetyTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.dbfile = Path(self.tmp.name) / "test.db"
        self.store = Store(self.dbfile)
        self.a = self.store.register("sender", "tester", "other")
        self.b = self.store.register("recipient", "tester", "other")

    def tearDown(self):
        self.store.close()
        self.tmp.cleanup()

    def age(self, identity, *, seconds):
        agent_id = identity["agent"]["agent_id"]
        old = time.time() - seconds
        with self.store.lock, self.store.db:
            self.store.db.execute(
                "UPDATE agents SET created_at=?,updated_at=?,last_mcp_activity=? "
                "WHERE agent_id=?", (old, old, old, agent_id)
            )

    def test_expired_recipient_cannot_acknowledge_new_task(self):
        self.age(self.b, seconds=MESSAGE_TTL_SECONDS + 5)
        with self.assertRaisesRegex(ValueError, "expired"):
            self.store.send(
                self.a["agent"]["agent_id"], self.a["token"], "recipient",
                "Never pretend this was delivered",
            )
        self.assertEqual(
            self.store.db.execute("SELECT count(*) FROM messages").fetchone()[0], 0
        )
        self.assertEqual(
            [r["name"] for r in self.store.prune_agents()], ["recipient"]
        )
        fresh = self.store.register("recipient", "new person", "other")
        self.assertNotEqual(fresh["agent"]["agent_id"], self.b["agent"]["agent_id"])

    def test_pending_message_survives_recipient_inactivity_cleanup(self):
        message = self.store.send(
            self.a["agent"]["agent_id"], self.a["token"], "recipient", "Fresh task"
        )
        self.age(self.b, seconds=MESSAGE_TTL_SECONDS + 10)
        self.assertEqual(self.store.prune_agents(), [])
        self.assertEqual(
            self.store.db.execute(
                "SELECT status FROM messages WHERE message_id=?",
                (message["message_id"],)
            ).fetchone()[0], "pending"
        )
        # Once its own TTL ends, the recipient may finally be pruned.
        future = time.time() + MESSAGE_TTL_SECONDS + 1
        self.assertEqual(self.store.prune_messages(at=future)["expired_messages"], 1)
        self.assertEqual(len(self.store.prune_agents(at=future)), 2)

    def test_reconnect_refreshes_activity(self):
        self.age(self.b, seconds=MESSAGE_TTL_SECONDS - 10)
        result = self.store.register(
            "recipient", "tester", "other", agent_id=self.b["agent"]["agent_id"],
            token=self.b["token"],
        )
        self.assertFalse(result["created"])
        self.assertGreater(
            self.store._agent(self.b["agent"]["agent_id"])["last_mcp_activity"],
            time.time() - 5,
        )
        self.assertEqual(self.store.prune_agents(at=time.time()+30), [])

    def test_legacy_sqlite_migrates_to_incremental_vacuum(self):
        import sqlite3
        self.store.close()
        with sqlite3.connect(self.dbfile) as raw:
            raw.execute("PRAGMA auto_vacuum=NONE")
            raw.execute("VACUUM")
            raw.execute("CREATE TABLE IF NOT EXISTS old_data(value TEXT)")
            raw.execute("INSERT INTO old_data(value) VALUES('original')")
        self.store = Store(self.dbfile)
        self.assertEqual(self.store.db.execute("PRAGMA auto_vacuum").fetchone()[0],2)
        self.assertEqual(self.store.db.execute("SELECT value FROM old_data").fetchone()[0],
                         "original")

    def test_sqlite_compaction_returns_pages_to_os(self):
        self.assertEqual(self.store.db.execute("PRAGMA auto_vacuum").fetchone()[0], 2)
        aid, token = self.a["agent"]["agent_id"], self.a["token"]
        for index in range(120):
            self.store.send(aid, token, "recipient", "x" * 12000 + str(index))
        with self.store.lock:
            pages_before = self.store.db.execute("PRAGMA page_count").fetchone()[0]
        with self.store.lock, self.store.db:
            self.store.db.execute(
                "UPDATE messages SET created_at=?",
                (time.time() - MESSAGE_TTL_SECONDS - 1,)
            )
        self.assertEqual(self.store.prune_messages()["expired_messages"], 120)
        self.store.maintain_storage()
        with self.store.lock:
            pages_after = self.store.db.execute("PRAGMA page_count").fetchone()[0]
        self.assertLess(pages_after, pages_before)


class CodexSecurityTests(unittest.TestCase):
    def test_local_websocket_url_requires_actual_loopback_host(self):
        for host in ("localhost", "127.0.0.1", "[::1]"):
            url = f"ws://{host}:8787/api/v1/channels/ws"
            self.assertEqual(validate_server_url(url), url)
        for url in (
            "ws://localhost:8787@evil.example:9876/api/v1/channels/ws",
            "ws://127.0.0.1:8787@evil.example:9876/api/v1/channels/ws",
            "wss://example.com/api/v1/channels/ws",
            "ws://127.0.0.1:8787/another",
            "ws://127.0.0.1:8787/api/v1/channels/ws?token=abc",
            "ws://127.0.0.1:8787/api/v1/channels/ws#x",
            "ws://127.0.0.1:8787",
            "ws://localhost:bad/api/v1/channels/ws",
        ):
            with self.subTest(url=url), self.assertRaises(ValueError):
                validate_server_url(url)

    def test_websocket_redirect_cannot_move_token_to_remote_host(self):
        connection = LocalOnlyConnect(
            "ws://127.0.0.1:8787/api/v1/channels/ws", proxy=None
        )
        redirect = InvalidStatus(Response(
            302, "Found",
            Headers([("Location","ws://evil.example:9999/api/v1/channels/ws")]),
            b"",
        ))
        self.assertIsInstance(connection.process_redirect(redirect), Exception)

    def test_codex_lifecycle_requires_known_turn_state(self):
        with tempfile.TemporaryDirectory() as path:
            root=Path(path)
            thread="01234567-1234-1234-1234-123456789abc"
            session=root/"sessions"/"2026"/"11"/"17"
            session.mkdir(parents=True)
            file=session/f"rollout-test-{thread}.jsonl"
            def emit(event):
                with file.open("a") as handle:
                    handle.write(json.dumps({
                        "type":"event_msg", "payload":{"type":event},
                    }) + "\n")
            self.assertEqual(detect_state(thread, codex_home=root), "unknown")
            emit("task_started")
            self.assertEqual(detect_state(thread, codex_home=root), "busy")
            emit("item_completed")
            self.assertEqual(detect_state(thread, codex_home=root), "busy")
            emit("task_complete")
            self.assertEqual(detect_state(thread, codex_home=root), "idle")
            self.assertEqual(detect_state("named-session", codex_home=root),"unknown")
            self.assertEqual(detect_state("named-session", codex_home=root,
                                          assume_idle=True),"idle")
            statefile=root/"codex-state.txt"
            statefile.write_text("busy\n")
            self.assertEqual(detect_state("named-session", codex_home=root,
                                          state_file=statefile), "busy")
            stale=time.time()-120
            os.utime(statefile,(stale,stale))
            self.assertEqual(detect_state("named-session", codex_home=root,
                                          state_file=statefile), "unknown")


class AdministrativeAndAuditTests(unittest.TestCase):
    def test_admin_token_persists_and_has_private_mode(self):
        with tempfile.TemporaryDirectory() as path:
            p=Path(path)/"test.db"
            app1=create_app(Config(database=str(p)))
            secret=Path(app1.state.admin_token_file)
            self.assertEqual(stat.S_IMODE(secret.stat().st_mode),0o600)
            old=secret.read_text()
            app1.state.store.close()
            app2=create_app(Config(database=str(p)))
            self.assertEqual(secret.read_text(),old)
            app2.state.store.close()

    def test_unauthenticated_mcp_attempt_is_not_attributed(self):
        with tempfile.TemporaryDirectory() as path:
            app=create_app(Config(database=str(Path(path)/"test.db")))
            with TestClient(app,base_url="http://127.0.0.1:8787") as client:
                reg=client.post("/api/v1/agents/register",json={
                    "name":"victim","role":"reviewer","kind":"other"
                }).json()
                aid=reg["agent"]["agent_id"]
                res=client.post("/mcp",headers={
                    "Content-Type":"application/json",
                    "Accept":"application/json, text/event-stream"
                },json={"jsonrpc":"2.0","id":3,"method":"tools/call",
                        "params":{"name":"heartbeat",
                                  "arguments":{"agent_id":aid, "token":"wrong"}}})
                self.assertTrue(res.json()["result"]["isError"])
                audit=client.get("/api/v1/dashboard/tool-history").json()["items"]
                self.assertEqual(audit[0]["status"],"error")
                self.assertIsNone(audit[0]["agent_id"])
                self.assertIsNone(audit[0]["agent_name"])
