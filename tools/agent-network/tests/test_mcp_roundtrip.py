"""End-to-end native MCP protocol tests with isolated SQLite storage."""
from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from fastapi.testclient import TestClient

from agent_network.server import Config, create_app


class McpRoundTripTests(unittest.TestCase):
    def test_all_native_mcp_tools(self):
        with tempfile.TemporaryDirectory() as tmp:
            app = create_app(Config(database=str(Path(tmp) / "mcp-test.db"),
                                    inactive_seconds=60))
            with TestClient(app, base_url="http://127.0.0.1:8787") as client:
                headers = {
                    "Content-Type": "application/json",
                    "Accept": "application/json, text/event-stream",
                }

                def rpc(method: str, params: dict, seq: int) -> dict:
                    response = client.post(
                        "/mcp",
                        json={"jsonrpc": "2.0", "method": method,
                              "id": seq, "params": params},
                        headers=headers,
                    )
                    self.assertEqual(response.status_code, 200, response.text[:300])
                    data = response.json()
                    self.assertNotIn("error", data, data)
                    return data["result"]

                def tool(name: str, arguments: dict, seq: int):
                    raw = rpc("tools/call", {"name": name, "arguments": arguments}, seq)
                    self.assertFalse(raw.get("isError"), raw)
                    if "structuredContent" in raw:
                        val = raw["structuredContent"]
                        if isinstance(val, dict) and "result" in val:
                            return val["result"]
                        return val
                    self.assertTrue(raw.get("content"), raw)
                    return json.loads(raw["content"][0]["text"])

                initialize = rpc(
                    "initialize",
                    {"protocolVersion": "2025-06-18",
                     "capabilities": {},
                     "clientInfo": {"name": "smoke-test", "version": "1"}},
                    1,
                )
                self.assertEqual(initialize["serverInfo"]["name"], "agent-network")
                names = {x["name"] for x in rpc("tools/list", {}, 2)["tools"]}
                for expected in (
                    "register_agent", "list_agents", "send_message", "get_messages",
                    "ack_message", "update_task", "heartbeat",
                    "save_context", "read_context",
                ):
                    self.assertIn(expected, names)

                alice = tool("register_agent", {
                    "name": "test-alice", "role": "MCP tester", "kind": "other"}, 3)
                bob = tool("register_agent", {
                    "name": "test-bob", "role": "MCP tester", "kind": "other"}, 4)
                a_auth = {"agent_id": alice["agent"]["agent_id"],
                          "token": alice["token"]}
                b_auth = {"agent_id": bob["agent"]["agent_id"],
                          "token": bob["token"]}
                self.assertTrue(tool("heartbeat", a_auth, 5)["ok"])

                self.assertEqual(tool("read_context", a_auth, 13), {
                    "exists": False, "context": "", "updated_at": None,
                })
                context = "# Checkpoint\nImplement durable context\nNext: validation"
                saved = tool("save_context", {**a_auth, "context": context}, 14)
                self.assertTrue(saved["saved"])
                self.assertEqual(saved["bytes"], len(context.encode("utf-8")))
                restored = tool("read_context", a_auth, 15)
                self.assertTrue(restored["exists"])
                self.assertEqual(restored["context"], context)
                self.assertEqual(restored["updated_at"], saved["updated_at"])
                self.assertFalse(tool("read_context", b_auth, 16)["exists"])

                agents = tool("list_agents", a_auth, 6)
                self.assertEqual({x["name"] for x in agents}, {"test-alice", "test-bob"})
                self.assertEqual(tool("update_task", {
                    **a_auth, "task": "MCP round trip", "status": "working"},
                    7)["task_status"], "working")

                message_args = {
                    **a_auth, "to": "test-bob", "text": "Hello from Alice",
                    "client_message_id": "roundtrip-a-b",
                }
                sent = tool("send_message", message_args, 8)
                self.assertFalse(sent["duplicate"])
                same = tool("send_message", message_args, 9)
                self.assertEqual(sent["message_id"], same["message_id"])
                self.assertTrue(same["duplicate"])

                inbox = tool("get_messages", b_auth, 10)
                self.assertEqual(len(inbox), 1)
                self.assertEqual(inbox[0]["body"], "Hello from Alice")
                self.assertEqual(tool("ack_message", {
                    **b_auth, "message_id": sent["message_id"]},
                    11)["status"], "acknowledged")
                self.assertEqual(tool("get_messages", b_auth, 12), [])
                self.assertEqual(tool("update_task", {
                    **a_auth, "task": "MCP round trip", "status": "done"},
                    13)["task_status"], "done")


if __name__ == "__main__":
    unittest.main()
