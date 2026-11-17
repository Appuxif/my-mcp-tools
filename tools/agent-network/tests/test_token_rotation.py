"""Administrator rotation: hash-only persistence, explicit revocation, no leaks."""
from __future__ import annotations
import json
import sqlite3
import tempfile
import unittest
from pathlib import Path

from fastapi.testclient import TestClient
from agent_network.server import Config, create_app
from auth_helpers import basic_headers


class TokenRotationTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.path = Path(self.tmp.name) / 'api.db'
        self.app = create_app(Config(database=str(self.path)))
        self.cm = TestClient(self.app, base_url='http://127.0.0.1:8787')
        self.client = self.cm.__enter__()
        self.basic = basic_headers(self.app)
        self.agent = self.client.post('/api/v1/dashboard/agents',headers=self.basic,json={
            'name':'Existing-Developer', 'role':'developer','kind':'codex','teams':['Ops'],
        }).json()
        self.aid = self.agent['agent']['agent_id']
        self.old = self.agent['token']
        self.url = f'/api/v1/dashboard/agents/{self.aid}/credentials/rotate'

    def tearDown(self):
        self.cm.__exit__(None,None,None)
        self.tmp.cleanup()

    def test_rotation_invalidate_old_credentials_and_keep_agent_data(self):
        store = self.app.state.store
        store.save_context(self.aid,self.old,'# Keep the context')
        before = store._teams(self.aid)
        unauthorized = self.client.post(self.url)
        self.assertEqual(unauthorized.status_code,401)
        for headers, expected in (
            ({**self.basic,'Origin':'https://other.example'},403),
            ({**self.basic,'Host':'other.example'},400),
            ({'X-Agent-Id':self.aid,'X-Agent-Token':self.old},401),
        ):
            self.assertEqual(self.client.post(self.url,headers=headers).status_code,expected)
        self.assertEqual(self.client.get(
            f'/api/v1/dashboard/agents/{self.aid}/credentials',
            headers=self.basic).status_code,404)
        response = self.client.post(self.url,headers=self.basic)
        self.assertEqual(response.status_code,200,response.text)
        self.assertIn('no-store', response.headers['cache-control'])
        result = response.json()
        self.assertEqual(result['agent_id'],self.aid)
        self.assertEqual(result['name'],'Existing-Developer')
        self.assertNotEqual(result['token'],self.old)
        self.assertTrue(len(result['token']) >= 40)
        with self.assertRaises(PermissionError):
            store.verify(self.aid,self.old)
        self.assertEqual(store.verify(self.aid,result['token'])['agent_id'],self.aid)
        self.assertEqual(store._teams(self.aid),before)
        self.assertEqual(store.read_context(self.aid,result['token'])['context'],
                         '# Keep the context')
        with sqlite3.connect(self.path) as c:
            columns = {col[1] for col in c.execute('PRAGMA table_info(agents)')}
            self.assertIn('token_hash',columns)
            self.assertNotIn('token_ciphertext',columns)
            values = json.dumps(c.execute('SELECT * FROM agents').fetchall())
            self.assertNotIn(self.old,values)
            self.assertNotIn(result['token'],values)
        snapshot = self.client.get('/api/v1/dashboard',headers=self.basic)
        self.assertNotIn(result['token'],snapshot.text)
        self.assertNotIn(self.old,snapshot.text)

    def test_each_explicit_rotation_generates_a_fresh_token(self):
        first = self.client.post(self.url, headers=self.basic).json()['token']
        second = self.client.post(self.url, headers=self.basic).json()['token']
        self.assertNotEqual(first,second)
        with self.assertRaises(PermissionError):
            self.app.state.store.verify(self.aid,first)
        self.app.state.store.verify(self.aid,second)

    def test_unknown_agent_cannot_rotate(self):
        response = self.client.post(
            '/api/v1/dashboard/agents/does-not-exist/credentials/rotate',
            headers=self.basic)
        self.assertEqual(response.status_code,404)


if __name__=='__main__':
    unittest.main()
