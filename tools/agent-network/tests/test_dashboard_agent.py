from __future__ import annotations

import json
import tempfile
import time
import unittest
from pathlib import Path

from fastapi.testclient import TestClient

from agent_network.server import Config, create_app
from agent_network.store import MESSAGE_TTL_SECONDS, Store
from auth_helpers import basic_headers


class BoundedHistoryTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.store = Store(Path(self.temp.name) / "bounded.db")
        self.a = self.store.register("auditor", "test sender", "other")
        self.b = self.store.register("receiver", "test receiver", "other")

    def tearDown(self):
        self.store.close()
        self.temp.cleanup()

    def test_tool_log_is_bounded_and_paginated(self):
        for n in range(125):
            self.store.record_tool_call("send_message", "ok" if n % 5 else "error", n / 7, self.a["agent"]["agent_id"])
        with self.store.lock:
            count = self.store.db.execute("SELECT count(*) FROM tool_calls").fetchone()[0]
        self.assertEqual(count, 100)
        first = self.store.tool_history(page=1)
        self.assertEqual(first["total"], 100)
        self.assertEqual(first["pages"], 10)
        self.assertEqual(len(first["items"]), 10)
        self.assertEqual(first["items"][0]["status"], "ok")
        self.assertEqual(len(self.store.tool_history(page=10)["items"]), 10)
        self.assertGreater(first["avg_ms"], 0)
        self.assertNotIn("token", json.dumps(first))
        with self.assertRaises(ValueError):
            self.store.tool_history(page=11)

    def test_ttl_all_statuses_and_no_count_limit(self):
        aid, at = self.a["agent"]["agent_id"], self.a["token"]
        bid, bt = self.b["agent"]["agent_id"], self.b["token"]
        delivered = []
        for n in range(111):
            mid = self.store.send(aid, at, "receiver", "delivered " + str(n))["message_id"]
            self.store.acknowledge(bid, bt, mid)
            delivered.append(mid)
        pending = [
            self.store.send(aid, at, "receiver", "unread " + str(n))["message_id"]
            for n in range(3)
        ]
        with self.store.lock:
            counts = self.store.db.execute(
                "SELECT status,count(*) FROM messages GROUP BY status"
            ).fetchall()
        self.assertEqual({r[0]:r[1] for r in counts},
                         {"acknowledged":111, "pending":3})
        self.assertEqual(len(self.store.inbox(bid, bt)),3)
        history = self.store.message_history(page=12)
        self.assertEqual(history["total"],114)
        self.assertEqual(history["pages"],12)
        self.assertEqual(len(history["items"]),4)
        self.assertEqual(self.store.prune_messages(),{"expired_messages":0})
        # Creation time, NOT status or ACK timestamp, determines expiration.
        expired = time.time() - MESSAGE_TTL_SECONDS - 3
        with self.store.lock, self.store.db:
            self.store.db.execute(
                "UPDATE messages SET created_at=? WHERE message_id IN (?,?)",
                (expired, delivered[0], pending[0])
            )
        # Even before maintenance queries must hide expired items.
        self.assertEqual(len(self.store.inbox(bid, bt)),2)
        self.assertEqual(self.store.message_history(page=1)["total"],112)
        snapshot = self.store.dashboard_snapshot()
        self.assertEqual(snapshot["metrics"]["pending_messages"],2)
        self.assertEqual(snapshot["metrics"]["messages_total"],112)
        self.assertEqual(self.store.prune_messages(),{"expired_messages":2})
        self.assertEqual(self.store.prune_messages(),{"expired_messages":0})
        self.assertEqual(len(self.store.message_history(page=12)["items"]), 2)
        with self.store.lock:
            self.assertEqual(
                self.store.db.execute("SELECT count(*) FROM messages").fetchone()[0],112
            )

    def test_expired_message_cannot_be_acked_and_dedup_key_reusable(self):
        aid, at = self.a["agent"]["agent_id"], self.a["token"]
        bid, bt = self.b["agent"]["agent_id"], self.b["token"]
        msg = self.store.send(aid, at, "receiver", "original",
                              client_message_id="retry-key")
        with self.store.lock, self.store.db:
            self.store.db.execute(
                "UPDATE messages SET created_at=? WHERE message_id=?",
                (time.time()-MESSAGE_TTL_SECONDS-10, msg["message_id"])
            )
        self.assertEqual(self.store.inbox(bid,bt),[])
        with self.assertRaises(ValueError):
            self.store.acknowledge(bid,bt,msg["message_id"])
        self.assertEqual(self.store.candidates(0,0),[])
        new = self.store.send(aid,at,"receiver","fresh",
                              client_message_id="retry-key")
        self.assertNotEqual(new["message_id"],msg["message_id"])
        self.assertFalse(new["duplicate"])

    def test_periodic_cleanup_without_new_messages(self):
        with tempfile.TemporaryDirectory() as tmp:
            app = create_app(Config(
                database=str(Path(tmp)/"periodic.db"),
                maintenance_seconds=0.025, wake_scan_seconds=0.01,
            ))
            store = app.state.store
            a = store.register("periodic-source","test","other")
            b = store.register("periodic-target","test","other")
            mid = store.send(a["agent"]["agent_id"],a["token"],
                             "periodic-target","expired")["message_id"]
            with store.lock,store.db:
                store.db.execute("UPDATE messages SET created_at=? WHERE message_id=?",
                                 (time.time()-MESSAGE_TTL_SECONDS-10,mid))
            # Start-up cleanup happens as soon as the server enters its lifespan.
            with TestClient(app,base_url="http://127.0.0.1:8787"):
                with store.lock:
                    self.assertEqual(
                        store.db.execute("SELECT count(*) FROM messages").fetchone()[0],0
                    )
                mid = store.send(a["agent"]["agent_id"],a["token"],
                                 "periodic-target","will expire")["message_id"]
                with store.lock,store.db:
                    store.db.execute("UPDATE messages SET created_at=? WHERE message_id=?",
                                     (time.time()-MESSAGE_TTL_SECONDS-10,mid))
                for attempt in range(40):
                    with store.lock:
                        remaining = store.db.execute(
                            "SELECT count(*) FROM messages WHERE message_id=?",(mid,)
                        ).fetchone()[0]
                    if remaining == 0:
                        break
                    time.sleep(0.01)
                self.assertEqual(remaining,0, "Periodic sweep failed to remove expired message")


class DashboardAgentHttpTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.app = create_app(Config(database=str(Path(self.temp.name)/"dash.db")))
        self.cm = TestClient(self.app, base_url="http://127.0.0.1:8787")
        self.client = self.cm.__enter__()
        self.client.headers.update(basic_headers(self.app))

    def tearDown(self):
        self.cm.__exit__(None, None, None)
        self.temp.cleanup()

    def test_opt_in_messaging_and_reconnect(self):
        c = self.client
        d = c.post("/api/v1/dashboard-agent/enable", json={"name":"dashboard-qa"})
        self.assertEqual(d.status_code, 200, d.text)
        identity = d.json()
        dash_id = identity["agent"]["agent_id"]
        self.assertEqual(identity["agent"]["kind"], "dashboard")
        self.assertTrue(identity["agent"]["online"])
        auth = {"X-Agent-Id":dash_id, "X-Agent-Token":identity["token"]}
        other = c.post("/api/v1/agents/register",json={
            "name":"remote-dev","kind":"codex","role":"Developer",
        }).json()
        agents = c.get("/api/v1/agents").json()
        self.assertIn("dashboard-qa", [r["name"] for r in agents])
        self.assertTrue(c.post("/api/v1/dashboard-agent/heartbeat",headers=auth,json={}).json()["ok"])
        sent = c.post("/api/v1/dashboard-agent/send",headers=auth,json={
            "to":"remote-dev","text":"Debug hello","client_message_id":"one",
        })
        self.assertEqual(sent.status_code,200,sent.text)
        inbox = self.app.state.store.inbox(
            other["agent"]["agent_id"], other["token"],
        )
        self.assertEqual(inbox[0]["body"],"Debug hello")
        self.app.state.store.send(
            other["agent"]["agent_id"],other["token"],"dashboard-qa","Reply for human",
        )
        incoming = c.get("/api/v1/dashboard-agent/inbox",headers=auth)
        self.assertEqual(incoming.status_code,200)
        self.assertEqual(incoming.json()["items"][0]["body"],"Reply for human")
        self.assertIn("no-store",incoming.headers["Cache-Control"])
        ack = c.post("/api/v1/dashboard-agent/ack",headers=auth,json={
            "message_id":incoming.json()["items"][0]["message_id"],
        })
        self.assertEqual(ack.status_code,200)
        self.assertEqual(c.get("/api/v1/dashboard-agent/inbox",headers=auth).json()["items"],[])
        self.assertTrue(c.get("/api/v1/dashboard").json()["metrics"]["pending_messages"])
        off = c.post("/api/v1/dashboard-agent/disable",headers=auth,json={})
        self.assertEqual(off.status_code,200)
        self.assertFalse(off.json()["online"])
        self.assertEqual(c.post("/api/v1/dashboard-agent/send",headers=auth,json={
            "to":"remote-dev","text":"not allowed",
        }).status_code,403)
        resumed = c.post("/api/v1/dashboard-agent/enable",json={
            "name":"dashboard-qa","agent_id":dash_id,"token":identity["token"],
        })
        self.assertEqual(resumed.status_code,200)
        self.assertEqual(resumed.json()["agent"]["agent_id"],dash_id)
        self.assertTrue(resumed.json()["agent"]["online"])

    def test_auth_origin_and_history(self):
        c=self.client
        self.assertEqual(c.get("/api/v1/dashboard-agent/inbox").status_code,401)
        self.assertEqual(c.post("/api/v1/dashboard-agent/enable",
            headers={"Origin":"https://attacker.example"},json={"name":"x"}).status_code,403)
        self.assertEqual(c.post("/api/v1/dashboard-agent/enable",
            headers={"Sec-Fetch-Site":"cross-site"},json={"name":"x"}).status_code,403)
        self.assertEqual(c.get("/api/v1/dashboard/message-history?page=11").status_code,200)
        self.assertEqual(c.get("/api/v1/dashboard/tool-history?page=11").status_code,422)
        self.assertEqual(c.get("/api/v1/dashboard/tool-history").json()["total"],0)
        h={"Content-Type":"application/json","Accept":"application/json, text/event-stream"}
        result=c.post("/mcp",headers=h,json={
            "jsonrpc":"2.0","id":12,"method":"tools/call",
            "params":{"name":"register_agent","arguments":{
                "name":"observer","role":"tester","kind":"other",
            }},
        })
        self.assertEqual(result.status_code,200)
        audit = c.get("/api/v1/dashboard/tool-history").json()
        self.assertEqual(audit["total"],1)
        self.assertEqual(audit["items"][0]["tool_name"],"register_agent")
        self.assertEqual(audit["items"][0]["status"],"ok")
        self.assertGreaterEqual(audit["items"][0]["duration_ms"],0)
        self.assertNotIn("token",json.dumps(audit))
        self.assertNotIn("observer",json.dumps(result.json().get("error",{})))


if __name__ == "__main__":
    unittest.main()
