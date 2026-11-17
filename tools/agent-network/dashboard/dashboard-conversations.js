/* Administrator-only read-only conversation explorer.
 * Messages remain subject to the existing 24-hour TTL; no new persistence.
 * Only the server returns message bodies after admin authentication.
 */
(() => {
  const $ = id => document.getElementById(id);
  const PAGE_SIZE = 30;
  const state = {
    agentId: null, agentName: '', peerId: null, peerName: '',
    conversations: [], nextCursor: null, hasMore: false, loading: false,
    generation: 0, messageIds: new Set(), previousFocus: null,
  };

  const fmtTime = timestamp => timestamp
    ? new Date(timestamp * 1000).toLocaleString('ru-RU', {
        day:'2-digit',month:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit'
      }) : '—';
  const ago = timestamp => {
    if (!timestamp) return '—';
    const age = Math.max(0, Math.floor(Date.now() / 1000 - timestamp));
    if (age < 60) return age + ' сек';
    if (age < 3600) return Math.floor(age / 60) + ' мин';
    if (age < 86400) return Math.floor(age / 3600) + ' ч';
    return Math.floor(age / 86400) + ' д';
  };
  const append = (parent, tag, className = '', text = '') => {
    const element = document.createElement(tag);
    if (className) element.className = className;
    element.textContent = text;
    parent.append(element);
    return element;
  };
  const showMessage = (place, text, error = false) => {
    place.replaceChildren();
    append(place, 'div', error ? 'chat-placeholder chat-error' : 'chat-placeholder', text);
  };
  const setThreadStatus = text => { $('chat-thread-status').textContent = text; };

  async function request(url) {
    // Browser reuses the HTTP Basic credentials entered on /dashboard.
    const response = await fetch(url, {
      method:'GET',
      cache:'no-store',
      credentials:'same-origin',
      headers:{'Accept':'application/json'},
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      if (response.status === 401) {
        throw Error('Необходим вход администратора. Обновите страницу и войдите снова.');
      }
      throw Error(payload.detail || 'HTTP ' + response.status);
    }
    return payload;
  }

  function visible() { return !$('chat-overlay').hidden; }

  function closePanel() {
    if (!visible()) return;
    state.generation++;
    state.loading = false;
    state.peerId = null;
    $('chat-overlay').hidden = true;
    document.body.classList.remove('chat-open');
    const previous = state.previousFocus;
    state.previousFocus = null;
    if (previous?.isConnected && typeof previous.focus === 'function') previous.focus();
  }

  function renderPeerList() {
    const list = $('chat-peer-list');
    list.replaceChildren();
    $('chat-peer-count').textContent = String(state.conversations.length);
    if (!state.conversations.length) {
      showMessage(list, 'Сообщений с другими агентами за последние 24 часа нет.');
      return;
    }
    for (const peer of state.conversations) {
      const button = append(list, 'button', 'chat-peer-item');
      button.type = 'button';
      button.setAttribute('aria-current', String(peer.peer_id === state.peerId));
      button.title = peer.peer_name;
      const top = append(button, 'div', 'chat-peer-top');
      append(top, 'span', 'chat-peer-name', peer.peer_name);
      append(top, 'span', 'chat-peer-time', ago(peer.last_message_at));
      const bottom = append(button, 'div', 'chat-peer-bottom');
      append(bottom,'span','',
        peer.message_count + ' сообщ.' + (peer.peer_kind ? ' · ' + peer.peer_kind : ''));
      if (peer.pending_for_agent) {
        append(bottom, 'span', 'chat-peer-queue',
          '↙ ' + peer.pending_for_agent + ' в очереди');
      }
      button.addEventListener('click', () => void selectPeer(peer.peer_id));
    }
  }

  function renderBubble(message) {
    const outgoing = message.sender_id === state.agentId;
    const article = document.createElement('article');
    article.className = 'chat-message' + (outgoing ? ' out' : ' in');
    article.dataset.messageId = message.message_id;

    const head = append(article, 'div', 'chat-message-header');
    append(head, 'strong', '', message.sender_name || message.sender_id);
    const date = append(head, 'span', 'chat-message-time', fmtTime(message.created_at));
    date.title = new Date(message.created_at * 1000).toLocaleString('ru-RU');

    // Always use textContent: messages are untrusted data, never HTML.
    append(article, 'div', 'chat-message-body', message.body || '');

    const footer = append(article, 'div', 'chat-message-footer');
    const status = append(
      footer, 'span', 'chat-delivery ' + (message.status || 'unknown'),
      message.status === 'acknowledged' ? '✓ Получено' :
      message.status === 'pending' ? '◷ В очереди' : 'Статус неизвестен'
    );
    if (message.acknowledged_at && message.status === 'acknowledged') {
      status.title = 'Подтверждено: ' + fmtTime(message.acknowledged_at);
    }
    append(footer, 'span', '', '#' + message.message_id.slice(0, 8) +
      (message.task_id ? ' · задача ' + message.task_id : ''));
    return article;
  }

  async function loadOlder(initial = false) {
    if (!state.peerId || state.loading || (!initial && !state.hasMore)) return;
    state.loading = true;
    const requestGeneration = state.generation;
    const scroll = $('chat-thread-scroll');
    const messages = $('chat-messages');
    const btn = $('chat-load-older');
    btn.disabled = true;
    btn.textContent = 'Загрузка…';
    const before = initial ? '' : state.nextCursor;
    const previousScrollHeight = scroll.scrollHeight;
    const previousScrollTop = scroll.scrollTop;
    try {
      const url = '/api/v1/dashboard/conversations/' +
        encodeURIComponent(state.agentId) + '/' + encodeURIComponent(state.peerId) +
        '/messages?limit=' + PAGE_SIZE +
        (before ? '&before=' + encodeURIComponent(before) : '');
      const data = await request(url);
      if (requestGeneration !== state.generation) return;
      if (data.agent_id !== state.agentId || data.peer_id !== state.peerId) {
        throw Error('Некорректный ответ сервера');
      }
      if (initial) {
        messages.replaceChildren();
        state.messageIds.clear();
      }
      const fragment = document.createDocumentFragment();
      for (const item of data.items) {
        if (state.messageIds.has(item.message_id)) continue;
        fragment.append(renderBubble(item));
        state.messageIds.add(item.message_id);
      }
      if (initial) {
        messages.append(fragment);
        if (!data.items.length) showMessage(messages, 'Пока нет сообщений в этой переписке.');
        scroll.scrollTop = scroll.scrollHeight;
      } else {
        messages.prepend(fragment);
        // Prevent jumping back to the top while older messages appear above.
        scroll.scrollTop = previousScrollTop + scroll.scrollHeight - previousScrollHeight;
      }
      state.hasMore = !!data.has_more;
      state.nextCursor = data.next_cursor;
      btn.hidden = !state.hasMore;
      setThreadStatus(state.hasMore
        ? 'Листайте вверх для загрузки предыдущих сообщений'
        : 'История за последние 24 часа · все доступные сообщения загружены');
      $('chat-footer').textContent =
        'Только просмотр · сообщения и ACK не изменяются · TTL 24 ч';
    } catch (error) {
      if (requestGeneration !== state.generation) return;
      setThreadStatus('Не удалось загрузить сообщения');
      $('chat-footer').textContent = String(error.message || error);
      $('chat-footer').classList.add('chat-error');
      // The user can retry with the same cursor.
      btn.hidden = false;
    } finally {
      if (requestGeneration === state.generation) {
        state.loading = false;
        btn.disabled = false;
        btn.textContent = 'Загрузить более ранние сообщения';
      }
    }
  }

  async function selectPeer(peerId) {
    if (!state.agentId || !state.conversations.some(p => p.peer_id === peerId)) return;
    state.generation++;
    state.peerId = peerId;
    const peer = state.conversations.find(p => p.peer_id === peerId);
    state.peerName = peer.peer_name;
    state.nextCursor = null;
    state.hasMore = true;
    state.loading = false;
    state.messageIds.clear();
    $('chat-load-older').hidden = true;
    $('chat-footer').classList.remove('chat-error');
    $('chat-peer-title').textContent = peer.peer_name;
    setThreadStatus('Загрузка сообщений…');
    $('chat-refresh').disabled = false;
    showMessage($('chat-messages'), 'Загрузка…');
    renderPeerList();
    await loadOlder(true);
  }

  async function openPanel({agentId, peerId} = {}) {
    if (!agentId) return;
    const token = ++state.generation;
    state.previousFocus = document.activeElement;
    state.agentId = agentId;
    state.agentName = '';
    state.peerId = null;
    state.nextCursor = null;
    state.hasMore = false;
    state.loading = false;
    state.messageIds.clear();
    state.conversations = [];
    $('chat-overlay').hidden = false;
    document.body.classList.add('chat-open');
    $('chat-drawer-title').textContent = 'Переписки агента';
    $('chat-drawer-subtitle').textContent = 'Сообщения за последние 24 часа';
    $('chat-peer-title').textContent = 'Выберите собеседника';
    $('chat-refresh').disabled = true;
    $('chat-load-older').hidden = true;
    $('chat-footer').classList.remove('chat-error');
    showMessage($('chat-peer-list'), 'Загрузка собеседников…');
    showMessage($('chat-messages'), 'Загрузка…');
    $('chat-close').focus();

    try {
      const data = await request('/api/v1/dashboard/conversations?agent_id=' +
                                 encodeURIComponent(agentId));
      if (token !== state.generation) return;
      state.agentName = data.agent_name;
      state.conversations = data.items;
      $('chat-drawer-title').textContent = data.agent_name;
      $('chat-drawer-subtitle').textContent =
        'Чаты за последние 24 часа · ' + data.items.length + ' собеседников';
      renderPeerList();
      if (!data.items.length) {
        showMessage($('chat-messages'), 'Нет переписок за последние 24 часа.');
        setThreadStatus('История пуста');
        return;
      }
      const wanted = data.items.find(p => p.peer_id === peerId) || data.items[0];
      await selectPeer(wanted.peer_id);
    } catch (error) {
      if (token !== state.generation) return;
      showMessage($('chat-peer-list'), String(error.message || error), true);
      showMessage($('chat-messages'), 'Историю загрузить не удалось.', true);
      setThreadStatus('Нет доступа к истории');
    }
  }

  $('open-agent-chat').addEventListener('click', () => {
    const agentId = $('open-agent-chat').dataset.agentId;
    if (agentId) void openPanel({agentId});
  });
  document.addEventListener('agent-network:open-chat', e => void openPanel(e.detail));
  $('chat-close').addEventListener('click', closePanel);
  $('chat-backdrop').addEventListener('click', closePanel);
  document.addEventListener('keydown', e => {
    if (visible() && e.key === 'Escape') {
      e.preventDefault();
      closePanel();
    }
    if (visible() && e.key === 'Tab') {
      const all = [...$('chat-drawer').querySelectorAll('button:not([disabled])')]
        .filter(button => !button.hidden);
      if (!all.length) return;
      const first = all[0], last = all[all.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }
  });
  $('chat-load-older').addEventListener('click', () => void loadOlder());
  $('chat-thread-scroll').addEventListener('scroll', () => {
    if (visible() && state.hasMore && !state.loading &&
        $('chat-thread-scroll').scrollTop <= 90) void loadOlder();
  });
  $('chat-refresh').addEventListener('click', () => {
    if (state.peerId) void selectPeer(state.peerId);
  });
})();
