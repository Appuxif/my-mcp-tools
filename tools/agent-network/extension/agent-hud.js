/* Floating Agent Network status HUD for a registered ChatGPT conversation.
   No conversation scraping, no MCP calls, no agent secrets in page DOM. */
(() => {
  if (globalThis.__agentNetworkHud) return;
  globalThis.__agentNetworkHud = true;

  const STORAGE_PREFIX = 'agentNetworkHud:';
  const POLL_MS = 12000;
  const ago = value => AgentNetworkStatus.ago(value);
  const labels = {
    idle:'Ожидает', busy:'Генерация', draft:'Черновик', unknown:'Неизвестно',
    working:'В работе', blocked:'Заблокирован', done:'Завершено',
    failed:'Ошибка', pending:'В очереди', acknowledged:'Получено'
  };

  let host = null;
  let shadow = null;
  let agentId = null;
  let boundChatUrl = '';
  let mode = 'full';
  let position = null;
  let dragging = null;
  let polling = false;
  let current = null;
  let viewerOpen = false;
  let viewerGeneration = 0;
  let viewerPeer = null;
  let viewerPeers = [];
  let viewerCursor = null;
  let viewerHasMore = false;
  let viewerLoading = false;
  const viewerMessageIds = new Set();

  const el = id => shadow?.getElementById(id);
  function text(id, value, title = '') {
    const node=el(id);
    if(!node) return;
    node.textContent=String(value ?? '');
    node.title=title;
  }

  function create() {
    if(host || !document.body) return;
    host=document.createElement('div');
    host.id='agent-network-hud';
    host.hidden=true;
    host.setAttribute('aria-label','Состояние агента Agent Network');
    shadow=host.attachShadow({mode:'closed'});
    const css=chrome.runtime.getURL('agent-hud.css');
    shadow.innerHTML=[
      '<link rel="stylesheet" href="'+css+'">',
      '<section class="card" aria-label="Agent Network">',
      '  <div id="drag-handle" class="header">',
      '    <div class="logo">◈</div>',
      '    <div class="identity">',
      '      <div class="eyebrow"><span id="dot" class="dot"></span> AGENT NETWORK</div>',
      '      <div id="name" class="name">Агент</div>',
      '    </div>',
      '    <div class="actions">',
      '      <button type="button" id="collapse" class="icon-button" aria-label="Свернуть" title="Свернуть">−</button>',
      '      <button type="button" id="hide" class="icon-button" aria-label="Скрыть в значок" title="Скрыть в значок">×</button>',
      '    </div>',
      '  </div>',
      '  <div class="body">',
      '    <div class="statusline">',
      '      <span id="ui-state" class="status-pill">Подключаюсь</span>',
      '      <span id="role" class="role"></span>',
      '    </div>',
      '    <div class="stats">',
      '      <div class="stat"><strong id="pending">—</strong><small>Входящая очередь</small></div>',
      '      <div class="stat"><strong id="sent">—</strong><small>Отправлено за 24 ч</small></div>',
      '    </div>',
      '    <div class="section-label">ПОСЛЕДНИЕ СООБЩЕНИЯ</div>',
      '    <div class="message out"><span class="arrow">↗</span>',
      '      <span id="last-out" class="message-name">Нет сообщений</span>',
      '      <span id="last-out-time" class="message-meta"></span>',
      '    </div>',
      '    <div class="message in"><span class="arrow">↙</span>',
      '      <span id="last-in" class="message-name">Нет сообщений</span>',
      '      <span id="last-in-time" class="message-meta"></span>',
      '    </div>',
      '    <div class="task"><span class="task-label">Задача</span>',
      '      <span id="task" class="task-text">—</span></div>',
      '    <div class="signals">',
      '      <div class="signal">MCP <strong id="mcp">—</strong></div>',
      '      <div class="signal">PUSH <strong id="push">—</strong></div>',
      '      <div class="signal">Статус <strong id="task-state">—</strong></div>',
      '      <div class="signal">Wake <strong id="wake">—</strong></div>',
      '    </div>',
      '    <div id="alert" class="alert" hidden></div>',
      '    <div class="footer">',
      '      <div class="footer-buttons">',
      '        <button type="button" id="messages" class="dashboard" title="Переписка этого агента">✉ Чаты</button>',
      '        <button type="button" id="dashboard" class="dashboard">↗ Дашборд</button>',
      '      </div>',
      '      <span id="updated" class="timestamp">Загрузка…</span>',
      '    </div>',
      '  </div>',
      '</section>',
      '<button type="button" id="restore" class="bubble" aria-label="Показать Agent Network"',
      '  title="Развернуть панель агента">◈',
      '  <span id="bubble-count" class="bubble-count" hidden></span>',
      '</button>',
      '<div id="chat-modal" class="hud-chat-modal" hidden>',
      '  <div id="chat-shade" class="hud-chat-shade"></div>',
      '  <section class="hud-chat-dialog" role="dialog" aria-modal="true" aria-labelledby="chat-title">',
      '    <div class="hud-chat-header">',
      '      <div><div class="hud-chat-overline">AGENT NETWORK · PRIVATE CHAT HISTORY</div>',
      '        <strong id="chat-title">Переписки агента</strong>',
      '        <div class="hud-chat-subtitle">Только диалоги этого агента · последние 24 часа</div>',
      '      </div>',
      '      <button type="button" id="chat-close" class="hud-chat-close" aria-label="Закрыть переписки">×</button>',
      '    </div>',
      '    <div class="hud-chat-layout">',
      '      <nav class="hud-chat-sidebar" aria-label="Собеседники">',
      '        <div class="hud-chat-side-title">Собеседники <span id="chat-peer-count">0</span></div>',
      '        <div id="chat-peers" class="hud-chat-peers">Загрузка…</div>',
      '      </nav>',
      '      <section class="hud-chat-thread" aria-label="История сообщений">',
      '        <div class="hud-chat-thread-head">',
      '          <strong id="chat-peer-title">Выберите собеседника</strong>',
      '          <button type="button" id="chat-refresh" class="hud-chat-refresh" disabled>↻ Обновить</button>',
      '        </div>',
      '        <div id="chat-scroll" class="hud-chat-scroll" tabindex="0" role="log" aria-live="off">',
      '          <button type="button" id="chat-older" class="hud-chat-older" hidden>Загрузить предыдущие</button>',
      '          <div id="chat-bubbles" class="hud-chat-bubbles"></div>',
      '        </div>',
      '        <div id="chat-info" class="hud-chat-info">Чтение без изменения ACK · TTL 24 ч</div>',
      '      </section>',
      '    </div>',
      '  </section>',
      '</div>'
    ].join('');
    document.body.appendChild(host);
    el('collapse').addEventListener('click', () =>
      changeMode(mode === 'collapsed' ? 'full' : 'collapsed'));
    el('hide').addEventListener('click', () => changeMode('icon'));
    el('restore').addEventListener('click', () => changeMode('full'));
    el('dashboard').addEventListener('click',async () => {
      try { await chrome.runtime.sendMessage({type:'network:hud-open-dashboard'}); }
      catch { text('updated','Не удалось открыть'); }
    });
    el('messages').addEventListener('click', () => void openViewer());
    el('chat-close').addEventListener('click', closeViewer);
    el('chat-shade').addEventListener('click', closeViewer);
    el('chat-refresh').addEventListener('click', () => {
      if (viewerPeer) void selectViewerPeer(viewerPeer);
    });
    el('chat-older').addEventListener('click', () => void loadViewerPage());
    el('chat-scroll').addEventListener('scroll', () => {
      if (viewerOpen && viewerHasMore && !viewerLoading &&
          el('chat-scroll').scrollTop <= 90) void loadViewerPage();
    });
    shadow.addEventListener('keydown', event => {
      if (!viewerOpen) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        closeViewer();
      } else if (event.key === 'Tab') {
        // Keep focus within the modal, not in ChatGPT's composer.
        const elements = [...el('chat-modal').querySelectorAll('button:not([disabled]):not([hidden])')];
        if (!elements.length) return;
        const first = elements[0], last = elements[elements.length - 1];
        if (event.shiftKey && shadow.activeElement === first) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && shadow.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      }
    });
    el('drag-handle').addEventListener('pointerdown',startDrag);
    window.addEventListener('pointermove',moveDrag);
    window.addEventListener('pointerup',endDrag);
    window.addEventListener('resize',clampPosition);
  }

  function appendChat(parent, tag, className, value) {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (value !== undefined) element.textContent = String(value);
    parent.append(element);
    return element;
  }

  function chatNotice(target, message) {
    target.replaceChildren();
    appendChat(target, 'div', 'hud-chat-empty', message);
  }

  function closeViewer() {
    if (!viewerOpen) return;
    viewerOpen = false;
    viewerGeneration++;
    viewerPeer = null;
    viewerPeers = [];
    viewerHasMore = false;
    viewerLoading = false;
    viewerMessageIds.clear();
    el('chat-modal').hidden = true;
    // Drop decrypted message text from the DOM on close or identity change.
    el('chat-bubbles').replaceChildren();
    el('chat-peers').replaceChildren();
    if (!host.hidden) el('messages').focus();
  }

  async function viewerRequest(type, fields = {}) {
    const response = await chrome.runtime.sendMessage({type, ...fields});
    if (!response?.ok) throw Error(response?.error || 'Не удалось получить историю');
    if (!viewerOpen || !agentId || response.agent_id !== agentId ||
        boundChatUrl !== location.href)
      throw Error('Агент или вкладка изменились');
    return response;
  }

  async function openViewer() {
    if (!host || host.hidden || !agentId || viewerOpen || location.href !== boundChatUrl)
      return;
    viewerOpen = true;
    const generation = ++viewerGeneration;
    viewerPeers = [];
    viewerPeer = null;
    viewerHasMore = false;
    el('chat-modal').hidden = false;
    text('chat-title', current?.name || 'Переписки агента');
    text('chat-peer-count', '0');
    text('chat-peer-title', 'Выберите собеседника');
    text('chat-info', 'Загрузка…');
    el('chat-older').hidden = true;
    el('chat-refresh').disabled = true;
    chatNotice(el('chat-peers'), 'Загрузка собеседников…');
    chatNotice(el('chat-bubbles'), 'Выберите собеседника слева.');
    el('chat-close').focus();
    try {
      const result = await viewerRequest('network:hud-conversations');
      if (!viewerOpen || viewerGeneration !== generation) return;
      viewerPeers = Array.isArray(result.items) ? result.items : [];
      text('chat-peer-count', viewerPeers.length);
      renderViewerPeers();
      if (viewerPeers.length) await selectViewerPeer(viewerPeers[0]);
      else {
        text('chat-info', 'За последние 24 часа сообщений нет');
        chatNotice(el('chat-bubbles'), 'Пока нет переписок с другими агентами.');
      }
    } catch (error) {
      if (viewerOpen && viewerGeneration === generation) {
        chatNotice(el('chat-peers'), String(error.message || error));
        text('chat-info', 'Ошибка загрузки списка');
      }
    }
  }

  function renderViewerPeers() {
    const container = el('chat-peers');
    container.replaceChildren();
    for (const peer of viewerPeers) {
      const button = appendChat(container, 'button', 'hud-chat-peer');
      button.type = 'button';
      button.setAttribute('aria-current', String(viewerPeer?.peer_id === peer.peer_id));
      appendChat(button, 'strong', '', peer.peer_name || 'Агент');
      const note = (peer.message_count || 0) + ' сообщ.' +
        (peer.pending_for_agent ? ' · ' + peer.pending_for_agent + ' в очереди' : '');
      appendChat(button, 'small', '', note);
      button.addEventListener('click', () => void selectViewerPeer(peer));
    }
  }

  function renderViewerBubble(message) {
    const outgoing = message.sender_id === agentId;
    const bubble = document.createElement('article');
    bubble.className = 'hud-chat-message' + (outgoing ? ' outgoing' : ' incoming');
    const heading = appendChat(bubble, 'div', 'hud-chat-msg-head');
    appendChat(heading, 'strong', '', message.sender_name || 'Агент');
    appendChat(heading, 'time', '',
      new Date(Number(message.created_at) * 1000).toLocaleString('ru-RU'));
    // Message bodies are untrusted: never parse as HTML or Markdown.
    appendChat(bubble, 'div', 'hud-chat-msg-body', message.body || '');
    appendChat(bubble, 'div', 'hud-chat-msg-status',
      message.status === 'acknowledged' ? '✓ Получено' :
      message.status === 'pending' ? '◷ Ожидает получения' : '—');
    return bubble;
  }

  async function selectViewerPeer(peer) {
    if (!viewerOpen || !viewerPeers.some(p => p.peer_id === peer.peer_id)) return;
    viewerPeer = peer;
    viewerCursor = null;
    viewerHasMore = true;
    viewerLoading = false;
    viewerMessageIds.clear();
    viewerGeneration++;
    text('chat-peer-title', peer.peer_name || 'Агент');
    text('chat-info', 'Загрузка истории…');
    el('chat-older').hidden = true;
    el('chat-refresh').disabled = false;
    chatNotice(el('chat-bubbles'), 'Загрузка…');
    renderViewerPeers();
    await loadViewerPage(true);
  }

  async function loadViewerPage(initial = false) {
    if (!viewerOpen || !viewerPeer || viewerLoading || (!initial && !viewerHasMore)) return;
    const generation = viewerGeneration;
    viewerLoading = true;
    const peerId = viewerPeer.peer_id;
    const before = initial ? '' : viewerCursor;
    const scroll = el('chat-scroll');
    const bubbles = el('chat-bubbles');
    const previousHeight = scroll.scrollHeight;
    const previousTop = scroll.scrollTop;
    const older = el('chat-older');
    older.disabled = true;
    try {
      const data = await viewerRequest('network:hud-messages', {peerId, before, limit:30});
      if (!viewerOpen || generation !== viewerGeneration || data.peer_id !== peerId)
        return;
      if (initial) bubbles.replaceChildren();
      const nodes = [];
      for (const message of data.items || []) {
        if (viewerMessageIds.has(message.message_id)) continue;
        viewerMessageIds.add(message.message_id);
        nodes.push(renderViewerBubble(message));
      }
      if (initial) {
        bubbles.append(...nodes);
        if (!nodes.length) chatNotice(bubbles, 'Сообщений пока нет.');
        scroll.scrollTop = scroll.scrollHeight;
      } else {
        bubbles.prepend(...nodes);
        scroll.scrollTop = previousTop + scroll.scrollHeight - previousHeight;
      }
      viewerCursor = data.next_cursor || null;
      viewerHasMore = !!data.has_more;
      older.hidden = !viewerHasMore;
      text('chat-info', 'Только свои переписки · чтение без ACK · TTL 24 ч');
    } catch (error) {
      if (generation === viewerGeneration && viewerOpen) {
        text('chat-info', String(error.message || error));
        older.hidden = false; // allow retry
      }
    } finally {
      if (generation === viewerGeneration) {
        viewerLoading = false;
        older.disabled = false;
      }
    }
  }

  function clampPosition() {
    if(!host || !position) return;
    const width=mode === 'icon' ? 45 : mode === 'collapsed' ? 225 : 300;
    position={
      x:Math.min(Math.max(4,position.x),Math.max(4,innerWidth-width-4)),
      y:Math.min(Math.max(4,position.y),Math.max(4,innerHeight-54))
    };
    host.style.right='auto';
    host.style.left=position.x+'px';
    host.style.top=position.y+'px';
  }
  function startDrag(event) {
    if(event.button !== 0 || event.target.closest('button')) return;
    const rect=host.getBoundingClientRect();
    dragging={
      pointer:event.pointerId, clientX:event.clientX,clientY:event.clientY,
      left:rect.left,top:rect.top
    };
    event.preventDefault();
  }
  function moveDrag(event) {
    if(!dragging || event.pointerId !== dragging.pointer) return;
    position={
      x:dragging.left+event.clientX-dragging.clientX,
      y:dragging.top+event.clientY-dragging.clientY
    };
    clampPosition();
  }
  function endDrag(event) {
    if(!dragging || event.pointerId !== dragging.pointer) return;
    dragging=null;
    void savePreferences();
  }

  function changeMode(value,save=true) {
    mode=value;
    host.dataset.mode=value;
    text('collapse',value === 'collapsed' ? '▢' : '−');
    el('collapse').title=value === 'collapsed' ? 'Развернуть' : 'Свернуть';
    el('collapse').setAttribute('aria-label',el('collapse').title);
    clampPosition();
    if(save) void savePreferences();
  }
  async function loadPreferences(id) {
    try {
      const key=STORAGE_PREFIX+id;
      const pref=(await chrome.storage.local.get(key))[key] || {};
      if(id!==agentId) return;
      position=Number.isFinite(pref.x) && Number.isFinite(pref.y)
        ? {x:pref.x,y:pref.y} : null;
      changeMode(['full','collapsed','icon'].includes(pref.mode) ? pref.mode : 'full',false);
    } catch { /* preference is optional */ }
  }
  async function savePreferences() {
    if(!agentId) return;
    try {
      await chrome.storage.local.set({[STORAGE_PREFIX+agentId]:{
        mode,x:position?.x ?? null,y:position?.y ?? null
      }});
    } catch { /* preference is optional */ }
  }

  function message(prefix,value) {
    const peer=value?.peer || 'Нет сообщений';
    text('last-'+prefix,peer,peer);
    const delivery = prefix === 'out' && value?.status === 'acknowledged' ? ' · ✓' :
      prefix === 'out' && value?.status === 'pending' ? ' · ⏳' : '';
    text('last-'+prefix+'-time',value ? ago(value.time)+delivery : '');
    el('last-'+prefix+'-time').title=value?.status
      ? 'Доставка: '+(labels[value.status] || value.status)
      : value ? 'Статус доставки неизвестен' : '';
  }

  function draw(data) {
    current=data;
    text('name',data.name || 'Agent Network',data.name || '');
    const status=data.status;
    text('role',status?.role || '');
    const ui=data.active ? data.ui || 'unknown' : 'stopped';
    const badge=el('ui-state');
    badge.textContent= !data.active ? 'Остановлен' :
      data.error ? 'Нет связи' : labels[ui] || labels.unknown;
    badge.className='status-pill'+(!data.active || data.error ? ' off' :
      ui === 'busy' || ui === 'draft' ? ' warn' : '');
    el('dot').className='dot'+(data.connected ?
      ui === 'busy' ? ' busy' : ' online' : '');
    text('pending',status ? status.pending : '—');
    const unread=Number(status?.pending || 0);
    const counter=el('bubble-count');
    counter.textContent=unread>99 ? '99+' : String(unread);
    counter.hidden=!unread;
    text('sent',status ?
      (status.sentCountIsLowerBound ? '≥' : '')+status.sent24h : '—');
    message('out',status?.lastOutbound);
    message('in',status?.lastInbound);
    text('task',status?.task || 'Нет задачи',status?.task || '');
    text('task-state',status ? labels[status.taskStatus] || status.taskStatus : '—');
    const push=el('push');
    push.textContent=data.connected
      ? (labels[status?.adapter?.state] || status?.adapter?.state || 'Online')
      : 'Offline';
    push.className=data.connected ? 'good' : '';
    text('mcp',status ? ago(status.lastMcp) : '—');
    text('wake',status ? ago(status.lastWake) : '—');
    const alert=el('alert');
    alert.hidden=!data.error && !!status;
    if(!alert.hidden) alert.textContent=data.error
      ? 'Сервер недоступен' : 'Агент не найден на сервере. Проверьте регистрацию.';
    text('updated',data.updatedAt ? 'Обновлено '+ago(data.updatedAt/1000) : 'Загрузка…');
  }

  async function poll() {
    if(polling || document.hidden) return;
    if(!location.pathname.includes('/c/')) {
      if(host) { closeViewer(); host.hidden=true; }
      return;
    }
    polling=true;
    try {
      const response=await chrome.runtime.sendMessage({type:'network:hud-status'});
      if(!response?.ok || !response.visible || response.chatUrl !== location.href) {
        if(host) { closeViewer(); host.hidden=true; }
        return;
      }
      create();
      if(!host) return;
      if(response.agentId!==agentId) {
        closeViewer();
        agentId=response.agentId;
        position=null;
        mode='full';
        await loadPreferences(agentId);
      }
      if(location.href!==response.chatUrl) {
        closeViewer();
        host.hidden=true;
        return;
      }
      boundChatUrl=response.chatUrl;
      draw(response);
      host.hidden=false;
    } catch {
      if(host && current) {
        draw({...current,error:'Network unavailable',status:null,
              connected:false,updatedAt:Date.now()});
      }
    } finally { polling=false; }
  }

  function start() {
    void poll();
    setInterval(() => void poll(),12000);
    window.addEventListener('popstate',() => void poll());
    window.addEventListener('hashchange',() => void poll());
    document.addEventListener('visibilitychange',() => {
      if(!document.hidden) void poll();
    });
    // ChatGPT SPA pushState navigation may not dispatch popstate.
    setInterval(() => {
      if(host && boundChatUrl && location.href!==boundChatUrl) {
        closeViewer();
        host.hidden=true;
      }
    },1000);
  }
  if(document.readyState === 'loading')
    document.addEventListener('DOMContentLoaded',start,{once:true});
  else start();
})();
