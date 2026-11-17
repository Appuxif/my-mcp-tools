const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const AgentNetworkStatus = require('../extension/agent-status.js');

const script = fs.readFileSync(path.join(__dirname,'../extension/agent-hud.js'),'utf8');

function createPage(registered=true, {delayInitialStatus=false}={}) {
  const chatUrl='https://chatgpt.com/c/aaa';
  const callbacks={};
  const intervalCallbacks=[];
  const requests=[];
  const hudMessages=[];
  const preferences={};
  let isRegistered=registered;
  let resolveInitialStatus=null;
  let initialStatusSeen=false;
  let appended=null;
  const els=new Map();
  const newElement=(tag='div')=>({
    tagName:tag.toUpperCase(),id:'',hidden:false,style:{},dataset:{},
    _text:'',title:'',className:'',children:[],listeners:{},attributes:{},
    set textContent(v){this._text=String(v);this.children=[];},
    get textContent(){return this._text+this.children.map(c=>c.textContent).join('');},
    setAttribute(name,value){this.attributes[name]=String(value);},
    addEventListener(name,cb){this.listeners[name]=cb;},
    append(...items){this.children.push(...items);},
    prepend(...items){this.children.unshift(...items);},
    replaceChildren(...items){this._text='';this.children=[...items];},
    focus(){this.focused=true;},
    querySelectorAll(){return [];},
    get scrollHeight(){
      return this.id==='chat-scroll'
        ? (els.get('chat-bubbles')?.children.length||0)*110+50
        : this.children.length*110;
    },
    getBoundingClientRect(){return {left:1000,top:96,width:300,height:390};},
    attachShadow() {
      const root={
        activeElement:null,
        getElementById(id){return els.get(id);},
        addEventListener(name,callback){callbacks['shadow:'+name]=callback;},
        set innerHTML(html) {
          for(const match of html.matchAll(/<[^>]*\bid="([^"]+)"[^>]*>/g)){
            const node=newElement();
            node.id=match[1];
            node.hidden=/\shidden(?:\s|>)/.test(match[0]);
            els.set(match[1],node);
          }
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
    createElement:(tag)=>newElement(tag),
    addEventListener(name,fn){callbacks[name]=fn;}
  };
  const window={addEventListener(name,fn){callbacks[name]=fn;}};
  const chrome={
    runtime:{
      onMessage:{addListener(listener){hudMessages.push(listener);}},
      getURL(name){return 'chrome-extension://extension-id/'+name;},
      async sendMessage(msg) {
        requests.push(msg);
        if(msg.type==='network:hud-open-dashboard') return {ok:true};
        if(msg.type==='network:hud-conversations') return {
          ok:true,agent_id:'a',agent_name:'Chopper-Developer',
          items:[
            {peer_id:'b',peer_name:'Chopper-Reviewer',message_count:4,pending_for_agent:1},
            {peer_id:'c',peer_name:'Another agent',message_count:1,pending_for_agent:0},
          ]
        };
        if(msg.type==='network:hud-messages') {
          if(msg.peerId==='c') return {
            ok:true,agent_id:'a',peer_id:'c',items:[
              {message_id:'c1',sender_id:'c',sender_name:'Another agent',
                created_at:170,status:'pending',body:'Hello'}
            ],has_more:false,next_cursor:null
          };
          if(msg.peerId!=='b')return {ok:false,error:'Unrelated conversation'};
          return {
            ok:true,agent_id:'a',peer_id:'b',
            items:msg.before ? [
              {message_id:'m1',sender_id:'a',sender_name:'Chopper-Developer',
                created_at:100,status:'acknowledged',body:'Old outbound'},
              {message_id:'m2',sender_id:'b',sender_name:'Chopper-Reviewer',
                created_at:120,status:'pending',body:'Old inbound'},
            ] : [
              {message_id:'m3',sender_id:'b',sender_name:'Chopper-Reviewer',
                created_at:200,status:'pending',body:'<img onerror=alert(1)>'},
              {message_id:'m4',sender_id:'a',sender_name:'Chopper-Developer',
                created_at:230,status:'acknowledged',body:'Review received'}
            ],
            has_more:!msg.before,next_cursor:msg.before?null:'m3'
          };
        }
        assert.equal(msg.type,'network:hud-status');
        if (delayInitialStatus && !initialStatusSeen) {
          initialStatusSeen=true;
          return new Promise(resolve => {resolveInitialStatus=resolve;});
        }
        return isRegistered ? response : {ok:true,visible:false};
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
    setRegistered(value){isRegistered=value;},
    releaseInitialStatus(value={ok:true,visible:false}){
      assert.ok(resolveInitialStatus,'No pending status request');
      resolveInitialStatus(value);
    },
    async notify(message){
      let response;
      const answered = new Promise(resolve => {
        const handled = hudMessages.map(listener =>
          listener(message,null,payload => {response=payload;resolve();}));
        if(!handled.some(Boolean))resolve();
      });
      await answered;
      return response;
    },
    get host(){return appended;},
    click(id){els.get(id).listeners.click();},
    clickPeer(index){els.get('chat-peers').children[index].listeners.click();},
    scrollToTop(){els.get('chat-scroll').scrollTop=0;els.get('chat-scroll').listeners.scroll();},
    async pressKey(key){callbacks['shadow:keydown']?.({key,preventDefault(){},stopPropagation(){},shiftKey:false});await flush();}
  };
}

async function showHud(page) {
  const result=await page.notify({
    type:'network:hud-show',agentId:'a',name:'Chopper-Developer',
    role:'Developer',chatUrl:'https://chatgpt.com/c/aaa'
  });
  assert.equal(result.ok,true);
  await page.flush();
}

test('HUD stays absent until explicit Show and then renders its metadata',async()=>{
  const page=createPage();
  await page.flush();
  assert.equal(page.host,null);
  assert.equal(page.requests.length,0,'registered chat must not poll automatically');
  await showHud(page);
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
  await showHud(page);
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
  await showHud(page);
  page.location.href='https://chatgpt.com/c/another-conversation';
  page.location.pathname='/c/another-conversation';
  for(const callback of page.intervalCallbacks)callback();
  await page.flush();
  assert.equal(page.host.hidden,true);
});

test('HUD chat button opens private read-only modal with peer list and message bubbles',async()=>{
  const page=createPage();await page.flush();await showHud(page);
  page.click('messages');await page.flush();
  assert.equal(page.els.get('chat-modal').hidden,false);
  assert.equal(page.els.get('chat-title').textContent,'Chopper-Developer');
  assert.equal(page.els.get('chat-peer-count').textContent,'2');
  assert.equal(page.els.get('chat-peer-title').textContent,'Chopper-Reviewer');
  const bubbles=page.els.get('chat-bubbles').children;
  assert.equal(bubbles.length,2);
  assert.ok(bubbles[0].className.includes('incoming'));
  assert.ok(bubbles[1].className.includes('outgoing'));
  assert.equal(bubbles[0].children[1].textContent,'<img onerror=alert(1)>');
  assert.equal(page.els.get('chat-older').hidden,false);
  assert.deepEqual(Array.from(page.requests.map(r=>r.type)),[
    'network:hud-status','network:hud-conversations','network:hud-messages'
  ]);
  assert.equal(JSON.stringify(page.requests).includes('token'),false);
  assert.equal(JSON.stringify(page.requests).includes('body'),false);
});

test('HUD chat scroll loads older messages without jumping and can switch peer',async()=>{
  const page=createPage();await page.flush();await showHud(page);page.click('messages');await page.flush();
  page.scrollToTop();await page.flush();
  const bubbles=page.els.get('chat-bubbles').children;
  assert.equal(bubbles.length,4);
  assert.equal(bubbles[0].children[1].textContent,'Old outbound');
  assert.equal(page.els.get('chat-older').hidden,true);
  assert.ok(page.els.get('chat-scroll').scrollTop>0);
  page.clickPeer(1);await page.flush();
  assert.equal(page.els.get('chat-peer-title').textContent,'Another agent');
  assert.equal(page.els.get('chat-bubbles').children.length,1);
  assert.equal(page.els.get('chat-bubbles').children[0].children[1].textContent,'Hello');
});

test('HUD modal closes on Escape and is dismissed on chat navigation',async()=>{
  const page=createPage();await page.flush();await showHud(page);page.click('messages');await page.flush();
  await page.pressKey('Escape');
  assert.equal(page.els.get('chat-modal').hidden,true);
  assert.equal(page.els.get('chat-bubbles').children.length,0);
  page.click('messages');await page.flush();
  page.location.href='https://chatgpt.com/c/another-conversation';
  page.location.pathname='/c/another-conversation';
  for(const callback of page.intervalCallbacks)callback();
  await page.flush();
  assert.equal(page.els.get('chat-modal').hidden,true);
  assert.equal(page.host.hidden,true);
});

test('Explicit Show displays HUD without waiting for the 12-second polling timer',async()=>{
  const page=createPage(false);
  await page.flush();
  assert.equal(page.host,null);
  page.setRegistered(true);
  const result=await page.notify({
    type:'network:hud-show',agentId:'a',name:'Chopper-Developer',
    role:'Developer',chatUrl:'https://chatgpt.com/c/aaa'
  });
  assert.equal(result.ok,true);
  assert.ok(page.host);
  assert.equal(page.host.hidden,false);
  assert.equal(page.host.dataset.mode,'full');
  assert.equal(page.els.get('name').textContent,'Chopper-Developer');
  await page.flush();
  assert.equal(page.els.get('pending').textContent,'3');
});

test('Explicit Show reopens a HUD previously hidden to its icon',async()=>{
  const page=createPage();await page.flush();await showHud(page);
  page.click('hide');await page.flush();
  assert.equal(page.host.dataset.mode,'icon');
  const response=await page.notify({
    type:'network:hud-show',agentId:'a',name:'Chopper-Developer',
    role:'Developer',chatUrl:'https://chatgpt.com/c/aaa'
  });
  await page.flush();
  assert.equal(response.ok,true);
  assert.equal(page.host.dataset.mode,'full');
  assert.equal(page.host.hidden,false);
});

test('Start notification for a different conversation cannot show a HUD',async()=>{
  const page=createPage(false);await page.flush();
  const result=await page.notify({
    type:'network:hud-show',agentId:'a',name:'Unrelated agent',
    chatUrl:'https://chatgpt.com/c/another'
  });
  assert.equal(result.ok,false);
  assert.equal(page.host,null);
});

test('Explicit Show cannot be hidden by a stale status poll',async()=>{
  const page=createPage(true,{delayInitialStatus:true});
  await page.flush();
  assert.equal(page.host,null);
  const first=await page.notify({
    type:'network:hud-show',agentId:'a',name:'Chopper-Developer',
    role:'Developer',chatUrl:'https://chatgpt.com/c/aaa'
  });
  assert.equal(first.ok,true);
  assert.equal(page.host.hidden,false);
  assert.equal(page.els.get('ui-state').textContent,'Подключаюсь…');
  // A second manual Show supersedes the earlier in-flight request.
  const second=await page.notify({
    type:'network:hud-show',agentId:'a',name:'Chopper-Developer',
    role:'Developer',chatUrl:'https://chatgpt.com/c/aaa'
  });
  assert.equal(second.ok,true);
  page.releaseInitialStatus();
  await page.flush();
  assert.equal(page.host.hidden,false);
  assert.equal(page.els.get('pending').textContent,'3');
});
