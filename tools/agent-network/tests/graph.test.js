const {test} = require('node:test');
const assert = require('node:assert/strict');
const {edgeAge, edgeGeometry} = require('../dashboard/graph-utils.js');

const node = (x, y, width = 190, height = 62) => ({x,y,width,height});
const extract = path => path.match(/-?\d+(?:\.\d+)?/g).map(Number);

test('arrow time is hidden beyond ten minutes', () => {
  const now = 200000;
  assert.equal(edgeAge(now, now), '0 сек назад');
  assert.equal(edgeAge(now-59,now), '59 сек назад');
  assert.equal(edgeAge(now-60,now), '1 мин назад');
  assert.equal(edgeAge(now-599,now), '9 мин назад');
  assert.equal(edgeAge(now-600,now), '10 мин назад');
  assert.equal(edgeAge(now-600.01,now), null);
  assert.equal(edgeAge(now-601,now), null);
  assert.equal(edgeAge(now-3600,now), null);
  assert.equal(edgeAge(null,now), null);
});

test('reciprocal arrows use opposite sides of the line', () => {
  const a=node(180,200),b=node(700,200);
  const forward=edgeGeometry(a,b,true);
  const reverse=edgeGeometry(b,a,true);
  assert.ok(forward.path.includes(' Q '));
  assert.ok(reverse.path.includes(' Q '));
  const fy=extract(forward.path),ry=extract(reverse.path);
  assert.ok(fy[3]>200);
  assert.ok(ry[3]<200);
  assert.ok(forward.labelY>200);
  assert.ok(reverse.labelY<200);
  assert.notEqual(forward.path,reverse.path);
});

test('single direction and self loops get usable geometry', () => {
  const a=node(150,180),b=node(670,270);
  const line=edgeGeometry(a,b,false);
  assert.ok(line.path.includes(' Q '));
  assert.ok(Number.isFinite(line.labelX));
  assert.ok(Number.isFinite(line.labelY));
  const loop=edgeGeometry(a,a,true);
  assert.ok(loop.path.includes(' C '));
  assert.ok(loop.labelY < 180);
  assert.equal(edgeGeometry(node(0,0),node(0,0)).path.includes(' C '),true);
});
