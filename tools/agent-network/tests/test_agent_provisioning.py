"""Agent creation is privileged and never exposed as an MCP capability."""
from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from fastapi.testclient import TestClient

from agent_network.server import Config, create_app
from auth_helpers import basic_headers


class AgentProvisioningTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.app = create_app(Config(database=str(Path(self.temp.name) / "auth.db")))
        self.cm = TestClient(self.app, base_url="http://127.0.0.1:8787")
        self.client = self.cm.__enter__()
        self.basic = basic_headers(self.app)
        self.secret = Path(self.app.state.admin_token_file).read_text().strip()
        self.ext = {
            "Origin": "chrome-extension://unit-test-extension",
            "X-Agent-Network-Admin-Token": self.secret,
        }
        self.url = "/api/v1/dashboard/agents"

    def tearDown(self):
        self.cm.__exit__(None, None, None)
        self.temp.cleanup()

    def data(self, **changes):
        result = {
            "name": "Admin-Created", "role": "Software Developer", "kind": "codex",
            "purpose": "Develop Python", "description": "Admin issued identity",
            "teams": ["Codex", "My MCP Tools"],
        }
        result.update(changes)
        return result

    def test_admin_provisions_agent_in_selected_teams_atomically(self):
        denied = self.client.post(self.url, json=self.data())
        self.assertEqual(denied.status_code, 401)
        result = self.client.post(self.url, json=self.data(), headers=self.basic)
        self.assertEqual(result.status_code, 200, result.text)
        self.assertIn("no-store", result.headers["Cache-Control"])
        data = result.json()
        self.assertTrue(data["created"])
        self.assertEqual(data["agent"]["kind"], "codex")
        self.assertEqual(data["agent"]["role"], "Software Developer")
        self.assertEqual(data["agent"]["purpose"], "Develop Python")
        self.assertEqual({t["name"] for t in data["agent"]["teams"]},
                         {"Codex", "My MCP Tools"})
        self.assertNotIn("default", {t["name"] for t in data["agent"]["teams"]})
        self.assertNotIn("token_hash", result.text)
        self.assertGreater(len(data["token"]), 35)
        self.app.state.store.verify(data["agent"]["agent_id"], data["token"])
        snapshot = self.client.get("/api/v1/dashboard", headers=self.basic)
        self.assertNotIn(data["token"], snapshot.text)
        self.assertNotIn(data["token"], str(self.app.state.store.tool_history()))
        self.assertEqual(self.client.post(
            self.url, json=self.data(), headers=self.basic
        ).status_code, 409)
        self.assertEqual(len(self.app.state.store.agents()), 1)

    def test_admin_auth_and_origin_and_invalid_profiles(self):
        for headers,code in (
            ({},401), ({"X-Agent-Token":"any"},401),
            ({"Authorization":"Bearer fake"},401),
            ({**self.basic,"Origin":"https://evil.test"},403),
            ({**self.basic,"Sec-Fetch-Site":"cross-site"},403),
            ({**self.basic,"Host":"evil.example"},400),
        ):
            with self.subTest(headers=str(headers.keys())):
                self.assertEqual(self.client.post(
                    self.url, json=self.data(), headers=headers
                ).status_code,code)
        for kwargs in (
            {"kind":"dashboard"}, {"name":"invalid space"},
            {"teams":[]}, {"teams":["a"]*13},
            {"teams":["bad\nname"]}, {"role":""},
        ):
            with self.subTest(kwargs=kwargs):
                self.assertGreaterEqual(
                    self.client.post(self.url, json=self.data(**kwargs),
                                     headers=self.basic).status_code,400
                )
        self.assertEqual(len(self.app.state.store.agents()),0)

    def test_public_registration_requires_admin_token_only_for_creation(self):
        path="/api/v1/agents/register"
        payload={"name":"Ext-Created","role":"Developer","kind":"chatgpt"}
        denied=self.client.post(path,json=payload)
        self.assertEqual(denied.status_code,403)
        self.assertEqual(self.client.post(path,json=payload,headers={
            "X-Agent-Network-Admin-Token":"wrong",
            "Origin":"chrome-extension://unit-test-extension",
        }).status_code,403)
        self.assertEqual(self.client.post(path,json=payload,headers={
            "X-Agent-Network-Admin-Token":self.secret,
            "Origin":"https://evil.example",
        }).status_code,403)
        self.assertEqual(self.client.post(path,json={**payload,"kind":"codex"},
            headers=self.ext).status_code,400)
        self.assertEqual(len(self.app.state.store.agents()),0)

        response=self.client.post(path,json=payload,headers=self.ext)
        self.assertEqual(response.status_code,200,response.text)
        created=response.json()
        self.assertTrue(created["created"])
        self.assertEqual([t["name"] for t in created["agent"]["teams"]],["default"])
        self.assertEqual(self.client.post(
            path,json={**payload,"name":"Attempt-Second-Creation",
                       "agent_id":created["agent"]["agent_id"],
                       "token":created["token"]}).status_code,409)
        # Agent reconnect is not admin: existing ID/token are sufficient.
        reconnect=self.client.post(path,json={
            **payload,
            "agent_id":created["agent"]["agent_id"],"token":created["token"],
            "teams":["Unauthorized-Team"],  # extra fields must not be used
        })
        self.assertEqual(reconnect.status_code,200,reconnect.text)
        self.assertFalse(reconnect.json()["created"])
        self.assertEqual([t["name"] for t in self.app.state.store._teams(
            created["agent"]["agent_id"])],["default"])
        self.assertEqual(self.client.post(path,json={
            **payload,"agent_id":created["agent"]["agent_id"],"token":"wrong"
        }).status_code,403)
        self.assertEqual(len(self.app.state.store.agents()),1)

    def test_normal_mcp_exposes_fourteen_tools_and_rejects_registration(self):
        headers={"Accept":"application/json, text/event-stream",
                 "Content-Type":"application/json"}
        tools=self.client.post("/mcp",json={
            "jsonrpc":"2.0","id":1,"method":"tools/list","params":{},
        },headers=headers)
        self.assertEqual(tools.status_code,200,tools.text)
        names={t["name"] for t in tools.json()["result"]["tools"]}
        self.assertEqual(names,{
            "list_agents","send_message","get_messages","ack_message",
            "update_task","heartbeat","save_context","read_context",
            "create_note","add_to_note","update_subnote",
            "remove_from_note","finalize_note","read_note",
        })
        denied=self.client.post("/mcp",json={
            "jsonrpc":"2.0","id":2,"method":"tools/call",
            "params":{"name":"register_agent","arguments":{
                "name":"Rogue","role":"Invented","kind":"codex"}},
        },headers=headers)
        self.assertEqual(denied.status_code,200,denied.text)
        self.assertTrue(denied.json()["result"]["isError"])
        self.assertEqual(len(self.app.state.store.agents()),0)


if __name__=="__main__":
    unittest.main()
