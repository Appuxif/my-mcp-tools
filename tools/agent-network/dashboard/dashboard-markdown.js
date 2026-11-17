/* Safe Markdown subset (CommonMark/GFM): headings, lists, checkboxes, tables,
 * links, emphasis, quotes and code. Never parse untrusted HTML into DOM.
 */
(() => {
  const make = (root, tag) => {
    const item = document.createElement(tag);
    root.append(item);
    return item;
  };
  const plain = (root, value) => {
    if (value) root.append(document.createTextNode(value));
  };
  const safeUrl = url => /^(https?:\/\/[^\s]+|mailto:[^@\s]+@[^\s]+)$/i.test(url);

  function inline(root, value, depth = 0) {
    if (depth > 10) { plain(root, value); return; }
    let index = 0, pending = '';
    const flush = () => { plain(root, pending); pending = ''; };
    while (index < value.length) {
      const ch = value[index];
      if (ch === '\\' && index + 1 < value.length &&
          /[\\*_~\x60\[\]()!<>|]/.test(value[index + 1])) {
        pending += value[index + 1]; index += 2; continue;
      }
      if (ch === '\x60') {
        const close = value.indexOf('\x60', index + 1);
        if (close > index + 1) {
          flush();
          plain(make(root, 'code'), value.slice(index + 1, close).replace(/\n/g, ' '));
          index = close + 1; continue;
        }
      }
      if (ch === '[' || (ch === '!' && value[index + 1] === '[')) {
        const image = ch === '!';
        const start = index + (image ? 2 : 1);
        const close = value.indexOf('](', start);
        const target = close > start ? value.slice(close + 2).match(/^([^\s()]+)\)/) : null;
        if (target && safeUrl(target[1])) {
          flush();
          const link = make(root, 'a');
          link.href = target[1];
          link.target = '_blank';
          link.rel = 'noopener noreferrer';
          if (image) plain(link, '[изображение] ');
          inline(link, value.slice(start, close), depth + 1);
          index = close + 2 + target[0].length;
          continue;
        }
      }
      if (ch === '<') {
        const auto = value.slice(index).match(/^<((?:https?:\/\/|mailto:)[^<>\s]+)>/i);
        if (auto && safeUrl(auto[1])) {
          flush();
          const link = make(root, 'a');
          link.href = auto[1];
          link.target = '_blank';
          link.rel = 'noopener noreferrer';
          plain(link, auto[1]);
          index += auto[0].length; continue;
        }
      }
      const marker = value.startsWith('**', index) ? '**' :
        value.startsWith('__', index) ? '__' :
        value.startsWith('~~', index) ? '~~' :
        ch === '*' || ch === '_' ? ch : '';
      if (marker) {
        const close = value.indexOf(marker, index + marker.length);
        const part = close < 0 ? '' : value.slice(index + marker.length, close);
        if (part && !/^\s|\s$/.test(part)) {
          flush();
          inline(make(root, marker === '~~' ? 'del' :
            marker.length === 2 ? 'strong' : 'em'), part, depth + 1);
          index = close + marker.length; continue;
        }
      }
      if (ch === '\n') {
        flush();
        make(root, 'br');
        index++; continue;
      }
      pending += ch;
      index++;
    }
    flush();
  }

  const fence = line => line.match(/^\s{0,3}([\x60~]{3,})\s*([^\s\x60~]*)?.*$/);
  const title = line => line.match(/^\s{0,3}(#{1,6})[ \t]+(.+?)\s*#*\s*$/);
  const hr = line => /^\s{0,3}(?:(?:-\s*){3,}|(?:\*\s*){3,}|(?:_\s*){3,})$/.test(line);
  const quote = line => /^\s{0,3}>\s?/.test(line);
  const item = line => line.match(/^(\s{0,12})([-+*]|\d+[.)])[ \t]+(.*)$/);
  const cells = line => line.trim().replace(/^\|/, '').replace(/\|$/, '')
    .split(/(?<!\\)\|/).map(part => part.trim().replace(/\\\|/g, '|'));
  const divider = line => line.includes('|') &&
    cells(line).every(part => /^:?-{3,}:?$/.test(part));
  const isBlock = (lines, i) => fence(lines[i]) || title(lines[i]) ||
    hr(lines[i]) || quote(lines[i]) || item(lines[i]) ||
    (lines[i].includes('|') && i + 1 < lines.length && divider(lines[i + 1]));

  function renderList(root, lines, start) {
    const first = item(lines[start]);
    const level = first[1].length;
    const ordered = /^\d/.test(first[2]);
    const node = make(root, ordered ? 'ol' : 'ul');
    if (ordered) node.start = Number.parseInt(first[2], 10);
    let i = start, last = null;
    while (i < lines.length) {
      const match = item(lines[i]);
      if (!match || match[1].length < level) break;
      if (match[1].length > level) {
        if (!last) break;
        const next = renderList(last, lines, i);
        if (next <= i) break;
        i = next; continue;
      }
      if (/^\d/.test(match[2]) !== ordered) break;
      last = make(node, 'li');
      let body = match[3];
      const check = body.match(/^\[([ xX])\]\s+(.*)$/);
      if (check) {
        const cb = make(last, 'input');
        cb.type = 'checkbox';
        cb.checked = check[1].toLowerCase() === 'x';
        cb.disabled = true;
        body = check[2];
      }
      inline(last, body);
      i++;
      if (i < lines.length && !lines[i].trim()) break;
    }
    return i;
  }

  function renderBlocks(root, source, depth = 0) {
    if (depth > 8) { plain(root, source); return; }
    const lines = source.replace(/\r\n?/g, '\n').split('\n');
    let i = 0;
    while (i < lines.length) {
      if (!lines[i].trim()) { i++; continue; }
      const start = fence(lines[i]);
      if (start) {
        const marker = start[1], code = [];
        const close = new RegExp('^\\s{0,3}' + marker[0] +
          '{' + marker.length + ',}\\s*$');
        i++;
        while (i < lines.length && !close.test(lines[i])) code.push(lines[i++]);
        if (i < lines.length) i++;
        const pre = make(root, 'pre');
        if (start[2]) pre.dataset.language = start[2].slice(0, 32);
        plain(make(pre, 'code'), code.join('\n'));
        continue;
      }
      const heading = title(lines[i]);
      if (heading) {
        inline(make(root, 'h' + heading[1].length), heading[2]);
        i++; continue;
      }
      if (hr(lines[i])) { make(root, 'hr'); i++; continue; }
      if (quote(lines[i])) {
        const linesInQuote = [];
        while (i < lines.length && quote(lines[i]))
          linesInQuote.push(lines[i++].replace(/^\s{0,3}>\s?/, ''));
        renderBlocks(make(root, 'blockquote'), linesInQuote.join('\n'), depth + 1);
        continue;
      }
      if (i + 1 < lines.length && lines[i].includes('|') && divider(lines[i + 1])) {
        const header = cells(lines[i]), table = make(root, 'table');
        const head = make(make(table, 'thead'), 'tr');
        header.forEach(value => inline(make(head, 'th'), value));
        const body = make(table, 'tbody');
        i += 2;
        while (i < lines.length && lines[i].trim() && lines[i].includes('|')) {
          const row = make(body, 'tr'), columns = cells(lines[i++]);
          for (let n = 0; n < header.length; n++)
            inline(make(row, 'td'), columns[n] || '');
        }
        continue;
      }
      if (item(lines[i])) {
        const next = renderList(root, lines, i);
        if (next > i) { i = next; continue; }
      }
      const paragraph = [lines[i++]];
      while (i < lines.length && lines[i].trim() && !isBlock(lines, i))
        paragraph.push(lines[i++]);
      inline(make(root, 'p'), paragraph.join('\n'));
    }
  }

  window.AgentNetworkMarkdown = Object.freeze({
    render(container, markdown) {
      container.replaceChildren();
      renderBlocks(container, String(markdown || ''));
    },
  });
})();
