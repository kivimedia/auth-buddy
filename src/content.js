// Runs on every page, but does nothing unless the site is one you saved in Auth Buddy.
(() => {
  const CODE_WORDS = /(one.?time|otp|totp|2fa|mfa|two.?factor|authenticat|verification|verify|security.?code|auth.?code|\bcode\b|token|passcode)/i;
  const NOT_CODE = /(promo|coupon|discount|gift|zip|postal|country|captcha|phone|e.?mail|search|user|login|name|card|cvv|cvc)/i;
  const SUBMIT_WORDS = /^(verify|submit|continue|confirm|sign.?in|log.?in|next|done|authenticate|ok)$/i;

  let filled = new WeakSet();
  let lockedToastShown = false;
  let busy = false;

  const send = (msg) =>
    new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(msg, (r) => resolve(chrome.runtime.lastError ? null : r));
      } catch {
        resolve(null); // extension reloaded under this page
      }
    });

  function visible(el) {
    if (el.disabled || el.readOnly) return false;
    const r = el.getBoundingClientRect();
    if (r.width < 4 || r.height < 4) return false;
    const s = getComputedStyle(el);
    return s.visibility !== 'hidden' && s.display !== 'none' && Number(s.opacity) > 0.05;
  }

  function describe(el) {
    const label = el.labels?.[0]?.textContent || '';
    return [el.name, el.id, el.placeholder, el.getAttribute('aria-label'), el.getAttribute('data-testid'), label].join(' ');
  }

  const textish = (el) => ['text', 'tel', 'number', ''].includes((el.getAttribute('type') || '').toLowerCase());

  // One input that takes the whole code.
  function findSingle(inputs) {
    const otc = inputs.find((el) => el.autocomplete === 'one-time-code' && visible(el) && !filled.has(el) && !el.value);
    if (otc) return otc;
    return inputs.find((el) => {
      if (!textish(el) || !visible(el) || filled.has(el) || el.value) return false;
      const max = Number(el.getAttribute('maxlength') || 0);
      if (max && (max < 6 || max > 10)) return false;
      const d = describe(el);
      return CODE_WORDS.test(d) && !NOT_CODE.test(d);
    });
  }

  // Six (or eight) one-character boxes side by side.
  function findSplit(inputs) {
    const singles = inputs.filter(
      (el) => textish(el) && el.getAttribute('maxlength') === '1' && visible(el) && !filled.has(el) && !el.value,
    );
    const groups = new Map();
    for (const el of singles) {
      let p = el.parentElement;
      for (let i = 0; i < 3 && p; i++) {
        const n = [...p.querySelectorAll('input[maxlength="1"]')].filter((x) => singles.includes(x)).length;
        if (n >= 6) break;
        p = p.parentElement;
      }
      if (!p) continue;
      if (!groups.has(p)) groups.set(p, [...p.querySelectorAll('input[maxlength="1"]')].filter((x) => singles.includes(x)));
    }
    return [...groups.values()].find((g) => g.length === 6 || g.length === 8) || null;
  }

  function setValue(el, value) {
    const proto = Object.getPrototypeOf(el);
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
    el.focus();
    if (setter) setter.call(el, value);
    else el.value = value;
    el.dispatchEvent(new InputEvent('input', { bubbles: true, data: value, inputType: 'insertText' }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function submitButton(field) {
    const scope = field.closest('form') || document;
    const buttons = [...scope.querySelectorAll('button, input[type="submit"]')].filter(visible).filter((b) => {
      if (b.matches('input[type="submit"], button[type="submit"]')) return true;
      return SUBMIT_WORDS.test((b.textContent || b.value || '').trim());
    });
    return buttons.length === 1 ? buttons[0] : null;
  }

  function toast(text) {
    const host = document.createElement('div');
    const root = host.attachShadow({ mode: 'closed' });
    root.innerHTML = `<style>
      div{position:fixed;z-index:2147483647;right:16px;bottom:16px;max-width:320px;padding:12px 14px;border-radius:10px;
      background:#0f172a;color:#f8fafc;font:14px/1.4 system-ui,sans-serif;box-shadow:0 6px 24px rgba(0,0,0,.3)}
      b{color:#5eead4}</style><div><b>Auth Buddy</b><br>${text}</div>`;
    document.documentElement.appendChild(host);
    setTimeout(() => host.remove(), 6000);
  }

  async function tryFill() {
    if (busy) return;
    const inputs = [...document.querySelectorAll('input')];
    const split = findSplit(inputs);
    const single = split ? null : findSingle(inputs);
    if (!split && !single) return;

    busy = true;
    try {
      let r = await send({ type: 'codeForPage' });
      if (!r?.ok) return;
      if (r.result.locked) {
        if (!lockedToastShown) toast('Locked. Click the Auth Buddy icon in the toolbar and enter your PIN to fill this code.');
        lockedToastShown = true;
        return;
      }
      if (!r.result.code) return;
      // A code about to expire may be rejected by the time it is submitted: wait for the next one.
      if (r.result.secondsLeft < 3) {
        await new Promise((ok) => setTimeout(ok, (r.result.secondsLeft + 1) * 1000));
        r = await send({ type: 'codeForPage' });
        if (!r?.ok || !r.result.code) return;
      }
      const code = r.result.code;
      const fields = split || [single];
      if (split) split.forEach((el, i) => setValue(el, code[i] || ''));
      else setValue(single, code);
      fields.forEach((el) => filled.add(el));
      if (r.result.many) toast(`Filled the ${r.result.issuer || 'first'} code. You have more than one account for this site: use the toolbar icon to pick another.`);

      const btn = submitButton(fields[fields.length - 1]);
      if (btn && !r.result.many) {
        setTimeout(() => {
          // Only if the page has not already moved on by itself.
          if (fields[0].isConnected && btn.isConnected && visible(btn)) btn.click();
        }, 600);
      }
    } finally {
      busy = false;
    }
  }

  async function start() {
    const r = await send({ type: 'siteStatus' });
    if (!r?.ok || !r.result.saved) return;
    let timer = null;
    const schedule = () => {
      clearTimeout(timer);
      timer = setTimeout(tryFill, 250);
    };
    new MutationObserver(schedule).observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['style', 'class', 'hidden'] });
    schedule();
    // Unlocked from the toolbar while the page was waiting: try again.
    chrome.runtime.onMessage.addListener((msg) => {
      if (msg?.type === 'unlocked') {
        lockedToastShown = false;
        filled = new WeakSet();
        schedule();
      }
    });
  }

  start();
})();
