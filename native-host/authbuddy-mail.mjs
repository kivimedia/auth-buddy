// Auth Buddy mail helper: a Chrome native messaging host that only the Auth Buddy extension may start
// (see allowed_origins in the host manifest that install.mjs writes).
// It reads your inbox with the `gws` CLI you are already signed in to and returns ONE code or link.
//
// Request:  { type: 'find', since: <ms>, rule: { from: [domains], code?: {pattern}, link?: {host, pathPrefix} } }
// Reply:    { found: true, code | link, receivedAt } | { found: false, checked: n } | { error }
//
// Test mode: AUTHBUDDY_MAIL_FIXTURE=<file.json> reads Gmail-shaped messages from that file instead of gws.
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { pick } from './mailparse.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));

function gwsArgv() {
  if (process.env.AUTHBUDDY_GWS) return JSON.parse(process.env.AUTHBUDDY_GWS);
  try {
    return JSON.parse(fs.readFileSync(path.join(here, 'config.json'), 'utf8')).gws;
  } catch {
    return ['gws'];
  }
}

function gws(args) {
  const [cmd, ...pre] = gwsArgv();
  return new Promise((resolve, reject) => {
    execFile(cmd, [...pre, ...args], { maxBuffer: 1 << 26, timeout: 30000, windowsHide: true }, (err, stdout, stderr) => {
      if (err) return reject(new Error(`gws failed: ${(stderr || err.message).trim().split('\n').pop()}`));
      const start = stdout.indexOf('{');
      try {
        resolve(JSON.parse(stdout.slice(start)));
      } catch {
        reject(new Error('gws returned something that is not JSON'));
      }
    });
  });
}

export async function fetchMessages(from, since) {
  if (process.env.AUTHBUDDY_MAIL_FIXTURE) {
    try {
      return JSON.parse(fs.readFileSync(process.env.AUTHBUDDY_MAIL_FIXTURE, 'utf8'));
    } catch {
      return [];
    }
  }
  // Gmail's after: is in seconds and inclusive enough; the exact cut is redone on internalDate.
  const q = `from:(${from.join(' OR ')}) after:${Math.floor(since / 1000) - 60}`;
  const list = await gws(['gmail', 'users', 'messages', 'list', '--params', JSON.stringify({ userId: 'me', q, maxResults: 5 })]);
  const ids = (list.messages || []).map((m) => m.id);
  return Promise.all(ids.map((id) => gws(['gmail', 'users', 'messages', 'get', '--params', JSON.stringify({ userId: 'me', id, format: 'full' })])));
}

export async function find({ since, rule }) {
  if (!rule?.from?.length || !(rule.code || rule.link)) return { error: 'bad rule' };
  const messages = await fetchMessages(rule.from, since);
  const hit = pick(messages, rule, since);
  return hit ? { found: true, ...hit } : { found: false, checked: messages.length };
}

// --- native messaging framing: 4-byte little-endian length, then JSON ---
function serve() {
  let buf = Buffer.alloc(0);
  const reply = (obj) => {
    const body = Buffer.from(JSON.stringify(obj), 'utf8');
    const head = Buffer.alloc(4);
    head.writeUInt32LE(body.length, 0);
    process.stdout.write(Buffer.concat([head, body]));
  };
  process.stdin.on('data', async (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    while (buf.length >= 4) {
      const len = buf.readUInt32LE(0);
      if (buf.length < 4 + len) return;
      const msg = JSON.parse(buf.subarray(4, 4 + len).toString('utf8'));
      buf = buf.subarray(4 + len);
      try {
        reply(msg.type === 'find' ? await find(msg) : msg.type === 'ping' ? { pong: true } : { error: 'unknown request' });
      } catch (e) {
        reply({ error: e.message });
      }
    }
  });
  process.stdin.on('end', () => process.exit(0));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) serve();
