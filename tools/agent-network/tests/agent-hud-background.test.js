const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const AgentNetworkStatus = require('../extension/agent-status.js');

const chatA = 'https://chatgpt.com/c/aaa';
const chatB = 'https://chatgpt.com/c/bbb';
function createWorker() {
  let onMessage, requests=0;
  const data={agentsByTab:{
    10:{name:'alpha',agentId:'agent-A',role:'coder',active:true,
        token:'AGENT_SECRET',server:'http://127.0.0.1:8787',chatUrl:chatA},
    20:{name:'beta',agentId:'agent-B',role:'reviewer',active:true,
        token:'SECOND_SECRET',server:'http://127.0.0.1:8787',chatUrl:chatB}
  }};
  const pages = {
    10:{id:10,url:chatA},
    20:{id:20,url:chatB}
  };
  const hook={addListener(fn){if(fn){} }};
  const snapshot={
    agents:[
      {agent_id:'agent-A',name:'alpha',role:'coder',pending_messages:2,
       task_status:'working',last_mcp_activity:100},
      {agent_id:'agent-B',name:'beta',role:'reviewer',pending_messages:9},
    ],
    channels:[{agent_id:'agent-A',connected:1,state:'idle',last_seen:100}],
    edges:[{source:'agent-A',target:'agent-B',recent_count:3,
            pending_count:0,last_message_at:88}],
    recent:[{
      sender_id:'agent-A',recipient_id:'agent-B',sender_name:'alpha',recipient_name:'beta',
      created_at:88,status:'acknowledged',body:'SECRET_MESSAGE_BODY'
    }],
    server:{now:105},
  };
  const chrome={
    webRequest:{onBeforeRequest:hook,onCompleted:hook,onErrorOccurred:hook},
    alarms:{create(){},onAlarm:hook},
    runtime:{onStartup:hook,onInstalled:hook,onMessage:{addListener(fn){onMessage=fn;}}},
    tabs:{
      onRemoved:hook,onUpdated:hook,
      async get(id){return pages[id]},
      async sendMessage(){return {state:'idle',network:'idle',activeRequests:0}},
      async create(){},
    },
    scripting:{async executeScript(){}},
    storage:{local:{
      async get(keys) {
        if(Array.isArray(keys)) return Object.fromEntries(keys.filter(key=>key in data).map(key=>[key,data[key]]));
        return {[keys]:data[keys]};
      },
      async set(update){Object.assign(data,update);}
    }}
  };
  const context=vm.createContext({
    chrome,URL,console,AgentNetworkStatus,
    WebSocket:class {static OPEN=1},
    AgentNetworkTraffic:{
      TrafficTracker:class{started(){} finished(){} clear(){} snapshot(){return {phase:'idle',activeRequests:0}}},
      combineState(dom){return {state:dom}}
    },
    importScripts(){},
    fetch:async url=>{
      requests++;
      assert.equal(url,'http://127.0.0.1:8787/api/v1/dashboard');
      return {ok:true,async json(){return snapshot}};
    },
    AbortSignal, Date, Promise, setInterval(){return 1}, clearInterval(){},
  });
  const code=fs.readFileSync(path.join(__dirname,'../extension/background.js'),'utf8');
  vm.runInContext(code,context);
  async function request(message, sender) {
    return new Promise(resolve=>onMessage(message,sender,resolve));
  }
  return {request,data,pages,get requests(){return requests}};
}

test('per-tab HUD gets only own metadata, not agent credentials or message bodies',async()=>{
  const bg=createWorker();
  const a=await bg.request({type:'network:hud-status',tabId:20},{
    tab:{id:10,url:chatA},frameId:0
  });
  assert.equal(a.ok,true);
  assert.equal(a.visible,true);
  assert.equal(a.agentId,'agent-A');
  assert.equal(a.name,'alpha');
  assert.equal(a.status.pending,2);
  assert.equal(a.status.sent24h,3);
  assert.equal(a.status.lastOutbound.peer,'beta');
  const response=JSON.stringify(a);
  assert.equal(response.includes('AGENT_SECRET'),false);
  assert.equal(response.includes('SECOND_SECRET'),false);
  assert.equal(response.includes('SECRET_MESSAGE_BODY'),false);
  assert.equal(response.includes('agent-B'),false);
});

test('wrong frames, unbound tabs and changed conversations cannot inspect HUD',async()=>{
  const bg=createWorker();
  for(const sender of [
    {tab:{id:10,url:chatA},frameId:1},
    {tab:{id:404,url:chatA},frameId:0},
    {tab:{id:10,url:'https://chatgpt.com/c/different'},frameId:0},
    {tab:{id:10,url:'https://malicious.example/c/aaa'},frameId:0},
    {},
  ]) {
    const result=await bg.request({type:'network:hud-status',tabId:20},sender);
    assert.equal(result.ok,true);
    assert.equal(result.visible,false);
  }
  assert.equal(bg.requests,0,'invalid tabs must not trigger server requests');
});

test('multiple agent tabs share one short-lived snapshot fetch',async()=>{
  const bg=createWorker();
  const a=await bg.request({type:'network:hud-status'},{tab:{id:10,url:chatA},frameId:0});
  const b=await bg.request({type:'network:hud-status'},{tab:{id:20,url:chatB},frameId:0});
  assert.equal(bg.requests,1);
  assert.equal(a.status.name,'alpha');
  assert.equal(b.status.name,'beta');
  assert.equal(b.status.pending,9);
});
