const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const path=require('node:path');
const Graph=require('../dashboard/graph-utils.js');

const src=fs.readFileSync(path.join(__dirname,'../dashboard/dashboard.js'),'utf8');

function harness({graphNetwork=null,savedTeams=null}={}) {
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
    replaceChildren(...children){
      const contains=(root,node)=>root===node || root.children.some(ch=>contains(ch,node));
      if(document.activeElement && contains(this,document.activeElement))
        document.activeElement=null; // Real browsers blur inputs removed from the DOM.
      this._text='';this.children=[...children];
    }
    focus(){document.activeElement=this;}
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
    activeElement:null,
    getElementById:get,
    createElement:tag=>new El(tag),
    createElementNS:(_ns,tag)=>new El(tag),
    addEventListener(type,fn){(listeners[type]??=[]).push(fn);},
    dispatchEvent(event){for(const fn of listeners[event.type]||[])fn(event);}
  };
  let memberNames=['default'];
  const requests=[];
  const preferences=new Map();
  if(savedTeams!==null) preferences.set('agentNetwork.graph.selectedTeams',JSON.stringify(savedTeams));
  const localStorage={
    getItem(key){return preferences.get(key)??null;},
    setItem(key,value){preferences.set(key,String(value));},
  };
  const snapshot=()=>({
    agents:[{
      agent_id:'A',name:'Worker',kind:'chatgpt',role:'Developer',
      teams:memberNames.map(name=>({team_id:name,name})),
      online:true,task_status:'idle',pending_messages:0,
    }],
    teams:graphNetwork?.teams || [{team_id:'default',name:'default'},{team_id:'dev',name:'Dev'}],
    edges:graphNetwork?.edges || [],channels:[],recent:[],server:{uptime_seconds:10},
    metrics:{agents_total:graphNetwork?.agents.length || 1,agents_working:0,
             agents_online:1,pending_messages:0,messages_24h:0,channels_connected:0},
    ...(graphNetwork ? {agents:graphNetwork.agents} : {}),
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
    console,AgentNetworkGraph:Graph,localStorage,setInterval(){},
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
  return {get,find,flush,document,requests,preferences,
    memberNames:()=>memberNames};
}

test('Dashboard inspector assigns and removes team memberships via Basic-authenticated admin API',async()=>{
  const h=harness();await h.flush();
  let editor=h.get('inspector');
  assert.equal(h.get('open-agent-context').dataset.agentId, 'A');
  assert.equal(h.get('open-agent-context').disabled, false);
  assert.equal(h.get('open-agent-context').hidden, false);
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

test('auto-refresh retains the exact focused input node, text and caret',async()=>{
  const h=harness();await h.flush();
  const input=h.find(h.get('inspector'),'team-editor-input');
  input.focus();
  input.value='Forest';
  for(const fn of input.listeners.input)fn();
  input.selectionStart=3;
  h.document.dispatchEvent({type:'agent-network:refresh'});
  await h.flush();
  assert.equal(h.find(h.get('inspector'),'team-editor-input'),input);
  assert.equal(h.document.activeElement,input);
  assert.equal(input.value,'Forest');
  assert.equal(input.selectionStart,3);
  input.value='Forest Chopper';
  for(const fn of input.listeners.input)fn();
  h.document.dispatchEvent({type:'agent-network:refresh'});
  await h.flush();
  assert.equal(h.find(h.get('inspector'),'team-editor-input'),input);
  assert.equal(h.document.activeElement,input);
  assert.equal(input.value,'Forest Chopper');
  assert.equal(h.find(h.get('inspector'),'team-editor-save').disabled,false);
});

test('adding a team with Enter preserves editor focus across subsequent polls',async()=>{
  const h=harness();await h.flush();
  const input=h.find(h.get('inspector'),'team-editor-input');
  input.focus();
  input.value='My New Team';
  for(const fn of input.listeners.input)fn();
  for(const fn of input.listeners.keydown)fn({key:'Enter',preventDefault(){}});
  assert.equal(h.document.activeElement,input);
  assert.equal(input.value,'');
  assert.equal(h.find(h.get('inspector'),'team-editor-chips').children.length,2);
  h.document.dispatchEvent({type:'agent-network:refresh'});
  await h.flush();
  assert.equal(h.document.activeElement,input);
  assert.equal(h.find(h.get('inspector'),'team-editor-chips').children.length,2);
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


const NETWORK={
  teams:[
    {team_id:'default',name:'default'}, {team_id:'alpha',name:'Forest Chopper'},
    {team_id:'beta',name:'My MCP Tools'}, {team_id:'unused',name:'Empty Team'},
  ],
  agents:[
    {agent_id:'A',name:'Alpha',kind:'chatgpt',role:'Developer',teams:[{team_id:'alpha'}]},
    {agent_id:'B',name:'Beta',kind:'other',role:'Reviewer',teams:[{team_id:'beta'}]},
    {agent_id:'C',name:'Shared',kind:'chatgpt',role:'Tester',teams:[{team_id:'alpha'},{team_id:'beta'}]},
    {agent_id:'D',name:'Default',kind:'other',role:'Worker',teams:[{team_id:'default'}]},
  ],
  edges:[
    {source:'A',target:'C',recent_count:1,pending_count:0,last_message_at:1},
    {source:'B',target:'C',recent_count:1,pending_count:0,last_message_at:1},
    {source:'D',target:'A',recent_count:1,pending_count:0,last_message_at:1},
  ],
};
function mapNodeNames(h) {
  return h.get('graph').children.filter(node=>
    node.attributes?.class?.split(' ').includes('node')
  ).map(node=>node.attributes['aria-label'].split(',')[0]);
}
function chooseTeam(h,name,checked=true) {
  const row=h.get('graph-team-options').children.find(label=>
    label.children[1].textContent===name);
  assert.ok(row,'team option exists: '+name);
  const box=row.children[0];
  box.checked=checked;
  for(const listener of box.listeners.change||[])listener();
  return box;
}

test('map defaults to all agents and filters selected teams as union, not intersection',async()=>{
  const h=harness({graphNetwork:NETWORK});
  await h.flush();
  assert.deepEqual(mapNodeNames(h),['Alpha','Beta','Shared','Default']);
  assert.equal(h.get('graph-team-summary').textContent,'Все команды');
  assert.equal(h.get('graph-summary').textContent,'4 узлов · 3 связей');
  assert.equal(h.get('agents-count').textContent,'4');
  chooseTeam(h,'Forest Chopper');
  assert.deepEqual(mapNodeNames(h),['Alpha','Shared']);
  assert.equal(h.get('graph-summary').textContent,'2 узлов · 1 связей');
  assert.equal(h.get('graph-team-summary').textContent,'Forest Chopper');
  chooseTeam(h,'My MCP Tools');
  assert.deepEqual(mapNodeNames(h),['Alpha','Beta','Shared']);
  assert.equal(h.get('graph-summary').textContent,'3 узлов · 2 связей');
  assert.equal(h.get('graph-team-summary').textContent,'Выбрано команд: 2');
  assert.equal(h.get('agents-count').textContent,'4','table is not filtered');
  assert.equal(h.get('metric-agents').textContent,'4','server metrics are not filtered');
  chooseTeam(h,'Forest Chopper',false);
  assert.deepEqual(mapNodeNames(h),['Beta','Shared']);
  h.get('graph-teams-all').click();
  assert.deepEqual(mapNodeNames(h),['Alpha','Beta','Shared','Default']);
  assert.equal(h.get('graph-team-summary').textContent,'Все команды');
});

test('map shows distinct empty-filter message and preserves selection on refresh',async()=>{
  const h=harness({graphNetwork:NETWORK});
  await h.flush();
  chooseTeam(h,'Empty Team');
  assert.deepEqual(mapNodeNames(h),[]);
  assert.equal(h.get('graph-empty').hidden,false);
  assert.match(h.get('graph-empty-title').textContent,/Нет агентов/);
  assert.equal(h.get('graph-filter-hint').textContent,'0 из 4 агентов');
  assert.equal(h.get('agents-count').textContent,'4');
  const option=h.get('graph-team-options').children.at(-1);
  h.get('graph-team-select').open=true;
  h.document.dispatchEvent({type:'agent-network:refresh'});
  await h.flush();
  assert.equal(h.get('graph-team-options').children.at(-1),option,
    'do not rebuild open menu on polling');
  assert.equal(h.get('graph-team-select').open,true);
  assert.equal(option.children[0].checked,true);
  assert.deepEqual(JSON.parse(h.preferences.get('agentNetwork.graph.selectedTeams')),['unused']);
});

test('map restores saved filter across page reload, drops missing team IDs',async()=>{
  const h=harness({graphNetwork:NETWORK,savedTeams:['alpha','deleted-team']});
  await h.flush();
  assert.deepEqual(mapNodeNames(h),['Alpha','Shared']);
  assert.deepEqual(JSON.parse(h.preferences.get('agentNetwork.graph.selectedTeams')),['alpha']);
  h.get('graph-teams-all').click();
  assert.deepEqual(JSON.parse(h.preferences.get('agentNetwork.graph.selectedTeams')),[]);
  assert.deepEqual(mapNodeNames(h),['Alpha','Beta','Shared','Default']);
});
