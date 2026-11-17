"""Identity retention, deletion, token invalidation, and safe cascade behavior."""
from __future__ import annotations

import tempfile
import time
import unittest
from pathlib import Path

from fastapi.testclient import TestClient

from agent_network.server import Config, create_app
from agent_network.store import MESSAGE_TTL_SECONDS, Store


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

    def test_expired_agent_deleted_name_released_and_messages_removed(self):
        a, b = self.a, self.b
        aid = a["agent"]["agent_id"]
        bid = b["agent"]["agent_id"]
        incoming = self.store.send(bid, b["token"], "old-agent", "pending to abandoned agent")
        outgoing = self.store.send(aid, a["token"], "live-agent", "sent by old agent")
        self.store.record_tool_call("send_message", "ok", 1.2, aid)
        self.age(a)
        # Both messages have already reached their own 24-hour retention TTL.
        with self.store.lock, self.store.db:
            self.store.db.execute(
                "UPDATE messages SET created_at=? WHERE message_id IN (?,?)",
                (time.time() - MESSAGE_TTL_SECONDS - 5,
                 incoming["message_id"], outgoing["message_id"]),
            )
        removed = self.store.prune_agents()
        self.assertEqual([x["name"] for x in removed], ["old-agent"])
        self.assertEqual(removed[0]["deleted_messages"], 2)
        self.assertFalse(self.store.db.execute("SELECT 1 FROM messages WHERE message_id IN (?,?)",
                                               (incoming["message_id"],outgoing["message_id"])).fetchone())
        self.assertEqual(self.store.tool_history()["items"][0]["agent_id"], None)
        with self.assertRaises(ValueError):
            self.store.verify(aid, a["token"])
        fresh = self.store.register("old-agent","new role","other")
        self.assertNotEqual(fresh["agent"]["agent_id"], aid)
        self.assertNotEqual(fresh["token"], a["token"])
        self.assertEqual(len(self.store.agents()), 2)

    def test_recent_mcp_or_channel_or_dashboard_activity_prevents_pruning(self):
        self.age(self.a)
        self.store.touch_mcp(self.a["agent"]["agent_id"], self.a["token"])
        self.assertEqual(self.store.prune_agents(), [])
        self.age(self.a)
        self.store.connect_channel(self.a["agent"]["agent_id"], self.a["token"],
                                   "chatgpt", "socket", "idle")
        self.age(self.a)
        self.assertEqual(self.store.prune_agents(), [])  # live socket
        self.store.disconnect_channel("socket")
        self.assertEqual(len(self.store.prune_agents()), 1)

    def test_scheduler_exclusion_and_boundary_24_hours(self):
        self.age(self.a)
        aid = self.a["agent"]["agent_id"]
        self.assertEqual(self.store.prune_agents(exclude_ids={aid}), [])
        self.age(self.a, hours=23)
        self.assertEqual(self.store.prune_agents(), [])
        self.age(self.a, hours=25)
        self.assertEqual([x["agent_id"] for x in self.store.prune_agents()], [aid])

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
        self.admin_token = Path(self.app.state.admin_token_file).read_text().strip()
        self.admin_headers = {"X-Admin-Token": self.admin_token}

    def tearDown(self):
        self.client_context.__exit__(None, None, None)
        self.tmp.cleanup()

    def test_delete_without_dashboard_agent_frees_name(self):
        agent = self.client.post("/api/v1/agents/register", json={
            "name": "stale-target", "role": "frontend", "kind": "chatgpt",
        }).json()
        aid = agent["agent"]["agent_id"]
        url = "/api/v1/dashboard/agents/" + aid

        # Deletion is independent from the Dashboard Agent toggle/identity.
        self.assertEqual(self.client.delete(url).status_code, 401)
        self.assertEqual(self.client.delete(
            url, headers={"Origin": "https://evil.site", **self.admin_headers}
        ).status_code, 403)
        self.assertEqual(self.client.delete(
            url, headers={"Sec-Fetch-Site": "cross-site", **self.admin_headers}
        ).status_code, 403)
        self.assertEqual(self.client.delete(
            url, headers={"Host": "remote.example", **self.admin_headers}
        ).status_code, 403)

        self.assertEqual(self.client.delete(
            url, headers={"X-Admin-Token":"invalid"}
        ).status_code,401)
        response = self.client.delete(url, headers=self.admin_headers)
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json()["name"], "stale-target")
        self.assertEqual(self.client.delete(url, headers=self.admin_headers).status_code, 404)
        replacement = self.client.post("/api/v1/agents/register", json={
            "name": "stale-target", "role": "another", "kind": "other",
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

    def test_startup_and_periodic_cleanup_releases_abandoned_names(self):
        store = self.app.state.store
        old = store.register("startup-abandoned", "tester", "other")
        expired_at = time.time() - MESSAGE_TTL_SECONDS - 5
        with store.lock, store.db:
            store.db.execute(
                "UPDATE agents SET created_at=?,updated_at=?,last_mcp_activity=? "
                "WHERE agent_id=?",
                (expired_at, expired_at, expired_at, old["agent"]["agent_id"])
            )
        # Already started TestClient: periodic maintenance should remove it.
        for _ in range(60):
            if not any(a["name"]=="startup-abandoned" for a in store.agents()):
                break
            time.sleep(.01)
        else:
            self.fail("Periodic agent cleanup did not run")
        self.assertEqual(self.client.post("/api/v1/agents/register", json={
            "name":"startup-abandoned","role":"new owner","kind":"other"
        }).status_code, 200)

    def test_delete_active_websocket_disconnects(self):
        operator=self.client.post("/api/v1/dashboard-agent/enable",
                                  json={"name":"dashboard-user"}).json()
        target=self.client.post("/api/v1/agents/register",json={
            "name":"ws-agent","role":"test","kind":"chatgpt",
        }).json()
        with self.client.websocket_connect("/api/v1/channels/ws") as ws:
            ws.send_json({"type":"register","kind":"chatgpt","state":"idle",
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
