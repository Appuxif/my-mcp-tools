"""Permanent administrator-managed agent instructions, distinct from context."""
from __future__ import annotations

import sqlite3
import tempfile
import unittest
from pathlib import Path

from fastapi.testclient import TestClient

from agent_network.server import Config, create_app
from agent_network.store import MAX_INSTRUCTIONS_BYTES, Store
from auth_helpers import basic_headers


class InstructionsStoreTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.path = Path(self.temp.name) / "agents.db"
        self.store = Store(self.path)
        self.first = self.store.register("Admin-Worker", "Developer", "other")
        self.second = self.store.register("Admin-Reviewer", "Reviewer", "other")
        self.aid = self.first["agent"]["agent_id"]
        self.bid = self.second["agent"]["agent_id"]

    def tearDown(self):
        self.store.close()
        self.temp.cleanup()

    def edit(self, value):
        rev = self.store.admin_read_instructions(self.aid)["revision"]
        return self.store.admin_update_instructions(self.aid, value, rev)

    def test_existing_agents_start_empty_and_admin_can_edit_or_clear(self):
        self.assertEqual(self.store.read_instructions(self.aid, self.first["token"]), {
            "instructions": "", "updated_at": None, "bytes": 0,
        })
        original = "# Правила\n  Ничего не выдумывай\n\n✓\n"
        result = self.edit(original)
        self.assertEqual(result["bytes"], len(original.encode("utf-8")))
        self.assertEqual(self.store.read_instructions(
            self.aid, self.first["token"])["instructions"], original)
        self.assertEqual(self.store.admin_read_instructions(self.aid)["instructions"], original)
        self.assertEqual(self.store.read_instructions(self.bid, self.second["token"])["instructions"], "")
        self.assertEqual(self.edit("")["bytes"], 0)
        self.assertEqual(self.store.read_instructions(self.aid, self.first["token"])["instructions"], "")

    def test_prompt_is_private_and_independent_of_user_context(self):
        secret = "PRIVATE ADMIN INSTRUCTIONS <img src=x onerror=alert(1)>"
        self.edit(secret)
        self.store.save_context(self.aid, self.first["token"], "compact-work-only")
        self.assertEqual(self.store.read_context(self.aid, self.first["token"])["context"],
                         "compact-work-only")
        for payload in (self.store.agents(), self.store.dashboard_snapshot(),
                        self.store.tool_history(), self.store.agent_hud_snapshot(
                            self.aid, self.first["token"]),
                        self.store.admin_read_context(self.aid)):
            self.assertNotIn(secret, str(payload))
        with self.assertRaises(PermissionError):
            self.store.read_instructions(self.aid, self.second["token"])
        with self.assertRaises(ValueError):
            self.store.read_instructions("not-registered", self.first["token"])

    def test_prompt_creation_is_atomic_and_reconnect_cannot_change_it(self):
        prompt = "* Persistent reviewer prompt\n"
        created = self.store.register("With-Prompt", "Reviewer", "chatgpt",
                                      instructions=prompt)
        cid = created["agent"]["agent_id"]
        self.assertEqual(self.store.read_instructions(cid, created["token"])["instructions"], prompt)
        self.assertNotIn(prompt, str(created["agent"]))
        reconnected = self.store.register("With-Prompt", "Reviewer", "chatgpt",
                                          agent_id=cid, token=created["token"])
        self.assertFalse(reconnected["created"])
        with self.assertRaisesRegex(ValueError, "Instructions cannot be changed"):
            self.store.register("With-Prompt", "Reviewer", "chatgpt",
                                agent_id=cid, token=created["token"],instructions="Replace me")
        self.assertEqual(self.store.read_instructions(cid,created["token"])["instructions"], prompt)

    def test_limit_utf8_and_invalid_input_cannot_change_existing_prompt(self):
        self.edit("Keep me")
        self.assertEqual(self.edit(
            "x" * MAX_INSTRUCTIONS_BYTES)["bytes"], MAX_INSTRUCTIONS_BYTES)
        for invalid in ("x" * (MAX_INSTRUCTIONS_BYTES+1),
                        "🦄" * (MAX_INSTRUCTIONS_BYTES // 4 + 1), "\ud800", None, 4):
            with self.subTest(value=str(invalid)[:20]), self.assertRaises(ValueError):
                self.edit(invalid)
        self.assertEqual(len(self.store.admin_read_instructions(self.aid)["instructions"]),
                         MAX_INSTRUCTIONS_BYTES)

    def test_stale_editor_revision_cannot_overwrite_newer_instructions(self):
        stale = self.store.admin_read_instructions(self.aid)["revision"]
        fresh = self.store.admin_update_instructions(self.aid, "Tab A", stale)
        self.assertEqual(fresh["revision"], stale+1)
        with self.assertRaisesRegex(ValueError, "revision conflict"):
            self.store.admin_update_instructions(self.aid, "Tab B", stale)
        self.assertEqual(self.store.admin_read_instructions(self.aid)["instructions"], "Tab A")
        with self.assertRaisesRegex(ValueError, "Invalid instructions revision"):
            self.store.admin_update_instructions(self.aid, "Evil", True)
        self.assertEqual(self.store.admin_read_instructions(self.aid)["revision"], stale+1)

    def test_existing_instructions_table_migrates_without_losing_old_prompt(self):
        self.store.close()
        with sqlite3.connect(self.path) as db:
            db.execute("DROP TABLE agent_instructions")
            db.execute("CREATE TABLE agent_instructions (agent_id TEXT PRIMARY KEY, "
                       "instructions TEXT NOT NULL DEFAULT '', updated_at REAL)")
            db.execute("INSERT INTO agent_instructions(agent_id,instructions,updated_at) "
                       "VALUES(?,?,?)", (self.aid, "legacy prompt", 42))
        self.store=Store(self.path)
        restored=self.store.admin_read_instructions(self.aid)
        self.assertEqual(restored["instructions"], "legacy prompt")
        self.assertEqual(restored["revision"], 0)
        self.assertEqual(self.edit("New prompt")["revision"], 1)
        self.assertEqual(self.store.admin_read_instructions(self.aid)["instructions"], "New prompt")

    def test_migration_backfills_old_agents_and_survives_restart_and_delete(self):
        self.store.save_context(self.aid, self.first["token"], "Existing saved context")
        self.store.close()
        with sqlite3.connect(self.path) as db:
            db.execute("DROP TABLE agent_instructions")
        self.store = Store(self.path)
        self.assertEqual(self.store.admin_read_instructions(self.aid)["instructions"], "")
        self.assertEqual(self.store.admin_read_instructions(self.bid)["instructions"], "")
        self.assertIsNone(self.store.admin_read_instructions(self.aid)["updated_at"])
        self.edit("New prompt")
        self.store.close()
        self.store = Store(self.path)
        self.assertEqual(self.store.read_instructions(self.aid, self.first["token"])["instructions"],
                         "New prompt")
        self.assertEqual(self.store.read_context(self.aid, self.first["token"])["context"],
                         "Existing saved context")
        deletion = self.store.delete_agent(self.aid)
        self.assertTrue(deletion["deleted_instructions"])
        self.assertIsNone(self.store.db.execute(
            "SELECT 1 FROM agent_instructions WHERE agent_id=?", (self.aid,)).fetchone())


class InstructionsHttpTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.app = create_app(Config(database=str(Path(self.temp.name) / "app.db")))
        self.cm = TestClient(self.app, base_url="http://127.0.0.1:8787")
        self.client = self.cm.__enter__()
        self.auth = basic_headers(self.app)
        self.agent = self.app.state.store.register("Worker", "Developer", "chatgpt")
        self.aid = self.agent["agent"]["agent_id"]
        self.url = f"/api/v1/dashboard/agents/{self.aid}/instructions"

    def tearDown(self):
        self.cm.__exit__(None,None,None)
        self.temp.cleanup()

    def test_dashboard_can_create_with_instructions_and_read_modify_clear(self):
        prompt = "## Admin instructions\n  Do not bypass tests\n"
        created = self.client.post("/api/v1/dashboard/agents", json={
            "name":"New-Agent", "role":"Developer", "kind":"other",
            "teams":["default"], "instructions":prompt,
        },headers=self.auth)
        self.assertEqual(created.status_code,200,created.text)
        other_id=created.json()["agent"]["agent_id"]
        other_url=f"/api/v1/dashboard/agents/{other_id}/instructions"
        self.assertEqual(self.client.get(other_url, headers=self.auth).json()["instructions"],prompt)
        before=self.client.get(self.url,headers=self.auth).json()
        result=self.client.put(self.url,json={"instructions":prompt,
                                              "expected_revision":before["revision"]},headers=self.auth)
        self.assertEqual(result.status_code,200,result.text)
        self.assertEqual(result.json()["instructions"],prompt)
        self.assertEqual(result.headers["Cache-Control"],"no-store")
        self.assertEqual(self.client.get(self.url,headers=self.auth).json()["instructions"],prompt)
        self.assertNotIn(prompt,self.client.get("/api/v1/dashboard",headers=self.auth).text)
        clear=self.client.put(self.url,json={"instructions":"",
                                         "expected_revision":result.json()["revision"]},headers=self.auth)
        self.assertEqual(clear.status_code,200)
        self.assertEqual(self.client.get(self.url,headers=self.auth).json()["instructions"],"")

    def test_two_dashboard_tabs_same_revision_get_conflict_409(self):
        left=self.client.get(self.url,headers=self.auth).json()
        right=self.client.get(self.url,headers=self.auth).json()
        self.assertEqual(left["revision"],right["revision"])
        first=self.client.put(self.url,json={"instructions":"Left edit",
            "expected_revision":left["revision"]},headers=self.auth)
        self.assertEqual(first.status_code,200,first.text)
        self.assertEqual(first.json()["revision"],left["revision"]+1)
        second=self.client.put(self.url,json={"instructions":"Right stale edit",
            "expected_revision":right["revision"]},headers=self.auth)
        self.assertEqual(second.status_code,409,second.text)
        current=self.client.get(self.url,headers=self.auth).json()
        self.assertEqual(current["instructions"],"Left edit")
        self.assertEqual(current["revision"],first.json()["revision"])
        self.assertEqual(self.client.put(self.url,json={"instructions":"Unsafe missing revision"},
            headers=self.auth).status_code,422)

    def test_admin_only_and_csrf_for_read_and_write_and_no_agent_token_override(self):
        original_mcp=self.app.state.store._agent(self.aid)["last_mcp_activity"]
        for method in ("get","put"):
            payload={"json":{"instructions":"Bad","expected_revision":0}} if method=="put" else {}
            for headers,expected in (({},401),
                 ({"X-Agent-Id":self.aid,"X-Agent-Token":self.agent["token"]},401),
                 ({**self.auth,"Origin":"https://evil.example"},403),
                 ({**self.auth,"Sec-Fetch-Site":"cross-site"},403)):
                with self.subTest(method=method, headers=headers):
                    self.assertEqual(getattr(self.client,method)(self.url,headers=headers,
                                                                **payload).status_code,expected)
        self.assertEqual(self.app.state.store._agent(self.aid)["last_mcp_activity"],original_mcp)
        self.assertEqual(self.client.get(self.url,headers=self.auth).status_code,200)
        self.assertEqual(self.app.state.store._agent(self.aid)["last_mcp_activity"],original_mcp)
        self.assertEqual(self.app.state.store.read_instructions(
            self.aid,self.agent["token"])["instructions"],"")

    def test_nonexistent_and_large_prompts_are_rejected(self):
        self.assertEqual(self.client.post('/api/v1/dashboard/agents', json={
            "name":"Too-Long", "role":"Worker", "teams":["default"],
            "instructions":"🦄"*40000,
        },headers=self.auth).status_code,400)
        wrong='/api/v1/dashboard/agents/not-here/instructions'
        self.assertEqual(self.client.get(wrong,headers=self.auth).status_code,404)
        self.assertEqual(self.client.put(wrong,json={"instructions":"x","expected_revision":0},headers=self.auth).status_code,404)
        self.assertEqual(self.client.put(self.url,json={"instructions":"🦄"*40000,"expected_revision":0},
                                         headers=self.auth).status_code,400)
        self.assertEqual(self.client.put(self.url,json={"instructions":12,"expected_revision":0},
                                         headers=self.auth).status_code,422)

    def test_native_mcp_read_instructions_only_and_tool_schema(self):
        headers={"Content-Type":"application/json", "Accept":"application/json, text/event-stream"}
        def rpc(name,agent_id,token,seq):
            response=self.client.post("/mcp",json={
                "jsonrpc":"2.0","method":"tools/call","id":seq,
                "params":{"name":name,"arguments":{"agent_id":agent_id,"token":token}},
            },headers=headers)
            self.assertEqual(response.status_code,200)
            return response.json()["result"]
        self.app.state.store.admin_update_instructions(self.aid,"Admin prompt only",0)
        listed=self.client.post("/mcp",json={"jsonrpc":"2.0","method":"tools/list",
                                              "id":1,"params":{}},headers=headers).json()
        names={tool["name"] for tool in listed["result"]["tools"]}
        self.assertIn("read_instructions",names)
        self.assertNotIn("update_instructions",names)
        valid=rpc("read_instructions",self.aid,self.agent["token"],2)
        self.assertFalse(valid.get("isError"),valid)
        import json
        payload=valid.get("structuredContent")
        payload=(payload.get("result",payload) if payload is not None else
                 json.loads(valid["content"][0]["text"]))
        self.assertEqual(payload["instructions"],"Admin prompt only")
        invalid=rpc("read_instructions",self.aid,"invalid",3)
        self.assertTrue(invalid.get("isError"),invalid)


if __name__=="__main__":
    unittest.main()
