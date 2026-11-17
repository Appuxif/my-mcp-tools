"""Per-agent compact summaries persist until explicit identity deletion."""
from __future__ import annotations

import tempfile
import time
import unittest
from pathlib import Path

from agent_network.server import Config, create_app
from agent_network.store import MAX_CONTEXT_BYTES, MESSAGE_TTL_SECONDS, Store


class CompactContextStoreTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.path = Path(self.temp.name) / "persistent.db"
        self.store = Store(self.path)
        self.a = self.store.register("first", "developer", "chatgpt")
        self.b = self.store.register("second", "reviewer", "other")
        self.aid = self.a["agent"]["agent_id"]
        self.bid = self.b["agent"]["agent_id"]

    def tearDown(self):
        self.store.close()
        self.temp.cleanup()

    def test_save_read_replace_preserves_exact_content_and_metadata(self):
        self.assertEqual(self.store.read_context(self.aid, self.a["token"]), {
            "exists": False, "context": "", "updated_at": None,
        })
        summary = "# Контекст\n  Этап 1 готов\n\nСледующее: пройти E2E\n"
        saved = self.store.save_context(self.aid, self.a["token"], summary)
        self.assertEqual(saved["bytes"], len(summary.encode("utf-8")))
        self.assertTrue(saved["saved"])
        self.assertEqual(self.store.read_context(self.aid, self.a["token"]), {
            "exists": True, "context": summary, "updated_at": saved["updated_at"],
        })
        another = "# Новый compact\nЗаменяем, а не дописываем"
        self.assertTrue(self.store.save_context(self.aid, self.a["token"], another)["saved"])
        self.assertEqual(self.store.read_context(self.aid, self.a["token"])["context"], another)
        self.assertFalse(self.store.read_context(self.bid, self.b["token"])["exists"])
        self.assertNotIn(another, str(self.store.agents()))
        self.assertNotIn(another, str(self.store.dashboard_snapshot()))
        self.assertNotIn(another, str(self.store.tool_history()))

    def test_only_owner_can_read_or_replace_summary(self):
        self.store.save_context(self.aid, self.a["token"], "private summary")
        with self.assertRaises(PermissionError):
            self.store.read_context(self.aid, self.b["token"])
        with self.assertRaises(PermissionError):
            self.store.save_context(self.aid, self.b["token"], "malicious replacement")
        with self.assertRaises(ValueError):
            self.store.read_context("not-an-agent", self.a["token"])
        self.assertEqual(self.store.read_context(self.aid, self.a["token"])["context"],
                         "private summary")

    def test_context_survives_restart_and_message_ttl_and_long_inactivity(self):
        saved = self.store.save_context(self.aid, self.a["token"], "migration checkpoint")
        with self.store.lock, self.store.db:
            old = time.time() - 90 * 86400
            self.store.db.execute(
                "UPDATE agents SET created_at=?,updated_at=?,last_mcp_activity=?,"
                "last_channel_activity=? WHERE agent_id=?",
                (old, old, old, old, self.aid),
            )
        self.store.prune_messages(at=time.time() + MESSAGE_TTL_SECONDS + 1)
        self.store.prune_channels(at=time.time() + MESSAGE_TTL_SECONDS + 1)
        self.store.maintain_storage()
        self.store.close()
        self.store = Store(self.path)
        restored = self.store.read_context(self.aid, self.a["token"])
        self.assertEqual(restored, {"exists": True, "context": "migration checkpoint",
                                    "updated_at": saved["updated_at"]})
        self.assertEqual(len(self.store.agents()), 2)

    def test_only_manual_delete_removes_context_and_releases_agent_name(self):
        self.store.save_context(self.aid, self.a["token"], "erase me with the agent")
        deleted = self.store.delete_agent(self.aid)
        self.assertTrue(deleted["deleted_context"])
        self.assertFalse(self.store.db.execute(
            "SELECT 1 FROM agent_contexts WHERE agent_id=?", (self.aid,)
        ).fetchone())
        with self.assertRaises(ValueError):
            self.store.read_context(self.aid, self.a["token"])
        recreated = self.store.register("first", "developer", "chatgpt")
        self.assertNotEqual(recreated["agent"]["agent_id"], self.aid)
        self.assertFalse(self.store.read_context(
            recreated["agent"]["agent_id"], recreated["token"])["exists"])

    def test_context_must_be_text_not_blank_or_over_128_kib(self):
        auth = (self.aid, self.a["token"])
        for invalid in ("", " \n  ", None, 42):
            with self.subTest(value=invalid), self.assertRaises(ValueError):
                self.store.save_context(*auth, invalid)
        self.assertEqual(self.store.save_context(*auth, "x" * MAX_CONTEXT_BYTES)["bytes"],
                         MAX_CONTEXT_BYTES)
        for invalid in ("x" * (MAX_CONTEXT_BYTES + 1),
                        "✓" * (MAX_CONTEXT_BYTES // 3 + 1)):
            with self.subTest(size=len(invalid)), self.assertRaisesRegex(ValueError, "exceeds"):
                self.store.save_context(*auth, invalid)
        self.assertEqual(len(self.store.read_context(*auth)["context"]), MAX_CONTEXT_BYTES)


class CompactContextMaintenanceTests(unittest.TestCase):
    def test_startup_and_background_maintenance_preserve_saved_context(self):
        with tempfile.TemporaryDirectory() as tmp:
            app = create_app(Config(database=str(Path(tmp) / "app.db"),
                                    wake_scan_seconds=.01, maintenance_seconds=.02))
            store = app.state.store
            entry = store.register("sleepy", "worker", "other")
            aid, token = entry["agent"]["agent_id"], entry["token"]
            store.save_context(aid, token, "Do not expire")
            old = time.time() - 200 * 86400
            with store.lock, store.db:
                store.db.execute("UPDATE agents SET created_at=?,updated_at=?,"
                                 "last_mcp_activity=? WHERE agent_id=?",
                                 (old, old, old, aid))
            app.state.broker.run_maintenance()
            self.assertEqual(store.read_context(aid, token)["context"], "Do not expire")
            self.assertEqual([a["name"] for a in store.agents()], ["sleepy"])
            store.close()


if __name__ == "__main__":
    unittest.main()
