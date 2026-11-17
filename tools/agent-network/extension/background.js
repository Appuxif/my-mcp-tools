/* MV3 wake adapter: only UI observations + wake signals; never proxies MCP calls. */
importScripts('network-state.js', 'agent-status.js');
const traffic = new AgentNetworkTraffic.TrafficTracker();
const completionFilter = { urls: ['https://chatgpt.com/backend-api/*'] };
chrome.webRequest.onBeforeRequest.addListener(
  details => traffic.started(details), completionFilter
);
chrome.webRequest.onCompleted.addListener(
  details => traffic.finished(details), completionFilter
);
chrome.webRequest.onErrorOccurred.addListener(
  details => traffic.finished(details), completionFilter
);
const DEFAULT_SERVER = 'http://127.0.0.1:8787';
function normalizeServer(raw) {
  const url = new URL((raw || '').trim());
  if (!['http:', 'https:'].includes(url.protocol)) throw Error('Server URL must be HTTP or HTTPS');
  if (!url.hostname || url.username || url.password || url.search || url.hash ||
      (url.pathname !== '/' && url.pathname !== ''))
    throw Error('Enter the server origin only, e.g. https://agents.example.com');
  const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1' ||
    url.hostname === '[::1]' || /^10\.\d+\.\d+\.\d+$/.test(url.hostname) ||
    /^192\.168\.\d+\.\d+$/.test(url.hostname) ||
    /^172\.(1[6-9]|2\d|3[01])\.\d+\.\d+$/.test(url.hostname);
  if (url.protocol === 'http:' && !local)
    throw Error('Use HTTPS for remote public servers (HTTP is allowed only on private networks)');
  return url.origin;
}
const socketUrl = server => server.replace(/^http/, 'ws') + '/api/v1/channels/ws';
async function serverForTab(tabId, record = null) {
  const data = await chrome.storage.local.get(['serverByTab', 'defaultServer']);
  return normalizeServer(
    record?.server || data.serverByTab?.[tabId] || data.defaultServer || DEFAULT_SERVER
  );
}
async function setServer(tabId, raw) {
  const url = normalizeServer(raw);
  const {key,entries,record} = await currentRecord(tabId);
  const before = await serverForTab(tabId, record);
  if (before !== url && record?.active)
    throw Error('Сначала останови агента, затем переключи сервер.');
  if (before !== url && record) {
    disconnect(record.ownerTabId);
    await updateRecords(records => {
      if (records[key]?.agentId === record.agentId) delete records[key];
    }); // Never use an agent token on a different server.
  }
  const data = await chrome.storage.local.get('serverByTab');
  await chrome.storage.local.set({
    serverByTab:{...(data.serverByTab || {}), [tabId]:url},
    defaultServer:url,
  });
  return {server:url,changed:before!==url};
}
const connections = new Map(); // tabId -> { socket, interval, key }
const connectionLocks = new Map(); // conversation -> in-flight connect attempt
// Only agent-scoped metadata; never fetch the administrator dashboard.
const agentStatusCache = new Map();
async function cachedAgentStatus(server, record) {
  const key = server + '|' + record.agentId;
  const current = agentStatusCache.get(key);
  if (current && Date.now() - current.at < 4000) return current.promise;
  const promise = (async () => {
    const response = await fetch(server + '/api/v1/agents/hud', {
      method: 'GET',
      headers: {
        'Accept':'application/json',
        'X-Agent-Id':record.agentId,
        'X-Agent-Token':record.token,
      },
      cache:'no-store',
      signal:AbortSignal.timeout(8000),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw Error(data.detail || 'Agent status HTTP ' + response.status);
    return data;
  })();
  agentStatusCache.set(key, {at:Date.now(),promise});
  if (agentStatusCache.size > 30) agentStatusCache.delete(agentStatusCache.keys().next().value);
  try { return await promise; }
  catch (error) {
    if (agentStatusCache.get(key)?.promise === promise) agentStatusCache.delete(key);
    throw error;
  }
}

function chatKey(raw) {
  try {
    const url = new URL(raw);
    if (url.origin !== 'https://chatgpt.com') return null;
    const match = url.pathname.match(/(?:^|\/)c\/([a-z0-9-]+)\/?$/i);
    return match ? 'https://chatgpt.com/c/' + match[1].toLowerCase() : null;
  } catch { return null; }
}
const chatUrl = url => !!chatKey(url);
function newChatUrl(raw) {
  try {
    const url = new URL(raw);
    return url.origin === 'https://chatgpt.com' &&
      (url.pathname === '/' ||
       /^\/g\/[^/]+(?:\/project)?\/?$/.test(url.pathname));
  } catch { return false; }
}

// Chrome Storage is copy-on-read; serialize every read-modify-write to avoid
// lost updates when two conversations register concurrently.
let recordWriteQueue=Promise.resolve();
function updateRecords(mutator) {
  const operation=recordWriteQueue.catch(()=>{}).then(async()=>{
    const entries=await storage();
    const result=mutator(entries);
    await save(entries);
    return result;
  });
  recordWriteQueue=operation.catch(()=>{});
  return operation;
}

// Start, Stop, migration and server changes are lifecycle transitions.
// Serialize them so Stop cannot race an in-flight Start/registration.
let lifecycleQueue=Promise.resolve();
function lifecycle(operation) {
  const run=lifecycleQueue.catch(()=>{}).then(operation);
  lifecycleQueue=run.catch(()=>{});
  return run;
}

// One-time migration from tab-indexed identities to stable conversation keys.
// A shared promise prevents concurrent worker operations from racing migration.
let migrationPromise=null;
function migrateLegacy() {
  if (!migrationPromise) {
    migrationPromise=(async () => {
      const data=await chrome.storage.local.get(['agentsByChat','agentsByTab']);
      const old=data.agentsByTab || {};
      if (!Object.keys(old).length) return;
      const chats={...(data.agentsByChat || {})};
      for (const [tabId,record] of Object.entries(old)) {
        const key=chatKey(record?.chatUrl);
        if (!key) continue;
        if (!chats[key] || (!chats[key].active && record.active)) {
          chats[key]={
            ...record,chatUrl:key,ownerTabId:record.active ? Number(tabId) : null,
          };
        }
      }
      await chrome.storage.local.set({agentsByChat:chats});
      await chrome.storage.local.remove('agentsByTab');
    })();
  }
  return migrationPromise;
}
async function storage() {
  await migrateLegacy();
  return (await chrome.storage.local.get('agentsByChat')).agentsByChat || {};
}
async function save(data) {
  await migrateLegacy();
  await chrome.storage.local.set({agentsByChat:data});
}
async function currentRecord(tabId) {
  const tab = await chrome.tabs.get(Number(tabId));
  const key = chatKey(tab?.url);
  const entries = await storage();
  return {tab,key,entries,record:key ? entries[key] || null : null};
}
const askTab = async (tabId, msg) => {
  try { return await chrome.tabs.sendMessage(Number(tabId), msg); }
  catch {
    await chrome.scripting.executeScript({ target: { tabId: Number(tabId) }, files: ['content.js'] });
    return chrome.tabs.sendMessage(Number(tabId), msg);
  }
};
async function fetchJSON(server, path, payload) {
  const r = await fetch(server + path, {
    method: payload ? 'POST' : 'GET',
    headers: { 'Content-Type': 'application/json' },
    body: payload ? JSON.stringify(payload) : undefined,
    signal: AbortSignal.timeout(8000),
  });
  const result = await r.json();
  if (!r.ok) {
    const error = new Error(result.detail || ('Server HTTP ' + r.status));
    error.status = r.status;
    throw error;
  }
  return result;
}
async function probe(tabId, record) {
  const tab = await chrome.tabs.get(Number(tabId));
  if (!tab || chatKey(tab.url) !== chatKey(record.chatUrl))
    return { state: 'unknown', reason: 'conversation changed' };
  let dom;
  try { dom = await askTab(tabId, { type: 'agent:probe' }); }
  catch { dom = { state: 'unknown', reason: 'content script not available' }; }
  const network = traffic.snapshot(Number(tabId));
  const resolved = AgentNetworkTraffic.combineState(dom.state, network);
  return { ...dom, ...resolved, network: network.phase,
           activeRequests: network.activeRequests };
}
function disconnect(tabId) {
  const connection = connections.get(Number(tabId));
  if (!connection) return;
  connections.delete(Number(tabId));
  if (connection.interval) clearInterval(connection.interval);
  connection.socket.onclose = null;
  connection.socket.close();
}
async function ping(tabId, record, ws) {
  if (ws.readyState !== WebSocket.OPEN) return;
  const s = await probe(tabId, record);
  ws.send(JSON.stringify({ type: 'ping', state: s.state || 'unknown' }));
}
async function wake(tabId, record, ws, msg) {
  let status = 'rejected';
  try {
    const s = await probe(tabId, record);
    if (s.state !== 'idle') throw Error('chat state: ' + s.state);
    const text = [
      '[Agent Network wake]',
      'There are ' + Number(msg.pending_count || 0) + ' pending messages for agent ' + record.name + '.',
      'Use your native agent-network MCP get_messages tool with your registered agent identity.',
      'Read and acknowledge messages through MCP, then continue the assigned work.',
      'This is only a wake signal; the message contents are never delivered through the browser.',
    ].join('\n');
    const tab = await chrome.tabs.get(Number(tabId));
    if (chatKey(tab?.url) !== chatKey(record.chatUrl))
      throw Error('conversation changed');
    const result = await askTab(tabId, {
      type: 'agent:send', text, url: tab.url, wakeId: msg.wake_id,
    });
    if (!result?.ok) throw Error(result?.error || 'Could not submit wake prompt');
    status = 'submitted';
  } catch (error) {
    console.warn('Agent Network wake unavailable:', String(error));
  }
  if (ws.readyState === WebSocket.OPEN)
    ws.send(JSON.stringify({ type: 'wake_result', wake_id: msg.wake_id, status }));
}
async function connect(tabId, record) {
  const key=chatKey(record.chatUrl);
  if (!key || migratingKeys.has(key)) return;
  if (connectionLocks.has(key)) return connectionLocks.get(key);
  const task=connectOwned(tabId,record);
  connectionLocks.set(key,task);
  try {return await task;}
  finally {if(connectionLocks.get(key)===task)connectionLocks.delete(key);}
}
async function connectOwned(tabId, record) {
  const key = chatKey(record.chatUrl);
  if (!key || !record.active || connections.has(Number(tabId))) return;
  const tab = await chrome.tabs.get(Number(tabId)).catch(() => null);
  if (!tab || chatKey(tab.url) !== key) return;

  const entries = await storage();
  const current = entries[key];
  if (!current?.active || current.agentId !== record.agentId) return;

  // Exactly one PUSH connection per conversation, even when multiple tabs
  // display that same ChatGPT chat. The owner is a transport detail, not identity.
  const owner = Number(current.ownerTabId);
  if (owner && owner !== Number(tabId)) {
    const ownerTab = await chrome.tabs.get(owner).catch(() => null);
    if (ownerTab && chatKey(ownerTab.url) === key)
      return connectOwned(owner,current); // reconnect existing owner, not a second socket
    disconnect(owner);
  }
  for (const [otherId, connection] of connections) {
    if (connection.key === key && otherId !== Number(tabId)) return;
  }
  const saved=await updateRecords(records => {
    if (!records[key]?.active || records[key]?.agentId!==current.agentId)
      return null;
    records[key].ownerTabId=Number(tabId);
    return {...records[key]};
  });
  if (!saved) return;
  const liveRecord = {...saved, chatUrl:tab.url};
  const ws = new WebSocket(socketUrl(saved.server || await serverForTab(tabId,saved)));
  const connection = {socket:ws, interval:null, key};
  connections.set(Number(tabId), connection);
  ws.onopen = async () => {
    if (connections.get(Number(tabId)) !== connection) return;
    const state = await probe(tabId, liveRecord);
    if (connections.get(Number(tabId)) !== connection || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({
      type:'register', agent_id:current.agentId,
      token:current.token, kind:'chatgpt', state:state.state || 'unknown',
    }));
    connection.interval = setInterval(() => void ping(tabId, liveRecord, ws).catch(() => {}),20000);
  };
  ws.onmessage = e => {
    if (connections.get(Number(tabId)) !== connection) return;
    let msg;
    try {msg=JSON.parse(e.data);} catch {return;}
    if (msg.type==='wake') void wake(tabId,liveRecord,ws,msg);
    else if (msg.type==='error') {
      console.warn('Agent Network:',msg.error);
      if (String(msg.error).includes('Unknown agent_id')) {
        void (async () => {
          await updateRecords(records => {
            if(records[key]?.agentId!==current.agentId) return;
            records[key].active=false;
            records[key].bootstrapDone=false;
          });
          disconnect(tabId);
        })();
      }
    }
  };
  ws.onclose = () => {
    if (connection.interval) clearInterval(connection.interval);
    if (connections.get(Number(tabId))===connection) connections.delete(Number(tabId));
  };
  ws.onerror = () => {};
}
async function resumeAll() {
  const entries=await storage();
  const tabs=await chrome.tabs.query({url:'https://chatgpt.com/*'}).catch(()=>[]);
  for (const [key,record] of Object.entries(entries)) {
    if (!record.active || migratingKeys.has(key)) continue;
    let owner = record.ownerTabId
      ? await chrome.tabs.get(Number(record.ownerTabId)).catch(()=>null)
      : null;
    if (!owner || chatKey(owner.url)!==key)
      owner=tabs.find(tab=>chatKey(tab.url)===key);
    if (owner) {
      try {await connect(owner.id,record);} catch {/* reconnect next alarm */}
    }
  }
}
async function hudStatus(sender) {
  const tabId=sender?.tab?.id;
  const key=chatKey(sender?.tab?.url);
  if (tabId==null || sender.frameId!==0 || !key) return {visible:false};
  const currentTab=await chrome.tabs.get(tabId).catch(()=>null);
  if (chatKey(currentTab?.url)!==key) return {visible:false};
  const entries=await storage();
  const record=entries[key];
  if (!record) return {visible:false};
  const server=record.server || await serverForTab(tabId,record);
  const connected=connections.get(Number(record.ownerTabId))?.socket.readyState===WebSocket.OPEN;
  const base={
    visible:true,name:record.name,role:record.role,active:!!record.active,
    connected:!!connected,server,chatUrl:sender.tab.url,agentId:record.agentId
  };
  try {
    const [snapshot,ui]=await Promise.all([
      cachedAgentStatus(server,record),
      record.active
        ? probe(tabId,{...record,chatUrl:sender.tab.url}).catch(()=>null)
        : Promise.resolve(null)
    ]);
    return {
      ...base,updatedAt:Date.now(),
      status:AgentNetworkStatus.summarize(snapshot,record.agentId),
      ui:ui?.state||'unknown',network:ui?.network||'unknown',
    };
  } catch(error) {
    return {...base,updatedAt:Date.now(),status:null,
            ui:'unknown',network:'unknown',
            error:String(error.message||error).slice(0,180)};
  }
}

async function hudConversationRequest(sender, peerId = null, before = '', limit = 30) {
  // The caller cannot pick an agent_id or supply its token. Both come from the
  // extension's own per-tab identity, never from page-controlled input.
  const tabId = sender?.tab?.id;
  if (tabId == null || sender.frameId !== 0 || !chatUrl(sender.tab?.url))
    throw Error('Conversation viewer is only available to bound ChatGPT tabs');
  const key=chatKey(sender.tab.url);
  const currentTab=await chrome.tabs.get(tabId).catch(()=>null);
  if(chatKey(currentTab?.url)!==key) throw Error('The conversation tab has changed');
  const record = (await storage())[key];
  if (!record?.agentId || !record?.token)
    throw Error('This conversation is not bound to an agent');
  if (peerId !== null && (typeof peerId !== 'string' || peerId.length > 64 ||
                          !/^[a-zA-Z0-9_-]+$/.test(peerId)))
    throw Error('Invalid conversation peer');
  if (typeof before !== 'string' || before.length > 64 ||
      (before && !/^[a-zA-Z0-9_-]+$/.test(before)))
    throw Error('Invalid message cursor');
  if (!Number.isInteger(limit) || limit < 1 || limit > 50)
    throw Error('Invalid page size');

  const server = record.server || await serverForTab(tabId);
  const suffix = peerId === null
    ? '/api/v1/agents/conversations'
    : '/api/v1/agents/conversations/' + encodeURIComponent(peerId) +
      '/messages?limit=' + limit +
      (before ? '&before=' + encodeURIComponent(before) : '');
  const response = await fetch(server + suffix, {
    method:'GET', cache:'no-store', signal:AbortSignal.timeout(8000),
    headers:{
      'Accept':'application/json',
      'X-Agent-Id':record.agentId,
      'X-Agent-Token':record.token,
    },
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw Error(
    response.status === 403 ? 'Agent credentials are invalid' :
    data.detail || ('Conversation HTTP ' + response.status)
  );
  // Do not return a previous conversation's data if this tab changed mid-request.
  const latest = await chrome.tabs.get(tabId);
  const current = (await storage())[key];
  if (chatKey(latest?.url)!==key || current?.agentId!==record.agentId)
    throw Error('The conversation tab has changed');
  if (data.agent_id !== record.agentId ||
      (peerId !== null && data.peer_id !== peerId))
    throw Error('Unexpected conversation owner');
  return data;
}

async function hudOpenDashboard(sender) {
  const tabId = sender?.tab?.id;
  if (tabId == null || sender.frameId !== 0 || !chatUrl(sender.tab?.url))
    throw Error('Only ChatGPT tab agents can open their own dashboard');
  const record = (await storage())[chatKey(sender.tab.url)];
  if (!record) throw Error('This conversation is not bound to an agent');
  await chrome.tabs.create({url:(record.server || await serverForTab(tabId)) + '/dashboard'});
  return {opened:true};
}

async function revealHud(tabId, record) {
  const tab = await chrome.tabs.get(Number(tabId)).catch(() => null);
  if (!tab || chatKey(tab.url)!==chatKey(record.chatUrl)) return false;
  const message = {
    type:'network:hud-show',
    agentId:record.agentId, name:record.name, role:record.role,
    chatUrl:tab.url,
  };
  // When an extension is reloaded while a ChatGPT tab stays open, its
  // content scripts may not exist in that tab yet. Install the HUD on demand.
  const send = () => chrome.tabs.sendMessage(Number(tabId), message);
  try {
    const result = await send();
    if (result?.ok) return true;
  } catch { /* no HUD receiver - install below */ }
  await chrome.scripting.executeScript({
    target:{tabId:Number(tabId)},
    files:['agent-status.js','agent-hud.js'],
  });
  const result = await send();
  return result?.ok === true;
}

function bootstrapPrompt(record, migrated=false) {
  return [
    '[Agent Network identity — private credential]',
    migrated
      ? 'This conversation is the new ChatGPT home of an EXISTING Agent Network identity.'
      : 'You are the registered agent named ' + record.name + '.',
    'Agent name: ' + record.name,
    'Role: ' + record.role,
    'Purpose: ' + record.purpose,
    'Description: ' + record.description,
    'Use the native agent-network MCP tools for ALL inter-agent messages.',
    'agent_id: ' + record.agentId,
    'token: ' + record.token,
    'Keep the token private. Use list_agents/get_messages/send_message/ack_message.',
    'Call get_messages now to check for pending work. Wake signals will arrive through this chat.',
    ...(migrated ? [
      'This is a new ChatGPT conversation. Prior ChatGPT conversation history was not copied.',
      'Continue using the same Agent Network ID, profile, pending inbox and task state.'
    ] : []),
  ].join('\n');
}

function existingCandidates(entries, server, excludeKey=null) {
  return Object.entries(entries).filter(([key,r]) =>
    key!==excludeKey && r?.agentId && r?.token &&
    (r.server||DEFAULT_SERVER)===server
  ).map(([key,r]) => ({
    chatUrl:key,agentId:r.agentId,name:r.name,
    role:r.role,purpose:r.purpose,description:r.description,active:!!r.active
  })).sort((a,b)=>a.name.localeCompare(b.name));
}
async function availableAgents(tabId) {
  const {key,record}=await currentRecord(tabId);
  const server=await serverForTab(tabId,record);
  return {
    items:existingCandidates(await storage(),server,key),
    canMigrate:!record,
    server,
  };
}

async function migrationPreview(tabId,name) {
  const tab=await chrome.tabs.get(Number(tabId));
  const target=chatKey(tab?.url);
  if (!target && !newChatUrl(tab?.url))
    throw Error('Открой новый чат ChatGPT перед переносом агента.');
  const entries=await storage();
  if (target && entries[target])
    throw Error('В этом чате уже есть агент. Сначала открой новый чат без привязки.');
  const server=await serverForTab(tabId);
  const candidates=existingCandidates(entries,server,target).filter(r=>r.name===name);
  if(candidates.length!==1)
    throw Error('Агент не найден среди локально сохранённых регистраций этого сервера.');
  const source=candidates[0];
  return {
    migrate:true,agentId:source.agentId,name:source.name,
    fromChatUrl:source.chatUrl,toChatUrl:tab.url,
    needsNewChat:!target,server,
  };
}

async function verifyMigrationAgent(server,record) {
  const response=await fetch(server+'/api/v1/agents/hud',{
    method:'GET', cache:'no-store', signal:AbortSignal.timeout(8000),
    headers:{
      'Accept':'application/json',
      'X-Agent-Id':record.agentId,
      'X-Agent-Token':record.token,
    },
  });
  if(!response.ok) throw Error(
    'Не удалось подтвердить доступ к старому агенту (HTTP '+response.status+').'
  );
  const snapshot=await response.json();
  if(!snapshot.agents?.some(a=>a.agent_id===record.agentId && a.name===record.name))
    throw Error('Сервер вернул неподходящую идентичность агента.');
}

async function waitForConversation(tabId, originalUrl, timeoutMs=30000) {
  const start=Date.now();
  while(Date.now()-start<timeoutMs) {
    const tab=await chrome.tabs.get(Number(tabId)).catch(()=>null);
    if(!tab) throw Error('Вкладка закрылась до создания нового чата.');
    const key=chatKey(tab.url);
    if(key) return {tab,key};
    if(tab.url!==originalUrl)
      throw Error('Открылась другая страница вместо нового чата.');
    await new Promise(resolve=>setTimeout(resolve,250));
  }
  throw Error('ChatGPT не выдал ID новой беседы. Старый агент сохранён без изменений.');
}
const migratingKeys=new Set();
async function migrateAgent(tabId,expectedAgentId,fromChatUrl,expectedDestination) {
  const tab=await chrome.tabs.get(Number(tabId));
  if(!tab || tab.url!==expectedDestination)
    throw Error('Адрес новой беседы изменился после подтверждения.');
  let targetKey=chatKey(tab.url);
  if(!targetKey && !newChatUrl(tab.url))
    throw Error('Текущая страница не является новым чатом ChatGPT.');
  const records=await storage();
  const old=records[fromChatUrl];
  if(!old || old.agentId!==expectedAgentId || !old.token)
    throw Error('Исходный агент изменился. Открой расширение заново.');
  if(fromChatUrl===targetKey || (targetKey && records[targetKey]))
    throw Error('В целевой беседе уже зарегистрирован агент.');
  const server=await serverForTab(tabId);
  if(server!==(old.server||DEFAULT_SERVER))
    throw Error('Нельзя перенести агента между серверами.');
  await verifyMigrationAgent(server,old);
  // Keep the old binding durable until the new chat accepts its bootstrap.
  // Temporarily disconnect old PUSH to avoid delivering wakes into both chats.
  migratingKeys.add(fromChatUrl);
  disconnect(old.ownerTabId);
  let transferred=false;
  try {
    const result=await askTab(tabId,{
      type:'agent:send',text:bootstrapPrompt(old,true),
      url:tab.url,allowNewChat:!targetKey,
    });
    if(!result?.ok) throw Error('Новый чат не принял инициализацию: '+(result?.error||'unknown'));
    const destination=targetKey
      ? {tab:await chrome.tabs.get(Number(tabId)),key:targetKey}
      : await waitForConversation(tabId,tab.url);
    if(chatKey(destination.tab?.url)!==destination.key)
      throw Error('Новая беседа изменилась во время инициализации.');
    targetKey=destination.key;
    // Move, not copy: only the new chat should use this agent identity.
    const updated=await updateRecords(entries=>{
      if(entries[fromChatUrl]?.agentId!==expectedAgentId || entries[targetKey])
        throw Error('Привязки изменились при переносе. Попробуй ещё раз.');
      const moved={
        ...entries[fromChatUrl],chatUrl:targetKey,
        ownerTabId:Number(tabId),active:true,bootstrapDone:true,
      };
      delete entries[fromChatUrl];
      entries[targetKey]=moved;
      return moved;
    });
    transferred=true;
    let connectionWarning='';
    try { await connect(tabId,updated); }
    catch(error) {
      // The identity was successfully transferred and must never roll back
      // after ChatGPT accepted the new bootstrap. PUSH can reconnect later.
      connectionWarning='PUSH сейчас недоступен: '+String(error.message||error);
    }
    return {migrated:true,agentId:updated.agentId,name:updated.name,
            fromChatUrl,toChatUrl:targetKey,
            connected:!!connections.get(Number(tabId)),connectionWarning};
  } finally {
    migratingKeys.delete(fromChatUrl);
    if(!transferred) await resumeAll(); // Failed migration keeps old owner working.
  }
}

const startLocks = new Map();
async function startAgent(tabId, profile) {
  const {tab,key}=await currentRecord(tabId);
  if (!key) throw Error('Open an existing ChatGPT conversation (not the homepage)');
  const previous = startLocks.get(key) || Promise.resolve();
  const operation = previous.catch(()=>{}).then(()=>registerConversation(tabId,profile));
  startLocks.set(key,operation);
  void operation.then(
    ()=>{if(startLocks.get(key)===operation)startLocks.delete(key);},
    ()=>{if(startLocks.get(key)===operation)startLocks.delete(key);}
  );
  return operation;
}
async function registerConversation(tabId, profile) {
  const {tab,key,entries,record:old}=await currentRecord(tabId);
  if (!key) throw Error('Conversation changed; open the ChatGPT conversation again');
  const server=await serverForTab(tabId,old);
  let record=old;
  if (record && (record.server || DEFAULT_SERVER)!==server)
    throw Error('Agent belongs to a different server. Stop and select a new server first.');
  if (record && record.name!==profile.name)
    throw Error('Agent name is immutable. Stop and create a new agent in a different chat.');

  let created=false;
  if (record) {
    try {
      await fetchJSON(server,'/api/v1/agents/profile',{
        agent_id:record.agentId,token:record.token,
        role:profile.role,purpose:profile.purpose,description:profile.description,
      });
      record={...record,...profile,active:true};
      if (!old.active) record.ownerTabId=tabId; // explicit new Start picks the owner
    } catch(error) {
      if(error.status===400 && String(error.message).includes('Unknown agent_id')) {
        disconnect(record.ownerTabId);
        record=null; // server expired/deleted this identity
      } else throw error;
    }
  }
  if (!record) {
    const result=await fetchJSON(server,'/api/v1/agents/register',{
      ...profile,kind:'chatgpt',
    });
    record={
      ...profile,agentId:result.agent.agent_id,token:result.token,
      chatUrl:key,ownerTabId:tabId,server,active:true,bootstrapDone:false,
    };
    created=true;
  }
  const actualTab=await chrome.tabs.get(Number(tabId)).catch(()=>null);
  const sameChat=chatKey(actualTab?.url)===key;
  if (!sameChat && created) record={...record,active:false,bootstrapDone:false};
  if (sameChat || created) {
    await updateRecords(records=>{ records[key]=record; });
  }
  if (!sameChat) throw Error(
    'Чат изменился во время регистрации. Вернитесь в исходную беседу и повторите Старт.'
  );

  // Registration controls agent identity only. The floating HUD is never
  // shown automatically; the popup has a separate explicit Show button.
  await connect(tabId,record);

  if (!record.bootstrapDone) {
    const bootstrap=bootstrapPrompt(record);
    const sent=await askTab(tabId,{type:'agent:send',text:bootstrap,url:tab.url});
    if(!sent?.ok) throw Error('Registered, but initialization prompt was not sent: '+(sent?.error||'unknown'));
    record.bootstrapDone=true;
    await updateRecords(records=>{
      if (records[key]?.agentId===record.agentId) records[key].bootstrapDone=true;
    });
  }
  return {agentId:record.agentId,name:record.name,created};
}
async function stopAgent(tabId) {
  const {key,record}=await currentRecord(tabId);
  if (!record || !key) return {stopped:true};
  await updateRecords(records=>{
    if(records[key]?.agentId===record.agentId) records[key].active=false;
  });
  disconnect(record.ownerTabId);
  return {stopped:true};
}
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  (async () => {
    switch (message?.type) {
      case 'network:status': {
        const {key,record}=await currentRecord(message.tabId);
        const server=await serverForTab(message.tabId,record);
        return {
          server,
          entry:record && {
            agentId:record.agentId,name:record.name,role:record.role,
            purpose:record.purpose,description:record.description,
            active:record.active,chatUrl:key,bootstrapDone:record.bootstrapDone,
          },
          connected:record ?
            connections.get(Number(record.ownerTabId))?.socket.readyState===WebSocket.OPEN : false,
          ui:record ? await probe(message.tabId,{...record,chatUrl:(await chrome.tabs.get(message.tabId)).url}) : null,
        };
      }
      case 'network:hud-status': return hudStatus(sender);
      case 'network:hud-conversations': return hudConversationRequest(sender);
      case 'network:hud-messages':
        return hudConversationRequest(sender, message.peerId, message.before || '', message.limit || 30);
      case 'network:hud-open-dashboard': return hudOpenDashboard(sender);
      case 'network:show-hud': {
        const {record}=await currentRecord(message.tabId);
        if (!record) throw Error('Сначала зарегистрируй агента кнопкой «Старт».');
        const visible=await revealHud(message.tabId,record);
        if (!visible) throw Error('Не удалось показать панель в текущем чате.');
        return {visible:true};
      }
      case 'network:available-agents': return availableAgents(message.tabId);
      case 'network:migration-preview':
        return migrationPreview(message.tabId,message.name);
      case 'network:migrate':
        return lifecycle(()=>migrateAgent(
          message.tabId,message.agentId,message.fromChatUrl,message.expectedDestination
        ));
      case 'network:start': return lifecycle(()=>startAgent(message.tabId, message.profile));
      case 'network:stop': return lifecycle(()=>stopAgent(message.tabId));
      case 'network:set-server': return lifecycle(()=>setServer(message.tabId, message.server));
      case 'network:open-dashboard': {
        const {record}=await currentRecord(message.tabId);
        const server = await serverForTab(message.tabId,record);
        await chrome.tabs.create({url: server + '/dashboard'});
        return {server};
      }
      default: throw Error('Unknown operation');
    }
  })().then(result => respond({ ok: true, ...result }))
    .catch(error => respond({ ok: false, error: String(error.message || error) }));
  return true;
});
chrome.tabs.onRemoved.addListener(tabId => {
  disconnect(tabId);
  traffic.clear(tabId);
  void (async () => {
    await updateRecords(entries=>{
      for(const record of Object.values(entries)){
        if(record.ownerTabId!=null && Number(record.ownerTabId)===Number(tabId))
          record.ownerTabId=null;
      }
    });
    const data=await chrome.storage.local.get('serverByTab');
    const servers=data.serverByTab || {};
    delete servers[tabId];
    await chrome.storage.local.set({serverByTab:servers});
    // The same conversation can still be open in another tab.
    await resumeAll();
  })().catch(error=>console.warn('Agent Network tab cleanup:',String(error)));
});
chrome.tabs.onUpdated.addListener((tabId,changes) => {
  if (!changes.url) return;
  traffic.clear(tabId);
  void (async () => {
    const key=chatKey(changes.url);
    const connection=connections.get(Number(tabId));
    if (connection && connection.key!==key) disconnect(tabId);
    await updateRecords(entries=>{
      for(const [oldKey,record] of Object.entries(entries)){
        if(record.ownerTabId!=null && Number(record.ownerTabId)===Number(tabId) && oldKey!==key)
          record.ownerTabId=null;
      }
    });
    await resumeAll();
  })().catch(error=>console.warn('Agent Network navigation:',String(error)));
});
chrome.alarms.create('agent-network-resume', { periodInMinutes: 1 });
chrome.alarms.onAlarm.addListener(a => {
  if (a.name === 'agent-network-resume') void resumeAll();
});
chrome.runtime.onStartup.addListener(() => void resumeAll());
chrome.runtime.onInstalled.addListener(() => void resumeAll());
void resumeAll();
