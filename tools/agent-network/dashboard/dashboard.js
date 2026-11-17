/* Dashboard consumes ONLY metadata. No tokens, headers or message contents. */
(() => {
  const $ = id => document.getElementById(id);
  const svgNS = 'http://www.w3.org/2000/svg';
  const newSvg = (name, attrs = {}, text = '') => {
    const el = document.createElementNS(svgNS, name);
    for (const [key, value] of Object.entries(attrs)) el.setAttribute(key, String(value));
    if (text) el.textContent = text;
    return el;
  };
  const add = (parent, tag, className, text = '') => {
    const el = document.createElement(tag);
    if (className) el.className = className;
    el.textContent = text;
    parent.append(el);
    return el;
  };
  const fmt = n => Number(n || 0).toLocaleString('ru-RU');
  const relative = value => {
    if (!value) return 'никогда';
    const n = Math.max(0, Math.floor(Date.now() / 1000 - value));
    if (n < 8) return 'только что';
    if (n < 60) return n + ' с назад';
    if (n < 3600) return Math.floor(n / 60) + ' мин назад';
    if (n < 86400) return Math.floor(n / 3600) + ' ч назад';
    return Math.floor(n / 86400) + ' д назад';
  };
  const formatUptime = sec => {
    sec = Math.floor(sec || 0);
    if (sec >= 86400) return Math.floor(sec / 86400) + ' д ' + Math.floor(sec % 86400 / 3600) + ' ч';
    if (sec >= 3600) return Math.floor(sec / 3600) + ' ч ' + Math.floor(sec % 3600 / 60) + ' мин';
    if (sec >= 60) return Math.floor(sec / 60) + ' мин';
    return sec + ' с';
  };
  const statusName = s => ({ working:'Работает', idle:'Ожидает', blocked:'Заблокирован',
    failed:'Ошибка', done:'Выполнено' })[s] || s || 'Ожидает';

  let snapshot = null;
  let selectedId = null;
  let inflight = false;

  function nameLines(name, maxChars = 24) {
    // Preserve every character. SVG cannot wrap text automatically.
    const lines = [];
    let remaining = String(name);
    while (remaining.length > maxChars) {
      const chunk = remaining.slice(0, maxChars);
      const lastSeparator = Math.max(chunk.lastIndexOf('-'), chunk.lastIndexOf('_'),
                                     chunk.lastIndexOf(' '));
      const end = lastSeparator > 9 ? lastSeparator + 1 : maxChars;
      lines.push(remaining.slice(0, end));
      remaining = remaining.slice(end);
    }
    lines.push(remaining);
    return lines;
  }

  function graph(data) {
    const svg = $('graph');
    svg.replaceChildren();
    const agents = data.agents.slice(0, 40);
    $('graph-empty').hidden = !!agents.length;
    $('graph-summary').textContent = agents.length
      ? fmt(agents.length) + ' узлов · ' + fmt(data.edges.length) + ' связей'
      : 'Ожидание регистрации первого агента';
    if (!agents.length) return;
    const W = 900, H = 415;
    const positions = new Map();
    agents.forEach((agent, index) => {
      const angle = -Math.PI / 2 + 2 * Math.PI * index / Math.max(agents.length, 1);
      const radiusX = agents.length <= 2 ? 260 : agents.length <= 8 ? 285 : 325;
      const radiusY = agents.length <= 2 ? 0 : agents.length <= 8 ? 137 : 163;
      const lines = nameLines(agent.name);
      const longest = Math.max(...lines.map(line => line.length));
      const width = Math.max(175, Math.min(265, longest * 7.6 + 48));
      const height = 62 + (lines.length - 1) * 17;
      positions.set(agent.agent_id, {
        x: agents.length === 1 ? W / 2 : W / 2 + Math.cos(angle) * radiusX,
        y: agents.length === 1 ? H / 2 : H / 2 + Math.sin(angle) * radiusY,
        lines, width, height
      });
    });
    const defs = newSvg('defs');
    const arrow = newSvg('marker', {id:'flow-arrow', markerWidth:7, markerHeight:7,
      refX:6, refY:3.5, orient:'auto', markerUnits:'strokeWidth'});
    arrow.append(newSvg('path', {d:'M0 0 L7 3.5 L0 7 z', fill:'#6487b1'}));
    const pendingArrow = newSvg('marker', {id:'pending-arrow', markerWidth:7, markerHeight:7,
      refX:6, refY:3.5, orient:'auto', markerUnits:'strokeWidth'});
    pendingArrow.append(newSvg('path', {d:'M0 0 L7 3.5 L0 7 z', fill:'#e9b878'}));
    defs.append(arrow, pendingArrow);
    svg.append(defs);
    data.edges.forEach(edge => {
      const a = positions.get(edge.source), b = positions.get(edge.target);
      if (!a || !b) return;
      const dx = b.x - a.x, dy = b.y - a.y;
      if (Math.abs(dx) + Math.abs(dy) < 2) return;
      const len = Math.hypot(dx, dy), ux = dx / len, uy = dy / len;
      const borderDistance = node => Math.min(
        (node.width / 2 + 9) / Math.max(Math.abs(ux), .001),
        (node.height / 2 + 7) / Math.max(Math.abs(uy), .001)
      );
      const start = borderDistance(a), end = borderDistance(b);
      if (start + end >= len) return;
      const sx = a.x + ux * start, sy = a.y + uy * start;
      const tx = b.x - ux * end, ty = b.y - uy * end;
      const bend = ((String(edge.source).charCodeAt(0) % 2) ? 1 : -1) * Math.min(36, len / 8);
      const mx = (sx + tx) / 2 - uy * bend, my = (sy + ty) / 2 + ux * bend;
      const isPending = edge.pending_count > 0;
      svg.append(newSvg('path', {
        d:`M ${sx} ${sy} Q ${mx} ${my} ${tx} ${ty}`,
        class:'edge' + (isPending ? ' has-pending' : ''),
        'marker-end':isPending ? 'url(#pending-arrow)' : 'url(#flow-arrow)'
      }));
      const count = Math.max(edge.recent_count || 0, edge.pending_count || 0);
      svg.append(newSvg('text', {x:mx, y:my - 8, class:'edge-count', 'text-anchor':'middle'}, '×' + count));
    });
    agents.forEach(agent => {
      const p = positions.get(agent.agent_id);
      const group = newSvg('g', {
        class:'node' + (!agent.online ? ' offline' : '') + (selectedId === agent.agent_id ? ' selected' : ''),
        tabindex:'0', role:'button',
        'aria-label':agent.name + ', ' + (agent.online ? 'онлайн' : 'офлайн'),
        transform:`translate(${p.x} ${p.y})`,
      });
      const left = -p.width / 2, top = -p.height / 2;
      group.append(newSvg('title', {}, agent.name));
      group.append(newSvg('rect', {
        x:left, y:top, rx:12, ry:12, width:p.width,
        height:p.height, class:'node-shell'
      }));
      group.append(newSvg('circle', {
        cx:left + 19, cy:top + 21, r:7,
        fill:agent.online ? '#46dfce' : '#63758d'
      }));
      group.append(newSvg('circle', {
        cx:left + 19, cy:top + 21, r:12, fill:'none',
        stroke:agent.online ? '#46dfce33' : '#63758d22', 'stroke-width':2
      }));
      const label = newSvg('text', {
        x:left + 36, y:top + 25, class:'node-name'
      });
      p.lines.forEach((line, i) => label.append(newSvg('tspan', {
        x:left + 36, dy:i ? 17 : 0
      }, line)));
      group.append(label);
      group.append(newSvg('text', {
        x:left + 36, y:top + p.height - 12, class:'node-sub'
      }, agent.kind + ' · ' + statusName(agent.task_status)));
      const activate = () => {
        selectedId = agent.agent_id;
        render(snapshot);
        document.dispatchEvent(new CustomEvent('agent-network:selected', {detail:agent}));
      };
      group.addEventListener('click', activate);
      group.addEventListener('keydown', event => {
        if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); activate(); }
      });
      svg.append(group);
    });
  }

  function inspector(data) {
    const el = $('inspector');
    if (!selectedId && data.agents.length === 1) selectedId = data.agents[0].agent_id;
    const agent = data.agents.find(a => a.agent_id === selectedId);
    if (!agent) {
      el.replaceChildren();
      const empty = add(el, 'div', 'inspector-placeholder');
      add(empty, 'span', '', '⌁');
      add(empty, 'strong', '', 'Выберите агента');
      add(empty, 'p', '', 'Нажмите на узел сети, чтобы увидеть его состояние.');
      return;
    }
    el.replaceChildren();
    const header = add(el, 'div', 'inspector-title');
    add(header, 'span', 'inspector-avatar', '◈');
    const body = add(header, 'div', '');
    add(body, 'strong', '', agent.name);
    add(body, 'span', '', agent.role || agent.kind);
    const connected = data.channels.filter(c => c.agent_id === agent.agent_id);
    const fields = [
      ['Состояние', agent.online ? 'Онлайн' : 'Офлайн'],
      ['Тип', agent.kind],
      ['Задача', statusName(agent.task_status)],
      ['MCP-активность', relative(agent.last_mcp_activity)],
      ['Последний опрос', relative(agent.last_poll_at)],
      ['PUSH-адаптеры', String(connected.length)],
      ['Сообщений в очереди', fmt(agent.pending_messages)],
      ['Последнее пробуждение', relative(agent.last_wake_at)],
    ];
    fields.forEach(([label, value]) => {
      const row = add(el, 'div', 'inspect-row');
      add(row, 'span', '', label);
      const strong = add(row, 'strong', '', value);
      strong.title = value;
    });
    const task = add(el, 'div', 'inspect-task');
    add(task, 'span', '', 'ТЕКУЩАЯ ЗАДАЧА');
    add(task, 'p', '', agent.current_task || agent.purpose || 'Нет активной задачи');
  }

  function agentsTable(data) {
    const tbody = $('agents-body');
    tbody.replaceChildren();
    $('agents-count').textContent = String(data.agents.length);
    if (!data.agents.length) {
      const tr = document.createElement('tr');
      const td = add(tr, 'td', 'table-empty', 'В сети пока нет агентов.');
      td.colSpan = 5; tbody.append(tr); return;
    }
    data.agents.forEach(agent => {
      const tr = document.createElement('tr');
      tr.addEventListener('click', () => {
        selectedId = agent.agent_id;
        render(snapshot);
        document.dispatchEvent(new CustomEvent('agent-network:selected', {detail:agent}));
      });
      const colName = add(tr, 'td', '');
      add(colName, 'span', 'agent-name', agent.name);
      add(colName, 'span', 'agent-kind', agent.kind + ' · ' + (agent.role || 'без роли'));
      const status = add(tr, 'td', '');
      add(status, 'span', 'status-pill' + (agent.online ? '' : ' off'),
        agent.online ? 'Онлайн' : 'Офлайн');
      const task = add(tr, 'td', '');
      const desc = add(task, 'div', 'task-text', agent.current_task || statusName(agent.task_status));
      desc.title = agent.current_task || '';
      add(tr, 'td', '', relative(agent.last_mcp_activity));
      add(tr, 'td', 'queue-number', agent.pending_messages ? fmt(agent.pending_messages) : '—');
      tbody.append(tr);
    });
  }

  function channels(data) {
    const el = $('channels-list');
    $('channels-count').textContent = String(data.channels.length);
    el.replaceChildren();
    if (!data.channels.length) {
      add(el, 'div', 'list-empty', 'Нет подключённых PUSH-адаптеров. Прямое MCP-соединение доступно независимо.');
      return;
    }
    data.channels.forEach(channel => {
      const row = add(el, 'div', 'channel-item');
      add(row, 'div', 'channel-icon', channel.kind === 'chatgpt' ? '◎' : channel.kind === 'codex' ? '⌘' : '↪');
      const info = add(row, 'div', 'channel-info');
      add(info, 'strong', '', channel.agent_name);
      add(info, 'small', '', channel.kind.toUpperCase() + ' · ' + relative(channel.last_seen));
      add(row, 'span', 'channel-state', channel.state === 'idle' ? 'IDLE' : channel.state.toUpperCase());
    });
  }

  function activity(data) {
    const el = $('activity-list');
    el.replaceChildren();
    if (!data.recent.length) { add(el, 'div', 'list-empty', 'Сообщений пока нет.'); return; }
    data.recent.forEach(message => {
      const row = add(el, 'div', 'event');
      add(row, 'span', 'event-indicator', '↗');
      const detail = add(row, 'div', 'event-detail');
      add(detail, 'strong', '', message.sender_name + ' → ' + message.recipient_name);
      add(detail, 'small', '', 'Сообщение ' + message.message_id.slice(0, 8));
      add(row, 'span', message.status === 'acknowledged' ? 'event-status done' : 'event-status',
        message.status === 'acknowledged' ? 'Получено' : 'В очереди');
      add(row, 'span', 'event-time', relative(message.created_at));
    });
  }

  function render(data) {
    if (!data) return;
    const m = data.metrics;
    $('metric-agents').textContent = fmt(m.agents_total);
    $('metric-agents-note').textContent = fmt(m.agents_working) + ' выполняют задачи';
    $('metric-online').textContent = fmt(m.agents_online);
    $('metric-queued').textContent = fmt(m.pending_messages);
    $('metric-messages').textContent = fmt(m.messages_24h);
    $('metric-adapters').textContent = fmt(m.channels_connected);
    $('uptime').textContent = formatUptime(data.server.uptime_seconds);
    graph(data);
    inspector(data);
    agentsTable(data);
    channels(data);
    // Paginated message activity is rendered by dashboard-interactions.js.
  }

  async function poll() {
    if (inflight) return;
    inflight = true;
    try {
      const response = await fetch('/api/v1/dashboard', {cache:'no-store', credentials:'same-origin'});
      if (!response.ok) throw Error('HTTP ' + response.status);
      const data = await response.json();
      if (!data.server || !data.metrics || !Array.isArray(data.agents)) throw Error('Некорректный ответ сервера');
      snapshot = data;
      $('server-state').classList.remove('offline');
      $('server-label').textContent = 'Сервер работает';
      render(data);
      document.dispatchEvent(new CustomEvent('agent-network:snapshot', {detail:data}));
    } catch (e) {
      $('server-state').classList.add('offline');
      $('server-label').textContent = 'Связь потеряна';
      $('graph-summary').textContent = 'Нет связи с сервером: ' + (e.message || e);
    } finally {
      inflight = false;
    }
  }
  function clock() { $('clock').textContent = new Date().toLocaleTimeString('ru-RU'); }
  clock();
  setInterval(clock, 1000);
  void poll();
  setInterval(() => void poll(), 3000);
})();
