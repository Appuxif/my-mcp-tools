const $ = id => document.getElementById(id);
const fields = ['name', 'role', 'purpose', 'description'];
let tabId;
const show = text => { $('status').textContent = text; };
async function request(type, extra = {}) {
  const response = await chrome.runtime.sendMessage({ type, tabId, ...extra });
  if (!response?.ok) throw Error(response?.error || 'Ошибка расширения');
  return response;
}
async function refresh() {
  try {
    const s = await request('network:status');
    $('server').value = s.server;
    if (s.entry) {
      for (const field of fields) $(field).value = s.entry[field] || '';
      $('name').disabled = true;
    } else {
      $('name').disabled = false;
    }
    show(s.entry
      ? [s.entry.name + ' · ' + (s.entry.active ? 'включён' : 'остановлен'),
         'WebSocket: ' + (s.connected ? 'подключён' : 'отключён'),
         'Состояние: ' + (s.ui?.state || 'неизвестно'),
         'Сеть: ' + (s.ui?.network || 'нет данных') +
           ' · ' + (s.ui?.activeRequests ?? 0) + ' запросов',
         s.entry.bootstrapDone ? '' : 'Требуется инициализация чата'].filter(Boolean).join('\n')
      : 'Агент не зарегистрирован. Для регистрации откройте чат ChatGPT и нажмите Старт.');
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
  $('start').addEventListener('click', async () => {
    $('start').disabled = true;
    try {
      const profile = Object.fromEntries(fields.map(f => [f, $(f).value.trim()]));
      if (!profile.name || !profile.role) throw Error('Укажи имя и роль.');
      show('Регистрирую агента…');
      await request('network:start', {profile});
      await refresh();
    } catch (e) { show(String(e.message || e)); }
    finally { $('start').disabled = false; }
  });
  $('stop').addEventListener('click', async () => {
    try { await request('network:stop'); await refresh(); }
    catch (e) { show(String(e.message || e)); }
  });
  if (!tab?.url?.startsWith('https://chatgpt.com/')) $('start').disabled = true;
  await refresh();
});
