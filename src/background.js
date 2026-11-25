import * as vault from './vault.js';
import { totp } from './totp.js';
import { hostMatches } from './otpauth.js';
import { mailRuleFor } from './mailrules.js';

const MAIL_HOST = 'co.kivimedia.authbuddy_mail';

// What the page may know about its mail rule: hints for the screen, not the senders or patterns.
const ruleView = (r) => r && { id: r.id, name: r.name, kind: r.link ? 'link' : 'code', sendButton: r.sendButton || null, pageHint: r.pageHint || null };

async function askMail(rule, since) {
  // A page cannot reach back further than 15 minutes, or into the future.
  const now = Date.now();
  since = Math.min(Math.max(Number(since) || now, now - 15 * 60e3), now);
  try {
    return await chrome.runtime.sendNativeMessage(MAIL_HOST, { type: 'find', since, rule: { from: rule.from, code: rule.code, link: rule.link } });
  } catch (e) {
    return { error: /not found|forbidden/i.test(e.message) ? 'helper-missing' : e.message };
  }
}

// The unlocked key lives in storage.session; keep it away from content scripts.
chrome.storage.session.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });

async function matchesFor(host) {
  const accounts = await vault.list();
  return accounts.filter((a) => a.domains.some((d) => hostMatches(host, d)));
}

async function handle(msg, sender) {
  const fromPage = sender.tab && !sender.url?.startsWith(chrome.runtime.getURL(''));
  switch (msg.type) {
    case 'siteStatus': {
      // Content script: is this a saved site, and is the vault open?
      const host = new URL(sender.url).hostname;
      const { index = [] } = await chrome.storage.local.get('index');
      const saved = index.some((a) => a.domains.some((d) => hostMatches(host, d)));
      return { saved, status: saved ? await vault.status() : null, mail: ruleView(mailRuleFor(sender.url)) };
    }
    case 'mailCode': {
      // The rule comes from the URL Chrome reports, never from the page.
      const rule = mailRuleFor(sender.url);
      if (!rule?.code) return { none: true };
      const r = await askMail(rule, msg.since);
      return r.found ? { code: r.code, receivedAt: r.receivedAt } : r;
    }
    case 'mailLink': {
      const rule = mailRuleFor(sender.url);
      if (!rule?.link) return { none: true };
      const r = await askMail(rule, msg.since);
      if (!r.found) return r;
      const u = new URL(r.link);
      if (u.protocol !== 'https:' || u.hostname !== rule.link.host || !u.pathname.startsWith(rule.link.pathPrefix)) return { error: 'link did not match' };
      // The page never sees the link: the tab is sent there directly.
      await chrome.tabs.update(sender.tab.id, { url: u.href });
      return { opened: true, receivedAt: r.receivedAt };
    }
    case 'codeForPage': {
      // Content script asks for the code of the page it runs on. The host comes from Chrome, not the page.
      const host = new URL(sender.url).hostname;
      if ((await vault.status()) !== 'unlocked') return { locked: true };
      const matches = await matchesFor(host);
      if (!matches.length) return { none: true };
      // Several accounts on one site: the page shows a picker and asks again with the chosen id.
      const pick = msg.id ? matches.find((a) => a.id === msg.id) : matches.length === 1 ? matches[0] : null;
      if (!pick) return { choose: matches.map((a) => ({ id: a.id, issuer: a.issuer, label: a.label })) };
      const { code, secondsLeft } = await totp(pick);
      return { code, secondsLeft, issuer: pick.issuer };
    }
  }

  // Everything below is only for the extension's own pages (popup, settings).
  if (fromPage) throw new Error('Not allowed');
  switch (msg.type) {
    case 'status':
      return vault.status();
    case 'create':
      return vault.create(msg.pin);
    case 'unlock':
      return vault.unlock(msg.pin);
    case 'lock':
      return vault.lock();
    case 'reset':
      return vault.reset();
    case 'list':
      return vault.list();
    case 'save':
      return vault.save(msg.accounts);
    case 'codesForHost': {
      const matches = await matchesFor(msg.host);
      return Promise.all(matches.map(async (a) => ({ id: a.id, issuer: a.issuer, label: a.label, ...(await totp(a)) })));
    }
    default:
      throw new Error(`Unknown message ${msg.type}`);
  }
}

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  handle(msg, sender).then(
    (result) => reply({ ok: true, result }),
    (err) => reply({ ok: false, error: err.message }),
  );
  return true;
});

chrome.runtime.onInstalled.addListener(({ reason }) => {
  if (reason === 'install') chrome.runtime.openOptionsPage();
});
