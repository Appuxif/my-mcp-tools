const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const src = fs.readFileSync(path.join(__dirname, '../dashboard/dashboard-conversations.js'),'utf8');

class Element {
  constructor(tag='div', id='') {
    this.tagName = tag.toUpperCase(); this.id = id; this.listeners = {};
    this.children=[]; this._text=''; this.dataset={}; this.hidden=false;
    this.disabled=false; this.style={}; this.attributes={};this.className='';
    const classes=new Set();
    this.classList={add:(x)=>classes.add(x),remove:(x)=>classes.delete(x),
      contains:(x)=>classes.has(x)};
    this.scrollTop=0; this.clientHeight=260;
    this.isConnected=true;this.title='';this.type='';this.parentElement=null;
  }
  set textContent(v){this._text=String(v);this.children=[];}
  get textContent(){return this._text+this.children.map(c=>c.textContent).join('');}
  setAttribute(k,v){this.attributes[k]=String(v);}
  getAttribute(k){return this.attributes[k] ?? null;}
  append(...elements) {
    for(const el of elements) {
      if (el.tagName==='#FRAGMENT') {
        this.append(...el.children);el.children=[];
      } else {el.parentElement=this;this.children.push(el);}
    }
  }
  prepend(...elements) {
    const combined=[];
    for(const el of elements) {
      if (el.tagName==='#FRAGMENT') {combined.push(...el.children);el.children=[];}
      else combined.push(el);
    }
    for(const el of combined)el.parentElement=this;
    this.children.unshift(...combined);
  }
  replaceChildren(...elements){this._text='';this.children=[];this.append(...elements);}
  addEventListener(k,fn){(this.listeners[k]??=[]).push(fn);}
  dispatch(k,e={}){for(const fn of (this.listeners[k]||[]))fn(e);}
  focus(){this.focused=true;}
  get scrollHeight() {
    if(this.id==='chat-thread-scroll') {
      return (this.owner.getElementById('chat-messages').children.length*110)+50;
    }
    return this.children.length*100;
  }
  querySelectorAll(){return [];}
}

function harness({unauthorized=false}={}) {
  const ids=[
    'chat-overlay','chat-drawer','chat-close','chat-backdrop','chat-drawer-title',
    'chat-drawer-subtitle','chat-peer-count','chat-peer-list','chat-peer-title',
    'chat-thread-status','chat-refresh','chat-load-older','chat-thread-scroll',
    'chat-messages','chat-footer','open-agent-chat',
  ];
  const elems=Object.fromEntries(ids.map(id=>[id,new Element('div',id)]));
  const listeners={}; const requests=[];
  const document={
    activeElement:new Element('button','initial-focus'),
    getElementById(id){return elems[id];},
    createElement(tag){return new Element(tag);},
    createDocumentFragment(){return new Element('#fragment');},
    addEventListener(name,fn){(listeners[name]??=[]).push(fn);},
    dispatchEvent(event){for(const fn of (listeners[event.type]||[]))fn(event);}
  };
  elems['chat-thread-scroll'].owner=document;
  elems['chat-overlay'].hidden=true;
  elems['chat-load-older'].hidden=true;
  elems['open-agent-chat'].dataset.agentId='A';
  const storage=new Map();
  const responses={
    peers:{agent_id:'A',agent_name:'Alpha',items:[
      {peer_id:'C',peer_name:'Charlie',message_count:1,last_message_at:400,pending_for_agent:0},
      {peer_id:'B',peer_name:'Bravo',message_count:4,last_message_at:300,pending_for_agent:1}
    ]},
    latest:{agent_id:'A',peer_id:'B',agent_name:'Alpha',peer_name:'Bravo',
      has_more:true,next_cursor:'m3',items:[
        {message_id:'m3',sender_id:'A',sender_name:'Alpha',recipient_id:'B',
         body:'text with <img onerror=alert(1)>',created_at:300,status:'pending'},
        {message_id:'m4',sender_id:'B',sender_name:'Bravo',recipient_id:'A',
         body:'reply 4',created_at:320,status:'acknowledged'},
      ]},
    older:{agent_id:'A',peer_id:'B',agent_name:'Alpha',peer_name:'Bravo',
      has_more:false,next_cursor:null,items:[
        {message_id:'m1',sender_id:'A',sender_name:'Alpha',recipient_id:'B',
         body:'first',created_at:100,status:'acknowledged'},
        {message_id:'m2',sender_id:'B',sender_name:'Bravo',recipient_id:'A',
         body:'second',created_at:200,status:'pending'},
      ]},
    c:{agent_id:'A',peer_id:'C',agent_name:'Alpha',peer_name:'Charlie',
      has_more:false,next_cursor:null,items:[
        {message_id:'c1',sender_id:'C',sender_name:'Charlie',recipient_id:'A',
         body:'C writes',created_at:400,status:'pending'},
      ]}
  };
  const fetch=async (url, options)=>{
    requests.push({url,options});
    assert.equal(options.method,'GET');
    assert.equal(options.credentials,'same-origin');
    assert.equal(options.headers['X-Admin-Token'],undefined);
    if(unauthorized)return {ok:false,status:401,async json(){return {detail:'Denied'}}};
    const parsed=new URL(url,'http://127.0.0.1:8787');
    const result=parsed.pathname.endsWith('/messages') ?
      (parsed.pathname.includes('/C/')?responses.c:
       parsed.searchParams.get('before')?responses.older:responses.latest)
      : responses.peers;
    return {ok:true,status:200,async json(){return structuredClone(result)}};
  };
  const context=vm.createContext({
    console, document,fetch, URL,location:{origin:'http://127.0.0.1:8787'},
    Date, CustomEvent:class {constructor(type,opts){this.type=type;this.detail=opts?.detail;}},
    structuredClone
  });
  const bodyClass=new Set();
  document.body={classList:{
    add(x){bodyClass.add(x)},remove(x){bodyClass.delete(x)},
    contains(x){return bodyClass.has(x)}
  }};
  vm.runInContext(src, context);
  const flush=async()=>{for(let i=0;i<5;i++)await new Promise(setImmediate);};
  return {
    elems,document,requests,flush,
    open:async(detail={agentId:'A',peerId:'B'})=>{
      document.dispatchEvent({type:'agent-network:open-chat',detail});await flush();
    },
    click:async id=>{elems[id].dispatch('click');await flush();},
    scroll:async top=>{elems['chat-thread-scroll'].scrollTop=top;
      elems['chat-thread-scroll'].dispatch('scroll');await flush();}
  };
}
function bodies(h) {
  return h.elems['chat-messages'].children.map(e=>
    e.children.find(n=>n.className==='chat-message-body')?.textContent);
}
test('opens authorized peer list and selected message from activity',async()=>{
  const h=harness();
  await h.open();
  assert.equal(h.elems['chat-overlay'].hidden,false);
  assert.equal(h.elems['chat-drawer-title'].textContent,'Alpha');
  assert.equal(h.elems['chat-peer-count'].textContent,'2');
  assert.equal(h.elems['chat-peer-title'].textContent,'Bravo');
  assert.deepEqual(bodies(h),['text with <img onerror=alert(1)>','reply 4']);
  assert.equal(h.elems['chat-thread-scroll'].scrollTop,
               h.elems['chat-thread-scroll'].scrollHeight);
  assert.equal(h.requests.length,2);
  assert.equal(h.requests.every(r=>!r.options.headers['X-Admin-Token']),true);
  assert.equal(h.requests.some(r=>r.options.method!=='GET'),false);
  assert.equal(h.elems['chat-load-older'].hidden,false);
});

test('older history is prepended on scroll with preserved viewport position',async()=>{
  const h=harness();await h.open();
  const scroll=h.elems['chat-thread-scroll'];
  assert.equal(bodies(h).length,2);
  await h.scroll(0);
  assert.deepEqual(bodies(h),['first','second','text with <img onerror=alert(1)>','reply 4']);
  assert.ok(scroll.scrollTop>0,'scrollTop should preserve the previous visible content');
  assert.equal(h.elems['chat-load-older'].hidden,true);
  assert.equal(h.requests.length,3);
});

test('chooses the newest existing chat by default and switches to a different peer',async()=>{
  const h=harness();await h.open({agentId:'A'});
  assert.equal(h.elems['chat-peer-title'].textContent,'Charlie');
  assert.deepEqual(bodies(h),['C writes']);
  const bravo=h.elems['chat-peer-list'].children[1];
  bravo.dispatch('click');await h.flush();
  assert.deepEqual(bodies(h),['text with <img onerror=alert(1)>','reply 4']);
});

test('browser Basic session allows opening without any extra token prompt',async()=>{
  const h=harness();await h.open();
  assert.equal(h.elems['chat-overlay'].hidden,false);
  assert.equal(h.requests.length,2);
  assert.equal(h.requests.every(r=>r.options.credentials==='same-origin'),true);
});

test('expired browser Basic login fails closed and never renders message bodies',async()=>{
  const h=harness({unauthorized:true});await h.open();
  assert.equal(h.elems['chat-overlay'].hidden,false);
  assert.match(h.elems['chat-peer-list'].textContent,/вход|администратора/i);
  assert.equal(h.requests.length,1);
  assert.deepEqual(bodies(h).filter(Boolean),[]);
});

test('close hides drawer and restores focus without changing messages',async()=>{
  const h=harness();await h.open();await h.click('chat-close');
  assert.equal(h.elems['chat-overlay'].hidden,true);
  assert.equal(h.document.body.classList.contains('chat-open'),false);
  assert.equal(h.requests.length,2);
});
