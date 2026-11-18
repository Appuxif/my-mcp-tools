const $ = id => document.getElementById(id);
const fields = ['name', 'role', 'purpose', 'description'];
let tabId;
let knownAgents=[];
let ownAgent=null;
let confirmedPreview=null;
let adminReady=false;
let selectedTeams=[];
let availableTeams=[];
const show = text => { $('status').textContent = text; };
const nameKey = name => name.trim().toLocaleLowerCase();
// Datalist values must be unique even if stale local records share a name.
const agentOption = agent => knownAgents.filter(a=>a.name===agent.name).length>1
  ? agent.name+' ['+agent.agentId+']' : agent.name;
const chosenAgent = () => knownAgents.find(a=>agentOption(a)===$('name').value.trim());
function renderTeamEditor() {
  const box=$('team-members');
  box.replaceChildren();
  for (const name of selectedTeams) {
    const button=document.createElement('button');
    button.type='button';
    button.className='team-chip';
    button.textContent=name+(adminReady && ownAgent ? ' ×' : '');
    button.disabled=!adminReady || !ownAgent;
    if(!button.disabled) button.addEventListener('click',()=>{
      selectedTeams=selectedTeams.filter(other=>nameKey(other)!==nameKey(name));
      renderTeamEditor();
    });
    box.append(button);
  }
  const editable=!!adminReady && !!ownAgent;
  $('team-name').disabled=!editable;
  $('team-add').disabled=!editable;
  $('team-save').disabled=!editable || selectedTeams.length===0;
}
function updateTeamOptions(items) {
  availableTeams=Array.isArray(items)?items:[];
  const list=$('known-teams');
  list.replaceChildren();
  for (const team of availableTeams) {
    const option=document.createElement('option');
    option.value=team.name;
    list.append(option);
  }
}
async function refreshAdmin() {
  try {
    const data=await request('network:admin-status');
    adminReady=!!data.configured;
    updateTeamOptions(data.teams);
    selectedTeams=adminReady
      ? (data.agentTeams || []).map(t=>t.name)
      : (ownAgent?.teams || []).map(t=>t.name);
    $('admin-info').textContent=adminReady
      ? 'Администратор подключён. Управление командами доступно.'
      : 'Нет admin-token для этого сервера. Членство доступно только для просмотра.';
  } catch(error) {
    adminReady=false;
    selectedTeams=(ownAgent?.teams || []).map(t=>t.name);
    updateTeamOptions([]);
    $('admin-info').textContent='Ошибка авторизации: '+String(error.message||error);
  }
  renderTeamEditor();
}
const cancelPreview = () => {
  confirmedPreview=null;
  $('migration-confirm').hidden=true;
};
function fillExisting() {
  if (ownAgent) return;
  cancelPreview();
  const candidate=chosenAgent();
  if (candidate) {
    for(const field of ['role','purpose','description']) $(field).value=candidate[field]||'';
    for(const field of ['role','purpose','description']) $(field).disabled=true;
    $('agent-source').textContent='Существующий агент · текущий чат: '+candidate.chatUrl+
      ' · Профиль сохранится без изменений.';
  } else {
    for(const field of ['role','purpose','description']) $(field).disabled=false;
    $('agent-source').textContent='Новое имя создаст агента после авторизации admin-token. Имя из списка перенесёт существующего.';
  }
}
function updateOptions(items) {
  knownAgents=Array.isArray(items)?items:[];
  const data=$('known-agents');
  data.replaceChildren();
  for(const agent of knownAgents) {
    const option=document.createElement('option');
    option.value=agentOption(agent);
    option.label=agent.role||agent.name;
    data.append(option);
  }
}

async function request(type, extra = {}) {
  const response = await chrome.runtime.sendMessage({ type, tabId, ...extra });
  if (!response?.ok) throw Error(response?.error || 'Ошибка расширения');
  return response;
}
async function refresh() {
  try {
    const s = await request('network:status');
    $('server').value = s.server;
    $('show-hud').disabled = !s.entry;
    $('repeat-bootstrap').disabled = !s.entry;
    $('agent-id-row').hidden = !s.entry;
    $('agent-token-row').hidden = !s.entry;
    $('agent-id').value = s.entry?.agentId || '';
    ownAgent=s.entry||null;
    const list=await request('network:available-agents');
    if(list.removedCurrent) return refresh(); // DB deletion invalidated this chat's old binding.
    updateOptions(list.items);
    if (s.entry) {
      for (const field of fields) $(field).value = s.entry[field] || '';
      for(const field of ['role','purpose','description']) $(field).disabled=false;
      $('name').disabled = true;
      $('agent-source').textContent='Этот чат уже привязан к агенту.';
    } else {
      $('name').disabled = false;
      fillExisting();
    }
    show(s.entry
      ? [s.entry.name + ' · ' + (s.entry.active ? 'включён' : 'остановлен'),
         'WebSocket: ' + (s.connected ? 'подключён' : 'отключён'),
         'Состояние: ' + (s.ui?.state || 'неизвестно'),
         'Сеть: ' + (s.ui?.network || 'нет данных') +
           ' · ' + (s.ui?.activeRequests ?? 0) + ' запросов',
         s.entry.bootstrapDone ? '' : 'Требуется инициализация чата'].filter(Boolean).join('\n')
      : 'Этот чат пока не привязан к агенту. Выбери существующего по имени для переноса или создай нового.');
    await refreshAdmin();
  } catch (e) { show(String(e.message || e)); }
}
function parseServer(raw) {
  const u = new URL(raw.trim());
  if (!['https:', 'http:'].includes(u.protocol) || u.username || u.password ||
      u.search || u.hash || !['', '/'].includes(u.pathname))
    throw Error('Укажи URL сервера без пути, логина, параметров и #.');
  const local = u.hostname === 'localhost' || u.hostname === '127.0.0.1' ||
    u.hostname === '[::1]' || /^10[.][0-9]+[.][0-9]+[.][0-9]+$/.test(u.hostname) ||
    /^192[.]168[.][0-9]+[.][0-9]+$/.test(u.hostname) ||
    /^172[.](1[6-9]|2[0-9]|3[01])[.][0-9]+[.][0-9]+$/.test(u.hostname);
  if (u.protocol === 'http:' && !local)
    throw Error('Для публичного удалённого сервера требуется HTTPS.');
  return u.origin;
}
async function grantOrigin(server) {
  const origin = parseServer(server) + '/*';
  const already = await chrome.permissions.contains({origins:[origin]});
  if (!already) {
    const granted = await chrome.permissions.request({origins:[origin]});
    if (!granted) throw Error('Доступ к выбранному серверу не разрешён.');
  }
}
document.addEventListener('DOMContentLoaded', async () => {
  const [tab] = await chrome.tabs.query({active:true,currentWindow:true});
  tabId = tab?.id;
  if (!tabId) {
    show('Не удалось определить активную вкладку.');
    return;
  }
  $('save-server').addEventListener('click', async () => {
    $('save-server').disabled = true;
    try {
      const url = parseServer($('server').value);
      await grantOrigin(url);
      const res = await request('network:set-server', {server:url});
      await refresh();
      if (res.changed) show('Адрес сервера обновлён. Остановленная привязка к предыдущему серверу сброшена.');
    } catch (e) { show(String(e.message || e)); }
    finally { $('save-server').disabled = false; }
  });
  $('open-dashboard').addEventListener('click', async () => {
    try { await request('network:open-dashboard'); }
    catch (e) { show(String(e.message || e)); }
  });
  $('show-hud').addEventListener('click', async () => {
    $('show-hud').disabled=true;
    try {
      await request('network:show-hud');
      show('Плавающее окно открыто для этой беседы.');
    } catch (e) { show(String(e.message || e)); }
    finally { $('show-hud').disabled=false; }
  });
  $('admin-connect').addEventListener('click', async()=>{
    $('admin-connect').disabled=true;
    try {
      const secret=$('admin-token').value.trim();
      await request('network:admin-connect',{adminToken:secret});
      $('admin-token').value=''; // Never leave the secret in popup DOM.
      await refreshAdmin();
    } catch(error) {
      $('admin-info').textContent='Ошибка: '+String(error.message||error);
    } finally { $('admin-connect').disabled=false; }
  });
  $('admin-clear').addEventListener('click', async()=>{
    try {
      await request('network:admin-clear');
      $('admin-token').value='';
      await refreshAdmin();
    } catch(error) { $('admin-info').textContent=String(error.message||error); }
  });
  $('team-add').addEventListener('click',()=>{
    const raw=$('team-name').value.trim();
    const known=availableTeams.find(t=>nameKey(t.name)===nameKey(raw));
    const name=known?.name || raw;
    if(!name || name.length>64 || /[\x00-\x1f,]/.test(name) ||
       selectedTeams.length>=12) {
      $('admin-info').textContent='Необходимо имя команды до 64 символов (максимум 12).';
      return;
    }
    if(!selectedTeams.some(existing=>nameKey(existing)===nameKey(name)))
      selectedTeams.push(name);
    $('team-name').value='';
    renderTeamEditor();
  });
  $('team-name').addEventListener('keydown',event=>{
    if(event.key==='Enter') {
      event.preventDefault();
      $('team-add').click();
    }
  });
  $('team-save').addEventListener('click',async()=>{
    $('team-save').disabled=true;
    try {
      const result=await request('network:admin-set-teams',{teams:selectedTeams});
      selectedTeams=(result.agent.teams||[]).map(t=>t.name);
      await refreshAdmin();
      $('admin-info').textContent='Команды агента сохранены.';
    } catch(error) {
      $('admin-info').textContent='Ошибка сохранения: '+String(error.message||error);
      renderTeamEditor();
    }
  });
  $('name').addEventListener('input', fillExisting);
  for(const field of ['role','purpose','description'])
    $(field).addEventListener('input', cancelPreview);
  $('cancel-migration').addEventListener('click', () => {
    cancelPreview();
    show('Перенос отменён. Исходный агент остался в прежнем чате.');
  });
  $('confirm-migration').addEventListener('click', async () => {
    if(!confirmedPreview) return;
    const preview=confirmedPreview;
    $('confirm-migration').disabled=true;
    $('start').disabled=true;
    try {
      show('Инициализирую агента в новом чате и переношу PUSH…');
      const result=await request('network:migrate',{
        agentId:preview.agentId,fromChatUrl:preview.fromChatUrl,
        expectedDestination:preview.toChatUrl,
      });
      cancelPreview();
      await refresh();
      show('Агент '+result.name+' перенесён в новый чат. ID и история Agent Network сохранены.'+
        (result.connectionWarning ? '\n'+result.connectionWarning : ''));
    } catch(error) { show(String(error.message||error)); }
    finally {
      $('confirm-migration').disabled=false;
      $('start').disabled=false;
    }
  });
  $('start').addEventListener('click', async () => {
    $('start').disabled = true;
    try {
      const candidate=!ownAgent ? chosenAgent() : null;
      const profile = Object.fromEntries(fields.map(f => [f, $(f).value.trim()]));
      if(candidate) profile.name=candidate.name;
      if (!profile.name || !profile.role) throw Error('Укажи имя и роль.');
      if(!candidate && [...profile.name].length>64)
        throw Error('Имя нового агента не должно превышать 64 символа.');
      if(!candidate && knownAgents.some(agent=>agent.name===profile.name))
        throw Error('Выбери агента с конкретным Agent ID из списка.');
      if(candidate) {
        const preview=await request('network:migration-preview',{
          name:candidate.name,agentId:candidate.agentId,
        });
        confirmedPreview=preview;
        $('migration-description').textContent=
          'Перенести '+preview.name+' из '+preview.fromChatUrl+
          ' в этот чат? Старый чат перестанет получать PUSH-сообщения.';
        $('migration-confirm').hidden=false;
        show('Проверь перенос и нажми «Подтвердить перенос».');
        return;
      }
      cancelPreview();
      show('Регистрирую агента…');
      await request('network:start', {profile});
      await refresh();
    } catch (e) { show(String(e.message || e)); }
    finally { $('start').disabled = false; }
  });
  $('copy-agent-id').addEventListener('click', async () => {
    if(!ownAgent?.agentId)return;
    try {
      await navigator.clipboard.writeText(ownAgent.agentId);
      show('Agent ID скопирован.');
    } catch(error) {
      $('agent-id').focus();
      $('agent-id').select();
      show('Выделен Agent ID. Скопируйте его вручную.');
    }
  });
  $('agent-token-apply').addEventListener('click', async () => {
    if(!ownAgent?.agentId)return;
    const token=$('agent-token-new').value.trim();
    if(!token) {show('Вставьте новый токен.');return;}
    $('agent-token-apply').disabled=true;
    try {
      await request('network:update-token',{token});
      $('agent-token-new').value='';
      show('Токен расширения обновлён. Отправьте агенту новые credentials или нажмите «Напомнить агенту контекст».');
    } catch(error) {
      show('Ошибка обновления токена: '+String(error.message||error));
    } finally {
      $('agent-token-apply').disabled=false;
    }
  });
  $('repeat-bootstrap').addEventListener('click', async () => {
    if(!ownAgent?.agentId)return;
    $('repeat-bootstrap').disabled=true;
    try {
      await request('network:repeat-bootstrap');
      show('Стартовое сообщение с данными агента повторно отправлено в чат.');
    } catch(error) {
      show('Не удалось отправить инструкции: '+String(error.message||error));
    } finally {
      $('repeat-bootstrap').disabled=false;
    }
  });
  $('stop').addEventListener('click', async () => {
    try { await request('network:stop'); await refresh(); }
    catch (e) { show(String(e.message || e)); }
  });
  if (!tab?.url?.startsWith('https://chatgpt.com/')) $('start').disabled = true;
  await refresh();
});
