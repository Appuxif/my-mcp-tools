const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const path=require('node:path');

const root=path.resolve(__dirname,'../dashboard');
const script=fs.readFileSync(path.join(root,'dashboard-tool-details.js'),'utf8');
const interactions=fs.readFileSync(path.join(root,'dashboard-interactions.js'),'utf8');
const html=fs.readFileSync(path.join(root,'index.html'),'utf8');

function harness(fetcher) {
  const nodes={}; const listeners={}; const fetched=[]; const copied=[];
  const classes=()=>({add(){},remove(){},contains(){return false;}});
  const doc={
    activeElement:null,
    body:{classList:classes()},
    getElementById(id){return nodes[id];},
    addEventListener(type,fn){(listeners[type]??=[]).push(fn);},
    dispatchEvent(event){for(const fn of listeners[event.type]??[])fn(event);},
  };
  for(const id of [
    'tool-call-overlay','tool-call-dialog','tool-call-close','tool-call-backdrop',
    'tool-call-title','tool-call-meta','tool-call-status','tool-call-refresh',
    'tool-call-copy','tool-call-scroll','tool-call-arguments','tools-body'
  ]){
    const el={
      id,hidden:false,disabled:false,scrollTop:0,isConnected:true,
      listeners:{},classList:classes(),_text:'',
      get textContent(){return this._text;},
      set textContent(v){this._text=String(v);},
      focus(){doc.activeElement=this;},
      querySelectorAll(){return [nodes['tool-call-close'],nodes['tool-call-refresh'],
        nodes['tool-call-copy']].filter(x=>!x.disabled);},
      addEventListener(type,fn){(this.listeners[type]??=[]).push(fn);},
      click(){for(const fn of this.listeners.click??[])fn({stopPropagation(){}});},
    };
    nodes[id]=el;
  }
  nodes['tool-call-overlay'].hidden=true;
  doc.activeElement=nodes['tools-body'];
  const fetch=async(url,opts)=>{
    fetched.push({url,opts});
    return fetcher?fetcher(url,opts):{ok:true,json:async()=>({
      id:13,tool_name:'send_message',agent_id:'agent-A',agent_name:'Reviewer',
      status:'ok',duration_ms:2.77,created_at:1795022213,
      arguments_truncated:false,
      arguments:{agent_id:'agent-A',token:'[REDACTED]',text:'<img onerror=alert(1)>'}
    })};
  };
  const ctx=vm.createContext({
    document:doc,fetch,URL,Number,Date,console,location:{origin:'http://127.0.0.1:8787'},
    navigator:{clipboard:{async writeText(text){copied.push(text);}}},
  });
  vm.runInContext(script,ctx);
  const flush=async()=>{for(let i=0;i<8;i++)await new Promise(setImmediate);};
  return {
    nodes,doc,fetched,copied,flush,
    open(id=13){doc.dispatchEvent({type:'agent-network:tool-call-detail',detail:{callId:id}});}
  };
}

test('history row opens read-only tool details using a delegated event',()=>{
  assert.match(interactions,/agent-network:tool-call-detail/);
  assert.match(interactions,/tr\.addEventListener\('click',show\)/);
  assert.match(html,/id="tool-call-overlay"/);
  assert.match(html,/id="tool-call-dialog"/);
  assert.match(html,/id="tool-call-arguments"/);
  assert.match(html,/dashboard-tool-details\.js/);
});

test('shows input arguments as raw JSON, safe from HTML execution',async()=>{
  const h=harness();
  const prior=h.doc.activeElement;
  h.open();
  await h.flush();
  assert.equal(h.fetched.length,1);
  assert.match(h.fetched[0].url,/\/api\/v1\/dashboard\/tool-history\/13$/);
  assert.equal(h.fetched[0].opts.credentials,'same-origin');
  assert.equal(h.fetched[0].opts.cache,'no-store');
  assert.equal(h.fetched[0].opts.headers['X-Agent-Token'],undefined);
  assert.equal(h.nodes['tool-call-overlay'].hidden,false);
  assert.equal(h.nodes['tool-call-title'].textContent,'send_message');
  assert.match(h.nodes['tool-call-meta'].textContent,/Reviewer/);
  assert.match(h.nodes['tool-call-status'].textContent,/Успешно/);
  assert.match(h.nodes['tool-call-arguments'].textContent,/<img onerror=alert\(1\)>/);
  assert.match(h.nodes['tool-call-arguments'].textContent,/\[REDACTED\]/);
  assert.equal(h.doc.activeElement,h.nodes['tool-call-close']);
  h.nodes['tool-call-copy'].click();await h.flush();
  assert.equal(h.copied[0],h.nodes['tool-call-arguments'].textContent);
  h.doc.dispatchEvent({type:'keydown',key:'Escape',preventDefault(){}});
  assert.equal(h.nodes['tool-call-overlay'].hidden,true);
  assert.equal(h.doc.activeElement,prior);
});

test('old metadata-only records communicate absent input body',async()=>{
  const h=harness(async()=>({ok:true,json:async()=>({
    id:13,tool_name:'heartbeat',agent_id:null,status:'ok',
    duration_ms:1,created_at:1795022213,arguments:null,
    arguments_truncated:false,
  })}));
  h.open();await h.flush();
  assert.match(h.nodes['tool-call-arguments'].textContent,/не сохранялись/);
  assert.equal(h.nodes['tool-call-copy'].disabled,true);
});

test('missing/deleted calls display useful errors; reload possible',async()=>{
  const h=harness(async()=>({ok:false,status:404,json:async()=>({detail:'not found'})}));
  h.open();await h.flush();
  assert.match(h.nodes['tool-call-arguments'].textContent,/удалена из истории/);
  assert.equal(h.nodes['tool-call-refresh'].disabled,false);
  assert.equal(h.nodes['tool-call-copy'].disabled,true);
  assert.match(h.nodes['tool-call-status'].textContent,/Ошибка/);
});

test('closing dialog ignores stale asynchronous detail',async()=>{
  let resolve;
  const h=harness(()=>new Promise(r=>{resolve=r;}));
  h.open();await h.flush();
  h.nodes['tool-call-close'].click();
  resolve({ok:true,json:async()=>({
    id:13,tool_name:'evil-stale',arguments:{text:'stale'},
  })});
  await h.flush();
  assert.equal(h.nodes['tool-call-overlay'].hidden,true);
  assert.equal(h.nodes['tool-call-arguments'].textContent,'');
});

test('switching call ignores old response and applies the latest',async()=>{
  const pending=new Map();
  const h=harness(url=>new Promise(resolve=>pending.set(url,resolve)));
  h.open(13);await h.flush();
  h.open(14);await h.flush();
  assert.equal(pending.size,2);
  for(const [url,resolve] of pending) if(url.endsWith('14'))resolve({
    ok:true,json:async()=>({
      id:14,tool_name:'new-call',agent_id:'A',status:'ok',
      duration_ms:1,created_at:1,arguments:{text:'new'},arguments_truncated:false
    })
  });
  await h.flush();
  for(const [url,resolve] of pending) if(url.endsWith('13'))resolve({
    ok:true,json:async()=>({
      id:13,tool_name:'old-call',agent_id:'A',status:'ok',
      duration_ms:1,created_at:1,arguments:{text:'old'},arguments_truncated:false
    })
  });
  await h.flush();
  assert.equal(h.nodes['tool-call-title'].textContent,'new-call');
  assert.match(h.nodes['tool-call-arguments'].textContent,/new/);
  assert.doesNotMatch(h.nodes['tool-call-arguments'].textContent,/old/);
});
