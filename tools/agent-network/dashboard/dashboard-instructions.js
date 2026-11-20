/* Administrator-only editor for permanent instructions. The authenticated
 * Dashboard API owns all writes; the agent's MCP token is never used here.
 * Keep the prompt out of general agent snapshots and avoid HTML injection.
 */
(() => {
  const $ = id => document.getElementById(id);
  const MAX_BYTES = 128 * 1024;
  const CONFLICT_HELP = 'Конфликт версий: инструкции изменены в другой вкладке. ' +
    'Скопируйте черновик, нажмите «Обновить» и объедините изменения вручную.';
  const encoder = new TextEncoder();
  const state = {agentId:'', generation:0, saved:'', revision:0, dirty:false,
                 conflicted:false, loaded:false, loading:false, saving:false,
                 previousFocus:null};
  const visible = () => !$('instructions-overlay').hidden;
  const byteSize = value => encoder.encode(value).length;
  const endpoint = agentId => new URL('/api/v1/dashboard/agents/' +
    encodeURIComponent(agentId) + '/instructions', location.origin).href;

  function updateControls(notifyDirty=false) {
    const size = byteSize($('instructions-text').value);
    $('instructions-bytes').textContent = size.toLocaleString('ru-RU') +
      ' / ' + MAX_BYTES.toLocaleString('ru-RU') + ' байт';
    state.dirty = $('instructions-text').value !== state.saved;
    $('instructions-save').disabled = !state.loaded || state.loading || state.saving ||
      state.conflicted || !state.dirty || size > MAX_BYTES;
    $('instructions-refresh').disabled = state.loading || state.saving;
    $('instructions-text').disabled = !state.loaded || state.loading || state.saving;
    if (notifyDirty) {
      if (state.conflicted) $('instructions-status').textContent = CONFLICT_HELP;
      else if (size > MAX_BYTES) $('instructions-status').textContent = 'Превышен лимит 128 KiB UTF-8';
      else if (state.dirty) $('instructions-status').textContent = 'Есть несохранённые изменения';
      else $('instructions-status').textContent = 'Без изменений';
    }
  }

  async function load() {
    if (!state.agentId || state.saving) return;
    const generation = ++state.generation;
    const agentId = state.agentId;
    state.loading = true;
    $('instructions-status').textContent = 'Загрузка…';
    updateControls();
    try {
      const response = await fetch(endpoint(agentId), {
        method:'GET',cache:'no-store',credentials:'same-origin',
        headers:{'Accept':'application/json'},
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw Error(response.status===401
        ? 'Нужна авторизация администратора. Обновите Dashboard.'
        : data.detail || 'HTTP ' + response.status);
      if (generation!==state.generation || !visible() || state.agentId!==agentId) return;
      if (data.agent_id!==agentId || typeof data.instructions!=='string' ||
          !Number.isSafeInteger(data.revision) || data.revision<0)
        throw Error('Некорректный ответ сервера');
      state.saved = data.instructions;
      state.revision = data.revision;
      state.conflicted = false;
      state.loaded = true;
      $('instructions-text').value = data.instructions;
      $('instructions-title').textContent = data.agent_name || agentId;
      $('instructions-meta').textContent = data.updated_at
        ? 'Обновлено: ' + new Date(data.updated_at * 1000).toLocaleString('ru-RU')
        : 'Инструкции ещё не заполнены';
      $('instructions-status').textContent = data.instructions ? 'Загружено' : 'Пустые инструкции';
    } catch(error) {
      if (generation!==state.generation || !visible()) return;
      state.loaded = false; // Never overwrite an unread remote prompt with a blind save.
      $('instructions-status').textContent = 'Ошибка: ' + String(error.message || error);
    } finally {
      if (generation===state.generation && visible()) {
        state.loading = false;
        updateControls();
      }
    }
  }

  function confirmDiscard() {
    return !state.dirty || window.confirm('Отменить несохранённые изменения инструкций?');
  }
  function open(agentId) {
    if (!agentId || state.saving) return;
    if (visible() && !confirmDiscard()) return;
    if (!visible()) state.previousFocus = document.activeElement;
    state.agentId = agentId;
    state.saved = '';
    state.revision = 0;
    state.conflicted = false;
    state.loaded = false;
    state.dirty = false;
    $('instructions-text').value = '';
    $('instructions-title').textContent = 'Инструкции агента';
    $('instructions-overlay').hidden = false;
    document.body.classList.add('instructions-open');
    $('instructions-close').focus();
    void load();
  }
  function close() {
    if (!visible() || state.saving || !confirmDiscard()) return;
    ++state.generation;
    $('instructions-overlay').hidden = true;
    document.body.classList.remove('instructions-open');
    state.agentId = '';
    state.saved = '';
    state.revision = 0;
    state.conflicted = false;
    state.loaded = false;
    state.dirty = false;
    $('instructions-text').value = '';
    const previous = state.previousFocus;
    state.previousFocus = null;
    if (previous?.isConnected && typeof previous.focus==='function') previous.focus();
  }
  async function save() {
    if (!visible() || !state.loaded || state.loading || state.saving ||
        state.conflicted || !state.dirty) return;
    const value = $('instructions-text').value;
    if (byteSize(value)>MAX_BYTES) {
      $('instructions-status').textContent = 'Превышен лимит 128 KiB UTF-8';
      return;
    }
    const generation = state.generation;
    const agentId = state.agentId;
    const revision = state.revision;
    state.saving = true;
    $('instructions-status').textContent = 'Сохранение…';
    updateControls();
    try {
      const response = await fetch(endpoint(agentId), {
        method:'PUT',cache:'no-store',credentials:'same-origin',
        headers:{'Content-Type':'application/json','Accept':'application/json'},
        body:JSON.stringify({instructions:value,expected_revision:revision}),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        if(response.status===409) {
          state.conflicted = true;
          throw Error(CONFLICT_HELP);
        }
        throw Error(data.detail || 'HTTP '+response.status);
      }
      if (data.agent_id!==agentId || data.instructions!==value ||
          data.revision!==revision+1)
        throw Error('Сервер вернул некорректные инструкции');
      if (generation!==state.generation || !visible()) return;
      state.saved = value;
      state.revision = data.revision;
      state.conflicted = false;
      $('instructions-meta').textContent = 'Обновлено: ' +
        new Date(data.updated_at * 1000).toLocaleString('ru-RU');
      $('instructions-status').textContent = 'Инструкции сохранены';
    } catch(error) {
      if (generation===state.generation && visible())
        $('instructions-status').textContent = 'Ошибка сохранения: '+String(error.message||error);
    } finally {
      if (generation===state.generation && visible()) {
        state.saving = false;
        updateControls();
      }
    }
  }
  $('open-agent-instructions').addEventListener('click',() =>
    open($('open-agent-instructions').dataset.agentId));
  $('instructions-close').addEventListener('click',close);
  $('instructions-backdrop').addEventListener('click',close);
  $('instructions-text').addEventListener('input',() => updateControls(true));
  $('instructions-refresh').addEventListener('click',() => {
    if (confirmDiscard()) void load();
  });
  $('instructions-save').addEventListener('click',() => void save());
  $('instructions-copy').addEventListener('click',async()=>{
    if(!visible() || !state.loaded) return;
    try {
      await navigator.clipboard.writeText($('instructions-text').value);
      $('instructions-status').textContent='Черновик скопирован' +
        (state.conflicted ? '. ' + CONFLICT_HELP : '');
    } catch(error) {
      $('instructions-status').textContent='Не удалось скопировать. Выделите текст вручную.' +
        (state.conflicted ? ' ' + CONFLICT_HELP : '');
      $('instructions-text').focus();
      $('instructions-text').select();
    }
  });
  window.addEventListener('beforeunload',event=>{
    if (!visible() || (!state.dirty && !state.saving)) return;
    event.preventDefault();
    event.returnValue='';
  });
  document.addEventListener('keydown',event=>{
    if (!visible()) return;
    if (event.key==='Escape') {event.preventDefault();close();return;}
    if (event.key!=='Tab') return;
    const items=[...$('instructions-dialog').querySelectorAll(
      'button:not([disabled]),textarea:not([disabled])'
    )].filter(el=>!el.hidden);
    if (!items.length) return;
    if (event.shiftKey && document.activeElement===items[0]) {
      event.preventDefault();items[items.length-1].focus();
    } else if (!event.shiftKey && document.activeElement===items[items.length-1]) {
      event.preventDefault();items[0].focus();
    }
  });
})();
