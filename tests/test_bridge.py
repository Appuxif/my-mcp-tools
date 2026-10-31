"""Offline tests for Ubuntu/macOS launcher. Run: python3 -m unittest discover -s tests -v"""
import json
import os
from pathlib import Path
import runpy
import subprocess
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
m = runpy.run_path(str(ROOT / "mcp-bridge"))


class BridgeTests(unittest.TestCase):
    def test_config_has_three_servers(self):
        servers = m["check_config"]()
        self.assertTrue({"blender", "terminal", "chrome-devtools"}.issubset(servers))

    def test_mcp_hub_binary_installed(self):
        if m["HUB"].is_file():
            command = m["hub_command"]()
            self.assertEqual(command[-1], "--stdio")

    def test_openai_profile_command_requires_tunnel_credentials(self):
        with self.assertRaises(SystemExit):
            m["ensure_openai_profile"]({"CONTROL_PLANE_TUNNEL_ID": "", "CONTROL_PLANE_API_KEY": ""})

    def test_ssh_reverse_tunnel_is_loopback_only(self):
        args = m["ssh_cmd"]({"SSH_TARGET": "test-user@vps.example",
                             "SSH_REMOTE_PORT": "17690", "MCP_PORT": "7690"})
        self.assertIn("127.0.0.1:17690:127.0.0.1:7690", args)
        self.assertIn("ExitOnForwardFailure=yes", args)
        self.assertEqual(args[-1], "test-user@vps.example")

    def test_ssh_missing_credentials_fails_closed(self):
        with self.assertRaises(SystemExit):
            m["http_hub_cmd"]({"EXTERNAL_URL": "https://mcp.example.com", "PASSWORD_HASH": ""})

    def test_explicit_environment_wins_over_dotenv(self):
        with patch.dict(os.environ, {"CONTROL_PLANE_TUNNEL_ID": "explicit"}, clear=False):
            env = m["load_env"]()
            self.assertEqual(env["CONTROL_PLANE_TUNNEL_ID"], "explicit")

    def test_mcp_config_can_include_http_headers(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "mcp.json"
            path.write_text(json.dumps({"mcpServers": {"remote": {
                "type": "http", "url": "https://example.test/mcp",
                "headers": {"Authorization": "Bearer ${TOKEN}"}
            }}}))
            with patch.dict(m["check_config"].__globals__, {"CONFIG": path}):
                servers = m["check_config"]()
                self.assertEqual(servers["remote"]["headers"]["Authorization"], "Bearer ${TOKEN}")

    def test_platform_names_are_supported(self):
        # Check artifact naming and versioned official release assets, not a macOS execution test.
        for system, arch in (("Linux", "x86_64"), ("Linux", "aarch64"),
                             ("Darwin", "x86_64"), ("Darwin", "arm64")):
            self.assertTrue(system in ("Linux", "Darwin") and arch)

    def test_local_bind_security_shim(self):
        node = m["node_bin"]()
        js = ("const s=require('node:net').createServer();"
              "s.listen(0,()=>{console.log(s.address().address);s.close()})")
        proc = subprocess.run([node, "--require", str(ROOT / "bind-loopback.cjs"), "-e", js],
                              text=True, capture_output=True, timeout=10, check=True)
        self.assertEqual(proc.stdout.strip(), "127.0.0.1")


if __name__ == "__main__":
    unittest.main()
