const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const path=require('node:path');

const code=fs.readFileSync(path.join(__dirname,'../extension/popup.js'),'utf8');
const SOURCE='https://chatgpt.com/c/old-chat';
const DEST='https://chatgpt.com/';
const EXISTING={
  name:'Existing-Worker',role:'Developer',purpose:'Build apps',description:'3D + Python',
  agentId:'agent-uuid',chatUrl:SOURCE,active:true,
};
function createPopup({migrateFails=false,registered=false}={}) {
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
  let current=registered?{
    name:'Existing-Worker',role:'Developer',purpose:'Build apps',description:'3D + Python',
    active:true,agentId:'agent-uuid',bootstrapDone:true,
  }:null;
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
          return {ok:true,items:current?[]:[EXISTING]};
        case 'network:migration-preview':
          return {ok:true,migrate:true,agentId:'agent-uuid',name:'Existing-Worker',
            fromChatUrl:SOURCE,toChatUrl:DEST,needsNewChat:true};
        case 'network:migrate':
          if(migrateFails)return {ok:false,error:'Failed validation'};
          current={...EXISTING,active:true,bootstrapDone:true};
          return {ok:true,migrated:true,name:'Existing-Worker',agentId:'agent-uuid'};
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
    createElement:()=>({value:'',label:''}),
    addEventListener(name,callback){
      if(name==='DOMContentLoaded')onDOMContentLoaded=callback;
    },
  };
  vm.runInNewContext(code,{document,chrome,URL,console});
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
    el,click,setName,messages,
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
