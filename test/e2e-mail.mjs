// End-to-end for email codes and links: real Chromium, the unpacked extension, the REAL mail helper
// started by Chrome over native messaging. Only the mailbox is a fixture file (AUTHBUDDY_MAIL_FIXTURE),
// and the two sites are local copies served at their real URLs.
// Run: node test/e2e-mail.mjs   (Windows: registers the test host under HKCU\Software\Chromium and
// "Google\Chrome for Testing" for the run, then removes it; your real Chrome's entry is not touched)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { HOST_NAME, writeHost, register } from '../native-host/install.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'test', 'output');
fs.mkdirSync(out, { recursive: true });
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'authbuddy-mail-'));
const mailbox = path.join(tmp, 'mailbox.json');
const TEST_BROWSERS = ['Chromium', 'Google\\Chrome for Testing'];

// ---- fixture mailbox, Gmail API "full" shape ----
const b64 = (s) => Buffer.from(s).toString('base64url');
const gauth = (d, ok = true) => `mx.google.com; dkim=${ok ? 'pass' : 'fail'} header.i=@${d} header.s=s1; dmarc=${ok ? 'pass' : 'fail'} (p=REJECT) header.from=${d}`;
const msg = (id, at, from, auth, html, to = 'someone@example.com') => ({ id, internalDate: String(at), payload: { mimeType: 'text/html', headers: [{ name: 'Authentication-Results', value: auth }, { name: 'From', value: from }, { name: 'To', value: to }], body: { data: b64(html) } } });
const pin = (id, at, code, ok = true) => msg(id, at, '"Authorize.Net" <support@authorize.net>', gauth('authorize.net', ok), `<p>Your Verification PIN is: ${code}</p>`);
const link = (id, at, tok, to) => msg(id, at, 'Anthropic <no-reply-x@mail.anthropic.com>', gauth('mail.anthropic.com'), `<a href="https://claude.ai/magic-link#${tok}">Sign in</a>`, to);
let mails = [];
const setMail = (list) => fs.writeFileSync(mailbox, JSON.stringify((mails = list)));
setMail([pin('old', Date.now() - 120000, '11111111'), link('oldlink', Date.now() - 60000, 'tok-old')]);

const page = (body) => `<!doctype html><html><body style="font:16px system-ui;padding:40px;background:#f2f3f7">${body}</body></html>`;
let pinEmailsAsked = 0;
const marks = {};
// Screenshots are evidence, not the test: a page that navigates mid-shot must not fail the run.
const snap = (p, name) => p.screenshot({ path: path.join(out, name), timeout: 5000 }).catch(() => console.log(`  (screenshot ${name} skipped: page was navigating)`));

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  (' + detail + ')' : ''}`);
};

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'authbuddy-'));
const ctx = await chromium.launchPersistentContext(profile, {
  channel: 'chromium',
  headless: true,
  executablePath: process.env.CHROMIUM_PATH || undefined,
  args: [`--disable-extensions-except=${root}`, `--load-extension=${root}`],
  env: { ...process.env, AUTHBUDDY_MAIL_FIXTURE: mailbox },
  viewport: { width: 1000, height: 760 },
  deviceScaleFactor: 2,
});

try {
  let [sw] = ctx.serviceWorkers();
  if (!sw) sw = await ctx.waitForEvent('serviceworker');
  const extId = new URL(sw.url()).host;
  register(writeHost(path.join(tmp, 'host'), [extId], null), TEST_BROWSERS);

  // ---- Authorize.net copy: "Verify Your Identity" -> EMAIL PIN TO ... -> PIN page ----
  await ctx.route('https://login.authorize.net/**', async (route) => {
    const u = new URL(route.request().url());
    const html = (b) => route.fulfill({ contentType: 'text/html', body: page(b) });
    if (u.pathname === '/verification-required') {
      marks.served ??= Date.now();
      return html(`<h1>Verify Your Identity</h1><p>Before logging in, confirm your identity by requesting and verifying a PIN.<br>A PIN will be sent to:</p>
        <button id="send" onclick="location.href='/verify-pin'">EMAIL PIN TO JO****@EXAMPLE.COM</button><p><a href="/">RETURN TO LOG IN PAGE</a></p>
        <p><a href="/verify-pin">Already have a PIN?</a> | <a href="#">Not your contact info?</a></p>`);
    }
    if (u.pathname === '/verify-pin') {
      pinEmailsAsked++;
      marks.pressed ??= Date.now();
      // The real PIN lands 5 s later; a spoofed "authorize.net" mail lands first and must be skipped.
      setMail([...mails, pin('spoof', Date.now() + 500, '99999999', false)]);
      setTimeout(() => setMail([...mails, pin('real', Date.now(), '33445566')]), 5000);
      return html(`<h1>Verify Your Identity</h1><p>Enter the PIN we emailed you. It is valid for 10 minutes.</p>
        <form action="/check"><label for="p">Verification PIN</label> <input id="p" name="verificationPin" type="text" maxlength="8">
        <button type="submit">VERIFY</button></form>`);
    }
    if (u.pathname === '/check') {
      const got = u.searchParams.get('verificationPin');
      return html(`<h1 id="result">${got === '33445566' ? 'ACCEPTED' : 'REJECTED'}</h1><p>pin ${got}</p>`);
    }
    return html('<h1>login</h1>');
  });

  const a = await ctx.newPage();
  const t0 = Date.now();
  await a.goto('https://login.authorize.net/verification-required');
  await a.waitForURL(/\/verify-pin/, { timeout: 20000 }).catch(() => {});
  check('Authorize.net: pressed "EMAIL PIN TO ..." by itself', a.url().includes('/verify-pin'), `page served -> pressed ${marks.pressed - marks.served} ms, goto -> served ${marks.served - t0} ms`);
  await a.waitForTimeout(2500);
  await snap(a, 'mail-authnet-waiting.png');
  await a.waitForSelector('#result', { timeout: 30000 }).catch(() => {});
  const res = (await a.textContent('#result').catch(() => null)) || 'no result';
  check('Authorize.net: filled the NEW PIN from the inbox and submitted', res === 'ACCEPTED', `${res}, ${a.url().split('?')[1] || ''}`);
  await snap(a, 'mail-authnet-done.png');

  // Back to the start page within 3 minutes: no second email request (no loops after a wrong PIN).
  await a.goto('https://login.authorize.net/verification-required');
  await a.waitForTimeout(3000);
  check('Authorize.net: does not ask for a second email within 3 minutes', pinEmailsAsked === 1 && a.url().includes('verification-required'), `asked ${pinEmailsAsked}x`);

  // ---- Claude copy: type email, Continue, "Check your email" -> magic link opened ----
  let magicHits = 0;
  await ctx.route('https://claude.ai/**', async (route) => {
    const u = new URL(route.request().url());
    const html = (b) => route.fulfill({ contentType: 'text/html', body: page(b) });
    if (u.pathname === '/login')
      return html(`<div id="app"><h1>Log in</h1><input id="email" type="email" placeholder="Enter your email">
        <button id="go">Continue with email</button></div><script>
        document.getElementById('go').onclick = () => { document.getElementById('app').innerHTML = '<h1>Check your email</h1><p>We sent a secure link to your inbox.</p>'; };
        </script>`);
    if (u.pathname === '/magic-link') {
      magicHits++;
      return html('<h1 id="result">SIGNED IN</h1>');
    }
    return html('<h1>home</h1>');
  });
  const c = await ctx.newPage();
  await c.goto('https://claude.ai/login');
  await c.fill('#email', 'someone@example.com');
  await c.click('#go');
  // Yours lands after 3 s; a link for ANOTHER account in the same inbox lands 0.2 s later (newest, both present at the next check) and must be ignored.
  setTimeout(() => setMail([...mails, link('newlink', Date.now(), 'tok-e2e', 'Someone <Someone@Example.com>')]), 3000);
  setTimeout(() => setMail([...mails, link('decoy', Date.now(), 'tok-other-account', 'other@example.com')]), 3200);
  await c.waitForTimeout(2000);
  await snap(c, 'mail-claude-waiting.png');
  await c.waitForURL(/magic-link/, { timeout: 30000 }).catch(() => {});
  check('Claude: opened the NEW sign-in link from the inbox in the same tab', c.url() === 'https://claude.ai/magic-link#tok-e2e', c.url());
  check('Claude: the older link and the newer link for another account were never opened', magicHits === 1, `${magicHits} hit(s)`);
  await snap(c, 'mail-claude-done.png');
} catch (e) {
  check('run finished without errors', false, e.message);
} finally {
  await ctx.close();
  if (process.platform === 'win32')
    for (const b of TEST_BROWSERS) {
      try {
        execFileSync('reg', ['delete', `HKCU\\Software\\${b}\\NativeMessagingHosts\\${HOST_NAME}`, '/f'], { stdio: 'ignore' });
      } catch {}
    }
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
