"""Dashboard sends respect team isolation and explain how to resolve failures."""
from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from fastapi.testclient import TestClient

from agent_network.server import Config, create_app
from auth_helpers import basic_headers


class DashboardCrossTeamSendTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.app = create_app(Config(database=str(Path(self.tmp.name) / "db.sqlite")))
        self.cm = TestClient(self.app, base_url="http://127.0.0.1:8787")
        self.client = self.cm.__enter__()
        self.basic = basic_headers(self.app)
        self.store = self.app.state.store
        self.recipient = self.store.register("Chopper-Developer", "developer", "chatgpt")
        self.recipient_id = self.recipient["agent"]["agent_id"]
        self.store.assign_teams(self.recipient_id, ["Chopper"])
        dashboard = self.client.post("/api/v1/dashboard-agent/enable",
                                     headers=self.basic,
                                     json={"name": "dashboard"}).json()
        self.dashboard = dashboard
        self.sender_id = dashboard["agent"]["agent_id"]
        self.store.assign_teams(self.sender_id, ["My MCP Tools", "default"])
        self.dash_headers = {
            **self.basic,
            "X-Agent-Id": self.sender_id,
            "X-Agent-Token": dashboard["token"],
        }
        self.url = "/api/v1/dashboard-agent/send"

    def tearDown(self):
        self.cm.__exit__(None, None, None)
        self.tmp.cleanup()

    def _teams(self, agent_id):
        return {t["name"] for t in self.store._teams(agent_id)}

    def _assign_dashboard(self, names):
        return self.client.put(
            f"/api/v1/dashboard/agents/{self.sender_id}/teams",
            headers=self.basic, json={"teams": names},
        )

    def test_missing_common_team_gives_actionable_error_without_side_effects(self):
        self.assertFalse(self.store._shared(self.sender_id, self.recipient_id))
        original_sender = self._teams(self.sender_id)
        original_recipient = self._teams(self.recipient_id)
        response = self.client.post(self.url, headers=self.dash_headers, json={
            "to": self.recipient_id, "text": "Начинай задачу",
            "client_message_id": "once",
        })
        self.assertEqual(response.status_code, 400, response.text)
        error = response.json()["detail"]
        self.assertIn("не найден в командах Dashboard-агента", error)
        self.assertIn("Chopper-Developer", error)
        self.assertIn("Chopper", error)
        self.assertIn("Добавьте Dashboard-агента", error)
        self.assertEqual(self._teams(self.sender_id), original_sender)
        self.assertEqual(self._teams(self.recipient_id), original_recipient)
        self.assertFalse(self.store.db.execute("SELECT 1 FROM messages").fetchone())

    def test_manual_team_assignment_then_send_and_idempotent_retry(self):
        payload = {
            "to": self.recipient_id, "text": "Начинай задачу",
            "client_message_id": "once",
        }
        rejected = self.client.post(self.url, headers=self.dash_headers, json=payload)
        self.assertEqual(rejected.status_code, 400)
        self.assertEqual(self._teams(self.sender_id), {"My MCP Tools", "default"})
        updated = self._assign_dashboard(["My MCP Tools", "default", "Chopper"])
        self.assertEqual(updated.status_code, 200, updated.text)
        response = self.client.post(self.url, headers=self.dash_headers, json=payload)
        self.assertEqual(response.status_code, 200, response.text)
        self.assertFalse(response.json()["duplicate"])
        self.assertEqual(self._teams(self.sender_id),
                         {"My MCP Tools", "default", "Chopper"})
        self.assertEqual(self._teams(self.recipient_id), {"Chopper"})
        self.assertEqual(len(self.store.inbox(
            self.recipient_id, self.recipient["token"]
        )), 1)
        mid = response.json()["message_id"]
        retry = self.client.post(self.url, headers=self.dash_headers, json=payload)
        self.assertEqual(retry.status_code, 200, retry.text)
        self.assertTrue(retry.json()["duplicate"])
        self.assertEqual(retry.json()["message_id"], mid)
        self.assertEqual(self._teams(self.sender_id),
                         {"My MCP Tools", "default", "Chopper"})

    def test_revoking_common_team_rejects_even_idempotent_retry(self):
        self.assertEqual(self._assign_dashboard(["Chopper"]).status_code, 200)
        payload = {
            "to": self.recipient_id, "text": "Hello",
            "client_message_id": "one-message",
        }
        success = self.client.post(self.url, headers=self.dash_headers, json=payload)
        self.assertEqual(success.status_code, 200)
        self.assertEqual(self._assign_dashboard(["My MCP Tools"]).status_code, 200)
        rejected = self.client.post(self.url, headers=self.dash_headers, json=payload)
        self.assertEqual(rejected.status_code, 400)
        self.assertIn("Добавьте Dashboard-агента", rejected.json()["detail"])
        self.assertEqual(self._teams(self.sender_id), {"My MCP Tools"})
        self.assertEqual(
            self.store.db.execute("SELECT count(*) FROM messages").fetchone()[0], 1
        )

    def test_sender_and_recipient_teams_stay_unchanged_on_auth_failures(self):
        data = {"to": self.recipient_id, "text": "testing"}
        self.assertEqual(self.client.post(self.url, json=data).status_code, 401)
        self.assertEqual(self.client.post(self.url, json=data, headers={
            "X-Agent-Id": self.sender_id, "X-Agent-Token": self.dashboard["token"]
        }).status_code, 401)
        self.assertEqual(self.client.post(self.url, json=data, headers={
            **self.dash_headers, "Origin": "https://evil.test"
        }).status_code, 403)
        self.assertEqual(self.client.post(self.url, json=data, headers={
            **self.dash_headers, "X-Agent-Token": "wrong"
        }).status_code, 403)
        self.assertEqual(self._teams(self.sender_id), {"My MCP Tools", "default"})
        self.assertEqual(self._teams(self.recipient_id), {"Chopper"})
        self.assertEqual(
            self.store.db.execute("SELECT count(*) FROM messages").fetchone()[0], 0
        )

    def test_unprivileged_mcp_agent_does_not_learn_invisible_recipient(self):
        other = self.store.register("MCP-Coder", "developer", "other")
        oid = other["agent"]["agent_id"]
        self.store.assign_teams(oid, ["My MCP Tools"])
        with self.assertRaisesRegex(ValueError, "^Recipient agent not found$"):
            self.store.send(oid, other["token"], self.recipient_id, "not allowed")
        self.assertFalse(self.store._shared(oid, self.recipient_id))
        self.assertFalse(self.store.db.execute("SELECT 1 FROM messages").fetchone())

    def test_unknown_recipient_is_distinct_from_missing_team(self):
        response = self.client.post(self.url, headers=self.dash_headers, json={
            "to": "unregistered-agent", "text": "Hello",
        })
        self.assertEqual(response.status_code, 400)
        self.assertEqual(response.json()["detail"], "Recipient agent not found")
        self.assertEqual(self._teams(self.sender_id), {"My MCP Tools", "default"})

    def test_idempotency_key_reuse_for_different_recipient_does_not_mutate_teams(self):
        self.assertEqual(self._assign_dashboard(["Chopper"]).status_code, 200)
        first = self.client.post(self.url, headers=self.dash_headers, json={
            "to": self.recipient_id, "text": "initial", "client_message_id": "same"
        })
        self.assertEqual(first.status_code, 200)
        other = self.store.register("Other-Team-Worker", "worker", "other")
        oid = other["agent"]["agent_id"]
        self.store.assign_teams(oid, ["Secret"])
        rejected = self.client.post(self.url, headers=self.dash_headers, json={
            "to": oid, "text": "different", "client_message_id": "same"
        })
        self.assertEqual(rejected.status_code, 400)
        self.assertIn("Idempotency key", rejected.json()["detail"])
        self.assertFalse(self.store._shared(self.sender_id, oid))
        self.assertEqual(self._teams(self.sender_id), {"Chopper"})
        self.assertEqual(len(self.store.inbox(oid, other["token"])), 0)

    def test_manual_join_to_second_team_enables_reply(self):
        other = self.store.register("Second-Worker", "worker", "other")
        oid = other["agent"]["agent_id"]
        self.store.assign_teams(oid, ["Ops"])
        rejected = self.client.post(self.url, headers=self.dash_headers, json={
            "to": oid, "text": "Hello Ops",
        })
        self.assertEqual(rejected.status_code, 400)
        self.assertIn("Ops", rejected.json()["detail"])
        self.assertEqual(self._assign_dashboard(["Ops"]).status_code, 200)
        response = self.client.post(self.url, headers=self.dash_headers, json={
            "to": oid, "text": "Hello Ops",
        })
        self.assertEqual(response.status_code, 200, response.text)
        reply = self.store.send(oid, other["token"], self.sender_id, "Hi Admin")
        inbox = self.client.get("/api/v1/dashboard-agent/inbox",
                                headers=self.dash_headers)
        self.assertEqual(inbox.status_code, 200)
        self.assertEqual(
            [x["message_id"] for x in inbox.json()["items"]],
            [reply["message_id"]],
        )


if __name__ == "__main__":
    unittest.main()
