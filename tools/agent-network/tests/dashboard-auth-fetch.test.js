const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '../dashboard');

test('HTTP Basic credentials in page URL must never enter fetch request URLs', () => {
  const pageUrl = 'http://admin:private-password@127.0.0.1:8787/dashboard';
  const origin = new URL(pageUrl).origin;
  assert.match(new URL('/api/v1/dashboard', pageUrl).href, /admin:private-password/);
  const target = new URL('/api/v1/dashboard', origin).href;
  assert.equal(target, 'http://127.0.0.1:8787/api/v1/dashboard');
  assert.equal(new URL(target).username, '');
  assert.equal(new URL(target).password, '');
});

test('all dashboard fetch call sites construct URL against credential-free origin', () => {
  const targets = {
    'dashboard.js': "fetch(new URL('/api/v1/dashboard', location.origin).href,",
    'dashboard-interactions.js': 'fetch(new URL(url, location.origin).href,',
    'dashboard-conversations.js': 'fetch(new URL(url, location.origin).href,',
  };
  for (const [file, expression] of Object.entries(targets)) {
    const source = fs.readFileSync(path.join(root, file), 'utf8');
    assert.ok(source.includes(expression), file + ' must normalize its fetch URL');
  }
});
