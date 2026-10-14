// Encrypted account store.
// chrome.storage.local:  vault = { salt, iv, data }  (AES-GCM, key from PIN via PBKDF2)
//                        index = [{ id, domains }]   (plaintext, no secrets: lets pages ask "is this a saved site?")
// chrome.storage.session: key = raw AES key while unlocked (gone when the browser closes)

const ITERATIONS = 310000;
const b64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)));
const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

async function deriveKey(pin, salt) {
  const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(pin), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations: ITERATIONS, hash: 'SHA-256' },
    base,
    { name: 'AES-GCM', length: 256 },
    true,
    ['encrypt', 'decrypt'],
  );
}

async function sessionKey() {
  const { key } = await chrome.storage.session.get('key');
  if (!key) return null;
  return crypto.subtle.importKey('raw', unb64(key), 'AES-GCM', true, ['encrypt', 'decrypt']);
}

async function encrypt(key, accounts) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(JSON.stringify(accounts)));
  return { iv: b64(iv), data: b64(data) };
}

async function decrypt(key, vault) {
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(vault.iv) }, key, unb64(vault.data));
  return JSON.parse(new TextDecoder().decode(plain));
}

export async function status() {
  const { vault } = await chrome.storage.local.get('vault');
  if (!vault) return 'new';
  return (await sessionKey()) ? 'unlocked' : 'locked';
}

export async function create(pin) {
  if (!pin || pin.length < 4) throw new Error('Use a PIN of at least 4 characters.');
  const { vault } = await chrome.storage.local.get('vault');
  if (vault) throw new Error('A vault already exists.');
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const key = await deriveKey(pin, salt);
  await chrome.storage.local.set({ vault: { salt: b64(salt), ...(await encrypt(key, [])) }, index: [] });
  await chrome.storage.session.set({ key: b64(await crypto.subtle.exportKey('raw', key)) });
}

export async function unlock(pin) {
  const { vault } = await chrome.storage.local.get('vault');
  if (!vault) throw new Error('Set a PIN in Settings first.');
  const key = await deriveKey(pin, unb64(vault.salt));
  try {
    await decrypt(key, vault);
  } catch {
    throw new Error('Wrong PIN.');
  }
  await chrome.storage.session.set({ key: b64(await crypto.subtle.exportKey('raw', key)) });
}

export async function lock() {
  await chrome.storage.session.remove('key');
}

export async function list() {
  const key = await sessionKey();
  if (!key) throw new Error('Locked');
  const { vault } = await chrome.storage.local.get('vault');
  return decrypt(key, vault);
}

export async function save(accounts) {
  const key = await sessionKey();
  if (!key) throw new Error('Locked');
  const { vault } = await chrome.storage.local.get('vault');
  await chrome.storage.local.set({
    vault: { salt: vault.salt, ...(await encrypt(key, accounts)) },
    index: accounts.map((a) => ({ id: a.id, domains: a.domains })),
  });
}

// Wipes everything, for "forgot PIN".
export async function reset() {
  await chrome.storage.local.remove(['vault', 'index']);
  await chrome.storage.session.remove('key');
}
