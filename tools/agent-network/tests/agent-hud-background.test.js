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
  const data={agentsByChat:{
    [chatA]:{name:'alpha',agentId:'agent-A',role:'coder',active:true,
        token:'AGENT_SECRET',server:'http://127.0.0.1:8787',chatUrl:chatA,ownerTabId:10},
    [chatB]:{name:'beta',agentId:'agent-B',role:'reviewer',active:true,
        token:'SECOND_SECRET',server:'http://127.0.0.1:8787',chatUrl:chatB,ownerTabId:20}
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
      async query(){return Object.values(pages)},
      async sendMessage(){return {state:'idle',network:'idle',activeRequests:0}},
      async create(){},
    },
    scripting:{async executeScript(){}},
    storage:{local:{
      async setAccessLevel(){},
      async get(keys) {
        if(Array.isArray(keys)) return Object.fromEntries(keys.filter(key=>key in data).map(key=>[key,data[key]]));
        return {[keys]:structuredClone(data[keys])};
      },
      async set(update){Object.assign(data,structuredClone(update));},
      async remove(key){delete data[key];}
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
    fetch:async (url,options)=>{
      requests++;
      const parsed=new URL(url);
      const id=options.headers['X-Agent-Id'];
      assert.equal(options.headers['X-Agent-Token'],
        id==='agent-A'?'AGENT_SECRET':'SECOND_SECRET');
      assert.ok(parsed.pathname.startsWith('/api/v1/agents/'));
      if (parsed.pathname === '/api/v1/agents/conversations') return {
        ok:true,async json(){return {
          agent_id:id,items:[{
            peer_id:id==='agent-A'?'agent-B':'agent-A',
            peer_name:id==='agent-A'?'beta':'alpha',
            message_count:2,pending_for_agent:1
          }]
        }}
      };
      if (parsed.pathname.startsWith('/api/v1/agents/conversations/')) {
        const peer=parsed.pathname.split('/')[5];
        if(peer !== (id==='agent-A'?'agent-B':'agent-A'))
          return {ok:false,status:404,async json(){return {detail:'Conversation not found'}}};
        return {ok:true,async json(){return {
          agent_id:id,peer_id:peer,items:[{
            message_id:'m1',sender_id:id,recipient_id:peer,
            sender_name:id==='agent-A'?'alpha':'beta',
            body:'SCOPED_PRIVATE_CHAT',created_at:100,status:'pending'
          }],has_more:false,next_cursor:null
        }}};
      }
      assert.equal(parsed.pathname,'/api/v1/agents/hud');
      const agent=snapshot.agents.find(a=>a.agent_id===id);
      const others=snapshot.agents.filter(a=>a.agent_id!==id)
        .map(a=>({agent_id:a.agent_id,name:a.name}));
      const view={
        ...snapshot,agents:[agent,...others],
        channels:snapshot.channels.filter(c=>c.agent_id===id),
        edges:snapshot.edges.filter(e=>e.source===id||e.target===id),
        recent:snapshot.recent.filter(m=>m.sender_id===id||m.recipient_id===id)
      };
      return {ok:true,async json(){return view}};
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

test('different agents fetch separate scoped views and cache repeated calls',async()=>{
  const bg=createWorker();
  const a=await bg.request({type:'network:hud-status'},{tab:{id:10,url:chatA},frameId:0});
  const b=await bg.request({type:'network:hud-status'},{tab:{id:20,url:chatB},frameId:0});
  assert.equal(bg.requests,2);
  const a2=await bg.request({type:'network:hud-status'},{tab:{id:10,url:chatA},frameId:0});
  assert.equal(bg.requests,2);
  assert.equal(a2.status.name,'alpha');
  assert.equal(a.status.name,'alpha');
  assert.equal(b.status.name,'beta');
  assert.equal(b.status.pending,9);
});

test('HUD conversation requests use ONLY the sender-tab identity, never a requested agent ID',async()=>{
  const bg=createWorker();
  const sender={tab:{id:10,url:chatA},frameId:0};
  const list=await bg.request({type:'network:hud-conversations',tabId:20,agentId:'agent-B'},sender);
  assert.equal(list.ok,true);
  assert.equal(list.agent_id,'agent-A');
  assert.deepEqual(Array.from(list.items.map(x=>x.peer_id)),['agent-B']);
  const history=await bg.request({type:'network:hud-messages',peerId:'agent-B',
                                  agentId:'agent-B',tabId:20,limit:30},sender);
  assert.equal(history.ok,true);
  assert.equal(history.agent_id,'agent-A');
  assert.equal(history.items[0].body,'SCOPED_PRIVATE_CHAT');
  assert.equal(JSON.stringify(history).includes('AGENT_SECRET'),false);
});

test('HUD chat requests reject unbound frames, unrelated peers and invalid cursors',async()=>{
  const bg=createWorker();
  const initial=bg.requests;
  for(const sender of [
    {tab:{id:10,url:chatA},frameId:1},
    {tab:{id:404,url:chatA},frameId:0},
    {tab:{id:10,url:chatB},frameId:0},
    {tab:{id:10,url:'https://evil.example/c/aaa'},frameId:0},
  ]) {
    const out=await bg.request({type:'network:hud-conversations'},sender);
    assert.equal(out.ok,false);
  }
  assert.equal(bg.requests,initial);
  const sender={tab:{id:10,url:chatA},frameId:0};
  for(const message of [
    {type:'network:hud-messages',peerId:'../admin'},
    {type:'network:hud-messages',peerId:'agent-B',before:'?x=evil'},
    {type:'network:hud-messages',peerId:'agent-B',limit:51},
  ]) {
    const out=await bg.request(message,sender);
    assert.equal(out.ok,false);
  }
  assert.equal(bg.requests,initial);
  const other=await bg.request({type:'network:hud-messages',peerId:'agent-C'},sender);
  assert.equal(other.ok,false);
  assert.match(other.error,/Conversation not found/);
  bg.pages[10].url=chatB;
  const stale=await bg.request({type:'network:hud-messages',peerId:'agent-B'},sender);
  assert.equal(stale.ok,false);
  assert.match(stale.error,/tab has changed/);
});
