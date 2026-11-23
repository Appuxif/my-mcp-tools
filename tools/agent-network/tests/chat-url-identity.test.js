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
  newChatCreatesId=true,failMigrationSend=false,failTransferBootstrap=false,
  transferConflict=false,failTransferCommit=false,ambiguousTransferCommit=false,
  commitDuringAbort=false,abortRecheckUnavailable=false,reconcileUnavailable=false,primerBusyProbes=0,primerNeverIdle=false,
  initialBusyProbes=0,probeDraftAfterPrimer=false,initialPending=null,
  initialDeferred=null,
  remoteCommittedTransfer=null,remoteForeignLease=null,verifyFails=false,
  bindForeignDuringLegacyHud=false,
  registrationDelay=0,transferCommitDelay=0,sendDelay=0,socketStartsOpen=true,noAdmin=false,
  rotatedToken=null,remoteAgentIds=null,remoteProfiles=[],registryFails=false,networkDown=false,
  remoteBindConflict=false,
}={}) {
  const data = {
    agentsByChat:initial || {},
    agentsByTab:legacy || {},
    defaultServer:'http://127.0.0.1:8787',
    serverByTab:{},
    ...(initialPending ? {pendingChatTransfers:initialPending} : {}),
    ...(initialDeferred ? {deferredChatBindings:initialDeferred} : {}),
    ...(noAdmin ? {} : {adminTokenByServer:{'http://127.0.0.1:8787':ADMIN_TEST_TOKEN}}),
  };
  const tabs = new Map(urls.map((url,i)=>[i+10,{id:i+10,url}]));
  const events=[],sockets=[],listeners={},intervals=new Map();
  const adminTeamMembership=new Map();
  let storageAccessLevel=null;
  let nextIntervalId=1;
  let remainingBusyProbes=initialBusyProbes;
  let primerSubmitted=false;
  let bindingLookupDown=false; // outage starts at commit, not at preview
  let remoteLeaseCleared=false;
  let remoteAgentDeleted=false;
  let foreignLease=remoteForeignLease;
  let foreignLeaseAfterAbort=null;
  let hudRequests=0;
  const hook=name=>({addListener(fn){listeners[name]=fn;}});
  const chrome={
    webRequest:{onBeforeRequest:hook('before'),onCompleted:hook('done'),onErrorOccurred:hook('failed')},
    alarms:{create(){},async clear(){return true;},onAlarm:hook('alarm')},
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
          case 'agent:probe':
            if(probeDraftAfterPrimer && primerSubmitted)
              return {state:'draft',reason:'composer contains user text'};
            if(remainingBusyProbes>0) {
              remainingBusyProbes--;
              return {state:'busy',reason:'stop-generation control'};
            }
            return {state:'idle'};
          case 'agent:send': {
            if(sendDelay) await new Promise(resolve=>setTimeout(resolve,sendDelay));
            if (message.allowNewChat && failMigrationSend)
              return {ok:false,error:'Composer is busy'};
            if (failTransferBootstrap && message.text?.includes('FRESH_DEST_TOKEN_FOR_'))
              return {ok:false,error:'Destination composer rejected bootstrap'};
            if(message.allowNewChat && newChatCreatesId) {
              primerSubmitted=true;
              remainingBusyProbes=primerNeverIdle?Infinity:primerBusyProbes;
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
  let delayedCommit=false;
  let legacyPrimaryValid=true;
  let legacyStatusUnavailable=false;
  let committedTransfer=remoteCommittedTransfer;
  const fetch=async (url,options)=>{
    events.push({kind:'http',url,method:options.method,body:options.body});
    if(networkDown) throw Error('Server unreachable');
    if(url.endsWith('/chat-binding') && options.method==='GET'){
      if(bindingLookupDown)
        return {ok:false,status:503,async json(){return {detail:'Lookup temporarily unavailable'}}};
      if(remoteAgentDeleted)
        return {ok:false,status:404,async json(){return {detail:'Unknown agent_id'}}};
      const id=url.split('/agents/')[1].split('/chat-binding')[0];
      if(foreignLease)
        return {ok:true,status:200,async json(){return foreignLease}};
      if(remoteLeaseCleared)
        return {ok:true,status:200,async json(){return {
          agent_id:id,token_id:null,chat_url:null,
        }}};
      const current=Object.entries(data.agentsByChat)
        .find(([,record])=>record.agentId===id);
      return {ok:true,status:200,async json(){return committedTransfer||{
        agent_id:id,token_id:current?.[1]?.chatCredentialId||null,
        chat_url:current?.[1]?.chatCredentialId?current[0]:null,
      }}};
    }
    if(url.includes('/chat-transfers')) {
      const id=url.split('/agents/')[1].split('/chat-transfers')[0];
      const transfer='transfer-'+id;
      if(url.endsWith('/chat-transfers') && options.method==='POST'){
        if(transferConflict)
          return {ok:false,status:409,async json(){return {detail:'Destination chat already bound'}}};
        const body=JSON.parse(options.body);
        if(body.admin_recovery && body.expected_source_token_id!==undefined) {
          const lease=foreignLease || (remoteLeaseCleared
            ? {token_id:null,chat_url:null}
            : Object.entries(data.agentsByChat).map(([url,record])=>({
              token_id:record.chatCredentialId||null,
              chat_url:record.chatCredentialId?url:null,
            })).find(row=>row.token_id) || {token_id:null,chat_url:null});
          if(body.expected_source_token_id!==lease.token_id ||
             body.expected_source_chat_url!==lease.chat_url)
            return {ok:false,status:409,async json(){return {
              detail:'Server chat binding changed; repeat migration preview',
            }}};
        }
        if(body.legacy_primary_token) {
          if(body.legacy_primary_token!=='PRIVATE_AGENT_SECRET' ||
             body.source_token_id || !legacyPrimaryValid)
            return {ok:false,status:409,async json(){return {detail:'Legacy primary credential changed'}}};
        }
        return {ok:true,status:200,async json(){return {
          agent_id:id,transfer_id:transfer,token_id:transfer,
          token:'FRESH_DEST_TOKEN_FOR_'+id,chat_url:body.new_chat_url,status:'prepared',
        }}};
      }
      if(url.endsWith('/commit') && options.method==='POST'){
        if(transferCommitDelay)
          await new Promise(resolve=>setTimeout(resolve,transferCommitDelay));
        if(reconcileUnavailable) bindingLookupDown=true;
        if(failTransferCommit)
          return {ok:false,status:409,async json(){return {detail:'Source binding changed during transfer'}}};
        if(commitDuringAbort) {
          delayedCommit=true;
          return {ok:false,status:503,async json(){return {detail:'Commit response delayed'}}};
        }
        const prepared=events.findLast(e=>e.url?.endsWith('/chat-transfers') &&
          e.method==='POST');
        committedTransfer={
          agent_id:id,token_id:transfer,
          chat_url:JSON.parse(prepared.body).new_chat_url,status:'committed',
        };
        if(JSON.parse(prepared.body).legacy_primary_token)
          legacyPrimaryValid=false;
        if(ambiguousTransferCommit)
          return {ok:false,status:503,async json(){return {detail:'Response lost after commit'}}};
        return {ok:true,status:200,async json(){return committedTransfer}};
      }
      if(options.method==='DELETE'){
        if(foreignLeaseAfterAbort){
          foreignLease=foreignLeaseAfterAbort;
          foreignLeaseAfterAbort=null;
          return {ok:true,status:200,async json(){return {aborted:false}}};
        }
        if(foreignLease)
          return {ok:true,status:200,async json(){return {aborted:false}}};
        if(delayedCommit && commitDuringAbort){
          const prepared=events.findLast(e=>e.url?.endsWith('/chat-transfers') &&
            e.method==='POST');
          committedTransfer={
            agent_id:id,token_id:transfer,
            chat_url:JSON.parse(prepared.body).new_chat_url,status:'committed',
          };
          delayedCommit=false;
          if(abortRecheckUnavailable) bindingLookupDown=true;
          return {ok:true,status:200,async json(){return {aborted:false}}};
        }
        return {ok:true,status:200,async json(){return {aborted:true}}};
      }
    }
    if(url.endsWith('/api/v1/admin/agents')) {
      if(registryFails) return {ok:false,status:503,async json(){return {detail:'Unavailable'}}};
      if(options.headers['X-Agent-Network-Admin-Token']!==ADMIN_TEST_TOKEN)
        return {ok:false,status:403,async json(){return {detail:'Invalid admin token'}}};
      const records=Object.values(data.agentsByChat)
        .filter(a=>a?.agentId && a.server!=='https://elsewhere.example' &&
               (remoteAgentIds===null || remoteAgentIds.includes(a.agentId)));
      return {ok:true,status:200,async json(){return {items:[
        ...records.map(a=>({agent_id:a.agentId,name:a.name,kind:'chatgpt',
          role:a.role||'',purpose:a.purpose||'',description:a.description||'',teams:[]})),
        ...remoteProfiles,
      ]}}};
    }
    if(url.includes('/chat-credentials')) {
      const id=url.split('/agents/')[1].split('/chat-credentials')[0];
      if(options.method==='POST') {
        const agent=remoteProfiles.find(a=>a.agent_id===id);
        if(!agent) return {ok:false,status:404,async json(){return {detail:'Unknown agent_id'}}};
        if(agent.kind!=='chatgpt') return {ok:false,status:400,async json(){return {detail:'Only ChatGPT agents can be bound'}}};
        if(remoteBindConflict && !JSON.parse(options.body).replace_existing)
          return {ok:false,status:409,async json(){return {detail:'Agent or chat already has an active binding'}}};
        return {ok:true,status:200,async json(){return {
          agent_id:id,token_id:'credential-'+id,token:'CHAT_BIND_TOKEN_FOR_'+id,
          agent,
        }}};
      }
      if(options.method==='DELETE') return {ok:true,status:200,async json(){return {revoked:true}}};
    }
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
    if(url.endsWith('/api/v1/admin/chatgpt-agents')){
      if(options.headers['X-Agent-Network-Admin-Token']!==ADMIN_TEST_TOKEN)
        return {ok:false,status:403,async json(){return {detail:'Invalid admin token'}}};
      if(registrationDelay) await new Promise(resolve=>setTimeout(resolve,registrationDelay));
      created++;
      const id='uuid-identity-'+created;
      return {ok:true,status:200,async json(){return {
        agent:{agent_id:id,name:JSON.parse(options.body).name,role:JSON.parse(options.body).role,
          kind:'chatgpt',purpose:JSON.parse(options.body).purpose,description:JSON.parse(options.body).description,teams:[]},
        token:'PRIVATE_AGENT_SECRET',token_id:'chat-token-'+id
      }}};
    }
    if(url.endsWith('/api/v1/agents/hud')){
      hudRequests++;
      if(bindForeignDuringLegacyHud && hudRequests>=2)
        foreignLease={agent_id:'uuid-identity-1',
          token_id:'new-external-token-C',
          chat_url:'https://chatgpt.com/c/33333333-3333-3333-3333-333333333333'};
      if(legacyStatusUnavailable)
        return {ok:false,status:503,async json(){return {detail:'Service unavailable'}}};
      if(verifyFails || (!legacyPrimaryValid &&
                         options.headers['X-Agent-Token']==='PRIVATE_AGENT_SECRET'))
        return {ok:false,status:403,async json(){return {detail:'Invalid token'}}};
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
  const start=tabId=>popupRequest(tabId,'network:start',{profile:{
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
    allowBindingLookups:()=>{bindingLookupDown=false;},
    setBindingLookupDown:value=>{bindingLookupDown=!!value;},
    setNetworkDown:value=>{networkDown=!!value;},
    rotateLegacyPrimary:()=>{legacyPrimaryValid=false;remoteLeaseCleared=true;},
    pauseLegacyAuth:()=>{legacyStatusUnavailable=true;},
    resumeLegacyAuth:()=>{legacyStatusUnavailable=false;},
    get legacyPrimaryValid(){return legacyPrimaryValid;},
    clearRemoteLease:()=>{remoteLeaseCleared=true;committedTransfer=null;},
    assignForeignLease:chatUrl=>{
      foreignLease={agent_id:'uuid-identity-1',
        token_id:'external-chat-token-C',chat_url:chatUrl};
      committedTransfer=null;
    },
    assignForeignLeaseOnAbort:chatUrl=>{
      foreignLeaseAfterAbort={agent_id:'uuid-identity-1',
        token_id:'external-chat-token-C',chat_url:chatUrl};
      committedTransfer=null;
    },
    deleteRemoteAgent:()=>{remoteAgentDeleted=true;committedTransfer=null;},
    get committedTransfer(){return committedTransfer;},
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

test('first PUSH introduces new identity only once, with no Start prompt',async()=>{
  const h=networkHarness({urls:[PROJECT]});
  const started=await h.start(10);
  assert.equal(started.ok,true,started.error);
  assert.equal(h.data.agentsByChat[PLAIN].identityIntroduced,false);
  assert.equal(h.events.filter(e=>e.type==='agent:send').length,0);
  h.sockets[0].receive({type:'wake',wake_id:'first',pending_count:1});
  await h.tick();
  assert.equal(h.data.agentsByChat[PLAIN].identityIntroduced,true);
  const first=h.events.filter(e=>e.type==='agent:send').at(-1).body.text;
  assert.match(first,/\[Agent Network wake\]/);
  assert.match(first,/read_instructions\(agent_id, token\)/);
  assert.match(first,/agent_id: uuid-identity-1/);
  assert.match(first,/token: PRIVATE_AGENT_SECRET/);
  h.sockets[0].receive({type:'wake',wake_id:'second',pending_count:2});
  await h.tick();
  const second=h.events.filter(e=>e.type==='agent:send').at(-1).body.text;
  assert.match(second,/\[Agent Network wake\]/);
  assert.equal(second.includes('read_instructions(agent_id, token)'),false);
  assert.equal(h.events.filter(e=>e.type==='agent:send').length,2);
});

test('manual identity reminder before first PUSH avoids duplicate bootstrap',async()=>{
  const h=networkHarness({urls:[PROJECT]});
  await h.start(10);
  assert.equal((await h.popupRequest(10,'network:repeat-bootstrap')).ok,true);
  assert.equal(h.data.agentsByChat[PLAIN].identityIntroduced,true);
  h.sockets[0].receive({type:'wake',wake_id:'after-manual',pending_count:1});
  await h.tick();
  const text=h.events.filter(e=>e.type==='agent:send').at(-1).body.text;
  assert.equal(text.includes('read_instructions(agent_id, token)'),false);
});

test('orphan Start offline then online rechecks GET and safely reconfirms without POST',async()=>{
  const chat='https://chatgpt.com/c/44444444-4444-4444-4444-444444444444';
  const server='http://127.0.0.1:8787';
  const deferred={'10':{
    kind:'start',server,originalUrl:'https://chatgpt.com/',
    profile:{name:'New-Agent',role:'Developer',purpose:'',description:''},
    targetUrl:chat,targetChatUrl:chat,state:'processing',
    phase:'preparing',createdAt:123,
  }};
  const h=networkHarness({urls:[chat],initialDeferred:deferred,networkDown:true});
  await h.alarm();
  assert.equal(h.data.deferredChatBindings['10'].state,'recovery_retry');
  assert.equal(h.data.deferredChatBindings['10'].phase,'preparing');
  assert.equal(h.registrations,0);
  await h.alarm();
  assert.equal(h.data.deferredChatBindings['10'].state,'recovery_retry');
  h.setNetworkDown(false);
  await h.alarm();
  assert.equal(h.data.deferredChatBindings['10'].state,'confirm_destination');
  assert.equal(h.registrations,0,'verification alone must never register');
  assert.ok(h.events.some(e=>e.url?.endsWith('/api/v1/admin/agents') && e.method==='GET'));
  const confirmed=await h.popupRequest(10,'network:confirm-deferred',{
    expectedDestination:chat,
  });
  assert.equal(confirmed.ok,true,confirmed.error);
  assert.equal(h.registrations,1);
  assert.equal(h.data.deferredChatBindings['10'],undefined);
});

test('orphan migration offline then online retains source A and safely reconfirms',async()=>{
  const chat='https://chatgpt.com/c/44444444-4444-4444-4444-444444444444';
  const server='http://127.0.0.1:8787';
  const source={agentId:'uuid-identity-1',name:'Same-Agent',
    token:'PRIVATE_AGENT_SECRET',chatCredentialId:'chat-token-uuid-identity-1',
    server,role:'Developer',purpose:'',description:'',
    active:true,bootstrapDone:true,chatUrl:PLAIN,ownerTabId:10};
  const deferred={'11':{
    kind:'migrate',server,agentId:source.agentId,fromChatUrl:PLAIN,
    expectedServerTokenId:source.chatCredentialId,
    expectedServerChatUrl:PLAIN,allowTakeover:false,
    originalUrl:'https://chatgpt.com/',targetUrl:chat,targetChatUrl:chat,
    state:'processing',phase:'server_request',createdAt:456,
  }};
  const h=networkHarness({urls:[PROJECT,chat],initial:{[PLAIN]:source},
    initialDeferred:deferred,networkDown:true});
  await h.alarm();
  assert.equal(h.data.deferredChatBindings['11'].state,'recovery_retry');
  assert.equal(h.data.agentsByChat[PLAIN].active,true);
  assert.equal(h.events.filter(e=>e.url?.endsWith('/chat-transfers') &&
    e.method==='POST').length,0);
  h.setNetworkDown(false);
  await h.alarm();
  assert.equal(h.data.deferredChatBindings['11'].state,'confirm_destination');
  assert.equal(h.data.agentsByChat[PLAIN].active,true);
  assert.equal(h.events.filter(e=>e.url?.endsWith('/chat-transfers') &&
    e.method==='POST').length,0);
  const confirmed=await h.popupRequest(11,'network:confirm-deferred',{
    expectedDestination:chat,
  });
  assert.equal(confirmed.ok,true,confirmed.error);
  assert.equal(h.data.agentsByChat[PLAIN],undefined);
  assert.equal(h.data.agentsByChat[chat].agentId,source.agentId);
});

test('orphan migration remote GET HTTP 503 retries automatically when server recovers',async()=>{
  const chat='https://chatgpt.com/c/44444444-4444-4444-4444-444444444444';
  const server='http://127.0.0.1:8787';
  const source={agentId:'uuid-identity-1',name:'Same-Agent',
    token:'PRIVATE_AGENT_SECRET',chatCredentialId:'chat-token-uuid-identity-1',
    server,role:'Developer',purpose:'',description:'',
    active:true,bootstrapDone:true,chatUrl:PLAIN,ownerTabId:10};
  const deferred={'11':{
    kind:'migrate',server,agentId:source.agentId,fromChatUrl:PLAIN,
    expectedServerTokenId:source.chatCredentialId,
    expectedServerChatUrl:PLAIN,allowTakeover:false,
    originalUrl:'https://chatgpt.com/',targetUrl:chat,targetChatUrl:chat,
    state:'processing',phase:'server_request',createdAt:456,
  }};
  const h=networkHarness({urls:[PROJECT,chat],initial:{[PLAIN]:source},
    initialDeferred:deferred});
  h.setBindingLookupDown(true);
  await h.alarm();
  assert.equal(h.data.deferredChatBindings['11'].state,'recovery_retry');
  assert.equal(h.data.deferredChatBindings['11'].phase,'server_request');
  assert.equal(h.data.agentsByChat[PLAIN].active,true);
  h.setBindingLookupDown(false);
  const status=await h.popupRequest(11,'network:status');
  assert.equal(status.ok,true,status.error);
  assert.equal(status.deferredBinding.state,'confirm_destination');
  assert.equal(h.events.filter(e=>e.url?.endsWith('/chat-transfers') &&
    e.method==='POST').length,0);
});

test('orphan Start recovers after missing admin token is reconfigured',async()=>{
  const chat='https://chatgpt.com/c/44444444-4444-4444-4444-444444444444';
  const server='http://127.0.0.1:8787';
  const deferred={'10':{
    kind:'start',server,originalUrl:'https://chatgpt.com/',
    profile:{name:'New-Agent',role:'Developer',purpose:'',description:''},
    targetUrl:chat,targetChatUrl:chat,state:'processing',
    phase:'preparing',createdAt:123,
  }};
  const h=networkHarness({urls:[chat],initialDeferred:deferred,noAdmin:true});
  await h.alarm();
  assert.equal(h.data.deferredChatBindings['10'].state,'recovery_retry');
  assert.match(h.data.deferredChatBindings['10'].error,/admin-доступа/);
  assert.equal(h.registrations,0);
  const result=await h.popupRequest(10,'network:admin-connect',
    {adminToken:ADMIN_TEST_TOKEN});
  assert.equal(result.ok,true,result.error);
  await h.alarm();
  assert.equal(h.data.deferredChatBindings['10'].state,'confirm_destination');
  assert.equal(h.registrations,0);
});

test('orphan Start processing before HTTP recovers to explicit reconfirmation',async()=>{
  const chat='https://chatgpt.com/c/44444444-4444-4444-4444-444444444444';
  const server='http://127.0.0.1:8787';
  const deferred={'10':{
    kind:'start',server,originalUrl:'https://chatgpt.com/',
    profile:{name:'New-Agent',role:'Developer',purpose:'',description:''},
    targetUrl:chat,targetChatUrl:chat,state:'processing',
    phase:'preparing',createdAt:123,
  }};
  const h=networkHarness({urls:[chat],initialDeferred:deferred});
  await h.alarm();
  assert.equal(h.registrations,0);
  assert.equal(h.data.deferredChatBindings['10'].state,'confirm_destination');
  assert.equal(h.data.deferredChatBindings['10'].phase,'reconciled');
  const recovered=await h.popupRequest(10,'network:confirm-deferred',{
    expectedDestination:chat,
  });
  assert.equal(recovered.ok,true,recovered.error);
  assert.equal(h.registrations,1);
  assert.equal(h.data.agentsByChat[chat].name,'New-Agent');
  assert.equal(h.data.deferredChatBindings['10'],undefined);
});

test('orphan migrated processing before prepare recovers without revoking A',async()=>{
  const chat='https://chatgpt.com/c/44444444-4444-4444-4444-444444444444';
  const server='http://127.0.0.1:8787';
  const source={
    agentId:'uuid-identity-1',name:'Same-Agent',
    token:'PRIVATE_AGENT_SECRET',chatCredentialId:'chat-token-uuid-identity-1',
    server,role:'Developer',purpose:'',description:'',
    active:true,bootstrapDone:true,chatUrl:PLAIN,ownerTabId:10,
  };
  const deferred={'11':{
    kind:'migrate',server,agentId:source.agentId,fromChatUrl:PLAIN,
    expectedServerTokenId:source.chatCredentialId,
    expectedServerChatUrl:PLAIN,allowTakeover:false,
    originalUrl:'https://chatgpt.com/',targetUrl:chat,targetChatUrl:chat,
    state:'processing',phase:'preparing',createdAt:456,
  }};
  const h=networkHarness({urls:[PROJECT,chat],initial:{[PLAIN]:source},
    initialDeferred:deferred});
  await h.alarm();
  assert.equal(h.data.deferredChatBindings['11'].state,'confirm_destination');
  assert.equal(h.data.agentsByChat[PLAIN].active,true);
  assert.equal(h.events.filter(e=>e.url?.endsWith('/chat-transfers') &&
    e.method==='POST').length,0);
  const recovered=await h.popupRequest(11,'network:confirm-deferred',{
    expectedDestination:chat,
  });
  assert.equal(recovered.ok,true,recovered.error);
  assert.equal(h.data.agentsByChat[PLAIN],undefined);
  assert.equal(h.data.agentsByChat[chat].agentId,source.agentId);
});

test('orphan Start with already active local scoped token cleans up without new registration',async()=>{
  const chat='https://chatgpt.com/c/44444444-4444-4444-4444-444444444444';
  const server='http://127.0.0.1:8787';
  const profile={name:'New-Agent',role:'Developer',purpose:'',description:''};
  const local={
    ...profile,agentId:'already-created',kind:'chatgpt',
    token:'PRIVATE_AGENT_SECRET',chatCredentialId:'chat-token-already-created',
    server,chatUrl:chat,active:true,bootstrapDone:true,ownerTabId:10,
  };
  const deferred={'10':{
    kind:'start',server,originalUrl:'https://chatgpt.com/',profile,
    targetUrl:chat,targetChatUrl:chat,state:'processing',
    phase:'local_committed',createdAt:123,
  }};
  const h=networkHarness({urls:[chat],initial:{[chat]:local},
    initialDeferred:deferred});
  await h.alarm();
  assert.equal(h.data.deferredChatBindings['10'],undefined);
  assert.equal(h.data.agentsByChat[chat].agentId,'already-created');
  assert.equal(h.registrations,0);
});

test('orphan Start after HTTP create but before local token save requires safe manual repair',async()=>{
  const chat='https://chatgpt.com/c/44444444-4444-4444-4444-444444444444';
  const server='http://127.0.0.1:8787';
  const profile={name:'New-Agent',role:'Developer',purpose:'',description:''};
  const deferred={'10':{
    kind:'start',server,originalUrl:'https://chatgpt.com/',profile,
    targetUrl:chat,targetChatUrl:chat,state:'processing',
    phase:'server_request',createdAt:123,
  }};
  const remote={agent_id:'created-on-server',kind:'chatgpt',
    name:'New-Agent',role:'Developer',purpose:'',description:''};
  const h=networkHarness({urls:[chat],initialDeferred:deferred,
    remoteProfiles:[remote]});
  await h.alarm();
  const state=h.data.deferredChatBindings['10'];
  assert.equal(state.state,'recovery_required');
  assert.match(state.error,/локальный токен отсутствует/);
  assert.equal(h.registrations,0);
  const cancel=await h.popupRequest(10,'network:cancel-deferred');
  assert.equal(cancel.ok,true);
  assert.equal(cancel.cancelled,false);
  assert.equal(cancel.reason,'recovery_reset');
  assert.equal(h.data.deferredChatBindings['10'],undefined);
  assert.equal(h.registrations,0);
});

test('orphan migrated processing after commit with local destination reconciles without rotating again',async()=>{
  const chat='https://chatgpt.com/c/44444444-4444-4444-4444-444444444444';
  const server='http://127.0.0.1:8787';
  const local={
    name:'Same-Agent',agentId:'uuid-identity-1',kind:'chatgpt',
    token:'FRESH_DEST_TOKEN_FOR_uuid-identity-1',
    chatCredentialId:'transfer-uuid-identity-1',
    server,chatUrl:chat,active:true,bootstrapDone:true,
    bootstrapMigrated:true,identityIntroduced:false,ownerTabId:11,
  };
  const deferred={'11':{
    kind:'migrate',server,agentId:local.agentId,fromChatUrl:PLAIN,
    expectedServerTokenId:'chat-token-uuid-identity-1',
    expectedServerChatUrl:PLAIN,allowTakeover:false,
    originalUrl:'https://chatgpt.com/',targetUrl:chat,targetChatUrl:chat,
    state:'processing',phase:'local_committed',createdAt:456,
  }};
  const h=networkHarness({urls:[PROJECT,chat],initial:{[chat]:local},
    initialDeferred:deferred});
  await h.alarm();
  assert.equal(h.data.deferredChatBindings['11'],undefined);
  assert.equal(h.data.agentsByChat[chat].active,true);
  assert.equal(h.events.filter(e=>e.url?.endsWith('/chat-transfers') &&
    e.method==='POST').length,0);
});

test('orphan migrated processing reconciles durable pending commit after restart',async()=>{
  const h=networkHarness({
    urls:[PROJECT,OTHER],ambiguousTransferCommit:true,reconcileUnavailable:true,
  });
  await h.start(10);
  const preview=await h.popupRequest(11,'network:migration-preview',
    {name:'Same-Agent'});
  const uncertain=await h.popupRequest(11,'network:migrate',{
    agentId:preview.agentId,fromChatUrl:preview.fromChatUrl,
    expectedDestination:preview.toChatUrl,
  });
  assert.equal(uncertain.ok,false);
  assert.equal(Object.keys(h.data.pendingChatTransfers).length,1);
  const source=h.data.agentsByChat[PLAIN];
  const deferred={'11':{
    kind:'migrate',server:source.server,agentId:source.agentId,
    fromChatUrl:PLAIN,
    expectedServerTokenId:source.chatCredentialId,
    expectedServerChatUrl:PLAIN,
    originalUrl:'https://chatgpt.com/',
    targetUrl:OTHER,targetChatUrl:OTHER,
    state:'processing',phase:'server_request',createdAt:654,
  }};
  const recovered=networkHarness({
    urls:[PROJECT,OTHER],
    initial:structuredClone(h.data.agentsByChat),
    initialPending:structuredClone(h.data.pendingChatTransfers),
    initialDeferred:deferred,
    remoteCommittedTransfer:structuredClone(h.committedTransfer),
  });
  await recovered.alarm();
  await recovered.tick();
  assert.equal(recovered.data.agentsByChat[PLAIN],undefined);
  assert.equal(recovered.data.agentsByChat[OTHER].agentId,source.agentId);
  assert.equal(recovered.data.deferredChatBindings['11'],undefined);
  assert.equal(Object.keys(recovered.data.pendingChatTransfers).length,0);
  assert.equal(recovered.events.filter(e=>e.url?.endsWith('/chat-transfers') &&
    e.method==='POST').length,0);
});

test('orphan migrated processing after remote commit with lost local token fails closed',async()=>{
  const chat='https://chatgpt.com/c/44444444-4444-4444-4444-444444444444';
  const server='http://127.0.0.1:8787';
  const source={name:'Same-Agent',agentId:'uuid-identity-1',
    token:'PRIVATE_AGENT_SECRET',chatCredentialId:'chat-token-uuid-identity-1',
    server,chatUrl:PLAIN,active:false,bootstrapDone:true,ownerTabId:null};
  const deferred={'11':{
    kind:'migrate',server,agentId:source.agentId,fromChatUrl:PLAIN,
    expectedServerTokenId:source.chatCredentialId,
    expectedServerChatUrl:PLAIN,allowTakeover:false,
    originalUrl:'https://chatgpt.com/',targetUrl:chat,targetChatUrl:chat,
    state:'processing',phase:'server_request',createdAt:456,
  }};
  const h=networkHarness({
    urls:[PROJECT,chat],initial:{[PLAIN]:source},
    initialDeferred:deferred,
    remoteCommittedTransfer:{agent_id:source.agentId,
      token_id:'transfer-uuid-identity-1',chat_url:chat,status:'committed'},
  });
  await h.alarm();
  assert.equal(h.data.deferredChatBindings['11'].state,'recovery_required');
  assert.equal(h.data.agentsByChat[PLAIN].agentId,source.agentId);
  assert.equal(h.data.agentsByChat[chat],undefined);
  assert.equal(h.events.filter(e=>e.url?.endsWith('/chat-transfers') &&
    e.method==='POST').length,0);
  const cancellation=await h.popupRequest(11,'network:cancel-deferred');
  assert.equal(cancellation.cancelled,false);
  assert.equal(cancellation.reason,'recovery_reset');
});

test('review regression: sidebar navigation to existing X never silently creates agent',async()=>{
  const x='https://chatgpt.com/c/44444444-4444-4444-4444-444444444444';
  const h=networkHarness({urls:['https://chatgpt.com/']});
  assert.equal((await h.start(10)).deferred,true);
  await h.navigate(10,x); // existing unrelated conversation, no user message
  await h.alarm();
  await h.tick();
  assert.equal(h.registrations,0);
  assert.equal(h.data.agentsByChat[x],undefined);
  assert.equal(h.data.deferredChatBindings['10'].state,'confirm_destination');
  assert.equal(h.data.deferredChatBindings['10'].targetUrl,x);
  assert.equal(h.events.filter(e=>e.type==='agent:send').length,0);
  const wrong=await h.popupRequest(10,'network:confirm-deferred',{
    expectedDestination:'https://chatgpt.com/c/55555555-5555-5555-5555-555555555555',
  });
  assert.equal(wrong.ok,false);
  assert.equal(h.registrations,0);
  await h.popupRequest(10,'network:cancel-deferred');
  assert.equal(h.data.deferredChatBindings['10'],undefined);
});

test('review regression: sidebar navigation to X cannot silently steal source A',async()=>{
  const x='https://chatgpt.com/c/44444444-4444-4444-4444-444444444444';
  const h=networkHarness({urls:[PROJECT,'https://chatgpt.com/']});
  await h.start(10);
  const primary=h.data.agentsByChat[PLAIN].token;
  const preview=await h.popupRequest(11,'network:migration-preview',{
    name:'Same-Agent',
  });
  assert.equal((await h.popupRequest(11,'network:migrate',{
    agentId:preview.agentId,fromChatUrl:preview.fromChatUrl,
    expectedDestination:preview.toChatUrl,
  })).deferred,true);
  await h.navigate(11,x); // sidebar click, not a new conversation
  await h.alarm();
  await h.tick();
  assert.equal(h.data.agentsByChat[PLAIN].token,primary);
  assert.equal(h.data.agentsByChat[PLAIN].active,true);
  assert.equal(h.data.agentsByChat[x],undefined);
  assert.equal(h.data.deferredChatBindings['11'].state,'confirm_destination');
  assert.equal(h.events.filter(e=>e.url?.endsWith('/chat-transfers') && e.method==='POST').length,0);
  await h.popupRequest(11,'network:cancel-deferred');
  assert.equal(h.data.agentsByChat[PLAIN].token,primary);
});

test('cancel during in-flight deferred Start refuses instead of falsely acknowledging',async()=>{
  const chat='https://chatgpt.com/c/44444444-4444-4444-4444-444444444444';
  const h=networkHarness({urls:['https://chatgpt.com/'],registrationDelay:65});
  assert.equal((await h.start(10)).deferred,true);
  await h.navigate(10,chat);
  const binding=h.popupRequest(10,'network:confirm-deferred',{
    expectedDestination:chat,
  });
  await new Promise(resolve=>setTimeout(resolve,18)); // registration HTTP inflight
  const cancelled=await h.popupRequest(10,'network:cancel-deferred');
  assert.equal(cancelled.ok,true,cancelled.error);
  assert.equal(cancelled.cancelled,false);
  assert.equal(cancelled.reason,'in_progress');
  const completed=await binding;
  assert.equal(completed.ok,true,completed.error);
  assert.equal(h.registrations,1);
  assert.equal(h.data.agentsByChat[chat].active,true);
  assert.equal(h.data.deferredChatBindings['10'],undefined);
});

test('cancel during in-flight deferred transfer commit refuses and preserves accurate status',async()=>{
  const chat='https://chatgpt.com/c/44444444-4444-4444-4444-444444444444';
  const h=networkHarness({urls:[PROJECT,'https://chatgpt.com/'],
    transferCommitDelay:75});
  await h.start(10);
  const preview=await h.popupRequest(11,'network:migration-preview',{
    name:'Same-Agent',
  });
  assert.equal((await h.popupRequest(11,'network:migrate',{
    agentId:preview.agentId,fromChatUrl:preview.fromChatUrl,
    expectedDestination:preview.toChatUrl,
  })).deferred,true);
  await h.navigate(11,chat);
  const binding=h.popupRequest(11,'network:confirm-deferred',{
    expectedDestination:chat,
  });
  for(let n=0;n<50 &&
    !h.events.some(e=>e.url?.endsWith('/commit') && e.method==='POST');n++)
    await new Promise(resolve=>setTimeout(resolve,2));
  assert.ok(h.events.some(e=>e.url?.endsWith('/commit') && e.method==='POST'));
  const cancelled=await h.popupRequest(11,'network:cancel-deferred');
  assert.equal(cancelled.ok,true,cancelled.error);
  assert.equal(cancelled.cancelled,false);
  assert.equal(cancelled.reason,'in_progress');
  const finished=await binding;
  assert.equal(finished.ok,true,finished.error);
  assert.equal(h.data.agentsByChat[PLAIN],undefined);
  assert.equal(h.data.agentsByChat[chat].active,true);
  assert.equal(h.data.deferredChatBindings['11'],undefined);
});

test('blank new tab can queue new agent registration and bind after first user message',async()=>{
  const h=networkHarness({urls:['https://chatgpt.com/'],initialBusyProbes:100});
  const pending=await h.start(10);
  assert.equal(pending.ok,true,pending.error);
  assert.equal(pending.deferred,true);
  assert.equal(h.registrations,0,'no ID yet: do not allocate agent or bearer');
  assert.equal(h.events.filter(e=>e.type==='agent:send').length,0);
  assert.equal((await h.popupRequest(10,'network:status')).deferredBinding.state,'waiting');
  const chat='https://chatgpt.com/c/99999999-9999-9999-9999-999999999999';
  await h.navigate(10,chat);
  await h.tick();
  assert.equal(h.registrations,0);
  assert.equal(h.data.deferredChatBindings['10'].state,'confirm_destination');
  assert.equal(h.data.deferredChatBindings['10'].targetUrl,chat);
  assert.equal(h.data.agentsByChat[chat],undefined);
  const confirmed=await h.popupRequest(10,'network:confirm-deferred',{
    expectedDestination:chat,
  });
  assert.equal(confirmed.ok,true,confirmed.error);
  assert.equal(confirmed.linked,true);
  assert.equal(h.registrations,1);
  assert.equal(h.data.agentsByChat[chat].active,true);
  assert.equal(h.data.agentsByChat[chat].identityIntroduced,false);
  assert.equal(h.data.deferredChatBindings['10'],undefined);
  assert.equal(h.events.filter(e=>e.type==='agent:send').length,0);
});

test('deferred migration survives service-worker startup without duplicate identity',async()=>{
  const old={
    agentId:'uuid-identity-1',name:'Same-Agent',
    token:'PRIVATE_AGENT_SECRET',chatCredentialId:'chat-token-uuid-identity-1',
    server:'http://127.0.0.1:8787',role:'Developer',
    purpose:'',description:'',active:true,
    bootstrapDone:true,chatUrl:PLAIN,ownerTabId:10,
  };
  const dest='https://chatgpt.com/c/99999999-9999-9999-9999-999999999999';
  const deferred={
    '11':{
      kind:'migrate',server:old.server,agentId:old.agentId,
      fromChatUrl:PLAIN,expectedServerTokenId:old.chatCredentialId,
      expectedServerChatUrl:PLAIN,allowTakeover:false,
      originalUrl:'https://chatgpt.com/',state:'waiting',createdAt:123456,
    },
  };
  const h=networkHarness({
    urls:[PROJECT,dest],initial:{[PLAIN]:old},initialDeferred:deferred,
  });
  await h.alarm();
  await h.tick();
  assert.equal(h.data.agentsByChat[PLAIN].agentId,old.agentId);
  assert.equal(h.data.deferredChatBindings['11'].state,'confirm_destination');
  assert.equal((await h.popupRequest(11,'network:confirm-deferred',{
    expectedDestination:dest,
  })).ok,true);
  assert.equal(h.data.agentsByChat[PLAIN],undefined);
  assert.equal(h.data.agentsByChat[dest].agentId,old.agentId);
  assert.equal(h.data.deferredChatBindings['11'],undefined);
  assert.equal(h.registrations,0);
  assert.equal(h.events.filter(e=>e.type==='agent:send').length,0);
});

test('cancelled deferred migration never revokes original server lease',async()=>{
  const h=networkHarness({urls:[PROJECT,'https://chatgpt.com/']});
  await h.start(10);
  const source=h.data.agentsByChat[PLAIN].agentId;
  const preview=await h.popupRequest(11,'network:migration-preview',{name:'Same-Agent'});
  const pending=await h.popupRequest(11,'network:migrate',{
    agentId:source,fromChatUrl:preview.fromChatUrl,
    expectedDestination:preview.toChatUrl,
  });
  assert.equal(pending.deferred,true);
  await h.popupRequest(11,'network:cancel-deferred');
  await h.navigate(11,'https://chatgpt.com/c/99999999-9999-9999-9999-999999999999');
  await h.tick();
  assert.equal(h.data.agentsByChat[PLAIN].agentId,source);
  assert.equal(h.data.agentsByChat[PLAIN].active,true);
  assert.equal(h.events.filter(e=>e.method==='POST' &&
    e.url?.endsWith('/chat-transfers')).length,0);
});

test('blank registration without admin token fails immediately, not after first message',async()=>{
  const h=networkHarness({urls:['https://chatgpt.com/'],noAdmin:true});
  const result=await h.start(10);
  assert.equal(result.ok,false);
  assert.match(result.error,/admin-token/);
  assert.equal(h.data.deferredChatBindings,undefined);
  assert.equal(h.registrations,0);
});

test('popup can cancel queued registration; content script cannot cancel it',async()=>{
  const h=networkHarness({urls:['https://chatgpt.com/']});
  const pending=await h.start(10);
  assert.equal(pending.deferred,true);
  const untrusted=await h.request(10,'network:cancel-deferred');
  assert.equal(untrusted.ok,false);
  const cancelled=await h.popupRequest(10,'network:cancel-deferred');
  assert.equal(cancelled.ok,true,cancelled.error);
  await h.navigate(10,'https://chatgpt.com/c/99999999-9999-9999-9999-999999999999');
  await h.tick();
  assert.equal(h.registrations,0);
  assert.equal(h.events.filter(e=>e.type==='agent:send').length,0);
});

test('closing a blank tab cancels queued agent registration',async()=>{
  const h=networkHarness({urls:['https://chatgpt.com/']});
  assert.equal((await h.start(10)).deferred,true);
  await h.close(10);
  assert.equal(h.data.deferredChatBindings['10'],undefined);
  assert.equal(h.registrations,0);
});

test('first PUSH after migration carries saved-context restore instructions',async()=>{
  const h=networkHarness({urls:[PROJECT,OTHER]});
  await h.start(10);
  const preview=await h.popupRequest(11,'network:migration-preview',{name:'Same-Agent'});
  assert.equal((await h.popupRequest(11,'network:migrate',{
    agentId:preview.agentId,fromChatUrl:preview.fromChatUrl,
    expectedDestination:preview.toChatUrl,
  })).ok,true);
  assert.equal(h.data.agentsByChat[OTHER].identityIntroduced,false);
  h.sockets.at(-1).receive({type:'wake',wake_id:'migration-first',pending_count:1});
  await h.tick();
  const sent=h.events.filter(e=>e.type==='agent:send').at(-1).body.text;
  assert.match(sent,/read_context\(agent_id, token\)/);
  assert.match(sent,/Prior ChatGPT conversation history was not copied/);
  assert.equal(h.data.agentsByChat[OTHER].identityIntroduced,true);
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
  assert.equal(h.events.filter(e=>e.type==='agent:send').length,0);

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
  assert.equal(h.events.filter(e=>e.type==='agent:send').length,0);

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
  assert.equal(h.events.filter(e=>e.type==='agent:send').length,0);
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
  const preview=await h.popupRequest(11,'network:migration-preview',{name:'Same-Agent'});
  assert.equal(preview.ok,true);
  assert.equal(preview.migrate,true);
  assert.equal(preview.fromChatUrl,PLAIN);
  assert.equal(preview.toChatUrl,OTHER);
  assert.equal(preview.agentId,'uuid-identity-1');
  assert.equal(JSON.stringify(preview).includes('PRIVATE_AGENT_SECRET'),false);
  assert.equal((await h.popupRequest(11,'network:migration-preview',{name:'Somebody-Else'})).ok,false);
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

test('migration attaches identity to busy destination without any prompt',async()=>{
  const h=networkHarness({urls:[PROJECT,OTHER],initialBusyProbes:100});
  await h.start(10);
  const oldId=h.data.agentsByChat[PLAIN].agentId;
  const preview=await h.popupRequest(11,'network:migration-preview',{name:'Same-Agent'});
  const migrated=await h.popupRequest(11,'network:migrate',{
    agentId:preview.agentId,fromChatUrl:preview.fromChatUrl,
    expectedDestination:preview.toChatUrl,
  });
  assert.equal(migrated.ok,true,migrated.error);
  assert.equal(migrated.agentId,oldId);
  assert.equal(h.registrations,1);
  assert.equal(h.data.agentsByChat[PLAIN],undefined);
  assert.equal(h.data.agentsByChat[OTHER].agentId,oldId);
  assert.equal(h.data.agentsByChat[OTHER].bootstrapDone,true);
  assert.equal(h.data.agentsByChat[OTHER].identityIntroduced,false);
  assert.equal(h.data.agentsByChat[OTHER].ownerTabId,11);
  assert.equal(h.events.filter(e=>e.type==='agent:send').length,0);
  assert.equal(h.events.filter(e=>e.type==='agent:probe' && e.tabId===11).length,0,
    'migration must not check destination chat state');
  assert.equal(h.sockets.length,2);
  assert.equal((await h.request(11,'network:status')).entry.agentId,oldId);
});

test('legacy primary transfer rotates old token without prompting destination',async()=>{
  const h=networkHarness({urls:[PROJECT,OTHER]});
  await h.start(10);
  delete h.data.agentsByChat[PLAIN].chatCredentialId;
  const preview=await h.popupRequest(11,'network:migration-preview',{name:'Same-Agent'});
  assert.equal(preview.rotatesPrimary,true);
  const moved=await h.popupRequest(11,'network:migrate',{
    agentId:preview.agentId,fromChatUrl:preview.fromChatUrl,
    expectedDestination:preview.toChatUrl,
  });
  assert.equal(moved.ok,true,moved.error);
  assert.equal(h.legacyPrimaryValid,false);
  assert.equal(h.data.agentsByChat[PLAIN],undefined);
  assert.equal(h.data.agentsByChat[OTHER].chatCredentialId,'transfer-'+preview.agentId);
  const prepared=h.events.find(e=>e.url?.endsWith('/chat-transfers') && e.method==='POST');
  assert.equal(JSON.parse(prepared.body).legacy_primary_token,'PRIVATE_AGENT_SECRET');
  assert.equal(h.events.filter(e=>e.type==='agent:send').length,0);
});

test('legacy primary transfer ignores a busy or non-writable destination composer',async()=>{
  const h=networkHarness({urls:[PROJECT,OTHER],failTransferBootstrap:true,
    probeDraftAfterPrimer:true,initialBusyProbes:100});
  await h.start(10);
  delete h.data.agentsByChat[PLAIN].chatCredentialId;
  const preview=await h.popupRequest(11,'network:migration-preview',{name:'Same-Agent'});
  const result=await h.popupRequest(11,'network:migrate',{
    agentId:preview.agentId,fromChatUrl:preview.fromChatUrl,
    expectedDestination:preview.toChatUrl,
  });
  assert.equal(result.ok,true,result.error);
  assert.equal(h.legacyPrimaryValid,false);
  assert.equal(h.data.agentsByChat[PLAIN],undefined);
  assert.equal(h.events.filter(e=>e.type==='agent:send').length,0);
});

test('legacy commit failure with lost GET restores original valid primary after reconnect',async()=>{
  const h=networkHarness({
    urls:[PROJECT,OTHER],failTransferCommit:true,reconcileUnavailable:true,
  });
  await h.start(10);
  delete h.data.agentsByChat[PLAIN].chatCredentialId;
  const preview=await h.popupRequest(11,'network:migration-preview',{name:'Same-Agent'});
  const uncertain=await h.popupRequest(11,'network:migrate',{
    agentId:preview.agentId,fromChatUrl:preview.fromChatUrl,
    expectedDestination:preview.toChatUrl,
  });
  assert.equal(uncertain.ok,false);
  assert.equal(h.data.agentsByChat[PLAIN].active,false);
  assert.equal(Object.keys(h.data.pendingChatTransfers).length,1);
  h.allowBindingLookups();
  await h.alarm();
  await h.tick();
  assert.equal(h.data.agentsByChat[PLAIN].active,false);
  assert.equal(h.data.agentsByChat[PLAIN].token,'PRIVATE_AGENT_SECRET');
  assert.equal(h.legacyPrimaryValid,true);
  assert.equal(h.data.agentsByChat[OTHER],undefined);
  assert.equal(Object.keys(h.data.pendingChatTransfers).length,0);
});

test('legacy ambiguous commit is recovered as a rotated source with valid B lease',async()=>{
  const h=networkHarness({
    urls:[PROJECT,OTHER],ambiguousTransferCommit:true,reconcileUnavailable:true,
  });
  await h.start(10);
  delete h.data.agentsByChat[PLAIN].chatCredentialId;
  const preview=await h.popupRequest(11,'network:migration-preview',{name:'Same-Agent'});
  const uncertain=await h.popupRequest(11,'network:migrate',{
    agentId:preview.agentId,fromChatUrl:preview.fromChatUrl,
    expectedDestination:preview.toChatUrl,
  });
  assert.equal(uncertain.ok,false);
  assert.equal(h.legacyPrimaryValid,false);
  assert.equal(h.data.agentsByChat[PLAIN].active,false);
  h.allowBindingLookups();
  await h.alarm();
  await h.tick();
  assert.equal(h.data.agentsByChat[PLAIN],undefined);
  assert.equal(h.data.agentsByChat[OTHER].active,true);
  assert.notEqual(h.data.agentsByChat[OTHER].token,'PRIVATE_AGENT_SECRET');
  assert.equal(Object.keys(h.data.pendingChatTransfers).length,0);
});

test('foreign C binding between legacy null GET and primary HUD cannot revive A PUSH',async()=>{
  const h=networkHarness({urls:[PROJECT,OTHER],failTransferCommit:true,
    reconcileUnavailable:true,bindForeignDuringLegacyHud:true});
  await h.start(10);
  delete h.data.agentsByChat[PLAIN].chatCredentialId;
  const preview=await h.popupRequest(11,'network:migration-preview',{name:'Same-Agent'});
  const failed=await h.popupRequest(11,'network:migrate',{
    agentId:preview.agentId,fromChatUrl:preview.fromChatUrl,
    expectedDestination:preview.toChatUrl,
  });
  assert.equal(failed.ok,false);
  h.allowBindingLookups();
  await h.alarm();
  await h.tick();
  assert.equal(h.data.agentsByChat[PLAIN].token,'PRIVATE_AGENT_SECRET');
  assert.equal(h.data.agentsByChat[PLAIN].active,false,
    'legacy source is paused even if primary remains valid');
  assert.equal(Object.keys(h.data.pendingChatTransfers).length,0);
  assert.equal(h.sockets.length,1,'foreign C does not re-enable old A PUSH');
  assert.equal(h.sockets[0].closed,true);
});

test('legacy recovery keeps pending when primary status cannot be confirmed',async()=>{
  const h=networkHarness({
    urls:[PROJECT,OTHER],failTransferCommit:true,reconcileUnavailable:true,
  });
  await h.start(10);
  delete h.data.agentsByChat[PLAIN].chatCredentialId;
  const preview=await h.popupRequest(11,'network:migration-preview',{name:'Same-Agent'});
  await h.popupRequest(11,'network:migrate',{
    agentId:preview.agentId,fromChatUrl:preview.fromChatUrl,
    expectedDestination:preview.toChatUrl,
  });
  h.allowBindingLookups();
  h.pauseLegacyAuth();
  await h.alarm();
  await h.tick();
  assert.equal(h.data.agentsByChat[PLAIN].active,false);
  assert.equal(Object.keys(h.data.pendingChatTransfers).length,1);
  h.resumeLegacyAuth();
  await h.alarm();
  await h.tick();
  assert.equal(h.data.agentsByChat[PLAIN].active,false);
  assert.equal(Object.keys(h.data.pendingChatTransfers).length,0);
});

test('admin rotation during legacy pending revokes A without reviving source',async()=>{
  const h=networkHarness({
    urls:[PROJECT,OTHER],failTransferCommit:true,reconcileUnavailable:true,
  });
  await h.start(10);
  delete h.data.agentsByChat[PLAIN].chatCredentialId;
  const preview=await h.popupRequest(11,'network:migration-preview',{name:'Same-Agent'});
  await h.popupRequest(11,'network:migrate',{
    agentId:preview.agentId,fromChatUrl:preview.fromChatUrl,
    expectedDestination:preview.toChatUrl,
  });
  h.rotateLegacyPrimary();
  h.allowBindingLookups();
  await h.alarm();
  await h.tick();
  assert.equal(h.data.agentsByChat[PLAIN],undefined);
  assert.equal(Object.keys(h.data.pendingChatTransfers).length,0);
  assert.equal(h.legacyPrimaryValid,false);
});

test('blank new chat defers migration until user creates /c/ ID naturally',async()=>{
  const h=networkHarness({urls:[PROJECT,'https://chatgpt.com/']});
  await h.start(10);
  const preview=await h.popupRequest(11,'network:migration-preview',{name:'Same-Agent'});
  const moved=await h.popupRequest(11,'network:migrate',{
    agentId:preview.agentId,fromChatUrl:preview.fromChatUrl,
    expectedDestination:preview.toChatUrl,
  });
  assert.equal(moved.ok,true,moved.error);
  assert.equal(moved.deferred,true);
  assert.equal(h.tabs.get(11).url,'https://chatgpt.com/');
  assert.ok(h.data.agentsByChat[PLAIN]);
  assert.equal(h.events.filter(e=>e.type==='agent:send').length,0);
  assert.equal(h.events.filter(e=>e.method==='POST' && e.url?.endsWith('/chat-transfers')).length,0);
  const destination='https://chatgpt.com/c/00000000-0000-0000-0000-000000000999';
  await h.navigate(11,destination);
  await h.tick();
  assert.equal(h.data.agentsByChat[PLAIN].agentId,preview.agentId);
  assert.equal(h.data.deferredChatBindings['11'].state,'confirm_destination');
  const confirmed=await h.popupRequest(11,'network:confirm-deferred',{
    expectedDestination:destination,
  });
  assert.equal(confirmed.ok,true,confirmed.error);
  assert.equal(h.data.agentsByChat[PLAIN],undefined);
  assert.equal(h.data.agentsByChat[destination].agentId,preview.agentId);
  assert.equal(h.data.agentsByChat[destination].identityIntroduced,false);
  assert.equal(h.events.filter(e=>e.type==='agent:send').length,0);
});

test('project landing page queues migration until first user message yields a /c/ ID',async()=>{
  const root='https://chatgpt.com/g/g-p-6af61be7a30c8191a28628b8c44f715b-blender-edu';
  const target='https://chatgpt.com/c/00000000-0000-0000-0000-000000000999';
  const h=networkHarness({urls:[PLAIN,root]});
  await h.start(10);
  const preview=await h.popupRequest(11,'network:migration-preview',{name:'Same-Agent'});
  const queued=await h.popupRequest(11,'network:migrate',{
    agentId:preview.agentId,fromChatUrl:preview.fromChatUrl,
    expectedDestination:preview.toChatUrl,
  });
  assert.equal(queued.deferred,true);
  await h.navigate(11,target);
  await h.tick();
  assert.equal(h.data.agentsByChat[PLAIN].agentId,preview.agentId);
  const confirmed=await h.popupRequest(11,'network:confirm-deferred',{
    expectedDestination:target,
  });
  assert.equal(confirmed.ok,true,confirmed.error);
  assert.equal(h.data.agentsByChat[target].agentId,preview.agentId);
  assert.equal(h.registrations,1);
});

test('revoked old token is recovered through admin without manual changes',async()=>{
  const h=networkHarness({urls:[PROJECT,OTHER],verifyFails:true});
  await h.start(10);
  const preview=await h.popupRequest(11,'network:migration-preview',{name:'Same-Agent'});
  const result=await h.popupRequest(11,'network:migrate',{
    agentId:preview.agentId,fromChatUrl:preview.fromChatUrl,
    expectedDestination:preview.toChatUrl
  });
  assert.equal(result.ok,true,result.error);
  assert.equal(h.data.agentsByChat[PLAIN],undefined);
  assert.equal(h.data.agentsByChat[OTHER].agentId,preview.agentId);
  const request=h.events.find(e=>e.method==='POST' && e.url?.endsWith('/chat-transfers'));
  assert.equal(JSON.parse(request.body).admin_recovery,true);
  assert.equal(JSON.parse(request.body).source_token_id,'');
  assert.equal(JSON.parse(request.body).legacy_primary_token,undefined);
  assert.equal(h.registrations,1);
});

test('legacy primary 403 also migrates via admin without sending stale secret',async()=>{
  const h=networkHarness({urls:[PROJECT,OTHER],verifyFails:true});
  await h.start(10);
  delete h.data.agentsByChat[PLAIN].chatCredentialId;
  const preview=await h.popupRequest(11,'network:migration-preview',{name:'Same-Agent'});
  const outcome=await h.popupRequest(11,'network:migrate',{
    agentId:preview.agentId,fromChatUrl:preview.fromChatUrl,
    expectedDestination:preview.toChatUrl,
  });
  assert.equal(outcome.ok,true,outcome.error);
  const staged=h.events.find(e=>e.method==='POST' &&
    e.url?.endsWith('/chat-transfers'));
  const request=JSON.parse(staged.body);
  assert.equal(request.admin_recovery,true);
  assert.equal(request.legacy_primary_token,undefined);
  assert.equal(h.data.agentsByChat[PLAIN],undefined);
  assert.equal(h.data.agentsByChat[OTHER].agentId,preview.agentId);
  assert.equal(h.events.filter(e=>e.type==='agent:send' && e.tabId===11).length,0);
});

test('revoked scoped A with empty server lease migrates without rotating valid global P',async()=>{
  const h=networkHarness({urls:[PROJECT,OTHER],verifyFails:true});
  await h.start(10);
  h.clearRemoteLease(); // Server expired A's scoped lease, primary P remains.
  const preview=await h.popupRequest(11,'network:migration-preview',{name:'Same-Agent'});
  assert.equal(preview.serverSourceTokenId,null);
  assert.equal(preview.takeover,false);
  const outcome=await h.popupRequest(11,'network:migrate',{
    agentId:preview.agentId,fromChatUrl:preview.fromChatUrl,
    expectedDestination:preview.toChatUrl,
    expectedServerTokenId:preview.serverSourceTokenId,
    expectedServerChatUrl:preview.serverSourceChatUrl,
  });
  assert.equal(outcome.ok,true,outcome.error);
  assert.equal(h.legacyPrimaryValid,true,'valid global P must not be rotated');
  assert.equal(h.data.agentsByChat[PLAIN],undefined);
  assert.equal(h.data.agentsByChat[OTHER].agentId,preview.agentId);
  const request=JSON.parse(h.events.find(e=>e.method==='POST' &&
    e.url?.endsWith('/chat-transfers')).body);
  assert.equal(request.admin_recovery,true);
  assert.equal(request.expected_source_token_id,null);
  assert.equal(request.expected_source_chat_url,null);
});

test('foreign C cannot be disconnected by an unconfirmed stale A migration',async()=>{
  const c='https://chatgpt.com/c/33333333-3333-3333-3333-333333333333';
  const h=networkHarness({urls:[PROJECT,OTHER],verifyFails:true,
    remoteForeignLease:{agent_id:'uuid-identity-1',
      token_id:'external-chat-token-C',chat_url:c}});
  await h.start(10);
  const preview=await h.popupRequest(11,'network:migration-preview',{name:'Same-Agent'});
  assert.equal(preview.takeover,true);
  assert.equal(preview.serverSourceChatUrl,c);
  const denied=await h.popupRequest(11,'network:migrate',{
    agentId:preview.agentId,fromChatUrl:preview.fromChatUrl,
    expectedDestination:preview.toChatUrl,
  });
  assert.equal(denied.ok,false);
  assert.match(denied.error,/другом чате/);
  assert.equal(h.events.filter(e=>e.method==='POST' &&
    e.url?.endsWith('/chat-transfers')).length,0);
  const confirmed=await h.popupRequest(11,'network:migrate',{
    agentId:preview.agentId,fromChatUrl:preview.fromChatUrl,
    expectedDestination:preview.toChatUrl,
    expectedServerTokenId:preview.serverSourceTokenId,
    expectedServerChatUrl:preview.serverSourceChatUrl,
    allowTakeover:true,
  });
  assert.equal(confirmed.ok,true,confirmed.error);
  assert.equal(h.data.agentsByChat[PLAIN],undefined);
  assert.equal(h.data.agentsByChat[OTHER].agentId,preview.agentId);
  const request=JSON.parse(h.events.find(e=>e.method==='POST' &&
    e.url?.endsWith('/chat-transfers')).body);
  assert.equal(request.admin_recovery,true);
  assert.equal(request.expected_source_chat_url,c);
  assert.equal(request.expected_source_token_id,'external-chat-token-C');
});

test('foreign server lease changes after preview: takeover must be refused',async()=>{
  const c='https://chatgpt.com/c/33333333-3333-3333-3333-333333333333';
  const d='https://chatgpt.com/c/44444444-4444-4444-4444-444444444444';
  const h=networkHarness({urls:[PROJECT,OTHER],verifyFails:true,
    remoteForeignLease:{agent_id:'uuid-identity-1',
      token_id:'external-chat-token-C',chat_url:c}});
  await h.start(10);
  const preview=await h.popupRequest(11,'network:migration-preview',{name:'Same-Agent'});
  h.assignForeignLease(d);
  const outcome=await h.popupRequest(11,'network:migrate',{
    agentId:preview.agentId,fromChatUrl:preview.fromChatUrl,
    expectedDestination:preview.toChatUrl,
    expectedServerTokenId:preview.serverSourceTokenId,
    expectedServerChatUrl:preview.serverSourceChatUrl,
    allowTakeover:true,
  });
  assert.equal(outcome.ok,false);
  assert.match(outcome.error,/Привязка агента изменилась/);
  assert.equal(h.events.filter(e=>e.method==='POST' &&
    e.url?.endsWith('/chat-transfers')).length,0);
});

test('stale token with server rejection aborts safely without reviving PUSH',async()=>{
  const h=networkHarness({
    urls:[PROJECT,OTHER],verifyFails:true,
    failTransferCommit:true,reconcileUnavailable:true,
  });
  await h.start(10);
  const preview=await h.popupRequest(11,'network:migration-preview',{name:'Same-Agent'});
  const result=await h.popupRequest(11,'network:migrate',{
    agentId:preview.agentId,fromChatUrl:preview.fromChatUrl,
    expectedDestination:preview.toChatUrl,
  });
  assert.equal(result.ok,false);
  assert.equal(h.data.agentsByChat[PLAIN].active,false);
  h.allowBindingLookups();
  await h.alarm();
  await h.tick();
  assert.equal(h.data.agentsByChat[PLAIN],undefined);
  assert.equal(h.data.agentsByChat[OTHER],undefined);
  assert.equal(Object.keys(h.data.pendingChatTransfers).length,0);
  assert.equal(h.sockets.length,1);
});

test('revoked local bearer cannot impersonate an agent missing from admin catalog',async()=>{
  const h=networkHarness({urls:[PROJECT,OTHER],verifyFails:true,remoteAgentIds:[]});
  await h.start(10);
  const preview=await h.popupRequest(11,'network:migration-preview',{name:'Same-Agent'});
  const outcome=await h.popupRequest(11,'network:migrate',{
    agentId:preview.agentId,fromChatUrl:preview.fromChatUrl,
    expectedDestination:preview.toChatUrl,
  });
  assert.equal(outcome.ok,false);
  assert.match(outcome.error,/больше не найден/);
  assert.equal(h.events.filter(e=>e.method==='POST' &&
    e.url?.endsWith('/chat-transfers')).length,0);
  assert.equal(h.data.agentsByChat[OTHER],undefined);
});

test('blank destination with busy composer queues transfer without touching old identity',async()=>{
  const h=networkHarness({urls:[PROJECT,'https://chatgpt.com/'],failMigrationSend:true});
  await h.start(10);
  const preview=await h.popupRequest(11,'network:migration-preview',{name:'Same-Agent'});
  const queued=await h.popupRequest(11,'network:migrate',{
    agentId:preview.agentId,fromChatUrl:preview.fromChatUrl,
    expectedDestination:preview.toChatUrl,
  });
  assert.equal(queued.ok,true,queued.error);
  assert.equal(queued.deferred,true);
  assert.equal(h.data.agentsByChat[PLAIN].active,true);
  assert.equal(h.data.agentsByChat[PLAIN].agentId,preview.agentId);
  assert.equal(h.events.filter(e=>e.type==='agent:send').length,0);
});

test('cannot migrate over an already registered chat or with wrong expected source ID',async()=>{
  const h=networkHarness({urls:[PROJECT,OTHER]});
  await h.start(10);
  const preview=await h.popupRequest(11,'network:migration-preview',{name:'Same-Agent'});
  const forged=await h.popupRequest(11,'network:migrate',{
    agentId:'wrong-id',fromChatUrl:preview.fromChatUrl,
    expectedDestination:preview.toChatUrl
  });
  assert.equal(forged.ok,false);
  assert.equal(h.data.agentsByChat[PLAIN].active,true);
  assert.equal(h.sockets.length,1);
  await h.popupRequest(11,'network:start',{profile:{
    name:'Another-Agent',role:'Reviewer',purpose:'Other',description:''
  }});
  const occupied=await h.popupRequest(11,'network:migration-preview',{name:'Same-Agent'});
  assert.equal(occupied.ok,false);
  assert.match(occupied.error,/уже есть агент/);
});

test('concurrent Start for different chats preserves both with clone-on-read Chrome Storage',async()=>{
  const h=networkHarness({urls:[PROJECT,OTHER],registrationDelay:30});
  const profile=name=>({name,role:'Developer',purpose:'',description:''});
  const [a,b]=await Promise.all([
    h.popupRequest(10,'network:start',{profile:profile('Agent-A')}),
    h.popupRequest(11,'network:start',{profile:profile('Agent-B')}),
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
    h.popupRequest(11,'network:migration-preview',{name:'Same-Agent'}),
    h.popupRequest(12,'network:migration-preview',{name:'Same-Agent'}),
  ]);
  assert.equal(a.ok,true);
  assert.equal(b.ok,true);
  const [first,second]=await Promise.all([
    h.popupRequest(11,'network:migrate',{
      agentId:a.agentId,fromChatUrl:a.fromChatUrl,expectedDestination:a.toChatUrl,
    }),
    h.popupRequest(12,'network:migrate',{
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
  const preview=await h.popupRequest(11,'network:migration-preview',{name:'No-Secret'});
  assert.equal(preview.ok,false);
  assert.match(preview.error,/не найден/);
});

test('project new-chat page binds after first real conversation URL without primer',async()=>{
  const root='https://chatgpt.com/g/g-p-6af61be7a30c8191a28628b8c44f715b-blender-edu/project';
  const target='https://chatgpt.com/c/00000000-0000-0000-0000-000000000999';
  const h=networkHarness({urls:[PROJECT,root]});
  await h.start(10);
  const preview=await h.popupRequest(11,'network:migration-preview',{name:'Same-Agent'});
  const waiting=await h.popupRequest(11,'network:migrate',{
    agentId:preview.agentId,fromChatUrl:preview.fromChatUrl,
    expectedDestination:preview.toChatUrl,
  });
  assert.equal(waiting.deferred,true);
  await h.navigate(11,target);
  await h.tick();
  assert.equal(h.data.agentsByChat[PLAIN].agentId,preview.agentId);
  const confirmed=await h.popupRequest(11,'network:confirm-deferred',{
    expectedDestination:target,
  });
  assert.equal(confirmed.ok,true,confirmed.error);
  assert.equal(h.data.agentsByChat[target].agentId,preview.agentId);
  assert.equal(h.data.agentsByChat[PLAIN],undefined);
  assert.equal(h.events.filter(e=>e.type==='agent:send').length,0);
  assert.equal(h.registrations,1);
});

test('a content script cannot invoke privileged identity migration',async()=>{
  const h=networkHarness({urls:[PROJECT,OTHER]});
  await h.start(10);
  const preview=await h.popupRequest(11,'network:migration-preview',{name:'Same-Agent'});
  const forbidden=await h.request(11,'network:migrate',{
    agentId:preview.agentId,fromChatUrl:preview.fromChatUrl,
    expectedDestination:preview.toChatUrl,
  });
  assert.equal(forbidden.ok,false);
  assert.match(forbidden.error,/только из popup/);
  assert.equal(h.data.agentsByChat[PLAIN].active,true);
  assert.equal(h.data.agentsByChat[OTHER],undefined);
  assert.equal(h.events.filter(e=>e.type==='agent:send' && e.tabId===11).length,0);
});

test('busy first user message creates URL and deferred transfer commits during generation',async()=>{
  const h=networkHarness({urls:[PROJECT,'https://chatgpt.com/'],
    primerNeverIdle:true,initialBusyProbes:100,probeDraftAfterPrimer:true});
  await h.start(10);
  const preview=await h.popupRequest(11,'network:migration-preview',{name:'Same-Agent'});
  const pending=await h.popupRequest(11,'network:migrate',{
    agentId:preview.agentId,fromChatUrl:preview.fromChatUrl,
    expectedDestination:preview.toChatUrl,
  });
  assert.equal(pending.deferred,true);
  await h.navigate(11,'https://chatgpt.com/c/00000000-0000-0000-0000-000000000999');
  await h.tick();
  assert.equal(h.data.agentsByChat[PLAIN].agentId,preview.agentId);
  assert.equal(h.data.deferredChatBindings['11'].state,'confirm_destination');
  const target='https://chatgpt.com/c/00000000-0000-0000-0000-000000000999';
  assert.equal((await h.popupRequest(11,'network:confirm-deferred',{
    expectedDestination:target,
  })).ok,true);
  assert.equal(h.data.agentsByChat[PLAIN],undefined);
  assert.equal(h.data.agentsByChat['https://chatgpt.com/c/00000000-0000-0000-0000-000000000999'].active,true);
  assert.equal(h.events.filter(e=>e.type==='agent:send').length,0);
});

test('blank chat with user draft is left untouched and migration remains pending',async()=>{
  const h=networkHarness({urls:[PROJECT,'https://chatgpt.com/'],
    probeDraftAfterPrimer:true});
  await h.start(10);
  const preview=await h.popupRequest(11,'network:migration-preview',{name:'Same-Agent'});
  const result=await h.popupRequest(11,'network:migrate',{
    agentId:preview.agentId,fromChatUrl:preview.fromChatUrl,
    expectedDestination:preview.toChatUrl,
  });
  assert.equal(result.deferred,true);
  assert.equal(h.data.agentsByChat[PLAIN].active,true);
  assert.equal(h.data.agentsByChat[OTHER],undefined);
  assert.equal(h.events.filter(e=>e.type==='agent:send').length,0);
  assert.equal(h.data.deferredChatBindings['11'].state,'waiting');
});

test('there is no busy-state timeout or waitForChatIdle dependency in transfer',async()=>{
  const h=networkHarness({urls:[PROJECT,OTHER],initialBusyProbes:10000});
  await h.start(10);
  const preview=await h.popupRequest(11,'network:migration-preview',{name:'Same-Agent'});
  const done=await h.popupRequest(11,'network:migrate',{
    agentId:preview.agentId,fromChatUrl:preview.fromChatUrl,
    expectedDestination:preview.toChatUrl,
  });
  assert.equal(done.migrated,true);
  assert.equal(h.events.filter(e=>e.type==='agent:send').length,0);
  assert.equal(h.events.filter(e=>e.type==='agent:probe' && e.tabId===11).length,0);
});

test('ambiguous commit and offline reconciliation persist pending state until recovery',async()=>{
  const h=networkHarness({
    urls:[PROJECT,OTHER],ambiguousTransferCommit:true,reconcileUnavailable:true,
  });
  await h.start(10);
  const source=h.data.agentsByChat[PLAIN];
  const preview=await h.popupRequest(11,'network:migration-preview',{name:'Same-Agent'});
  const uncertain=await h.popupRequest(11,'network:migrate',{
    agentId:preview.agentId,fromChatUrl:preview.fromChatUrl,
    expectedDestination:preview.toChatUrl,
  });
  assert.equal(uncertain.ok,false);
  assert.match(uncertain.error,/Результат переноса неизвестен/);
  assert.equal(h.data.agentsByChat[PLAIN].active,false);
  assert.equal(h.data.agentsByChat[OTHER],undefined);
  assert.equal(h.sockets.length,1);
  assert.equal(h.sockets[0].closed,true);
  const waiting=Object.values(h.data.pendingChatTransfers);
  assert.equal(waiting.length,1);
  assert.equal(waiting[0].sourceTokenId,source.chatCredentialId);
  assert.notEqual(waiting[0].next.token,source.token);
  assert.equal(h.events.filter(e=>e.method==='DELETE' &&
    e.url?.includes('/chat-transfers/')).length,0);

  await h.alarm();
  assert.equal(h.data.agentsByChat[PLAIN].active,false);
  assert.equal(Object.keys(h.data.pendingChatTransfers).length,1);
  assert.equal(h.sockets.length,1);
  h.allowBindingLookups();
  await h.alarm();
  await h.tick();
  assert.equal(h.data.agentsByChat[PLAIN],undefined);
  assert.equal(h.data.agentsByChat[OTHER].active,true);
  assert.equal(h.data.agentsByChat[OTHER].chatCredentialId,
               h.committedTransfer.token_id);
  assert.equal(Object.keys(h.data.pendingChatTransfers).length,0);
  assert.equal(h.sockets.at(-1).closed,false);
});

test('confirmed uncommitted transfer rolls back after outage and restores source',async()=>{
  const h=networkHarness({
    urls:[PROJECT,OTHER],failTransferCommit:true,reconcileUnavailable:true,
  });
  await h.start(10);
  const source=h.data.agentsByChat[PLAIN];
  const preview=await h.popupRequest(11,'network:migration-preview',{name:'Same-Agent'});
  const uncertain=await h.popupRequest(11,'network:migrate',{
    agentId:preview.agentId,fromChatUrl:preview.fromChatUrl,
    expectedDestination:preview.toChatUrl,
  });
  assert.equal(uncertain.ok,false);
  assert.match(uncertain.error,/Результат переноса неизвестен/);
  assert.equal(h.data.agentsByChat[PLAIN].active,false);
  assert.equal(Object.keys(h.data.pendingChatTransfers).length,1);
  assert.equal(h.sockets.length,1);
  h.allowBindingLookups();
  await h.alarm();
  await h.tick();
  assert.equal(h.data.agentsByChat[PLAIN].active,true);
  assert.equal(h.data.agentsByChat[PLAIN].token,source.token);
  assert.equal(h.data.agentsByChat[OTHER],undefined);
  assert.equal(Object.keys(h.data.pendingChatTransfers).length,0);
  assert.equal(h.events.filter(e=>e.method==='DELETE' &&
    e.url?.includes('/chat-transfers/')).length,1);
  assert.equal(h.sockets.length,2);
  assert.equal(h.sockets.at(-1).closed,false);
});

test('abort:false after concurrent commit finalizes B instead of resurrecting A',async()=>{
  const h=networkHarness({urls:[PROJECT,OTHER],commitDuringAbort:true});
  await h.start(10);
  const oldToken=h.data.agentsByChat[PLAIN].token;
  const preview=await h.popupRequest(11,'network:migration-preview',{name:'Same-Agent'});
  const moved=await h.popupRequest(11,'network:migrate',{
    agentId:preview.agentId,fromChatUrl:preview.fromChatUrl,
    expectedDestination:preview.toChatUrl,
  });
  assert.equal(moved.ok,true,moved.error);
  assert.equal(h.data.agentsByChat[PLAIN],undefined);
  assert.equal(h.data.agentsByChat[OTHER].active,true);
  assert.notEqual(h.data.agentsByChat[OTHER].token,oldToken);
  assert.equal(h.data.agentsByChat[OTHER].chatCredentialId,h.committedTransfer.token_id);
  assert.equal(Object.keys(h.data.pendingChatTransfers).length,0);
  assert.equal(h.events.filter(e=>e.method==='DELETE' &&
    e.url?.includes('/chat-transfers/')).length,1);
  assert.equal(h.sockets.length,2);
  assert.equal(h.sockets.at(-1).closed,false);
});

test('abort:false plus failed post-abort GET keeps pending until later reconciliation',async()=>{
  const h=networkHarness({
    urls:[PROJECT,OTHER],commitDuringAbort:true,abortRecheckUnavailable:true,
  });
  await h.start(10);
  const oldToken=h.data.agentsByChat[PLAIN].token;
  const preview=await h.popupRequest(11,'network:migration-preview',{name:'Same-Agent'});
  const uncertain=await h.popupRequest(11,'network:migrate',{
    agentId:preview.agentId,fromChatUrl:preview.fromChatUrl,
    expectedDestination:preview.toChatUrl,
  });
  assert.equal(uncertain.ok,false);
  assert.match(uncertain.error,/Результат переноса неизвестен/);
  assert.equal(h.data.agentsByChat[PLAIN].active,false);
  assert.equal(h.data.agentsByChat[OTHER],undefined);
  assert.equal(Object.keys(h.data.pendingChatTransfers).length,1);
  assert.equal(h.sockets.length,1);
  h.allowBindingLookups();
  await h.alarm();
  await h.tick();
  assert.equal(h.data.agentsByChat[PLAIN],undefined);
  assert.equal(h.data.agentsByChat[OTHER].active,true);
  assert.notEqual(h.data.agentsByChat[OTHER].token,oldToken);
  assert.equal(Object.keys(h.data.pendingChatTransfers).length,0);
  assert.equal(h.sockets.at(-1).closed,false);
});

test('pending migration blocks mutation and exposes status only to trusted popup',async()=>{
  const h=networkHarness({
    urls:[PROJECT,OTHER],ambiguousTransferCommit:true,reconcileUnavailable:true,
  });
  await h.start(10);
  const preview=await h.popupRequest(11,'network:migration-preview',{name:'Same-Agent'});
  await h.popupRequest(11,'network:migrate',{
    agentId:preview.agentId,fromChatUrl:preview.fromChatUrl,
    expectedDestination:preview.toChatUrl,
  });
  const untrusted=await h.request(10,'network:status');
  const trusted=await h.popupRequest(10,'network:status');
  assert.equal(untrusted.pendingTransfer,null);
  assert.equal(trusted.pendingTransfer.toChatUrl,OTHER);
  for(const [type,payload] of [
    ['network:stop',{}],
    ['network:unlink',{}],
    ['network:set-server',{server:'http://127.0.0.1:8999'}],
    ['network:repeat-bootstrap',{}],
    ['network:start',{profile:{
      name:'Same-Agent',role:'Developer',purpose:'Testing',description:'',
    }}],
    ['network:update-token',{token:'PRIVATE_AGENT_SECRET'}],
    ['network:schedule-set',{schedule:{
      enabled:true,intervalMinutes:5,text:'hello',
    }}],
  ]){
    const result=await h.popupRequest(10,type,payload);
    assert.equal(result.ok,false,type+' unexpectedly succeeded');
    assert.match(result.error,/незавершённый перенос/,type);
  }
  assert.equal(h.data.agentsByChat[PLAIN].active,false);
  assert.equal(Object.keys(h.data.pendingChatTransfers).length,1);
});

test('admin token rotation while pending clears stale binding and allows new scoped rebind',async()=>{
  const profile={agent_id:'uuid-identity-1',name:'Same-Agent',kind:'chatgpt',
    role:'Developer',purpose:'Testing',description:'',teams:[]};
  const h=networkHarness({
    urls:[PROJECT,OTHER],ambiguousTransferCommit:true,
    reconcileUnavailable:true,remoteProfiles:[profile],
  });
  await h.start(10);
  const preview=await h.popupRequest(11,'network:migration-preview',{name:'Same-Agent'});
  const outcome=await h.popupRequest(11,'network:migrate',{
    agentId:preview.agentId,fromChatUrl:preview.fromChatUrl,
    expectedDestination:preview.toChatUrl,
  });
  assert.equal(outcome.ok,false);
  assert.equal(Object.keys(h.data.pendingChatTransfers).length,1);
  h.clearRemoteLease(); // Dashboard rotated primary credential and cleared lease.
  h.allowBindingLookups();
  await h.alarm();
  await h.tick();
  assert.equal(Object.keys(h.data.pendingChatTransfers).length,0);
  assert.equal(h.data.agentsByChat[PLAIN],undefined);
  assert.equal(h.data.agentsByChat[OTHER],undefined);
  assert.equal(h.sockets.length,1);
  assert.equal(h.sockets[0].closed,true);
  const rebound=await h.popupRequest(10,'network:start',{profile:{
    agentId:profile.agent_id,name:profile.name,role:profile.role,
    purpose:profile.purpose,description:profile.description,
  }});
  assert.equal(rebound.ok,true,rebound.error);
  assert.equal(h.data.agentsByChat[PLAIN].agentId,profile.agent_id);
  assert.equal(h.registrations,1,'rebind must not create another server agent');
});

test('agent deletion while pending removes stale local identity without reconnecting',async()=>{
  const h=networkHarness({
    urls:[PROJECT,OTHER],ambiguousTransferCommit:true,reconcileUnavailable:true,
  });
  await h.start(10);
  const preview=await h.popupRequest(11,'network:migration-preview',{name:'Same-Agent'});
  await h.popupRequest(11,'network:migrate',{
    agentId:preview.agentId,fromChatUrl:preview.fromChatUrl,
    expectedDestination:preview.toChatUrl,
  });
  h.deleteRemoteAgent();
  h.allowBindingLookups();
  await h.alarm();
  await h.tick();
  assert.equal(Object.keys(h.data.pendingChatTransfers).length,0);
  assert.equal(h.data.agentsByChat[PLAIN],undefined);
  assert.equal(h.data.agentsByChat[OTHER],undefined);
  assert.equal(h.sockets.length,1);
});

test('rotation then remote browser rebind C clears old pending without touching C',async()=>{
  const c='https://chatgpt.com/c/33333333-3333-3333-3333-333333333333';
  const h=networkHarness({
    urls:[PROJECT,OTHER],ambiguousTransferCommit:true,reconcileUnavailable:true,
  });
  await h.start(10);
  const scheduled=await h.popupRequest(10,'network:schedule-set',{schedule:{
    enabled:true,intervalMinutes:5,text:'Old agent schedule',
  }});
  assert.equal(scheduled.ok,true,scheduled.error);
  const scoped='http://127.0.0.1:8787|uuid-identity-1';
  assert.equal(h.data.agentSchedulesById[scoped].enabled,true);
  const preview=await h.popupRequest(11,'network:migration-preview',{name:'Same-Agent'});
  const failed=await h.popupRequest(11,'network:migrate',{
    agentId:preview.agentId,fromChatUrl:preview.fromChatUrl,
    expectedDestination:preview.toChatUrl,
  });
  assert.equal(failed.ok,false);
  h.clearRemoteLease();
  h.assignForeignLease(c);
  h.allowBindingLookups();
  await h.alarm();
  await h.tick();
  assert.equal(h.data.agentsByChat[PLAIN],undefined);
  assert.equal(h.data.agentsByChat[OTHER],undefined);
  assert.equal(h.data.agentsByChat[c],undefined,'must not claim remote C lease');
  assert.equal(Object.keys(h.data.pendingChatTransfers).length,0);
  assert.equal(h.sockets.length,1,'old PUSH stays disconnected');
  assert.ok(h.events.some(e=>e.method==='DELETE' &&
    e.url?.includes('/chat-transfers/')));
  assert.equal(h.data.agentSchedulesById[scoped].enabled,false);
});

test('external rebind between GET(null) and abort GET(C) clears stale pending',async()=>{
  const c='https://chatgpt.com/c/33333333-3333-3333-3333-333333333333';
  const h=networkHarness({
    urls:[PROJECT,OTHER],ambiguousTransferCommit:true,reconcileUnavailable:true,
  });
  await h.start(10);
  const preview=await h.popupRequest(11,'network:migration-preview',{name:'Same-Agent'});
  await h.popupRequest(11,'network:migrate',{
    agentId:preview.agentId,fromChatUrl:preview.fromChatUrl,
    expectedDestination:preview.toChatUrl,
  });
  h.clearRemoteLease();
  h.assignForeignLeaseOnAbort(c);
  h.allowBindingLookups();
  await h.alarm();
  await h.tick();
  assert.equal(h.data.agentsByChat[PLAIN],undefined);
  assert.equal(Object.keys(h.data.pendingChatTransfers).length,0);
  assert.equal(h.sockets.length,1);
  assert.equal(h.events.filter(e=>e.method==='GET' &&
    e.url?.endsWith('/chat-binding')).length>=3,true);
});

test('service worker restart discards old pending when remote lease belongs to C',async()=>{
  const c='https://chatgpt.com/c/33333333-3333-3333-3333-333333333333';
  const h=networkHarness({
    urls:[PROJECT,OTHER],ambiguousTransferCommit:true,reconcileUnavailable:true,
  });
  await h.start(10);
  const preview=await h.popupRequest(11,'network:migration-preview',{name:'Same-Agent'});
  await h.popupRequest(11,'network:migrate',{
    agentId:preview.agentId,fromChatUrl:preview.fromChatUrl,
    expectedDestination:preview.toChatUrl,
  });
  const restarted=networkHarness({
    urls:[PROJECT,OTHER],
    initial:structuredClone(h.data.agentsByChat),
    initialPending:structuredClone(h.data.pendingChatTransfers),
    remoteForeignLease:{agent_id:'uuid-identity-1',
      token_id:'external-chat-token-C',chat_url:c},
  });
  await restarted.tick();
  assert.equal(restarted.data.agentsByChat[PLAIN],undefined);
  assert.equal(Object.keys(restarted.data.pendingChatTransfers).length,0);
  assert.equal(restarted.sockets.length,0);
});

test('service worker restart recovers a previously committed remote transfer',async()=>{
  const h=networkHarness({
    urls:[PROJECT,OTHER],ambiguousTransferCommit:true,reconcileUnavailable:true,
  });
  await h.start(10);
  const preview=await h.popupRequest(11,'network:migration-preview',{name:'Same-Agent'});
  const uncertain=await h.popupRequest(11,'network:migrate',{
    agentId:preview.agentId,fromChatUrl:preview.fromChatUrl,
    expectedDestination:preview.toChatUrl,
  });
  assert.equal(uncertain.ok,false);
  const restarted=networkHarness({
    urls:[PROJECT,OTHER],initial:structuredClone(h.data.agentsByChat),
    initialPending:structuredClone(h.data.pendingChatTransfers),
    remoteCommittedTransfer:structuredClone(h.committedTransfer),
  });
  await restarted.tick();
  assert.equal(restarted.data.agentsByChat[PLAIN],undefined);
  assert.equal(restarted.data.agentsByChat[OTHER].active,true);
  assert.equal(Object.keys(restarted.data.pendingChatTransfers).length,0);
  assert.equal(restarted.sockets.length,1);
  assert.equal(restarted.sockets[0].closed,false);
});

test('remote destination conflict never discloses A bearer or even a pending B bearer',async()=>{
  const h=networkHarness({urls:[PROJECT,OTHER],transferConflict:true});
  await h.start(10);
  const old=h.data.agentsByChat[PLAIN].token;
  const preview=await h.popupRequest(11,'network:migration-preview',{name:'Same-Agent'});
  const result=await h.popupRequest(11,'network:migrate',{
    agentId:preview.agentId,fromChatUrl:preview.fromChatUrl,
    expectedDestination:preview.toChatUrl,
  });
  assert.equal(result.ok,false);
  assert.match(result.error,/Destination chat already bound/);
  assert.equal(h.data.agentsByChat[PLAIN].token,old);
  assert.equal(h.data.agentsByChat[OTHER],undefined);
  assert.equal(h.events.filter(e=>e.type==='agent:send' && e.tabId===11).length,0);
  assert.equal(h.events.some(e=>e.url?.includes('/chat-transfers/') &&
                            e.url.endsWith('/commit')),false);
  assert.equal(h.sockets.at(-1).closed,false);
});

test('destination composer failing does not prevent staged token commit',async()=>{
  const h=networkHarness({urls:[PROJECT,OTHER],failTransferBootstrap:true});
  await h.start(10);
  const preview=await h.popupRequest(11,'network:migration-preview',{name:'Same-Agent'});
  const moved=await h.popupRequest(11,'network:migrate',{
    agentId:preview.agentId,fromChatUrl:preview.fromChatUrl,
    expectedDestination:preview.toChatUrl,
  });
  assert.equal(moved.ok,true,moved.error);
  assert.equal(h.data.agentsByChat[PLAIN],undefined);
  assert.equal(h.data.agentsByChat[OTHER].active,true);
  assert.equal(h.events.filter(e=>e.type==='agent:send' && e.tabId===11).length,0);
  assert.equal(h.events.filter(e=>e.method==='POST' && e.url?.endsWith('/commit')).length,1);
});

test('lost commit response reconciles server-owned B lease without reviving A',async()=>{
  const h=networkHarness({urls:[PROJECT,OTHER],ambiguousTransferCommit:true});
  await h.start(10);
  const oldToken=h.data.agentsByChat[PLAIN].token;
  const preview=await h.popupRequest(11,'network:migration-preview',{name:'Same-Agent'});
  const moved=await h.popupRequest(11,'network:migrate',{
    agentId:preview.agentId,fromChatUrl:preview.fromChatUrl,
    expectedDestination:preview.toChatUrl,
  });
  assert.equal(moved.ok,true,moved.error);
  assert.equal(h.data.agentsByChat[PLAIN],undefined);
  assert.notEqual(h.data.agentsByChat[OTHER].token,oldToken);
  assert.ok(h.events.some(e=>e.url?.endsWith('/chat-binding') && e.method==='GET'));
  assert.equal(h.events.some(e=>e.url?.includes('/chat-transfers/') &&
                            e.method==='DELETE'),false);
  assert.equal(h.sockets.length,2);
  assert.equal(h.sockets.at(-1).closed,false);
});

test('failed server commit aborts pending bearer and keeps A identity intact',async()=>{
  const h=networkHarness({urls:[PROJECT,OTHER],failTransferCommit:true});
  await h.start(10);
  const original=h.data.agentsByChat[PLAIN].token;
  const preview=await h.popupRequest(11,'network:migration-preview',{name:'Same-Agent'});
  const result=await h.popupRequest(11,'network:migrate',{
    agentId:preview.agentId,fromChatUrl:preview.fromChatUrl,
    expectedDestination:preview.toChatUrl,
  });
  assert.equal(result.ok,false);
  assert.match(result.error,/Source binding changed during transfer/);
  assert.equal(h.data.agentsByChat[PLAIN].token,original);
  assert.equal(h.data.agentsByChat[OTHER],undefined);
  assert.equal(h.events.filter(e=>e.type==='agent:send' && e.tabId===11).length,0);
  assert.equal(h.events.filter(e=>e.method==='DELETE' &&
    e.url?.includes('/chat-transfers/')).length,1);
  assert.equal(h.sockets.at(-1).closed,false);
});

test('blank destination stores intention without contacting transfer API before ID',async()=>{
  const h=networkHarness({urls:[PROJECT,'https://chatgpt.com/'],transferConflict:true});
  await h.start(10);
  const preview=await h.popupRequest(11,'network:migration-preview',{name:'Same-Agent'});
  const result=await h.popupRequest(11,'network:migrate',{
    agentId:preview.agentId,fromChatUrl:preview.fromChatUrl,
    expectedDestination:preview.toChatUrl,
  });
  assert.equal(result.deferred,true);
  assert.equal(h.events.filter(e=>e.type==='agent:send').length,0);
  assert.equal(h.events.filter(e=>e.method==='POST' && e.url?.endsWith('/chat-transfers')).length,0);
  assert.equal(h.data.agentsByChat[PLAIN].active,true);
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
  assert.equal(h.data.agentsByChat[PLAIN].bootstrapDone,true);
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
  assert.equal(h.data.agentsByChat[PLAIN].bootstrapDone,true);
  assert.equal(h.data.agentsByChat[PLAIN].ownerTabId,null);
  assert.equal(h.sockets.length,0);
});

test('registration on an already busy conversation never sends bootstrap',async()=>{
  const h=networkHarness({urls:[PLAIN],initialBusyProbes:1000,sendDelay:200});
  const result=await h.start(10);
  assert.equal(result.ok,true,result.error);
  assert.equal(h.data.agentsByChat[PLAIN].bootstrapDone,true);
  assert.equal(h.data.agentsByChat[PLAIN].identityIntroduced,false);
  assert.equal(h.data.agentsByChat[PLAIN].active,true);
  assert.equal(h.events.filter(e=>e.type==='agent:send').length,0);
  assert.equal(h.sockets.length,1);
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
  assert.equal(h.events.filter(e=>e.type==='agent:send').length,0);
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
  assert.equal(h.events.filter(e=>e.type==='agent:send').length,1);
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
  assert.equal(h.events.filter(e=>e.type==='agent:send').length,0);
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
  const registration=h.events.find(e=>e.url.endsWith('/api/v1/admin/chatgpt-agents'));
  assert.ok(registration);
  assert.equal(h.events.filter(e=>e.type==='agent:send').length,0);
});

test('manual identity reminder is available without an automatic Start bootstrap',async()=>{
  const h=networkHarness();
  const started=await h.start(10);
  assert.equal(started.ok,true,started.error);
  assert.equal(h.events.filter(e=>e.type==='agent:send').length,0);
  assert.equal(h.data.agentsByChat[PLAIN].identityIntroduced,false);
  const denied=await h.request(10,'network:repeat-bootstrap');
  assert.equal(denied.ok,false);
  assert.match(denied.error,/popup/);
  const again=await h.popupRequest(10,'network:repeat-bootstrap');
  assert.equal(again.ok,true,again.error);
  const sent=h.events.filter(e=>e.type==='agent:send').at(-1);
  assert.match(sent.body.text,/agent_id: uuid-identity-1/);
  assert.match(sent.body.text,/token: PRIVATE_AGENT_SECRET/);
  assert.match(sent.body.text,/read_instructions\(agent_id, token\)/);
  assert.equal(h.registrations,1);
  assert.equal(h.data.agentsByChat[PLAIN].identityIntroduced,true);
});

test('manual identity reminder after prompt-free migration includes read_context',async()=>{
  const h=networkHarness({urls:[PROJECT,OTHER]});
  await h.start(10);
  const preview=await h.popupRequest(11,'network:migration-preview',{name:'Same-Agent'});
  const moved=await h.popupRequest(11,'network:migrate',{
    agentId:preview.agentId,fromChatUrl:preview.fromChatUrl,
    expectedDestination:preview.toChatUrl,
  });
  assert.equal(moved.ok,true,moved.error);
  assert.equal(h.data.agentsByChat[OTHER].bootstrapMigrated,true);
  assert.equal(h.events.filter(e=>e.type==='agent:send').length,0);
  const reminder=await h.popupRequest(11,'network:repeat-bootstrap');
  assert.equal(reminder.ok,true,reminder.error);
  const sent=h.events.filter(e=>e.type==='agent:send').at(-1).body.text;
  assert.match(sent,/read_context\(agent_id, token\)/);
  assert.match(sent,/read_instructions\(agent_id, token\)/);
  assert.match(sent,/Prior ChatGPT conversation history was not copied/);
  assert.equal(h.data.agentsByChat[OTHER].identityIntroduced,true);
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
  assert.equal(h.events.filter(e=>e.type==='agent:send').length,0,
    'no message is sent before or after invalid navigation');
});

test('dashboard-created ChatGPT agent appears in catalog without a token and gets a token on bind',async()=>{
  const synced={agent_id:'server-created',name:'Server-ChatGPT',kind:'chatgpt',
    role:'Developer',purpose:'Existing dashboard identity',description:'No local token',
    teams:[{team_id:'dev',name:'Dev'}]};
  const h=networkHarness({urls:[OTHER],remoteProfiles:[synced]});
  const list=await h.popupRequest(10,'network:available-agents');
  assert.equal(list.ok,true,list.error);
  assert.equal(list.items.length,1);
  assert.equal(list.items[0].agentId,synced.agent_id);
  assert.equal(list.items[0].chatUrl,null);
  assert.equal(JSON.stringify(list).includes('CHAT_BIND_TOKEN'),false);
  const bound=await h.popupRequest(10,'network:start',{profile:{
    agentId:synced.agent_id,name:synced.name,role:synced.role,
    purpose:synced.purpose,description:synced.description,
  }});
  assert.equal(bound.ok,true,bound.error);
  assert.equal(bound.linked,true);
  assert.equal(bound.created,false);
  assert.equal(h.registrations,0,'bind must not create a second server agent');
  const stored=h.data.agentsByChat[OTHER];
  assert.equal(stored.agentId,synced.agent_id);
  assert.equal(stored.token,'CHAT_BIND_TOKEN_FOR_server-created');
  assert.equal(stored.chatCredentialId,'credential-server-created');
  assert.equal(stored.bootstrapDone,true);
  assert.equal(stored.active,true);
  assert.equal(h.events.filter(x=>x.type==='agent:send').length,0);
  assert.ok(h.events.some(x=>x.url.endsWith('/chat-credentials')));
  assert.equal((await h.popupRequest(10,'network:available-agents')).items.length,0);
});

test('unlink revokes just the chat credential without deleting server agent',async()=>{
  const synced={agent_id:'bound-server',name:'Bound-ChatGPT',kind:'chatgpt',
    role:'Developer',purpose:'',description:'',teams:[]};
  const h=networkHarness({urls:[OTHER],remoteProfiles:[synced]});
  const bound=await h.popupRequest(10,'network:start',{profile:{
    agentId:synced.agent_id,name:synced.name,role:synced.role,
    purpose:'',description:'',
  }});
  assert.equal(bound.ok,true,bound.error);
  const unlinked=await h.popupRequest(10,'network:unlink');
  assert.equal(unlinked.ok,true,unlinked.error);
  assert.equal(h.data.agentsByChat[OTHER],undefined);
  assert.equal(h.registrations,0);
  assert.ok(h.events.some(x=>x.method==='DELETE' && x.url.endsWith(
    '/chat-credentials/credential-bound-server')));
  const visible=await h.popupRequest(10,'network:available-agents');
  assert.equal(visible.items[0].agentId,synced.agent_id,'agent remains on server');
});

test('non-ChatGPT server agent cannot be bound by the extension',async()=>{
  const synced={agent_id:'codex-only',name:'Codex-Only',kind:'codex',
    role:'Developer',purpose:'',description:'',teams:[]};
  const h=networkHarness({urls:[OTHER],remoteProfiles:[synced]});
  const options=await h.popupRequest(10,'network:available-agents');
  assert.equal(options.items[0].kind,'codex');
  const attempt=await h.popupRequest(10,'network:start',{profile:{
    agentId:synced.agent_id,name:synced.name,role:synced.role,
  }});
  assert.equal(attempt.ok,false);
  assert.equal(h.data.agentsByChat[OTHER],undefined);
});

test('explicit server rebind requests fresh lease only after admin confirmation flag',async()=>{
  const synced={agent_id:'server-locked',name:'Locked-ChatGPT',kind:'chatgpt',
    role:'Developer',purpose:'',description:'',teams:[]};
  const h=networkHarness({urls:[OTHER],remoteProfiles:[synced],remoteBindConflict:true});
  const normal=await h.popupRequest(10,'network:start',{profile:{
    agentId:synced.agent_id,name:synced.name,role:synced.role,purpose:'',description:'',
  }});
  assert.equal(normal.ok,false);
  assert.match(normal.error,/active binding/);
  const forced=await h.popupRequest(10,'network:start',{profile:{
    agentId:synced.agent_id,name:synced.name,role:synced.role,purpose:'',description:'',
    rebind:true,
  }});
  assert.equal(forced.ok,true,forced.error);
  const requests=h.events.filter(x=>x.url?.endsWith('/chat-credentials') && x.method==='POST');
  assert.equal(requests.length,2);
  assert.equal(h.data.agentsByChat[OTHER].agentId,synced.agent_id);
  assert.equal(h.registrations,0);
});
