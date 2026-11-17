const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const path=require('node:path');

const script=fs.readFileSync(path.join(__dirname,'../dashboard/dashboard-context.js'),'utf8');
const markdownScript=fs.readFileSync(path.join(__dirname,'../dashboard/dashboard-markdown.js'),'utf8');
const html=fs.readFileSync(path.join(__dirname,'../dashboard/index.html'),'utf8');

function harness(fetcher=async()=>({ok:true,json:async()=>({
  agent_id:'A',agent_name:'Alpha',exists:true,context:'# Title\n<evil>\nПривет',
  updated_at:1780000000,bytes:36,
})})) {
  const events={};
  const byId=new Map();
  let activeElement=null;
  const classes=()=> {
    const set=new Set();
    return {add:val=>set.add(val),remove:val=>set.delete(val),
      toggle:(val,on)=>{if(on===undefined? !set.has(val):on)set.add(val);else set.delete(val);},
      contains:val=>set.has(val)};
  };
  function element(id) {
    if(byId.has(id))return byId.get(id);
    const e={
      id,hidden:false,disabled:false,dataset:{},scrollTop:0,
      isConnected:true,listeners:{},classList:classes(),children:[],_text:'',
      set textContent(value){this._text=String(value);this.children=[];},
      get textContent(){return this._text+this.children.map(c=>c.textContent).join('');},
      append(...children){this.children.push(...children);},
      replaceChildren(...children){this._text='';this.children=[...children];},
      addEventListener(type,handler){(this.listeners[type]??=[]).push(handler);},
      click(){for(const f of this.listeners.click??[])f();},
      focus(){activeElement=this;},
      querySelectorAll(){return [];},
    };
    byId.set(id,e);return e;
  }
  const document={
    get activeElement(){return activeElement;},
    getElementById:element,
    createElement:tag=>Object.assign(element('generated-'+tag+'-'+byId.size),{tagName:tag.toUpperCase()}),
    createTextNode:value=>({tagName:'#text',textContent:String(value),children:[]}),
    body:{classList:classes()},
    addEventListener(type,handler){(events[type]??=[]).push(handler);},
    dispatch(type,extra={}){
      const e={key:type==='keydown'?'Escape':undefined,preventDefault(){},...extra};
      for(const f of events[type]??[])f(e);
    },
  };
  const copied=[];
  const calls=[];
  const fetch=async(url,opts)=>{
    calls.push({url,opts});
    return fetcher(url,opts);
  };
  const window={};
  const context=vm.createContext({
    document,window,fetch,URL,location:{origin:'http://127.0.0.1:8787'},
    navigator:{clipboard:{async writeText(value){copied.push(value);}}},
    console,
  });
  element('context-overlay').hidden=true;
  element('open-agent-context').dataset.agentId='A';
  element('context-wrap').checked=true;
  element('context-markdown').checked=true;
  vm.runInContext(markdownScript,context);
  context.AgentNetworkMarkdown=window.AgentNetworkMarkdown;
  vm.runInContext(script,context);
  const flush=async()=>{for(let i=0;i<8;i++)await new Promise(resolve=>setImmediate(resolve));};
  return {element,document,copied,calls,flush,get activeElement(){return activeElement;}};
}

test('context viewer is mounted as separate read-only dialog and script',()=>{
  for(const id of ['open-agent-context','context-dialog','context-scroll','context-copy',
                    'context-close','context-refresh','context-wrap']){
    assert.match(html,new RegExp('id="'+id+'"'));
  }
  assert.match(html,/dashboard-context\.js/);
  assert.match(html,/dashboard-markdown\.js/);
  assert.match(html,/id="context-rendered"/);
  assert.match(html,/id="context-markdown"/);
  assert.match(html,/aria-modal="true"/);
});

test('context viewer fetches administrator endpoint and renders exact untrusted text',async()=>{
  const h=harness();
  const previous=h.element('open-agent-context');previous.focus();
  previous.click();
  await h.flush();
  assert.equal(h.calls.length,1);
  assert.match(h.calls[0].url,/\/api\/v1\/dashboard\/agents\/A\/context$/);
  assert.equal(h.calls[0].opts.credentials,'same-origin');
  assert.equal(h.calls[0].opts.cache,'no-store');
  assert.equal(h.calls[0].opts.headers['X-Agent-Token'],undefined);
  assert.equal(h.element('context-content').textContent,'# Title\n<evil>\nПривет');
  assert.equal(h.element('context-rendered').hidden,false);
  assert.equal(h.element('context-content').hidden,true);
  assert.equal(h.element('context-rendered').children[0].tagName.toLowerCase(),'h1');
  assert.equal(h.element('context-title').textContent,'Alpha');
  assert.equal(h.element('context-copy').disabled,false);
  assert.match(h.element('context-meta').textContent,/байт/);
  assert.equal(h.element('context-overlay').hidden,false);
  assert.equal(h.activeElement,h.element('context-close'));
  h.element('context-copy').click();await h.flush();
  assert.equal(h.copied[0],'# Title\n<evil>\nПривет');
  h.element('context-wrap').checked=false;
  for(const f of h.element('context-wrap').listeners.change)f();
  assert.equal(h.element('context-content').classList.contains('no-wrap'),true);
  h.element('context-markdown').checked=false;
  for(const f of h.element('context-markdown').listeners.change)f();
  assert.equal(h.element('context-content').hidden,false);
  assert.equal(h.element('context-rendered').hidden,true);
  h.element('context-markdown').checked=true;
  for(const f of h.element('context-markdown').listeners.change)f();
  assert.equal(h.element('context-rendered').hidden,false);
  h.document.dispatch('keydown');
  assert.equal(h.element('context-overlay').hidden,true);
  assert.equal(h.activeElement,previous);
});

test('missing saved context has clear empty state and disables copying',async()=>{
  const h=harness(async()=>({ok:true,json:async()=>({
    agent_id:'A',agent_name:'Alpha',exists:false,context:'',updated_at:null,bytes:0,
  })}));
  h.element('open-agent-context').click();await h.flush();
  assert.match(h.element('context-content').textContent,/не вызывал save_context/);
  assert.equal(h.element('context-copy').disabled,true);
  assert.match(h.element('context-status').textContent,/Нет сохранённого/);
});

test('server errors are visible but do not expose secrets or stale contents',async()=>{
  const h=harness(async()=>({
    ok:false,status:401,json:async()=>({detail:'Internal server text'}),
  }));
  h.element('open-agent-context').click();await h.flush();
  assert.match(h.element('context-content').textContent,/авторизация администратора/);
  assert.equal(h.element('context-copy').disabled,true);
  assert.equal(h.element('context-refresh').disabled,false);
});

test('closing or switching agent invalidates pending context response',async()=>{
  const pending=[];
  const h=harness(()=>new Promise(resolve=>pending.push(resolve)));
  h.element('open-agent-context').click();
  await h.flush();
  h.element('open-agent-context').dataset.agentId='B';
  h.element('open-agent-context').click();
  await h.flush();
  assert.equal(pending.length,2);
  pending[1]({ok:true,json:async()=>({
    agent_id:'B',agent_name:'Beta',exists:true,context:'Beta only',bytes:9,
  })});
  await h.flush();
  pending[0]({ok:true,json:async()=>({
    agent_id:'A',agent_name:'Alpha',exists:true,context:'Stale Alpha',bytes:11,
  })});
  await h.flush();
  assert.equal(h.element('context-title').textContent,'Beta');
  assert.equal(h.element('context-content').textContent,'Beta only');
  h.element('context-close').click();
  assert.equal(h.element('context-overlay').hidden,true);
});

test('refresh reads the saved context anew only when requested',async()=>{
  let value='first';
  const h=harness(async()=>({ok:true,json:async()=>({
    agent_id:'A',agent_name:'Alpha',exists:true,context:value,bytes:value.length,
  })}));
  h.element('open-agent-context').click();await h.flush();
  assert.equal(h.element('context-content').textContent,'first');
  value='updated';
  assert.equal(h.element('context-content').textContent,'first');
  h.element('context-refresh').click();await h.flush();
  assert.equal(h.element('context-content').textContent,'updated');
  assert.equal(h.calls.length,2);
});
