const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const path=require('node:path');

const src=fs.readFileSync(path.join(__dirname,'../dashboard/dashboard-notes.js'),'utf8');
const html=fs.readFileSync(path.join(__dirname,'../dashboard/index.html'),'utf8');

class Element {
  constructor(tag='div',id='') {
    this.tagName=tag.toUpperCase();this.id=id;this.listeners={};this.children=[];
    this._text='';this.dataset={};this.disabled=false;this.hidden=false;
    this.isConnected=true;this.title='';this.className='';this.scrollTop=0;
  }
  set textContent(s){this._text=String(s);this.children=[];}
  get textContent(){return this._text+this.children.map(x=>x.textContent).join('');}
  append(...xs){for(const x of xs)this.children.push(x);}
  replaceChildren(...xs){this._text='';this.children=[...xs];}
  addEventListener(name,handler){(this.listeners[name]??=[]).push(handler);}
  dispatch(name,event={}){
    for(const handler of this.listeners[name]??[])handler({
      stopPropagation(){},preventDefault(){},...event
    });
  }
  focus(){this.document.activeElement=this;}
  querySelectorAll(){return [this.document.getElementById('notes-close'),
    this.document.getElementById('notes-detail-refresh')].filter(x=>!x.disabled);}
}

const first={
  note_id:'note-A',title:'<svg onload=alert(1)>',agent_id:'agent-123',
  created_at:1795022213.5,status:'draft',agent_name:'Reviewer',
  finalized_at:null,subnote_count:1
};
const second={
  note_id:'note-B',title:'Approved report',agent_id:'agent-456',
  created_at:1795022212,status:'finalized',agent_name:'Developer',
  finalized_at:1795022282,subnote_count:0
};
function harness(handler) {
  const nodes={};
  const events={};
  const calls=[];
  const document={
    activeElement:null,
    body:{classList:{add(){},remove(){}}},
    getElementById(id){return nodes[id];},
    createElement(tag){
      const el=new Element(tag);
      el.document=document;
      return el;
    },
    addEventListener(name,fn){(events[name]??=[]).push(fn);},
    dispatch(name,event={}){
      for(const fn of events[name]??[])fn({type:name,preventDefault(){},...event});
    }
  };
  for(const id of [
    'notes-count','notes-body','notes-refresh','notes-prev','notes-next',
    'notes-page','notes-total','notes-overlay','notes-dialog','notes-close',
    'notes-backdrop','notes-detail-refresh','notes-detail-status',
    'notes-detail-scroll','note-title','note-meta','note-description',
    'note-subnotes-count','note-subnotes'
  ]){
    nodes[id]=new Element('div',id);
    nodes[id].document=document;
  }
  nodes['notes-overlay'].hidden=true;
  document.activeElement=nodes['notes-refresh'];
  const fetch=async(url,options)=>{
    calls.push({url,options});
    assert.equal(options.method,'GET');
    assert.equal(options.credentials,'same-origin');
    assert.equal(options.cache,'no-store');
    assert.equal(options.headers['X-Agent-Token'],undefined);
    assert.equal(options.headers['X-Admin-Token'],undefined);
    const parsed=new URL(url);
    if(handler)return handler(parsed);
    if(parsed.pathname.endsWith('/notes')) {
      const page=+(parsed.searchParams.get('page')||'1');
      return {ok:true,json:async()=>({
        items:page===1?[first,second]:[first],
        total:21,page,page_size:20
      })};
    }
    if(parsed.pathname.endsWith('/note-A')) {
      return {ok:true,json:async()=>({
        ...first,description:'<script>alert(1)</script>\nMultiline',
        expires_at:1795195013.5,subnotes:[
          {subnote_id:'sub1',title:'<img onerror=alert(1)>',
           description:'Python <br> must be treated as text'}
        ]
      })};
    }
    return {ok:false,status:404,json:async()=>({detail:'Not found'})};
  };
  const context=vm.createContext({
    document,fetch,location:{origin:'http://127.0.0.1:8787'},
    URL,Date,console
  });
  vm.runInContext(src,context);
  const flush=async()=>{for(let i=0;i<6;i++)await new Promise(setImmediate);};
  return {nodes,document,calls,flush};
}

test('Notes table, detail modal, and separate script are present',()=>{
  for(const id of ['notes-body','notes-overlay','notes-dialog',
                   'note-description','note-subnotes','notes-prev','notes-next']) {
    assert.match(html,new RegExp('id="'+id+'"'));
  }
  assert.match(html,/dashboard-notes\.js/);
  assert.match(html,/aria-modal="true"/);
  assert.match(html,/<th>TITLE<\/th><th>STATUS<\/th><th>AGENT_ID<\/th><th>CREATED_AT<\/th>/);
});

test('loads list metadata, opens a note with safe text, and restores focus',async()=>{
  const h=harness();
  await h.flush();
  assert.equal(h.calls.length,1);
  assert.match(h.calls[0].url,/\/api\/v1\/dashboard\/notes\?page=1$/);
  assert.equal(h.nodes['notes-count'].textContent,'21');
  assert.equal(h.nodes['notes-body'].children.length,2);
  const firstRow=h.nodes['notes-body'].children[0];
  assert.equal(firstRow.children.length,4);
  assert.equal(firstRow.children[0].children.length,1); // Title without a status badge.
  assert.equal(firstRow.children[0].children[0].textContent,first.title);
  assert.equal(firstRow.children[1].textContent,'Draft');
  assert.equal(firstRow.children[1].className,'notes-status-cell draft');
  assert.equal(firstRow.children[2].textContent,first.agent_id);
  assert.equal(h.nodes['notes-body'].children[1].children[1].textContent,'Finalized');
  const opener=firstRow.children[0].children[0];
  opener.focus();
  opener.dispatch('click');await h.flush();
  assert.match(h.calls[1].url,/\/api\/v1\/dashboard\/notes\/note-A$/);
  assert.equal(h.nodes['notes-overlay'].hidden,false);
  assert.equal(h.nodes['note-title'].textContent,first.title);
  assert.equal(h.nodes['note-description'].textContent,
               '<script>alert(1)</script>\nMultiline');
  assert.equal(h.nodes['note-subnotes-count'].textContent,'1');
  assert.equal(h.nodes['note-subnotes'].children.length,1);
  const child=h.nodes['note-subnotes'].children[0];
  assert.equal(child.children[1].children[0].textContent,'<img onerror=alert(1)>');
  assert.equal(child.children[1].children[1].textContent,
               'Python <br> must be treated as text');
  assert.equal(h.document.activeElement,h.nodes['notes-close']);
  h.document.dispatch('keydown',{key:'Escape'});
  assert.equal(h.nodes['notes-overlay'].hidden,true);
  assert.equal(h.document.activeElement,opener);
});

test('pagination, empty states and status reflect the requested page',async()=>{
  const h=harness();
  await h.flush();
  assert.equal(h.nodes['notes-page'].textContent,'1 / 2');
  assert.equal(h.nodes['notes-prev'].disabled,true);
  assert.equal(h.nodes['notes-next'].disabled,false);
  h.nodes['notes-next'].dispatch('click');await h.flush();
  assert.equal(h.nodes['notes-page'].textContent,'2 / 2');
  assert.equal(h.nodes['notes-prev'].disabled,false);
  assert.equal(h.nodes['notes-next'].disabled,true);
  assert.equal(h.nodes['notes-body'].children.length,1);
  h.nodes['notes-prev'].dispatch('click');await h.flush();
  assert.equal(h.nodes['notes-page'].textContent,'1 / 2');
  assert.equal(h.calls.length,3);
});

test('expired note displays a clear error and does not show stale detail',async()=>{
  const h=harness();
  await h.flush();
  const other=h.nodes['notes-body'].children[1];
  other.dispatch('click');await h.flush();
  assert.match(h.nodes['note-description'].textContent,/срок её хранения истёк/);
  assert.equal(h.nodes['note-subnotes'].children.length,0);
  assert.equal(h.nodes['notes-detail-refresh'].disabled,false);
});

test('missing Basic login/error is reflected in table without retry storm',async()=>{
  const h=harness(async()=>({
    ok:false,status:401,json:async()=>({detail:'Do not show secret'})
  }));
  await h.flush();
  assert.match(h.nodes['notes-body'].textContent,/Нужна авторизация администратора/);
  assert.equal(h.nodes['notes-refresh'].disabled,false);
  assert.equal(h.calls.length,1);
});

test('closing a note invalidates an outstanding detail response',async()=>{
  let resolveDetail;
  const h=harness(async url=>{
    if(url.pathname.endsWith('/notes')) {
      return {ok:true,json:async()=>({items:[first],total:1,page:1,page_size:20})};
    }
    return new Promise(resolve=>{resolveDetail=resolve;});
  });
  await h.flush();
  h.nodes['notes-body'].children[0].dispatch('click');
  await h.flush();
  h.nodes['notes-close'].dispatch('click');
  resolveDetail({ok:true,json:async()=>({...first,description:'stale',
    subnotes:[]})});
  await h.flush();
  assert.equal(h.nodes['notes-overlay'].hidden,true);
  assert.notEqual(h.nodes['note-description'].textContent,'stale');
});
