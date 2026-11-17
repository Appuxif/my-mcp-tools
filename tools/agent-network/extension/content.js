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

  function hasComposerAttachments(input) {
    const form = input?.closest('form[data-chatgpt-composer]') ||
                 input?.closest('form');
    if (!form) return true; // unknown composer -> never risk a submission
    // ChatGPT currently renders file/image chips inside this dedicated region.
    // Treat *any* child as user context, including uploads still in progress.
    const tray = form.querySelector('[data-composer-attachments]');
    if (!tray) return true; // fail closed when the UI layout changes
    if (tray.childElementCount > 0 || tray.textContent?.trim()) return true;
    // The input can still own selected files before the tray renders them.
    if ([...form.querySelectorAll('input[type="file"]')]
          .some(el => (el.files?.length || 0) > 0)) return true;
    // Additional upload/context states outside the standard chip region.
    if (form.querySelector('[data-testid*="attachment-preview"], ' +
        '[data-testid*="upload-progress"], [aria-label*="Uploading"], ' +
        '[aria-label*="Загрузка"], [role="progressbar"]')) return true;
    return false;
  }

  function state() {
    const input = editor();
    if (!input || !location.pathname.includes('/c/') || document.readyState === 'loading')
      return { state: 'unknown', reason: 'no conversation or composer', url: location.href };
    if (isGenerating()) return { state: 'busy', reason: 'stop-generation control', url: location.href };
    if (hasComposerAttachments(input))
      return { state: 'draft', reason: 'attachments or upload in composer', url: location.href };
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
      if (hasComposerAttachments(input))
        throw Error('Attachment appeared before wake submit; prompt left in composer');
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
    // Ignore messages for other content scripts. In particular, the HUD owns
    // "network:hud-show" and must be the only responder for it.
    if (message?.type !== 'agent:probe' && message?.type !== 'agent:send')
      return false;
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
