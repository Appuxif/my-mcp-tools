const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');

const extension=path.join(__dirname,'../extension');
const manifest=JSON.parse(fs.readFileSync(path.join(extension,'manifest.json'),'utf8'));

test('Chrome uses the generated logo at every required icon size',()=>{
  for(const size of [16,32,48,128]){
    const icon='icons/icon'+size+'.png';
    assert.equal(manifest.icons[size],icon);
    assert.equal(manifest.action.default_icon[size],icon);
    const buffer=fs.readFileSync(path.join(extension,icon));
    assert.equal(buffer.subarray(0,8).toString('hex'),'89504e470d0a1a0a');
    assert.equal(buffer.readUInt32BE(16),size);
    assert.equal(buffer.readUInt32BE(20),size);
    assert.equal(buffer[25],6,'PNG must retain its alpha channel');
  }
});

test('popup uses the same logo asset as the Chrome toolbar',()=>{
  const html=fs.readFileSync(path.join(extension,'popup.html'),'utf8');
  assert.match(html,/src="icons\/icon48.png"/);
});
