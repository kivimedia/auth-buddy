import { parseQrText, guessDomain } from './otpauth.js';
import { totp, base32Decode } from './totp.js';
import { encryptBackup, decryptBackup } from './backup.js';

const $ = (id) => document.getElementById(id);

async function call(type, data = {}) {
  const r = await chrome.runtime.sendMessage({ type, ...data });
  if (!r?.ok) throw new Error(r?.error || 'No answer from Auth Buddy');
  return r.result;
}

function el(tag, props = {}, ...children) {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children.filter((c) => c != null));
  return node;
}

let accounts = [];
let pending = [];

async function refresh() {
  const status = await call('status');
  $('setup').classList.toggle('hidden', status !== 'new');
  $('locked').classList.toggle('hidden', status !== 'locked');
  $('app').classList.toggle('hidden', status !== 'unlocked');
  if (status === 'unlocked') {
    accounts = await call('list');
    renderAccounts();
  }
}

// ---------- PIN ----------
$('createBtn').onclick = async () => {
  $('setupErr').textContent = '';
  if ($('newPin').value !== $('newPin2').value) return ($('setupErr').textContent = 'The two PINs are different.');
  try {
    await call('create', { pin: $('newPin').value });
    refresh();
  } catch (e) {
    $('setupErr').textContent = e.message;
  }
};

async function doUnlock() {
  $('lockErr').textContent = 'Unlocking...';
  try {
    await call('unlock', { pin: $('pin').value });
    $('pin').value = '';
    $('lockErr').textContent = '';
    refresh();
  } catch (e) {
    $('lockErr').textContent = e.message;
  }
}
$('unlockBtn').onclick = doUnlock;
// addEventListener, not onkeydown: an on-handler returning false (every non-Enter key) cancels the keystroke.
$('pin').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') doUnlock();
});
$('lockBtn').onclick = async () => {
  await call('lock');
  refresh();
};
$('resetBtn').onclick = async () => {
  if (!confirm('Erase every saved account from Auth Buddy? Your authenticator app is not affected.')) return;
  await call('reset');
  refresh();
};

// ---------- Adding ----------
async function decodeImage(blob) {
  const bitmap = await createImageBitmap(blob);
  // Large screenshots decode faster and just as well when scaled down.
  for (const max of [1600, 800, 2400]) {
    const scale = Math.min(1, max / Math.max(bitmap.width, bitmap.height));
    const w = Math.round(bitmap.width * scale);
    const h = Math.round(bitmap.height * scale);
    const canvas = new OffscreenCanvas(w, h);
    const ctx = canvas.getContext('2d');
    ctx.drawImage(bitmap, 0, 0, w, h);
    const found = window.jsQR(ctx.getImageData(0, 0, w, h).data, w, h, { inversionAttempts: 'attemptBoth' });
    if (found?.data) return found.data;
  }
  throw new Error('No QR code found in that image. Try a sharper or closer picture.');
}

function addParsed(list) {
  const known = new Set([...accounts, ...pending].map((a) => a.secret));
  let dupes = 0;
  for (const a of list) {
    if (known.has(a.secret)) {
      dupes++;
      continue;
    }
    known.add(a.secret);
    pending.push({ ...a, id: crypto.randomUUID(), domains: [guessDomain(a.issuer)].filter(Boolean) });
  }
  const notes = [];
  if (dupes) notes.push(`${dupes} already saved, skipped.`);
  if (list.skipped) notes.push(`${list.skipped} counter-based (HOTP) account(s) skipped: only time-based codes are supported.`);
  $('addErr').textContent = notes.join(' ');
  renderPending();
}

async function handleFiles(files) {
  $('addErr').textContent = '';
  for (const f of files) {
    if (!f.type.startsWith('image/')) continue;
    try {
      addParsed(parseQrText(await decodeImage(f)));
    } catch (e) {
      $('addErr').textContent = `${f.name || 'Image'}: ${e.message}`;
    }
  }
}

$('pickBtn').onclick = () => $('file').click();
$('file').onchange = () => handleFiles([...$('file').files]).then(() => ($('file').value = ''));
const drop = $('drop');
drop.ondragover = (e) => {
  e.preventDefault();
  drop.classList.add('over');
};
drop.ondragleave = () => drop.classList.remove('over');
drop.ondrop = (e) => {
  e.preventDefault();
  drop.classList.remove('over');
  handleFiles([...e.dataTransfer.files]);
};
document.addEventListener('paste', (e) => {
  if ($('app').classList.contains('hidden')) return;
  const files = [...e.clipboardData.files];
  if (files.length) handleFiles(files);
});

$('uriBtn').onclick = () => {
  const text = $('uri').value.trim();
  $('addErr').textContent = '';
  try {
    if (text.startsWith('otpauth')) addParsed(parseQrText(text));
    else {
      const secret = text.replace(/\s/g, '').toUpperCase();
      base32Decode(secret); // throws on a bad key
      if (secret.length < 16) throw new Error('That setup key looks too short.');
      addParsed([{ issuer: '', label: '', secret, algorithm: 'SHA1', digits: 6, period: 30 }]);
    }
    $('uri').value = '';
  } catch (e) {
    $('addErr').textContent = e.message;
  }
};

// ---------- Backup ----------
function backupMsg(text, ok = false) {
  $('backupMsg').textContent = text;
  $('backupMsg').className = ok ? 'ok' : 'error';
}

$('importBtn').onclick = () => {
  if (!$('importPass').value) return backupMsg('Type the backup passphrase first.');
  $('importFile').click();
};
$('importFile').onchange = async () => {
  const file = $('importFile').files[0];
  $('importFile').value = '';
  if (!file) return;
  backupMsg('Decrypting...', true);
  try {
    const list = await decryptBackup(JSON.parse(await file.text()), $('importPass').value);
    const known = new Set(accounts.map((a) => a.secret));
    const fresh = list.filter((a) => !known.has(a.secret)).map((a) => ({ ...a, id: crypto.randomUUID() }));
    accounts.push(...fresh);
    await call('save', { accounts });
    $('importPass').value = '';
    renderAccounts();
    const skipped = list.length - fresh.length;
    backupMsg(`Imported ${fresh.length} account${fresh.length === 1 ? '' : 's'}${skipped ? `, ${skipped} already saved` : ''}.`, true);
  } catch (e) {
    backupMsg(e instanceof SyntaxError ? 'That file is not an Auth Buddy backup.' : e.message);
  }
};

$('exportBtn').onclick = async () => {
  try {
    if (!accounts.length) return backupMsg('There are no accounts to back up yet.');
    const file = await encryptBackup(accounts, $('exportPass').value);
    const url = URL.createObjectURL(new Blob([JSON.stringify(file)], { type: 'application/json' }));
    const a = el('a', { href: url, download: `auth-buddy-backup-${new Date().toISOString().slice(0, 10)}.json` });
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
    $('exportPass').value = '';
    backupMsg(`Backup of ${accounts.length} accounts downloaded. Keep the passphrase somewhere safe.`, true);
  } catch (e) {
    backupMsg(e.message);
  }
};

const splitDomains = (s) => s.split(/[\s,]+/).map((d) => d.trim().toLowerCase()).filter(Boolean);

function renderPending() {
  const box = $('pending');
  box.replaceChildren(
    ...pending.map((a) => {
      const issuer = el('input', { type: 'text', value: a.issuer, placeholder: 'For example GitHub' });
      const domains = el('input', { type: 'text', value: a.domains.join(', '), placeholder: 'github.com' });
      issuer.oninput = () => {
        a.issuer = issuer.value;
        if (!domains.dataset.touched) domains.value = guessDomain(issuer.value);
      };
      domains.oninput = () => (domains.dataset.touched = '1');
      const save = el('button', { className: 'primary', textContent: 'Save' });
      const skip = el('button', { textContent: 'Skip' });
      const err = el('p', { className: 'error' });
      save.onclick = async () => {
        a.domains = splitDomains(domains.value);
        if (!a.domains.length) return (err.textContent = 'Add the site address, for example github.com');
        const { id, issuer: iss, label, secret, algorithm, digits, period, domains: ds } = a;
        accounts.push({ id, issuer: iss.trim(), label, secret, algorithm, digits, period, domains: ds });
        await call('save', { accounts });
        pending = pending.filter((p) => p !== a);
        renderPending();
        renderAccounts();
      };
      skip.onclick = () => {
        pending = pending.filter((p) => p !== a);
        renderPending();
      };
      return el(
        'div',
        { className: 'pending' },
        el('div', { className: 'name', textContent: `New: ${a.issuer || 'Unnamed'}${a.label ? ' (' + a.label + ')' : ''}` }),
        el('label', { textContent: 'Name' }),
        issuer,
        el('label', { textContent: 'Fill codes on (site address, several allowed with commas)' }),
        domains,
        el('div', { className: 'row', style: 'margin-top:10px' }, save, skip),
        err,
      );
    }),
  );
}

$('filter').oninput = () => renderAccounts();

function renderAccounts() {
  $('empty').classList.toggle('hidden', accounts.length > 0);
  $('filter').classList.toggle('hidden', accounts.length < 6);
  const q = $('filter').value.trim().toLowerCase();
  const shown = q ? accounts.filter((a) => [a.issuer, a.label, ...a.domains].join(' ').toLowerCase().includes(q)) : accounts;
  $('accounts').replaceChildren(
    ...shown.map((a) => {
      const domains = el('input', { type: 'text', value: a.domains.join(', '), placeholder: 'Not filled on any site yet: add one, for example github.com' });
      domains.onchange = async () => {
        a.domains = splitDomains(domains.value);
        await call('save', { accounts });
      };
      const del = el('button', { className: 'danger', textContent: 'Remove' });
      del.onclick = async () => {
        if (!confirm(`Remove ${a.issuer || 'this account'} from Auth Buddy? Your authenticator app keeps it.`)) return;
        accounts = accounts.filter((x) => x !== a);
        await call('save', { accounts });
        renderAccounts();
      };
      const live = el('div', { className: 'live' });
      live.dataset.id = a.id;
      return el(
        'div',
        { className: 'account' },
        el(
          'div',
          {},
          el('div', { className: 'name', textContent: a.issuer || 'Unnamed' }),
          a.label ? el('div', { className: 'muted', textContent: a.label }) : null,
          el('label', { textContent: 'Fill codes on' }),
          domains,
        ),
        el('div', { style: 'text-align:right' }, live, del),
      );
    }),
  );
  tick();
}

async function tick() {
  for (const node of document.querySelectorAll('.live')) {
    const a = accounts.find((x) => x.id === node.dataset.id);
    if (!a) continue;
    const { code, secondsLeft } = await totp(a);
    node.textContent = `${code} `;
    node.append(el('span', { className: 'muted', style: 'font-size:12px;letter-spacing:0', textContent: `${secondsLeft}s` }));
  }
}
setInterval(tick, 1000);

refresh();
