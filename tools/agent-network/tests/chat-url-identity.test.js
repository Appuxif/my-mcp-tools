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

function networkHarness({
  legacy=null,initial=null,urls=[PROJECT,PLAIN],
  newChatCreatesId=true,failMigrationSend=false,verifyFails=false,
  registrationDelay=0,
}={}) {
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
      async get(id){return structuredClone(tabs.get(Number(id)));},
      async query(){return [...tabs.values()];},
      async sendMessage(tabId,message){
        events.push({kind:'tabMessage',tabId,type:message.type,body:message});
        switch(message.type) {
          case 'agent:probe':return {state:'idle'};
          case 'agent:send': {
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
                 a?.token===options.headers['X-Agent-Token']);
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
    Promise,setTimeout,importScripts(){},setInterval(){return 1},clearInterval(){},
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
