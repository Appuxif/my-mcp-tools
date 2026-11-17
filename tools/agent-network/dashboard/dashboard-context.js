/* Administrator-only, read-only saved-context viewer.
 * A dedicated HTTP Basic-protected API, not the agent MCP read_context tool.
 * The content is untrusted text: render only with textContent.
 */
(() => {
  const $ = id => document.getElementById(id);
  const state = {agentId:'',generation:0,previousFocus:null,raw:''};
  const visible = () => !$('context-overlay').hidden;

  function setText(text, empty = false) {
    const body = $('context-content');
    body.textContent = text;
    body.classList.toggle('empty', empty);
  }

  async function loadContext() {
    if (!state.agentId) return;
    const generation = ++state.generation;
    const agentId = state.agentId;
    $('context-refresh').disabled = true;
    $('context-copy').disabled = true;
    $('context-status').textContent = 'Загрузка…';
    try {
      // Browser sends its existing Dashboard Basic auth, never an agent token.
      const response = await fetch(new URL(
        '/api/v1/dashboard/agents/' + encodeURIComponent(agentId) + '/context',
        location.origin,
      ).href, {
        method:'GET', cache:'no-store', credentials:'same-origin',
        headers:{'Accept':'application/json'},
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw Error(response.status === 401
        ? 'Нужна авторизация администратора. Обновите Dashboard.'
        : data.detail || 'HTTP ' + response.status);
      if (generation !== state.generation || !visible() || agentId !== state.agentId) return;
      if (data.agent_id !== agentId || typeof data.exists !== 'boolean' ||
          (data.exists && typeof data.context !== 'string')) {
        throw Error('Сервер вернул некорректный контекст');
      }
      $('context-title').textContent = data.agent_name || agentId;
      if (!data.exists) {
        state.raw = '';
        $('context-meta').textContent = 'Контекст ещё не сохранён';
        $('context-status').textContent = 'Нет сохранённого контекста';
        setText('Агент ещё не вызывал save_context. Контекст появится после сохранения агентом.', true);
        return;
      }
      state.raw = data.context;
      const when = data.updated_at
        ? new Date(data.updated_at * 1000).toLocaleString('ru-RU')
        : 'неизвестно';
      $('context-meta').textContent = 'Обновлён: ' + when +
        ' · ' + Number(data.bytes || 0).toLocaleString('ru-RU') + ' байт';
      $('context-status').textContent = 'Только чтение';
      setText(state.raw);
      $('context-copy').disabled = false;
    } catch (error) {
      if (generation !== state.generation || !visible()) return;
      state.raw = '';
      $('context-status').textContent = 'Ошибка загрузки';
      $('context-meta').textContent = 'Контекст недоступен';
      setText(String(error.message || error), true);
    } finally {
      if (generation === state.generation && visible()) $('context-refresh').disabled = false;
    }
  }

  function open(agentId) {
    if (!agentId) return;
    if (!visible()) state.previousFocus = document.activeElement;
    state.agentId = agentId;
    state.raw = '';
    $('context-title').textContent = 'Сохранённый контекст';
    $('context-meta').textContent = 'Чтение контекста агента';
    $('context-overlay').hidden = false;
    document.body.classList.add('context-open');
    setText('Загрузка…', true);
    $('context-scroll').scrollTop = 0;
    $('context-close').focus();
    void loadContext();
  }

  function close() {
    if (!visible()) return;
    ++state.generation; // An outdated response must never populate another agent's viewer.
    $('context-overlay').hidden = true;
    document.body.classList.remove('context-open');
    state.raw = '';
    state.agentId = '';
    setText('');
    const previous = state.previousFocus;
    state.previousFocus = null;
    if (previous?.isConnected && typeof previous.focus === 'function') previous.focus();
  }

  $('open-agent-context').addEventListener('click', () => open($('open-agent-context').dataset.agentId));
  $('context-close').addEventListener('click', close);
  $('context-backdrop').addEventListener('click', close);
  $('context-refresh').addEventListener('click', () => void loadContext());
  $('context-wrap').addEventListener('change', () => {
    $('context-content').classList.toggle('no-wrap', !$('context-wrap').checked);
  });
  $('context-copy').addEventListener('click', async () => {
    if (!state.raw) return;
    const raw = state.raw;
    try {
      await navigator.clipboard.writeText(raw);
      if (visible() && state.raw === raw) $('context-status').textContent = 'Скопировано';
    } catch {
      if (visible()) $('context-status').textContent = 'Не удалось скопировать. Выделите текст вручную.';
    }
  });
  document.addEventListener('keydown', event => {
    if (!visible()) return;
    if (event.key === 'Escape') { event.preventDefault(); close(); return; }
    if (event.key !== 'Tab') return;
    const items = [...$('context-dialog').querySelectorAll(
      'button:not([disabled]), input:not([disabled])'
    )].filter(el => !el.hidden);
    if (!items.length) return;
    if (event.shiftKey && document.activeElement === items[0]) {
      event.preventDefault();
      items[items.length - 1].focus();
    } else if (!event.shiftKey && document.activeElement === items[items.length - 1]) {
      event.preventDefault();
      items[0].focus();
    }
  });
})();
