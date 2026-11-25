// Self-reload for unpacked installs: load a COPY of the extension, prove it stays put while nothing changes,
// then bump the version in the copy's folder and prove it reloads itself into the new version.
// Run: node test/e2e-selfupdate.mjs   (~2.5 minutes; set CHROMIUM_PATH if needed)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const copy = fs.mkdtempSync(path.join(os.tmpdir(), 'authbuddy-copy-'));
for (const item of ['manifest.json', 'src', 'vendor', 'icons', 'popup.html', 'options.html', 'styles.css'])
  if (fs.existsSync(path.join(root, item))) fs.cpSync(path.join(root, item), path.join(copy, item), { recursive: true });

const results = [];
const check = (name, ok, detail = '') => {
  results.push(ok);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  (' + detail + ')' : ''}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'authbuddy-'));
// Installed the way "Load unpacked" installs it, with Developer mode on, as in a real Chrome.
// (Playwright's default --disable-extensions and a --load-extension install both disable the
// extension on ANY reload, so they cannot test this.)
const ctx = await chromium.launchPersistentContext(profile, {
  channel: 'chromium',
  headless: true,
  executablePath: process.env.CHROMIUM_PATH || undefined,
  args: ['--enable-unsafe-extension-debugging'],
  ignoreDefaultArgs: ['--disable-extensions'],
});
// The live worker's version and a marker that only survives if the extension was NOT reloaded.
// Asked from one of the extension's own pages, so it does not depend on which worker Playwright tracks.
let extId = null;
async function probe() {
  const p = await ctx.newPage();
  try {
    await p.goto(`chrome-extension://${extId}/options.html`, { timeout: 10000 });
    return await p.evaluate(async () => ({ version: chrome.runtime.getManifest().version, marked: (await chrome.storage.session.get('abMark')).abMark === 1 }));
  } catch (e) {
    return { error: e.message.split(/\r?\n/)[0] };
  } finally {
    await p.close().catch(() => {});
  }
}
try {
  const dev = await ctx.newPage();
  await dev.goto('chrome://extensions/');
  await dev.evaluate(() => chrome.developerPrivate.updateProfileConfiguration({ inDeveloperMode: true }));
  await dev.close();
  const swReady = ctx.waitForEvent('serviceworker', { timeout: 15000 });
  extId = (await (await ctx.browser().newBrowserCDPSession()).send('Extensions.loadUnpacked', { path: copy.split(path.sep).join('/') })).id;
  const sw = await swReady;
  // Session storage survives the worker going to sleep, but is wiped by a real reload.
  const start = await sw.evaluate(async () => {
    await chrome.storage.session.set({ abMark: 1 });
    return chrome.runtime.getManifest().version;
  });
  console.log(`loaded ${start}; waiting 70 s with nothing changed...`);
  await sleep(70000);
  const idle = await probe();
  check('No reload while the folder holds the same version', idle?.marked === true && idle.version === start, JSON.stringify(idle));

  const mf = JSON.parse(fs.readFileSync(path.join(copy, 'manifest.json'), 'utf8'));
  mf.version = '9.9.9';
  fs.writeFileSync(path.join(copy, 'manifest.json'), JSON.stringify(mf, null, 2));
  const t = Date.now();
  console.log('bumped the folder to 9.9.9; waiting up to 90 s for the extension to reload itself...');
  let now = null;
  while (Date.now() - t < 90000) {
    await sleep(5000);
    now = await probe();
    if (now?.version === '9.9.9') break;
  }
  check('Reloaded itself into the new version, no click', now?.version === '9.9.9' && !now.marked, `${JSON.stringify(now)} after ${Math.round((Date.now() - t) / 1000)} s`);
} catch (e) {
  check('run finished without errors', false, e.message);
} finally {
  await ctx.close();
  fs.rmSync(copy, { recursive: true, force: true });
}
const failed = results.filter((ok) => !ok).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
