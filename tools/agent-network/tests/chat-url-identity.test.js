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
const ADMIN_TEST_TOKEN='TEST_ADMIN_SECRET_'.repeat(4);

function networkHarness({
  legacy=null,initial=null,urls=[PROJECT,PLAIN],
  newChatCreatesId=true,failMigrationSend=false,verifyFails=false,
  registrationDelay=0,sendDelay=0,socketStartsOpen=true,noAdmin=false,
  rotatedToken=null,remoteAgentIds=null,registryFails=false,networkDown=false,
}={}) {
  const data = {
    agentsByChat:initial || {},
    agentsByTab:legacy || {},
    defaultServer:'http://127.0.0.1:8787',
    serverByTab:{},
    ...(noAdmin ? {} : {adminTokenByServer:{'http://127.0.0.1:8787':ADMIN_TEST_TOKEN}}),
  };
  const tabs = new Map(urls.map((url,i)=>[i+10,{id:i+10,url}]));
  const events=[],sockets=[],listeners={},intervals=new Map();
  const adminTeamMembership=new Map();
  let storageAccessLevel=null;
  let nextIntervalId=1;
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
      async get(id){return structuredClone(tabs.get(Number(id)));},
      async query(){return [...tabs.values()];},
      async sendMessage(tabId,message){
        events.push({kind:'tabMessage',tabId,type:message.type,body:message});
        switch(message.type) {
          case 'agent:probe':return {state:'idle'};
          case 'agent:send': {
            if(sendDelay) await new Promise(resolve=>setTimeout(resolve,sendDelay));
            if (message.allowNewChat && failMigrationSend)
              return {ok:false,error:'Composer is busy'};
            if(message.allowNewChat && newChatCreatesId) {
              const next='https://chatgpt.com/c/00000000-0000-0000-0000-000000000999';
              tabs.get(Number(tabId)).url=next;
              listeners.updated(Number(tabId),{url:next});
            }
            return {ok:true,submitted:true};
          }
          case 'network:hud-show':return {ok:true};
          default: throw Error('Unexpected tab message '+message.type);
        }
      },
      async create(){},
    },
    scripting:{async executeScript(){events.push({kind:'inject'});}},
    storage:{local:{
      async setAccessLevel(options){storageAccessLevel=options.accessLevel;},
      async get(keys){
        if(Array.isArray(keys))return Object.fromEntries(
          keys.filter(k=>k in data).map(k=>[k,structuredClone(data[k])])
        );
        return {[keys]:structuredClone(data[keys])};
      },
      async set(changes){Object.assign(data,structuredClone(changes));},
      async remove(key){delete data[key];},
    }},
  };
  class Socket {
    static CONNECTING=0;
    static OPEN=1;
    static CLOSED=3;
    readyState=socketStartsOpen ? 1 : 0;
    constructor(url){
      this.url=url;this.closed=false;sockets.push(this);
      events.push({kind:'socket',url});
    }
    open(){
      if(this.closed)throw Error('Socket already closed');
      this.readyState=Socket.OPEN;
      this.onopen?.();
    }
    close(){
      this.closed=true;this.readyState=Socket.CLOSED;
      this.onclose?.();
    }
    serverClose(){this.close();}
    fail(){
      this.onerror?.(new Error('Connection lost'));
      this.serverClose();
    }
    receive(payload){this.onmessage?.({data:JSON.stringify(payload)});}
    send(payload){
      if(this.readyState!==Socket.OPEN)throw Error('Socket is not open');
      events.push({kind:'socketSend',payload:JSON.parse(payload)});
    }
  }
  let created=0;
  const fetch=async (url,options)=>{
    events.push({kind:'http',url,method:options.method});
    if(networkDown) throw Error('Server unreachable');
    if(url.endsWith('/api/v1/admin/agent-ids')) {
      if(registryFails) return {ok:false,status:503,async json(){return {detail:'Unavailable'}}};
      if(options.headers['X-Agent-Network-Admin-Token']!==ADMIN_TEST_TOKEN)
        return {ok:false,status:403,async json(){return {detail:'Invalid admin token'}}};
      const ids=remoteAgentIds || Object.values(data.agentsByChat)
        .filter(a=>a?.agentId).map(a=>a.agentId);
      return {ok:true,status:200,async json(){return {agent_ids:ids}}};
    }
    if(url.endsWith('/api/v1/admin/teams') ||
       url.endsWith('/api/v1/admin/me/teams')) {
      if(options.headers['X-Agent-Network-Admin-Token']!==ADMIN_TEST_TOKEN)
        return {ok:false,status:403,async json(){return {detail:'Invalid administrator token'}}};
      const available=[{team_id:'default',name:'default'},
        {team_id:'dev',name:'Dev'},{team_id:'qa',name:'QA'}];
      if(url.endsWith('/api/v1/admin/teams'))
        return {ok:true,status:200,async json(){return {items:available}}};
      const agentId=options.headers['X-Agent-Id'];
      const token=options.headers['X-Agent-Token'];
      if(!agentId || token!=='PRIVATE_AGENT_SECRET')
        return {ok:false,status:403,async json(){return {detail:'Invalid agent token'}}};
      if(options.method==='PUT') {
        const teams=JSON.parse(options.body).teams;
        adminTeamMembership.set(agentId,teams.map(name=>({team_id:name,name})));
        return {ok:true,status:200,async json(){
          return {agent_id:agentId,teams:adminTeamMembership.get(agentId)};
        }};
      }
      return {ok:true,status:200,async json(){
        return {agent_id:agentId,
                teams:adminTeamMembership.get(agentId)||[{team_id:'default',name:'default'}]};
      }};
    }
    if(url.endsWith('/api/v1/agents/register')){
      if(options.headers['X-Agent-Network-Admin-Token']!==ADMIN_TEST_TOKEN)
        return {ok:false,status:403,async json(){return {detail:'Invalid admin token'}}};
      if(registrationDelay) await new Promise(resolve=>setTimeout(resolve,registrationDelay));
      created++;
      const id='uuid-identity-'+created;
      return {ok:true,status:200,async json(){return {
        agent:{agent_id:id},token:'PRIVATE_AGENT_SECRET'
      }}};
    }
    if(url.endsWith('/api/v1/agents/hud')){
      if(verifyFails) return {ok:false,status:403,async json(){return {detail:'Invalid token'}}};
      const agent=Object.values(data.agentsByChat)
        .find(a=>a?.agentId===options.headers['X-Agent-Id'] &&
                 (remoteAgentIds===null || remoteAgentIds.includes(a.agentId)) &&
                 (a?.token===options.headers['X-Agent-Token'] ||
                  (rotatedToken && rotatedToken===options.headers['X-Agent-Token'])));
      return {ok:!!agent,status:agent?200:403,async json(){
        return agent?{agents:[{agent_id:agent.agentId,name:agent.name}]}:{detail:'Invalid token'};
      }};
    }
    if(url.endsWith('/api/v1/agents/profile')){
      return {ok:true,status:200,async json(){return {agent_id:'uuid-identity-1'}}};
    }
    throw Error('Unexpected endpoint '+url);
  };
  const context=vm.createContext({
    chrome,URL,console,fetch,WebSocket:Socket,AbortSignal,
    Promise,setTimeout,importScripts(){},
    setInterval(fn){const id=nextIntervalId++;intervals.set(id,fn);return id;},
    clearInterval(id){intervals.delete(id);},
    AgentNetworkTraffic:{
      TrafficTracker:class{started(){}finished(){}clear(){}snapshot(){return {phase:'idle',activeRequests:0}}},
      combineState(dom){return {state:dom}},
    }
  });
  vm.runInContext(SOURCE,context);
  const request=(tabId,type,extra={})=>
    new Promise(resolve=>listeners.message({type,tabId,...extra},
      {tab:tabs.get(tabId),frameId:0},resolve));
  const popupRequest=(tabId,type,extra={})=>
    new Promise(resolve=>listeners.message({type,tabId,...extra},{},resolve));
  const start=tabId=>request(tabId,'network:start',{profile:{
    name:'Same-Agent',role:'Developer',purpose:'Testing',description:'',
  }});
  const tick=async()=>{
    for(let i=0;i<12;i++)await new Promise(resolve=>setImmediate(resolve));
  };
  return {data,tabs,sockets,events,context,request,popupRequest,start,tick,
    get storageAccessLevel(){return storageAccessLevel;},
    close:async tabId=>{
      tabs.delete(tabId);listeners.removed(tabId);await tick();
    },
    navigate:async(tabId,url)=>{
      const tab=tabs.get(tabId);tab.url=url;
      listeners.updated(tabId,{url});await tick();
    },
    alarm:async()=>{listeners.alarm({name:'agent-network-resume'});await tick();},
    ping:async()=>{for(const fn of intervals.values())fn();await tick();},
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

test('migration preview lists only locally owned identities and preserves their profile',async()=>{
  const h=networkHarness({urls:[PROJECT,OTHER]});
  await h.start(10);
  const options=await h.request(11,'network:available-agents');
  assert.equal(options.ok,true);
  assert.equal(options.items.length,1);
  const agent=options.items[0];
  assert.equal(agent.name,'Same-Agent');
  assert.equal(agent.role,'Developer');
  assert.equal(agent.purpose,'Testing');
  assert.equal(agent.chatUrl,PLAIN);
  assert.equal(JSON.stringify(options).includes('PRIVATE_AGENT_SECRET'),false);
  const preview=await h.request(11,'network:migration-preview',{name:'Same-Agent'});
  assert.equal(preview.ok,true);
  assert.equal(preview.migrate,true);
  assert.equal(preview.fromChatUrl,PLAIN);
  assert.equal(preview.toChatUrl,OTHER);
  assert.equal(preview.agentId,'uuid-identity-1');
  assert.equal(JSON.stringify(preview).includes('PRIVATE_AGENT_SECRET'),false);
  assert.equal((await h.request(11,'network:migration-preview',{name:'Somebody-Else'})).ok,false);
});

test('authoritative admin snapshot removes deleted agents from local Chrome storage',async()=>{
  const stale='https://chatgpt.com/c/stale-agent';
  const otherServer='https://chatgpt.com/c/other-server';
  const base={name:'Chopper-Reviewer',role:'Reviewer',purpose:'Review',description:'',
              token:'PRIVATE_AGENT_SECRET',active:false,server:'http://127.0.0.1:8787'};
  const h=networkHarness({urls:[OTHER],remoteAgentIds:['live-reviewer'],initial:{
    [PLAIN]:{...base,agentId:'deleted-reviewer',chatUrl:PLAIN},
    [stale]:{...base,agentId:'live-reviewer',chatUrl:stale},
    [otherServer]:{...base,agentId:'different-server',chatUrl:otherServer,
                   server:'https://elsewhere.example'},
  }});
  const result=await h.popupRequest(10,'network:available-agents');
  assert.equal(result.ok,true,result.error);
  assert.deepEqual(Array.from(result.items.map(a=>a.agentId)),['live-reviewer']);
  assert.equal(h.data.agentsByChat[PLAIN],undefined,'deleted registration is purged');
  assert.equal(h.data.agentsByChat[stale].agentId,'live-reviewer');
  assert.equal(h.data.agentsByChat[otherServer].agentId,'different-server');
  const preview=await h.popupRequest(10,'network:migration-preview',{
    name:'Chopper-Reviewer',agentId:'live-reviewer'
  });
  assert.equal(preview.ok,true,preview.error);
  assert.equal(preview.agentId,'live-reviewer');
  assert.equal(preview.fromChatUrl,stale);
});

test('deletion of an agent bound to the current chat triggers popup status refresh',async()=>{
  const h=networkHarness({urls:[PROJECT],remoteAgentIds:[],initial:{
    [PLAIN]:{name:'Deleted',role:'Reviewer',agentId:'deleted-id',
      token:'PRIVATE_AGENT_SECRET',chatUrl:PLAIN,server:'http://127.0.0.1:8787',
      active:false},
  }});
  assert.equal((await h.popupRequest(10,'network:status')).entry.agentId,'deleted-id');
  const result=await h.popupRequest(10,'network:available-agents');
  assert.equal(result.removedCurrent,true);
  assert.equal(result.canMigrate,true);
  assert.equal(h.data.agentsByChat[PLAIN],undefined);
  assert.equal((await h.popupRequest(10,'network:status')).entry,null);
});

test('without admin token, inaccessible agents are hidden but never deleted',async()=>{
  const h=networkHarness({urls:[OTHER],noAdmin:true,remoteAgentIds:['live-reviewer'],initial:{
    [PLAIN]:{name:'Reviewer',role:'R',agentId:'deleted-reviewer',token:'PRIVATE_AGENT_SECRET',
             chatUrl:PLAIN,server:'http://127.0.0.1:8787'},
    ['https://chatgpt.com/c/live']:{name:'Reviewer',role:'R',agentId:'live-reviewer',
             token:'PRIVATE_AGENT_SECRET',chatUrl:'https://chatgpt.com/c/live',
             server:'http://127.0.0.1:8787'},
  }});
  const response=await h.popupRequest(10,'network:available-agents');
  assert.equal(response.ok,true);
  assert.deepEqual(Array.from(response.items.map(a=>a.agentId)),['live-reviewer']);
  assert.ok(h.data.agentsByChat[PLAIN],'invalid token may be rotated, preserve record');
});

test('offline registry reconciliation does not delete local identities',async()=>{
  const h=networkHarness({urls:[OTHER],networkDown:true,initial:{
    [PLAIN]:{name:'Reviewer',role:'R',agentId:'locally-saved',token:'TOKEN',
             chatUrl:PLAIN,server:'http://127.0.0.1:8787'},
  }});
  const available=await h.popupRequest(10,'network:available-agents');
  assert.equal(available.ok,true);
  assert.equal(available.items[0].agentId,'locally-saved');
  assert.ok(h.data.agentsByChat[PLAIN]);
});

test('migration preview targets exact ID when local names collide',async()=>{
  const h=networkHarness({urls:[OTHER],initial:{
    [PLAIN]:{name:'Reviewer',role:'R',agentId:'one',token:'PRIVATE_AGENT_SECRET',
             chatUrl:PLAIN,server:'http://127.0.0.1:8787'},
    ['https://chatgpt.com/c/second']:{name:'Reviewer',role:'R',agentId:'two',
             token:'PRIVATE_AGENT_SECRET',chatUrl:'https://chatgpt.com/c/second',
             server:'http://127.0.0.1:8787'},
  }});
  assert.equal((await h.popupRequest(10,'network:migration-preview',
    {name:'Reviewer'})).ok,false,'ambiguous name must remain rejected');
  const exact=await h.popupRequest(10,'network:migration-preview',
    {name:'Reviewer',agentId:'two'});
  assert.equal(exact.ok,true,exact.error);
  assert.equal(exact.agentId,'two');
});

test('confirmed migration moves the SAME agent to a different existing conversation',async()=>{
  const h=networkHarness({urls:[PROJECT,OTHER]});
  await h.start(10);
  const oldId=h.data.agentsByChat[PLAIN].agentId;
  const preview=await h.request(11,'network:migration-preview',{name:'Same-Agent'});
  const migrated=await h.request(11,'network:migrate',{
    agentId:preview.agentId,fromChatUrl:preview.fromChatUrl,
    expectedDestination:preview.toChatUrl
  });
  assert.equal(migrated.ok,true,migrated.error);
  assert.equal(migrated.migrated,true);
  assert.equal(migrated.agentId,oldId);
  assert.equal(h.registrations,1,'migration cannot register another agent');
  assert.equal(h.data.agentsByChat[PLAIN],undefined);
  assert.equal(h.data.agentsByChat[OTHER].agentId,oldId);
  assert.equal(h.data.agentsByChat[OTHER].name,'Same-Agent');
  assert.equal(h.data.agentsByChat[OTHER].role,'Developer');
  assert.equal(h.data.agentsByChat[OTHER].bootstrapDone,true);
  assert.equal(h.data.agentsByChat[OTHER].ownerTabId,11);
  assert.equal(h.sockets[0].closed,true);
  assert.equal(h.sockets.length,2);
  const newPrompt=h.events.filter(e=>e.type==='agent:send').at(-1).body;
  assert.match(newPrompt.text,/EXISTING Agent Network identity/);
  assert.match(newPrompt.text,/Prior ChatGPT conversation history was not copied/);
  assert.match(newPrompt.text,/read_context\(agent_id, token\)/);
  assert.match(newPrompt.text,/read_instructions\(agent_id, token\)/);
  assert.match(newPrompt.text,/Use save_context only when the user explicitly asks/);
  assert.match(newPrompt.text,/agent_id: uuid-identity-1/);
  assert.match(newPrompt.text,/token: PRIVATE_AGENT_SECRET/);
  assert.equal(newPrompt.allowNewChat,false);
  assert.equal((await h.request(10,'network:status')).entry,null);
  assert.equal((await h.request(11,'network:status')).entry.agentId,oldId);
});

test('migration into a brand-new blank ChatGPT tab waits for first conversation ID',async()=>{
  const h=networkHarness({urls:[PROJECT,'https://chatgpt.com/']});
  await h.start(10);
  const preview=await h.request(11,'network:migration-preview',{name:'Same-Agent'});
  assert.equal(preview.needsNewChat,true);
  const migrated=await h.request(11,'network:migrate',{
    agentId:preview.agentId,fromChatUrl:preview.fromChatUrl,
    expectedDestination:preview.toChatUrl
  });
  assert.equal(migrated.ok,true,migrated.error);
  assert.equal(migrated.toChatUrl,'https://chatgpt.com/c/00000000-0000-0000-0000-000000000999');
  assert.equal(h.tabs.get(11).url,migrated.toChatUrl);
  assert.equal(h.data.agentsByChat[PLAIN],undefined);
  assert.equal(h.data.agentsByChat[migrated.toChatUrl].agentId,preview.agentId);
  assert.equal(h.registrations,1);
  assert.equal(h.events.filter(e=>e.type==='agent:send').at(-1).body.allowNewChat,true);
  assert.equal(h.sockets.length,2);
});

test('migration can bootstrap into a project new-chat URL without a conversation ID',async()=>{
  const projectRoot='https://chatgpt.com/g/g-p-6af61be7a30c8191a28628b8c44f715b-blender-edu';
  const h=networkHarness({urls:[PLAIN,projectRoot]});
  await h.start(10);
  const preview=await h.request(11,'network:migration-preview',{name:'Same-Agent'});
  assert.equal(preview.ok,true,preview.error);
  const outcome=await h.request(11,'network:migrate',{
    agentId:preview.agentId,fromChatUrl:preview.fromChatUrl,
    expectedDestination:preview.toChatUrl
  });
  assert.equal(outcome.ok,true,outcome.error);
  assert.equal(h.registrations,1);
});

test('failed token validation leaves old binding and PUSH untouched',async()=>{
  const h=networkHarness({urls:[PROJECT,OTHER],verifyFails:true});
  await h.start(10);
  const preview=await h.request(11,'network:migration-preview',{name:'Same-Agent'});
  const result=await h.request(11,'network:migrate',{
    agentId:preview.agentId,fromChatUrl:preview.fromChatUrl,
    expectedDestination:preview.toChatUrl
  });
  assert.equal(result.ok,false);
  assert.match(result.error,/подтвердить доступ/);
  assert.equal(h.sockets[0].closed,false);
  assert.equal(h.data.agentsByChat[PLAIN].active,true);
  assert.equal(h.data.agentsByChat[OTHER],undefined);
  assert.equal(h.registrations,1);
  assert.equal(h.events.filter(e=>e.type==='agent:send').length,1);
});

test('failed new chat composer preserves original identity and reconnects PUSH',async()=>{
  const h=networkHarness({urls:[PROJECT,'https://chatgpt.com/'],failMigrationSend:true});
  await h.start(10);
  const preview=await h.request(11,'network:migration-preview',{name:'Same-Agent'});
  const result=await h.request(11,'network:migrate',{
    agentId:preview.agentId,fromChatUrl:preview.fromChatUrl,
    expectedDestination:preview.toChatUrl
  });
  assert.equal(result.ok,false);
  assert.match(result.error,/Composer is busy/);
  assert.equal(h.data.agentsByChat[PLAIN].agentId,preview.agentId);
  assert.equal(h.data.agentsByChat[PLAIN].active,true);
  assert.equal(h.data.agentsByChat[OTHER],undefined);
  assert.equal(h.sockets[0].closed,true);
  assert.equal(h.sockets.length,2,'old PUSH owner is reconnected');
  assert.equal(h.registrations,1);
});

test('cannot migrate over an already registered chat or with wrong expected source ID',async()=>{
  const h=networkHarness({urls:[PROJECT,OTHER]});
  await h.start(10);
  const preview=await h.request(11,'network:migration-preview',{name:'Same-Agent'});
  const forged=await h.request(11,'network:migrate',{
    agentId:'wrong-id',fromChatUrl:preview.fromChatUrl,
    expectedDestination:preview.toChatUrl
  });
  assert.equal(forged.ok,false);
  assert.equal(h.data.agentsByChat[PLAIN].active,true);
  assert.equal(h.sockets.length,1);
  await h.request(11,'network:start',{profile:{
    name:'Another-Agent',role:'Reviewer',purpose:'Other',description:''
  }});
  const occupied=await h.request(11,'network:migration-preview',{name:'Same-Agent'});
  assert.equal(occupied.ok,false);
  assert.match(occupied.error,/уже есть агент/);
});

test('concurrent Start for different chats preserves both with clone-on-read Chrome Storage',async()=>{
  const h=networkHarness({urls:[PROJECT,OTHER],registrationDelay:30});
  const profile=name=>({name,role:'Developer',purpose:'',description:''});
  const [a,b]=await Promise.all([
    h.request(10,'network:start',{profile:profile('Agent-A')}),
    h.request(11,'network:start',{profile:profile('Agent-B')}),
  ]);
  assert.equal(a.ok,true,a.error);
  assert.equal(b.ok,true,b.error);
  assert.equal(h.registrations,2);
  assert.equal(h.data.agentsByChat[PLAIN].name,'Agent-A');
  assert.equal(h.data.agentsByChat[OTHER].name,'Agent-B');
  assert.notEqual(h.data.agentsByChat[PLAIN].agentId,h.data.agentsByChat[OTHER].agentId);
});

test('Stop during in-flight Start wins and closes PUSH',async()=>{
  const h=networkHarness({urls:[PROJECT,PLAIN],registrationDelay:30});
  const started=h.start(10);
  await new Promise(resolve=>setTimeout(resolve,5));
  const stopped=h.request(11,'network:stop');
  const [startResult,stopResult]=await Promise.all([started,stopped]);
  assert.equal(startResult.ok,true,startResult.error);
  assert.equal(stopResult.ok,true,stopResult.error);
  assert.equal(h.data.agentsByChat[PLAIN].active,false);
  assert.equal(h.sockets[0].closed,true);
});

test('concurrent confirmations of the same source cannot duplicate an agent',async()=>{
  const third='https://chatgpt.com/c/33333333-3333-3333-3333-333333333333';
  const h=networkHarness({urls:[PROJECT,OTHER,third]});
  await h.start(10);
  const [a,b]=await Promise.all([
    h.request(11,'network:migration-preview',{name:'Same-Agent'}),
    h.request(12,'network:migration-preview',{name:'Same-Agent'}),
  ]);
  assert.equal(a.ok,true);
  assert.equal(b.ok,true);
  const [first,second]=await Promise.all([
    h.request(11,'network:migrate',{
      agentId:a.agentId,fromChatUrl:a.fromChatUrl,expectedDestination:a.toChatUrl,
    }),
    h.request(12,'network:migrate',{
      agentId:b.agentId,fromChatUrl:b.fromChatUrl,expectedDestination:b.toChatUrl,
    }),
  ]);
  assert.equal(first.ok,true,first.error);
  assert.equal(second.ok,false);
  assert.equal(h.registrations,1);
  const owners=Object.values(h.data.agentsByChat).filter(r=>r.agentId===a.agentId);
  assert.equal(owners.length,1);
  assert.equal(owners[0].chatUrl,OTHER);
});

test('a name without a locally owned token never becomes a migration candidate',async()=>{
  const h=networkHarness({
    urls:[PROJECT,OTHER],
    initial:{[PLAIN]:{
      name:'No-Secret',role:'Developer',agentId:'some-id',
      chatUrl:PLAIN,active:true,server:'http://127.0.0.1:8787'
    }},
  });
  const available=await h.request(11,'network:available-agents');
  assert.equal(available.items.length,0);
  const preview=await h.request(11,'network:migration-preview',{name:'No-Secret'});
  assert.equal(preview.ok,false);
  assert.match(preview.error,/не найден/);
});

test('migration from ChatGPT project landing /project URL succeeds without another agent registration',async()=>{
  const destination='https://chatgpt.com/g/g-p-6af61be7a30c8191a28628b8c44f715b-blender-edu/project';
  const h=networkHarness({urls:[PLAIN,destination]});
  await h.start(10);
  const preview=await h.request(11,'network:migration-preview',{name:'Same-Agent'});
  assert.equal(preview.ok,true,preview.error);
  assert.equal(preview.needsNewChat,true);
  const result=await h.request(11,'network:migrate',{
    agentId:preview.agentId,fromChatUrl:preview.fromChatUrl,
    expectedDestination:preview.toChatUrl,
  });
  assert.equal(result.ok,true,result.error);
  assert.equal(h.registrations,1);
  assert.equal(h.data.agentsByChat[PLAIN],undefined);
  assert.equal(h.data.agentsByChat[result.toChatUrl].agentId,preview.agentId);
  assert.equal(h.events.filter(e=>e.type==='agent:send').at(-1).body.allowNewChat,true);
});


test('storage writes from two independent async paths cannot overwrite each other',async()=>{
  const h=networkHarness({urls:[]});
  // Independent copy-on-read mimics real chrome.storage.local. Without the
  // serialized updateRecords queue, the last writer destroys the first.
  const a=vm.runInContext(
    "updateRecords(entries => { entries['"+PLAIN+"']={agentId:'A'}; })",h.context);
  const b=vm.runInContext(
    "updateRecords(entries => { entries['"+OTHER+"']={agentId:'B'}; })",h.context);
  await Promise.all([a,b]);
  assert.equal(h.data.agentsByChat[PLAIN].agentId,'A');
  assert.equal(h.data.agentsByChat[OTHER].agentId,'B');
});

test('navigation while HTTP registration is in flight stores inactive recoverable identity',async()=>{
  const h=networkHarness({urls:[PLAIN,OTHER],registrationDelay:45});
  const pending=h.start(10);
  await new Promise(resolve=>setTimeout(resolve,8));
  await h.navigate(10,OTHER);
  const result=await pending;
  assert.equal(result.ok,false);
  assert.match(result.error,/Чат изменился/);
  assert.equal(h.registrations,1);
  assert.equal(h.data.agentsByChat[PLAIN].active,false);
  assert.equal(h.data.agentsByChat[PLAIN].bootstrapDone,false);
  assert.equal(h.data.agentsByChat[PLAIN].ownerTabId,null);
  assert.equal(h.sockets.length,0);
  assert.equal(h.events.filter(e=>e.type==='agent:send').length,0);
  await h.navigate(10,PLAIN);
  const retried=await h.start(10);
  assert.equal(retried.ok,true,retried.error);
  assert.equal(retried.created,false);
  assert.equal(h.registrations,1,'retry must reuse the already issued identity');
  assert.equal(h.data.agentsByChat[PLAIN].active,true);
});

test('closing the tab while registering does not create an active ghost agent',async()=>{
  const h=networkHarness({urls:[PLAIN],registrationDelay:45});
  const pending=h.start(10);
  await new Promise(resolve=>setTimeout(resolve,8));
  await h.close(10);
  const result=await pending;
  assert.equal(result.ok,false);
  assert.equal(h.registrations,1);
  assert.equal(h.data.agentsByChat[PLAIN].active,false);
  assert.equal(h.data.agentsByChat[PLAIN].bootstrapDone,false);
  assert.equal(h.data.agentsByChat[PLAIN].ownerTabId,null);
  assert.equal(h.sockets.length,0);
});

test('navigation while bootstrap is pending never marks the registration as initialized',async()=>{
  const h=networkHarness({urls:[PLAIN],sendDelay:45});
  const pending=h.start(10);
  for(let n=0;n<100 && !h.events.some(e=>e.type==='agent:send');n++)
    await new Promise(resolve=>setTimeout(resolve,1));
  assert.equal(h.events.filter(e=>e.type==='agent:send').length,1);
  await h.navigate(10,OTHER);
  const result=await pending;
  assert.equal(result.ok,false);
  assert.equal(h.data.agentsByChat[PLAIN].active,false);
  assert.equal(h.data.agentsByChat[PLAIN].bootstrapDone,false);
  assert.equal(h.data.agentsByChat[PLAIN].ownerTabId,null);
  assert.equal(h.sockets.length,0);
});

test('Start after Stop reuses identity without sending duplicate bootstrap',async()=>{
  const h=networkHarness({urls:[PLAIN]});
  await h.start(10);
  const stopped=await h.request(10,'network:stop');
  assert.equal(stopped.ok,true);
  const restarted=await h.start(10);
  assert.equal(restarted.ok,true);
  assert.equal(restarted.created,false);
  assert.equal(h.registrations,1);
  assert.equal(h.events.filter(e=>e.type==='agent:send').length,1);
  assert.equal(h.data.agentsByChat[PLAIN].active,true);
});

test('WebSocket lifecycle registers, fails, reconnects, and stops without duplicates',async()=>{
  const h=networkHarness({urls:[PLAIN,PROJECT],socketStartsOpen:false});
  const started=await h.start(10);
  assert.equal(started.ok,true,started.error);
  assert.equal(h.sockets.length,1);
  assert.equal((await h.request(10,'network:status')).connected,false);
  h.sockets[0].open();
  await h.tick();
  const sent=h.events.filter(e=>e.kind==='socketSend');
  assert.equal(sent.filter(e=>e.payload.type==='register').length,1);
  assert.equal(sent.at(-1).payload.agent_id,'uuid-identity-1');
  h.sockets[0].receive({type:'wake',wake_id:'w1',pending_count:1});
  await h.tick();
  assert.equal(h.events.filter(e=>e.type==='agent:send').length,2);
  assert.ok(h.events.some(e=>e.payload?.type==='wake_result' && e.payload.status==='submitted'));

  h.sockets[0].fail();
  await h.alarm();
  assert.equal(h.sockets.length,2,'alarm should restore connection once');
  await h.alarm();
  assert.equal(h.sockets.length,2,'second alarm cannot duplicate socket');
  h.sockets[1].open();
  await h.tick();
  assert.equal(h.events.filter(e=>e.payload?.type==='register').length,2);
  const stopped=await h.request(11,'network:stop');
  assert.equal(stopped.ok,true);
  assert.equal(h.sockets[1].closed,true);
  await h.alarm();
  assert.equal(h.sockets.length,2,'inactive agent never reconnects');
});

test('owner handover closes previous WebSocket before creating new one',async()=>{
  const h=networkHarness({urls:[PROJECT,PLAIN],socketStartsOpen:false});
  await h.start(10);
  h.sockets[0].open();
  await h.tick();
  await h.close(10);
  assert.equal(h.sockets[0].closed,true);
  assert.equal(h.sockets.length,2);
  h.sockets[1].open();
  await h.tick();
  assert.equal(h.data.agentsByChat[PLAIN].ownerTabId,11);
  assert.equal(h.events.filter(e=>e.payload?.type==='register').length,2);
  await h.alarm();
  assert.equal(h.sockets.length,2);
});


test('periodic ping stops when the agent is stopped',async()=>{
  const h=networkHarness({urls:[PLAIN],socketStartsOpen:false});
  await h.start(10);
  h.sockets[0].open();
  await h.tick();
  await h.ping();
  assert.equal(h.events.filter(e=>e.payload?.type==='ping').length,1);
  assert.equal(h.events.filter(e=>e.payload?.type==='ping')[0].payload.state,'idle');
  await h.request(10,'network:stop');
  await h.ping();
  assert.equal(h.events.filter(e=>e.payload?.type==='ping').length,1);
});

test('service worker restart resumes bound agent without registering a new identity',async()=>{
  const h=networkHarness({urls:[PLAIN]});
  await h.start(10);
  const persisted=structuredClone(h.data.agentsByChat);
  const restarted=networkHarness({urls:[PROJECT],initial:persisted,socketStartsOpen:false});
  await restarted.tick();
  assert.equal(restarted.registrations,0);
  assert.equal(restarted.sockets.length,1);
  assert.equal(restarted.data.agentsByChat[PLAIN].agentId,persisted[PLAIN].agentId);
  restarted.sockets[0].open();
  await restarted.tick();
  const registrations=restarted.events.filter(e=>e.payload?.type==='register');
  assert.equal(registrations.length,1);
  assert.equal(registrations[0].payload.agent_id,persisted[PLAIN].agentId);
  assert.equal(restarted.events.filter(e=>e.type==='agent:send').length,0);
});

test('two overlapping per-tab server preference writes do not lose updates',async()=>{
  const h=networkHarness({urls:[]});
  const a=vm.runInContext(
    "updateServerPreferences(data => { data.serverByTab[10]='https://a.example'; })",h.context);
  const b=vm.runInContext(
    "updateServerPreferences(data => { data.serverByTab[11]='https://b.example'; })",h.context);
  await Promise.all([a,b]);
  assert.equal(h.data.serverByTab[10],'https://a.example');
  assert.equal(h.data.serverByTab[11],'https://b.example');
});


test('admin-only popup can assign multiple teams; ChatGPT tab cannot use admin token',async()=>{
  const h=networkHarness();
  await h.start(10);
  assert.equal(h.storageAccessLevel,'TRUSTED_CONTEXTS');
  const tabDenied=await h.request(10,'network:admin-connect',{adminToken:ADMIN_TEST_TOKEN});
  assert.equal(tabDenied.ok,false);
  assert.match(tabDenied.error,/popup-only/);
  const invalid=await h.popupRequest(10,'network:admin-connect',{adminToken:'bad secret'});
  assert.equal(invalid.ok,false);
  const connected=await h.popupRequest(10,'network:admin-connect',{adminToken:ADMIN_TEST_TOKEN});
  assert.equal(connected.ok,true,connected.error);
  const before=await h.popupRequest(10,'network:admin-status');
  assert.equal(before.ok,true);
  assert.deepEqual(Array.from(before.agentTeams.map(t=>t.name)),['default']);
  const selected=await h.popupRequest(10,'network:admin-set-teams',{teams:['Dev','QA']});
  assert.equal(selected.ok,true,selected.error);
  assert.deepEqual(Array.from(selected.agent.teams.map(t=>t.name)),['Dev','QA']);
  const after=await h.popupRequest(10,'network:admin-status');
  assert.deepEqual(Array.from(after.agentTeams.map(t=>t.name)),['Dev','QA']);
  const denied=await h.request(10,'network:admin-set-teams',{teams:['secret']});
  assert.equal(denied.ok,false);
  assert.match(denied.error,/popup-only/);
  const prompt=h.events.find(e=>e.type==='agent:send').body.text;
  assert.equal(prompt.includes(ADMIN_TEST_TOKEN),false);
  const exposed=await h.request(10,'network:status');
  assert.equal(JSON.stringify(exposed).includes(ADMIN_TEST_TOKEN),false);
  const cleared=await h.popupRequest(10,'network:admin-clear');
  assert.equal(cleared.ok,true);
  const status=await h.popupRequest(10,'network:admin-status');
  assert.equal(status.configured,false);
  const rejected=await h.popupRequest(10,'network:admin-set-teams',{teams:['Dev']});
  assert.equal(rejected.ok,false);
});

test('popup admin-token follows server origin and is not available in another tab without auth',async()=>{
  const h=networkHarness();
  await h.start(10);
  assert.equal((await h.popupRequest(10,'network:admin-connect',
    {adminToken:ADMIN_TEST_TOKEN})).ok,true);
  const old=h.data.adminTokenByServer;
  assert.equal(old['http://127.0.0.1:8787'],ADMIN_TEST_TOKEN);
  assert.equal(Object.keys(old).length,1);
  // An unrelated tab/content script cannot read administrator status.
  const bad=await h.request(11,'network:admin-status');
  assert.equal(bad.ok,false);
  assert.match(bad.error,/popup-only/);
});

test('administrator secret never leaves the extension for a remote server',async()=>{
  const h=networkHarness({urls:[PLAIN,OTHER],noAdmin:true});
  h.data.serverByTab[11]='https://remote.example';
  const result=await h.popupRequest(11,'network:admin-connect',{
    adminToken:ADMIN_TEST_TOKEN
  });
  assert.equal(result.ok,false);
  assert.match(result.error,/локальный сервер/);
  assert.equal(h.events.some(e=>e.kind==='http' &&
    e.url.startsWith('https://remote.example/api/v1/admin')),false);
  assert.equal(h.data.adminTokenByServer,undefined);
});

test('HUD preference bridge requires a bound sender identity',async()=>{
  const h=networkHarness({urls:[PLAIN,OTHER]});
  await h.start(10);
  const agentId=h.data.agentsByChat[PLAIN].agentId;
  const saved=await h.request(10,'network:hud-preferences-set',{
    agentId,pref:{mode:'icon',x:160,y:50}
  });
  assert.equal(saved.ok,true);
  const loaded=await h.request(10,'network:hud-preferences-get',{agentId});
  assert.equal(loaded.pref.mode,'icon');
  assert.equal(loaded.pref.x,160);
  assert.equal((await h.request(10,'network:hud-preferences-get',{
    agentId:'another'
  })).ok,false);
  assert.equal((await h.request(11,'network:hud-preferences-get',{
    agentId
  })).ok,false);
});

test('new ChatGPT agent requires admin-token; no identity is created otherwise',async()=>{
  const h=networkHarness({noAdmin:true});
  const attempt=await h.start(10);
  assert.equal(attempt.ok,false);
  assert.match(attempt.error,/admin-token/);
  assert.equal(h.registrations,0);
  assert.equal(Object.keys(h.data.agentsByChat).length,0);
  assert.equal((await h.popupRequest(10,'network:admin-connect',
    {adminToken:ADMIN_TEST_TOKEN})).ok,true);
  const retry=await h.start(10);
  assert.equal(retry.ok,true,retry.error);
  assert.equal(h.registrations,1);
  const registration=h.events.find(e=>e.url.endsWith('/api/v1/agents/register'));
  assert.ok(registration);
  const bootstrap=h.events.find(e=>e.type==='agent:send').body.text;
  assert.match(bootstrap,/read_instructions\(agent_id, token\)/);
  assert.equal(bootstrap.includes(ADMIN_TEST_TOKEN),false);
});

test('popup can resend identical Start bootstrap without new registration',async()=>{
  const h=networkHarness();
  const started=await h.start(10);
  assert.equal(started.ok,true,started.error);
  const original=h.events.filter(e=>e.type==='agent:send').at(-1).body.text;
  assert.match(original,/agent_id: uuid-identity-1/);
  assert.match(original,/token: PRIVATE_AGENT_SECRET/);
  const denied=await h.request(10,'network:repeat-bootstrap');
  assert.equal(denied.ok,false);
  assert.match(denied.error,/popup/);
  const again=await h.popupRequest(10,'network:repeat-bootstrap');
  assert.equal(again.ok,true,again.error);
  assert.equal(again.agentId,'uuid-identity-1');
  const sent=h.events.filter(e=>e.type==='agent:send').at(-1);
  assert.equal(sent.body.text,original);
  assert.equal(h.registrations,1);
  assert.equal(h.data.agentsByChat[PLAIN].bootstrapDone,true);
  assert.equal(h.data.agentsByChat[PLAIN].active,true);
});

test('repeat bootstrap preserves migration-specific read_context instructions',async()=>{
  const h=networkHarness({urls:[PROJECT,OTHER]});
  const started=await h.start(10);
  assert.equal(started.ok,true,started.error);
  assert.equal(h.data.agentsByChat[PLAIN].bootstrapMigrated,false);

  const preview=await h.request(11,'network:migration-preview',{name:'Same-Agent'});
  assert.equal(preview.ok,true,preview.error);
  const transferred=await h.request(11,'network:migrate',{
    agentId:preview.agentId,
    fromChatUrl:preview.fromChatUrl,
    expectedDestination:preview.toChatUrl,
  });
  assert.equal(transferred.ok,true,transferred.error);
  assert.equal(h.data.agentsByChat[OTHER].bootstrapMigrated,true);
  const migratedText=h.events.filter(e=>e.type==='agent:send').at(-1).body.text;
  assert.match(migratedText,/read_context\(agent_id, token\)/);
  assert.match(migratedText,/Prior ChatGPT conversation history was not copied/);

  const reminder=await h.popupRequest(11,'network:repeat-bootstrap');
  assert.match(h.events.filter(e=>e.type==='agent:send').at(-1).body.text,
               /read_instructions\(agent_id, token\)/);
  assert.equal(reminder.ok,true,reminder.error);
  const repeatedText=h.events.filter(e=>e.type==='agent:send').at(-1).body.text;
  assert.equal(repeatedText,migratedText);
  assert.equal(h.registrations,1);
  assert.equal(h.data.agentsByChat[PLAIN],undefined);
  assert.equal(h.data.agentsByChat[OTHER].bootstrapMigrated,true);
});

test('waking a bound agent includes the exact agent ID and token, not admin credentials',async()=>{
  const h=networkHarness();
  await h.start(10);
  const ws=h.sockets.at(-1);
  ws.receive({type:'wake',wake_id:'w-credentials',pending_count:2});
  await h.tick();
  const wake=h.events.filter(e=>e.type==='agent:send' && e.body.wakeId==='w-credentials');
  assert.equal(wake.length,1);
  assert.match(wake[0].body.text,/agent_id: uuid-identity-1/);
  assert.match(wake[0].body.text,/token: PRIVATE_AGENT_SECRET/);
  assert.match(wake[0].body.text,/Do not register a new agent/);
  assert.equal(wake[0].body.text.includes(ADMIN_TEST_TOKEN),false);
  assert.equal(h.events.some(e=>e.payload?.type==='wake_result' &&
                              e.payload.wake_id==='w-credentials' &&
                              e.payload.status==='submitted'),true);
});

test('popup updates a rotated token only after server verification and restarts PUSH',async()=>{
  const h=networkHarness({rotatedToken:'ROTATED_TOKEN_LONG_ENOUGH_987654'});
  const started=await h.start(10);
  assert.equal(started.ok,true,started.error);
  const old=h.sockets.at(-1);
  const denied=await h.request(10,'network:update-token',
    {token:'ROTATED_TOKEN_LONG_ENOUGH_987654'});
  assert.equal(denied.ok,false);
  assert.match(denied.error,/popup/);
  const bad=await h.popupRequest(10,'network:update-token',{token:'wrong'});
  assert.equal(bad.ok,false);
  assert.equal(h.data.agentsByChat[PLAIN].token,'PRIVATE_AGENT_SECRET');
  const result=await h.popupRequest(10,'network:update-token',
    {token:'ROTATED_TOKEN_LONG_ENOUGH_987654'});
  assert.equal(result.ok,true,result.error);
  assert.equal(result.updated,true);
  assert.equal(h.data.agentsByChat[PLAIN].token,'ROTATED_TOKEN_LONG_ENOUGH_987654');
  assert.equal(old.closed,true);
  assert.equal(h.sockets.length,2);
  assert.equal(JSON.stringify(result).includes('ROTATED_TOKEN_LONG_ENOUGH_987654'),false);
  const bootstrap=await h.popupRequest(10,'network:repeat-bootstrap');
  assert.equal(bootstrap.ok,true,bootstrap.error);
  assert.match(h.events.filter(e=>e.type==='agent:send').at(-1).body.text,
    /token: ROTATED_TOKEN_LONG_ENOUGH_987654/);
});

test('resending identity is blocked when conversation navigation invalidates binding',async()=>{
  const h=networkHarness({urls:[PROJECT,OTHER]});
  await h.start(10);
  h.tabs.get(10).url=OTHER;
  const response=await h.popupRequest(10,'network:repeat-bootstrap');
  assert.equal(response.ok,false);
  assert.equal(h.events.filter(e=>e.type==='agent:send').length,1,
    'only the original bootstrap may have been sent');
});
