// Encrypted backup files: { format: 'auth-buddy-backup', version: 1, iterations, salt, iv, data }.
// data = AES-GCM(JSON array of accounts), key from the backup passphrase via PBKDF2-SHA256.
// Works in the extension and in Node 18+.

const ITERATIONS = 310000;
const b64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)));
const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

async function keyFor(passphrase, salt, iterations) {
  const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(passphrase), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'PBKDF2', salt, iterations, hash: 'SHA-256' }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

export async function encryptBackup(accounts, passphrase) {
  if (!passphrase || passphrase.length < 8) throw new Error('Use a backup passphrase of at least 8 characters.');
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await keyFor(passphrase, salt, ITERATIONS);
  const clean = accounts.map(({ issuer, label, secret, algorithm, digits, period, domains }) => ({ issuer, label, secret, algorithm, digits, period, domains }));
  const data = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(JSON.stringify(clean)));
  return { format: 'auth-buddy-backup', version: 1, iterations: ITERATIONS, salt: b64(salt), iv: b64(iv), data: b64(data) };
}

export async function decryptBackup(file, passphrase) {
  if (file?.format !== 'auth-buddy-backup') throw new Error('This is not an Auth Buddy backup file.');
  const key = await keyFor(passphrase, unb64(file.salt), file.iterations || ITERATIONS);
  let plain;
  try {
    plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(file.iv) }, key, unb64(file.data));
  } catch {
    throw new Error('Wrong backup passphrase.');
  }
  const list = JSON.parse(new TextDecoder().decode(plain));
  if (!Array.isArray(list)) throw new Error('The backup is damaged.');
  return list.map((a) => ({
    issuer: String(a.issuer || '').trim(),
    label: String(a.label || '').trim(),
    secret: String(a.secret || '').replace(/\s/g, '').toUpperCase(),
    algorithm: (a.algorithm || 'SHA1').toUpperCase(),
    digits: Number(a.digits || 6),
    period: Number(a.period || 30),
    domains: Array.isArray(a.domains) ? a.domains.map((d) => String(d).toLowerCase().trim()).filter(Boolean) : [],
  })).filter((a) => a.secret);
}
