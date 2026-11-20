"""Short-lived notes for multi-agent handoffs; no implicit notifications."""
from __future__ import annotations

import json
import tempfile
import time
import unittest
from pathlib import Path

from fastapi.testclient import TestClient

from agent_network.server import Config, create_app
from agent_network.store import (
    MAX_NOTE_BYTES, MAX_SUBNOTES, NOTE_TTL_SECONDS, Store,
)


class NoteStoreTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.path = Path(self.tmp.name) / "notes.sqlite"
        self.store = Store(self.path)
        self.author = self.store.register("Reviewer", "reviewer", "other")
        self.developer = self.store.register("Developer", "developer", "other")
        self.outsider = self.store.register("Outsider", "developer", "other",
                                           teams=["isolated"])
        self.a = self.author["agent"]["agent_id"]
        self.b = self.developer["agent"]["agent_id"]
        self.c = self.outsider["agent"]["agent_id"]
        self.auth = (self.a, self.author["token"])
        self.peer_auth = (self.b, self.developer["token"])
        self.outsider_auth = (self.c, self.outsider["token"])

    def tearDown(self):
        self.store.close()
        self.tmp.cleanup()

    def test_draft_edit_finalize_and_explicit_send_only(self):
        created = self.store.create_note(*self.auth, "Review", "Commit 123")
        note_id = created["note_id"]
        self.assertEqual(created["status"], "draft")
        self.assertAlmostEqual(created["expires_at"] - time.time(), NOTE_TTL_SECONDS, delta=5)
        first = self.store.add_to_note(*self.auth, note_id, "P1", "First finding")
        second = self.store.add_to_note(*self.auth, note_id, "P2", "Discard me")
        self.store.update_subnote(*self.auth, note_id, first["subnote_id"],
                                  "P1 fixed", "Revised finding")
        self.store.remove_from_note(*self.auth, note_id, second["subnote_id"])
        with self.assertRaisesRegex(ValueError, "Note not found"):
            self.store.read_note(*self.peer_auth, note_id)
        with self.assertRaisesRegex(ValueError, "Note not found"):
            self.store.add_to_note(*self.peer_auth, note_id, "sneak", "bad")
        draft = self.store.read_note(*self.auth, note_id)
        self.assertEqual(draft["status"], "draft")
        self.assertEqual(len(draft["subnotes"]), 1)
        self.assertEqual(draft["subnotes"][0]["title"], "P1 fixed")
        self.assertEqual(draft["subnotes"][0]["description"], "Revised finding")

        result = self.store.finalize_note(*self.auth, note_id)
        repeated = self.store.finalize_note(*self.auth, note_id)
        self.assertEqual(result, repeated)
        self.assertEqual(result["subnote_count"], 1)
        self.assertEqual(result["status"], "finalized")

        # Creating, editing and finalizing a note never creates a message,
        # changes peer's inbox, or creates a wake candidate.
        self.assertEqual(self.store.inbox(*self.peer_auth), [])
        self.assertIsNone(self.store.db.execute("SELECT * FROM messages").fetchone())
        self.assertEqual(self.store.candidates(60, 90), [])

        peer_note = self.store.read_note(*self.peer_auth, note_id)
        self.assertEqual(peer_note["author_name"], "Reviewer")
        self.assertEqual(peer_note["status"], "finalized")
        self.assertEqual(peer_note, self.store.read_note(*self.peer_auth, note_id))
        for fn, args in (
            (self.store.add_to_note, (note_id, "late", "finding")),
            (self.store.update_subnote,
             (note_id, first["subnote_id"], "late", "edit")),
            (self.store.remove_from_note, (note_id, first["subnote_id"])),
        ):
            with self.assertRaisesRegex(ValueError, "finalized"):
                fn(*self.auth, *args)
        with self.assertRaisesRegex(ValueError, "Note not found"):
            self.store.finalize_note(*self.peer_auth, note_id)

        # This explicit send is the sole event that puts note_id in the inbox.
        body = f"Review ready: note_id={note_id}"
        self.store.send(*self.auth, to="Developer", body=body)
        incoming = self.store.inbox(*self.peer_auth)
        self.assertEqual(len(incoming), 1)
        self.assertIn(note_id, incoming[0]["body"])

    def test_note_visibility_follows_current_team_membership(self):
        nid = self.store.create_note(*self.auth, "Shared", "private")["note_id"]
        self.store.finalize_note(*self.auth, nid)
        with self.assertRaisesRegex(ValueError, "Note not found"):
            self.store.read_note(*self.outsider_auth, nid)
        self.store.assign_teams(self.b, ["isolated"])
        with self.assertRaisesRegex(ValueError, "Note not found"):
            self.store.read_note(*self.peer_auth, nid)
        self.store.assign_teams(self.b, ["default"])
        self.assertEqual(self.store.read_note(*self.peer_auth, nid)["title"], "Shared")

    def test_ttl_48h_from_creation_does_not_reset_on_finalize(self):
        nid = self.store.create_note(*self.auth, "time", "")["note_id"]
        with self.store.lock, self.store.db:
            self.store.db.execute(
                "UPDATE notes SET created_at=? WHERE note_id=?",
                (time.time() - NOTE_TTL_SECONDS + 10, nid),
            )
        self.store.finalize_note(*self.auth, nid)
        result = self.store.read_note(*self.peer_auth, nid)
        self.assertLess(result["expires_at"] - time.time(), 11)
        with self.store.lock, self.store.db:
            self.store.db.execute(
                "UPDATE notes SET created_at=? WHERE note_id=?",
                (time.time() - NOTE_TTL_SECONDS - 1, nid),
            )
        for auth in (self.auth, self.peer_auth):
            with self.assertRaisesRegex(ValueError, "Note not found"):
                self.store.read_note(*auth, nid)
        self.assertEqual(self.store.prune_notes()["expired_notes"], 1)
        self.assertEqual(self.store.db.execute(
            "SELECT count(*) FROM subnotes WHERE note_id=?", (nid,)
        ).fetchone()[0], 0)

    def test_draft_ttl_and_explicit_pruning(self):
        nid = self.store.create_note(*self.auth, "draft", "")["note_id"]
        child = self.store.add_to_note(*self.auth, nid, "first", "details")
        with self.store.lock, self.store.db:
            self.store.db.execute("UPDATE notes SET created_at=? WHERE note_id=?",
                                  (time.time() - NOTE_TTL_SECONDS - 5, nid))
        with self.assertRaisesRegex(ValueError, "Note not found"):
            self.store.add_to_note(*self.auth, nid, "expired", "")
        with self.assertRaisesRegex(ValueError, "Note not found"):
            self.store.finalize_note(*self.auth, nid)
        self.assertEqual(self.store.prune_notes()["expired_notes"], 1)
        self.assertFalse(self.store.db.execute(
            "SELECT 1 FROM subnotes WHERE subnote_id=?", (child["subnote_id"],)
        ).fetchone())
        self.assertEqual(self.store.prune_notes()["expired_notes"], 0)

    def test_validation_and_limits_are_atomic(self):
        with self.assertRaises(ValueError):
            self.store.create_note(*self.auth, "", "")
        with self.assertRaises(ValueError):
            self.store.create_note(*self.auth, "x" * 201, "")
        with self.assertRaises(ValueError):
            self.store.create_note(*self.auth, "x", "z" * 12001)
        with self.assertRaises(PermissionError):
            self.store.create_note(self.a, "wrong-token", "secret", "")
        nid = self.store.create_note(*self.auth, "Limit", "")["note_id"]
        for i in range(MAX_SUBNOTES):
            self.store.add_to_note(*self.auth, nid, "x", str(i))
        with self.assertRaisesRegex(ValueError, "subnote limit"):
            self.store.add_to_note(*self.auth, nid, "overflow", "")
        children = self.store.read_note(*self.auth, nid)["subnotes"]
        self.assertEqual(len(children), MAX_SUBNOTES)
        with self.assertRaisesRegex(ValueError, "Subnote not found"):
            self.store.remove_from_note(*self.auth, nid, "not-present")
        self.store.remove_from_note(*self.auth, nid, children[0]["subnote_id"])
        self.store.add_to_note(*self.auth, nid, "new", "works")
        self.assertEqual(len(self.store.read_note(*self.auth, nid)["subnotes"]),
                         MAX_SUBNOTES)

        # UTF-8 bytes rather than just number of characters are bounded.
        large = self.store.create_note(*self.auth, "Big", "")["note_id"]
        for i in range(2):
            self.store.add_to_note(*self.auth, large, "C", "🧩" * 12000)
        with self.assertRaisesRegex(ValueError, "maximum size"):
            # Add would exceed 128KiB.
            for i in range(2):
                self.store.add_to_note(*self.auth, large, "C", "🧩" * 12000)
        self.assertLessEqual(self.store._note_usage(self.store._note(large))[1],
                             MAX_NOTE_BYTES)

    def test_restart_persistence_rotation_and_author_deletion(self):
        nid = self.store.create_note(*self.auth, "Persist", "")["note_id"]
        self.store.add_to_note(*self.auth, nid, "child", "value")
        self.store.close()
        self.store = Store(self.path)
        self.assertEqual(len(self.store.read_note(*self.auth, nid)["subnotes"]), 1)
        rotated = self.store.rotate_agent_token(self.a)
        with self.assertRaises(PermissionError):
            self.store.read_note(*self.auth, nid)
        new_auth = (self.a, rotated["token"])
        self.store.finalize_note(*new_auth, nid)
        self.assertEqual(self.store.read_note(*self.peer_auth, nid)["title"], "Persist")
        deleted = self.store.delete_agent(self.a)
        self.assertEqual(deleted["deleted_notes"], 1)
        self.assertEqual(self.store.db.execute("SELECT count(*) FROM subnotes").fetchone()[0], 0)
        with self.assertRaisesRegex(ValueError, "Note not found"):
            self.store.read_note(*self.peer_auth, nid)


class NotesMcpTests(unittest.TestCase):
    def test_native_tool_schema_and_roundtrip(self):
        with tempfile.TemporaryDirectory() as tmp:
            app = create_app(Config(database=str(Path(tmp) / "mcp.db")))
            with TestClient(app, base_url="http://127.0.0.1:8787") as client:
                author = app.state.store.register("Reviewer", "worker", "other")
                peer = app.state.store.register("Developer", "worker", "other")
                auth = {"agent_id": author["agent"]["agent_id"],
                        "token": author["token"]}
                target = {"agent_id": peer["agent"]["agent_id"],
                          "token": peer["token"]}
                headers = {"Content-Type": "application/json",
                           "Accept": "application/json, text/event-stream"}

                def rpc(method, params, seq):
                    response = client.post(
                        "/mcp", headers=headers,
                        json={"jsonrpc": "2.0", "method": method,
                              "params": params, "id": seq})
                    self.assertEqual(response.status_code, 200, response.text[:300])
                    data = response.json()
                    self.assertNotIn("error", data, data)
                    return data["result"]

                rpc("initialize", {
                    "protocolVersion": "2025-06-18",
                    "capabilities": {},
                    "clientInfo": {"name": "notes-test", "version": "1"},
                }, 1)
                schemas = rpc("tools/list", {}, 2)["tools"]
                self.assertEqual(len(schemas), 15)
                names = {tool["name"] for tool in schemas}
                self.assertTrue({
                    "create_note", "add_to_note", "remove_from_note",
                    "update_subnote", "finalize_note", "read_note",
                }.issubset(names))

                def tool(name, credentials, seq, **kwargs):
                    result = rpc("tools/call", {
                        "name": name,
                        "arguments": {**credentials, **kwargs},
                    }, seq)
                    self.assertFalse(result.get("isError"), result)
                    content = result.get("structuredContent")
                    if content is not None:
                        return content.get("result", content)
                    return json.loads(result["content"][0]["text"])

                note = tool("create_note", auth, 3,
                            title="Review", description="All findings")
                nid = note["note_id"]
                sub = tool("add_to_note", auth, 4,
                           note_id=nid, title="P1", description="Fix this")
                tool("update_subnote", auth, 5, note_id=nid,
                     subnote_id=sub["subnote_id"],
                     title="P2", description="Fix this instead")
                self.assertEqual(tool("read_note", auth, 6, note_id=nid)["status"],
                                 "draft")
                self.assertEqual(tool("finalize_note", auth, 7, note_id=nid)["status"],
                                 "finalized")
                shared = tool("read_note", target, 8, note_id=nid)
                self.assertEqual(shared["subnotes"][0]["title"], "P2")
                self.assertEqual(tool("get_messages", target, 9), [])
                self.assertEqual(app.state.store.db.execute(
                    "SELECT count(*) FROM messages"
                ).fetchone()[0], 0)
                tool("send_message", auth, 10, to="Developer",
                     text=f"Review complete, note_id={nid}")
                self.assertIn(nid, tool("get_messages", target, 11)[0]["body"])


if __name__ == "__main__":
    unittest.main()
