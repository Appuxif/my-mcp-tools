/* Admin-only, read-only temporary Notes browser.
 * Lists only metadata; fetches description/subnotes after an explicit click.
 * All Note text is untrusted: render using textContent, never innerHTML.
 */
(() => {
  const $ = id => document.getElementById(id);
  const add = (parent, tag, className, value = '') => {
    const el = document.createElement(tag);
    if (className) el.className = className;
    el.textContent = String(value);
    parent.append(el);
    return el;
  };
  const date = value => Number.isFinite(value)
    ? new Date(value * 1000).toLocaleString('ru-RU')
    : '—';
  const labelStatus = value => value === 'finalized' ? 'Finalized' : 'Draft';
  const state = {
    page: 1, total: 0, generation: 0, listLoading: false, lastListAt: 0,
    noteId: '', detailGeneration: 0, previousFocus: null,
  };
  const visible = () => !$('notes-overlay').hidden;

  function showListError(message) {
    const body = $('notes-body');
    body.replaceChildren();
    const row = add(body, 'tr', '');
    const cell = add(row, 'td', 'table-empty', message);
    cell.colSpan = 4;
  }

  function renderList(items) {
    const body = $('notes-body');
    body.replaceChildren();
    if (!items.length) {
      showListError(state.total ? 'На этой странице записок нет.' : 'За последние 48 часов заметок нет.');
      return;
    }
    for (const note of items) {
      const row = add(body, 'tr', 'notes-table-row');
      const titleCell = add(row, 'td', '');
      const button = add(titleCell, 'button', 'notes-title-link', note.title);
      button.type = 'button';
      button.title = 'Открыть заметку';
      add(row, 'td',
        'notes-status-cell ' + (note.status === 'finalized' ? 'finalized' : 'draft'),
        labelStatus(note.status));
      const agentId = add(row, 'td', 'notes-agent-id', note.agent_id);
      agentId.title = note.agent_id;
      const created = add(row, 'td', 'notes-created-at', date(note.created_at));
      created.title = date(note.created_at);
      const open = () => openNote(note.note_id);
      button.addEventListener('click', event => {
        event.stopPropagation();
        open();
      });
      row.addEventListener('click', open);
    }
  }

  async function loadList() {
    if (state.listLoading) return;
    const generation = ++state.generation;
    const page = state.page;
    state.listLoading = true;
    $('notes-refresh').disabled = true;
    $('notes-prev').disabled = true;
    $('notes-next').disabled = true;
    try {
      const response = await fetch(new URL(
        '/api/v1/dashboard/notes?page=' + encodeURIComponent(page),
        location.origin,
      ).href, {
        method: 'GET', credentials: 'same-origin', cache: 'no-store',
        headers: {'Accept': 'application/json'},
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw Error(response.status === 401
        ? 'Нужна авторизация администратора'
        : payload.detail || 'HTTP ' + response.status);
      if (!Array.isArray(payload.items) || !Number.isInteger(payload.total) ||
          !Number.isInteger(payload.page) || payload.page !== page) {
        throw Error('Некорректный ответ сервера');
      }
      if (generation !== state.generation) return;
      state.total = payload.total;
      const pages = Math.max(1, Math.ceil(state.total / 20));
      $('notes-count').textContent = String(state.total);
      $('notes-total').textContent = 'Заметок за 48 часов: ' + state.total + ' · 20 на странице';
      $('notes-page').textContent = page + ' / ' + pages;
      renderList(payload.items);
      $('notes-prev').disabled = page <= 1;
      $('notes-next').disabled = page >= pages;
      state.lastListAt = Date.now();
    } catch (error) {
      if (generation !== state.generation) return;
      showListError('Не удалось загрузить заметки: ' + String(error.message || error));
    } finally {
      if (generation === state.generation) {
        state.listLoading = false;
        $('notes-refresh').disabled = false;
      }
    }
  }

  function fillNote(note) {
    $('note-title').textContent = note.title;
    $('note-meta').textContent =
      'note_id: ' + note.note_id +
      ' · agent_id: ' + note.agent_id +
      (note.agent_name ? ' (' + note.agent_name + ')' : '') +
      ' · создана: ' + date(note.created_at) +
      ' · истекает: ' + date(note.expires_at);
    $('notes-detail-status').textContent = labelStatus(note.status) +
      (note.finalized_at ? ' · финализирована: ' + date(note.finalized_at) : '');
    $('note-description').textContent = note.description || 'Нет описания.';
    $('note-subnotes-count').textContent = String(note.subnotes.length);
    const container = $('note-subnotes');
    container.replaceChildren();
    if (!note.subnotes.length) {
      add(container, 'div', 'list-empty', 'Дочерних заметок пока нет.');
      return;
    }
    note.subnotes.forEach((child, index) => {
      const entry = add(container, 'article', 'notes-subnote');
      add(entry, 'div', 'notes-subnote-index', String(index + 1).padStart(2, '0'));
      const content = add(entry, 'div', 'notes-subnote-body');
      add(content, 'h5', '', child.title);
      add(content, 'div', 'notes-text', child.description || 'Нет описания.');
    });
  }

  async function loadDetail() {
    if (!visible() || !state.noteId) return;
    const generation = ++state.detailGeneration;
    const id = state.noteId;
    $('notes-detail-refresh').disabled = true;
    $('notes-detail-status').textContent = 'Загрузка…';
    try {
      const response = await fetch(new URL(
        '/api/v1/dashboard/notes/' + encodeURIComponent(id), location.origin,
      ).href, {
        method: 'GET', credentials: 'same-origin', cache: 'no-store',
        headers: {'Accept': 'application/json'},
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw Error(response.status === 404
        ? 'Записка не найдена или срок её хранения истёк'
        : response.status === 401 ? 'Нужна авторизация администратора'
          : payload.detail || 'HTTP ' + response.status);
      if (payload.note_id !== id || !Array.isArray(payload.subnotes) ||
          typeof payload.description !== 'string') {
        throw Error('Некорректный ответ сервера');
      }
      if (generation !== state.detailGeneration || !visible() || id !== state.noteId) return;
      fillNote(payload);
    } catch (error) {
      if (generation !== state.detailGeneration || !visible()) return;
      $('notes-detail-status').textContent = 'Ошибка';
      $('note-description').textContent = String(error.message || error);
      $('note-subnotes').replaceChildren();
      $('note-subnotes-count').textContent = '0';
    } finally {
      if (generation === state.detailGeneration && visible()) {
        $('notes-detail-refresh').disabled = false;
      }
    }
  }

  function openNote(id) {
    if (!id) return;
    if (!visible()) state.previousFocus = document.activeElement;
    state.noteId = id;
    ++state.detailGeneration;
    $('note-title').textContent = 'Заметка';
    $('note-meta').textContent = 'note_id: ' + id;
    $('notes-detail-status').textContent = 'Загрузка…';
    $('note-description').textContent = 'Загрузка…';
    $('note-subnotes-count').textContent = '0';
    $('note-subnotes').replaceChildren();
    $('notes-overlay').hidden = false;
    document.body.classList.add('notes-open');
    $('notes-detail-scroll').scrollTop = 0;
    $('notes-close').focus();
    void loadDetail();
  }

  function closeNote() {
    if (!visible()) return;
    ++state.detailGeneration;
    $('notes-overlay').hidden = true;
    document.body.classList.remove('notes-open');
    state.noteId = '';
    $('note-subnotes').replaceChildren();
    const previous = state.previousFocus;
    state.previousFocus = null;
    if (previous?.isConnected) previous.focus();
    else $('notes-refresh').focus();
  }

  $('notes-refresh').addEventListener('click', () => void loadList());
  $('notes-prev').addEventListener('click', () => {
    if (state.listLoading || state.page <= 1) return;
    state.page--;
    void loadList();
  });
  $('notes-next').addEventListener('click', () => {
    if (state.listLoading || state.page >= Math.max(1, Math.ceil(state.total / 20))) return;
    state.page++;
    void loadList();
  });
  $('notes-close').addEventListener('click', closeNote);
  $('notes-backdrop').addEventListener('click', closeNote);
  $('notes-detail-refresh').addEventListener('click', () => void loadDetail());
  document.addEventListener('keydown', event => {
    if (!visible()) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      closeNote();
      return;
    }
    if (event.key !== 'Tab') return;
    const buttons = [...$('notes-dialog').querySelectorAll('button:not([disabled])')];
    if (!buttons.length) return;
    if (event.shiftKey && document.activeElement === buttons[0]) {
      event.preventDefault();
      buttons[buttons.length - 1].focus();
    } else if (!event.shiftKey && document.activeElement === buttons[buttons.length - 1]) {
      event.preventDefault();
      buttons[0].focus();
    }
  });

  // Dashboard emits a snapshot every ~3s; refresh this lightweight table
  // at most every 12s, without touching the currently open dialog.
  document.addEventListener('agent-network:snapshot', () => {
    if (!state.listLoading && Date.now() - state.lastListAt > 12000) void loadList();
  });
  void loadList();
})();
