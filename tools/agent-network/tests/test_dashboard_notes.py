"""Admin-only read-only Notes table and detail APIs."""
from __future__ import annotations

import tempfile
import time
import unittest
from pathlib import Path

from fastapi.testclient import TestClient

from agent_network.server import Config, create_app
from agent_network.store import NOTE_TTL_SECONDS
from auth_helpers import basic_headers


class DashboardNotesTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.app = create_app(Config(database=str(Path(self.temp.name) / "notes.db")))
        self.client_cm = TestClient(self.app, base_url="http://127.0.0.1:8787")
        self.client = self.client_cm.__enter__()
        self.auth = basic_headers(self.app)
        self.store = self.app.state.store
        self.a = self.store.register("Reviewer", "reviewer", "other", teams=["Private"])
        self.b = self.store.register("Developer", "developer", "other", teams=["Other"])
        self.aid = self.a["agent"]["agent_id"]
        self.bid = self.b["agent"]["agent_id"]
        self.a_auth = (self.aid, self.a["token"])
        self.b_auth = (self.bid, self.b["token"])
        self.list_url = "/api/v1/dashboard/notes"

    def tearDown(self):
        self.client_cm.__exit__(None, None, None)
        self.temp.cleanup()

    def create_note(self, auth, title="Example", description="Example description"):
        return self.store.create_note(*auth, title, description)["note_id"]

    def detail(self, note_id):
        return self.client.get(f"{self.list_url}/{note_id}", headers=self.auth)

    def test_list_three_metadata_fields_and_detail_full_content(self):
        title = 'Audit <script>alert("x")</script>'
        description = 'Line 1\nLine 2 <img src=x onerror=alert(1)>'
        n1 = self.create_note(self.a_auth, title=title, description=description)
        c1 = self.store.add_to_note(*self.a_auth, n1, "P1", "one")
        self.store.add_to_note(*self.a_auth, n1, "P2", "two")
        n2 = self.create_note(self.b_auth, title="Final report", description="Approved")
        self.store.finalize_note(*self.b_auth, n2)

        listed = self.client.get(self.list_url, headers=self.auth)
        self.assertEqual(listed.status_code, 200, listed.text)
        self.assertEqual(listed.headers["cache-control"], "no-store")
        data = listed.json()
        self.assertEqual(data["total"], 2)
        self.assertEqual(data["page"], 1)
        self.assertEqual(data["page_size"], 20)
        self.assertEqual([item["note_id"] for item in data["items"]], [n2, n1])
        self.assertEqual(set(data["items"][1]), {
            "note_id", "title", "agent_id", "created_at",
            "status", "finalized_at", "agent_name", "subnote_count"
        })
        self.assertNotIn(description, listed.text)
        self.assertNotIn("one", listed.text)
        self.assertEqual(data["items"][1]["subnote_count"], 2)
        self.assertEqual(data["items"][1]["status"], "draft")
        self.assertEqual(data["items"][0]["status"], "finalized")

        full = self.detail(n1)
        self.assertEqual(full.status_code, 200, full.text)
        self.assertEqual(full.headers["cache-control"], "no-store")
        note = full.json()
        self.assertEqual(note["agent_id"], self.aid)
        self.assertEqual(note["agent_name"], "Reviewer")
        self.assertEqual(note["title"], title)
        self.assertEqual(note["description"], description)
        self.assertEqual(note["status"], "draft")
        self.assertEqual([x["title"] for x in note["subnotes"]], ["P1", "P2"])
        self.assertEqual(note["subnotes"][0]["subnote_id"], c1["subnote_id"])
        self.assertAlmostEqual(
            note["expires_at"] - note["created_at"], NOTE_TTL_SECONDS
        )
        # Admin sees drafts across teams without acquiring author's agent token.
        with self.assertRaisesRegex(ValueError, "Note not found"):
            self.store.read_note(*self.b_auth, n1)
        self.assertEqual(self.detail(n1).json()["description"], description)

    def test_auth_and_cross_origin(self):
        n1 = self.create_note(self.a_auth, description="private details")
        paths = [self.list_url, f"{self.list_url}/{n1}"]
        for path in paths:
            with self.subTest(path=path):
                self.assertEqual(self.client.get(path).status_code, 401)
                self.assertEqual(self.client.get(path, headers={
                    "X-Agent-Id": self.aid, "X-Agent-Token": self.a["token"]
                }).status_code, 401)
                self.assertEqual(self.client.get(path, headers={
                    **self.auth, "Origin": "https://other.example"
                }).status_code, 403)
                self.assertEqual(self.client.get(path, headers={
                    **self.auth, "Sec-Fetch-Site": "cross-site"
                }).status_code, 403)
                self.assertEqual(self.client.get(path, headers=self.auth).status_code, 200)

    def test_expired_notes_are_hidden_before_maintenance(self):
        live = self.create_note(self.b_auth, title="Live")
        old = self.create_note(self.a_auth, title="Expired")
        self.store.add_to_note(*self.a_auth, old, "secret", "child")
        with self.store.lock, self.store.db:
            self.store.db.execute(
                "UPDATE notes SET created_at=? WHERE note_id=?",
                (time.time() - NOTE_TTL_SECONDS - 20, old),
            )
        listing = self.client.get(self.list_url, headers=self.auth).json()
        self.assertEqual(listing["total"], 1)
        self.assertEqual(listing["items"][0]["note_id"], live)
        self.assertEqual(self.detail(old).status_code, 404)
        self.assertEqual(self.detail("unknown-note").status_code, 404)
        self.assertEqual(self.store.prune_notes()["expired_notes"], 1)
        self.assertEqual(self.detail(old).status_code, 404)

    def test_pagination_order_and_bounds(self):
        for idx in range(25):
            self.create_note(self.a_auth, title=f"Note {idx}")
        first = self.client.get(self.list_url, headers=self.auth).json()
        second = self.client.get(self.list_url + "?page=2", headers=self.auth).json()
        self.assertEqual(first["total"], second["total"])
        self.assertEqual(first["total"], 25)
        self.assertEqual(len(first["items"]), 20)
        self.assertEqual(len(second["items"]), 5)
        self.assertEqual(first["items"][0]["title"], "Note 24")
        self.assertEqual(second["items"][-1]["title"], "Note 0")
        self.assertFalse(set(x["note_id"] for x in first["items"]) &
                         set(x["note_id"] for x in second["items"]))
        for params in ("?page=0", "?page=-1", "?page=10001", "?page=nope"):
            self.assertEqual(
                self.client.get(self.list_url + params, headers=self.auth).status_code,
                422,
            )
        empty = self.client.get(self.list_url + "?page=3", headers=self.auth).json()
        self.assertEqual(empty["total"], 25)
        self.assertEqual(empty["items"], [])

    def test_admin_reads_do_not_touch_presence_or_inbox(self):
        n1 = self.create_note(self.a_auth)
        self.store.add_to_note(*self.a_auth, n1, "child", "text")
        before = self.store._agent(self.aid)["last_mcp_activity"]
        self.assertEqual(self.store.db.execute(
            "SELECT count(*) FROM messages"
        ).fetchone()[0], 0)
        self.client.get(self.list_url, headers=self.auth)
        self.detail(n1)
        self.assertEqual(self.store._agent(self.aid)["last_mcp_activity"], before)
        self.assertEqual(self.store.db.execute(
            "SELECT count(*) FROM messages"
        ).fetchone()[0], 0)
        self.assertEqual(self.store.candidates(60, 90), [])

        # Deleting an author invalidates their notes automatically.
        self.store.delete_agent(self.aid)
        self.assertEqual(self.detail(n1).status_code, 404)
        self.assertEqual(
            self.client.get(self.list_url, headers=self.auth).json()["total"], 0
        )


if __name__ == "__main__":
    unittest.main()
