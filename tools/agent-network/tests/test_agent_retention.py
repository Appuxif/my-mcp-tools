"""Identity retention, deletion, token invalidation, and safe cascade behavior."""
from __future__ import annotations

import tempfile
import time
import unittest
from pathlib import Path

from fastapi.testclient import TestClient

from agent_network.server import Config, create_app
from agent_network.store import MESSAGE_TTL_SECONDS, Store
from auth_helpers import basic_headers


class AgentRetentionTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.db = Path(self.temp.name) / "retention.db"
        self.store = Store(self.db)
        self.a = self.store.register("old-agent", "old task", "other")
        self.b = self.store.register("live-agent", "operator", "other")

    def tearDown(self):
        self.store.close()
        self.temp.cleanup()

    def age(self, record, *, hours=25):
        agent_id = record["agent"]["agent_id"]
        old = time.time() - hours * 3600
        with self.store.lock, self.store.db:
            self.store.db.execute(
                "UPDATE agents SET created_at=?,updated_at=?,last_mcp_activity=?,"
                "last_poll_at=?,last_channel_activity=?,last_dashboard_seen=? "
                "WHERE agent_id=?",
                (old,old,old,old,old,old,agent_id),
            )

    def test_inactive_agent_keeps_name_and_identity_until_manual_deletion(self):
        a, b = self.a, self.b
        aid, bid = a["agent"]["agent_id"], b["agent"]["agent_id"]
        incoming = self.store.send(bid, b["token"], "old-agent", "pending")
        outgoing = self.store.send(aid, a["token"], "live-agent", "outgoing")
        self.store.record_tool_call("send_message", "ok", 1.2, aid)
        self.age(a)
        with self.store.lock, self.store.db:
            self.store.db.execute(
                "UPDATE messages SET created_at=? WHERE message_id IN (?,?)",
                (time.time() - MESSAGE_TTL_SECONDS - 5,
                 incoming["message_id"], outgoing["message_id"]),
            )
        self.assertEqual(self.store.prune_messages()["expired_messages"], 2)
        self.assertEqual(len(self.store.agents()), 2)
        self.store.verify(aid, a["token"])
        with self.assertRaisesRegex(ValueError, "already registered"):
            self.store.register("old-agent", "other", "other")
        removed = self.store.delete_agent(aid)
        self.assertEqual(removed["name"], "old-agent")
        self.assertFalse(removed["deleted_context"])
        self.assertEqual(self.store.tool_history()["items"][0]["agent_id"], None)
        with self.assertRaises(ValueError):
            self.store.verify(aid, a["token"])
        fresh = self.store.register("old-agent", "new role", "other")
        self.assertNotEqual(fresh["agent"]["agent_id"], aid)

    def test_activity_or_channel_state_does_not_affect_identity_lifetime(self):
        self.age(self.a)
        aid = self.a["agent"]["agent_id"]
        self.store.connect_channel(aid, self.a["token"],
                                   "chatgpt", "socket", "idle")
        self.store.disconnect_channel("socket")
        self.store.prune_channels(at=time.time() + MESSAGE_TTL_SECONDS + 1)
        self.assertEqual({x["name"] for x in self.store.agents()},
                         {"old-agent", "live-agent"})
        self.store.verify(aid, self.a["token"])

    def test_manual_deletion_cascades_including_self_messages(self):
        a,b=self.a,self.b
        aid,bid=a["agent"]["agent_id"],b["agent"]["agent_id"]
        for target in ("live-agent", "old-agent"):
            self.store.send(aid,a["token"],target,"delete target's message")
        self.store.send(bid,b["token"],"old-agent","incoming")
        self.store.connect_channel(aid,a["token"],"codex","active","busy")
        result=self.store.delete_agent(aid)
        self.assertEqual(result["deleted_messages"],3)
        self.assertEqual(result["deleted_channels"],1)
        self.assertEqual(self.store.inbox(bid,b["token"]),[])
        self.assertEqual(self.store.agents()[0]["name"],"live-agent")
        recreated=self.store.register("old-agent","same name allowed","other")
        self.assertNotEqual(recreated["agent"]["agent_id"],aid)


class AgentDeletionHttpTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.app = create_app(Config(database=str(Path(self.tmp.name)/"app.db"),
                                     wake_scan_seconds=.01, maintenance_seconds=.02))
        self.client_context = TestClient(self.app, base_url="http://127.0.0.1:8787")
        self.client = self.client_context.__enter__()
        self.admin_headers = basic_headers(self.app)
        self.client.headers.update(self.admin_headers)

    def tearDown(self):
        self.client_context.__exit__(None, None, None)
        self.tmp.cleanup()

    def test_delete_without_dashboard_agent_frees_name(self):
        agent = self.client.post("/api/v1/dashboard/agents", json={
            "name": "stale-target", "role": "frontend", "kind": "chatgpt", "teams": ["default"],
        }).json()
        aid = agent["agent"]["agent_id"]
        self.app.state.store.save_context(aid, agent["token"], "private checkpoint")
        url = "/api/v1/dashboard/agents/" + aid

        # Deletion is independent from the Dashboard Agent toggle/identity.
        self.assertEqual(self.client.delete(url, headers={"Authorization":""}).status_code, 401)
        self.assertEqual(self.client.delete(
            url, headers={"Origin": "https://evil.site", **self.admin_headers}
        ).status_code, 403)
        self.assertEqual(self.client.delete(
            url, headers={"Sec-Fetch-Site": "cross-site", **self.admin_headers}
        ).status_code, 403)
        self.assertEqual(self.client.delete(
            url, headers={"Host": "remote.example", **self.admin_headers}
        ).status_code, 400)

        self.assertEqual(self.client.delete(
            url, headers={"Authorization":"Basic invalid"}
        ).status_code,401)
        response = self.client.delete(url, headers=self.admin_headers)
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json()["name"], "stale-target")
        self.assertTrue(response.json()["deleted_context"])
        self.assertFalse(self.app.state.store.db.execute(
            "SELECT 1 FROM agent_contexts WHERE agent_id=?", (aid,)
        ).fetchone())
        self.assertEqual(self.client.delete(url, headers=self.admin_headers).status_code, 404)
        replacement = self.client.post("/api/v1/dashboard/agents", json={
            "name": "stale-target", "role": "another", "kind": "other", "teams": ["default"],
        }).json()
        self.assertNotEqual(replacement["agent"]["agent_id"], aid)

    def test_self_delete_invalidates_dashboard_identity(self):
        d=self.client.post("/api/v1/dashboard-agent/enable",
                           json={"name":"dashboard-self"}).json()
        did=d["agent"]["agent_id"]
        auth={"X-Agent-Id":did,"X-Agent-Token":d["token"]}
        response=self.client.delete("/api/v1/dashboard/agents/"+did,
                                    headers=self.admin_headers)
        self.assertEqual(response.status_code,200)
        self.assertEqual(response.json()["name"], "dashboard-self")
        self.assertEqual(self.client.get("/api/v1/dashboard-agent/inbox",headers=auth).status_code,403)
        replacement=self.client.post("/api/v1/dashboard-agent/enable",
                                     json={"name":"dashboard-self"})
        self.assertEqual(replacement.status_code,200)
        self.assertNotEqual(replacement.json()["agent"]["agent_id"],did)

    def test_startup_and_periodic_cleanup_preserves_inactive_agents(self):
        store = self.app.state.store
        old = store.register("startup-abandoned", "tester", "other")
        aid = old["agent"]["agent_id"]
        expired_at = time.time() - MESSAGE_TTL_SECONDS - 5
        with store.lock, store.db:
            store.db.execute(
                "UPDATE agents SET created_at=?,updated_at=?,last_mcp_activity=? "
                "WHERE agent_id=?", (expired_at, expired_at, expired_at, aid)
            )
        self.app.state.broker.run_maintenance()
        time.sleep(.1)  # Let the periodic maintenance sweep run too.
        self.assertIn(aid, {a["agent_id"] for a in store.agents()})
        self.assertEqual(self.client.post("/api/v1/dashboard/agents", json={
            "name": "startup-abandoned", "role": "new owner", "kind": "other", "teams": ["default"]
        }).status_code, 409)
        self.assertEqual(self.client.delete(
            "/api/v1/dashboard/agents/" + aid, headers=self.admin_headers
        ).status_code, 200)
        self.assertEqual(self.client.post("/api/v1/dashboard/agents", json={
            "name": "startup-abandoned", "role": "new owner", "kind": "other", "teams": ["default"]
        }).status_code, 200)

    def test_delete_active_websocket_disconnects(self):
        operator=self.client.post("/api/v1/dashboard-agent/enable",
                                  json={"name":"dashboard-user"}).json()
        target=self.client.post("/api/v1/dashboard/agents",json={
            "name":"ws-agent","role":"test","kind":"chatgpt", "teams": ["default"],
        }).json()
        with self.client.websocket_connect("/api/v1/channels/ws", headers={"Host":"127.0.0.1:8787"}) as ws:
            ws.send_json({"type":"register","kind":"chatgpt", "teams": ["default"],"state":"idle",
                          "agent_id":target["agent"]["agent_id"],
                          "token":target["token"]})
            self.assertEqual(ws.receive_json()["type"],"registered")
            result=self.client.delete("/api/v1/dashboard/agents/"+
                                      target["agent"]["agent_id"],
                                      headers=self.admin_headers)
            self.assertEqual(result.status_code,200)
            self.assertEqual(self.app.state.broker.connections,{})
            with self.app.state.store.lock:
                self.assertEqual(
                    self.app.state.store.db.execute(
                        "SELECT count(*) FROM channels WHERE agent_id=?",
                        (target["agent"]["agent_id"],)
                    ).fetchone()[0],0
                )


if __name__ == "__main__":
    unittest.main()
