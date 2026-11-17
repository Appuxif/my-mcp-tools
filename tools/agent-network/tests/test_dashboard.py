"""Dashboard exposes safe metadata and aggregates without exposing message bodies."""
from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from fastapi.testclient import TestClient

from agent_network.server import Config, create_app
from agent_network.store import Store


class DashboardStoreTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.store = Store(Path(self.temp.name) / "data.db")
        self.a = self.store.register("frontend", "UI engineer", "chatgpt")
        self.b = self.store.register("backend", "API engineer", "codex")

    def tearDown(self):
        self.store.close()
        self.temp.cleanup()

    def test_snapshot_flow_and_pending_counts(self):
        a, b = self.a, self.b
        sent = self.store.send(
            a["agent"]["agent_id"], a["token"], "backend",
            "TOP SECRET: SHOULD NOT APPEAR IN DASHBOARD",
        )
        self.store.connect_channel(b["agent"]["agent_id"], b["token"],
                                   "codex", "channel-1", "idle")
        snap = self.store.dashboard_snapshot(present_ids={b["agent"]["agent_id"]})
        self.assertEqual(snap["metrics"]["agents_total"], 2)
        self.assertEqual(snap["metrics"]["channels_connected"], 1)
        self.assertEqual(snap["metrics"]["pending_messages"], 1)
        self.assertEqual(snap["metrics"]["messages_24h"], 1)
        self.assertEqual(snap["edges"][0]["source"], a["agent"]["agent_id"])
        self.assertEqual(snap["edges"][0]["target"], b["agent"]["agent_id"])
        self.assertEqual(snap["edges"][0]["pending_count"], 1)
        self.assertEqual(snap["recent"][0]["status"], "pending")
        self.assertEqual(snap["channels"][0]["agent_name"], "backend")
        self.assertNotIn("body", str(snap))
        self.assertNotIn("TOP SECRET", str(snap))
        self.assertNotIn(a["token"], str(snap))
        self.assertNotIn(b["token"], str(snap))
        self.store.acknowledge(b["agent"]["agent_id"], b["token"],
                               sent["message_id"])
        after = self.store.dashboard_snapshot()
        self.assertEqual(after["metrics"]["pending_messages"], 0)
        self.assertEqual(after["recent"][0]["status"], "acknowledged")
        self.assertEqual(after["edges"][0]["pending_count"], 0)


class DashboardHttpTests(unittest.TestCase):
    def test_html_assets_json_and_no_cache(self):
        with tempfile.TemporaryDirectory() as tmp:
            app = create_app(Config(database=str(Path(tmp) / "test.db")))
            with TestClient(app, base_url="http://127.0.0.1:8787") as client:
                page = client.get("/dashboard")
                self.assertEqual(page.status_code, 200)
                self.assertIn("Карта взаимодействий", page.text)
                self.assertIn("Content-Security-Policy", page.headers)
                self.assertIn("no-store", page.headers["Cache-Control"])
                js = client.get("/dashboard-assets/dashboard.js")
                self.assertEqual(js.status_code, 200)
                self.assertIn("function graph(data)", js.text)
                graph_utils = client.get("/dashboard-assets/graph-utils.js")
                self.assertEqual(graph_utils.status_code, 200)
                self.assertIn("function edgeGeometry", graph_utils.text)
                self.assertIn("function edgeAge", graph_utils.text)
                self.assertIn("delete-agent", page.text)
                css = client.get("/dashboard-assets/styles.css")
                self.assertEqual(css.status_code, 200)
                self.assertIn(".edge.has-pending", css.text)
                meta = client.get("/api/v1/dashboard")
                self.assertEqual(meta.status_code, 200)
                self.assertIn("no-store", meta.headers["Cache-Control"])
                self.assertEqual(meta.json()["metrics"]["agents_total"], 0)
                self.assertIn("started_at", meta.json()["server"])
                self.assertEqual(meta.json()["edges"], [])


if __name__ == "__main__":
    unittest.main()
