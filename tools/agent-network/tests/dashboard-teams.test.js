const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const path=require('node:path');
const Graph=require('../dashboard/graph-utils.js');

const src=fs.readFileSync(path.join(__dirname,'../dashboard/dashboard.js'),'utf8');

function harness() {
  class El {
    constructor(tag='div') {
      this.tagName=tag.toUpperCase();this.id='';this.className='';
      this.children=[];this.listeners={};this.dataset={};this.style={};
      this.hidden=false;this.disabled=false;this.attributes={};this.value='';
      this._text='';
      this.classList={add(){},remove(){},contains(){return false;}};
    }
    set textContent(text){this._text=String(text);this.children=[];}
    get textContent(){return this._text+this.children.map(c=>c.textContent).join('');}
    append(...children){this.children.push(...children);}
    replaceChildren(...children){this._text='';this.children=[...children];}
    addEventListener(kind,callback){(this.listeners[kind]??=[]).push(callback);}
    setAttribute(name,value){this.attributes[name]=String(value);}
    insertBefore(element,before){
      const idx=this.children.indexOf(before);
      this.children.splice(idx<0?0:idx,0,element);
    }
    getComputedTextLength(){return this.textContent.length*7;}
    click(){for(const listener of this.listeners.click||[]) listener();}
  }
  const ids=new Map();
  const listeners={};
  const events=[];
  const get=id=>{if(!ids.has(id))ids.set(id,new El());return ids.get(id);};
  const document={
    getElementById:get,
    createElement:tag=>new El(tag),
    createElementNS:(_ns,tag)=>new El(tag),
    addEventListener(type,fn){(listeners[type]??=[]).push(fn);},
    dispatchEvent(event){for(const fn of listeners[event.type]||[])fn(event);}
  };
  let memberNames=['default'];
  const requests=[];
  const snapshot=()=>({
    agents:[{
      agent_id:'A',name:'Worker',kind:'chatgpt',role:'Developer',
      teams:memberNames.map(name=>({team_id:name,name})),
      online:true,task_status:'idle',pending_messages:0,
    }],
    teams:[{team_id:'default',name:'default'},{team_id:'dev',name:'Dev'}],
    edges:[],channels:[],recent:[],server:{uptime_seconds:10},
    metrics:{agents_total:1,agents_working:0,agents_online:1,
             pending_messages:0,messages_24h:0,channels_connected:0},
  });
  const fetch=async(url,options={})=>{
    requests.push({url:String(url),options});
    const method=options.method||'GET';
    if(method==='PUT'){
      assert.equal(options.credentials,'same-origin');
      const input=JSON.parse(options.body);
      memberNames=input.teams;
      return {ok:true,status:200,async json(){return {agent_id:'A',teams:memberNames};}};
    }
    return {ok:true,status:200,async json(){return snapshot();}};
  };
  const ctx=vm.createContext({
    document,fetch,URL,location:{origin:'http://127.0.0.1:8787'},
    console,AgentNetworkGraph:Graph,setInterval(){},
    CustomEvent:class {constructor(type,options){this.type=type;this.detail=options?.detail;}},
  });
  vm.runInContext(src,ctx);
  const find=(el,css)=>{
    if(el.className===css)return el;
    for(const child of el.children){
      const result=find(child,css);
      if(result)return result;
    }
    return null;
  };
  const flush=async()=>{for(let i=0;i<10;i++)await new Promise(r=>setImmediate(r));};
  return {get,find,flush,document,requests,memberNames:()=>memberNames};
}

test('Dashboard inspector assigns and removes team memberships via Basic-authenticated admin API',async()=>{
  const h=harness();await h.flush();
  let editor=h.get('inspector');
  assert.match(editor.textContent,/КОМАНДЫ АГЕНТА/);
  assert.match(editor.textContent,/default/);
  const addInput=h.find(editor,'team-editor-input');
  assert.ok(addInput);
  addInput.value='Dev';
  for(const fn of addInput.listeners.input)fn();
  h.find(editor,'team-editor-button').click();
  editor=h.get('inspector');
  assert.equal(h.find(editor,'team-editor-chips').children.length,2);
  h.find(editor,'team-editor-chips').children[0].click(); // remove default
  editor=h.get('inspector');
  h.find(editor,'team-editor-save').click();
  await h.flush();
  assert.deepEqual(h.memberNames(),['Dev']);
  const put=h.requests.find(r=>r.options.method==='PUT');
  assert.ok(put.url.endsWith('/api/v1/dashboard/agents/A/teams'));
  assert.deepEqual(JSON.parse(put.options.body),{teams:['Dev']});
  assert.equal(put.options.headers['X-Agent-Network-Admin-Token'],undefined);
});

test('Dashboard unsaved team input survives automatic data refresh',async()=>{
  const h=harness();await h.flush();
  const input=h.find(h.get('inspector'),'team-editor-input');
  input.value='New Team';
  for(const fn of input.listeners.input)fn();
  h.document.dispatchEvent({type:'agent-network:refresh'});
  await h.flush();
  assert.equal(h.find(h.get('inspector'),'team-editor-input').value,'New Team');
});
