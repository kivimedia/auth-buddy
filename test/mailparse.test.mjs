import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pick, domainMatches, senderVerified, parseMessage } from '../native-host/mailparse.mjs';
import { MAIL_RULES, mailRuleFor } from '../src/mailrules.js';

const AUTHNET = MAIL_RULES.find((r) => r.id === 'authorize.net');
const CLAUDE = MAIL_RULES.find((r) => r.id === 'claude.ai');
const b64 = (s) => Buffer.from(s).toString('base64url');
const googleAuth = (domain) => `mx.google.com; dkim=pass header.i=@${domain} header.s=s1; spf=pass smtp.mailfrom=x@${domain}; dmarc=pass (p=REJECT) header.from=${domain}`;

// Shaped like the Gmail API "full" format, as the real Authorize.net and Claude mails were on 25-Nov-2026.
export function gmailMessage({ id = 'm1', at, from, auth, html, extraAuth, to = 'Me <me@example.com>' }) {
  const headers = [];
  if (auth) headers.push({ name: 'Authentication-Results', value: auth });
  if (extraAuth) headers.push({ name: 'Authentication-Results', value: extraAuth });
  headers.push({ name: 'From', value: from }, { name: 'To', value: to }, { name: 'Subject', value: 'x' });
  return { id, internalDate: String(at), payload: { mimeType: 'text/html', headers, body: { data: b64(html) } } };
}
const pinMail = (pin, at, over = {}) =>
  gmailMessage({
    at,
    from: '"Authorize.Net" <support@authorize.net>',
    auth: googleAuth('authorize.net'),
    html: `<p>To ensure your account security, you must confirm your identity by entering the eight-digit PIN below.</p><p>Your Verification PIN is: ${pin}</p>`,
    ...over,
  });
const linkMail = (href, at, over = {}) =>
  gmailMessage({
    at,
    from: 'Anthropic <no-reply-abc@mail.anthropic.com>',
    auth: 'mx.google.com; dkim=pass header.i=@antispam.mailspamprotection.com header.s=default; dkim=pass header.i=@mail.anthropic.com header.s=s1; arc=pass',
    html: `<a href="https://fonts.googleapis.com/css?family=x">f</a><a href="https://url8792.mail.anthropic.com/ls/click?upn=1">track</a><a href="${href}">Sign in</a>`,
    ...over,
  });

const T = 1_795_606_955_000;

test('domain matching respects dot boundaries', () => {
  assert.ok(domainMatches('mail.anthropic.com', ['anthropic.com']));
  assert.ok(domainMatches('authorize.net', ['authorize.net']));
  assert.ok(!domainMatches('authorize.net.evil.com', ['authorize.net']));
  assert.ok(!domainMatches('notauthorize.net', ['authorize.net']));
});

test('Authorize.net: newest PIN after the request time', () => {
  const r = pick([pinMail('11111111', T - 120000, { id: 'old' }), pinMail('22222222', T + 5000, { id: 'new' })], AUTHNET, T);
  assert.equal(r.code, '22222222');
});

test('Authorize.net: a PIN from before the request is never used', () => {
  assert.equal(pick([pinMail('11111111', T - 1)], AUTHNET, T), null);
});

test('planted bad: spoofed sender with no Gmail verification is ignored', () => {
  const spoof = pinMail('66666666', T + 1, { auth: 'mx.google.com; dkim=none; spf=fail smtp.mailfrom=x@evil.com; dmarc=fail header.from=authorize.net' });
  assert.equal(pick([spoof], AUTHNET, T), null);
});

test('planted bad: a forged pass line below a failing Gmail line is ignored', () => {
  const m = pinMail('66666666', T + 1, { auth: 'mx.google.com; dmarc=fail header.from=authorize.net', extraAuth: googleAuth('authorize.net') });
  assert.equal(senderVerified(parseMessage(m), AUTHNET.from), false);
  assert.equal(pick([m], AUTHNET, T), null);
});

test('planted bad: Authentication-Results not written by Gmail is ignored', () => {
  const m = pinMail('66666666', T + 1, { auth: googleAuth('authorize.net').replace('mx.google.com', 'mx.evil.com') });
  assert.equal(pick([m], AUTHNET, T), null);
});

test('planted bad: look-alike sender domain is ignored', () => {
  const m = pinMail('66666666', T + 1, { from: 'support@authorize.net.evil.com', auth: googleAuth('authorize.net.evil.com') });
  assert.equal(pick([m], AUTHNET, T), null);
});

test('Claude: the magic link, verified by DKIM through a forwarder', () => {
  const r = pick([linkMail('https://claude.ai/magic-link#tok123', T + 1000)], CLAUDE, T);
  assert.equal(r.link, 'https://claude.ai/magic-link#tok123');
});

test('planted bad: a link to another host or path is never returned', () => {
  for (const href of ['https://claude.ai.evil.com/magic-link#x', 'https://evil.com/?r=https://claude.ai/magic-link', 'http://claude.ai/magic-link#x', 'https://claude.ai/settings'])
    assert.equal(pick([linkMail(href, T + 1000)], CLAUDE, T), null, href);
});

test('planted bad: a newer link sent to ANOTHER account in the same inbox is never used', () => {
  const mine = linkMail('https://claude.ai/magic-link#mine', T + 1000, { id: 'mine', to: 'me@example.com' });
  const other = linkMail('https://claude.ai/magic-link#other', T + 5000, { id: 'other', to: 'Someone <ME.other@example.com>' });
  assert.equal(pick([mine, other], CLAUDE, T, 'me@example.com').link, 'https://claude.ai/magic-link#mine');
  assert.equal(pick([other], CLAUDE, T, 'me@example.com'), null);
  // An address that merely contains mine is not mine.
  assert.equal(pick([linkMail('https://claude.ai/magic-link#x', T + 1, { to: 'notme@example.com' })], CLAUDE, T, 'me@example.com'), null);
  // Matching ignores case and display names.
  assert.equal(pick([linkMail('https://claude.ai/magic-link#y', T + 1, { to: '"Me" <Me@Example.com>' })], CLAUDE, T, 'me@example.com').link, 'https://claude.ai/magic-link#y');
});

test('rules are chosen from the page URL', () => {
  assert.equal(mailRuleFor('https://login.authorize.net/verification-required').id, 'authorize.net');
  assert.equal(mailRuleFor('https://claude.ai/login').id, 'claude.ai');
  assert.equal(mailRuleFor('https://claude.ai/new'), null);
  assert.equal(mailRuleFor('https://authorize.net.evil.com/x'), null);
});

test('the Authorize.net send button text matches, other buttons do not', () => {
  const re = new RegExp(AUTHNET.sendButton, 'i');
  assert.ok(re.test('EMAIL PIN TO JO****@EXAMPLE.COM'));
  assert.ok(!re.test('RETURN TO LOG IN PAGE'));
  assert.ok(!re.test('Already have a PIN?'));
});
