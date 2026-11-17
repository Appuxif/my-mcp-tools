const {test}=require('node:test');
const assert=require('node:assert/strict');
const vm=require('node:vm');
const fs=require('node:fs');
const path=require('node:path');
const script=fs.readFileSync(path.join(__dirname,'../dashboard/dashboard-markdown.js'),'utf8');

function harness() {
  class Node {
    constructor(tag,ownText='') {
      this.tagName=tag;this.children=[];this._text=ownText;this.href='';
      this.className='';this.dataset={};
    }
    append(...children){this.children.push(...children);}
    replaceChildren(...children){this._text='';this.children=[...children];}
    set textContent(value){this._text=String(value);this.children=[];}
    get textContent(){return this._text+this.children.map(node=>node.textContent).join('');}
  }
  const document={
    createElement:tag=>new Node(tag),
    createTextNode:value=>new Node('#text',value),
  };
  const window={};
  vm.runInNewContext(script,{document,window});
  const root=new Node('main');
  return {root,render:text=>window.AgentNetworkMarkdown.render(root,text)};
}
function descend(root,tag) {
  return [root,...root.children.flatMap(node=>descend(node,tag))]
    .filter(node=>node.tagName===tag);
}

test('Markdown renderer makes headings, inline formatting, links and blocks',()=>{
  const h=harness();
  h.render('# Heading\n\nParagraph **bold**, *italic*, ~~old~~ and `x = 1`.\n\n> Important\n\n---');
  assert.equal(descend(h.root,'h1')[0].textContent,'Heading');
  assert.equal(descend(h.root,'strong')[0].textContent,'bold');
  assert.equal(descend(h.root,'em')[0].textContent,'italic');
  assert.equal(descend(h.root,'del')[0].textContent,'old');
  assert.equal(descend(h.root,'code')[0].textContent,'x = 1');
  assert.equal(descend(h.root,'blockquote')[0].textContent,'Important');
  assert.equal(descend(h.root,'hr').length,1);
});

test('Markdown renderer supports lists, nested lists, task boxes and tables',()=>{
  const h=harness();
  h.render('- First\n  - nested\n- [x] Done\n- [ ] Todo\n\nName | Value\n--- | ---\nA | B\nC | D');
  assert.equal(descend(h.root,'ul').length,2);
  assert.equal(descend(h.root,'li').length,4);
  const boxes=descend(h.root,'input');
  assert.equal(boxes.length,2);
  assert.equal(boxes[0].disabled,true);
  assert.equal(boxes[0].checked,true);
  assert.equal(boxes[1].checked,false);
  assert.equal(descend(h.root,'th').length,2);
  assert.equal(descend(h.root,'td').length,4);
});

test('Markdown code fence preserves raw literal HTML and language',()=>{
  const h=harness();
  h.render('~~~js\nconst html = "<script>alert(1)</script>";\n~~~');
  const pre=descend(h.root,'pre')[0];
  assert.equal(pre.dataset.language,'js');
  assert.match(pre.textContent,/<script>alert/);
  assert.equal(descend(h.root,'script').length,0);
});

test('Markdown URL restrictions block javascript/data/html injection while allowing HTTPS',()=>{
  const h=harness();
  h.render('[evil](javascript:alert) [x](data:text/html) [safe](https://app.notion.com/p/a)\n\n<img src=x onerror=alert(1)>');
  const links=descend(h.root,'a');
  assert.equal(links.length,1);
  assert.equal(links[0].href,'https://app.notion.com/p/a');
  assert.equal(links[0].rel,'noopener noreferrer');
  assert.equal(links[0].target,'_blank');
  assert.equal(descend(h.root,'img').length,0);
  assert.match(h.root.textContent,/<img src=x onerror/);
  assert.match(h.root.textContent,/javascript:alert/);
});

test('Markdown re-render replaces old children and preserves unrecognized content as text',()=>{
  const h=harness();
  h.render('# Title');
  h.render('Plain text <details> with unsupported markup');
  assert.equal(descend(h.root,'h1').length,0);
  assert.match(h.root.textContent,/<details>/);
});
