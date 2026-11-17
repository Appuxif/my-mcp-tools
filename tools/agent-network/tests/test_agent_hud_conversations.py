"""Token-scoped HUD conversation access; never expose third-party pair messages."""
from __future__ import annotations

import tempfile
import time
import unittest
from pathlib import Path

from fastapi.testclient import TestClient

from agent_network.server import Config, create_app
from auth_helpers import basic_headers
from agent_network.store import MESSAGE_TTL_SECONDS


class AgentHudConversationTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory()
        self.app=create_app(Config(database=str(Path(self.temp.name)/"hud.db")))
        self.cm=TestClient(self.app,base_url="http://127.0.0.1:8787")
        self.client=self.cm.__enter__()
        self.agents={}
        for name in ("alpha","beta","charlie"):
            identity=self.client.post("/api/v1/dashboard/agents",headers=basic_headers(self.app),json={
                "name":name,"role":"tester","kind":"chatgpt", "teams": ["default"]
            }).json()
            self.agents[name]=identity
        self.store=self.app.state.store
        self.alpha=self.agents["alpha"]["agent"]["agent_id"]
        self.beta=self.agents["beta"]["agent"]["agent_id"]
        self.charlie=self.agents["charlie"]["agent"]["agent_id"]
        self.ab=self.send("alpha","beta","from alpha to beta")
        self.ba=self.send("beta","alpha","reply from beta to alpha")
        self.bc=self.send("beta","charlie","PRIVATE BETA CHARLIE")
        self.cb=self.send("charlie","beta","reply from charlie")
        self.urls=(
            "/api/v1/agents/conversations",
            "/api/v1/agents/conversations/"+self.beta+"/messages"
        )

    def tearDown(self):
        self.cm.__exit__(None,None,None)
        self.temp.cleanup()

    def headers(self,name):
        agent=self.agents[name]
        return {
            "X-Agent-Id":agent["agent"]["agent_id"],
            "X-Agent-Token":agent["token"],
        }

    def send(self,name,to,body):
        sender=self.agents[name]
        return self.store.send(
            sender["agent"]["agent_id"],sender["token"],to,body
        )["message_id"]

    def test_peer_lists_only_include_conversations_with_self(self):
        alpha=self.client.get(self.urls[0],headers=self.headers("alpha"))
        self.assertEqual(alpha.status_code,200,alpha.text)
        self.assertIn("no-store",alpha.headers["Cache-Control"])
        self.assertEqual(
            [peer["peer_id"] for peer in alpha.json()["items"]],
            [self.beta],
        )
        self.assertNotIn("PRIVATE BETA CHARLIE",alpha.text)
        self.assertNotIn("charlie",alpha.text)
        beta=self.client.get(self.urls[0],headers=self.headers("beta"))
        self.assertEqual(
            {peer["peer_id"] for peer in beta.json()["items"]},
            {self.alpha,self.charlie}
        )
        self.assertEqual(beta.json()["agent_id"],self.beta)

    def test_own_history_contains_only_pair_messages_in_both_directions(self):
        last_activity=self.store._agent(self.alpha)["last_mcp_activity"]
        inbox_before=self.store.db.execute(
            "SELECT status FROM messages WHERE message_id=?",(self.ba,)
        ).fetchone()[0]
        history=self.client.get(self.urls[1],headers=self.headers("alpha"))
        self.assertEqual(history.status_code,200,history.text)
        rows=history.json()["items"]
        self.assertEqual({m["message_id"] for m in rows},{self.ab,self.ba})
        self.assertEqual({m["body"] for m in rows},{
            "from alpha to beta","reply from beta to alpha"
        })
        self.assertNotIn("PRIVATE BETA CHARLIE",history.text)
        self.assertEqual(self.store._agent(self.alpha)["last_mcp_activity"],
                         last_activity)
        self.assertEqual(self.store.db.execute(
            "SELECT status FROM messages WHERE message_id=?",(self.ba,)
        ).fetchone()[0],inbox_before)
        self.assertEqual(history.headers["Cache-Control"],"no-store")

    def test_foreign_pair_not_accessible_even_with_forged_query(self):
        bad=self.client.get(
            "/api/v1/agents/conversations/"+self.charlie+
            "/messages?agent_id="+self.beta,
            headers=self.headers("alpha"),
        )
        self.assertEqual(bad.status_code,404)
        self.assertNotIn("PRIVATE BETA CHARLIE",bad.text)
        # Swapping identity ID without matching token does not work.
        spoof=self.client.get(
            "/api/v1/agents/conversations/"+self.charlie+"/messages",
            headers={
                "X-Agent-Id":self.beta,
                "X-Agent-Token":self.agents["alpha"]["token"],
            }
        )
        self.assertEqual(spoof.status_code,403)
        self.assertEqual(
            self.client.get(self.urls[0]).status_code,403
        )
        self.assertEqual(
            self.client.get(self.urls[0],headers={
                "Authorization":"Basic dummy"
            }).status_code,403
        )

    def test_cursor_cannot_escape_pair_and_validation(self):
        url=self.urls[1]
        self.assertEqual(self.client.get(
            url+"?before="+self.bc,headers=self.headers("alpha")
        ).status_code,400)
        self.assertEqual(self.client.get(
            url+"?before=invalid",headers=self.headers("alpha")
        ).status_code,400)
        self.assertEqual(self.client.get(
            url+"?limit=51",headers=self.headers("alpha")
        ).status_code,422)
        self.assertEqual(self.client.get(
            url+"?limit=0",headers=self.headers("alpha")
        ).status_code,422)

    def test_paginate_more_than_one_page_without_leaking_foreign_messages(self):
        ids=[self.ab,self.ba]
        for i in range(43):
            ids.append(self.send("alpha","beta","message "+str(i)))
        first=self.client.get(self.urls[1]+"?limit=30",
                              headers=self.headers("alpha")).json()
        self.assertTrue(first["has_more"])
        self.assertEqual(len(first["items"]),30)
        older=self.client.get(self.urls[1]+"?limit=30&before="+first["next_cursor"],
                              headers=self.headers("alpha")).json()
        self.assertFalse(older["has_more"])
        self.assertEqual(len(older["items"]),15)
        self.assertEqual(
            {m["message_id"] for m in first["items"]+older["items"]},set(ids)
        )

    def test_expired_or_deleted_pair_not_readable(self):
        cutoff=time.time()-MESSAGE_TTL_SECONDS-5
        with self.store.lock,self.store.db:
            self.store.db.execute(
                "UPDATE messages SET created_at=? WHERE message_id IN (?,?)",
                (cutoff,self.ab,self.ba)
            )
        self.assertEqual(
            self.client.get(self.urls[0],
                            headers=self.headers("alpha")).json()["items"],[]
        )
        self.assertEqual(
            self.client.get(self.urls[1],
                            headers=self.headers("alpha")).status_code,404
        )


if __name__=="__main__":
    unittest.main()
