"""Test that the dashboard belongs to its MCP stdio process, not a service."""
from __future__ import annotations

import base64

import asyncio
import socket
import sys
import tempfile
import unittest
from pathlib import Path

import httpx
from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client


class StdioLifecycleTests(unittest.IsolatedAsyncioTestCase):
    async def test_native_stdio_and_http_close_together(self):
        root = Path(__file__).resolve().parents[1]
        with tempfile.TemporaryDirectory() as tmp:
            probe = socket.socket()
            probe.bind(("127.0.0.1", 0))
            port = probe.getsockname()[1]
            probe.close()
            params = StdioServerParameters(
                command=sys.executable,
                args=[
                    "-u", "-m", "agent_network.stdio",
                    "--port", str(port),
                    "--db", str(Path(tmp) / "temp.db"),
                ],
                env={"PYTHONPATH": str(root)},
            )
            async with stdio_client(params) as (reader, writer):
                async with ClientSession(reader, writer) as session:
                    result = await session.initialize()
                    self.assertEqual(result.server_info.name, "agent-network")
                    tools = await session.list_tools()
                    self.assertEqual(len(tools.tools), 8)
                    async with httpx.AsyncClient(timeout=3) as client:
                        password=(Path(tmp)/"admin-token").read_text().strip()
                        basic="Basic "+base64.b64encode(
                            ("admin:"+password).encode()
                        ).decode()
                        response = await client.get(
                            f"http://127.0.0.1:{port}/dashboard",
                            headers={"Authorization":basic},
                        )
                        self.assertEqual(response.status_code, 200)
                        response = await client.get(
                            f"http://127.0.0.1:{port}/api/v1/dashboard",
                            headers={"Authorization":basic},
                        )
                        self.assertEqual(response.status_code, 200)
            # No HTTP process may survive after the stdio child has gone away.
            async with httpx.AsyncClient(timeout=0.5) as client:
                for i in range(20):
                    try:
                        await client.get(f"http://127.0.0.1:{port}/api/v1/health")
                    except httpx.RequestError:
                        break
                    await asyncio.sleep(0.1)
                else:
                    self.fail("Dashboard listener survived stdio client shutdown")


if __name__ == "__main__":
    unittest.main()
