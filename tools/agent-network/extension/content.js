/* Minimal, reversible ChatGPT UI adapter. No MCP calls, no conversation scraping. */
(() => {
  if (globalThis.__agentNetworkContent) return;
  globalThis.__agentNetworkContent = true;

  const editorSelectors = [
    '[data-chatgpt-composer] [data-composer-markdown][contenteditable="true"]',
    '#prompt-textarea',
    'form [contenteditable="true"][role="textbox"]',
    'form textarea',
  ];
  const stopSelectors = [
    '[data-testid="stop-button"]',
    'button[aria-label="Stop generating"]',
    'button[aria-label*="Stop"]',
    'button[aria-label*="Останов"]',
    'button[aria-label*="Прервать"]',
  ];
  const sendSelectors = [
    '#composer-submit-button',
    'button[data-testid="send-button"]',
    'button[aria-label="Send prompt"]',
    'button[aria-label="Отправить"]',
    'form button[type="submit"]',
  ];
  const one = selectors => selectors.map(s => document.querySelector(s)).find(Boolean);
  const editor = () => one(editorSelectors);
  const isGenerating = () => stopSelectors.some(s =>
    [...document.querySelectorAll(s)].some(e => e.getClientRects().length > 0));
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

  function state() {
    const input = editor();
    if (!input || !location.pathname.includes('/c/') || document.readyState === 'loading')
      return { state: 'unknown', reason: 'no conversation or composer', url: location.href };
    if (isGenerating()) return { state: 'busy', reason: 'stop-generation control', url: location.href };
    if ((input.value ?? input.innerText ?? input.textContent ?? '').trim())
      return { state: 'draft', reason: 'composer contains user text', url: location.href };
    return { state: 'idle', reason: 'composer ready, no generation', url: location.href };
  }

  function setText(input, text) {
    input.focus();
    if (input instanceof HTMLTextAreaElement || input instanceof HTMLInputElement) {
      const setter = Object.getOwnPropertyDescriptor(
        input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype,
        'value'
      )?.set;
      if (setter) setter.call(input, text);
      else input.value = text;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      return;
    }
    const sel = getSelection();
    const range = document.createRange();
    range.selectNodeContents(input);
    sel.removeAllRanges();
    sel.addRange(range);
    let ok = false;
    try { ok = document.execCommand('insertText', false, text); } catch {}
    if (!ok) {
      input.textContent = text;
      input.dispatchEvent(new InputEvent('input', {
        bubbles: true, inputType: 'insertText', data: text,
      }));
    }
  }

  async function send(text, expectedUrl) {
    if (location.href !== expectedUrl)
      throw Error('Conversation changed; wake cancelled');
    if (state().state !== 'idle')
      throw Error('Chat is generating, unavailable or contains a draft');
    const input = editor();
    setText(input, text);
    const deadline = Date.now() + 6000;
    while (Date.now() < deadline) {
      if (location.href !== expectedUrl)
        throw Error('Conversation changed while sending');
      if (isGenerating()) throw Error('Chat started generating before submit');
      const button = one(sendSelectors);
      if (button && !button.disabled && button.getAttribute('aria-disabled') !== 'true') {
        button.click();
        return { submitted: true };
      }
      await sleep(100);
    }
    // Do not silently overwrite or clear a draft after a failed send.
    throw Error('ChatGPT send control is unavailable; prompt left in composer');
  }

  const seen = new Set();
  chrome.runtime.onMessage.addListener((message, _sender, respond) => {
    (async () => {
      if (message?.type === 'agent:probe')
        return { ok: true, ...state() };
      if (message?.type === 'agent:send') {
        if (message.wakeId && seen.has(message.wakeId))
          return { ok: true, duplicate: true };
        const result = await send(message.text, message.url);
        if (message.wakeId) seen.add(message.wakeId);
        return { ok: true, ...result };
      }
      return { ok: false, error: 'Unknown operation' };
    })().then(respond).catch(e => respond({ ok: false, error: String(e.message || e) }));
    return true;
  });
})();
