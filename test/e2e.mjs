// End-to-end: load the unpacked extension in Chromium, set a PIN, import a QR image,
// then visit a local login page that checks the code server-side.
// Run: node test/e2e.mjs   (set CHROMIUM_PATH if Playwright's own browser is not installed)
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import QRCode from 'qrcode';
import { totp } from '../src/totp.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'test', 'output');
fs.mkdirSync(out, { recursive: true });

const SECRET = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP'; // test-only key, not a real account
const qrPath = path.join(out, 'test-qr.png');
await QRCode.toFile(qrPath, `otpauth://totp/TestSite:ziv@example.com?secret=${SECRET}&issuer=TestSite`, { width: 400 });

// --- A fake site that asks for a code and checks it like a real one would ---
const valid = async (code) => {
  const now = Date.now();
  for (const skew of [-30000, 0, 30000]) if ((await totp({ secret: SECRET }, now + skew)).code === code) return true;
  return false;
};
const page = (body) => `<!doctype html><html><body style="font:16px system-ui;padding:40px">${body}</body></html>`;
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  res.setHeader('content-type', 'text/html');
  if (url.pathname === '/single')
    return res.end(page(`<h1>Two-step verification</h1><form action="/check"><label for="otp">Enter the code from your authenticator app</label><br>
      <input id="otp" name="otp" inputmode="numeric" autocomplete="one-time-code" maxlength="6"><button type="submit">Verify</button></form>`));
  if (url.pathname === '/split')
    // Code boxes appear late, like a single-page app.
    return res.end(page(`<h1>Security code</h1><div id="app">Loading...</div><script>
      setTimeout(()=>{document.getElementById('app').innerHTML='<form action="/check"><div class="boxes">'+
      [0,1,2,3,4,5].map(i=>'<input maxlength="1" inputmode="numeric" name="d'+i+'" style="width:30px">').join('')+
      '</div><button type="submit">Continue</button></form>'},1500)</script>`));
  if (url.pathname === '/check') {
    const code = url.searchParams.get('otp') ?? [0, 1, 2, 3, 4, 5].map((i) => url.searchParams.get('d' + i)).join('');
    const ok = await valid(code);
    return res.end(page(`<h1 id="result">${ok ? 'ACCEPTED' : 'REJECTED'}</h1><p>code ${code}</p>`));
  }
  res.statusCode = 404;
  res.end('nope');
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const site = `http://127.0.0.1:${server.address().port}`;

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'authbuddy-'));
const ctx = await chromium.launchPersistentContext(profile, {
  channel: 'chromium',
  headless: true,
  executablePath: process.env.CHROMIUM_PATH || undefined,
  args: [`--disable-extensions-except=${root}`, `--load-extension=${root}`],
  viewport: { width: 900, height: 800 },
  deviceScaleFactor: 2,
});

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  (' + detail + ')' : ''}`);
};

try {
  let [sw] = ctx.serviceWorkers();
  if (!sw) sw = await ctx.waitForEvent('serviceworker');
  const extId = new URL(sw.url()).host;

  // 1. Settings: create PIN, import QR, set site
  const opts = await ctx.newPage();
  await opts.goto(`chrome-extension://${extId}/options.html`);
  await opts.fill('#newPin', '4321');
  await opts.fill('#newPin2', '4321');
  await opts.click('#createBtn');
  await opts.waitForSelector('#app:not(.hidden)');
  await opts.setInputFiles('#file', qrPath);
  await opts.waitForSelector('.pending');
  const guessed = await opts.inputValue('.pending input >> nth=1');
  check('QR image imported, site guessed from issuer', guessed === 'testsite.com', `guess "${guessed}"`);
  await opts.fill('.pending input >> nth=1', '127.0.0.1');
  await opts.click('.pending button.primary');
  await opts.waitForSelector('.account .live');
  await opts.waitForTimeout(1200);
  const shown = (await opts.textContent('.account .live')).slice(0, 6);
  const expected = (await totp({ secret: SECRET })).code;
  check('Settings shows the live code', shown === expected, `${shown} vs ${expected}`);
  await opts.screenshot({ path: path.join(out, 'settings.png') });

  // Secrets are not stored in the clear
  const stored = await sw.evaluate(() => chrome.storage.local.get(null));
  check('Secret is encrypted at rest', !JSON.stringify(stored).includes(SECRET) && !!stored.vault?.data);

  // 2. Single box + auto-submit
  const p = await ctx.newPage();
  await p.goto(`${site}/single`);
  await p.waitForSelector('#result', { timeout: 15000 });
  check('Single code box: filled and submitted, server accepted', (await p.textContent('#result')) === 'ACCEPTED', await p.textContent('p'));
  await p.screenshot({ path: path.join(out, 'single-accepted.png') });

  // 3. Split boxes that appear late
  await p.goto(`${site}/split`);
  await p.waitForSelector('#result', { timeout: 15000 });
  check('Six split boxes (late-loading): filled and submitted, accepted', (await p.textContent('#result')) === 'ACCEPTED', await p.textContent('p'));

  // 4. Locked: no fill, toast instead
  await opts.click('#lockBtn');
  await opts.waitForSelector('#locked:not(.hidden)');
  await p.goto(`${site}/single`);
  await p.waitForTimeout(2500);
  const val = await p.inputValue('#otp');
  check('Locked vault fills nothing', val === '' && !p.url().includes('/check'));
  await p.screenshot({ path: path.join(out, 'locked-toast.png') });

  // 5. Unrelated site gets nothing even when unlocked
  await opts.fill('#pin', '0000');
  await opts.click('#unlockBtn');
  await opts.waitForTimeout(1500);
  check('Wrong PIN is refused', (await opts.textContent('#lockErr')).includes('Wrong PIN'));
  await opts.fill('#pin', '4321');
  await opts.click('#unlockBtn');
  await opts.waitForSelector('#app:not(.hidden)');
  await p.goto(`http://localhost:${server.address().port}/single`);
  await p.waitForTimeout(2500);
  check('Other site (localhost, not 127.0.0.1) gets no code', (await p.inputValue('#otp')) === '');

  // 6. A web page cannot read the vault through the extension
  const leak = await p.evaluate(() => typeof chrome !== 'undefined' && !!chrome.runtime?.sendMessage);
  check('Page scripts have no direct line to the extension', !leak);

  // 7. Popup shows the code for the site
  await p.goto(`${site}/single`); // auto-submits
  const pop = await ctx.newPage();
  await pop.goto(`chrome-extension://${extId}/popup.html`);
  await pop.waitForSelector('#open:not(.hidden)');
  await pop.screenshot({ path: path.join(out, 'popup.png') });
  check('Popup opens unlocked', true);
} catch (e) {
  check('e2e run', false, e.message);
} finally {
  await ctx.close();
  server.close();
}
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
