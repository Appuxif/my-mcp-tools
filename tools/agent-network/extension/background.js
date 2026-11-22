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
// Administrator tokens require the trusted-context storage boundary.
// If it cannot be established, fail closed rather than making the stored
// secret accessible to a ChatGPT content script.
const adminStorageProtected=chrome.storage.local.setAccessLevel
  ? chrome.storage.local.setAccessLevel({accessLevel:'TRUSTED_CONTEXTS'})
  : Promise.reject(Error('Chrome does not support trusted-context storage'));
void adminStorageProtected.catch(()=>{});
const ADMIN_STORE_KEY='adminTokenByServer';
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

// Administrator token is stored per-server in extension-only local storage,
// never in a conversation record or the ChatGPT bootstrap prompt.
let adminWriteQueue=Promise.resolve();
function changeAdminTokens(mutator) {
  const op=adminWriteQueue.catch(()=>{}).then(async()=>{
    await adminStorageProtected;
    const stored=(await chrome.storage.local.get(ADMIN_STORE_KEY))[ADMIN_STORE_KEY] || {};
    const next={...stored};
    mutator(next);
    await chrome.storage.local.set({[ADMIN_STORE_KEY]:next});
  });
  adminWriteQueue=op.catch(()=>{});
  return op;
}
async function adminToken(server) {
  await adminStorageProtected;
  const stored=(await chrome.storage.local.get(ADMIN_STORE_KEY))[ADMIN_STORE_KEY] || {};
  return stored[server] || '';
}
async function adminRequest(server, secret, path, method='GET', body=null, record=null) {
  const hostname=new URL(server).hostname;
  if(!['127.0.0.1','localhost','[::1]'].includes(hostname))
    throw Error('Администрирование команд доступно только через локальный сервер.');
  const headers={'Accept':'application/json', 'X-Agent-Network-Admin-Token':secret};
  if(body!==null) headers['Content-Type']='application/json';
  if(record) {
    headers['X-Agent-Id']=record.agentId;
    headers['X-Agent-Token']=record.token;
  }
  const response=await fetch(server+path,{
    method,headers,cache:'no-store',
    body:body!==null ? JSON.stringify(body) : undefined,
    signal:AbortSignal.timeout(8000),
  });
  const data=await response.json().catch(()=>({}));
  if(!response.ok) {
    const error=new Error(data.detail || 'Admin HTTP '+response.status);
    error.status=response.status;
    throw error;
  }
  return data;
}
async function adminConnect(tabId, secret) {
  await adminStorageProtected;
  if(typeof secret!=='string' || secret.length<40 || secret.length>256)
    throw Error('Укажи корректный admin-token.');
  const {record}=await currentRecord(tabId);
  const server=await serverForTab(tabId,record);
  const data=await adminRequest(server,secret,'/api/v1/admin/teams');
  await changeAdminTokens(tokens=>{tokens[server]=secret;});
  return {configured:true,teams:data.items};
}
async function adminStatus(tabId) {
  const {record}=await currentRecord(tabId);
  const server=await serverForTab(tabId,record);
  const secret=await adminToken(server);
  if(!secret) return {configured:false,teams:[]};
  const data=await adminRequest(server,secret,'/api/v1/admin/teams');
  let agentTeams=[];
  if(record?.agentId && record?.token) {
    const own=await adminRequest(server,secret,'/api/v1/admin/me/teams',
                                 'GET',null,record);
    if(own.agent_id===record.agentId) agentTeams=own.teams;
  }
  return {configured:true,teams:data.items,agentTeams};
}
async function adminClear(tabId) {
  const {record}=await currentRecord(tabId);
  const server=await serverForTab(tabId,record);
  await changeAdminTokens(tokens=>{delete tokens[server];});
  return {configured:false};
}
async function adminSetTeams(tabId,teams) {
  const {key,record}=await currentRecord(tabId);
  if(!key || !record?.token) throw Error('Сначала зарегистрируй агента.');
  const server=await serverForTab(tabId,record);
  const secret=await adminToken(server);
  if(!secret) throw Error('Сначала укажи admin-token.');
  const agent=await adminRequest(server,secret,'/api/v1/admin/me/teams',
                                 'PUT',{teams},record);
  if(agent.agent_id!==record.agentId)
    throw Error('Административный сервер вернул другого агента.');
  await updateRecords(entries=>{
    if(entries[key]?.agentId===record.agentId) entries[key].teams=agent.teams;
  });
  return {agent};
}
async function revokeChatCredential(record) {
  if(!record?.chatCredentialId) return;
  const server=normalizeServer(record.server||DEFAULT_SERVER);
  const secret=await adminToken(server);
  if(!secret) throw Error('Для отвязки агента нужен admin-token.');
  await adminRequest(server,secret,
    '/api/v1/admin/agents/'+encodeURIComponent(record.agentId)+
    '/chat-credentials/'+encodeURIComponent(record.chatCredentialId),'DELETE');
}
async function unlinkAgent(tabId) {
  const {key,record}=await currentRecord(tabId);
  if(!key || !record) throw Error('Чат не привязан к агенту.');
  await assertNoPendingTransfer(record);
  // Revoke on the server before dropping the local credential.
  await revokeChatCredential(record);
  disconnect(record.ownerTabId);
  await updateRecords(entries=>{
    if(entries[key]?.agentId!==record.agentId) throw Error('Привязка изменилась.');
    delete entries[key];
  });
  // Stop all scheduled wakeups before dropping this chat binding.
  await disableSchedule(record);
  return {unlinked:true,legacyTokenNotRevoked:!record.chatCredentialId};
}
async function serverForTab(tabId, record = null) {
  const data = await chrome.storage.local.get(['serverByTab', 'defaultServer']);
  return normalizeServer(
    record?.server || data.serverByTab?.[tabId] || data.defaultServer || DEFAULT_SERVER
  );
}
// Tab-specific server preferences also use copy-on-read Chrome Storage.
// Navigation/close handlers may overlap a popup server change.
let serverWriteQueue=Promise.resolve();
function updateServerPreferences(mutator) {
  const operation=serverWriteQueue.catch(()=>{}).then(async()=>{
    const data=await chrome.storage.local.get(['serverByTab','defaultServer']);
    const next={serverByTab:{...(data.serverByTab||{})}};
    if(data.defaultServer!==undefined) next.defaultServer=data.defaultServer;
    mutator(next);
    await chrome.storage.local.set(next);
  });
  serverWriteQueue=operation.catch(()=>{});
  return operation;
}
async function setServer(tabId, raw) {
  const url = normalizeServer(raw);
  const {key,entries,record} = await currentRecord(tabId);
  const before = await serverForTab(tabId, record);
  if(before!==url && record) await assertNoPendingTransfer(record);
  if (before !== url && record?.active)
    throw Error('Сначала останови агента, затем переключи сервер.');
  if (before !== url && record) {
    // The session token is only valid while its local chat binding exists.
    await revokeChatCredential(record);
    await disableSchedule(record);
    disconnect(record.ownerTabId);
    await updateRecords(records => {
      if (records[key]?.agentId === record.agentId) delete records[key];
    }); // Never use an agent token on a different server.
  }
  await updateServerPreferences(data=>{
    data.serverByTab[tabId]=url;
    data.defaultServer=url;
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
// Scheduled and server-triggered wakes must not race in the same chat.
const wakeInFlight = new Set();
async function guardedWake(agentId, action) {
  if (wakeInFlight.has(agentId)) throw Error('another wake is in progress');
  wakeInFlight.add(agentId);
  try { return await action(); }
  finally { wakeInFlight.delete(agentId); }
}
async function wake(tabId, record, ws, msg) {
  let status = 'rejected';
  try {
    await guardedWake(record.agentId, async () => {
      const s = await probe(tabId, record);
      if (s.state !== 'idle') throw Error('chat state: ' + s.state);
      const text = [
        '[Agent Network wake]',
        'There are ' + Number(msg.pending_count || 0) + ' pending messages for agent ' + record.name + '.',
        'Agent name: ' + record.name,
        'agent_id: ' + record.agentId,
        'token: ' + record.token,
        'Use these exact credentials with the native agent-network MCP get_messages tool. Do not register a new agent.',
        'Keep the token private; do not send it in inter-agent messages or logs.',
        'Read and acknowledge messages through MCP, then continue the assigned work.',
        'This is only a wake signal; the message contents are never delivered through the browser.',
      ].join('\n');
      const tab = await chrome.tabs.get(Number(tabId));
      const current=(await storage())[chatKey(record.chatUrl)];
      if (chatKey(tab?.url) !== chatKey(record.chatUrl) ||
          current?.agentId !== record.agentId || current?.token !== record.token ||
          !current?.active)
        throw Error('conversation binding changed');
      const result = await askTab(tabId, {
        type: 'agent:send', text, url: tab.url, wakeId: msg.wake_id,
      });
      if (!result?.ok) throw Error(result?.error || 'Could not submit wake prompt');
    });
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
  const server=saved.server || await serverForTab(tabId,saved);
  // The owner can navigate or Stop while the URL/server/storage awaits finish.
  // Check the live tab and binding immediately before creating a socket.
  const latestTab=await chrome.tabs.get(Number(tabId)).catch(()=>null);
  const latest=(await storage())[key];
  if (chatKey(latestTab?.url)!==key || !latest?.active ||
      latest.agentId!==saved.agentId || Number(latest.ownerTabId)!==Number(tabId))
    return;
  const liveRecord = {...latest, chatUrl:latestTab.url};
  const ws = new WebSocket(socketUrl(server));
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
  await recoverPendingTransfers();
  const pending=await pendingChatTransfers();
  const unresolved=new Set(Object.values(pending).map(p=>p.from));
  const entries=await storage();
  const tabs=await chrome.tabs.query({url:'https://chatgpt.com/*'}).catch(()=>[]);
  for (const [key,record] of Object.entries(entries)) {
    if (!record.active || migratingKeys.has(key) || unresolved.has(key)) continue;
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

async function hudPreferences(sender, agentId, pref=null) {
  const tabId=sender?.tab?.id;
  const key=chatKey(sender?.tab?.url);
  if(tabId==null || sender?.frameId!==0 || !key)
    throw Error('HUD preferences require a bound ChatGPT tab');
  const actual=await chrome.tabs.get(tabId).catch(()=>null);
  const record=(await storage())[key];
  if(chatKey(actual?.url)!==key || !record?.agentId ||
     record.agentId!==agentId)
    throw Error('HUD preference identity mismatch');
  const prefKey='agentNetworkHud:'+record.agentId;
  if(pref===null) {
    const stored=(await chrome.storage.local.get(prefKey))[prefKey] || {};
    return {pref:stored};
  }
  if(typeof pref!=='object' || Array.isArray(pref) ||
     !['full','collapsed','icon'].includes(pref.mode) ||
     ![pref.x,pref.y].every(n=>n===null ||
       (typeof n==='number' && Number.isFinite(n) && Math.abs(n)<1e6)))
    throw Error('Invalid HUD preferences');
  await chrome.storage.local.set({[prefKey]:{
    mode:pref.mode,x:pref.x,y:pref.y,
  }});
  return {saved:true};
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
    'Team membership is read-only for agents; only a human administrator can change teams.',
    'Use list_agents to discover peers sharing one or more of your teams.',
    'Use the native agent-network MCP tools for ALL inter-agent messages.',
    'agent_id: ' + record.agentId,
    'token: ' + record.token,
    'Keep the token private. Use list_agents/get_messages/send_message/ack_message.',
    'Call native MCP read_instructions(agent_id, token) NOW to load the permanent administrator-defined instructions before starting work.',
    'These instructions are independent of saved context, read-only for agents, and may be updated in the Dashboard.',
    'Call get_messages now to check for pending work. Wake signals will arrive through this chat.',
    'Use save_context only when the user explicitly asks you to compact/save this chat; never automatically.',
    ...(migrated ? [
      'This is a new ChatGPT conversation. Prior ChatGPT conversation history was not copied.',
      'Call native MCP read_context(agent_id, token) now to restore the saved compact summary from the prior conversation.',
      'Continue from that saved context when it exists. If no summary was saved, do not invent one.',
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
  })).map(agent=>({...agent,source:'local',kind:'chatgpt'}))
    .sort((a,b)=>a.name.localeCompare(b.name));
}
async function availableAgents(tabId, trustedPopup=false) {
  const {key,record}=await currentRecord(tabId);
  const server=await serverForTab(tabId,record);
  let entries=await storage();
  let candidates=existingCandidates(entries,server,key);
  let syncError='';
  let authoritative=false;
  if(trustedPopup) {
    try {
      const secret=await adminToken(server);
      if(secret) {
        const result=await adminRequest(server,secret,'/api/v1/admin/agents');
        if(!Array.isArray(result.items) || !result.items.every(a=>
          a && typeof a.agent_id==='string' && typeof a.name==='string' &&
          typeof a.role==='string' && typeof a.kind==='string' &&
          typeof a.purpose==='string' && typeof a.description==='string'))
          throw Error('Invalid agent catalog');
        const ids=result.items.map(a=>a.agent_id);
        if(new Set(ids).size!==ids.length) throw Error('Duplicate agent identities');
        const live=new Set(ids);
        await updateRecords(records=>{
          for(const [chat,agent] of Object.entries(records)) {
            if(agent?.agentId && (agent.server||DEFAULT_SERVER)===server &&
               !live.has(agent.agentId)) {
              const connection=connections.get(Number(agent.ownerTabId));
              if(connection?.key===chat) disconnect(agent.ownerTabId);
              delete records[chat];
            }
          }
        });
        entries=await storage();
        authoritative=true;
        const local=new Map(existingCandidates(entries,server,key)
          .map(a=>[a.agentId,a]));
        candidates=result.items.filter(a=>a.agent_id!==record?.agentId)
          .map(a=>{
            const linked=local.get(a.agent_id);
            return {
              agentId:a.agent_id,name:a.name,kind:a.kind,role:a.role,
              purpose:a.purpose,description:a.description,
              teams:Array.isArray(a.teams)?a.teams:[],
              chatUrl:linked?.chatUrl || null,
              active:!!linked?.active,source:linked?'local':'server',
            };
          }).sort((a,b)=>a.name.localeCompare(b.name));
      }
    } catch(error) {
      // An unavailable server must never cause destructive cleanup.
      syncError=String(error.message||error);
      console.warn('Agent Network catalog sync failed:',syncError);
    }
  }
  if(trustedPopup && !authoritative && candidates.length) {
    // Without an authoritative response we can hide agents whose local token
    // is rejected, but must preserve their bindings (rotation vs deletion).
    const visible=await Promise.all(candidates.map(async agent=>{
      const local=entries[agent.chatUrl];
      try {
        const response=await fetch(server+'/api/v1/agents/hud',{
          method:'GET',cache:'no-store',signal:AbortSignal.timeout(8000),
          headers:{'Accept':'application/json','X-Agent-Id':local.agentId,
                   'X-Agent-Token':local.token},
        });
        if(response.status===403) return false;
        if(!response.ok) return true;
        const snapshot=await response.json();
        return snapshot.agents?.some(a=>
          a.agent_id===local.agentId && a.name===local.name)===true;
      } catch { return true; }
    }));
    candidates=candidates.filter((_,i)=>visible[i]);
  }
  const removedCurrent=!!record && !entries[key];
  return {items:candidates,canMigrate:!record || removedCurrent,
          removedCurrent,server,syncError,synced:authoritative};
}

async function migrationPreview(tabId,name,agentId='') {
  const tab=await chrome.tabs.get(Number(tabId));
  const target=chatKey(tab?.url);
  if (!target && !newChatUrl(tab?.url))
    throw Error('Открой новый чат ChatGPT перед переносом агента.');
  const entries=await storage();
  if (target && entries[target])
    throw Error('В этом чате уже есть агент. Сначала открой новый чат без привязки.');
  const server=await serverForTab(tabId);
  const candidates=existingCandidates(entries,server,target).filter(r=>
    r.name===name && (!agentId || r.agentId===agentId));
  if(candidates.length!==1)
    throw Error('Агент не найден среди локально сохранённых регистраций этого сервера.');
  const source=candidates[0];
  const admin=await adminToken(server);
  if(!admin) throw Error('Для переноса агента настрой admin-token в расширении.');
  const binding=await adminRequest(server,admin,
    '/api/v1/admin/agents/'+encodeURIComponent(source.agentId)+'/chat-binding');
  if(binding.agent_id!==source.agentId)
    throw Error('Сервер вернул неправильную привязку агента.');
  const takeover=!!binding.chat_url && binding.chat_url!==source.chatUrl;
  return {
    migrate:true,agentId:source.agentId,name:source.name,
    fromChatUrl:source.chatUrl,toChatUrl:tab.url,
    serverSourceChatUrl:binding.chat_url,
    serverSourceTokenId:binding.token_id,
    takeover,needsNewChat:!target,server,
    rotatesPrimary:!(entries[source.chatUrl]?.chatCredentialId) && !binding.token_id,
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
  // A rotated or expired old chat token is a stale LOCAL binding, not
  // grounds to reject a human-confirmed, admin-authorized migration.
  if(response.status===401 || response.status===403) return false;
  if(!response.ok) throw Error(
    'Не удалось связаться с сервером агента (HTTP '+response.status+').'
  );
  const snapshot=await response.json();
  return !!snapshot.agents?.some(a=>
    a.agent_id===record.agentId && a.name===record.name);
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
async function waitForChatIdle(tabId,expectedKey,timeoutMs=90000) {
  const deadline=Date.now()+timeoutMs;
  while(Date.now()<deadline) {
    const tab=await conversationTab(tabId,expectedKey);
    const readiness=await probe(tabId,{chatUrl:tab.url});
    if(readiness?.state==='idle') return tab;
    if(readiness?.state==='draft')
      throw Error('В новом чате есть черновик или вложение. Перенос отменён.');
    await new Promise(resolve=>setTimeout(resolve,350));
  }
  throw Error('Новый чат ещё генерирует ответ; дождись окончания и повтори перенос.');
}

const PENDING_TRANSFER_STORE='pendingChatTransfers';
let pendingTransferWriteQueue=Promise.resolve();
function pendingTransferKey(record) {
  return normalizeServer(record.server||DEFAULT_SERVER)+'|'+record.agentId;
}
async function pendingChatTransfers() {
  await adminStorageProtected;
  return (await chrome.storage.local.get(PENDING_TRANSFER_STORE))[PENDING_TRANSFER_STORE]||{};
}
async function assertNoPendingTransfer(record) {
  if(record?.agentId && (await pendingChatTransfers())[pendingTransferKey(record)])
    throw Error('У агента незавершённый перенос. Подожди восстановления связи.');
}
async function updatePendingTransfers(mutator) {
  const op=pendingTransferWriteQueue.catch(()=>{}).then(async()=>{
    const current=await pendingChatTransfers();
    const next={...current};
    const result=mutator(next);
    await chrome.storage.local.set({[PENDING_TRANSFER_STORE]:next});
    return result;
  });
  pendingTransferWriteQueue=op.catch(()=>{});
  return op;
}
async function savePendingTransfer(pending) {
  return updatePendingTransfers(records=>{
    if(records[pending.key]) throw Error('Перенос агента уже ожидает восстановления.');
    records[pending.key]=pending;
  });
}
async function clearPendingTransfer(key,transferId) {
  return updatePendingTransfers(records=>{
    if(records[key]?.transferId===transferId) delete records[key];
  });
}
function transferBase(pending) {
  return '/api/v1/admin/agents/'+encodeURIComponent(pending.agentId);
}
async function finalizePendingTransfer(pending) {
  const {from,to,next,agentId,key,transferId}=pending;
  const updated=await updateRecords(entries=>{
    const source=entries[from];
    const destination=entries[to];
    if(destination?.agentId===agentId &&
       destination.chatCredentialId===transferId) return {...destination};
    if(destination || !source || source.agentId!==agentId ||
       (source.chatCredentialId||null)!==(pending.sourceTokenId||null))
      throw Error('Невозможно восстановить перенос: локальная привязка изменилась.');
    const moved={...next,active:true,bootstrapDone:true,bootstrapMigrated:true};
    delete entries[from];
    entries[to]=moved;
    return {...moved};
  });
  await clearPendingTransfer(key,transferId);
  return updated;
}
function isForeignChatLease(pending,binding) {
  return binding?.agent_id===pending.agentId &&
    typeof binding.token_id==='string' && !!binding.token_id &&
    binding.token_id!==pending.sourceTokenId &&
    binding.token_id!==pending.transferId &&
    typeof binding.chat_url==='string' &&
    chatKey(binding.chat_url)===binding.chat_url;
}
async function forgetRetiredLocalTransfer(pending) {
  // An administrator revoked the old lease or moved it to another browser.
  // Never activate A or touch the new server-side lease (C).
  await updateRecords(entries=>{
    const source=entries[pending.from];
    if(source?.agentId===pending.agentId &&
       (source.chatCredentialId||null)===(pending.sourceTokenId||null))
      delete entries[pending.from];
  });
  await disableSchedule({server:pending.server,agentId:pending.agentId});
  await clearPendingTransfer(pending.key,pending.transferId);
  return {status:'retired'};
}
async function legacySourceStillValid(pending) {
  const source=(await storage())[pending.from];
  if(!source?.token || source.agentId!==pending.agentId ||
     source.chatCredentialId || !pending.legacyPrimary) return false;
  let response;
  try {
    response=await fetch(pending.server+'/api/v1/agents/hud',{
      method:'GET',cache:'no-store',signal:AbortSignal.timeout(8000),
      headers:{Accept:'application/json','X-Agent-Id':source.agentId,
               'X-Agent-Token':source.token},
    });
  } catch {
    // An unavailable server is NOT evidence that the primary token was
    // revoked. Leave the pending transfer inert for the next retry.
    throw Error('Не удалось проверить старый основной токен; повторим позже.');
  }
  if(response.status===401 || response.status===403) return false;
  if(!response.ok)
    throw Error('Сервер не подтвердил состояние старого токена (HTTP '+
      response.status+').');
  const snapshot=await response.json();
  if(!snapshot.agents?.some(a=>a.agent_id===source.agentId &&
                               a.name===source.name))
    throw Error('Неоднозначная идентичность агента при восстановлении.');
  return true;
}
async function restoreSourceAfterAbort(pending) {
  await updateRecords(entries=>{
    const source=entries[pending.from];
    if(source?.agentId===pending.agentId &&
       (source.chatCredentialId||null)===(pending.sourceTokenId||null))
      // A legacy permanent primary may still authenticate after C binds.
      // Never auto-resume its PUSH after a failed migration: the user can
      // retry migration, while there is no duplicate background wake.
      source.active=pending.legacyPrimary?false:pending.sourceWasActive;
  });
  await clearPendingTransfer(pending.key,pending.transferId);
  return {status:'rolled_back'};
}
async function resolveAfterTransferAbort(pending,admin) {
  // DELETE may race POST commit or a separate admin rebind. Its 200 response
  // alone (even aborted:true) does not prove the active lease is still A.
  // Stage is definitely absent by now; the fresh authoritative GET decides.
  const binding=await adminRequest(pending.server,admin,
    transferBase(pending)+'/chat-binding');
  if(binding?.agent_id!==pending.agentId)
    throw Error('Сервер вернул неверную идентичность после отмены переноса.');
  if(binding.token_id===pending.transferId && binding.chat_url===pending.to)
    return {status:'committed',record:await finalizePendingTransfer(pending)};
  if(pending.recoveryStaleSource) {
    // The original browser token was invalid even before migration.
    // Its local record must NEVER be reactivated after an aborted commit.
    if((binding.token_id===null && binding.chat_url===null) ||
       (typeof binding.token_id==='string' && !!binding.token_id &&
        typeof binding.chat_url==='string' &&
        chatKey(binding.chat_url)===binding.chat_url))
      return forgetRetiredLocalTransfer(pending);
    throw Error('Некорректная серверная привязка после восстановления.');
  }
  if(binding.token_id===pending.sourceTokenId &&
     binding.chat_url===pending.from)
    return restoreSourceAfterAbort(pending);
  if(binding.token_id===null && binding.chat_url===null) {
    // Legacy A has no scoped server lease until commit. After a confirmed
    // abort, its primary credential may still be valid. Preserve it only
    // when the server independently authenticates the OLD primary bearer.
    if(pending.legacyPrimary && await legacySourceStillValid(pending))
      return restoreSourceAfterAbort(pending);
    return forgetRetiredLocalTransfer(pending);
  }
  if(isForeignChatLease(pending,binding))
    return forgetRetiredLocalTransfer(pending);
  throw Error('Неоднозначная новая привязка агента; восстановление отложено.');
}
async function rollbackPendingTransfer(pending,admin) {
  await adminRequest(pending.server,admin,
    transferBase(pending)+'/chat-transfers/'+
      encodeURIComponent(pending.transferId),'DELETE');
  return resolveAfterTransferAbort(pending,admin);
}
async function discardRevokedPendingTransfer(pending,admin,agentDeleted=false) {
  if(agentDeleted) return forgetRetiredLocalTransfer(pending);
  await adminRequest(pending.server,admin,
    transferBase(pending)+'/chat-transfers/'+
      encodeURIComponent(pending.transferId),'DELETE');
  return resolveAfterTransferAbort(pending,admin);
}
async function reconcilePendingTransfer(pending,admin) {
  let binding;
  try {
    binding=await adminRequest(pending.server,admin,
      transferBase(pending)+'/chat-binding');
  } catch(error) {
    if(error.status===404 && String(error.message).includes('Unknown agent_id'))
      return discardRevokedPendingTransfer(pending,admin,true);
    throw error;
  }
  if(binding?.agent_id!==pending.agentId)
    throw Error('Сервер вернул неверную идентичность при восстановлении.');
  if(binding.token_id===pending.transferId && binding.chat_url===pending.to)
    return {status:'committed',record:await finalizePendingTransfer(pending)};
  if(pending.recoveryStaleSource) {
    if((binding.token_id===null && binding.chat_url===null) ||
       (typeof binding.token_id==='string' && !!binding.token_id &&
        typeof binding.chat_url==='string' &&
        chatKey(binding.chat_url)===binding.chat_url))
      return discardRevokedPendingTransfer(pending,admin);
    throw Error('Некорректная серверная привязка при восстановлении.');
  }
  if(binding.token_id===pending.sourceTokenId &&
     binding.chat_url===pending.from)
    return rollbackPendingTransfer(pending,admin);
  if(binding.token_id===null && binding.chat_url===null) {
    if(pending.legacyPrimary)
      return rollbackPendingTransfer(pending,admin);
    return discardRevokedPendingTransfer(pending,admin);
  }
  if(isForeignChatLease(pending,binding))
    return discardRevokedPendingTransfer(pending,admin);
  throw Error('Серверная привязка изменилась; автоматическое восстановление остановлено.');
}
let pendingRecoveryPromise=null;
async function recoverPendingTransfers() {
  if(pendingRecoveryPromise) return pendingRecoveryPromise;
  const work=(async()=>{
    const all=await pendingChatTransfers();
    for(const pending of Object.values(all)) {
      if(!pending?.key || migratingKeys.has(pending.from)) continue;
      try {
        const admin=await adminToken(pending.server);
        if(!admin) continue;
        await reconcilePendingTransfer(pending,admin);
      } catch(error) {
        console.warn('Agent Network: pending transfer still unresolved:',
                     String(error.message||error));
      }
    }
  })();
  pendingRecoveryPromise=work;
  try {await work;}
  finally {if(pendingRecoveryPromise===work) pendingRecoveryPromise=null;}
}
async function migrateAgent(tabId,expectedAgentId,fromChatUrl,expectedDestination,
                            expectedServerTokenId=undefined,
                            expectedServerChatUrl=undefined,
                            allowTakeover=false) {
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
  if((await pendingChatTransfers())[pendingTransferKey(old)])
    throw Error('У агента есть незавершённый перенос. Дождись восстановления.');
  const admin=await adminToken(server);
  if(!admin) throw Error('Для переноса агента настрой admin-token в расширении.');
  const binding=await adminRequest(server,admin,
    '/api/v1/admin/agents/'+encodeURIComponent(old.agentId)+'/chat-binding');
  if(binding.agent_id!==old.agentId)
    throw Error('Сервер вернул неправильную привязку агента.');
  if(expectedServerTokenId!==undefined &&
     (expectedServerTokenId!==binding.token_id ||
      expectedServerChatUrl!==binding.chat_url))
    throw Error('Привязка агента изменилась после подтверждения. Повтори перенос.');
  const remoteTakeover=!!binding.chat_url && binding.chat_url!==fromChatUrl;
  if(remoteTakeover && (!allowTakeover ||
       expectedServerTokenId!==binding.token_id ||
       expectedServerChatUrl!==binding.chat_url))
    throw Error('Агент уже работает в другом чате: '+binding.chat_url+
      '. Сначала подтверди перенос именно из этого чата.');
  const oldTokenValid=await verifyMigrationAgent(server,old);
  const useAdminRecovery=!oldTokenValid ||
    binding.token_id!==(old.chatCredentialId||null) ||
    (binding.token_id!==null && binding.chat_url!==fromChatUrl);
  let authoritativeAgent=null;
  if(useAdminRecovery) {
    // Admin authentication (not a stale or misbound agent token) is the permission
    // required to recover an existing agent. Never create another identity.
    const catalogue=await adminRequest(server,admin,'/api/v1/admin/agents');
    authoritativeAgent=catalogue.items?.find(agent=>
      agent.agent_id===old.agentId && agent.kind==='chatgpt');
    if(!authoritativeAgent)
      throw Error('Агент больше не найден на сервере. Выбери другого.');
    // The old bearer has already been rejected by the server. Do not keep
    // pretending its PUSH channel is healthy while recovering the binding.
    disconnect(old.ownerTabId);
    await updateRecords(entries=>{
      if(entries[fromChatUrl]?.agentId===old.agentId &&
         entries[fromChatUrl]?.token===old.token)
        entries[fromChatUrl].active=false;
    });
  }

  // Before a new ChatGPT conversation has a /c/ URL, create it with a
  // completely secret-free message. Do not bootstrap the old bearer.
  if(!targetKey) {
    const created=await askTab(tabId,{
      type:'agent:send',
      text:'Agent Network: подготовка беседы для переноса агента. '+
        'Ожидай отдельного сообщения с новыми инструкциями.',
      url:tab.url,allowNewChat:true,
    });
    if(!created?.ok)
      throw Error('Не удалось создать новый чат: '+(created?.error||'unknown'));
    const destination=await waitForConversation(tabId,tab.url);
    targetKey=destination.key;
    await waitForChatIdle(tabId,targetKey);
  }
  const destinationBefore=await conversationTab(tabId,targetKey);
  if(targetKey===fromChatUrl || (await storage())[targetKey])
    throw Error('Целевая беседа изменилась или уже содержит агента.');

  migratingKeys.add(fromChatUrl);
  disconnect(old.ownerTabId);
  let prepared=null;
  let committed=false;
  let commitPending=false;
  try {
    // Stage B's new bearer ONLY after the server validates the destination
    // is not occupied. A still owns its old token until commit.
    prepared=await adminRequest(server,admin,
      '/api/v1/admin/agents/'+encodeURIComponent(old.agentId)+'/chat-transfers',
      'POST',{source_token_id:useAdminRecovery?'':(old.chatCredentialId||''),
              old_chat_url:fromChatUrl,new_chat_url:targetKey,
              ...(!useAdminRecovery && !old.chatCredentialId
                ?{legacy_primary_token:old.token}:{}),
              admin_recovery:useAdminRecovery,
              expected_source_token_id:binding.token_id,
              expected_source_chat_url:binding.chat_url});
    if(prepared.agent_id!==old.agentId || !prepared.transfer_id ||
       !prepared.token || prepared.token_id!==prepared.transfer_id ||
       prepared.chat_url!==targetKey)
      throw Error('Сервер вернул неверный подготовленный перенос.');
    const next={
      ...old,
      ...(authoritativeAgent ? {
        name:authoritativeAgent.name,role:authoritativeAgent.role,
        purpose:authoritativeAgent.purpose,
        description:authoritativeAgent.description,
        teams:authoritativeAgent.teams,
      } : {}),
      token:prepared.token,chatCredentialId:prepared.transfer_id,
      chatUrl:targetKey,ownerTabId:Number(tabId),
      active:false,bootstrapDone:false,bootstrapMigrated:true,
    };
    // Staged bearer is NOT authorized by Store.verify until commit.
    // Any failed/ambiguous send can be aborted without revoking A.
    const sent=await askTab(tabId,{
      type:'agent:send',text:bootstrapPrompt(next,true),
      url:destinationBefore.url,allowNewChat:false,
    });
    if(!sent?.ok)
      throw Error('Новый чат не принял инициализацию: '+(sent?.error||'unknown'));
    await conversationTab(tabId,targetKey);
    if((await storage())[targetKey])
      throw Error('Целевая беседа уже занята во время переноса.');

    const pending={
      key:pendingTransferKey(old),server,agentId:old.agentId,
      transferId:prepared.transfer_id,sourceTokenId:old.chatCredentialId||null,
      legacyPrimary:!useAdminRecovery && !old.chatCredentialId,
      recoveryStaleSource:useAdminRecovery,
      from:fromChatUrl,to:targetKey,
      next:{...next,active:true,bootstrapDone:true},
      sourceWasActive:!!old.active,
    };
    // Persist before POST commit so an ambiguous result cannot resurrect
    // A's revoked token. The new token stays extension-local until recovery.
    await savePendingTransfer(pending);
    commitPending=true;
    await updateRecords(entries=>{
      const current=entries[fromChatUrl];
      if(!current || current.agentId!==old.agentId ||
         (current.chatCredentialId||null)!==(old.chatCredentialId||null) ||
         current.token!==old.token)
        throw Error('Привязка агента изменилась перед подтверждением переноса.');
      current.active=false;
    });
    const base=transferBase(pending);
    let outcome;
    try {
      const result=await adminRequest(server,admin,
        base+'/chat-transfers/'+encodeURIComponent(prepared.transfer_id)+'/commit',
        'POST');
      if(result.agent_id!==old.agentId || result.token_id!==next.chatCredentialId ||
         result.chat_url!==targetKey || result.status!=='committed')
        throw Error('Сервер вернул неверное подтверждение переноса.');
      outcome={status:'committed',record:await finalizePendingTransfer(pending)};
    } catch(error) {
      try {outcome=await reconcilePendingTransfer(pending,admin);}
      catch {
        // The server may have committed. Keep the durable record, and keep
        // source PUSH disabled until metadata reconciliation becomes possible.
        throw Error('Результат переноса неизвестен. Привязка временно '+
          'заблокирована, будет восстановлена при подключении к серверу.');
      }
      if(outcome.status==='rolled_back') throw error;
    }
    if(outcome.status!=='committed')
      throw Error('Перенос не подтверждён сервером.');
    committed=true;
    const updated=outcome.record;
    let connectionWarning='';
    try { await connect(tabId,updated); }
    catch(error) {
      connectionWarning='PUSH сейчас недоступен: '+String(error.message||error);
    }
    return {migrated:true,agentId:updated.agentId,name:updated.name,
            fromChatUrl,toChatUrl:targetKey,
            connected:!!connections.get(Number(tabId)),connectionWarning};
  } finally {
    migratingKeys.delete(fromChatUrl);
    if(!committed && !commitPending) {
      if(prepared?.transfer_id) {
        try {
          await adminRequest(server,admin,
            '/api/v1/admin/agents/'+encodeURIComponent(old.agentId)+
            '/chat-transfers/'+encodeURIComponent(prepared.transfer_id),'DELETE');
        } catch(error) {
          console.warn('Transfer abort failed; inactive credential will expire:',
                       String(error.message||error));
        }
      }
      await resumeAll(); // Rejected pre-commit migration keeps A operational.
    }
    // Once a commit may have occurred, NEVER blindly revive A's old token.
    // A confirmed rollback clears the durable record, so it is safe to
    // reconnect A only after the in-flight migration flag is removed.
    if(!committed && commitPending &&
       !(await pendingChatTransfers())[pendingTransferKey(old)])
      await resumeAll();
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
async function conversationTab(tabId, expectedKey) {
  const tab = await chrome.tabs.get(Number(tabId)).catch(() => null);
  if (!tab || chatKey(tab.url) !== expectedKey)
    throw Error('Чат изменился во время регистрации. Вернитесь в исходную беседу и повторите Старт.');
  return tab;
}

async function registerConversation(tabId, profile) {
  const {key,record:old}=await currentRecord(tabId);
  if (!key) throw Error('Conversation changed; open the ChatGPT conversation again');
  const server=await serverForTab(tabId,old);
  await assertNoPendingTransfer(old);
  const wasActive=!!old?.active;
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
      record={...record,...profile};
    } catch(error) {
      if(error.status===400 && String(error.message).includes('Unknown agent_id')) {
        disconnect(record.ownerTabId);
        record=null; // server expired/deleted this identity
      } else throw error;
    }
  }
  if (!record) {
    const secret=await adminToken(server);
    if(!secret)
      throw Error('Для привязки агента сначала авторизуй admin-token в расширении.');
    if(profile.agentId) {
      if(Object.values(await storage()).some(other=>
        other.agentId===profile.agentId && (other.server||DEFAULT_SERVER)===server))
        throw Error('Агент уже привязан к другому чату. Используй перенос.');
      const result=await adminRequest(
        server,secret,'/api/v1/admin/agents/'+encodeURIComponent(profile.agentId)+
        '/chat-credentials','POST',{chat_url:key,replace_existing:profile.rebind===true}
      );
      if(result.agent_id!==profile.agentId || !result.token_id ||
         !result.token || result.agent?.agent_id!==profile.agentId)
        throw Error('Сервер вернул неверную идентичность агента.');
      record={
        name:result.agent.name,role:result.agent.role,
        purpose:result.agent.purpose,description:result.agent.description,
        kind:result.agent.kind,teams:result.agent.teams,
        agentId:result.agent_id,token:result.token,chatCredentialId:result.token_id,
        chatUrl:key,ownerTabId:null,server,active:false,bootstrapDone:false,
        bootstrapMigrated:false,
      };
    } else {
      // Never inject a newly-created agent's permanent primary token into
      // ChatGPT. The server creates identity + scoped chat credential together.
      const result=await adminRequest(server,secret,'/api/v1/admin/chatgpt-agents',
                                     'POST',{...profile,chat_url:key});
      if(!result.agent?.agent_id || result.agent.kind!=='chatgpt' ||
         !result.token || !result.token_id)
        throw Error('Сервер не выдал токен привязки нового агента.');
      record={
        name:result.agent.name,role:result.agent.role,
        purpose:result.agent.purpose,description:result.agent.description,
        kind:'chatgpt',teams:result.agent.teams,
        agentId:result.agent.agent_id,token:result.token,chatCredentialId:result.token_id,
        chatUrl:key,ownerTabId:null,server,active:false,bootstrapDone:false,
        bootstrapMigrated:false,
      };
    }
    created=true;
  }

  // Persist a newly issued identity before any further awaits, but do not
  // activate it until the bootstrap was delivered to its original conversation.
  // Failed or abandoned registration can then be safely resumed on next Start.
  try {
    await conversationTab(tabId,key);
  } catch(error) {
    if(created) await updateRecords(entries=>{
      if(!entries[key] || entries[key].agentId===old?.agentId)
        entries[key]={...record,active:false,ownerTabId:null,bootstrapDone:false};
    });
    throw error;
  }

  await updateRecords(entries=>{
    if(old && entries[key]?.agentId!==old.agentId)
      throw Error('Agent binding changed during registration');
    if(!old && entries[key])
      throw Error('Conversation was bound to another agent during registration');
    entries[key]={
      ...record,active:wasActive && !created,
      ownerTabId:wasActive && !created ? old.ownerTabId : null,
    };
  });

  try {
    if (!record.bootstrapDone) {
      const tab=await conversationTab(tabId,key);
      const sent=await askTab(tabId,{
        type:'agent:send',text:bootstrapPrompt(record,record.bootstrapMigrated===true),url:tab.url,
      });
      if(!sent?.ok)
        throw Error('Registered, but initialization prompt was not sent: '+(sent?.error||'unknown'));
      await conversationTab(tabId,key); // Navigation can happen while send() awaits.
      record={...record,bootstrapDone:true};
      await updateRecords(entries=>{
        if(entries[key]?.agentId!==record.agentId)
          throw Error('Agent binding changed during bootstrap');
        entries[key].bootstrapDone=true;
      });
    }

    await conversationTab(tabId,key);
    record=await updateRecords(entries=>{
      if(entries[key]?.agentId!==record.agentId)
        throw Error('Agent binding changed during activation');
      entries[key].active=true;
      if(!wasActive || created) entries[key].ownerTabId=Number(tabId);
      return {...entries[key]};
    });
    await connect(tabId,record);
    await conversationTab(tabId,key);
    return {agentId:record.agentId,name:record.name,created:created&&!profile.agentId,linked:!!profile.agentId};
  } catch(error) {
    if(!wasActive || created) {
      // Do not leave an uninitialized or abandoned agent active. In
      // particular, a late send response must never resurrect a moved tab.
      await updateRecords(entries=>{
        if(entries[key]?.agentId!==record.agentId) return;
        entries[key].active=false;
        entries[key].ownerTabId=null;
      });
      disconnect(tabId);
    }
    throw error;
  }
}
async function updateToken(tabId, replacement) {
  const {key,record}=await currentRecord(tabId);
  if (!key || !record?.agentId)
    throw Error('Этот чат не привязан к агенту.');
  await assertNoPendingTransfer(record);
  if (typeof replacement !== 'string' || replacement.length < 20 || replacement.length > 512)
    throw Error('Некорректный токен.');
  const tab=await conversationTab(tabId,key);
  const server=record.server || await serverForTab(tabId,record);
  const response=await fetch(server+'/api/v1/agents/hud',{
    method:'GET',cache:'no-store',signal:AbortSignal.timeout(8000),
    headers:{
      'Accept':'application/json',
      'X-Agent-Id':record.agentId,
      'X-Agent-Token':replacement,
    },
  });
  if(!response.ok)throw Error('Новый токен не прошёл проверку для этого агента.');
  const result=await response.json();
  if(!result.agents?.some(agent=>agent.agent_id===record.agentId &&
                             agent.name===record.name))
    throw Error('Токен не соответствует привязанному агенту.');
  await conversationTab(tabId,key);
  if(replacement===record.token) return {updated:false,agentId:record.agentId};
  // A manual credential replacement must not leave the old chat token live.
  await revokeChatCredential(record);
  const updated=await updateRecords(entries=>{
    if(entries[key]?.agentId!==record.agentId ||
       entries[key]?.token!==record.token)
      throw Error('Привязка агента изменилась.');
    entries[key].token=replacement;
    delete entries[key].chatCredentialId;
    return {...entries[key]};
  });
  // Replace the old PUSH connection immediately. No token is ever returned
  // through runtime messages to content scripts or ChatGPT page code.
  disconnect(updated.ownerTabId ?? tabId);
  if(updated.active) await connect(tabId,updated);
  return {updated:true,agentId:record.agentId};
}

async function repeatBootstrap(tabId) {
  const {key,record}=await currentRecord(tabId);
  if (!key || !record?.agentId || !record?.token)
    throw Error('Этот чат не привязан к агенту. Сначала нажмите Старт.');
  await assertNoPendingTransfer(record);
  const tab=await conversationTab(tabId,key);
  const result=await askTab(tabId,{
    // Reuse the original bootstrap variant for the bound conversation:
    // migrated chats must retain their read_context restoration instructions.
    type:'agent:send',text:bootstrapPrompt(record,record.bootstrapMigrated===true),url:tab.url,
  });
  if (!result?.ok) throw Error(result?.error || 'Не удалось отправить инструкции');
  const latest=(await storage())[key];
  await conversationTab(tabId,key);
  if(!latest || latest.agentId!==record.agentId)
    throw Error('Привязка агента изменилась во время отправки.');
  // A manual reminder is not a new registration and does not modify agent
  // credentials, conversation ownership or bootstrapDone state.
  return {sent:true,agentId:record.agentId};
}
async function stopAgent(tabId) {
  const {key,record}=await currentRecord(tabId);
  if (!record || !key) return {stopped:true};
  await assertNoPendingTransfer(record);
  await updateRecords(records=>{
    if(records[key]?.agentId===record.agentId) records[key].active=false;
  });
  disconnect(record.ownerTabId);
  return {stopped:true};
}
// Entire scheduling feature is local to Chrome. No Notion or task-server API.
const SCHEDULE_PREFIX='agent-network-schedule:';
const SCHEDULE_INTERVALS=[5,15,30,60];
const SCHEDULE_STORE='agentSchedulesById';
let scheduleQueue=Promise.resolve();
function scheduleLocked(action) {
  const operation=scheduleQueue.catch(()=>{}).then(action);
  scheduleQueue=operation.catch(()=>{});
  return operation;
}
async function agentSchedules() {
  return (await chrome.storage.local.get(SCHEDULE_STORE))[SCHEDULE_STORE] || {};
}
const scheduleKey=record=>normalizeServer(record.server||DEFAULT_SERVER)+'|'+record.agentId;
const scheduleAlarm=key=>SCHEDULE_PREFIX+key;
async function disableSchedule(record) {
  const key=scheduleKey(record);
  return scheduleLocked(async()=>{
    const schedules=await agentSchedules();
    if(schedules[key]) {
      schedules[key]={...schedules[key],enabled:false};
      await chrome.storage.local.set({[SCHEDULE_STORE]:schedules});
    }
    await chrome.alarms.clear(scheduleAlarm(key));
  });
}
async function getSchedule(tabId) {
  const {record}=await currentRecord(tabId);
  if(!record?.agentId) return {schedule:null};
  const schedules=await agentSchedules();
  return {schedule:schedules[scheduleKey(record)] || null};
}
async function saveSchedule(tabId, options) {
  const {record}=await currentRecord(tabId);
  if(!record?.agentId) throw Error('Сначала привяжите агента к чату.');
  await assertNoPendingTransfer(record);
  const enabled=options?.enabled===true;
  const intervalMinutes=Number(options?.intervalMinutes);
  const text=typeof options?.text==='string'?options.text.trim():'';
  if(!SCHEDULE_INTERVALS.includes(intervalMinutes))
    throw Error('Выберите допустимый интервал расписания.');
  if(text.length>4000 || (enabled && !text))
    throw Error('Введите текст пробуждения (максимум 4000 символов).');
  const key=scheduleKey(record);
  return scheduleLocked(async()=>{
    const schedules=await agentSchedules();
    const old=schedules[key] || {};
    const schedule={...old,enabled,intervalMinutes,text};
    schedules[key]=schedule;
    await chrome.storage.local.set({[SCHEDULE_STORE]:schedules});
    if(enabled)
      await chrome.alarms.create(scheduleAlarm(key),
        {delayInMinutes:intervalMinutes,periodInMinutes:intervalMinutes});
    else
      await chrome.alarms.clear(scheduleAlarm(key));
    return {schedule};
  });
}
async function scheduleOutcome(key,state,reason) {
  const at=Date.now();
  await scheduleLocked(async()=>{
    const schedules=await agentSchedules();
    if(!schedules[key]) return;
    schedules[key]={...schedules[key],lastAttempt:{at,state,reason}};
    await chrome.storage.local.set({[SCHEDULE_STORE]:schedules});
  });
}
async function runSchedule(key) {
  let state='skipped',reason='Расписание отключено';
  try {
    const schedules=await agentSchedules();
    const schedule=schedules[key];
    if(!schedule?.enabled) return {sent:false,reason};
    const entries=await storage();
    const match=Object.entries(entries).find(([,r])=>r.agentId && scheduleKey(r)===key);
    if(!match || !match[1].active || !match[1].bootstrapDone ||
       migratingKeys.has(match[0])) {
      reason='Агент не запущен или переносится';
    } else {
      const [key,record]=match;
      const tabs=await chrome.tabs.query({url:'https://chatgpt.com/*'}).catch(()=>[]);
      const owner=tabs.find(t=>t.id===record.ownerTabId && chatKey(t.url)===key)
        || tabs.find(t=>chatKey(t.url)===key);
      if(!owner) reason='Чат агента не открыт';
      else {
        await guardedWake(record.agentId,async()=>{
          const readiness=await probe(owner.id,record);
          if(readiness.state!=='idle')
            throw Error('Чат не готов: '+readiness.state);
          // Recheck configuration and identity after probe (which may await).
          const latest=(await agentSchedules())[scheduleKey(record)];
          const current=(await storage())[key];
          if(!latest?.enabled || current?.agentId!==record.agentId ||
             !current.active || !current.bootstrapDone || migratingKeys.has(key) ||
             current.token!==record.token ||
             scheduleKey(current)!==scheduleKey(record))
            throw Error('Расписание или привязка изменились');
          const tab=await chrome.tabs.get(owner.id);
          if(chatKey(tab?.url)!==key) throw Error('Чат изменился');
          const prompt=[
            '[Agent Network schedule]',
            'Agent name: '+current.name,
            'agent_id: '+current.agentId,
            'token: '+current.token,
            'Follow your permanent instructions. Keep your token private.',
            'Scheduled instruction:',
            latest.text,
          ].join('\n');
          const result=await askTab(owner.id,{
            type:'agent:send',text:prompt,url:tab.url,
          });
          if(!result?.ok) throw Error(result?.error||'Не удалось отправить сообщение');
          state='sent';
          reason='Пробуждение отправлено';
        });
      }
    }
  } catch(error) {
    reason=String(error.message||error).slice(0,180);
  }
  await scheduleOutcome(key,state,reason);
  return {sent:state==='sent',reason};
}
// Collapse overlapping manual/alarm invocations before the lifecycle lock.
const scheduleRunLocks=new Map();
function runScheduleExclusive(key) {
  const pending=scheduleRunLocks.get(key);
  if(pending) return Promise.resolve({sent:false,reason:'Пробуждение уже выполняется'});
  const operation=lifecycle(()=>runSchedule(key));
  scheduleRunLocks.set(key,operation);
  void operation.then(
    ()=>{if(scheduleRunLocks.get(key)===operation) scheduleRunLocks.delete(key);},
    ()=>{if(scheduleRunLocks.get(key)===operation) scheduleRunLocks.delete(key);}
  );
  return operation;
}
async function runScheduleNow(tabId) {
  const {record}=await currentRecord(tabId);
  if(!record?.agentId) throw Error('Сначала привяжите агента к чату.');
  return runScheduleExclusive(scheduleKey(record));
}
async function restoreSchedules() {
  return scheduleLocked(async()=>{
    const schedules=await agentSchedules();
    const records=Object.values(await storage()).filter(r=>r?.agentId);
    for(const [key,item] of Object.entries(schedules)) {
      if(key.includes('|')) continue;
      // Migrate v0.7 schedule keyed only by agentId to a server-scoped key.
      const owners=records.filter(r=>r.agentId===key);
      if(owners.length===1) {
        const scoped=scheduleKey(owners[0]);
        if(!schedules[scoped]) schedules[scoped]=item;
      }
      delete schedules[key];
      await chrome.alarms.clear(scheduleAlarm(key));
    }
    await chrome.storage.local.set({[SCHEDULE_STORE]:schedules});
    for(const [key,item] of Object.entries(schedules)) {
      if(!item?.enabled || !SCHEDULE_INTERVALS.includes(item.intervalMinutes)) continue;
      if(!records.some(r=>scheduleKey(r)===key)) {
        schedules[key]={...item,enabled:false};
        continue;
      }
      const name=scheduleAlarm(key);
      const existing=await chrome.alarms.get(name);
      if(!existing)
        await chrome.alarms.create(name,{
          delayInMinutes:item.intervalMinutes,periodInMinutes:item.intervalMinutes,
        });
    }
    await chrome.storage.local.set({[SCHEDULE_STORE]:schedules});
  });
}

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  (async () => {
    switch (message?.type) {
      case 'network:status': {
        const {key,record}=await currentRecord(message.tabId);
        const server=await serverForTab(message.tabId,record);
        // Destination URL is private to trusted popup; content scripts
        // receive no pending-transfer metadata.
        const pending=!sender?.tab && record?.agentId
          ? (await pendingChatTransfers())[pendingTransferKey(record)] : null;
        return {
          server,
          pendingTransfer:pending ? {toChatUrl:pending.to} : null,
          entry:record && {
            agentId:record.agentId,name:record.name,role:record.role,
            purpose:record.purpose,description:record.description,
            active:record.active,chatUrl:key,bootstrapDone:record.bootstrapDone,
            teams:record.teams || [],
          },
          connected:record ?
            connections.get(Number(record.ownerTabId))?.socket.readyState===WebSocket.OPEN : false,
          ui:record ? await probe(message.tabId,{...record,chatUrl:(await chrome.tabs.get(message.tabId)).url}) : null,
        };
      }
      case 'network:hud-status': return hudStatus(sender);
      case 'network:hud-preferences-get':
        return hudPreferences(sender,message.agentId);
      case 'network:hud-preferences-set':
        return hudPreferences(sender,message.agentId,message.pref);
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
      case 'network:schedule-get':
      case 'network:schedule-set':
      case 'network:schedule-run': {
        if(sender?.tab) throw Error('Расписание доступно только из popup.');
        if(message.type==='network:schedule-get') return getSchedule(message.tabId);
        if(message.type==='network:schedule-set')
          return saveSchedule(message.tabId,message.schedule);
        return runScheduleNow(message.tabId);
      }
      case 'network:available-agents':
        return lifecycle(()=>availableAgents(message.tabId,!sender?.tab));
      case 'network:admin-status':
      case 'network:admin-connect':
      case 'network:admin-clear':
      case 'network:admin-set-teams': {
        // Unprivileged page and content-script messages cannot use saved
        // administrator credentials. Only extension popup messages can.
        if(sender?.tab) throw Error('Admin operations are popup-only');
        if(message.type==='network:admin-status') return adminStatus(message.tabId);
        if(message.type==='network:admin-connect')
          return adminConnect(message.tabId,message.adminToken);
        if(message.type==='network:admin-clear') return adminClear(message.tabId);
        return adminSetTeams(message.tabId,message.teams);
      }
      case 'network:migration-preview':
        if(sender?.tab) throw Error('Перенос доступен только из popup.');
        return migrationPreview(message.tabId,message.name,message.agentId);
      case 'network:migrate':
        if(sender?.tab) throw Error('Перенос доступен только из popup.');
        return lifecycle(()=>migrateAgent(
          message.tabId,message.agentId,message.fromChatUrl,message.expectedDestination,
          message.expectedServerTokenId,message.expectedServerChatUrl,
          message.allowTakeover===true
        ));
      case 'network:unlink':
        if(sender?.tab) throw Error('Отвязка доступна только из popup.');
        return lifecycle(()=>unlinkAgent(message.tabId));
      case 'network:start':
        if(sender?.tab) throw Error('Привязка доступна только из popup.');
        return lifecycle(()=>startAgent(message.tabId,message.profile));
      case 'network:repeat-bootstrap': {
        if(sender?.tab) throw Error('Повторная инициализация доступна только из popup.');
        return lifecycle(()=>repeatBootstrap(message.tabId));
      }
      case 'network:update-token': {
        if(sender?.tab) throw Error('Обновление токена доступно только из popup.');
        return lifecycle(()=>updateToken(message.tabId,message.token));
      }
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
    await updateServerPreferences(data=>{
      delete data.serverByTab[tabId];
    });
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
  if(a.name === 'agent-network-resume') void resumeAll();
  if(a.name.startsWith(SCHEDULE_PREFIX))
    void runScheduleExclusive(a.name.slice(SCHEDULE_PREFIX.length));
});
chrome.runtime.onStartup.addListener(() => {
  void resumeAll();
  void restoreSchedules();
});
chrome.runtime.onInstalled.addListener(() => {
  void resumeAll();
  void restoreSchedules();
});
void resumeAll();
void restoreSchedules();
