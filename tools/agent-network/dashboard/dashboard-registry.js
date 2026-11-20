/* Explicit admin-only agent creation. A token is displayed once and is never
 * persisted in localStorage or included in the normal dashboard snapshot.
 */
(() => {
  const $ = id => document.getElementById(id);
  const state = {opened:false,creating:false,teams:['default'],known:[],
                 credentials:null,previousFocus:null};
  const visible = () => !$('registry-overlay').hidden;
  const normalize = text => String(text || '').trim().toLocaleLowerCase();
  const setStatus = text => {
    if (state.credentials) $('registry-result-status').textContent = text;
    else $('registry-form-status').textContent = text;
  };
  const env = () => {
    if (!state.credentials) return '';
    const {name, agent_id, token} = state.credentials;
    return '# Private Agent Network identity; chmod 600; never commit\n' +
      'AGENT_NETWORK_AGENT_ID=' + agent_id + '\n' +
      'AGENT_NETWORK_TOKEN=' + token + '\n' +
      'AGENT_NETWORK_AGENT_NAME=' + name + '\n';
  };
  function renderChips() {
    const area = $('registry-team-chips');
    area.replaceChildren();
    for (const name of state.teams) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'registry-team-chip';
      button.textContent = name + ' ×';
      button.title = 'Убрать команду';
      button.addEventListener('click', () => {
        if (state.teams.length <= 1) {
          setStatus('Агент должен состоять хотя бы в одной команде.');
          return;
        }
        state.teams = state.teams.filter(x => normalize(x) !== normalize(name));
        renderChips();
      });
      area.append(button);
    }
  }
  function addTeam() {
    const field = $('registry-team-name');
    const raw = field.value.trim();
    if (!raw || raw.length > 64 || /[\x00-\x1f\x7f,]/.test(raw)) {
      setStatus('Имя команды должно содержать 1–64 символа без запятых.');
      return;
    }
    const name = state.known.find(x => normalize(x.name) === normalize(raw))?.name || raw;
    if (state.teams.some(x => normalize(x) === normalize(name))) {
      field.value = ''; return;
    }
    if (state.teams.length >= 12) {
      setStatus('Допустимо не более 12 команд.');
      return;
    }
    state.teams.push(name);
    field.value = '';
    renderChips();
  }
  async function fetchTeams() {
    try {
      const response = await fetch(new URL('/api/v1/dashboard/teams',location.origin).href,
        {cache:'no-store',credentials:'same-origin'});
      if (!response.ok) throw Error('HTTP ' + response.status);
      const data = await response.json();
      if (!visible()) return;
      state.known = Array.isArray(data.items) ? data.items : [];
      const list = $('registry-known-teams');
      list.replaceChildren();
      for (const team of state.known) {
        const option = document.createElement('option');
        option.value = team.name;
        list.append(option);
      }
    } catch (error) {
      if (visible()) setStatus('Не удалось загрузить список команд: ' + String(error.message || error));
    }
  }
  function open() {
    if (visible()) return;
    state.previousFocus = document.activeElement;
    state.credentials = null;
    state.creating = false;
    state.known = [];
    state.teams = ['default'];
    $('registry-form').reset();
    $('registry-kind').value = 'codex';
    $('registry-form').hidden = false;
    $('registry-result').hidden = true;
    $('registry-id-result').value = '';
    $('registry-token-result').value = '';
    $('registry-form-status').textContent = 'Токен показывается только при создании.';
    $('registry-result-status').textContent = '';
    $('registry-submit').disabled = false;
    $('registry-overlay').hidden = false;
    document.body.classList.add('registry-open');
    renderChips();
    $('registry-name').focus();
    void fetchTeams();
  }
  function close() {
    if (!visible() || state.creating) return;
    $('registry-overlay').hidden = true;
    document.body.classList.remove('registry-open');
    $('registry-id-result').value = '';
    $('registry-token-result').value = '';
    $('registry-result-status').textContent = '';
    $('registry-form').reset();
    state.credentials = null;
    state.known = [];
    state.teams = [];
    const previous = state.previousFocus;
    state.previousFocus = null;
    if (previous?.isConnected && typeof previous.focus === 'function') previous.focus();
  }
  async function create(event) {
    event.preventDefault();
    if (state.creating || state.credentials || !state.teams.length) return;
    const payload = {
      name:$('registry-name').value.trim(),
      role:$('registry-role').value.trim(),
      kind:$('registry-kind').value,
      purpose:$('registry-purpose').value.trim(),
      description:$('registry-description').value.trim(),
      instructions:$('registry-instructions').value,
      teams:[...state.teams],
    };
    if (!payload.name || !payload.role) {
      setStatus('Заполните имя и роль агента.');
      return;
    }
    if(new TextEncoder().encode(payload.instructions).length>131072) {
      setStatus('Инструкции не должны превышать 128 KiB UTF-8.');
      return;
    }
    state.creating = true;
    $('registry-submit').disabled = true;
    setStatus('Создаю агента…');
    try {
      const response = await fetch(new URL('/api/v1/dashboard/agents',location.origin).href,{
        method:'POST',cache:'no-store',credentials:'same-origin',
        headers:{'Content-Type':'application/json','Accept':'application/json'},
        body:JSON.stringify(payload),
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw Error(result.detail || 'HTTP ' + response.status);
      if (result.created !== true || !result.agent?.agent_id ||
          !result.token || result.agent?.name !== payload.name) {
        throw Error('Сервер вернул некорректные credentials.');
      }
      state.credentials = {name:result.agent.name,agent_id:result.agent.agent_id,
                           token:result.token};
      $('registry-id-result').value = state.credentials.agent_id;
      $('registry-token-result').value = state.credentials.token;
      $('registry-teams-result').textContent = 'Команды: ' +
        (result.agent.teams || []).map(t=>t.name).join(', ');
      $('registry-form').hidden = true;
      $('registry-result').hidden = false;
      $('registry-result-status').textContent = 'Сохраните данные перед закрытием окна.';
      $('registry-copy-token').focus();
      document.dispatchEvent(new CustomEvent('agent-network:refresh'));
    } catch (error) {
      setStatus('Ошибка: ' + String(error.message || error));
    } finally {
      state.creating = false;
      $('registry-submit').disabled = false;
    }
  }
  async function copy(value) {
    if (!state.credentials) return;
    try {
      await navigator.clipboard.writeText(value);
      setStatus('Скопировано.');
    } catch {
      setStatus('Копирование недоступно. Выделите текст вручную.');
    }
  }
  function downloadEnv() {
    if (!state.credentials) return;
    const file = new Blob([env()],{type:'text/plain;charset=utf-8'});
    const url = URL.createObjectURL(file);
    const link = document.createElement('a');
    link.href = url;
    link.download = '.agent.env';
    document.body.append(link);
    link.click();
    link.remove();
    // The browser has started the download; release the temporary object URL.
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    setStatus('Файл .agent.env подготовлен. Храните его вне Git, chmod 600.');
  }

  $('agent-create-open').addEventListener('click',open);
  $('registry-close').addEventListener('click',close);
  $('registry-backdrop').addEventListener('click',close);
  $('registry-form').addEventListener('submit',event=>void create(event));
  $('registry-team-add').addEventListener('click',addTeam);
  $('registry-team-name').addEventListener('keydown',event=>{
    if(event.key === 'Enter') {event.preventDefault();addTeam();}
  });
  $('registry-copy-id').addEventListener('click',()=>void copy(state.credentials?.agent_id));
  $('registry-copy-token').addEventListener('click',()=>void copy(state.credentials?.token));
  $('registry-copy-env').addEventListener('click',()=>void copy(env()));
  $('registry-download-env').addEventListener('click',downloadEnv);
  document.addEventListener('keydown',event=>{
    if (!visible()) return;
    if (event.key==='Escape') {event.preventDefault();close();}
    if (event.key!=='Tab') return;
    const nodes=[...$('registry-dialog').querySelectorAll(
      'button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled])'
    )].filter(node=>!node.hidden && !node.closest('[hidden]'));
    if (!nodes.length) return;
    const first=nodes[0], last=nodes[nodes.length-1];
    if(event.shiftKey && document.activeElement===first){
      event.preventDefault();last.focus();
    }else if(!event.shiftKey && document.activeElement===last){
      event.preventDefault();first.focus();
    }
  });
})();
