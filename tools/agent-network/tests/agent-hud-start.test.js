const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

const SOURCE = fs.readFileSync(path.join(__dirname, '../extension/background.js'), 'utf8');
const CHAT = 'https://chatgpt.com/c/test-agent';
const ADMIN_SECRET = 'TEST_ADMIN_SECRET_'.repeat(4);

function startHarness({hudInstalled=true,registrationError=false,existing=false}={}) {
  const events=[];
  const hooks={addListener(){}};
  const original={
    name:'Alice',role:'Developer',purpose:'Tests',description:'',
    agentId:'a1',token:'SECRET_NOT_FOR_HUD',server:'http://127.0.0.1:8787',
    chatUrl:CHAT,ownerTabId:7,active:false,bootstrapDone:true,
  };
  const data={
    agentsByChat:existing ? {[CHAT]:original} : {},
    serverByTab:{},defaultServer:'http://127.0.0.1:8787',
    adminTokenByServer:{'http://127.0.0.1:8787':ADMIN_SECRET},
  };
  const tab={id:7,url:CHAT};
  let onMessage;
  let receiver=hudInstalled;
  const chrome={
    webRequest:{onBeforeRequest:hooks,onCompleted:hooks,onErrorOccurred:hooks},
    runtime:{onMessage:{addListener(fn){onMessage=fn;}},onStartup:hooks,onInstalled:hooks},
    alarms:{create(){},onAlarm:hooks},
    tabs:{
      onRemoved:hooks,onUpdated:hooks,
      async get(id){assert.equal(id,7);return tab;},
      async query(){return [tab];},
      async sendMessage(id,message){
        assert.equal(id,7);
        events.push({kind:'message',type:message.type,message});
        switch(message.type) {
          case 'agent:probe':return {state:'idle'};
          case 'agent:send':return {ok:true,submitted:true};
          case 'network:hud-show':
            if(!receiver) throw Error('Receiving end does not exist');
            return {ok:true};
          default:throw Error('Unexpected message: '+message.type);
        }
      },
      async create(){},
    },
    scripting:{
      async executeScript(options) {
        events.push({kind:'inject',files:options.files});
        assert.equal(options.target.tabId,7);
        receiver=true;
      },
    },
    storage:{local:{
      async setAccessLevel(){},
      async get(key) {
        if(Array.isArray(key))return Object.fromEntries(key.filter(k=>k in data).map(k=>[k,structuredClone(data[k])]));
        return {[key]:structuredClone(data[key])};
      },
      async set(update){Object.assign(data,structuredClone(update));},
      async remove(key){delete data[key];}
    }},
  };
  class MockSocket {
    static OPEN=1;
    readyState=0;
    close(){this.readyState=3;}
    constructor(url) {
      events.push({kind:'socket',url});
    }
  }
  const fetch=async (url,options)=>{
    assert.equal(options.method,'POST');
    events.push({kind:'fetch',url});
    if(url.endsWith('/api/v1/admin/chatgpt-agents')) {
      assert.equal(options.headers['X-Agent-Network-Admin-Token'],ADMIN_SECRET);
      if(registrationError)return {ok:false,status:503,async json(){return {detail:'Unavailable'}}};
      return {ok:true,status:200,async json(){return {agent:{agent_id:'a1',kind:'chatgpt',name:'Alice',role:'Developer',purpose:'Tests',description:'',teams:[]},token:'SECRET_NOT_FOR_HUD',token_id:'test-token-id'}}};
    }
    if(url.endsWith('/api/v1/agents/profile')) {
      return {ok:true,status:200,async json(){return {agent_id:'a1'}}};
    }
    throw Error('Unexpected HTTP request: '+url);
  };
  const context=vm.createContext({
    chrome,URL,console,WebSocket:MockSocket,fetch,AbortSignal,Promise,
    importScripts(){},setInterval(){return 1},clearInterval(){},
    AgentNetworkTraffic:{
      TrafficTracker:class {started(){}finished(){}clear(){}snapshot(){return {phase:'idle',activeRequests:0}}},
      combineState(state){return {state}},
    },
  });
  vm.runInContext(SOURCE,context);
  const request=message=>new Promise(resolve=>onMessage(message,{tab},resolve));
  const start=()=>new Promise(resolve=>onMessage({type:'network:start',tabId:7,profile:{
    name:'Alice',role:'Developer',purpose:'Tests',description:'',
  }},{},resolve));
  return {events,data,start,request};
}

test('Start registers the chat without showing the floating HUD',async()=>{
  const x=startHarness();
  const result=await x.start();
  assert.equal(result.ok,true);
  assert.equal(result.created,true);
  assert.equal(x.events.filter(e=>e.type==='network:hud-show').length,0);
  assert.equal(x.events.filter(e=>e.kind==='inject').length,0);
  assert.equal(x.events.filter(e=>e.type==='agent:send').length,0);
  assert.equal(x.data.agentsByChat[CHAT].active,true);
  assert.equal(x.data.agentsByChat[CHAT].bootstrapDone,true);
});

test('Explicit popup Show injects HUD scripts if the tab has no receiver',async()=>{
  const x=startHarness({hudInstalled:false});
  assert.equal((await x.start()).ok,true);
  assert.equal(x.events.filter(e=>e.kind==='inject').length,0);
  const shown=await x.request({type:'network:show-hud',tabId:7});
  assert.equal(shown.ok,true);
  assert.equal(shown.visible,true);
  const injected=x.events.find(e=>e.kind==='inject');
  assert.deepEqual(Array.from(injected.files),['agent-status.js','agent-hud.js']);
  assert.equal(x.events.filter(e=>e.type==='network:hud-show').length,2);
  const firstShow=x.events.find(e=>e.type==='network:hud-show');
  assert.equal(firstShow.message.name,'Alice');
  assert.equal(firstShow.message.agentId,'a1');
  assert.equal(firstShow.message.chatUrl,CHAT);
  assert.equal(JSON.stringify(firstShow).includes('SECRET_NOT_FOR_HUD'),false);
});

test('Start resumes existing conversation identity but keeps HUD hidden',async()=>{
  const x=startHarness({existing:true});
  const result=await x.start();
  assert.equal(result.ok,true);
  assert.equal(result.created,false);
  assert.equal(x.events.filter(e=>e.type==='network:hud-show').length,0);
  assert.equal(x.events.filter(e=>e.type==='agent:send').length,0);
  assert.ok(x.events.some(e=>e.url?.endsWith('/api/v1/agents/profile')));
  const status=await x.request({type:'network:status',tabId:7});
  assert.equal(status.entry.name,'Alice');
});

test('Failed registration never emits a HUD show signal',async()=>{
  const x=startHarness({registrationError:true});
  const result=await x.start();
  assert.equal(result.ok,false);
  assert.equal(x.events.filter(e=>e.type==='network:hud-show').length,0);
  assert.equal(x.events.filter(e=>e.type==='agent:send').length,0);
});
