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
async function serverForTab(tabId) {
  const data = await chrome.storage.local.get(['serverByTab', 'defaultServer']);
  return normalizeServer(data.serverByTab?.[tabId] || data.defaultServer || DEFAULT_SERVER);
}
async function setServer(tabId, raw) {
  const url = normalizeServer(raw);
  const entries = await storage();
  const old = entries[tabId];
  const before = await serverForTab(tabId);
  if (before !== url && old?.active) throw Error('Сначала останови агента, затем переключи сервер.');
  if (before !== url && old) {
    disconnect(tabId);
    delete entries[tabId]; // Never reuse the token on a different server.
    await save(entries);
  }
  const data = await chrome.storage.local.get('serverByTab');
  await chrome.storage.local.set({
    serverByTab: {...(data.serverByTab || {}), [tabId]:url},
    defaultServer:url,
  });
  return {server:url, changed:before!==url};
}
const connections = new Map(); // tabId -> { socket, interval }
// Short-lived shared snapshots: status panels do not poll once per agent/tab.
const dashboardCache = new Map();
async function cachedDashboard(server) {
  const current = dashboardCache.get(server);
  if (current && Date.now() - current.at < 4000) return current.promise;
  const promise = fetchJSON(server, '/api/v1/dashboard');
  dashboardCache.set(server, {at:Date.now(), promise});
  if (dashboardCache.size > 12) {
    dashboardCache.delete(dashboardCache.keys().next().value);
  }
  try { return await promise; }
  catch (error) {
    if (dashboardCache.get(server)?.promise === promise) dashboardCache.delete(server);
    throw error;
  }
}

const chatUrl = url => /^https:\/\/chatgpt\.com\/(?:.*\/)?c\/[^/?#]+/.test(url || '');
const storage = async () => (await chrome.storage.local.get('agentsByTab')).agentsByTab || {};
async function save(data) { await chrome.storage.local.set({ agentsByTab: data }); }
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
  if (!tab || tab.url !== record.chatUrl) return { state: 'unknown', reason: 'conversation changed' };
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
    const result = await askTab(tabId, {
      type: 'agent:send', text, url: record.chatUrl, wakeId: msg.wake_id,
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
  if (connections.has(Number(tabId))) return;
  if (!record.active) return;
  const tab = await chrome.tabs.get(Number(tabId)).catch(() => null);
  if (!tab || tab.url !== record.chatUrl || !chatUrl(tab.url)) return;
  const ws = new WebSocket(socketUrl(record.server || await serverForTab(tabId)));
  const connection = { socket: ws, interval: null };
  connections.set(Number(tabId), connection);
  ws.onopen = async () => {
    const state = await probe(tabId, record);
    ws.send(JSON.stringify({
      type: 'register', agent_id: record.agentId,
      token: record.token, kind: 'chatgpt', state: state.state || 'unknown',
    }));
    // Chrome MV3 (116+) keeps the worker alive with WebSocket traffic < 30 s.
    connection.interval = setInterval(() => void ping(tabId, record, ws).catch(() => {}), 20000);
  };
  ws.onmessage = e => {
    let msg;
    try { msg = JSON.parse(e.data); } catch { return; }
    if (msg.type === 'wake') void wake(tabId, record, ws, msg);
    else if (msg.type === 'error') {
      console.warn('Agent Network:', msg.error);
      if (String(msg.error).includes('Unknown agent_id')) {
        // The agent expired or was manually deleted. Require explicit Start
        // to register a fresh identity and send a new bootstrap prompt.
        void storage().then(async entries => {
          const latest = entries[tabId];
          if (latest?.agentId !== record.agentId) return;
          latest.active = false;
          latest.bootstrapDone = false;
          await save(entries);
        });
      }
    }
  };
  ws.onclose = () => {
    if (connection.interval) clearInterval(connection.interval);
    if (connections.get(Number(tabId)) === connection) connections.delete(Number(tabId));
  };
  ws.onerror = () => {}; // Reconnect via 1-minute alarm.
}
async function resumeAll() {
  const entries = await storage();
  for (const [tabId, record] of Object.entries(entries)) {
    try { await connect(Number(tabId), record); } catch { /* tab has gone away */ }
  }
}
async function hudStatus(sender) {
  // Content scripts must not access another tab's agent metadata.
  const tabId = sender?.tab?.id;
  if (tabId == null || sender.frameId !== 0 ||
      !chatUrl(sender.tab?.url)) return {visible:false};
  const entries = await storage();
  const record = entries[tabId];
  if (!record || record.chatUrl !== sender.tab.url) return {visible:false};

  const server = record.server || await serverForTab(tabId);
  const connected = connections.get(Number(tabId))?.socket.readyState === WebSocket.OPEN;
  const base = {
    visible:true, name:record.name, active:!!record.active, connected:!!connected,
    server, chatUrl:record.chatUrl, agentId:record.agentId
  };
  try {
    const [snapshot, ui] = await Promise.all([
      cachedDashboard(server),
      record.active ? probe(tabId, record).catch(() => null) : Promise.resolve(null)
    ]);
    return {
      ...base, updatedAt:Date.now(),
      status:AgentNetworkStatus.summarize(snapshot, record.agentId),
      ui:ui?.state || 'unknown', network:ui?.network || 'unknown',
    };
  } catch (error) {
    return {...base, updatedAt:Date.now(), status:null,
            ui:'unknown', network:'unknown',
            error:String(error.message || error).slice(0, 180)};
  }
}

async function hudOpenDashboard(sender) {
  const tabId = sender?.tab?.id;
  if (tabId == null || sender.frameId !== 0 || !chatUrl(sender.tab?.url))
    throw Error('Only ChatGPT tab agents can open their own dashboard');
  const record = (await storage())[tabId];
  if (!record || record.chatUrl !== sender.tab.url)
    throw Error('This conversation is not bound to an agent');
  await chrome.tabs.create({url:(record.server || await serverForTab(tabId)) + '/dashboard'});
  return {opened:true};
}

async function startAgent(tabId, profile) {
  const tab = await chrome.tabs.get(Number(tabId));
  if (!chatUrl(tab?.url)) throw Error('Open an existing ChatGPT conversation (not the homepage)');
  const server = await serverForTab(tabId);
  const entries = await storage();
  let record = entries[tabId];
  if (record && (record.server || DEFAULT_SERVER) !== server)
    throw Error('Agent belongs to a different server. Stop it and select the new server first.');
  if (record && record.chatUrl !== tab.url) {
    if (record.active) throw Error('Stop the old agent before binding another conversation.');
    record = {...record, chatUrl: tab.url, bootstrapDone: false};
  }
  if (record && record.name !== profile.name)
    throw Error('Agent name is immutable. Stop and create a new agent in a new chat.');
  let created = false;
  if (record) {
    try {
      await fetchJSON(server, '/api/v1/agents/profile', {
        agent_id: record.agentId, token: record.token,
        role: profile.role, purpose: profile.purpose, description: profile.description,
      });
      record = { ...record, ...profile, active: true };
    } catch (error) {
      if (error.status === 400 && String(error.message).includes('Unknown agent_id')) {
        disconnect(tabId);
        record = null; // expired/deleted identity; fresh registration below
      } else {
        throw error;
      }
    }
  }
  if (!record) {
    const result = await fetchJSON(server, '/api/v1/agents/register', {
      ...profile, kind: 'chatgpt',
    });
    record = {
      ...profile, agentId: result.agent.agent_id, token: result.token,
      chatUrl: tab.url, server, active: true, bootstrapDone: false,
    };
    created = true;
  }
  entries[tabId] = record;
  await save(entries);
  await connect(tabId, record);
  if (!record.bootstrapDone) {
    const bootstrap = [
      '[Agent Network identity — private credential]',
      'You are the registered agent named ' + record.name + '.',
      'Role: ' + record.role, 'Purpose: ' + record.purpose,
      'Description: ' + record.description,
      'Use the native agent-network MCP tools for ALL inter-agent messages.',
      'agent_id: ' + record.agentId,
      'token: ' + record.token,
      'Keep the token private. Use list_agents/get_messages/send_message/ack_message.',
      'Call get_messages now to check for pending work. Wake signals will arrive through this tab.',
    ].join('\n');
    const sent = await askTab(tabId, {
      type: 'agent:send', text: bootstrap, url: record.chatUrl,
    });
    if (!sent?.ok) throw Error('Registered, but initialization prompt was not sent: ' + (sent?.error || 'unknown'));
    record.bootstrapDone = true;
    entries[tabId] = record;
    await save(entries);
  }
  return { agentId: record.agentId, name: record.name, created };
}
async function stopAgent(tabId) {
  const entries = await storage();
  if (!entries[tabId]) return { stopped: true };
  entries[tabId].active = false;
  await save(entries);
  disconnect(tabId);
  return { stopped: true };
}
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  (async () => {
    switch (message?.type) {
      case 'network:status': {
        const entries = await storage();
        const tabId = message.tabId;
        const server = await serverForTab(tabId);
        const entry = entries[tabId] || null;
        return {
          server,
          entry: entry && {
            agentId: entry.agentId, name: entry.name, role: entry.role,
            purpose: entry.purpose, description: entry.description,
            active: entry.active, chatUrl: entry.chatUrl, bootstrapDone: entry.bootstrapDone,
          },
          connected: connections.get(Number(tabId))?.socket.readyState === WebSocket.OPEN,
          ui: entry ? await probe(tabId, entry) : null,
        };
      }
      case 'network:hud-status': return hudStatus(sender);
      case 'network:hud-open-dashboard': return hudOpenDashboard(sender);
      case 'network:start': return startAgent(message.tabId, message.profile);
      case 'network:stop': return stopAgent(message.tabId);
      case 'network:set-server': return setServer(message.tabId, message.server);
      case 'network:open-dashboard': {
        const server = await serverForTab(message.tabId);
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
    const entries = await storage();
    delete entries[tabId];
    await save(entries);
    const data = await chrome.storage.local.get('serverByTab');
    const servers = data.serverByTab || {};
    delete servers[tabId];
    await chrome.storage.local.set({serverByTab: servers});
  })();
});
chrome.tabs.onUpdated.addListener((tabId, changes) => {
  if (changes.url) {
    traffic.clear(tabId);
    void storage().then(entries => {
      if (entries[tabId] && entries[tabId].chatUrl !== changes.url)
        disconnect(tabId);
      else if (entries[tabId]) void connect(tabId, entries[tabId]);
    });
  }
});
chrome.alarms.create('agent-network-resume', { periodInMinutes: 1 });
chrome.alarms.onAlarm.addListener(a => {
  if (a.name === 'agent-network-resume') void resumeAll();
});
chrome.runtime.onStartup.addListener(() => void resumeAll());
chrome.runtime.onInstalled.addListener(() => void resumeAll());
void resumeAll();
