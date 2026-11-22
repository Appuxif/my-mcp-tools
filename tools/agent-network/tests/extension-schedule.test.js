const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');

const SOURCE=fs.readFileSync(path.join(__dirname,'../extension/background.js'),'utf8');
const KEY='https://chatgpt.com/c/scheduled-agent';
const PREFIX='agent-network-schedule:';
const AGENT='agent-uuid-scheduler';
const SCOPED='http://127.0.0.1:8787|'+AGENT;

function harness({state='idle',active=true,open=true,sendDelay=0,probeMutate=null}={}) {
  const events=[],alarms=new Map(),hooks={};
  const tabs=new Map(open?[[10,{id:10,url:KEY}]]:[]);
  const records={
    [KEY]:{
      name:'MCP-Dispatcher',role:'Dispatcher',agentId:AGENT,
      token:'test-agent-token',chatUrl:KEY,ownerTabId:10,
      server:'http://127.0.0.1:8787',active,bootstrapDone:true,
    }
  };
  const data={agentsByChat:records,agentSchedulesById:{}};
  const event=name=>({addListener(fn){hooks[name]=fn;}});
  const chrome={
    webRequest:{onBeforeRequest:event('request'),onCompleted:event('response'),
                onErrorOccurred:event('error')},
    runtime:{onMessage:event('message'),onStartup:event('startup'),
             onInstalled:event('installed')},
    alarms:{
      onAlarm:event('alarm'),
      create(name,props){alarms.set(name,props);},
      async get(name){return alarms.has(name)?{name,...alarms.get(name)}:undefined;},
      async clear(name){return alarms.delete(name);},
    },
    tabs:{
      onRemoved:event('removed'),onUpdated:event('updated'),
      async get(id){const value=tabs.get(Number(id));if(!value)throw Error('No tab');return {...value};},
      async query(){return [...tabs.values()].map(tab=>({...tab}));},
      async sendMessage(id,msg) {
        events.push({type:msg.type,tabId:id,message:msg});
        if(msg.type==='agent:probe'){
          if(probeMutate)probeMutate(data);
          return {state};
        }
        if(msg.type==='agent:send') {
          if(sendDelay) await new Promise(done=>setTimeout(done,sendDelay));
          return {ok:true};
        }
        throw Error('Unexpected message');
      }
    },
    scripting:{async executeScript(){throw Error('Should not inject');}},
    storage:{local:{
      async setAccessLevel(){},
      async get(keys){
        if(Array.isArray(keys))return Object.fromEntries(keys
          .filter(key=>key in data).map(key=>[key,structuredClone(data[key])]));
        return {[keys]:structuredClone(data[keys])};
      },
      async set(values){Object.assign(data,structuredClone(values));},
      async remove(key){delete data[key];},
    }}
  };
  class WebSocket {
    static OPEN=1;
    readyState=1;
    constructor(){this.readyState=1;}
    send(){}
    close(){this.readyState=3;}
  }
  const context=vm.createContext({
    chrome,URL,console,WebSocket,setTimeout,setInterval(){return 1;},clearInterval(){},
    importScripts(){},
    AgentNetworkTraffic:{
      TrafficTracker:class {started(){}finished(){}clear(){}
        snapshot(){return {phase:'idle',activeRequests:0};}},
      combineState(dom){return {state:dom};},
    },
  });
  vm.runInContext(SOURCE,context);
  const request=(type,extra={},popup=true)=>new Promise(resolve=>{
    hooks.message({type,tabId:10,...extra},popup?{}:{tab:{id:10,url:KEY}},resolve);
  });
  const save=(enabled=true,text='Check Notion backlog',intervalMinutes=5)=>
    request('network:schedule-set',{schedule:{enabled,text,intervalMinutes}});
  const alarm=async()=>{hooks.alarm({name:PREFIX+SCOPED});await settle();};
  const settle=async()=>{for(let i=0;i<8;i++)await new Promise(done=>setImmediate(done));};
  const sent=()=>events.filter(e=>e.type==='agent:send');
  return {data,alarms,hooks,tabs,events,request,save,alarm,settle,sent,
    setState(value){state=value;}
  };
}

test('schedule saves for a bound agent and delivers a manual wake',async()=>{
  const h=harness();
  const saved=await h.save();
  assert.equal(saved.ok,true);
  assert.equal(saved.schedule.enabled,true);
  assert.equal(h.alarms.get(PREFIX+SCOPED).periodInMinutes,5);
  const result=await h.request('network:schedule-run');
  assert.equal(result.ok,true);
  assert.equal(result.sent,true);
  assert.equal(h.sent().length,1);
  assert.match(h.sent()[0].message.text,/Check Notion backlog/);
  assert.match(h.sent()[0].message.text,/agent_id: agent-uuid-scheduler/);
  const get=await h.request('network:schedule-get');
  assert.equal(get.schedule.lastAttempt.state,'sent');
  assert.equal(get.schedule.lastAttempt.reason,'Пробуждение отправлено');
});

test('alarm sends once, then disabled schedule no longer sends',async()=>{
  const h=harness();
  await h.save();
  await h.alarm();
  assert.equal(h.sent().length,1);
  await h.save(false,'Check Notion backlog');
  assert.equal(h.alarms.has(PREFIX+SCOPED),false);
  await h.alarm(); // stale callback after alarm was cleared
  assert.equal(h.sent().length,1);
});

test('unknown interval or empty enabled instruction is rejected',async()=>{
  const h=harness();
  const bad=await h.save(true,'Check backlog',2);
  assert.equal(bad.ok,false);
  const blank=await h.save(true,'  ',5);
  assert.equal(blank.ok,false);
  assert.equal(h.alarms.size,1); // only the preexisting resume alarm
});

test('schedule never overwrites an active composer or draft',async()=>{
  const h=harness({state:'draft'});
  await h.save();
  await h.alarm();
  assert.equal(h.sent().length,0);
  assert.equal((await h.request('network:schedule-get')).schedule.lastAttempt.state,'skipped');
  h.setState('busy');
  await h.alarm();
  assert.equal(h.sent().length,0);
  h.setState('idle');
  await h.alarm();
  assert.equal(h.sent().length,1);
});

test('stopped agent and closed conversation are skipped without reopening it',async()=>{
  const h=harness({active:false});
  await h.save();
  await h.alarm();
  assert.equal(h.sent().length,0);
  h.data.agentsByChat[KEY].active=true;
  h.tabs.clear();
  await h.alarm();
  assert.equal(h.sent().length,0);
  assert.equal(h.data.agentSchedulesById[SCOPED].lastAttempt.reason,'Чат агента не открыт');
});

test('schedule is bound to agent ID and follows migrated chat',async()=>{
  const h=harness();
  await h.save();
  const next='https://chatgpt.com/c/migrated-agent';
  h.data.agentsByChat[next]={...h.data.agentsByChat[KEY],chatUrl:next,ownerTabId:20};
  delete h.data.agentsByChat[KEY];
  h.tabs.clear();
  h.tabs.set(20,{id:20,url:next});
  await h.alarm();
  assert.equal(h.sent().length,1);
  assert.equal(h.sent()[0].tabId,20);
  assert.equal(h.sent()[0].message.url,next);
});

test('overlapping manual triggers never send duplicate messages',async()=>{
  const h=harness({sendDelay:20});
  await h.save();
  const [a,b]=await Promise.all([
    h.request('network:schedule-run'),
    h.request('network:schedule-run')
  ]);
  assert.equal(a.ok,true);
  assert.equal(b.ok,true);
  assert.equal(h.sent().length,1);
  assert.equal([a.sent,b.sent].filter(Boolean).length,1);
});

test('schedule preferences are popup-only',async()=>{
  const h=harness();
  const res=await h.request('network:schedule-set',{
    schedule:{enabled:true,text:'Test',intervalMinutes:5}
  },false);
  assert.equal(res.ok,false);
  assert.equal(h.data.agentSchedulesById[SCOPED],undefined);
});

test('startup restores a missing alarm for saved schedules',async()=>{
  const h=harness();
  await h.save();
  h.alarms.delete(PREFIX+SCOPED);
  h.hooks.startup();
  await h.settle();
  assert.equal(h.alarms.has(PREFIX+SCOPED),true);
});

test('schedule UI exposes the required controls',()=>{
  const html=fs.readFileSync(path.join(__dirname,'../extension/popup.html'),'utf8');
  for(const id of ['schedule-section','schedule-enabled','schedule-interval',
                   'schedule-text','schedule-save','schedule-run','schedule-info']) {
    assert.match(html,new RegExp('id="'+id+'"'));
  }
});


test('scheduled wake refuses a stale token when binding changes during probe',async()=>{
  const h=harness({probeMutate:data=>{
    data.agentsByChat[KEY].token='NEW_TOKEN_FOR_SAME_AGENT';
  }});
  await h.save();
  const result=await h.request('network:schedule-run');
  assert.equal(result.ok,true,result.error);
  assert.equal(result.sent,false);
  assert.equal(h.sent().length,0);
  assert.match(h.data.agentSchedulesById[SCOPED].lastAttempt.reason,
               /привязка изменились/);
});

test('changing server revokes its scheduling policy and clears old alarm',async()=>{
  const h=harness({active:false});
  await h.save();
  assert.equal(h.data.agentSchedulesById[SCOPED].enabled,true);
  assert.equal(h.alarms.has(PREFIX+SCOPED),true);
  const changed=await h.request('network:set-server',{
    server:'http://127.0.0.1:8999',
  });
  assert.equal(changed.ok,true,changed.error);
  assert.equal(h.data.agentSchedulesById[SCOPED].enabled,false);
  assert.equal(h.alarms.has(PREFIX+SCOPED),false);
  assert.equal(h.data.agentsByChat[KEY],undefined);
  await h.alarm();
  assert.equal(h.sent().length,0);
});

test('server-scoped schedule cannot run same UUID on different server',async()=>{
  const h=harness();
  await h.save();
  const foreign='https://chatgpt.com/c/other-server-agent';
  h.data.agentsByChat[foreign]={
    ...h.data.agentsByChat[KEY],server:'http://127.0.0.1:8999',
    chatUrl:foreign,ownerTabId:20,
  };
  h.tabs.set(20,{id:20,url:foreign});
  h.data.agentsByChat[KEY].active=false;
  await h.alarm();
  assert.equal(h.sent().length,0);
  assert.equal(h.data.agentSchedulesById[SCOPED].lastAttempt.state,'skipped');
});
