const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const AgentNetworkStatus = require('../extension/agent-status.js');

const script = fs.readFileSync(path.join(__dirname,'../extension/agent-hud.js'),'utf8');

function createPage(registered=true) {
  const chatUrl='https://chatgpt.com/c/aaa';
  const callbacks={};
  const intervalCallbacks=[];
  const requests=[];
  const preferences={};
  let appended=null;
  const els=new Map();
  const newElement=()=>({
    hidden:false,style:{},dataset:{},textContent:'',title:'',className:'',
    attributes:{},listeners:{},
    setAttribute(name,value){this.attributes[name]=value;},
    addEventListener(name,cb){this.listeners[name]=cb;},
    getBoundingClientRect(){return {left:1000,top:96,width:300,height:390};},
    attachShadow() {
      const root={
        getElementById(id){return els.get(id);},
        set innerHTML(html) {
          for(const match of html.matchAll(/id="([^"]+)"/g))
            els.set(match[1],newElement());
        }
      };
      return root;
    }
  });
  const response={
    ok:true,visible:true,name:'Chopper-Developer',agentId:'a',active:true,
    connected:true,server:'http://127.0.0.1:8787',chatUrl,ui:'busy',
    updatedAt:Date.now(),
    status:{
      name:'Chopper-Developer',role:'Developer',
      pending:3,sent24h:7,sentCountIsLowerBound:false,
      lastOutbound:{peer:'Chopper-Reviewer',time:Date.now()/1000-45,status:'acknowledged'},
      lastInbound:{peer:'Chopper-Reviewer',time:Date.now()/1000-92,status:'pending'},
      task:'Building avatar editor',taskStatus:'working',
      lastMcp:Date.now()/1000-15,lastWake:Date.now()/1000-100,
      adapter:{state:'busy'}
    }
  };
  const location={href:chatUrl,pathname:'/c/aaa'};
  const document={
    readyState:'complete',body:{appendChild(el){appended=el;}},
    createElement:()=>newElement(),
    addEventListener(name,fn){callbacks[name]=fn;}
  };
  const window={addEventListener(name,fn){callbacks[name]=fn;}};
  const chrome={
    runtime:{
      getURL(name){return 'chrome-extension://extension-id/'+name;},
      async sendMessage(msg) {
        requests.push(msg);
        if(msg.type==='network:hud-open-dashboard') return {ok:true};
        assert.equal(msg.type,'network:hud-status');
        return registered ? response : {ok:true,visible:false};
      }
    },
    storage:{local:{
      async get(key){return {[key]:preferences[key]};},
      async set(prefs){Object.assign(preferences,prefs);}
    }}
  };
  const context=vm.createContext({
    console,document,window,chrome,location,AgentNetworkStatus,
    innerWidth:1440,innerHeight:800,
    setInterval(fn){intervalCallbacks.push(fn);return intervalCallbacks.length;},
  });
  vm.runInContext(script,context);
  const flush=async()=>{for(let i=0;i<5;i++)await new Promise(resolve=>setImmediate(resolve));};
  return {
    flush,els,preferences,requests,location,intervalCallbacks,
    get host(){return appended;},
    click(id){els.get(id).listeners.click();}
  };
}

test('HUD appears automatically for its agent and renders message metadata only',async()=>{
  const page=createPage();
  await page.flush();
  assert.ok(page.host);
  assert.equal(page.host.hidden,false);
  assert.equal(page.els.get('name').textContent,'Chopper-Developer');
  assert.equal(page.els.get('pending').textContent,'3');
  assert.equal(page.els.get('sent').textContent,'7');
  assert.equal(page.els.get('last-out').textContent,'Chopper-Reviewer');
  assert.match(page.els.get('last-out-time').textContent,/✓/);
  assert.equal(page.els.get('last-in').textContent,'Chopper-Reviewer');
  assert.equal(page.els.get('ui-state').textContent,'Генерация');
  assert.equal(page.els.get('push').textContent,'Генерация');
  assert.equal(page.els.get('task').textContent,'Building avatar editor');
  assert.deepEqual(Array.from(page.requests.map(r=>r.type)),['network:hud-status']);
  assert.equal(JSON.stringify(page.requests).includes('token'),false);
});

test('HUD can collapse, hide to unread badge and restore without extension popup',async()=>{
  const page=createPage();
  await page.flush();
  page.click('collapse');
  await page.flush();
  assert.equal(page.host.dataset.mode,'collapsed');
  page.click('hide');
  await page.flush();
  assert.equal(page.host.dataset.mode,'icon');
  assert.equal(page.els.get('bubble-count').textContent,'3');
  assert.equal(page.els.get('bubble-count').hidden,false);
  page.click('restore');
  await page.flush();
  assert.equal(page.host.dataset.mode,'full');
  assert.equal(page.preferences['agentNetworkHud:a'].mode,'full');
  page.click('dashboard');
  await page.flush();
  assert.equal(page.requests.at(-1).type,'network:hud-open-dashboard');
});

test('unregistered conversations never receive a floating widget',async()=>{
  const page=createPage(false);
  await page.flush();
  assert.equal(page.host,null);
});

test('HUD disappears on single-page chat navigation',async()=>{
  const page=createPage();
  await page.flush();
  page.location.href='https://chatgpt.com/c/another-conversation';
  page.location.pathname='/c/another-conversation';
  for(const callback of page.intervalCallbacks)callback();
  await page.flush();
  assert.equal(page.host.hidden,true);
});
