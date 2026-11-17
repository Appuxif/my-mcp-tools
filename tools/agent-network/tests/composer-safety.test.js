const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

const code = fs.readFileSync(path.join(__dirname, '..', 'extension', 'content.js'), 'utf8');

function chat({
  attached=false,fileSelected=false,attachAfterInsert=false,text='',
  url='https://chatgpt.com/c/test'
}={}) {
  let listener, clicks=0;
  const tray={childElementCount:attached ? 1 : 0, textContent:''};
  const file={files:fileSelected ? [{name:'private.pdf'}] : []};
  const form={
    querySelector(selector) {
      if (selector === '[data-composer-attachments]') return tray;
      return null;
    },
    querySelectorAll(selector) {
      return selector === 'input[type="file"]' ? [file] : [];
    },
  };
  const input={
    value:undefined, innerText:text, textContent:text,
    closest() { return form; },
    focus() {},
  };
  const send={disabled:false,getAttribute(){return null;},click(){clicks++;}};
  const selection={removeAllRanges(){},addRange(){}};
  const globals={
    location:{href:url,pathname:new URL(url).pathname},
    document:{
      readyState:'complete',
      querySelector(selector) {
        if (selector === '#prompt-textarea') return input;
        if (selector === '#composer-submit-button') return send;
        return null;
      },
      querySelectorAll() {return [];},
      createRange(){return {selectNodeContents(){}};},
      execCommand(){if(attachAfterInsert) tray.childElementCount=1;input.innerText='Wake';return true;},
    },
    chrome:{runtime:{onMessage:{addListener(fn){listener=fn;}}}},
    getSelection(){return selection;},
    HTMLTextAreaElement:class {},
    HTMLInputElement:class {},
    Event:class {},
    InputEvent:class {},
    setTimeout,
    Promise,
  };
  globals.globalThis=globals;
  vm.runInNewContext(code,globals);
  const run=message => new Promise(resolve => listener(message,null,resolve));
  return {
    run,clicks:()=>clicks,
    unrelated(messageType){
      let responded=false;
      const accepted=listener({type:messageType},null,()=>{responded=true;});
      return {accepted,responded};
    }
  };
}

test('wake refuses an attached file even when composer text is empty',async()=>{
  const page=chat({attached:true});
  const s=await page.run({type:'agent:probe'});
  assert.equal(s.state,'draft');
  assert.match(s.reason,/attachments/);
  const result=await page.run({type:'agent:send',text:'Wake',url:'https://chatgpt.com/c/test'});
  assert.equal(result.ok,false);
  assert.equal(page.clicks(),0);
});

test('selected file input blocks wake before upload chip is created',async()=>{
  const page=chat({fileSelected:true});
  assert.equal((await page.run({type:'agent:probe'})).state,'draft');
  assert.equal((await page.run({type:'agent:send',text:'Wake',url:'https://chatgpt.com/c/test'})).ok,false);
  assert.equal(page.clicks(),0);
});

test('a file attached while the wake text is being inserted blocks submit',async()=>{
  const page=chat({attachAfterInsert:true});
  assert.equal((await page.run({type:'agent:probe'})).state,'idle');
  const response=await page.run({type:'agent:send',text:'Wake',url:'https://chatgpt.com/c/test'});
  assert.equal(response.ok,false);
  assert.equal(page.clicks(),0);
});

test('plain idle composer without attachments is still wakeable',async()=>{
  const page=chat();
  assert.equal((await page.run({type:'agent:probe'})).state,'idle');
  const response=await page.run({type:'agent:send',text:'Wake',url:'https://chatgpt.com/c/test'});
  assert.equal(response.ok,true);
  assert.equal(page.clicks(),1);
});

test('ChatGPT composer content script does not steal HUD Start messages',()=>{
  const page=chat();
  const result=page.unrelated('network:hud-show');
  assert.equal(result.accepted,false);
  assert.equal(result.responded,false);
});

test('new blank ChatGPT chat accepts bootstrap ONLY when explicitly allowed',async()=>{
  const url='https://chatgpt.com/';
  const page=chat({url});
  assert.equal((await page.run({type:'agent:probe'})).state,'unknown');
  const blocked=await page.run({type:'agent:send',text:'Bootstrap',url});
  assert.equal(blocked.ok,false);
  assert.equal(page.clicks(),0);
  const allowed=await page.run({type:'agent:send',text:'Bootstrap',url,allowNewChat:true});
  assert.equal(allowed.ok,true,allowed.error);
  assert.equal(page.clicks(),1);
});

test('new project chat accepts bootstrap, but never overwrites an attached file',async()=>{
  const url='https://chatgpt.com/g/g-p-example-edu';
  const safe=chat({url});
  assert.equal((await safe.run({type:'agent:send',text:'Bootstrap',url,allowNewChat:true})).ok,true);
  assert.equal(safe.clicks(),1);
  const attached=chat({url,attached:true});
  assert.equal((await attached.run({type:'agent:send',text:'Bootstrap',url,allowNewChat:true})).ok,false);
  assert.equal(attached.clicks(),0);
});

test('allowNewChat cannot be used to bypass safety on existing conversations',async()=>{
  const url='https://chatgpt.com/c/test';
  const page=chat({url});
  const result=await page.run({type:'agent:send',text:'Bootstrap',url,allowNewChat:true});
  assert.equal(result.ok,false);
  assert.equal(page.clicks(),0);
});

test('ChatGPT project landing path /g/<project-id>/project accepts blank-chat bootstrap',async()=>{
  const url='https://chatgpt.com/g/g-p-example-edu/project';
  const page=chat({url});
  assert.equal((await page.run({type:'agent:probe'})).state,'unknown');
  const initial=await page.run({type:'agent:send',text:'Bootstrap',url});
  assert.equal(initial.ok,false,'ordinary wake must still reject new-chat landing pages');
  const result=await page.run({type:'agent:send',text:'Bootstrap',url,allowNewChat:true});
  assert.equal(result.ok,true,result.error);
  assert.equal(page.clicks(),1);
});

test('project new-chat landing preserves an existing draft and never sends migration bootstrap',async()=>{
  const url='https://chatgpt.com/g/g-p-example-edu/project';
  const page=chat({url,text:'unfinished text'});
  const result=await page.run({type:'agent:send',text:'Bootstrap',url,allowNewChat:true});
  assert.equal(result.ok,false);
  assert.match(result.error,/draft.*composer contains user text/i);
  assert.equal(page.clicks(),0);
});
