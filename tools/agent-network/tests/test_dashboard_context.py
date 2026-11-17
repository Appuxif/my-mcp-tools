"""Read-only administrator access to saved agent compact contexts."""
from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from fastapi.testclient import TestClient

from agent_network.server import Config, create_app
from auth_helpers import basic_headers


class DashboardContextTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.app = create_app(Config(database=str(Path(self.tmp.name) / "contexts.db")))
        self.cm = TestClient(self.app, base_url="http://127.0.0.1:8787")
        self.client = self.cm.__enter__()
        self.auth = basic_headers(self.app)
        self.agent = self.app.state.store.register("Sample", "worker", "other")
        self.agent_id = self.agent["agent"]["agent_id"]
        self.url = f"/api/v1/dashboard/agents/{self.agent_id}/context"

    def tearDown(self):
        self.cm.__exit__(None, None, None)
        self.tmp.cleanup()

    def test_empty_saved_context_has_explicit_readonly_response(self):
        response = self.client.get(self.url, headers=self.auth)
        self.assertEqual(response.status_code, 200)
        self.assertIn("no-store", response.headers["cache-control"])
        self.assertEqual(response.json(), {
            "agent_id": self.agent_id,
            "agent_name": "Sample",
            "exists": False, "context": "", "updated_at": None, "bytes": 0,
        })

    def test_admin_can_read_exact_context_without_modifying_agent(self):
        original = "# Summary\nRussian: Привет\n<script>alert(1)</script>\n"
        self.app.state.store.save_context(self.agent_id, self.agent["token"], original)
        with self.app.state.store.lock:
            activity = self.app.state.store._agent(self.agent_id)["last_mcp_activity"]
            saved_at = self.app.state.store.db.execute(
                "SELECT updated_at FROM agent_contexts WHERE agent_id=?",
                (self.agent_id,),
            ).fetchone()["updated_at"]
        result = self.client.get(self.url, headers=self.auth)
        self.assertEqual(result.status_code, 200, result.text)
        data = result.json()
        self.assertEqual(data["context"], original)
        self.assertEqual(data["bytes"], len(original.encode("utf-8")))
        self.assertEqual(data["agent_name"], "Sample")
        self.assertTrue(data["exists"])
        self.assertEqual(data["updated_at"], saved_at)
        self.assertIn("no-store", result.headers["cache-control"])
        with self.app.state.store.lock:
            self.assertEqual(
                self.app.state.store._agent(self.agent_id)["last_mcp_activity"], activity
            )
        # Metadata endpoints never expose saved context.
        snapshot = self.client.get("/api/v1/dashboard", headers=self.auth)
        self.assertNotIn(original, snapshot.text)

    def test_access_requires_dashboard_basic_and_same_origin(self):
        self.app.state.store.save_context(self.agent_id, self.agent["token"], "secret")
        self.assertEqual(self.client.get(self.url).status_code, 401)
        self.assertEqual(self.client.get(self.url, headers={
            "X-Agent-Id": self.agent_id, "X-Agent-Token": self.agent["token"]
        }).status_code, 401)
        self.assertEqual(self.client.get(self.url, headers={
            "X-Agent-Network-Admin-Token": "not-dashboard-basic"
        }).status_code, 401)
        self.assertEqual(self.client.get(self.url, headers={
            **self.auth, "Origin": "https://malicious.example"
        }).status_code, 403)
        self.assertEqual(self.client.get(self.url, headers={
            **self.auth, "Sec-Fetch-Site": "cross-site"
        }).status_code, 403)
        self.assertEqual(self.client.get(self.url, headers={
            **self.auth, "Host": "malicious.example"
        }).status_code, 400)
        self.assertEqual(self.client.get(self.url, headers=self.auth).status_code, 200)

    def test_missing_agent_is_404_and_identity_deletion_revokes_access(self):
        unknown = "/api/v1/dashboard/agents/missing/context"
        self.assertEqual(self.client.get(unknown, headers=self.auth).status_code, 404)
        self.app.state.store.save_context(self.agent_id, self.agent["token"], "forget")
        self.app.state.store.delete_agent(self.agent_id)
        self.assertEqual(self.client.get(self.url, headers=self.auth).status_code, 404)


if __name__ == "__main__":
    unittest.main()
