"""Team membership is exclusively admin-managed; agent communication is scoped."""
from __future__ import annotations

import base64
import sqlite3
import tempfile
import unittest
from pathlib import Path

from fastapi.testclient import TestClient

from agent_network.server import Config, create_app
from agent_network.store import Store


class TeamStoreTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.db = Path(self.tmp.name) / "db.sqlite"
        self.store = Store(self.db)
        self.a = self.store.register("Alpha", "worker", "other")
        self.b = self.store.register("Beta", "worker", "other")
        self.c = self.store.register("Gamma", "worker", "other")
        self.aid = self.a["agent"]["agent_id"]
        self.bid = self.b["agent"]["agent_id"]
        self.cid = self.c["agent"]["agent_id"]

    def tearDown(self):
        self.store.close()
        self.tmp.cleanup()

    def test_defaults_and_admin_assignment_isolates_mcp_messages(self):
        self.assertEqual(self.a["agent"]["teams"][0]["name"], "default")
        self.store.assign_teams(self.aid, ["Forest Chopper"])
        self.store.assign_teams(self.bid, ["My MCP Tools"])
        self.store.assign_teams(self.cid, ["Forest Chopper", "My MCP Tools"])
        self.assertEqual({x["name"] for x in self.store.agents(requester_id=self.aid)},
                         {"Alpha", "Gamma"})
        self.assertEqual({x["name"] for x in self.store.agents(requester_id=self.bid)},
                         {"Beta", "Gamma"})
        self.assertEqual({t["name"] for t in self.store.agents(requester_id=self.aid)[1]["teams"]},
                         {"Forest Chopper"})
        with self.assertRaisesRegex(ValueError, "not found"):
            self.store.send(self.aid, self.a["token"], self.bid, "not allowed")
        with self.assertRaisesRegex(ValueError, "not found"):
            self.store.send(self.bid, self.b["token"], self.aid, "not allowed")
        self.assertFalse(self.store.db.execute("SELECT 1 FROM messages").fetchone())
        message = self.store.send(self.aid, self.a["token"], self.cid, "shared")
        inbox = self.store.inbox(self.cid, self.c["token"])
        self.assertEqual([m["message_id"] for m in inbox], [message["message_id"]])
        self.assertEqual(self.store.acknowledge(self.cid, self.c["token"], message["message_id"])["status"],
                         "acknowledged")
        message2 = self.store.send(self.cid, self.c["token"], self.bid, "bridge")
        self.assertEqual(self.store.inbox(self.bid, self.b["token"])[0]["message_id"], message2["message_id"])
        # Bridge does not forward visibility between disjoint teams.
        self.assertNotIn("Beta", {x["name"] for x in self.store.agents(requester_id=self.aid)})

    def test_agent_id_addressing_wins_over_colliding_agent_name(self):
        spoof = self.store.register(self.aid, "spoof", "other")
        spoof_id = spoof["agent"]["agent_id"]
        self.store.assign_teams(spoof_id, ["Other"])
        message = self.store.send(self.bid, self.b["token"], self.aid, "for Alpha")
        self.assertEqual(self.store.inbox(self.aid, self.a["token"])[0]["message_id"],
                         message["message_id"])
        self.assertEqual(self.store.inbox(spoof_id, spoof["token"]), [])

    def test_revocation_blocks_pending_ack_conversation_and_idempotent_resend(self):
        message = self.store.send(self.aid, self.a["token"], self.bid, "before revocation",
                                  client_message_id="key")
        self.assertEqual(len(self.store.inbox(self.bid, self.b["token"])), 1)
        self.store.assign_teams(self.bid, ["Other"])
        self.assertEqual(self.store.inbox(self.bid, self.b["token"]), [])
        self.assertEqual(self.store.agent_conversations(self.bid, self.b["token"])["items"], [])
        with self.assertRaisesRegex(ValueError, "Conversation not found"):
            self.store.agent_conversation_messages(self.bid, self.b["token"], self.aid)
        with self.assertRaises(ValueError):
            self.store.acknowledge(self.bid, self.b["token"], message["message_id"])
        with self.assertRaises(ValueError):
            self.store.send(self.aid, self.a["token"], self.bid, "before revocation",
                            client_message_id="key")
        self.store.assign_teams(self.bid, ["default"])
        self.assertEqual(len(self.store.inbox(self.bid, self.b["token"])), 1)

    def test_reconnect_profile_and_context_cannot_edit_membership(self):
        self.store.assign_teams(self.aid, ["Private Project"])
        auth = (self.aid, self.a["token"])
        reconnect = self.store.register("Alpha", "worker", "other", agent_id=auth[0],
                                        token=auth[1])
        self.assertEqual([t["name"] for t in reconnect["agent"]["teams"]], ["Private Project"])
        self.store.update_profile(*auth, role="new", purpose="other")
        self.store.save_context(*auth, context="some notes")
        self.assertEqual([t["name"] for t in self.store.agents(requester_id=self.aid)[0]["teams"]],
                         ["Private Project"])
        with self.assertRaises(TypeError):
            self.store.register("Alpha", "worker", "other", agent_id=auth[0],
                                token=auth[1], teams=["untrusted"])
        with self.assertRaises(TypeError):
            self.store.update_profile(*auth, role="new", teams=["untrusted"])

    def test_admin_name_normalization_replacement_and_restart(self):
        assigned = self.store.assign_teams(self.aid, ["  Test Team  ", "test team", "Another"])
        self.assertEqual({t["name"] for t in assigned["teams"]}, {"Test Team", "Another"})
        self.assertEqual(len(assigned["teams"]), 2)
        self.store.assign_teams(self.bid, ["Тестовая Команда"])
        team_id = self.store._teams(self.bid)[0]["team_id"]
        self.store.assign_teams(self.cid, ["тестовая команда"])
        self.assertEqual(self.store._teams(self.cid)[0]["team_id"], team_id)
        for bad in ([], ["  "], [42], ["x"]*13, ["x"*65], ["bad\nline"]):
            with self.subTest(bad=bad), self.assertRaises(ValueError):
                self.store.assign_teams(self.aid, bad)
        self.assertEqual(len(self.store.agents(requester_id=self.aid)[0]["teams"]), 2)
        self.store.close()
        self.store = Store(self.db)
        self.assertEqual({t["name"] for t in self.store.agents(requester_id=self.aid)[0]["teams"]},
                         {"Test Team", "Another"})
        self.assertEqual({t["name"] for t in self.store.agents(requester_id=self.bid)[0]["teams"]},
                         {"Тестовая Команда"})

    def test_legacy_migration_once_and_stable_team_ids(self):
        self.store.close()
        # Simulate older DB by dropping newly introduced team tables.
        db = sqlite3.connect(self.db)
        db.execute("PRAGMA foreign_keys=ON")
        db.execute("DROP TABLE agent_teams")
        db.execute("DROP TABLE teams")
        db.execute("DROP TABLE migrations")
        db.commit()
        db.close()
        self.store = Store(self.db)
        self.assertEqual({a["name"] for a in self.store.agents(requester_id=self.aid)},
                         {"Alpha", "Beta", "Gamma"})
        default_id = self.store._teams(self.aid)[0]["team_id"]
        self.store.assign_teams(self.aid, ["Private"])
        self.store.close()
        self.store = Store(self.db)
        self.assertEqual(self.store._teams(self.aid)[0]["name"], "Private")
        self.assertEqual(self.store._teams(self.bid)[0]["team_id"], default_id)
        self.assertEqual({a["name"] for a in self.store.agents(requester_id=self.aid)},
                         {"Alpha"})
        # Recover from an interrupted migration with a table but no marker.
        self.store.close()
        db=sqlite3.connect(self.db)
        db.execute("DELETE FROM migrations WHERE name='agent_teams_v1'")
        db.commit()
        db.close()
        self.store=Store(self.db)
        self.assertEqual([t["name"] for t in self.store._teams(self.aid)], ["Private"])


class TeamHttpSecurityTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.app = create_app(Config(database=str(Path(self.tmp.name)/"api.sqlite")))
        self.client = TestClient(self.app, base_url="http://127.0.0.1:8787")
        self.client.__enter__()
        self.a = self.app.state.store.register("Alpha", "worker", "other")
        self.b = self.app.state.store.register("Beta", "worker", "other")
        self.aid = self.a["agent"]["agent_id"]
        secret = Path(self.app.state.admin_token_file).read_text().strip()
        self.admin_secret = secret
        basic = base64.b64encode(("admin:"+secret).encode()).decode()
        self.admin = {"Authorization":"Basic "+basic}
        self.ext = {"X-Agent-Network-Admin-Token":secret,
                    "Origin":"chrome-extension://testextension"}
        self.agent = {"X-Agent-Id":self.aid, "X-Agent-Token":self.a["token"]}

    def tearDown(self):
        self.client.__exit__(None,None,None)
        self.tmp.cleanup()

    def test_dashboard_admin_only_and_cross_origin_protection(self):
        path = f"/api/v1/dashboard/agents/{self.aid}/teams"
        self.assertEqual(self.client.put(path,json={"teams":["Ops"]}).status_code,401)
        self.assertEqual(self.client.put(path,json={"teams":["Ops"]},
                                         headers={"X-Agent-Id":self.aid,"X-Agent-Token":self.a["token"]}).status_code,401)
        self.assertEqual(self.client.put(path,json={"teams":["Ops"]},headers={
            **self.admin,"Origin":"https://evil.example"
        }).status_code,403)
        self.assertEqual(self.client.put(path,json={"teams":["Ops"]},headers=self.admin).status_code,200)
        self.assertEqual(self.client.get("/api/v1/dashboard/teams").status_code,401)
        self.assertIn("Ops", {t["name"] for t in self.client.get(
            "/api/v1/dashboard/teams",headers=self.admin).json()["items"]})

    def test_extension_requires_admin_and_own_agent_identity(self):
        url = "/api/v1/admin/me/teams"
        self.assertEqual(self.client.get("/api/v1/admin/teams").status_code,403)
        self.assertEqual(self.client.get("/api/v1/admin/teams",headers=self.ext).status_code,200)
        self.assertEqual(self.client.put(url,json={"teams":["Dev"]},
                                         headers=self.agent).status_code,403)
        self.assertEqual(self.client.put(url,json={"teams":["Dev"]},
                                         headers={**self.ext,**self.agent}).status_code,200)
        self.assertEqual(self.client.put(url,json={"teams":["Not Allowed"]},
                                         headers={**self.ext,**self.agent,"Origin":"https://evil.example"}).status_code,403)
        self.assertEqual(self.client.put(url,json={"teams":["Wrong Token"]},
                                         headers={**self.ext,**self.agent,"X-Agent-Token":self.b["token"]}).status_code,403)
        self.assertEqual(self.client.put(url,json={"teams":["Wrong Admin"]},
                                         headers={**self.agent,"X-Agent-Network-Admin-Token":"wrong"}).status_code,403)
        self.assertEqual([t["name"] for t in self.app.state.store._teams(self.aid)], ["Dev"])
        self.assertEqual([t["name"] for t in self.app.state.store._teams(self.b["agent"]["agent_id"])],["default"])

    def test_mcp_no_teams_parameter_and_scoped_list(self):
        self.app.state.store.assign_teams(self.aid, ["Ops"])
        headers={"Accept":"application/json, text/event-stream","Content-Type":"application/json"}
        c = self.client
        def rpc(name,args,seq):
            raw=c.post("/mcp",json={
                "jsonrpc":"2.0","method":"tools/call","id":seq,
                "params":{"name":name,"arguments":args}
            },headers=headers).json()["result"]
            if raw.get("isError"):
                return raw
            return raw.get("structuredContent") or raw
        tools=c.post("/mcp",json={"jsonrpc":"2.0","method":"tools/list",
                                 "id":1,"params":{}},headers=headers).json()["result"]["tools"]
        register=next(t for t in tools if t["name"]=="register_agent")
        self.assertNotIn("teams",register["inputSchema"]["properties"])
        scoped=rpc("list_agents",{"agent_id":self.aid,"token":self.a["token"]},2)
        items=scoped.get("result",scoped)
        self.assertEqual([a["name"] for a in items], ["Alpha"])
        # The MCP framework may ignore extra input fields, but they must
        # never change memberships, even if injected by a client.
        registered=rpc("register_agent",{"name":"Gamma","role":"Worker",
                                        "teams":["Ops"]},3)
        self.assertFalse(registered.get("isError",False))
        row=self.app.state.store.db.execute(
            "SELECT agent_id FROM agents WHERE name='Gamma'"
        ).fetchone()
        self.assertIsNotNone(row)
        self.assertEqual(
            [t["name"] for t in self.app.state.store._teams(row["agent_id"])],
            ["default"]
        )


if __name__=="__main__":
    unittest.main()
