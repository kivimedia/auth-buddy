const $ = (id) => document.getElementById(id);

async function call(type, data = {}) {
  const r = await chrome.runtime.sendMessage({ type, ...data });
  if (!r?.ok) throw new Error(r?.error || 'No answer from Auth Buddy');
  return r.result;
}

let tab = null;
let host = '';

async function show() {
  const status = await call('status');
  for (const id of ['locked', 'new', 'open']) $(id).classList.add('hidden');
  if (status === 'new') return $('new').classList.remove('hidden');
  if (status === 'locked') {
    $('locked').classList.remove('hidden');
    return $('pin').focus();
  }
  $('open').classList.remove('hidden');
  render();
}

async function render() {
  const codes = host ? await call('codesForHost', { host }) : [];
  $('none').classList.toggle('hidden', codes.length > 0);
  $('none').textContent = host ? `No saved account for ${host}.` : 'Open a website to see its code here.';
  $('codes').replaceChildren(
    ...codes.map((c) => {
      const item = document.createElement('div');
      item.className = 'item';
      const name = document.createElement('div');
      name.textContent = `${c.issuer || 'Unnamed'}${c.label ? ' - ' + c.label : ''}`;
      const code = document.createElement('div');
      code.className = 'code';
      code.textContent = c.code;
      const meta = document.createElement('div');
      meta.className = 'row';
      const left = document.createElement('span');
      left.className = 'muted';
      left.textContent = `${c.secondsLeft}s left`;
      const copy = document.createElement('button');
      copy.textContent = 'Copy';
      copy.onclick = async () => {
        await navigator.clipboard.writeText(c.code);
        copy.textContent = 'Copied';
      };
      meta.append(copy, left);
      item.append(name, code, meta);
      return item;
    }),
  );
}

async function unlock() {
  $('err').textContent = 'Unlocking...';
  try {
    await call('unlock', { pin: $('pin').value });
    $('err').textContent = '';
    // Let the page that was waiting for a code fill it now.
    if (tab?.id) chrome.tabs.sendMessage(tab.id, { type: 'unlocked' }).catch(() => {});
    show();
  } catch (e) {
    $('err').textContent = e.message;
  }
}

$('unlock').onclick = unlock;
// addEventListener, not onkeydown: an on-handler returning false (every non-Enter key) cancels the keystroke.
$('pin').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') unlock();
});
$('lock').onclick = async () => {
  await call('lock');
  show();
};
$('settings').onclick = () => chrome.runtime.openOptionsPage();

[tab] = await chrome.tabs.query({ active: true, currentWindow: true });
try {
  const url = new URL(tab?.url || '');
  if (url.protocol.startsWith('http')) host = url.hostname;
} catch {}
await show();
setInterval(() => !$('open').classList.contains('hidden') && render(), 1000);
