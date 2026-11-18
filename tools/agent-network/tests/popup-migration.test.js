const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const path=require('node:path');

const code=fs.readFileSync(path.join(__dirname,'../extension/popup.js'),'utf8');
const html=fs.readFileSync(path.join(__dirname,'../extension/popup.html'),'utf8');
const SOURCE='https://chatgpt.com/c/old-chat';
const DEST='https://chatgpt.com/';
const EXISTING={
  name:'Existing-Worker',role:'Developer',purpose:'Build apps',description:'3D + Python',
  agentId:'agent-uuid',chatUrl:SOURCE,active:true,
};
function createPopup({migrateFails=false,registered=false,agents=[EXISTING],deletedBound=false}={}) {
  const elements=new Map();
  const el=id=>{
    if(!elements.has(id)){
      const element={
        id,value:'',textContent:'',disabled:false,hidden:id==='migration-confirm',
        listeners:{},children:[],label:'',
        addEventListener(name,callback){this.listeners[name]=callback;},
        replaceChildren(){this.children=[];},
        append(...nodes){this.children.push(...nodes);},
      };
      elements.set(id,element);
    }
    return elements.get(id);
  };
  let onDOMContentLoaded;
  const messages=[];
  const copied=[];
  let current=registered?{
    name:'Existing-Worker',role:'Developer',purpose:'Build apps',description:'3D + Python',
    active:true,agentId:'agent-uuid',bootstrapDone:true,
  }:null;
  let adminConfigured=false;
  let currentTeams=[{team_id:'default',name:'default'}];
  const secret='TEST_ADMIN_SECRET_'.repeat(4);
  const chrome={
    tabs:{async query(){return [{id:5,url:DEST}];}},
    runtime:{async sendMessage(msg){
      messages.push(msg);
      switch(msg.type){
        case 'network:status':return {
          ok:true,server:'http://127.0.0.1:8787',
          entry:current,connected:!!current,ui:{state:'idle',network:'idle'},
        };
        case 'network:available-agents':
          if(deletedBound && current) {current=null;return {ok:true,items:[],removedCurrent:true};}
          return {ok:true,items:current?[]:agents};
        case 'network:admin-status':
          return {ok:true,configured:adminConfigured,
                  teams:[{name:'default'},{name:'Dev'},{name:'QA'}],
                  agentTeams:current?currentTeams:[]};
        case 'network:admin-connect':
          if(msg.adminToken!==secret) return {ok:false,error:'Invalid admin token'};
          adminConfigured=true;
          return {ok:true,configured:true,teams:[{name:'default'}]};
        case 'network:admin-clear':
          adminConfigured=false;
          return {ok:true,configured:false};
        case 'network:admin-set-teams':
          if(!adminConfigured || !current) return {ok:false,error:'Denied'};
          currentTeams=msg.teams.map(name=>({team_id:name,name}));
          return {ok:true,agent:{agent_id:current.agentId,teams:currentTeams}};
        case 'network:migration-preview': {
          const agent=agents.find(a=>a.agentId===msg.agentId);
          if(!agent) return {ok:false,error:'Agent not found'};
          return {ok:true,migrate:true,agentId:agent.agentId,name:agent.name,
            fromChatUrl:agent.chatUrl,toChatUrl:DEST,needsNewChat:true};
        }
        case 'network:migrate':
          if(migrateFails)return {ok:false,error:'Failed validation'};
          current={...EXISTING,active:true,bootstrapDone:true};
          return {ok:true,migrated:true,name:'Existing-Worker',agentId:'agent-uuid'};
        case 'network:repeat-bootstrap':
          return {ok:true,sent:true,agentId:current?.agentId};
        case 'network:update-token':
          return {ok:true,updated:true,agentId:current?.agentId};
        case 'network:start':
          current={...msg.profile,active:true,bootstrapDone:true};
          return {ok:true,created:true};
        default:return {ok:false,error:'Unexpected '+msg.type};
      }
    }},
    permissions:{async contains(){return true;},async request(){return true;}},
  };
  const document={
    getElementById:el,
    createElement:()=>({
      value:'',label:'',textContent:'',disabled:false,listeners:{},
      addEventListener(name,callback){this.listeners[name]=callback;},
    }),
    addEventListener(name,callback){
      if(name==='DOMContentLoaded')onDOMContentLoaded=callback;
    },
  };
  vm.runInNewContext(code,{document,chrome,URL,console,
    navigator:{clipboard:{async writeText(value){copied.push(value);}}},
  });
  const click=async id=>{
    const callback=el(id).listeners.click;
    assert.equal(typeof callback,'function','no click listener on '+id);
    await callback();
  };
  const setName=value=>{
    el('name').value=value;
    el('name').listeners.input();
  };
  return {
    el,click,setName,messages,copied,
    async ready(){assert.ok(onDOMContentLoaded);await onDOMContentLoaded();}
  };
}

test('selecting existing local agent fills original profile, Start requires confirmation',async()=>{
  const ui=createPopup();
  await ui.ready();
  assert.equal(ui.el('known-agents').children[0].value,'Existing-Worker');
  assert.equal(ui.el('migration-confirm').hidden,true);
  ui.setName('Existing-Worker');
  assert.equal(ui.el('role').value,'Developer');
  assert.equal(ui.el('purpose').value,'Build apps');
  assert.equal(ui.el('description').value,'3D + Python');
  assert.equal(ui.el('role').disabled,true);
  await ui.click('start');
  assert.equal(ui.el('migration-confirm').hidden,false);
  assert.match(ui.el('migration-description').textContent,/Existing-Worker/);
  assert.match(ui.el('migration-description').textContent,/old-chat/);
  assert.equal(ui.messages.some(m=>m.type==='network:migrate'),false);
  assert.equal(ui.messages.some(m=>m.type==='network:start'),false);
});

test('Confirm transfers selected existing agent without creating a new one',async()=>{
  const ui=createPopup();await ui.ready();
  ui.setName('Existing-Worker');
  await ui.click('start');
  await ui.click('confirm-migration');
  const call=ui.messages.find(m=>m.type==='network:migrate');
  assert.equal(call.agentId,'agent-uuid');
  assert.equal(call.fromChatUrl,SOURCE);
  assert.equal(call.expectedDestination,DEST);
  assert.equal(ui.messages.some(m=>m.type==='network:start'),false);
  assert.equal(ui.el('migration-confirm').hidden,true);
  assert.equal(ui.el('name').disabled,true);
  assert.equal(ui.el('role').disabled,false);
  assert.match(ui.el('status').textContent,/перенесён/);
});

test('duplicate local names have distinct datalist values and migrate by agent ID',async()=>{
  const stale={...EXISTING,agentId:'deleted-uuid',role:'Obsolete',
               chatUrl:'https://chatgpt.com/c/deleted'};
  const ui=createPopup({agents:[stale,EXISTING]});
  await ui.ready();
  const options=ui.el('known-agents').children.map(o=>o.value);
  assert.equal(new Set(options).size,2);
  assert.ok(options[1].includes('agent-uuid'));
  ui.setName(options[1]);
  assert.equal(ui.el('role').value,'Developer');
  await ui.click('start');
  const preview=ui.messages.find(m=>m.type==='network:migration-preview');
  assert.equal(preview.agentId,'agent-uuid');
  assert.equal(preview.name,'Existing-Worker');
  assert.equal(ui.el('migration-confirm').hidden,false);
});

test('long duplicate agent name fits the input, but long NEW agent name is rejected',async()=>{
  const name='R'.repeat(64);
  const one={...EXISTING,name,agentId:'12345678-1234-1234-1234-123456789abc'};
  const two={...EXISTING,name,agentId:'87654321-4321-4321-4321-cba987654321'};
  const ui=createPopup({agents:[one,two]});
  await ui.ready();
  const values=ui.el('known-agents').children.map(option=>option.value);
  const maxlength=Number(html.match(/id="name" maxlength="(\d+)"/)[1]);
  assert.equal(values[0].length,103);
  assert.ok(values.every(value=>value.length<=maxlength));
  ui.setName(values[1]);
  await ui.click('start');
  const call=ui.messages.find(m=>m.type==='network:migration-preview');
  assert.equal(call.agentId,two.agentId);
  assert.equal(ui.el('migration-confirm').hidden,false);
  ui.setName('Y'.repeat(65));
  ui.el('role').value='Worker';
  await ui.click('start');
  assert.match(ui.el('status').textContent,/64 символа/);
  assert.equal(ui.messages.some(m=>m.type==='network:start'),false);
});

test('surrogate-pair Unicode agent names remain selectable within input maxlength',async()=>{
  const name='𐐀'.repeat(64); // Deseret letter: 64 Python code points, 128 JS code units.
  const first={...EXISTING,name,agentId:'12345678-1234-1234-1234-123456789abc'};
  const second={...EXISTING,name,agentId:'87654321-4321-4321-4321-cba987654321'};
  const ui=createPopup({agents:[first,second]});
  await ui.ready();
  const options=ui.el('known-agents').children.map(o=>o.value);
  const maxlength=Number(html.match(/id="name" maxlength="(\d+)"/)[1]);
  assert.equal(options[0].length,167);
  assert.ok(options.every(value=>value.length<=maxlength));
  ui.setName(options[1]);
  await ui.click('start');
  assert.equal(ui.messages.find(m=>m.type==='network:migration-preview').agentId,second.agentId);
});

test('Cancel leaves existing agent untouched and hides confirmation',async()=>{
  const ui=createPopup();await ui.ready();
  ui.setName('Existing-Worker');
  await ui.click('start');
  await ui.click('cancel-migration');
  assert.equal(ui.el('migration-confirm').hidden,true);
  assert.equal(ui.messages.some(m=>m.type==='network:migrate'),false);
  assert.match(ui.el('status').textContent,/отменён/);
});

test('Failed migration leaves confirmation visible for retry',async()=>{
  const ui=createPopup({migrateFails:true});await ui.ready();
  ui.setName('Existing-Worker');
  await ui.click('start');
  await ui.click('confirm-migration');
  assert.equal(ui.el('migration-confirm').hidden,false);
  assert.match(ui.el('status').textContent,/Failed validation/);
  assert.equal(ui.el('start').disabled,false);
  assert.equal(ui.el('confirm-migration').disabled,false);
});

test('unknown name still uses normal new agent registration',async()=>{
  const ui=createPopup();await ui.ready();
  ui.setName('Fresh-Agent');
  ui.el('role').value='Tester';
  assert.equal(ui.el('role').disabled,false);
  await ui.click('start');
  assert.equal(ui.messages.filter(m=>m.type==='network:start').length,1);
  assert.equal(ui.messages.filter(m=>m.type==='network:migrate').length,0);
});


test('popup administrator can join multiple teams and remove memberships',async()=>{
  const ui=createPopup({registered:true});await ui.ready();
  assert.equal(ui.el('team-name').disabled,true);
  ui.el('admin-token').value='TEST_ADMIN_SECRET_'.repeat(4);
  await ui.click('admin-connect');
  assert.equal(ui.el('admin-token').value,'','secret must be cleared from the DOM');
  assert.equal(ui.el('team-name').disabled,false);
  assert.equal(ui.el('known-teams').children.length,3);
  assert.equal(ui.el('team-members').children.length,1);
  ui.el('team-name').value='Dev';
  await ui.click('team-add');
  ui.el('team-name').value='QA';
  await ui.click('team-add');
  assert.equal(ui.el('team-members').children.length,3);
  ui.el('team-members').children[0].listeners.click();
  assert.equal(ui.el('team-members').children.length,2);
  await ui.click('team-save');
  const saved=ui.messages.find(m=>m.type==='network:admin-set-teams');
  assert.deepEqual(Array.from(saved.teams),['Dev','QA']);
  assert.equal(ui.el('admin-info').textContent,'Команды агента сохранены.');
  await ui.click('admin-clear');
  assert.equal(ui.el('team-name').disabled,true);
  assert.equal(ui.el('team-save').disabled,true);
});

test('admin token is not part of agent profile or migration message',async()=>{
  const ui=createPopup();await ui.ready();
  ui.el('admin-token').value='TEST_ADMIN_SECRET_'.repeat(4);
  await ui.click('admin-connect');
  ui.el('name').value='New-Worker';
  ui.el('role').value='Worker';
  await ui.click('start');
  const registration=ui.messages.find(m=>m.type==='network:start');
  assert.ok(registration);
  assert.equal(JSON.stringify(registration).includes('TEST_ADMIN_SECRET_'),false);
  assert.equal('teams' in registration.profile,false);
  assert.equal(ui.messages.some(m=>m.type==='network:admin-set-teams'),false,
    'only explicit administrator Save can assign teams');
});

test('popup displays agent_id and offers safe reminder and rotated-token import',async()=>{
  const ui=createPopup({registered:true});
  await ui.ready();
  assert.equal(ui.el('agent-id-row').hidden,false);
  assert.equal(ui.el('agent-id').value,'agent-uuid');
  assert.equal(ui.el('repeat-bootstrap').disabled,false);
  await ui.click('copy-agent-id');
  assert.deepEqual(ui.copied,['agent-uuid']);
  await ui.click('repeat-bootstrap');
  assert.equal(ui.messages.filter(m=>m.type==='network:repeat-bootstrap').length,1);
  assert.match(ui.el('status').textContent,/повторно отправлено/);
  ui.el('agent-token-new').value='UPDATED_PRIVATE_TOKEN';
  await ui.click('agent-token-apply');
  assert.equal(ui.messages.some(m=>m.type==='network:update-token' &&
    m.token==='UPDATED_PRIVATE_TOKEN'),true);
  assert.equal(ui.el('agent-token-new').value,'');
  assert.match(ui.el('status').textContent,/обновлён/);
});

test('popup resets binding after authoritative cleanup deletes current agent',async()=>{
  const ui=createPopup({registered:true,deletedBound:true});
  await ui.ready();
  assert.equal(ui.el('name').disabled,false);
  assert.equal(ui.el('agent-id-row').hidden,true);
  assert.equal(ui.el('show-hud').disabled,true);
});

test('unbound popup hides agent ID and disables reminder',async()=>{
  const ui=createPopup();await ui.ready();
  assert.equal(ui.el('agent-id-row').hidden,true);
  assert.equal(ui.el('agent-token-row').hidden,true);
  assert.equal(ui.el('repeat-bootstrap').disabled,true);
});
