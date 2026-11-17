"""Regression tests: one HTTP Basic login for every administrator resource."""
from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from fastapi.testclient import TestClient

from agent_network.server import Config, create_app
from auth_helpers import basic_headers


class DashboardBasicAuthTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.app = create_app(Config(database=str(Path(self.temp.name) / "auth.db")))
        self.cm = TestClient(self.app, base_url="http://127.0.0.1:8787")
        self.client = self.cm.__enter__()
        self.headers = basic_headers(self.app)

    def tearDown(self):
        self.cm.__exit__(None,None,None)
        self.temp.cleanup()

    def test_every_admin_endpoint_and_asset_requires_basic_login(self):
        protected = [
            "/dashboard", "/dashboard/", "/dashboard-assets/dashboard.js",
            "/dashboard-assets/dashboard-conversations.js",
            "/dashboard-assets/styles.css",
            "/dashboard-assets/favicon.ico",
            "/dashboard-assets/favicon-16.png",
            "/dashboard-assets/favicon-32.png",
            "/dashboard-assets/favicon-48.png",
            "/api/v1/dashboard",
            "/api/v1/dashboard/message-history",
            "/api/v1/dashboard/tool-history",
            "/api/v1/dashboard/conversations?agent_id=missing",
            "/api/v1/dashboard/conversations/missing/other/messages",
            "/api/v1/dashboard-agent/inbox",
            "/api/v1/agents",
            "/api/v1/health",
            "/docs", "/redoc", "/openapi.json",
        ]
        for url in protected:
            with self.subTest(url=url):
                denied=self.client.get(url)
                self.assertEqual(denied.status_code,401, (url,denied.text))
                self.assertIn("Basic",denied.headers.get("WWW-Authenticate",""))
                self.assertIn("no-store",denied.headers.get("Cache-Control",""))
                self.assertEqual(self.client.get(
                    url, headers={"X-Admin-Token":"untrusted"}
                ).status_code,401)
                self.assertEqual(self.client.get(url,headers={
                    "Authorization":"Bearer fake"
                }).status_code,401)
                allowed=self.client.get(url,headers=self.headers)
                if url == "/api/v1/dashboard-agent/inbox":
                    # Basic login is accepted; a separate dashboard *sender*
                    # identity is still required for its personal inbox.
                    self.assertEqual(allowed.status_code,401)
                    self.assertNotIn("WWW-Authenticate",allowed.headers)
                else:
                    self.assertNotEqual(allowed.status_code,401,(url,allowed.text))
                self.assertIn("no-store", allowed.headers.get("Cache-Control",""))

    def test_login_credentials_reject_wrong_user_or_password_and_remote_host(self):
        import base64
        password=Path(self.app.state.admin_token_file).read_text().strip()
        for username,secret in (("root",password),("admin","wrong"),
                                ("ADMIN",password),("admin","")):
            raw=base64.b64encode(f"{username}:{secret}".encode()).decode()
            res=self.client.get("/dashboard",headers={
                "Authorization":"Basic "+raw
            })
            self.assertEqual(res.status_code,401)
        self.assertEqual(self.client.get("/dashboard",headers={
            **self.headers, "Host":"evil.example"
        }).status_code,400)
        self.assertEqual(self.client.get("/dashboard",headers={
            **self.headers, "Origin":"https://evil.example"
        }).status_code,403)
        self.assertEqual(self.client.get("/dashboard",headers={
            **self.headers, "Sec-Fetch-Site":"cross-site"
        }).status_code,403)

    def test_single_login_enables_all_dashboard_functions(self):
        agent=self.client.post("/api/v1/agents/register",json={
            "name":"recipient","role":"worker","kind":"other"
        }).json()
        aid=agent["agent"]["agent_id"]
        peer=self.client.post("/api/v1/agents/register",json={
            "name":"sender","role":"worker","kind":"other"
        }).json()
        self.app.state.store.send(
            peer["agent"]["agent_id"],peer["token"],"recipient","private body"
        )
        client=self.client
        client.headers.update(self.headers)
        self.assertEqual(client.get("/dashboard").status_code,200)
        self.assertEqual(client.get("/api/v1/dashboard").status_code,200)
        self.assertEqual(client.get(
            "/api/v1/dashboard/message-history").status_code,200)
        self.assertEqual(client.get(
            "/api/v1/dashboard/tool-history").status_code,200)
        result=client.get(
            "/api/v1/dashboard/conversations?agent_id="+aid)
        self.assertEqual(result.status_code,200)
        self.assertEqual(result.json()["items"][0]["peer_name"],"sender")
        self.assertEqual(client.get(
            "/api/v1/dashboard/conversations/"+aid+"/"+
            peer["agent"]["agent_id"]+"/messages"
        ).json()["items"][0]["body"],"private body")
        dashboard=client.post("/api/v1/dashboard-agent/enable",json={
            "name":"dashboard-human"
        })
        self.assertEqual(dashboard.status_code,200)
        identity=dashboard.json()
        dash_headers={
            "X-Agent-Id":identity["agent"]["agent_id"],
            "X-Agent-Token":identity["token"],
        }
        sent=client.post("/api/v1/dashboard-agent/send",
            headers=dash_headers,json={"to":"recipient","text":"from dashboard"})
        self.assertEqual(sent.status_code,200,sent.text)
        self.assertEqual(client.delete(
            "/api/v1/dashboard/agents/"+aid
        ).status_code,200)
        # Session isn't tied to any dashboard agent; remains authorized after deletion.
        self.assertEqual(client.get("/dashboard").status_code,200)

    def test_agent_hud_is_token_scoped_without_admin_login(self):
        c=self.client
        sender=c.post("/api/v1/agents/register",json={
            "name":"alice","role":"sender role","kind":"chatgpt"
        }).json()
        recipient=c.post("/api/v1/agents/register",json={
            "name":"bob","role":"private recipient role","kind":"other"
        }).json()
        unrelated=c.post("/api/v1/agents/register",json={
            "name":"charlie","role":"sensitive third-party role","kind":"other"
        }).json()
        a,b=sender["agent"]["agent_id"],recipient["agent"]["agent_id"]
        c.app.state.store.send(a,sender["token"],"bob","SECRET BODY")
        c.app.state.store.send(unrelated["agent"]["agent_id"],unrelated["token"],
                               "bob","OTHER SECRET BODY")
        url="/api/v1/agents/hud"
        self.assertEqual(c.get(url).status_code,403)
        self.assertEqual(c.get(url,headers={
            "X-Agent-Id":a,"X-Agent-Token":"wrong"
        }).status_code,403)
        self.assertEqual(c.get(url,headers=self.headers).status_code,403)
        result=c.get(url,headers={"X-Agent-Id":a,"X-Agent-Token":sender["token"]})
        self.assertEqual(result.status_code,200,result.text)
        data=result.json()
        self.assertEqual(data["agents"][0]["name"],"alice")
        self.assertIn("bob",[row["name"] for row in data["agents"]])
        self.assertNotIn("charlie",[row["name"] for row in data["agents"]])
        self.assertEqual(data["edges"][0]["source"],a)
        self.assertEqual(data["edges"][0]["target"],b)
        self.assertEqual(data["agents"][0]["pending_messages"],0)
        self.assertNotIn("token", result.text)
        self.assertNotIn("SECRET BODY",result.text)
        self.assertNotIn("OTHER SECRET BODY",result.text)
        self.assertNotIn("sensitive third-party role",result.text)
        self.assertIn("no-store",result.headers["Cache-Control"])
        # A message history GET still requires admin login.
        self.assertEqual(c.get("/api/v1/dashboard/message-history").status_code,401)


if __name__=="__main__":
    unittest.main()
