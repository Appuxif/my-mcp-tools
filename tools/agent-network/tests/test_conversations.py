"""Admin-only agent conversation browser: TTL, auth and cursor pagination."""
from __future__ import annotations

import tempfile
import time
import unittest
from pathlib import Path

from fastapi.testclient import TestClient

from agent_network.server import Config, create_app
from agent_network.store import MESSAGE_TTL_SECONDS, Store
from auth_helpers import basic_headers


class ConversationStoreTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.store = Store(Path(self.tmp.name) / "conversation.db")
        self.a = self.store.register("frontend", "Frontend", "chatgpt")
        self.b = self.store.register("backend", "Backend", "codex")
        self.c = self.store.register("reviewer", "Reviewer", "other")
        self.aid = self.a["agent"]["agent_id"]
        self.bid = self.b["agent"]["agent_id"]
        self.cid = self.c["agent"]["agent_id"]

    def tearDown(self):
        self.store.close()
        self.tmp.cleanup()

    def send(self, sender, to, body):
        return self.store.send(sender["agent"]["agent_id"],
                               sender["token"], to, body)["message_id"]

    def test_peer_list_groups_bidirectional_and_self_messages(self):
        first = self.send(self.a, "backend", "A to B")
        second = self.send(self.b, "frontend", "B to A")
        third = self.send(self.c, "frontend", "C to A")
        self.send(self.a, "frontend", "A to A")
        self.store.acknowledge(self.bid, self.b["token"], first)
        self.store.acknowledge(self.aid, self.a["token"], second)

        results = self.store.conversations(self.aid)
        self.assertEqual(results["agent_name"], "frontend")
        peers = {row["peer_id"]: row for row in results["items"]}
        self.assertEqual(set(peers), {self.aid, self.bid, self.cid})
        self.assertEqual(peers[self.bid]["message_count"], 2)
        self.assertEqual(peers[self.bid]["pending_for_agent"], 0)
        self.assertEqual(peers[self.cid]["pending_for_agent"], 1)
        self.assertEqual(peers[self.aid]["message_count"], 1)
        self.assertNotIn("body", str(results))
        self.assertNotIn("C to A", str(results))

    def test_cursor_pagination_has_no_gaps_on_tied_timestamps(self):
        ids = []
        for index in range(12):
            sender, to = (self.a, "backend") if index % 2 == 0 else (self.b, "frontend")
            ids.append(self.send(sender, to, "body " + str(index)))

        # Every row has the exact same timestamp. rowid is the tiebreaker.
        tie_time = time.time() - 4
        with self.store.lock, self.store.db:
            self.store.db.execute(
                "UPDATE messages SET created_at=? WHERE message_id IN ("
                + ",".join("?" for _ in ids) + ")",
                (tie_time, *ids)
            )
        all_seen = []
        cursor = ""
        for _ in range(4):
            data = self.store.conversation_messages(self.aid, self.bid,
                                                    before=cursor, limit=5)
            self.assertEqual(data["agent_name"], "frontend")
            self.assertEqual(data["peer_name"], "backend")
            self.assertEqual(len(data["items"]), 5 if len(all_seen) < 10 else 2)
            all_seen.extend(row["message_id"] for row in data["items"])
            if not data["has_more"]:
                self.assertIsNone(data["next_cursor"])
                break
            cursor = data["next_cursor"]
            self.assertTrue(cursor)
        self.assertEqual(len(all_seen), 12)
        self.assertEqual(len(set(all_seen)), 12)
        self.assertEqual(set(all_seen), set(ids))
        self.assertEqual(all_seen[-2:], ids[:2])

    def test_new_messages_do_not_shift_older_cursor_pages(self):
        ids = [self.send(self.a, "backend", f"entry {n}") for n in range(8)]
        first = self.store.conversation_messages(self.aid, self.bid, limit=3)
        self.assertEqual([m["message_id"] for m in first["items"]], ids[-3:])
        new_id = self.send(self.b, "frontend", "new after first page")
        second = self.store.conversation_messages(
            self.aid, self.bid, limit=3, before=first["next_cursor"]
        )
        self.assertEqual([m["message_id"] for m in second["items"]], ids[-6:-3])
        self.assertNotIn(new_id, [m["message_id"] for m in second["items"]])

    def test_conversation_history_is_read_only_and_ttl_filtered(self):
        fresh = self.send(self.b, "frontend", "<img src=x onerror=alert(1)>")
        old = self.send(self.a, "backend", "expired secret")
        with self.store.lock, self.store.db:
            self.store.db.execute("UPDATE messages SET created_at=? WHERE message_id=?",
                                  (time.time() - MESSAGE_TTL_SECONDS - 5, old))
        seen_before = self.store._agent(self.aid)["last_mcp_activity"]
        history = self.store.conversation_messages(self.aid, self.bid)
        self.assertEqual([m["message_id"] for m in history["items"]], [fresh])
        self.assertEqual(history["items"][0]["body"], "<img src=x onerror=alert(1)>")
        self.assertEqual(history["items"][0]["status"], "pending")
        self.assertEqual(history["items"][0]["sender_name"], "backend")
        self.assertEqual(self.store._agent(self.aid)["last_mcp_activity"], seen_before)
        self.assertEqual(len(self.store.inbox(self.aid, self.a["token"])), 1)
        self.assertEqual(len(self.store.conversations(self.bid)["items"]), 1)
        self.assertEqual(self.store.conversations(self.bid)["items"][0]["message_count"], 1)

    def test_cursors_cannot_cross_pairs_or_agents(self):
        msg_for_b = self.send(self.a, "backend", "allowed")
        msg_for_c = self.send(self.a, "reviewer", "other pair")
        with self.assertRaisesRegex(ValueError, "invalid or expired"):
            self.store.conversation_messages(self.aid, self.bid, before=msg_for_c)
        with self.assertRaisesRegex(ValueError, "invalid or expired"):
            self.store.conversation_messages(self.aid, self.cid, before=msg_for_b)
        with self.assertRaisesRegex(ValueError, "Unknown agent_id"):
            self.store.conversation_messages("unknown", self.bid)
        with self.assertRaisesRegex(ValueError, "1..50"):
            self.store.conversation_messages(self.aid, self.bid, limit=0)
        with self.assertRaisesRegex(ValueError, "1..50"):
            self.store.conversation_messages(self.aid, self.bid, limit=51)

    def test_metadata_and_body_disappear_after_ttl_pruning(self):
        mid = self.send(self.a, "backend", "this message expires")
        with self.store.lock, self.store.db:
            self.store.db.execute("UPDATE messages SET created_at=? WHERE message_id=?",
                                  (time.time() - MESSAGE_TTL_SECONDS - 2, mid))
        self.assertEqual(self.store.conversations(self.aid)["items"], [])
        self.assertEqual(self.store.conversation_messages(self.aid, self.bid)["items"], [])
        self.assertEqual(self.store.prune_messages()["expired_messages"], 1)
        self.assertEqual(self.store.conversations(self.aid)["items"], [])


class ConversationHttpTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.app = create_app(Config(database=str(Path(self.tmp.name) / "http.db")))
        self.context = TestClient(self.app, base_url="http://127.0.0.1:8787")
        self.client = self.context.__enter__()
        self.headers = basic_headers(self.app)
        self.client.headers.update(self.headers)
        a = self.client.post("/api/v1/agents/register", json={
            "name": "alpha", "role": "tester", "kind": "other",
        }).json()
        b = self.client.post("/api/v1/agents/register", json={
            "name": "beta", "role": "tester", "kind": "other",
        }).json()
        self.aid, self.bid = a["agent"]["agent_id"], b["agent"]["agent_id"]
        self.app.state.store.send(self.aid, a["token"], "beta", "a private body")

    def tearDown(self):
        self.context.__exit__(None, None, None)
        self.tmp.cleanup()

    def test_admin_secret_required_and_no_store(self):
        index = "/api/v1/dashboard/conversations?agent_id=" + self.aid
        body = "/api/v1/dashboard/conversations/" + self.aid + "/" + self.bid + "/messages"
        for url in [index, body]:
            self.assertEqual(self.client.get(url, headers={"Authorization":""}).status_code, 401)
            self.assertEqual(self.client.get(
                url, headers={"Authorization":"Basic invalid"}
            ).status_code, 401)
            self.assertEqual(self.client.get(
                url, headers={**self.headers,"Origin":"https://evil.example"}
            ).status_code, 403)
            self.assertEqual(self.client.get(
                url, headers={**self.headers,"Sec-Fetch-Site":"cross-site"}
            ).status_code, 403)
            self.assertEqual(self.client.get(
                url, headers={**self.headers,"Host":"evil.example"}
            ).status_code, 401)
            response = self.client.get(url, headers=self.headers)
            self.assertEqual(response.status_code, 200, response.text)
            self.assertEqual(response.headers["Cache-Control"], "no-store")

        self.assertNotIn("a private body", self.client.get(
            "/api/v1/dashboard").text)
        self.assertNotIn("a private body", self.client.get(
            "/api/v1/dashboard/message-history").text)
        peers = self.client.get(index, headers=self.headers).json()
        self.assertEqual(peers["items"][0]["peer_name"], "beta")
        content = self.client.get(body, headers=self.headers).json()
        self.assertEqual(content["items"][0]["body"], "a private body")

    def test_query_validations(self):
        base = ("/api/v1/dashboard/conversations/"
                + self.aid + "/" + self.bid + "/messages")
        self.assertEqual(self.client.get(base+"?limit=51",
                                         headers=self.headers).status_code, 422)
        self.assertEqual(self.client.get(base+"?before=invalid",
                                         headers=self.headers).status_code, 400)
        self.assertEqual(self.client.get(
            "/api/v1/dashboard/conversations?agent_id=unknown",
            headers=self.headers).status_code, 404)


if __name__ == "__main__":
    unittest.main()
