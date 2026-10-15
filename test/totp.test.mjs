import { test } from 'node:test';
import assert from 'node:assert/strict';
import { totp, base32Encode, base32Decode } from '../src/totp.js';
import { parseQrText, guessDomain, hostMatches } from '../src/otpauth.js';
import { encryptBackup, decryptBackup } from '../src/backup.js';

test('encrypted backup round trip, wrong passphrase refused', async () => {
  const accounts = [
    { id: 'x', issuer: 'LinkedIn', label: 'a@b.com', secret: 'JBSWY3DPEHPK3PXP', algorithm: 'SHA1', digits: 6, period: 30, domains: ['linkedin.com'] },
    { issuer: 'Unknown', label: '', secret: 'GEZDGNBVGY3TQOJQ', algorithm: 'SHA1', digits: 6, period: 30, domains: [] },
  ];
  const file = await encryptBackup(accounts, 'correct horse battery');
  assert.ok(!JSON.stringify(file).includes('JBSWY3DPEHPK3PXP'));
  const back = await decryptBackup(JSON.parse(JSON.stringify(file)), 'correct horse battery');
  assert.equal(back.length, 2);
  assert.equal(back[0].secret, 'JBSWY3DPEHPK3PXP');
  assert.deepEqual(back[0].domains, ['linkedin.com']);
  assert.equal(back[0].id, undefined);
  await assert.rejects(decryptBackup(file, 'wrong passphrase!'), /Wrong backup passphrase/);
  await assert.rejects(decryptBackup({ hello: 1 }, 'x'), /not an Auth Buddy backup/);
  await assert.rejects(encryptBackup(accounts, 'short'), /at least 8/);
});

const ascii = (s) => base32Encode(new TextEncoder().encode(s));
const SEEDS = {
  SHA1: ascii('12345678901234567890'),
  SHA256: ascii('12345678901234567890123456789012'),
  SHA512: ascii('1234567890123456789012345678901234567890123456789012345678901234'),
};

// RFC 6238 Appendix B
const VECTORS = [
  [59, '94287082', '46119246', '90693936'],
  [1111111109, '07081804', '68084774', '25091201'],
  [1111111111, '14050471', '67062674', '99943326'],
  [1234567890, '89005924', '91819424', '93441116'],
  [2000000000, '69279037', '90698825', '38618901'],
  [20000000000, '65353130', '77737706', '47863826'],
];

test('RFC 6238 test vectors', async () => {
  for (const [t, sha1, sha256, sha512] of VECTORS) {
    for (const [algorithm, want] of [['SHA1', sha1], ['SHA256', sha256], ['SHA512', sha512]]) {
      const { code } = await totp({ secret: SEEDS[algorithm], algorithm, digits: 8, period: 30 }, t * 1000);
      assert.equal(code, want, `${algorithm} at ${t}`);
    }
  }
});

test('base32 round trip, spaces and lowercase allowed', () => {
  const bytes = crypto.getRandomValues(new Uint8Array(20));
  const enc = base32Encode(bytes);
  assert.deepEqual(base32Decode(enc.toLowerCase().replace(/(.{4})/g, '$1 ')), bytes);
});

test('otpauth URI with issuer prefix', () => {
  const [a] = parseQrText('otpauth://totp/GitHub:ziv%40example.com?secret=JBSWY3DPEHPK3PXP&issuer=GitHub');
  assert.deepEqual(a, { issuer: 'GitHub', label: 'ziv@example.com', secret: 'JBSWY3DPEHPK3PXP', algorithm: 'SHA1', digits: 6, period: 30 });
});

test('HOTP is refused with a clear message', () => {
  assert.throws(() => parseQrText('otpauth://hotp/X?secret=JBSWY3DPEHPK3PXP&counter=1'), /time-based/);
});

// Builds a Google Authenticator export payload the way the app does.
function pb(field, value) {
  const varint = (n) => {
    const out = [];
    while (n > 127) {
      out.push((n & 127) | 128);
      n >>>= 7;
    }
    out.push(n);
    return out;
  };
  if (typeof value === 'number') return [...varint(field * 8), ...varint(value)];
  const bytes = typeof value === 'string' ? [...new TextEncoder().encode(value)] : [...value];
  return [...varint(field * 8 + 2), ...varint(bytes.length), ...bytes];
}

test('Google Authenticator export QR (otpauth-migration)', () => {
  const secret1 = new TextEncoder().encode('12345678901234567890');
  const secret2 = Uint8Array.from({ length: 10 }, (_, i) => i + 1);
  const p1 = [...pb(1, secret1), ...pb(2, 'Google:me@gmail.com'), ...pb(3, 'Google'), ...pb(4, 1), ...pb(5, 1), ...pb(6, 2)];
  const p2 = [...pb(1, secret2), ...pb(2, 'me@x.com'), ...pb(3, 'Dropbox'), ...pb(4, 2), ...pb(5, 2), ...pb(6, 2)];
  const hotpEntry = [...pb(1, secret2), ...pb(2, 'old'), ...pb(6, 1)];
  const payload = Uint8Array.from([...pb(1, p1), ...pb(1, p2), ...pb(1, hotpEntry), ...pb(2, 1), ...pb(3, 1)]);
  const data = encodeURIComponent(btoa(String.fromCharCode(...payload)));
  const list = parseQrText(`otpauth-migration://offline?data=${data}`);
  assert.equal(list.length, 2);
  assert.equal(list.skipped, 1);
  assert.deepEqual(list[0], { issuer: 'Google', label: 'me@gmail.com', secret: SEEDS.SHA1, algorithm: 'SHA1', digits: 6, period: 30 });
  assert.equal(list[1].issuer, 'Dropbox');
  assert.equal(list[1].algorithm, 'SHA256');
  assert.equal(list[1].digits, 8);
  assert.deepEqual(base32Decode(list[1].secret), secret2);
});

test('domain guess and host matching', () => {
  assert.equal(guessDomain('GitHub'), 'github.com');
  assert.equal(guessDomain('www.Kivimedia.co'), 'kivimedia.co');
  assert.ok(hostMatches('login.github.com', 'github.com'));
  assert.ok(hostMatches('www.github.com', 'https://github.com/login'));
  assert.ok(!hostMatches('evilgithub.com', 'github.com'));
  assert.ok(!hostMatches('github.com.evil.io', 'github.com'));
});
