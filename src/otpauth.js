// Parses what a QR code holds into accounts:
//   otpauth://totp/Issuer:label?secret=...&issuer=...
//   otpauth-migration://offline?data=...   (Google Authenticator "Export accounts")

import { base32Encode } from './totp.js';

export function parseQrText(text) {
  const t = text.trim();
  if (t.startsWith('otpauth://')) return [parseOtpauth(t)];
  if (t.startsWith('otpauth-migration://')) return parseMigration(t);
  throw new Error('This QR code is not an authenticator code (expected otpauth:// or otpauth-migration://).');
}

export function parseOtpauth(uri) {
  const url = new URL(uri);
  const type = url.host.toLowerCase();
  if (type !== 'totp') throw new Error(`Only time-based (TOTP) codes are supported, this one is ${type.toUpperCase()}.`);
  const params = url.searchParams;
  const secret = (params.get('secret') || '').replace(/\s/g, '').toUpperCase();
  if (!secret) throw new Error('The QR code has no secret.');
  const path = decodeURIComponent(url.pathname.replace(/^\/+/, ''));
  let issuer = params.get('issuer') || '';
  let label = path;
  const colon = path.indexOf(':');
  if (colon >= 0) {
    if (!issuer) issuer = path.slice(0, colon);
    label = path.slice(colon + 1);
  }
  return {
    issuer: issuer.trim(),
    label: label.trim(),
    secret,
    algorithm: (params.get('algorithm') || 'SHA1').toUpperCase(),
    digits: Number(params.get('digits') || 6),
    period: Number(params.get('period') || 30),
  };
}

// Minimal protobuf reader for Google's MigrationPayload.
function readVarint(buf, pos) {
  let result = 0;
  let shift = 0;
  for (;;) {
    const b = buf[pos.i++];
    result += (b & 0x7f) * 2 ** shift;
    if (!(b & 0x80)) return result;
    shift += 7;
  }
}

function readFields(buf) {
  const pos = { i: 0 };
  const fields = [];
  while (pos.i < buf.length) {
    const tag = readVarint(buf, pos);
    const field = Math.floor(tag / 8);
    const wire = tag & 7;
    if (wire === 0) fields.push([field, readVarint(buf, pos)]);
    else if (wire === 2) {
      const len = readVarint(buf, pos);
      fields.push([field, buf.subarray(pos.i, pos.i + len)]);
      pos.i += len;
    } else if (wire === 5) pos.i += 4;
    else if (wire === 1) pos.i += 8;
    else throw new Error('Unreadable export QR code.');
  }
  return fields;
}

const MIG_ALG = { 0: 'SHA1', 1: 'SHA1', 2: 'SHA256', 3: 'SHA512' };
const MIG_DIGITS = { 0: 6, 1: 6, 2: 8 };

export function parseMigration(uri) {
  const data = new URL(uri).searchParams.get('data');
  if (!data) throw new Error('The export QR code has no data.');
  const bin = Uint8Array.from(atob(data.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
  const dec = new TextDecoder();
  const accounts = [];
  let skipped = 0;
  for (const [field, value] of readFields(bin)) {
    if (field !== 1) continue;
    const p = { secret: null, name: '', issuer: '', algorithm: 1, digits: 1, type: 2 };
    for (const [f, v] of readFields(value)) {
      if (f === 1) p.secret = v;
      else if (f === 2) p.name = dec.decode(v);
      else if (f === 3) p.issuer = dec.decode(v);
      else if (f === 4) p.algorithm = v;
      else if (f === 5) p.digits = v;
      else if (f === 6) p.type = v;
    }
    if (p.type !== 2 || !p.secret || !MIG_ALG[p.algorithm]) {
      skipped++;
      continue;
    }
    let label = p.name;
    if (p.issuer && label.startsWith(p.issuer + ':')) label = label.slice(p.issuer.length + 1);
    accounts.push({
      issuer: p.issuer.trim(),
      label: label.trim(),
      secret: base32Encode(p.secret),
      algorithm: MIG_ALG[p.algorithm],
      digits: MIG_DIGITS[p.digits] || 6,
      period: 30,
    });
  }
  if (!accounts.length) throw new Error('No time-based codes found in this export QR code.');
  accounts.skipped = skipped;
  return accounts;
}

// Best guess at the site for an issuer, for the user to confirm.
export function guessDomain(issuer) {
  const s = (issuer || '').toLowerCase().trim();
  if (!s) return '';
  if (/^[a-z0-9.-]+\.[a-z]{2,}$/.test(s)) return s.replace(/^www\./, '');
  const word = s.replace(/[^a-z0-9]/g, '');
  return word ? `${word}.com` : '';
}

export function hostMatches(host, domain) {
  const h = host.toLowerCase().replace(/^www\./, '');
  const d = domain.toLowerCase().trim().replace(/^https?:\/\//, '').replace(/\/.*$/, '').replace(/^www\./, '');
  return !!d && (h === d || h.endsWith('.' + d));
}
