"""Dashboard operator can send into another team only via admin-authenticated HTTP."""
from __future__ import annotations
import tempfile
import unittest
from pathlib import Path
from fastapi.testclient import TestClient
from agent_network.server import Config, create_app
from auth_helpers import basic_headers


class DashboardCrossTeamSendTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.app = create_app(Config(database=str(Path(self.tmp.name) / 'db.sqlite')))
        self.cm = TestClient(self.app, base_url='http://127.0.0.1:8787')
        self.client = self.cm.__enter__()
        self.basic = basic_headers(self.app)
        self.store = self.app.state.store
        self.recipient = self.store.register('Chopper-Developer','developer','chatgpt')
        self.recipient_id = self.recipient['agent']['agent_id']
        self.store.assign_teams(self.recipient_id,['Chopper'])
        dashboard = self.client.post('/api/v1/dashboard-agent/enable',
                                     headers=self.basic,
                                     json={'name':'dashboard'}).json()
        self.dashboard = dashboard
        self.sender_id = dashboard['agent']['agent_id']
        self.dash_headers = {
            **self.basic,
            'X-Agent-Id':self.sender_id,
            'X-Agent-Token':dashboard['token'],
        }
        self.url = '/api/v1/dashboard-agent/send'

    def tearDown(self):
        self.cm.__exit__(None, None, None)
        self.tmp.cleanup()

    def test_admin_send_adds_only_dashboard_operator_to_recipient_team(self):
        self.store.assign_teams(self.sender_id,['My MCP Tools','default'])
        self.assertFalse(self.store._shared(self.sender_id,self.recipient_id))
        body = {'to':self.recipient_id,'text':'Начинай задачу','client_message_id':'once'}
        response = self.client.post(self.url,json=body,headers=self.dash_headers)
        self.assertEqual(response.status_code,200,response.text)
        self.assertFalse(response.json()['duplicate'])
        teams = {t['name'] for t in self.store._teams(self.sender_id)}
        self.assertEqual(teams,{'default','My MCP Tools','Chopper'})
        self.assertEqual([t['name'] for t in self.store._teams(self.recipient_id)], ['Chopper'])
        self.assertEqual(len(self.store.inbox(self.recipient_id,self.recipient['token'])),1)
        mid = response.json()['message_id']
        self.assertEqual(self.store.acknowledge(self.recipient_id,self.recipient['token'],mid)['status'],
                         'acknowledged')
        # Retried POST is deduplicated, team membership does not grow.
        retry = self.client.post(self.url,json=body,headers=self.dash_headers)
        self.assertEqual(retry.status_code,200,retry.text)
        self.assertTrue(retry.json()['duplicate'])
        self.assertEqual(retry.json()['message_id'],mid)
        self.assertEqual({t['name'] for t in self.store._teams(self.sender_id)},teams)

    def test_admin_route_authentication_required_for_auto_join(self):
        data={'to':self.recipient_id,'text':'testing'}
        self.assertEqual(self.client.post(self.url,json=data).status_code,401)
        self.assertEqual(self.client.post(self.url,json=data,headers={
            'X-Agent-Id':self.sender_id,'X-Agent-Token':self.dashboard['token']
        }).status_code,401)
        self.assertEqual(self.client.post(self.url,json=data,headers={
            **self.dash_headers,'Origin':'https://evil.test'
        }).status_code,403)
        self.assertEqual(self.client.post(self.url,json=data,headers={
            **self.dash_headers,'X-Agent-Token':'wrong'
        }).status_code,403)
        self.assertFalse(self.store._shared(self.sender_id,self.recipient_id))
        self.assertEqual(self.store.db.execute('SELECT count(*) FROM messages').fetchone()[0],0)

    def test_unprivileged_mcp_agent_still_cannot_send_across_teams(self):
        other=self.store.register('MCP-Coder','developer','other')
        oid=other['agent']['agent_id']
        self.store.assign_teams(oid,['My MCP Tools'])
        with self.assertRaisesRegex(ValueError,'Recipient agent not found'):
            self.store.send(oid,other['token'],self.recipient_id,'not allowed')
        self.assertFalse(self.store._shared(oid,self.recipient_id))
        self.assertFalse(self.store.db.execute('SELECT 1 FROM messages').fetchone())

    def test_rejected_idempotency_reuse_does_not_change_team_memberships(self):
        first=self.client.post(self.url,headers=self.dash_headers,json={
            'to':self.recipient_id,'text':'initial','client_message_id':'same'
        })
        self.assertEqual(first.status_code,200)
        other=self.store.register('Other-Team-Worker','worker','other')
        oid=other['agent']['agent_id']
        self.store.assign_teams(oid,['Secret'])
        self.assertFalse(self.store._shared(self.sender_id,oid))
        rejected=self.client.post(self.url,headers=self.dash_headers,json={
            'to':oid,'text':'different','client_message_id':'same'
        })
        self.assertEqual(rejected.status_code,400)
        self.assertFalse(self.store._shared(self.sender_id,oid))
        self.assertEqual(len(self.store.inbox(oid,other['token'])),0)

    def test_dashboard_admin_can_send_to_second_team_and_recipient_reply(self):
        other=self.store.register('Second-Worker','worker','other')
        oid=other['agent']['agent_id']
        self.store.assign_teams(oid,['Ops'])
        response=self.client.post(self.url,headers=self.dash_headers,json={
            'to':oid,'text':'Hello Ops'
        })
        self.assertEqual(response.status_code,200,response.text)
        self.assertTrue(self.store._shared(self.sender_id,oid))
        reply=self.store.send(oid,other['token'],self.sender_id,'Hi Admin')
        inbox=self.client.get('/api/v1/dashboard-agent/inbox',
                              headers=self.dash_headers)
        self.assertEqual(inbox.status_code,200)
        self.assertEqual([x['message_id'] for x in inbox.json()['items']],
                         [reply['message_id']])


if __name__ == '__main__':
    unittest.main()
