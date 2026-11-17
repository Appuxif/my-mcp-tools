const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

const SOURCE = fs.readFileSync(path.join(__dirname,'../extension/background.js'),'utf8');
const CONVERSATION='6af61821-13e8-83eb-a4eb-548737722538';
const PROJECT='https://chatgpt.com/g/g-p-6af61be7a30c8191a28628b8c44f715b-blender-edu/c/'+CONVERSATION;
const PLAIN='https://chatgpt.com/c/'+CONVERSATION;
const OTHER='https://chatgpt.com/c/6afc8b42-4bc8-83ed-8236-589f43d07958';

function networkHarness({legacy=null,initial=null,urls=[PROJECT,PLAIN]}={}) {
  const data = {
    agentsByChat:initial || {},
    agentsByTab:legacy || {},
    defaultServer:'http://127.0.0.1:8787',
    serverByTab:{}
  };
  const tabs = new Map(urls.map((url,i)=>[i+10,{id:i+10,url}]));
  const events=[],sockets=[],listeners={};
  const hook=name=>({addListener(fn){listeners[name]=fn;}});
  const chrome={
    webRequest:{onBeforeRequest:hook('before'),onCompleted:hook('done'),onErrorOccurred:hook('failed')},
    alarms:{create(){},onAlarm:hook('alarm')},
    runtime:{
      onStartup:hook('startup'),onInstalled:hook('installed'),
      onMessage:hook('message')
    },
    tabs:{
      onRemoved:hook('removed'),onUpdated:hook('updated'),
      async get(id){return tabs.get(Number(id));},
      async query(){return [...tabs.values()];},
      async sendMessage(tabId,message){
        events.push({kind:'tabMessage',tabId,type:message.type,body:message});
        switch(message.type) {
          case 'agent:probe':return {state:'idle'};
          case 'agent:send': return {ok:true,submitted:true};
          case 'network:hud-show':return {ok:true};
          default: throw Error('Unexpected tab message '+message.type);
        }
      },
      async create(){},
    },
    scripting:{async executeScript(){events.push({kind:'inject'});}},
    storage:{local:{
      async get(keys){
        if(Array.isArray(keys))return Object.fromEntries(keys.filter(k=>k in data).map(k=>[k,data[k]]));
        return {[keys]:data[keys]};
      },
      async set(changes){Object.assign(data,changes);},
      async remove(key){delete data[key];},
    }},
  };
  class Socket {
    static OPEN=1;
    readyState=1;
    constructor(url){
      this.url=url;this.closed=false;sockets.push(this);
      events.push({kind:'socket',url});
    }
    close(){this.closed=true;this.readyState=3;}
    send(payload){events.push({kind:'socketSend',payload:JSON.parse(payload)});}
  }
  let created=0;
  const fetch=async (url,options)=>{
    events.push({kind:'http',url,method:options.method});
    if(url.endsWith('/api/v1/agents/register')){
      created++;
      return {ok:true,status:200,async json(){return {
        agent:{agent_id:'uuid-identity-1'},token:'PRIVATE_AGENT_SECRET'
      }}};
    }
    if(url.endsWith('/api/v1/agents/profile')){
      return {ok:true,status:200,async json(){return {agent_id:'uuid-identity-1'}}};
    }
    throw Error('Unexpected endpoint '+url);
  };
  const context=vm.createContext({
    chrome,URL,console,fetch,WebSocket:Socket,AbortSignal,
    Promise,importScripts(){},setInterval(){return 1},clearInterval(){},
    AgentNetworkTraffic:{
      TrafficTracker:class{started(){}finished(){}clear(){}snapshot(){return {phase:'idle',activeRequests:0}}},
      combineState(dom){return {state:dom}},
    }
  });
  vm.runInContext(SOURCE,context);
  const request=(tabId,type,extra={})=>
    new Promise(resolve=>listeners.message({type,tabId,...extra},
      {tab:tabs.get(tabId),frameId:0},resolve));
  const start=tabId=>request(tabId,'network:start',{profile:{
    name:'Same-Agent',role:'Developer',purpose:'Testing',description:'',
  }});
  const tick=async()=>{
    for(let i=0;i<12;i++)await new Promise(resolve=>setImmediate(resolve));
  };
  return {data,tabs,sockets,events,context,request,start,tick,
    close:async tabId=>{
      tabs.delete(tabId);listeners.removed(tabId);await tick();
    },
    navigate:async(tabId,url)=>{
      const tab=tabs.get(tabId);tab.url=url;
      listeners.updated(tabId,{url});await tick();
    },
    open:(tabId,url)=>{tabs.set(tabId,{id:tabId,url});},
    get registrations(){return created;}
  };
}

test('ChatGPT project-prefixed and plain routes resolve to the same canonical identity',()=>{
  const h=networkHarness({urls:[]});
  const key=url=>vm.runInContext('chatKey('+JSON.stringify(url)+')',h.context);
  assert.equal(key(PROJECT),PLAIN);
  assert.equal(key(PLAIN),PLAIN);
  assert.equal(key(PLAIN+'?ref=sidebar#message-1'),PLAIN);
  assert.equal(key(OTHER),OTHER);
  assert.notEqual(key(OTHER),key(PROJECT));
  assert.equal(key('https://chatgpt.com/'),null);
  assert.equal(key('https://evil.example/c/'+CONVERSATION),null);
  assert.equal(key('https://chatgpt.com/c/'),null);
});

test('same conversation in two tabs shares one agent identity and one PUSH socket',async()=>{
  const h=networkHarness();
  const started=await h.start(10);
  assert.equal(started.ok,true);
  assert.equal(started.created,true);
  assert.equal(h.registrations,1);
  assert.equal(h.sockets.length,1);
  assert.equal(h.data.agentsByChat[PLAIN].name,'Same-Agent');
  assert.equal(h.data.agentsByChat[PLAIN].ownerTabId,10);
  assert.equal(h.data.agentsByChat[PLAIN].chatUrl,PLAIN);
  assert.equal(h.events.filter(e=>e.type==='agent:send').length,1);

  const clone=await h.request(11,'network:status');
  assert.equal(clone.entry.name,'Same-Agent');
  assert.equal(clone.entry.agentId,'uuid-identity-1');
  assert.equal(clone.entry.active,true);
  assert.equal(clone.entry.bootstrapDone,true);
  assert.equal(clone.connected,true);

  const repeated=await h.start(11);
  assert.equal(repeated.ok,true);
  assert.equal(repeated.created,false);
  assert.equal(h.registrations,1);
  assert.equal(h.sockets.length,1);
  assert.equal(h.events.filter(e=>e.type==='agent:send').length,1);

  const shown=await h.request(11,'network:show-hud');
  assert.equal(shown.ok,true);
  const message=h.events.filter(e=>e.type==='network:hud-show').at(-1).body;
  assert.equal(message.name,'Same-Agent');
  assert.equal(message.agentId,'uuid-identity-1');
  assert.equal(message.chatUrl,PLAIN);
  assert.equal(JSON.stringify(message).includes('PRIVATE_AGENT_SECRET'),false);
});

test('closing PUSH owner transfers to another tab but retains one logical identity',async()=>{
  const h=networkHarness();
  await h.start(10);
  assert.equal(h.sockets.length,1);
  await h.close(10);
  assert.equal(h.sockets[0].closed,true);
  assert.equal(h.sockets.length,2,'other chat tab should take over');
  assert.equal(h.data.agentsByChat[PLAIN].ownerTabId,11);
  assert.equal(h.registrations,1);
  assert.equal((await h.request(11,'network:status')).entry.name,'Same-Agent');
  await h.close(11);
  assert.equal(h.data.agentsByChat[PLAIN].active,true,'registration survives closing all tabs');
  assert.equal(h.data.agentsByChat[PLAIN].ownerTabId,null);
  h.open(12,PROJECT);
  await h.navigate(12,PROJECT);
  assert.equal(h.sockets.length,3);
  assert.equal(h.data.agentsByChat[PLAIN].ownerTabId,12);
  assert.equal(h.registrations,1);
});

test('navigating an owner to another conversation preserves original identity',async()=>{
  const h=networkHarness();
  await h.start(10);
  await h.navigate(10,OTHER);
  assert.equal(h.sockets[0].closed,true);
  assert.equal(h.sockets.length,2);
  assert.equal(h.data.agentsByChat[PLAIN].ownerTabId,11);
  assert.equal(h.data.agentsByChat[PLAIN].name,'Same-Agent');
  assert.equal((await h.request(10,'network:status')).entry,null);
  assert.equal((await h.request(11,'network:status')).entry.name,'Same-Agent');
});

test('stopping from secondary tab stops shared identity and existing PUSH owner',async()=>{
  const h=networkHarness();
  await h.start(10);
  const response=await h.request(11,'network:stop');
  assert.equal(response.ok,true);
  assert.equal(h.data.agentsByChat[PLAIN].active,false);
  assert.equal(h.sockets[0].closed,true);
  assert.equal((await h.request(10,'network:status')).entry.active,false);
  assert.equal((await h.request(11,'network:status')).entry.active,false);
  await h.start(11);
  assert.equal(h.data.agentsByChat[PLAIN].ownerTabId,11);
  assert.equal(h.sockets.length,2);
  assert.equal(h.registrations,1);
});

test('one-time migration preserves tab-bound agent records under conversation URLs',async()=>{
  const h=networkHarness({legacy:{
    10:{
      name:'Migrated',agentId:'agent-old',token:'OLDEST_TOKEN',
      role:'Worker',server:'http://127.0.0.1:8787',
      chatUrl:PROJECT,active:true,bootstrapDone:true,
    }
  }});
  await h.tick();
  assert.equal(h.data.agentsByTab,undefined);
  assert.equal(h.data.agentsByChat[PLAIN].name,'Migrated');
  assert.equal(h.data.agentsByChat[PLAIN].agentId,'agent-old');
  assert.equal(h.data.agentsByChat[PLAIN].ownerTabId,10);
  const other=await h.request(11,'network:status');
  assert.equal(other.entry.name,'Migrated');
  assert.equal(other.entry.bootstrapDone,true);
  assert.equal(h.registrations,0,'migration must not register another identity');
  assert.equal(h.sockets.length,1);
});

test('simultaneous Start clicks in two tabs create only one ChatGPT agent',async()=>{
  const h=networkHarness();
  const [a,b]=await Promise.all([h.start(10),h.start(11)]);
  assert.equal(a.ok,true);
  assert.equal(b.ok,true);
  assert.equal(h.registrations,1);
  assert.equal(h.sockets.length,1);
  assert.equal(h.events.filter(e=>e.type==='agent:send').length,1);
  assert.equal((await h.request(11,'network:status')).entry.agentId,'uuid-identity-1');
});

test('the popup Show action cannot create a HUD for an unregistered conversation',async()=>{
  const h=networkHarness();
  const result=await h.request(10,'network:show-hud');
  assert.equal(result.ok,false);
  assert.match(result.error,/Сначала зарегистрируй/);
  assert.equal(h.events.filter(e=>e.type==='network:hud-show').length,0);
});
