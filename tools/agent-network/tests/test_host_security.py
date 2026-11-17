"""HTTP Host validation prevents same-origin DNS rebinding of loopback API."""
from __future__ import annotations

import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from fastapi.testclient import TestClient
from starlette.testclient import WebSocketDenialResponse

from agent_network.server import Config, create_app


class TrustedHostsTests(unittest.TestCase):
    def test_untrusted_host_cannot_register_or_enable_agents_or_open_websocket(self):
        with tempfile.TemporaryDirectory() as tmp:
            with patch.dict(os.environ, {"AGENT_NETWORK_TRUSTED_HOSTS": ""}):
                app = create_app(Config(database=str(Path(tmp) / "api.db")))
            with TestClient(app, base_url="http://127.0.0.1:8787") as client:
                hostile = {"Host": "evil.example",
                           "Origin": "http://evil.example"}
                endpoints = (
                    ("/api/v1/agents/register",
                     {"name": "hijacked", "role": "attacker"}),
                    ("/api/v1/dashboard-agent/enable",
                     {"name": "hijacked-dashboard"}),
                    ("/mcp", {"jsonrpc": "2.0", "id": 1,
                              "method": "tools/list", "params": {}}),
                )
                for path, body in endpoints:
                    with self.subTest(path=path):
                        response = client.post(path, headers=hostile, json=body)
                        self.assertEqual(response.status_code, 400)
                self.assertEqual(app.state.store.agents(), [])
                with self.assertRaises(WebSocketDenialResponse) as denied:
                    with client.websocket_connect("/api/v1/channels/ws",
                                                  headers=hostile):
                        pass
                self.assertEqual(denied.exception.status_code, 400)
                # New registrations are forbidden without the administrator token.
                denied_new = client.post("/api/v1/agents/register", headers={
                    "Host": "127.0.0.1:8787",
                    "Origin": "chrome-extension://example",
                }, json={"name": "normal", "role": "worker"})
                self.assertEqual(denied_new.status_code, 403)
                token = Path(app.state.admin_token_file).read_text().strip()
                ok = client.post("/api/v1/agents/register", headers={
                    "Host": "127.0.0.1:8787",
                    "Origin": "chrome-extension://example",
                    "X-Agent-Network-Admin-Token": token,
                }, json={"name": "normal", "role": "worker", "kind":"chatgpt"})
                self.assertEqual(ok.status_code, 200, ok.text)

    def test_explicit_private_proxy_hostname_and_no_wildcard(self):
        with tempfile.TemporaryDirectory() as tmp:
            with patch.dict(os.environ, {
                "AGENT_NETWORK_TRUSTED_HOSTS": "proxy.private.example",
            }):
                app = create_app(Config(database=str(Path(tmp) / "api.db")))
            with TestClient(app, base_url="http://127.0.0.1:8787") as client:
                # Trusted host is not sufficient to create an identity.
                created = client.post("/api/v1/agents/register", headers={
                    "Host": "proxy.private.example",
                }, json={"name": "proxy-worker", "role": "worker"})
                self.assertEqual(created.status_code, 403, created.text)
                # A previously provisioned agent can reconnect with its own credentials.
                provisioned=app.state.store.register(
                    "proxy-worker", "worker", "chatgpt")
                reconnected=client.post("/api/v1/agents/register", headers={
                    "Host": "proxy.private.example",
                }, json={"name": "proxy-worker", "role": "worker", "kind": "chatgpt",
                         "agent_id":provisioned["agent"]["agent_id"],
                         "token":provisioned["token"]})
                self.assertEqual(reconnected.status_code, 200, reconnected.text)
                self.assertFalse(reconnected.json()["created"])
                denied = client.post("/api/v1/agents/register", headers={
                    "Host": "evil.example",
                }, json={"name": "evil", "role": "worker"})
                self.assertEqual(denied.status_code, 400)
        with tempfile.TemporaryDirectory() as tmp:
            for value in ("*", "*.example.com", "https://proxy.private.example"):
                with self.subTest(value=value), patch.dict(os.environ, {
                    "AGENT_NETWORK_TRUSTED_HOSTS": value
                }), self.assertRaises(ValueError):
                    create_app(Config(database=str(Path(tmp) / "never.db")))


if __name__ == "__main__":
    unittest.main()
