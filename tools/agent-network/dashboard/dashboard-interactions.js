/* Browser-side human operator identity + bounded, paginated debugging history. */
(() => {
  const $ = id => document.getElementById(id);
  const key = 'agent-network:dashboard-agent:v1';
  const short = name => name.length > 20 ? name.slice(0, 19) + '…' : name;
  const ago = time => {
    if (!time) return 'никогда';
    const sec = Math.max(0, Math.floor(Date.now()/1000 - time));
    if (sec < 60) return sec + ' с назад';
    if (sec < 3600) return Math.floor(sec / 60) + ' мин назад';
    if (sec < 86400) return Math.floor(sec / 3600) + ' ч назад';
    return Math.floor(sec / 86400) + ' д назад';
  };
  const add = (parent, name, cls, text = '') => {
    const el = document.createElement(name);
    if (cls) el.className = cls;
    el.textContent = text;
    parent.append(el);
    return el;
  };
  let identity = null;
  try { identity = JSON.parse(localStorage.getItem(key) || 'null'); } catch {}
  const active = () => !!(identity?.enabled && identity?.agent_id && identity?.token);
  let busy = false;
  let sending = false;
  let messagePage = 1, toolPage = 1;
  let lastInboxKey = null;
  let sendAttemptKey = null;
  let recipients = [];

  async function api(url, options = {}, authenticated = false) {
    const headers = {'Accept':'application/json'};
    if (options.body !== undefined) headers['Content-Type'] = 'application/json';
    if (authenticated) {
      if (!active()) throw Error('Dashboard agent is disabled');
      headers['X-Agent-Id'] = identity.agent_id;
      headers['X-Agent-Token'] = identity.token;
    }
    const res = await fetch(new URL(url, location.origin).href, {
      method: options.method || 'GET',
      headers:{...headers, ...(options.headers || {})},
      cache:'no-store', credentials:'same-origin',
      body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const error = new Error(data.detail || 'Server error: ' + res.status);
      error.status = res.status;
      throw error;
    }
    return data;
  }
  const saveIdentity = () => {
    if (identity) localStorage.setItem(key, JSON.stringify(identity));
    else localStorage.removeItem(key);
  };
  const status = (text, error = false) => {
    $('dashboard-agent-info').textContent = text;
    $('dashboard-agent-info').style.color = error ? 'var(--red)' : '';
  };
  function showEnabled() {
    const enabled = active();
    $('dashboard-toggle').checked = enabled;
    $('dashboard-name').disabled = !!identity?.agent_id;
    if (identity?.name) $('dashboard-name').value = identity.name;
    $('dashboard-presence').textContent = enabled ? 'Онлайн' : 'Выключен';
    $('dashboard-presence').classList.toggle('off', !enabled);
    $('dashboard-send').disabled = !enabled || sending;
    $('dashboard-recipient').disabled = !enabled;
    $('dashboard-message').disabled = !enabled;
    if (!enabled) {
      lastInboxKey = null;
      $('dashboard-inbox-count').textContent = '0';
      $('dashboard-inbox').replaceChildren();
      add($('dashboard-inbox'), 'div', 'list-empty',
          'Агент выключен. Входящие сохраняются на сервере до следующего включения.');
      $('dashboard-send-status').textContent = 'Для отправки включите агента';
    } else {
      $('dashboard-send-status').textContent = 'Отправка через общую очередь Agent Network';
    }
  }

  async function onToggle() {
    if (busy) return;
    busy = true;
    $('dashboard-toggle').disabled = true;
    const wanted = $('dashboard-toggle').checked;
    try {
      if (wanted) {
        const name = (identity?.name || $('dashboard-name').value).trim();
        if (!name) throw Error('Укажите имя агента.');
        let result;
        try {
          result = await api('/api/v1/dashboard-agent/enable', {
            method:'POST',
            body: {name, agent_id:identity?.agent_id || '', token:identity?.token || ''},
          });
        } catch (error) {
          if (identity?.agent_id && error.status === 409 &&
              String(error.message).includes('Unknown agent identity')) {
            // Identity was manually deleted: recover by registering a fresh one.
            result = await api('/api/v1/dashboard-agent/enable', {
              method:'POST', body:{name},
            });
          } else {
            throw error;
          }
        }
        identity = {
          name:result.agent.name,
          agent_id:result.agent.agent_id,
          token:result.token,
          enabled:true,
        };
        saveIdentity();
        showEnabled();
        status('Зарегистрирован · ' + short(identity.agent_id));
        await refreshInbox();
      } else {
        if (active()) await api('/api/v1/dashboard-agent/disable', {
          method:'POST', body:{},
        }, true);
        if (identity) identity.enabled = false;
        saveIdentity();
        showEnabled();
        status('Регистрация сохранена, агент офлайн');
      }
    } catch (e) {
      $('dashboard-toggle').checked = active();
      status(String(e.message || e), true);
    } finally {
      $('dashboard-toggle').disabled = false;
      busy = false;
    }
  }

  function updateRecipients(data) {
    recipients = data.agents || [];
    const field = $('dashboard-recipient');
    const prev = field.value;
    field.replaceChildren();
    add(field, 'option', '', 'Выберите получателя').value = '';
    recipients.forEach(agent => {
      const option = add(field, 'option', '', agent.name +
        (agent.kind === 'dashboard' ? ' · dashboard' : '') +
        (agent.online ? ' · онлайн' : ' · офлайн'));
      option.value = agent.agent_id;
    });
    if (recipients.some(a => a.agent_id === prev)) field.value = prev;
  }

  async function refreshInbox() {
    if (!active()) return;
    try {
      const result = await api('/api/v1/dashboard-agent/inbox', {}, true);
      const items = result.items || [];
      $('dashboard-inbox-count').textContent = String(items.length);
      const fingerprint = items.map(x => x.message_id).join('|');
      if (lastInboxKey === fingerprint) return;
      lastInboxKey = fingerprint;
      const list = $('dashboard-inbox');
      list.replaceChildren();
      if (!items.length) {
        add(list,'div','list-empty','Входящих сообщений пока нет. Другие агенты могут написать этому агенту через MCP.');
      }
      for (const message of items) {
        const row = add(list,'article','inbox-entry');
        const head = add(row,'div','inbox-entry-top');
        add(head,'strong','inbox-sender',message.sender_name || message.sender_id);
        add(head,'span','tiny-muted',ago(message.created_at));
        add(row,'div','inbox-body',message.body);
        const foot = add(row,'div','inbox-entry-bottom');
        add(foot,'span','inbox-id','#' + message.message_id.slice(0,8));
        const button = add(foot,'button','ack-button','Подтвердить ✓');
        button.type = 'button';
        button.addEventListener('click',async () => {
          button.disabled = true;
          try {
            await api('/api/v1/dashboard-agent/ack', {
              method:'POST',body:{message_id:message.message_id},
            }, true);
            lastInboxKey = null;
            await refreshInbox();
            void refreshHistories();
          } catch(e) {
            status('ACK: ' + String(e.message||e),true);
            button.disabled = false;
          }
        });
      }
    } catch(e) {
      if (e.status === 403) {
        // Stale tab identity was manually deleted on the server.
        const previousName = identity?.name;
        identity = null;
        saveIdentity();
        if (previousName) $('dashboard-name').value = previousName;
        showEnabled();
        status('Регистрация агента устарела. Включите его повторно.', true);
        return;
      }
      status('Входящие: ' + String(e.message||e),true);
    }
  }

  async function submitMessage(event) {
    event.preventDefault();
    if (!active() || sending) return;
    const to = $('dashboard-recipient').value;
    const text = $('dashboard-message').value.trim();
    if (!to || !text) return;
    sending = true;
    $('dashboard-send').disabled = true;
    const clientMessageId = sendAttemptKey || crypto.randomUUID();
    sendAttemptKey = clientMessageId; // keep ID on failed/retried HTTP requests
    try {
      const result = await api('/api/v1/dashboard-agent/send', {
        method:'POST', body:{to,text,client_message_id:clientMessageId},
      },true);
      $('dashboard-message').value = '';
      sendAttemptKey = null;
      $('dashboard-send-status').textContent =
        (result.duplicate ? 'Уже было отправлено · ' : 'Отправлено · ') +
        result.message_id.slice(0,8);
      void refreshHistories();
    } catch (e) {
      $('dashboard-send-status').textContent = 'Ошибка: ' + String(e.message||e);
    } finally {
      sending = false;
      $('dashboard-send').disabled = !active();
    }
  }

  function paginate(prefix, page, pages, total) {
    $(prefix+'-page').textContent = page + ' / ' + pages;
    $(prefix+'-total').textContent = prefix === 'messages'
      ? total + ' сообщений за 24 часа · 10 на странице'
      : total + ' из 100 сохранённых вызовов · 10 на странице';
    $(prefix+'-prev').disabled = page <= 1;
    $(prefix+'-next').disabled = page >= pages;
  }
  function toolHistory(data) {
    const el = $('tools-body');
    el.replaceChildren();
    $('tool-avg').textContent = (Number(data.avg_ms)||0).toFixed(1) + ' мс';
    paginate('tools',data.page,data.pages,data.total);
    if (!data.items.length) {
      const tr = add(el,'tr','');
      add(tr,'td','table-empty','Вызовов инструментов пока нет.').colSpan = 5;
      return;
    }
    data.items.forEach(call => {
      const tr=add(el,'tr','');
      add(tr,'td','tool-name',call.tool_name);
      add(tr,'td','tool-actor',call.agent_name || (call.agent_id ? call.agent_id.slice(0,8) : '—'));
      add(tr,'td',call.status==='ok'?'call-ok':'call-error',call.status==='ok'?'Успешно':'Ошибка');
      add(tr,'td','duration',Number(call.duration_ms).toFixed(2)+' мс');
      add(tr,'td','',ago(call.created_at));
    });
  }
  function messageHistory(data) {
    const el=$('activity-list');
    el.replaceChildren();
    paginate('messages',data.page,data.pages,data.total);
    if (!data.items.length) {
      add(el,'div','list-empty','Сообщений пока нет.');
      return;
    }
    data.items.forEach(msg => {
      const row=add(el,'div','event');
      add(row,'span','event-indicator','↗');
      const detail=add(row,'div','event-detail');
      add(detail,'strong','',msg.sender_name+' → '+msg.recipient_name);
      add(detail,'small','', 'Сообщение #'+msg.message_id.slice(0,8));
      add(row,'span',msg.status==='acknowledged'?'event-status done':'event-status',
          msg.status==='acknowledged'?'Получено':'В очереди');
      add(row,'span','event-time',ago(msg.created_at));
      const open = add(row,'button','event-chat-button','Чат');
      open.type='button';
      open.title='Открыть переписку этих агентов';
      open.setAttribute('aria-label','Открыть чат ' + msg.sender_name + ' и ' + msg.recipient_name);
      open.addEventListener('click',() => document.dispatchEvent(
        new CustomEvent('agent-network:open-chat',{
          detail:{agentId:msg.sender_id,peerId:msg.recipient_id}
        })
      ));
    });
  }

  let fetchingHistories=false;
  async function refreshHistories() {
    if (fetchingHistories) return;
    fetchingHistories=true;
    try {
      const [m,t]=await Promise.all([
        api('/api/v1/dashboard/message-history?page='+messagePage),
        api('/api/v1/dashboard/tool-history?page='+toolPage),
      ]);
      if (m.page===messagePage) messageHistory(m);
      if (t.page===toolPage) toolHistory(t);
    } catch(e) {
      console.warn('Dashboard histories unavailable:',e.message||e);
    } finally {
      fetchingHistories=false;
    }
  }
  function pageButtons() {
    [['messages', () => messagePage, v => messagePage = v],
     ['tools', () => toolPage, v => toolPage = v]]
      .forEach(([prefix,get,set]) => {
        $(prefix+'-prev').addEventListener('click',() => {
          set(Math.max(1,get()-1)); void refreshHistories();
        });
        $(prefix+'-next').addEventListener('click',() => {
          const max = prefix === 'messages'
            ? Number($(prefix+'-page').textContent.split(' / ')[1]) || 1
            : 10;
          set(Math.min(max,get()+1)); void refreshHistories();
        });
      });
  }

  async function deleteSelectedAgent() {
    const button = $('delete-agent');
    const targetId = button.dataset.agentId;
    const targetName = button.dataset.agentName;
    if (!targetId || !targetName || button.disabled) return;
    const accepted = confirm(
      'Безвозвратно удалить агента «' + targetName + '»?\\n\\n' +
      'Будут удалены сохранённый контекст, все сообщения (входящие и исходящие) и PUSH-адаптеры. ' +
      'Имя освободится; прежний токен перестанет работать.'
    );
    if (!accepted) return;
    button.disabled = true;
    try {
      const result = await api(
        '/api/v1/dashboard/agents/' + encodeURIComponent(targetId),
        {method:'DELETE'}
      );
      if (targetId === identity?.agent_id) {
        identity = null;
        saveIdentity();
        $('dashboard-name').value = '';
        showEnabled();
      }
      status('Удалён агент «' + result.name + '», связанных сообщений: ' +
             result.deleted_messages);
      button.dataset.agentId = '';
      button.dataset.agentName = '';
      button.hidden = true;
      document.dispatchEvent(new CustomEvent('agent-network:refresh'));
      void refreshHistories();
    } catch (error) {
      if (error.status === 401) {
        status('Требуется вход администратора. Обновите страницу.', true);
      } else {
        status('Удаление: ' + String(error.message || error), true);
      }
    } finally {
      // Inspector refresh hides the button if its selected agent is gone.
      button.disabled = !button.dataset.agentId;
    }
  }

  $('delete-agent').addEventListener('click', () => void deleteSelectedAgent());
  $('dashboard-toggle').addEventListener('change', () => void onToggle());
  $('dashboard-compose').addEventListener('submit', submitMessage);
  $('dashboard-message').addEventListener('input', () => {sendAttemptKey=null;});
  $('dashboard-recipient').addEventListener('change', () => {sendAttemptKey=null;});
  document.addEventListener('agent-network:snapshot', event => updateRecipients(event.detail));
  document.addEventListener('agent-network:selected', event => {
    const id = event.detail?.agent_id;
    if (id && recipients.some(a => a.agent_id===id)) $('dashboard-recipient').value=id;
  });
  pageButtons();
  if (!identity) $('dashboard-name').value='dashboard-'+crypto.randomUUID().slice(0,8);
  showEnabled();
  if (active()) status('Подключение к сети…');
  void refreshHistories();
  if (active()) void refreshInbox();
  setInterval(() => {
    if (active()) void refreshInbox();
    void refreshHistories();
  },5000);
})();
