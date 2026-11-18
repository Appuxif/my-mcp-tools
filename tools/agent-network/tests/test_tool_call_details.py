"""Tool call input auditing: token-safe storage and administrator detail API."""
from __future__ import annotations

import json
import sqlite3
import tempfile
import unittest
from pathlib import Path

from fastapi.testclient import TestClient

from agent_network.server import Config, create_app
from agent_network.store import Store, MAX_TOOL_ARGUMENT_BYTES
from auth_helpers import basic_headers


class ToolCallInputTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.path = Path(self.temp.name) / "tool-audit.db"
        self.app = create_app(Config(database=str(self.path)))
        self.cm = TestClient(self.app,base_url="http://127.0.0.1:8787")
        self.client = self.cm.__enter__()
        self.headers = basic_headers(self.app)
        self.store = self.app.state.store
        self.a = self.store.register("Dev", "developer", "other")
        self.b = self.store.register("Review", "reviewer", "other")
        self.credentials = {
            "agent_id": self.a["agent"]["agent_id"],
            "token": self.a["token"]
        }
        self.rpc_headers = {
            "Content-Type":"application/json",
            "Accept":"application/json, text/event-stream"
        }

    def tearDown(self):
        self.cm.__exit__(None,None,None)
        self.temp.cleanup()

    def invoke(self,tool,**arguments):
        resp=self.client.post("/mcp",headers=self.rpc_headers,json={
            "jsonrpc":"2.0","id":100,"method":"tools/call",
            "params":{"name":tool,"arguments":arguments}
        })
        self.assertEqual(resp.status_code,200,resp.text)
        return resp.json()

    def latest_id(self):
        return self.client.get("/api/v1/dashboard/tool-history",
                               headers=self.headers).json()["items"][0]["id"]

    def test_real_mcp_call_persists_useful_body_but_not_token(self):
        body="Check auth.go:31; sample <script>alert(1)</script>"
        response=self.invoke("send_message",**self.credentials,to="Review",
                             text=body,task_id="auth-review")
        self.assertFalse(response["result"].get("isError",False))
        history=self.client.get("/api/v1/dashboard/tool-history",
                                headers=self.headers)
        self.assertNotIn(body,history.text) # metadata list only
        self.assertNotIn(self.credentials["token"],history.text)
        call_id=self.latest_id()
        detail=self.client.get(f"/api/v1/dashboard/tool-history/{call_id}",
                               headers=self.headers)
        self.assertEqual(detail.status_code,200,detail.text)
        self.assertIn("no-store",detail.headers["cache-control"])
        data=detail.json()
        self.assertEqual(data["tool_name"],"send_message")
        self.assertEqual(data["agent_id"],self.credentials["agent_id"])
        self.assertEqual(data["arguments"]["text"],body)
        self.assertEqual(data["arguments"]["to"],"Review")
        self.assertEqual(data["arguments"]["task_id"],"auth-review")
        self.assertEqual(data["arguments"]["token"],"[REDACTED]")
        self.assertEqual(data["arguments_truncated"],False)
        self.assertNotIn(self.credentials["token"],detail.text)
        # Safe before storage, not merely masked in the HTTP view.
        row=self.store.db.execute(
            "SELECT arguments_json FROM tool_calls WHERE id=?", (call_id,)
        ).fetchone()[0]
        self.assertNotIn(self.credentials["token"],row)
        self.assertIn(body,row)
        self.assertNotIn(body,str(history.json()))

    def test_invalid_token_masked_and_not_attributed(self):
        claimed=self.a["agent"]["agent_id"]
        bad="bad-secret-token-should-not-persist"
        result=self.invoke("heartbeat",agent_id=claimed,token=bad)
        self.assertTrue(result["result"]["isError"])
        call=self.store.tool_call_detail(self.latest_id())
        self.assertIsNone(call["agent_id"])
        self.assertEqual(call["arguments"]["agent_id"],claimed)
        self.assertEqual(call["arguments"]["token"],"[REDACTED]")
        self.assertNotIn(bad,json.dumps(call))
        with self.store.lock:
            raw=self.store.db.execute(
                "SELECT arguments_json FROM tool_calls WHERE id=?", (call["id"],)
            ).fetchone()[0]
        self.assertNotIn(bad,raw)

    def test_nested_redaction_and_echoed_known_token_in_body(self):
        secret=self.credentials["token"]
        arguments={
            "agent_id":self.credentials["agent_id"],
            "token":secret,
            "text":"Raw " + secret + " inside body",
            "nested":{"authorization":"Bearer xyz","config":{
                "access_token":"hidden-value",
                "items":[{"api_key":"hidden-key"},{"safe":"visible"}]}},
        }
        self.store.record_tool_call("demo","ok",1.5,self.credentials["agent_id"],
                                    arguments=arguments)
        detail=self.store.tool_call_detail(self.latest_id())
        raw=self.store.db.execute(
            "SELECT arguments_json FROM tool_calls WHERE id=?", (detail["id"],)
        ).fetchone()[0]
        self.assertNotIn(secret,raw)
        self.assertNotIn("hidden-value",raw)
        self.assertNotIn("hidden-key",raw)
        self.assertNotIn("Bearer xyz",raw)
        self.assertEqual(detail["arguments"]["text"],
                         "Raw [REDACTED] inside body")
        self.assertEqual(detail["arguments"]["nested"]["config"]["items"][1]["safe"],
                         "visible")

    def test_nested_and_aliased_secrets_cannot_reappear_in_other_fields(self):
        # A secret field can be nested in a list or use an alias recognized
        # by the shared redaction predicate, not only top-level "token".
        nested_secret = "NESTED_SECRET_123456789"
        alias_secret = "ALIAS_SECRET_987654321"
        payload = {
            "meta": {"credentials": [{"access_token": nested_secret}]},
            "client_secret": alias_secret,
            "text": f"copy {nested_secret} and {alias_secret}",
            "memo": ["plain", f"again:{nested_secret}"],
        }
        self.store.record_tool_call("demo", "ok", 1.2, arguments=payload)
        detail = self.store.tool_call_detail(self.latest_id())
        self.assertEqual(detail["arguments"]["meta"]["credentials"][0]
                         ["access_token"], "[REDACTED]")
        self.assertEqual(detail["arguments"]["client_secret"], "[REDACTED]")
        self.assertEqual(detail["arguments"]["text"],
                         "copy [REDACTED] and [REDACTED]")
        self.assertEqual(detail["arguments"]["memo"][1], "again:[REDACTED]")
        with self.store.lock:
            stored = self.store.db.execute(
                "SELECT arguments_json FROM tool_calls WHERE id=?",
                (detail["id"],)
            ).fetchone()[0]
        self.assertNotIn(nested_secret, stored)
        self.assertNotIn(alias_secret, stored)

    def test_escape_heavy_truncated_payload_never_exceeds_cap(self):
        for character in ("\\", '"', "\n", "🔒"):
            with self.subTest(character=repr(character)):
                data, truncated = Store._safe_tool_arguments({
                    "body": character * 200_000
                })
                self.assertEqual(truncated, 1)
                self.assertLessEqual(len(data.encode("utf-8")),
                                     MAX_TOOL_ARGUMENT_BYTES)
                decoded = json.loads(data)
                self.assertTrue(decoded["_truncated"])
                self.assertIsInstance(decoded["_preview"], str)

    def test_cap_retention_legacy_migration_and_pagination(self):
        # File DB migration from an existing pre-upgrade tool_calls table.
        legacy_path=Path(self.temp.name)/"legacy.db"
        db=sqlite3.connect(legacy_path)
        db.execute("""CREATE TABLE tool_calls(
            id INTEGER PRIMARY KEY AUTOINCREMENT,tool_name TEXT NOT NULL,
            agent_id TEXT,status TEXT NOT NULL,duration_ms REAL NOT NULL,
            created_at REAL NOT NULL)""")
        db.execute("INSERT INTO tool_calls(tool_name,status,duration_ms,created_at) "
                   "VALUES('old','ok',1.5,123.0)")
        db.commit()
        db.close()
        legacy=Store(legacy_path)
        self.assertIsNone(legacy.tool_call_detail(1)["arguments"])
        self.assertEqual(legacy.tool_call_detail(1)["status"],"ok")
        legacy.close()

        big="🔒"*(MAX_TOOL_ARGUMENT_BYTES//3)
        self.store.record_tool_call("long","ok",1.0,arguments={"body":big})
        call=self.store.tool_call_detail(self.latest_id())
        self.assertTrue(call["arguments_truncated"])
        self.assertTrue(call["arguments"]["_truncated"])
        row=self.store.db.execute("SELECT arguments_json FROM tool_calls "
                                  "WHERE id=?",(call["id"],)).fetchone()[0]
        self.assertLessEqual(len(row.encode("utf-8")),MAX_TOOL_ARGUMENT_BYTES)
        for i in range(101):
            self.store.record_tool_call("audit","ok",1.0,arguments={"index":i})
        self.assertEqual(self.store.tool_history()["total"],100)
        with self.assertRaisesRegex(ValueError,"not found"):
            self.store.tool_call_detail(call["id"])

    def test_admin_only_detail_rejects_cross_site_and_missing(self):
        cid=self.latest_id() if self.store.tool_history()["total"] else 1
        paths=[f"/api/v1/dashboard/tool-history/{cid}",
               "/api/v1/dashboard/tool-history/999999"]
        for path in paths:
            self.assertEqual(self.client.get(path).status_code,401)
            self.assertEqual(self.client.get(path,headers={
                "X-Agent-Id":self.credentials["agent_id"],
                "X-Agent-Token":self.credentials["token"]
            }).status_code,401)
            self.assertEqual(self.client.get(path,headers={
                **self.headers,"Origin":"https://attacker.example"
            }).status_code,403)
            self.assertEqual(self.client.get(path,headers={
                **self.headers,"Sec-Fetch-Site":"cross-site"
            }).status_code,403)
            self.assertEqual(self.client.get(path,headers=self.headers).status_code,404)
        self.assertEqual(self.client.get(
            "/api/v1/dashboard/tool-history/bad",headers=self.headers
        ).status_code,422)


if __name__=="__main__":
    unittest.main()
