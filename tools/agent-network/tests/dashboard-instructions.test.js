const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');

const script=fs.readFileSync(path.join(__dirname,'../dashboard/dashboard-instructions.js'),'utf8');
const html=fs.readFileSync(path.join(__dirname,'../dashboard/index.html'),'utf8');

function harness({fetcher=null}={}) {
  const store=new Map();
  const handlers={};
  const requests=[];
  const pending=[];
  let focus=null;
  let confirmed=true;
  let askCount=0;
  let server='Initial admin instructions\n';
  let revision=0;
  const windowEvents={};
  const copied=[];
  const classes=()=>({add(){},remove(){}});
  const element=id=>{
    if(store.has(id))return store.get(id);
    const el={id,hidden:false,disabled:false,value:'',textContent:'',dataset:{},
      isConnected:true,listeners:{},
      addEventListener(type,callback){(this.listeners[type]??=[]).push(callback);},
      click(){for(const cb of this.listeners.click??[])cb();},
      dispatch(type){for(const cb of this.listeners[type]??[])cb();},
      focus(){focus=this;},querySelectorAll(){return [];}};
    store.set(id,el);return el;
  };
  const document={
    get activeElement(){return focus;},
    getElementById:element,
    body:{classList:classes()},
    addEventListener(type,fn){(handlers[type]??=[]).push(fn);},
    dispatch(type,extra={}){
      for(const fn of handlers[type]??[])fn({key:type==='keydown'?'Escape':undefined,
        preventDefault(){},...extra});
    },
  };
  const fetch=async(url,opts)=>{
    requests.push({url,opts});
    if(fetcher)return fetcher(url,opts,pending);
    if(opts.method==='PUT') {
      const body=JSON.parse(opts.body);
      if(body.expected_revision!==revision)
        return {ok:false,status:409,json:async()=>({detail:'Instructions revision conflict'})};
      server=body.instructions;
      revision++;
    }
    return {ok:true,status:200,json:async()=>({
      agent_id:url.split('/').at(-2),agent_name:'Agent '+url.split('/').at(-2),
      instructions:server,revision,updated_at:1780000000,
      bytes:new TextEncoder().encode(server).length,
    })};
  };
  const context=vm.createContext({document,fetch,URL,TextEncoder,console,
    location:{origin:'http://127.0.0.1:8787'},
    window:{
      confirm(){askCount++;return confirmed;},
      addEventListener(type,fn){(windowEvents[type]??=[]).push(fn);},
    },
    navigator:{clipboard:{async writeText(value){copied.push(value);}}},
  });
  element('instructions-overlay').hidden=true;
  element('open-agent-instructions').dataset.agentId='A';
  vm.runInContext(script,context);
  const flush=async()=>{for(let i=0;i<8;i++)await new Promise(resolve=>setImmediate(resolve));};
  return {element,document,requests,pending,flush,copied,
    beforeUnload(){
      const event={prevented:false,returnValue:undefined,
        preventDefault(){this.prevented=true;}};
      for(const fn of windowEvents.beforeunload??[])fn(event);
      return event;
    },
    set confirmed(value){confirmed=value;},
    get askCount(){return askCount;},get focused(){return focus;},
    setServer(value){server=value;}};
}

test('admin prompt editor mounted and linked from inspector, not compact context',()=>{
  for(const id of ['open-agent-instructions','instructions-overlay','instructions-dialog',
                   'instructions-text','instructions-save','instructions-close',
                   'instructions-refresh','instructions-bytes'])
    assert.match(html,new RegExp('id="'+id+'"'));
  assert.match(html,/dashboard-instructions\.js/);
  assert.match(html,/registry-instructions/);
  assert.match(html,/read_instructions/);
});

test('editor fetches admin-only endpoint, saves exact multiline plain text',async()=>{
  const h=harness();
  h.element('open-agent-instructions').focus();
  h.element('open-agent-instructions').click();await h.flush();
  assert.equal(h.requests.length,1);
  assert.equal(h.requests[0].url,'http://127.0.0.1:8787/api/v1/dashboard/agents/A/instructions');
  assert.equal(h.requests[0].opts.method,'GET');
  assert.equal(h.requests[0].opts.credentials,'same-origin');
  assert.equal(h.requests[0].opts.cache,'no-store');
  assert.equal(h.element('instructions-text').value,'Initial admin instructions\n');
  assert.equal(h.element('instructions-save').disabled,true);
  assert.equal(h.focused,h.element('instructions-close'));
  const prompt='# Prompt\n  <script>alert(1)</script>\n 🔍\n';
  h.element('instructions-text').value=prompt;
  h.element('instructions-text').dispatch('input');
  assert.equal(h.element('instructions-save').disabled,false);
  assert.match(h.element('instructions-status').textContent,/несохранённые/);
  h.element('instructions-save').click();await h.flush();
  const put=h.requests[1];
  assert.equal(put.opts.method,'PUT');
  assert.equal(put.opts.headers['Content-Type'],'application/json');
  assert.equal(put.opts.headers['X-Agent-Token'],undefined);
  assert.equal(JSON.parse(put.opts.body).instructions,prompt);
  assert.equal(JSON.parse(put.opts.body).expected_revision,0);
  assert.equal(h.element('instructions-save').disabled,true);
  assert.match(h.element('instructions-status').textContent,/сохранены/);
  assert.equal(h.element('instructions-text').value,prompt);
  h.element('instructions-close').click();
  assert.equal(h.element('instructions-overlay').hidden,true);
  assert.equal(h.focused,h.element('open-agent-instructions'));
});

test('empty instructions are valid and clearing explicitly saves blank',async()=>{
  const h=harness();h.element('open-agent-instructions').click();await h.flush();
  h.element('instructions-text').value='';h.element('instructions-text').dispatch('input');
  h.element('instructions-save').click();await h.flush();
  assert.equal(JSON.parse(h.requests[1].opts.body).instructions,'');
  assert.equal(h.element('instructions-text').value,'');
  assert.equal(h.element('instructions-save').disabled,true);
});

test('unsaved changes require confirmation before close, switch or reload',async()=>{
  const h=harness();h.element('open-agent-instructions').click();await h.flush();
  h.element('instructions-text').value='Unsaved';h.element('instructions-text').dispatch('input');
  h.confirmed=false;
  h.element('instructions-close').click();
  assert.equal(h.element('instructions-overlay').hidden,false);
  h.element('instructions-refresh').click();await h.flush();
  assert.equal(h.requests.length,1);
  h.element('open-agent-instructions').dataset.agentId='B';
  h.element('open-agent-instructions').click();await h.flush();
  assert.equal(h.requests.length,1);
  h.confirmed=true;
  h.element('open-agent-instructions').click();await h.flush();
  assert.equal(h.requests.length,2);
  assert.match(h.requests[1].url,/agents\/B\/instructions$/);
  assert.equal(h.element('instructions-text').value,'Initial admin instructions\n');
  assert.equal(h.element('instructions-title').textContent,'Agent B');
});

test('stale network response cannot overwrite another selected agent',async()=>{
  const h=harness({fetcher:async(url,opts,pending)=>
    new Promise(resolve=>pending.push({url,resolve}))});
  h.element('open-agent-instructions').click();await h.flush();
  h.element('open-agent-instructions').dataset.agentId='B';
  h.element('open-agent-instructions').click();await h.flush();
  assert.equal(h.pending.length,2);
  const response=(agent_id,instructions)=>({ok:true,json:async()=>({
    agent_id,agent_name:agent_id,instructions,revision:0,
    updated_at:null,bytes:instructions.length})});
  h.pending[1].resolve(response('B','New B prompt'));await h.flush();
  h.pending[0].resolve(response('A','Stale A prompt'));await h.flush();
  assert.equal(h.element('instructions-text').value,'New B prompt');
  assert.equal(h.element('instructions-title').textContent,'B');
});

test('UTF-8 byte limit blocks save, while small Unicode text is allowed',async()=>{
  const h=harness();h.element('open-agent-instructions').click();await h.flush();
  h.element('instructions-text').value='🦄'.repeat(32769);
  h.element('instructions-text').dispatch('input');
  assert.equal(h.element('instructions-save').disabled,true);
  assert.match(h.element('instructions-status').textContent,/лимит/);
  h.element('instructions-save').click();await h.flush();
  assert.equal(h.requests.length,1);
  h.element('instructions-text').value='🦄';h.element('instructions-text').dispatch('input');
  assert.equal(h.element('instructions-save').disabled,false);
});

test('failed initial GET prevents blind overwrite of unknown remote instructions',async()=>{
  const h=harness({fetcher:async()=>({ok:false,status:503,json:async()=>({detail:'Offline'})})});
  h.element('open-agent-instructions').click();await h.flush();
  assert.equal(h.element('instructions-text').disabled,true);
  assert.equal(h.element('instructions-save').disabled,true);
  assert.match(h.element('instructions-status').textContent,/Offline/);
  h.element('instructions-text').value='Blind update';
  h.element('instructions-text').dispatch('input');
  h.element('instructions-save').click();await h.flush();
  assert.equal(h.requests.length,1);
});


test('conflicting remote edit blocks stale save and preserves draft for manual merge',async()=>{
  let rev=7;
  const h=harness({fetcher:async(url,opts)=>opts.method==='GET'
    ? {ok:true,json:async()=>({agent_id:'A',instructions:'base',revision:rev})}
    : {ok:false,status:409,json:async()=>({detail:'Instructions revision conflict'})}});
  h.element('open-agent-instructions').click();await h.flush();
  h.element('instructions-text').value='My unsaved large draft';
  h.element('instructions-text').dispatch('input');
  h.element('instructions-save').click();await h.flush();
  assert.equal(JSON.parse(h.requests[1].opts.body).expected_revision,7);
  assert.equal(h.element('instructions-text').value,'My unsaved large draft');
  assert.equal(h.element('instructions-save').disabled,true);
  assert.match(h.element('instructions-status').textContent,/Конфликт версий/);
  assert.match(h.element('instructions-status').textContent,/Скопируйте черновик/);
  h.element('instructions-text').value+='!';
  h.element('instructions-text').dispatch('input');
  assert.match(h.element('instructions-status').textContent,/Конфликт версий/);
  assert.match(h.element('instructions-status').textContent,/Скопируйте черновик/);
  assert.equal(h.element('instructions-save').disabled,true);
  h.element('instructions-copy').click();await h.flush();
  assert.equal(h.copied.at(-1),'My unsaved large draft!');
  assert.match(h.element('instructions-status').textContent,/Скопируйте черновик/);
  h.element('instructions-save').click();await h.flush();
  assert.equal(h.requests.length,2,'conflicted draft cannot be overwritten by retry');
  h.confirmed=true;
  h.element('instructions-refresh').click();await h.flush();
  assert.equal(h.element('instructions-text').value,'base');
  assert.equal(h.element('instructions-save').disabled,true);
});

test('beforeunload warns only for dirty draft or in-flight save, clears after save',async()=>{
  const h=harness();
  assert.equal(h.beforeUnload().prevented,false);
  h.element('open-agent-instructions').click();await h.flush();
  assert.equal(h.beforeUnload().prevented,false);
  h.element('instructions-text').value='Draft to protect';
  h.element('instructions-text').dispatch('input');
  const blocked=h.beforeUnload();
  assert.equal(blocked.prevented,true);
  assert.equal(blocked.returnValue,'');
  h.element('instructions-save').click();await h.flush();
  assert.equal(h.beforeUnload().prevented,false);
  h.element('instructions-text').value='Unsaved again';
  h.element('instructions-text').dispatch('input');
  assert.equal(h.beforeUnload().prevented,true);
  h.confirmed=true;h.element('instructions-close').click();
  assert.equal(h.beforeUnload().prevented,false);
});

test('server errors preserve drafts and do not allow a fictitious success',async()=>{
  const h=harness({fetcher:async(url,opts)=>opts.method==='GET'
    ? {ok:true,json:async()=>({agent_id:'A',instructions:'original',revision:0})}
    : {ok:false,status:500,json:async()=>({detail:'Rejected'})}});
  h.element('open-agent-instructions').click();await h.flush();
  h.element('instructions-text').value='New draft';h.element('instructions-text').dispatch('input');
  h.element('instructions-save').click();await h.flush();
  assert.equal(h.element('instructions-text').value,'New draft');
  assert.equal(h.element('instructions-save').disabled,false);
  assert.match(h.element('instructions-status').textContent,/Ошибка сохранения/);
});
