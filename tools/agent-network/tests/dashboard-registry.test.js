const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const path=require('node:path');
const script=fs.readFileSync(path.join(__dirname,'../dashboard/dashboard-registry.js'),'utf8');
const html=fs.readFileSync(path.join(__dirname,'../dashboard/index.html'),'utf8');
const SITE='http://127.0.0.1:8787';

function harness({fail=false,deferred=false}={}) {
  const store=new Map(), events={}, req=[], copied=[], downloads=[];
  const classList=()=>{
    const values=new Set();
    return {add:n=>values.add(n),remove:n=>values.delete(n),contains:n=>values.has(n)};
  };
  let focus=null;
  function element(id,tag='div'){
    if(store.has(id))return store.get(id);
    const el={
      id,tagName:tag.toUpperCase(),value:'',textContent:'',hidden:false,disabled:false,
      type:'',dataset:{},children:[],classList:classList(),isConnected:true,
      listeners:{},append(...items){this.children.push(...items);},
      replaceChildren(...items){this.children=[...items];},
      addEventListener(type,handler){(this.listeners[type]??=[]).push(handler);},
      dispatch(type,event={}){for(const fn of this.listeners[type]??[])fn(event);},
      focus(){focus=this;},
      reset(){this.resetCalls=(this.resetCalls||0)+1;},
      click(){this.dispatch('click');},
      closest(){return null;},
      remove(){},
      querySelectorAll(){return [];},
    };
    store.set(id,el);return el;
  }
  let serial=0;
  const document={
    get activeElement(){return focus;},
    getElementById:element,
    createElement:tag=>element('temporary-'+(++serial),tag),
    body:element('body'),
    addEventListener:(type,callback)=>{(events[type]??=[]).push(callback);},
    dispatchEvent:event=>{for(const fn of events[event.type]??[])fn(event);},
  };
  const result={created:true,agent:{
    agent_id:'d5d8d41b-b403-4a40-a036-b168ea6f4c1d',
    name:'Codex-Dev',teams:[{name:'Ops'}],
  },token:'SECRET_TOKEN_12345'};
  const pending=[];
  const fetch=async(url,opts)=>{
    req.push({url,opts});
    if(url.endsWith('/teams')) return {ok:true,json:async()=>({
      items:[{team_id:'default',name:'default'},{team_id:'ops',name:'Ops'}],
    })};
    if(!url.endsWith('/agents') || opts.method!=='POST')throw Error('Unknown URL: '+url);
    if(deferred)return new Promise(resolve=>pending.push(resolve));
    return fail
      ? {ok:false,status:409,json:async()=>({detail:'Agent already exists'})}
      : {ok:true,status:200,json:async()=>result};
  };
  const URLMock=class extends URL {
    static createObjectURL(blob){downloads.push(blob);return 'blob:example';}
    static revokeObjectURL(){}
  };
  const context=vm.createContext({
    document,fetch,URL:URLMock,Blob,location:{origin:SITE},console,
    navigator:{clipboard:{writeText:async value=>{copied.push(value);}}},
    setTimeout:callback=>callback(),CustomEvent:class{
      constructor(type){this.type=type;}
    },
  });
  element('registry-overlay').hidden=true;
  element('registry-result').hidden=true;
  vm.runInContext(script,context);
  const flush=async()=>{for(let i=0;i<10;i++)await new Promise(resolve=>setImmediate(resolve));};
  const fill=()=>{
    element('registry-name').value='Codex-Dev';
    element('registry-role').value='Developer';
    element('registry-purpose').value='Python';
    element('registry-team-name').value='Ops';
    element('registry-team-add').click();
    const first=element('registry-team-chips').children[0];
    first.click(); // remove default; only Ops stays
  };
  const submit=()=>element('registry-form').dispatch('submit',{preventDefault(){}});
  return {element,req,copied,downloads,pending,flush,fill,submit,result,document,
    get focused(){return focus;}};
}

test('admin form and credentials modal are present',()=>{
  for(const id of ['agent-create-open','registry-overlay','registry-form','registry-name',
                   'registry-role','registry-kind','registry-team-chips','registry-result',
                   'registry-token-result','registry-copy-token','registry-download-env'])
    assert.match(html,new RegExp('id="'+id+'"'));
  assert.match(html,/dashboard-registry\.js/);
  assert.match(html,/aria-modal="true"/);
});

test('one-time credential creation is admin-only and respects selected teams',async()=>{
  const h=harness();
  h.element('agent-create-open').focus();
  h.element('agent-create-open').click();
  await h.flush();
  assert.equal(h.element('registry-overlay').hidden,false);
  assert.equal(h.focused,h.element('registry-name'));
  h.fill();
  h.submit();
  await h.flush();
  const post=h.req.find(x=>x.opts.method==='POST');
  assert.ok(post);
  assert.equal(post.url,SITE+'/api/v1/dashboard/agents');
  assert.equal(post.opts.credentials,'same-origin');
  assert.equal(post.opts.cache,'no-store');
  assert.equal(post.opts.headers['X-Agent-Token'],undefined);
  const payload=JSON.parse(post.opts.body);
  assert.equal(payload.name,'Codex-Dev');
  assert.deepEqual(payload.teams,['Ops']);
  assert.equal(h.element('registry-form').hidden,true);
  assert.equal(h.element('registry-result').hidden,false);
  assert.equal(h.element('registry-token-result').value,h.result.token);
  assert.equal(h.element('registry-id-result').value,h.result.agent.agent_id);
  assert.match(h.element('registry-teams-result').textContent,/Ops/);
  h.element('registry-copy-env').click();await h.flush();
  assert.match(h.copied[0],/AGENT_NETWORK_TOKEN=SECRET_TOKEN_12345/);
  assert.match(h.copied[0],/AGENT_NETWORK_AGENT_NAME=Codex-Dev/);
  h.element('registry-close').click();
  assert.equal(h.element('registry-overlay').hidden,true);
  assert.equal(h.element('registry-token-result').value,'');
  assert.equal(h.element('registry-id-result').value,'');
  assert.equal(h.focused,h.element('agent-create-open'));
  h.element('agent-create-open').click();
  assert.equal(h.element('registry-result').hidden,true);
  assert.equal(h.element('registry-token-result').value,'');
});

test('server validation error does not expose credentials',async()=>{
  const h=harness({fail:true});
  h.element('agent-create-open').click();
  h.fill();
  h.submit();await h.flush();
  assert.equal(h.element('registry-result').hidden,true);
  assert.equal(h.element('registry-submit').disabled,false);
  assert.match(h.element('registry-form-status').textContent,/Agent already exists/);
});

test('double submits never create duplicate agents',async()=>{
  const h=harness({deferred:true});
  h.element('agent-create-open').click();h.fill();
  h.submit();h.submit();await h.flush();
  assert.equal(h.pending.length,1);
  assert.equal(h.element('registry-submit').disabled,true);
  h.pending[0]({ok:true,json:async()=>h.result});
  await h.flush();
  assert.equal(h.element('registry-result').hidden,false);
  h.submit();await h.flush();
  assert.equal(h.pending.length,1);
});

test('a registered agent cannot be created without a team',async()=>{
  const h=harness();
  h.element('agent-create-open').click();await h.flush();
  // Only the final team chip is protected from removal.
  assert.equal(h.element('registry-team-chips').children.length,1);
  h.element('registry-team-chips').children[0].click();
  assert.equal(h.element('registry-team-chips').children.length,1);
  assert.match(h.element('registry-form-status').textContent,/хотя бы в одной/);
  h.element('registry-team-name').value='Ops';
  h.element('registry-team-add').click();
  assert.equal(h.element('registry-team-chips').children.length,2);
});
