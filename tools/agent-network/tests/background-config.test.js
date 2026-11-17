const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function createBackground() {
  const key='https://chatgpt.com/c/test';
  const data = {agentsByChat:{}, serverByTab:{}};
  const event = {addListener() {}};
  const chrome = {
    webRequest: {onBeforeRequest:event, onCompleted:event, onErrorOccurred:event},
    runtime: {onMessage:event, onStartup:event, onInstalled:event},
    tabs:{
      onRemoved:event,onUpdated:event,
      async get(id){return {id,url:key};},
      async query(){return [{id:9,url:key}]},
    },
    alarms: {create() {}, onAlarm:event},
    storage: {local:{
      async get(keys) {
        if (Array.isArray(keys))
          return Object.fromEntries(keys.filter(k => k in data).map(k => [k,data[k]]));
        return typeof keys === 'string' ? {[keys]:data[keys]} : data;
      },
      async set(update) {Object.assign(data,update);},
      async remove(key){delete data[key];}
    }}
  };
  const context = vm.createContext({
    console, chrome, URL,
    importScripts() {},
    AgentNetworkTraffic:{
      TrafficTracker:class{started(){} finished(){} clear(){}},
      combineState(dom) {return {state:dom};}
    },
  });
  const script = fs.readFileSync(path.join(__dirname,'../extension/background.js'),'utf8');
  vm.runInContext(script, context);
  const evaluate = expression => vm.runInContext(expression,context);
  return {data,evaluate,key};
}

test('server URLs accept HTTPS remotes, HTTP loopback/private only', () => {
  const {evaluate} = createBackground();
  assert.equal(evaluate("normalizeServer('http://127.0.0.1:8787/')"),
               'http://127.0.0.1:8787');
  assert.equal(evaluate("normalizeServer('https://agents.example.com/')"),
               'https://agents.example.com');
  assert.equal(evaluate("normalizeServer('http://192.168.10.5:8000')"),
               'http://192.168.10.5:8000');
  assert.equal(evaluate("socketUrl('https://agents.example.com')"),
               'wss://agents.example.com/api/v1/channels/ws');
  for (const url of [
    'http://agents.example.com', 'https://user:pass@example.com',
    'https://example.com/api', 'https://example.com/?apiKey=secret',
    'file:///tmp/file', 'not a url'
  ]) {
    assert.throws(() => evaluate('normalizeServer(' + JSON.stringify(url) + ')'));
  }
});

test('server is saved per tab and an inactive identity is reset on change', async () => {
  const {data,evaluate,key} = createBackground();
  await evaluate("setServer(9, 'https://agents.example.com')");
  assert.equal(data.serverByTab[9], 'https://agents.example.com');
  assert.equal(data.defaultServer, 'https://agents.example.com');
  data.agentsByChat[key] = {
    name:'test',active:false,chatUrl:key,server:'https://agents.example.com'
  };
  await evaluate("setServer(9, 'http://127.0.0.1:8787')");
  assert.equal(data.agentsByChat[key], undefined);
  assert.equal(data.serverByTab[9], 'http://127.0.0.1:8787');
  data.agentsByChat[key] = {
    name:'test',active:true,chatUrl:key,server:'http://127.0.0.1:8787'
  };
  await assert.rejects(evaluate("setServer(9, 'https://agents.example.com')"));
  assert.equal(data.serverByTab[9], 'http://127.0.0.1:8787');
  assert.equal(data.agentsByChat[key].name,'test');
});

test('popup validates server origins before requesting Chrome permission', () => {
  const context = vm.createContext({
    document: {addEventListener() {}},
    URL,
  });
  const script = fs.readFileSync(path.join(__dirname,'../extension/popup.js'),'utf8');
  vm.runInContext(script, context);
  const parse = url => vm.runInContext('parseServer(' + JSON.stringify(url) + ')',context);
  assert.equal(parse('https://agents.example.com/'),'https://agents.example.com');
  assert.equal(parse('http://127.0.0.1:8787'),'http://127.0.0.1:8787');
  assert.equal(parse('http://192.168.1.5:7777'),'http://192.168.1.5:7777');
  assert.throws(()=>parse('http://agents.example.com'));
  assert.throws(()=>parse('https://example.com/admin'));
  assert.throws(()=>parse('ftp://example.com'));
});
