// LIVE end-to-end against SiteGround. Not part of `npm test`; needs Ziv's machine and creds.
// Loads the extension in a throwaway Chromium profile, imports ONLY the SiteGround key (encrypted
// backup, same path a user takes), logs in with real credentials and lets Auth Buddy fill the 2FA.
// Env: AB_SEED_JSON_CMD (prints {"siteground":"<base32>"}), SG_USER, SG_PASS, CHROMIUM_PATH, OUT_DIR
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { encryptBackup } from '../src/backup.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = process.env.OUT_DIR || path.join(root, 'test', 'output');
fs.mkdirSync(out, { recursive: true });
const log = (s) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${s}`);

const seed = JSON.parse(execSync(process.env.AB_SEED_JSON_CMD, { encoding: 'utf8' })).siteground;
if (!seed) throw new Error('no siteground seed');
const pass = 'live-test-' + Math.random().toString(36).slice(2);
const backupPath = path.join(os.tmpdir(), `ab-live-${process.pid}.json`);
fs.writeFileSync(backupPath, JSON.stringify(await encryptBackup([
  { issuer: 'SiteGround', label: process.env.SG_USER, secret: seed, algorithm: 'SHA1', digits: 6, period: 30, domains: ['siteground.com'] },
], pass)));

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'ab-live-profile-'));
const ctx = await chromium.launchPersistentContext(profile, {
  channel: 'chromium',
  // SiteGround's reCAPTCHA silently rejects headless logins; a real window parked off-screen passes.
  headless: false,
  executablePath: process.env.CHROMIUM_PATH || undefined,
  ignoreDefaultArgs: ['--enable-automation'],
  args: [`--disable-extensions-except=${root}`, `--load-extension=${root}`, '--disable-blink-features=AutomationControlled', '--window-position=-2600,0', '--window-size=1280,1000'],
  viewport: { width: 1280, height: 900 },
});
let result = 'unknown';
try {
  let [sw] = ctx.serviceWorkers();
  if (!sw) sw = await ctx.waitForEvent('serviceworker');
  const extId = new URL(sw.url()).host;

  const opts = await ctx.newPage();
  await opts.goto(`chrome-extension://${extId}/options.html`);
  // onInstalled opens its own Settings tab; keystrokes only reach the tab in front.
  await opts.waitForTimeout(1000);
  await opts.bringToFront();
  await opts.locator('#newPin').pressSequentially('2468');
  await opts.locator('#newPin2').pressSequentially('2468');
  await opts.click('#createBtn');
  await opts.waitForSelector('#app:not(.hidden)');
  await opts.fill('#importPass', pass);
  await opts.setInputFiles('#importFile', backupPath);
  await opts.waitForFunction(() => /Imported|Wrong|not/.test(document.getElementById('backupMsg').textContent));
  log('settings: ' + (await opts.textContent('#backupMsg')));
  fs.rmSync(backupPath, { force: true });

  const p = await ctx.newPage();
  await p.bringToFront();
  await p.goto('https://login.siteground.com/login', { waitUntil: 'domcontentloaded' });
  await p.waitForSelector('input[name="username"]', { timeout: 30000 });
  await p.waitForTimeout(2000);
  await p.locator('input[name="username"]').pressSequentially(process.env.SG_USER, { delay: 80 });
  await p.locator('input[type="password"]').pressSequentially(process.env.SG_PASS, { delay: 90 });
  const typed = await p.evaluate(() => [document.querySelector('input[name="username"]').value.length, document.querySelector('input[type="password"]').value.length]);
  log(`typed lengths user=${typed[0]} pass=${typed[1]} (expected ${process.env.SG_USER.length}/${process.env.SG_PASS.length})`);
  await p.waitForTimeout(4000);
  await p.getByRole('button', { name: /log ?in/i }).first().click();
  log('clicked Login, waiting for the 2FA page');
  await p.waitForURL((u) => u.pathname.includes('two-step') || u.hostname.startsWith('my.'), { timeout: 45000 });
  log('now at ' + p.url());
  await p.screenshot({ path: path.join(out, 'sg-1-2fa-page.png') });
  if (p.url().includes('two-step')) {
    // Hands off: Auth Buddy must fill and submit on its own.
    await p.waitForTimeout(1500);
    const filled = await p.evaluate(() => document.querySelector('input[name="two_factor_code"]')?.value || '');
    log(`code box after 1.5 s: ${filled ? filled.length + ' digits filled' : 'EMPTY'}`);
    const dom = await p.evaluate(() => [...document.querySelectorAll('input')].map((i) => {
      const lab = i.labels?.[0]?.textContent?.trim() || '';
      const r = i.getBoundingClientRect();
      const s = getComputedStyle(i);
      const d = [i.name, i.id, i.placeholder, i.getAttribute('aria-label'), i.getAttribute('data-testid'), lab].join(' ');
      return `${i.outerHTML.slice(0, 400)}  | label="${lab}" type=${i.type} rect=${Math.round(r.width)}x${Math.round(r.height)} vis=${s.visibility} disp=${s.display} op=${s.opacity} dis=${i.disabled} ro=${i.readOnly} val=${i.value.length} desc="${d}"`;
    }).join('\n'));
    log('inputs on the 2FA page:\n' + dom);
    await p.screenshot({ path: path.join(out, 'sg-2-filled.png') });
    await p.waitForURL((u) => u.hostname.startsWith('my.'), { timeout: 30000 }).catch(() => {});
  }
  await p.waitForTimeout(3000);
  log('final url ' + p.url());
  await p.screenshot({ path: path.join(out, 'sg-3-after.png') });
  result = new URL(p.url()).hostname.startsWith('my.') ? 'LOGGED IN' : 'NOT LOGGED IN';
} catch (e) {
  log('error: ' + e.message.split('\n')[0]);
  for (const [i, pg] of ctx.pages().entries()) await pg.screenshot({ path: path.join(out, `sg-error-${i}.png`) }).catch(() => {});
} finally {
  fs.rmSync(backupPath, { force: true });
  await ctx.close();
  fs.rmSync(profile, { recursive: true, force: true });
}
console.log('RESULT: ' + result);
