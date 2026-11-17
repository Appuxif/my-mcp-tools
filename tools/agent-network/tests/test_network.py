from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

from fastapi.testclient import TestClient

from agent_network.codex_adapter import queue_wake
from agent_network.server import Config, create_app
from agent_network.store import Store
from auth_helpers import basic_headers


class StoreTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.path = Path(self.tmp.name) / "state.db"
        self.store = Store(self.path)
        self.a = self.store.register("alpha", "backend", "codex")
        self.b = self.store.register("beta", "frontend", "chatgpt")

    def tearDown(self):
        self.store.close()
        self.tmp.cleanup()

    def test_registration_and_authentication(self):
        aid = self.a["agent"]["agent_id"]
        self.assertNotIn("token_hash", self.a["agent"])
        with self.assertRaises(PermissionError):
            self.store.verify(aid, "wrong")
        with self.assertRaises(ValueError):
            self.store.register("alpha", "other", "other")
        resumed = self.store.register("alpha", "backend", "codex",
                                      agent_id=aid, token=self.a["token"])
        self.assertFalse(resumed["created"])

    def test_durable_delivery_and_idempotency(self):
        a, b = self.a, self.b
        aid, bid = a["agent"]["agent_id"], b["agent"]["agent_id"]
        msg = self.store.send(aid, a["token"], "beta", "message", client_message_id="replay")
        again = self.store.send(aid, a["token"], "beta", "message", client_message_id="replay")
        self.assertEqual(msg["message_id"], again["message_id"])
        self.assertTrue(again["duplicate"])
        with self.assertRaises(ValueError):
            self.store.send(aid, a["token"], "beta", "different", client_message_id="replay")
        inbox = self.store.inbox(bid, b["token"])
        self.assertEqual(len(inbox), 1)
        self.assertEqual(inbox[0]["body"], "message")
        with self.assertRaises(ValueError):
            self.store.acknowledge(aid, a["token"], msg["message_id"])
        self.store.close()
        self.store = Store(self.path)
        self.assertEqual(len(self.store.inbox(bid, b["token"])), 1)
        self.store.acknowledge(bid, b["token"], msg["message_id"])
        self.assertEqual(self.store.inbox(bid, b["token"]), [])

    def test_task_and_wake_cooldown(self):
        aid = self.a["agent"]["agent_id"]
        bid = self.b["agent"]["agent_id"]
        self.assertEqual(self.store.update_task(aid, self.a["token"],
                                                "implement HTTP API", "working")["task_status"],
                         "working")
        self.store.send(aid, self.a["token"], "beta", "check inbox")
        candidates = self.store.candidates(0, 0)
        self.assertIn(bid, [r["agent_id"] for r in candidates])
        self.store.mark_wake(bid)
        self.assertNotIn(bid, [r["agent_id"] for r in self.store.candidates(0, 120)])

    def test_optional_channel_presence(self):
        bid = self.b["agent"]["agent_id"]
        self.store.connect_channel(bid, self.b["token"], "chatgpt", "ws-1", "idle")
        self.assertEqual(self.store.db.execute(
            "SELECT connected FROM channels WHERE channel_id='ws-1'"
        ).fetchone()[0], 1)
        self.store.update_channel("ws-1", "busy")
        self.assertEqual(self.store.db.execute(
            "SELECT state FROM channels WHERE channel_id='ws-1'"
        ).fetchone()[0], "busy")
        self.store.disconnect_all_channels()
        self.assertEqual(self.store.db.execute(
            "SELECT connected FROM channels WHERE channel_id='ws-1'"
        ).fetchone()[0], 0)


class ApiTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.app = create_app(Config(
            database=str(Path(self.tmp.name) / "api.db"),
            inactive_seconds=0,
            wake_scan_seconds=0.05,
            wake_cooldown_seconds=10,
        ))
        self.cm = TestClient(self.app, base_url="http://127.0.0.1:8787")
        self.client = self.cm.__enter__()
        self.client.headers.update(basic_headers(self.app))

    def tearDown(self):
        self.cm.__exit__(None, None, None)
        self.tmp.cleanup()

    def register(self, name, kind="chatgpt"):
        response = self.client.post("/api/v1/agents/register", json={
            "name": name, "role": "developer", "kind": kind,
        })
        self.assertEqual(response.status_code, 200, response.text[:300])
        return response.json()

    def test_registration_http(self):
        agent = self.register("frontend")
        self.assertEqual(self.client.get("/api/v1/health").json()["agents"], 1)
        self.assertEqual(self.client.post("/api/v1/agents/register", json={
            "name": "frontend", "role": "different",
        }).status_code, 409)
        response = self.client.post("/api/v1/agents/profile", json={
            "agent_id": agent["agent"]["agent_id"], "token": agent["token"],
            "role": "UI architect", "purpose": "reusable UI",
        })
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["role"], "UI architect")
        self.assertNotIn("token_hash", self.client.get("/api/v1/agents").text)

    def test_ws_wake_contains_no_message_body(self):
        a = self.register("source", "codex")
        b = self.register("target")
        self.app.state.store.send(a["agent"]["agent_id"], a["token"],
                                  "target", "PRIVATE MESSAGE BODY")
        with self.client.websocket_connect("/api/v1/channels/ws", headers={"Host":"127.0.0.1:8787"}) as ws:
            ws.send_json({
                "type": "register", "kind": "chatgpt", "state": "idle",
                "agent_id": b["agent"]["agent_id"], "token": b["token"],
            })
            reg = ws.receive_json()
            self.assertEqual(reg["type"], "registered")
            wake = ws.receive_json()
            self.assertEqual(wake["type"], "wake")
            self.assertEqual(wake["pending_count"], 1)
            self.assertNotIn("PRIVATE MESSAGE BODY", json.dumps(wake))
            ws.send_json({"type": "wake_result", "wake_id": wake["wake_id"],
                          "status": "submitted"})
            ws.send_json({"type": "ping", "state": "busy"})
            self.assertEqual(ws.receive_json()["type"], "pong")

    def test_mcp_initialize_and_tools_list(self):
        headers = {
            "Content-Type": "application/json",
            "Accept": "application/json, text/event-stream",
        }
        init = self.client.post("/mcp", headers=headers, json={
            "jsonrpc": "2.0", "id": 1, "method": "initialize",
            "params": {
                "protocolVersion": "2025-06-18",
                "capabilities": {},
                "clientInfo": {"name": "test", "version": "1"},
            }
        })
        self.assertEqual(init.status_code, 200, init.text[:350])
        self.assertIn("result", init.json())
        listed = self.client.post("/mcp", headers=headers, json={
            "jsonrpc": "2.0", "id": 2, "method": "tools/list", "params": {},
        })
        self.assertEqual(listed.status_code, 200, listed.text[:350])
        names = {t["name"] for t in listed.json()["result"]["tools"]}
        self.assertTrue({"register_agent", "send_message", "get_messages", "ack_message"} <= names)


class CodexTests(unittest.TestCase):
    def test_codex_queue_and_resume_warning(self):
        output = Mock(returncode=0, stdout="queued", stderr="")
        with patch("agent_network.codex_adapter.shutil.which", return_value="/bin/codex"), patch(
            "agent_network.codex_adapter.subprocess.run", return_value=output
        ) as execute:
            status, _ = queue_wake("thread-1", "agent-1", 2)
            self.assertEqual(status, "queued")
            self.assertEqual(execute.call_args.args[0][:4],
                             ["codex", "queue", "--thread", "thread-1"])
            self.assertIn("--resume", execute.call_args.args[0])
        output.stderr = "Warning: failed to resume"
        with patch("agent_network.codex_adapter.shutil.which", return_value="/bin/codex"), patch(
            "agent_network.codex_adapter.subprocess.run", return_value=output
        ):
            self.assertEqual(queue_wake("thread-1", "agent-1", 2)[0], "queued_warning")


if __name__ == "__main__":
    unittest.main()
