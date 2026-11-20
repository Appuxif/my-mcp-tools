"""Tests for optional Agent Network MCP stdio request diagnostics."""
from __future__ import annotations

import json
import os
import stat
import socket
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from anyio import create_memory_object_stream
from mcp import types
from mcp.shared.message import SessionMessage

from agent_network.mcp_debug import (
    LoggedReceiveStream, McpDebugLog, debug_enabled, redact,
)


class McpDebugTests(unittest.TestCase):
    def test_env_opt_in(self):
        with patch.dict(os.environ, {}, clear=True):
            self.assertFalse(debug_enabled())
            for value in ("0", "false", "", "off"):
                os.environ["AGENT_NETWORK_DEBUG"] = value
                self.assertFalse(debug_enabled())
            for value in ("1", "true", "YES", "on"):
                os.environ["AGENT_NETWORK_DEBUG"] = value
                self.assertTrue(debug_enabled())

    def test_redacts_secrets_and_preserves_meta_identifiers(self):
        raw = {
            "method": "tools/call", "params": {
                "name": "get_messages",
                "arguments": {
                    "agent_id": "visible-agent-id",
                    "token": "PRIVATE_AGENT_SECRET",
                    "nested": [{"access_token": "hidden1", "api_key": "hidden2"}],
                },
                "_meta": {
                    "openai/session": "session-for-debug",
                    "openai/subject": "user-for-debug",
                    "Authorization": "Bearer private",
                    "requestId": "opaque-context",
                },
            },
        }
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "debug" / "mcp.jsonl"
            logger = McpDebugLog(path)
            try:
                msg = types.jsonrpc_message_adapter.validate_python({
                    "jsonrpc": "2.0", "id": 5, **raw
                })
                logger.record(SessionMessage(msg))
            finally:
                logger.close()
            self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o600)
            raw_log = path.read_text()
            logged = json.loads(raw_log)
            self.assertEqual(logged["direction"], "incoming")
            mcp = logged["jsonrpc"]
            self.assertEqual(mcp["method"], "tools/call")
            self.assertEqual(mcp["params"]["arguments"]["agent_id"], "visible-agent-id")
            self.assertEqual(mcp["params"]["_meta"]["openai/session"], "session-for-debug")
            self.assertEqual(mcp["params"]["_meta"]["openai/subject"], "user-for-debug")
            self.assertEqual(mcp["params"]["_meta"]["requestId"], "opaque-context")
            self.assertNotIn("PRIVATE_AGENT_SECRET", raw_log)
            self.assertNotIn("hidden1", raw_log)
            self.assertNotIn("hidden2", raw_log)
            self.assertNotIn("Bearer private", raw_log)

    def test_redact_does_not_mutate_original(self):
        source = {"params": {"token": "secret", "_meta": {"session": "visible"}}}
        masked = redact(source)
        self.assertEqual(masked["params"]["token"], "[REDACTED]")
        self.assertEqual(source["params"]["token"], "secret")
        self.assertEqual(masked["params"]["_meta"]["session"], "visible")


class DebugReceiveTests(unittest.IsolatedAsyncioTestCase):
    async def test_tap_forwards_same_session_message(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "debug.jsonl"
            logger = McpDebugLog(path)
            tx, rx = create_memory_object_stream(1)
            try:
                message = SessionMessage(types.jsonrpc_message_adapter.validate_python({
                    "jsonrpc": "2.0", "id": 4, "method": "tools/call",
                    "params": {"name": "heartbeat", "arguments": {"token": "private"},
                               "_meta": {"openai/session": "session-id"}},
                }))
                await tx.send(message)
                tapped = LoggedReceiveStream(rx, logger)
                received = await tapped.receive()
                self.assertIs(received, message)
                content = json.loads(path.read_text())
                self.assertEqual(content["jsonrpc"]["params"]["_meta"]["openai/session"],
                                 "session-id")
            finally:
                await tx.aclose()
                await rx.aclose()
                logger.close()


class StdioDebugIntegrationTests(unittest.IsolatedAsyncioTestCase):
    async def test_stdio_roundtrip_logs_metadata_not_token(self):
        from mcp import ClientSession, StdioServerParameters
        from mcp.client.stdio import stdio_client

        root = Path(__file__).resolve().parents[1]
        with tempfile.TemporaryDirectory() as tmp:
            db = Path(tmp) / "temp.db"
            log_path = Path(tmp) / "trace.jsonl"
            with socket.socket() as probe:
                probe.bind(("127.0.0.1", 0))
                port = probe.getsockname()[1]

            from agent_network.store import Store
            store = Store(str(db))
            try:
                agent = store.register("debug-test-agent", "Tester", "other")
                credentials = {
                    "agent_id": agent["agent"]["agent_id"],
                    "token": agent["token"],
                }
            finally:
                store.db.close()

            params = StdioServerParameters(
                command=sys.executable,
                args=["-u", "-m", "agent_network.stdio",
                      "--port", str(port), "--db", str(db)],
                env={
                    "PYTHONPATH": str(root),
                    "AGENT_NETWORK_DEBUG": "1",
                    "AGENT_NETWORK_DEBUG_LOG": str(log_path),
                },
            )
            async with stdio_client(params) as (reader, writer):
                async with ClientSession(reader, writer) as session:
                    response = await session.initialize()
                    self.assertEqual(response.server_info.name, "agent-network")
                    tools = await session.list_tools()
                    self.assertEqual(len(tools.tools), 15)
                    await session.call_tool(
                        "get_messages",
                        arguments=credentials,
                        meta={"openai/session": "fake-session",
                              "openai/subject": "fake-subject"},
                    )
            lines = [json.loads(line) for line in log_path.read_text().splitlines()]
            self.assertTrue(any(x["jsonrpc"]["method"] == "initialize" for x in lines))
            calls = [x["jsonrpc"] for x in lines
                     if x["jsonrpc"].get("method") == "tools/call"]
            self.assertEqual(len(calls), 1)
            args = calls[0]["params"]
            self.assertEqual(args["name"], "get_messages")
            self.assertEqual(args["arguments"]["agent_id"], credentials["agent_id"])
            self.assertEqual(args["arguments"]["token"], "[REDACTED]")
            self.assertEqual(args["_meta"]["openai/session"], "fake-session")
            self.assertEqual(args["_meta"]["openai/subject"], "fake-subject")
            self.assertNotIn(credentials["token"], log_path.read_text())


if __name__ == "__main__":
    unittest.main()
