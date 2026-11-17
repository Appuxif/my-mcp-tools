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
      '      <button type="button" id="dashboard" class="dashboard">↗ Дашборд</button>',
      '      <span id="updated" class="timestamp">Загрузка…</span>',
      '    </div>',
      '  </div>',
      '</section>',
      '<button type="button" id="restore" class="bubble" aria-label="Показать Agent Network"',
      '  title="Развернуть панель агента">◈',
      '  <span id="bubble-count" class="bubble-count" hidden></span>',
      '</button>'
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
    el('drag-handle').addEventListener('pointerdown',startDrag);
    window.addEventListener('pointermove',moveDrag);
    window.addEventListener('pointerup',endDrag);
    window.addEventListener('resize',clampPosition);
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
      if(host) host.hidden=true;
      return;
    }
    polling=true;
    try {
      const response=await chrome.runtime.sendMessage({type:'network:hud-status'});
      if(!response?.ok || !response.visible || response.chatUrl !== location.href) {
        if(host) host.hidden=true;
        return;
      }
      create();
      if(!host) return;
      if(response.agentId!==agentId) {
        agentId=response.agentId;
        position=null;
        mode='full';
        await loadPreferences(agentId);
      }
      if(location.href!==response.chatUrl) {
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
      if(host && boundChatUrl && location.href!==boundChatUrl)
        host.hidden=true;
    },1000);
  }
  if(document.readyState === 'loading')
    document.addEventListener('DOMContentLoaded',start,{once:true});
  else start();
})();
