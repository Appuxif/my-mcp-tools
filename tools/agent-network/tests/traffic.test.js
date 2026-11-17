const { test } = require('node:test');
const assert = require('node:assert/strict');
const { TrafficTracker, completionRequest, combineState } = require('../extension/network-state.js');

const request = (requestId, path = '/backend-api/f/conversation', tabId = 3) => ({
  url: 'https://chatgpt.com' + path,
  method: 'POST',
  requestId,
  tabId,
});

test('only exact completion requests count as generation', () => {
  assert.equal(completionRequest(request('1')), true);
  assert.equal(completionRequest(request('2', '/backend-api/conversation')), true);
  assert.equal(completionRequest(request('3', '/backend-api/f/conversation/prepare')), false);
  assert.equal(completionRequest(request('4', '/backend-api/conversations')), false);
  assert.equal(completionRequest(request('5', '/realtime/wm')), false);
  assert.equal(completionRequest({...request('6'), method:'GET'}), false);
  assert.equal(completionRequest({...request('7'), url:'https://evil.example/backend-api/f/conversation'}), false);
});

test('requests are isolated per tab and independently tracked', () => {
  const tracker = new TrafficTracker({ settleMs: 100, staleMs: 1000 });
  tracker.started(request('a'), 1000);
  tracker.started(request('b'), 1010);
  tracker.started(request('c', '/backend-api/f/conversation', 4), 1015);
  assert.deepEqual(tracker.snapshot(3, 1016), { phase: 'running', activeRequests: 2 });
  tracker.finished(request('a'), 1020);
  assert.equal(tracker.snapshot(3, 1021).activeRequests, 1);
  tracker.finished(request('b'), 1030);
  assert.equal(tracker.snapshot(3, 1050).phase, 'settling');
  assert.equal(tracker.snapshot(3, 1135).phase, 'idle');
  assert.equal(tracker.snapshot(4, 1135).phase, 'running');
});

test('network overrides stale DOM but does not erase draft', () => {
  assert.equal(combineState('idle', {phase: 'running'}).state, 'busy');
  assert.equal(combineState('idle', {phase: 'settling'}).state, 'busy');
  assert.equal(combineState('draft', {phase: 'idle'}).state, 'draft');
  assert.equal(combineState('busy', {phase: 'idle'}).state, 'busy');
  assert.equal(combineState('idle', {phase: 'unknown'}).state, 'unknown');
});

test('stale in-flight request cannot accidentally mark agent idle', () => {
  const t = new TrafficTracker({staleMs:100, settleMs:20});
  t.started(request('x'), 200);
  assert.equal(t.snapshot(3, 301).phase, 'unknown');
  t.clear(3);
  assert.equal(t.snapshot(3, 301).phase, 'idle');
});
