// Runs on every page, but does nothing unless the site is one you saved in Auth Buddy.
(() => {
  const CODE_WORDS = /(one.?time|otp|totp|2fa|mfa|two.?factor|authenticat|verification|verify|security.?code|auth.?code|\bcode\b|token|passcode|\bpin\b)/i;
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

  // el.type, not the attribute: an invalid type (SiteGround ships type="input") resolves to "text".
  const textish = (el) => ['text', 'tel', 'number'].includes(el.type);

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

  let picker = null;
  let dismissed = false;

  // Several saved accounts for this site: ask which one, right on the page.
  function showPicker(choices, fields) {
    if (picker) return;
    picker = document.createElement('div');
    const root = picker.attachShadow({ mode: 'closed' });
    const style = document.createElement('style');
    style.textContent = `
      .box{position:fixed;z-index:2147483647;right:16px;bottom:16px;width:300px;max-height:60vh;overflow:auto;padding:12px;border-radius:10px;
        background:#0f172a;color:#f8fafc;font:14px/1.4 system-ui,sans-serif;box-shadow:0 6px 24px rgba(0,0,0,.3)}
      b{color:#5eead4} p{margin:4px 0 8px}
      button{display:block;width:100%;text-align:left;margin:6px 0 0;padding:8px 10px;border-radius:8px;border:1px solid #334155;
        background:#1e293b;color:#f8fafc;font:inherit;cursor:pointer}
      button:hover,button:focus{border-color:#5eead4;outline:none}
      .x{background:transparent;border:0;color:#cbd5e1;text-align:right;padding:0;margin:0}`;
    const box = document.createElement('div');
    box.className = 'box';
    const head = document.createElement('div');
    head.innerHTML = '<b>Auth Buddy</b>';
    const text = document.createElement('p');
    text.textContent = 'Which account is this code for?';
    box.append(head, text);
    for (const c of choices) {
      const b = document.createElement('button');
      b.textContent = c.label ? `${c.issuer || 'Unnamed'}: ${c.label}` : c.issuer || 'Unnamed';
      b.onclick = () => {
        closePicker();
        fill(fields, c.id);
      };
      box.append(b);
    }
    const x = document.createElement('button');
    x.className = 'x';
    x.textContent = 'Not now';
    x.onclick = () => {
      closePicker();
      dismissed = true; // do not pop up again on this page
    };
    box.append(x);
    root.append(style, box);
    document.documentElement.appendChild(picker);
  }

  function closePicker() {
    picker?.remove();
    picker = null;
  }

  async function fill(fields, id) {
    let r = await send({ type: 'codeForPage', id });
    if (!r?.ok || !r.result.code) return;
    // A code about to expire may be rejected by the time it is submitted: wait for the next one.
    if (r.result.secondsLeft < 3) {
      await new Promise((ok) => setTimeout(ok, (r.result.secondsLeft + 1) * 1000));
      r = await send({ type: 'codeForPage', id });
      if (!r?.ok || !r.result.code) return;
    }
    putCode(fields, r.result.code);
  }

  function putCode(fields, code) {
    if (fields.length > 1) fields.forEach((el, i) => setValue(el, code[i] || ''));
    else setValue(fields[0], code);
    fields.forEach((el) => filled.add(el));

    const btn = submitButton(fields[fields.length - 1]);
    if (btn) {
      setTimeout(() => {
        // Only if the page has not already moved on by itself.
        if (fields[0].isConnected && btn.isConnected && visible(btn)) btn.click();
      }, 600);
    }
  }

  // ---------- Codes and sign-in links that the site emails you ----------
  let mailRule = null;
  const mailPage = () => !!(mailRule?.pageHint && new RegExp(mailRule.pageHint, 'i').test(document.body?.innerText || ''));

  // One status box that updates in place, so you always see what Auth Buddy is doing right now.
  let statusHost = null;
  let statusText = null;
  let statusTimer = null;
  function status(text, final = false) {
    if (!statusHost?.isConnected) {
      statusHost = document.createElement('div');
      const root = statusHost.attachShadow({ mode: 'closed' });
      root.innerHTML = `<style>
        div{position:fixed;z-index:2147483647;right:16px;bottom:16px;max-width:340px;padding:12px 14px;border-radius:10px;
        background:#0f172a;color:#f8fafc;font:14px/1.4 system-ui,sans-serif;box-shadow:0 6px 24px rgba(0,0,0,.3)}
        b{color:#5eead4}</style><div><b>Auth Buddy</b><br><span></span></div>`;
      statusText = root.querySelector('span');
      document.documentElement.appendChild(statusHost);
    }
    statusText.textContent = text;
    clearTimeout(statusTimer);
    if (final) statusTimer = setTimeout(() => statusHost?.remove(), 9000);
  }

  const store = (k, v) => {
    try {
      if (v === undefined) return Number(sessionStorage.getItem(k) || 0);
      sessionStorage.setItem(k, String(v));
    } catch {
      return 0;
    }
  };
  const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));
  const clock = (ms) => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

  function startMail(rule) {
    const KEY = `authbuddy-mail-${rule.id}`;
    const sendRe = rule.sendButton ? new RegExp(rule.sendButton, 'i') : null;
    const what = rule.kind === 'code' ? 'code' : 'sign-in link';
    let polling = false;
    let gaveUp = false;

    // Sign-in link sites: remember the moment you asked for the email, so an older link is never used.
    if (rule.kind === 'link') {
      const mark = () => {
        const typed = [...document.querySelectorAll('input')].find((i) => (i.type === 'email' || /mail|user/i.test(describe(i))) && /\S+@\S+\.\S+/.test(i.value));
        if (!typed) return;
        store(`${KEY}-asked`, Date.now());
        // Which account: only a link sent to this address will be opened.
        try {
          sessionStorage.setItem(`${KEY}-email`, typed.value.trim().toLowerCase());
        } catch {}
      };
      document.addEventListener('submit', mark, true);
      document.addEventListener('click', (e) => e.target.closest?.('button, input[type="submit"], [role="button"]') && mark(), true);
      document.addEventListener('keydown', (e) => e.key === 'Enter' && mark(), true);
    }

    // The address you typed, or else the single address the "check your email" page shows.
    function accountEmail() {
      try {
        const typed = sessionStorage.getItem(`${KEY}-email`);
        if (typed) return typed;
      } catch {}
      const shown = [...new Set((document.body?.innerText || '').match(/[^\s@<>"',;:()]+@[^\s@<>"',;:()]+\.[a-z]{2,}/gi) || [])];
      return shown.length === 1 ? shown[0].toLowerCase() : null;
    }

    function codeFields() {
      const inputs = [...document.querySelectorAll('input')];
      const split = findSplit(inputs);
      if (split) return split;
      const single = findSingle(inputs);
      if (single) return [single];
      // The email-code page itself: its one empty box is the code box.
      if (!mailPage()) return null;
      const open = inputs.filter((el) => (textish(el) || el.type === 'password') && visible(el) && !el.value && !filled.has(el));
      return open.length === 1 ? open : null;
    }

    async function poll(since, fields) {
      polling = true;
      // Never the same mail twice: after a used code or link, only newer mail counts.
      since = Math.max(since, store(`${KEY}-used`) + 1);
      const start = Date.now();
      const waiting = () => status(`Checking your inbox for the ${rule.name} ${what}... ${Math.round((Date.now() - start) / 1000)} s`);
      waiting();
      const ticker = setInterval(waiting, 1000);
      try {
        while (Date.now() - start < 180e3) {
          const r = await send({ type: rule.kind === 'code' ? 'mailCode' : 'mailLink', since, to: rule.kind === 'link' ? accountEmail() : undefined });
          const res = r?.ok ? r.result : { error: r?.error || 'the extension did not answer' };
          if (res.error === 'helper-missing') {
            status('Cannot read your inbox yet. In the auth-buddy folder run: node native-host/install.mjs', true);
            gaveUp = true;
            return;
          }
          if (res.error === 'no-email') {
            status(`Not opening any ${rule.name} link: I could not tell which email address you signed in with. Type it on this page and press Continue.`, true);
            gaveUp = true;
            return;
          }
          if (res.error) {
            status(`Could not read your inbox: ${res.error}`, true);
            gaveUp = true;
            return;
          }
          if (res.code) {
            store(`${KEY}-used`, res.receivedAt);
            if (!fields?.[0]?.isConnected) fields = codeFields();
            if (!fields) return status(`Found the ${rule.name} code from ${clock(res.receivedAt)}, but the code box is gone.`, true);
            status(`Found the ${rule.name} code from ${clock(res.receivedAt)}. Filling it in.`, true);
            putCode(fields, res.code);
            return;
          }
          if (res.opened) {
            store(`${KEY}-used`, res.receivedAt);
            status(`Found the ${rule.name} sign-in link from ${clock(res.receivedAt)}. Opening it.`, true);
            return;
          }
          await sleep(4000);
        }
        status(`No email from ${rule.name} after 3 minutes. Reload the page to try again.`, true);
        gaveUp = true;
      } finally {
        clearInterval(ticker);
        polling = false;
      }
    }

    function tick() {
      if (polling || gaveUp) return;
      const asked = store(`${KEY}-asked`);
      const recent = asked && Date.now() - asked < 15 * 60e3;

      // 1. The "email me the code" button: press it, at most once every 3 minutes.
      if (sendRe) {
        const btn = [...document.querySelectorAll('button, a, input[type="button"], input[type="submit"], [role="button"]')]
          .filter(visible)
          .find((b) => sendRe.test((b.textContent || b.value || '').trim()));
        if (btn && Date.now() - asked > 180e3) {
          store(`${KEY}-asked`, Date.now());
          status(`Asking ${rule.name} to email your ${what}...`);
          btn.click();
          return;
        }
      }

      // 2. Wait for the mail, then fill the code or open the link.
      if (rule.kind === 'code') {
        const fields = codeFields();
        if (fields) poll(recent ? asked - 15e3 : Date.now() - 10 * 60e3, fields);
      } else if (mailPage() || (asked && Date.now() - asked < 5 * 60e3)) {
        poll(asked ? asked - 15e3 : Date.now() - 3 * 60e3, null);
      }
    }

    let timer = null;
    const schedule = () => {
      clearTimeout(timer);
      timer = setTimeout(tick, 400);
    };
    new MutationObserver(schedule).observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['style', 'class', 'hidden'] });
    schedule();
  }

  async function tryFill() {
    if (busy || picker || dismissed) return;
    if (mailPage()) return; // this code arrives by email, not from the authenticator
    const inputs = [...document.querySelectorAll('input')];
    const split = findSplit(inputs);
    const single = split ? null : findSingle(inputs);
    if (!split && !single) return;
    const fields = split || [single];

    busy = true;
    try {
      const r = await send({ type: 'codeForPage' });
      if (!r?.ok) return;
      if (r.result.locked) {
        if (!lockedToastShown) toast('Locked. Click the Auth Buddy icon in the toolbar and enter your PIN to fill this code.');
        lockedToastShown = true;
        return;
      }
      if (r.result.choose) return showPicker(r.result.choose, fields);
      if (r.result.code) await fill(fields);
    } finally {
      busy = false;
    }
  }

  async function start() {
    let r = null;
    // The background worker may still be waking up: ask again a few times before giving up.
    for (let i = 0; i < 4 && !r?.ok; i++) {
      if (i) await new Promise((ok) => setTimeout(ok, 500 * i));
      r = await send({ type: 'siteStatus' });
    }
    if (!r?.ok) return;
    mailRule = r.result.mail;
    if (mailRule && window.top === window) startMail(mailRule);
    if (!r.result.saved) return;
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
