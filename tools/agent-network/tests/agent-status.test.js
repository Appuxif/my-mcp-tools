const {test} = require('node:test');
const assert = require('node:assert/strict');
const {summarize, ago, latestInteraction} = require('../extension/agent-status.js');

const snapshot = {
  agents: [
    {agent_id:'a',name:'Chopper-Developer',role:'Python developer',current_task:'Implement HUD',
      task_status:'working', online:true, active_mcp:true, last_mcp_activity:160, last_poll_at:130,
      last_wake_at:100, last_wake_result:'submitted', pending_messages:3,
      token_hash:'HASH_MUST_NOT_LEAK'},
    {agent_id:'b',name:'Chopper-Reviewer',role:'Reviewer',pending_messages:0},
    {agent_id:'c',name:'Agent C',pending_messages:1},
  ],
  channels:[{agent_id:'a',connected:1,state:'busy',last_seen:166,last_wake_result:'submitted'}],
  edges: [
    {source:'a',target:'b',recent_count:7,pending_count:1,last_message_at:155},
    {source:'b',target:'a',recent_count:4,pending_count:2,last_message_at:151},
    {source:'a',target:'c',recent_count:2,pending_count:0,last_message_at:120},
  ],
  recent: [
    {message_id:'m1',sender_id:'a',sender_name:'Chopper-Developer',recipient_id:'b',
      recipient_name:'Chopper-Reviewer',created_at:155,status:'acknowledged',body:'PRIVATE BODY'},
    {message_id:'m2',sender_id:'b',sender_name:'Chopper-Reviewer',recipient_id:'a',
      recipient_name:'Chopper-Developer',created_at:151,status:'pending',body:'PRIVATE BODY'},
  ],
  server:{now:170}
};

test('HUD summarizes only the selected agent and excludes tokens/bodies',()=>{
  const data=summarize(snapshot,'a');
  assert.equal(data.name,'Chopper-Developer');
  assert.equal(data.role,'Python developer');
  assert.equal(data.pending,3);
  assert.equal(data.sent24h,9);
  assert.equal(data.taskStatus,'working');
  assert.equal(data.task,'Implement HUD');
  assert.deepEqual(data.lastOutbound,{peer:'Chopper-Reviewer',time:155,status:'acknowledged',pending:1});
  assert.deepEqual(data.lastInbound,{peer:'Chopper-Reviewer',time:151,status:'pending',pending:2});
  assert.equal(data.lastMcp,160);
  assert.equal(data.lastWake,100);
  assert.equal(data.adapter.state,'busy');
  assert.equal(data.recent.length,2);
  const raw=JSON.stringify(data);
  assert.equal(raw.includes('HASH_MUST_NOT_LEAK'),false);
  assert.equal(raw.includes('PRIVATE BODY'),false);
  assert.equal(raw.includes('token'),false);
  assert.equal(summarize(snapshot,'non-existing-id'),null);
});

test('HUD picks latest outgoing even outside top 10 recent messages',()=>{
  const state=JSON.parse(JSON.stringify(snapshot));
  state.recent=[];
  const data=summarize(state,'a');
  assert.equal(data.lastOutbound.peer,'Chopper-Reviewer');
  assert.equal(data.lastOutbound.time,155);
  assert.equal(data.lastOutbound.status,null);
  assert.equal(data.lastInbound.status,null);
});

test('HUD marks sent count as a lower bound when the graph caps relationships at 100',()=>{
  const state={...snapshot,edges:Array.from({length:100}, (_,i) => ({
    source:'a',target:String(i),recent_count:1,last_message_at:i
  }))};
  const data=summarize(state,'a');
  assert.equal(data.sent24h,100);
  assert.equal(data.sentCountIsLowerBound,true);
});

test('HUD marks scoped edge truncation as an incomplete count',()=>{
  const data=summarize({...snapshot,edgesTruncated:true},'a');
  assert.equal(data.sentCountIsLowerBound,true);
});

test('HUD handles missing/empty metadata safely',()=>{
  const data=summarize({agents:[{agent_id:'a',name:'A'}]},'a');
  assert.equal(data.pending,0);
  assert.equal(data.sent24h,0);
  assert.equal(data.lastOutbound,null);
  assert.equal(data.lastInbound,null);
  assert.equal(data.adapter,null);
  assert.equal(data.lastMcp,null);
  assert.equal(data.taskStatus,'idle');
  assert.equal(summarize(null,'a'),null);
  assert.equal(latestInteraction({edges:[]},'a','out'),null);
});

test('time labels are relative and safely handle null timestamps',()=>{
  assert.equal(ago(null,100),'—');
  assert.equal(ago(0,100),'—');
  assert.equal(ago(99,100),'сейчас');
  assert.equal(ago(75,100),'25 сек');
  assert.equal(ago(35,100),'1 мин');
  assert.equal(ago(100,100),'сейчас');
  assert.equal(ago(100,3700),'1 ч');
  assert.equal(ago(100,86400+100),'1 д');
});
