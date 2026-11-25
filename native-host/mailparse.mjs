// Pure helpers: turn a Gmail API message (format "full") into what Auth Buddy needs.
// No I/O here, so the unit tests can feed real-shaped messages.

const decode = (data) => Buffer.from(data, 'base64url').toString('utf8');

/** a.b.example.com matches example.com; example.com.evil.net does not. */
export function domainMatches(domain, allowed) {
  const d = String(domain || '').toLowerCase();
  return allowed.some((a) => {
    const x = a.toLowerCase();
    return d === x || d.endsWith('.' + x);
  });
}

export function parseMessage(m) {
  const headers = m.payload?.headers || [];
  const get = (name) => headers.find((h) => h.name.toLowerCase() === name)?.value || '';
  const from = get('from');
  const fromAddr = (from.match(/<([^>]+)>/)?.[1] || from).trim();
  const fromDomain = fromAddr.split('@')[1]?.toLowerCase() || '';
  // Only the TOP Authentication-Results line is written by Gmail itself; anything below it came with the mail.
  const firstAuth = headers.find((h) => h.name.toLowerCase() === 'authentication-results')?.value || '';
  const parts = [];
  (function walk(p) {
    if (!p) return;
    if (p.parts) p.parts.forEach(walk);
    else if (p.body?.data) parts.push({ type: p.mimeType, body: decode(p.body.data) });
  })(m.payload);
  const html = parts.filter((p) => p.type === 'text/html').map((p) => p.body).join('\n');
  const plain = parts.filter((p) => p.type === 'text/plain').map((p) => p.body).join('\n');
  return { id: m.id, receivedAt: Number(m.internalDate || 0), from: fromAddr, fromDomain, auth: firstAuth, html, plain };
}

/** Gmail itself says the sender is real: DMARC pass for the From domain, or a DKIM pass signed by an allowed domain. */
export function senderVerified(msg, allowed) {
  const a = msg.auth.replace(/\s+/g, ' ');
  if (!/^mx\.google\.com;/i.test(a)) return false;
  const dmarc = a.match(/dmarc=pass\b[^;]*header\.from=([^\s;]+)/i);
  if (dmarc && domainMatches(dmarc[1], allowed) && domainMatches(msg.fromDomain, allowed)) return true;
  for (const d of a.matchAll(/dkim=pass header\.i=@([^\s;]+)/gi))
    if (domainMatches(d[1], allowed) && domainMatches(msg.fromDomain, allowed)) return true;
  return false;
}

export function textOf(msg) {
  if (msg.plain) return msg.plain;
  return msg.html
    .replace(/<(style|script)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ');
}

/** pattern: a regex source whose first group is the code. */
export function extractCode(msg, pattern) {
  const m = textOf(msg).match(new RegExp(pattern, 'i'));
  return m ? m[1] : null;
}

/** First link in the mail whose host and path match exactly what the rule allows. */
export function extractLink(msg, { host, pathPrefix }) {
  const html = msg.html || msg.plain;
  for (const m of html.matchAll(/href\s*=\s*["']([^"']+)["']/gi)) {
    const raw = m[1].replace(/&amp;/g, '&');
    let u;
    try {
      u = new URL(raw);
    } catch {
      continue;
    }
    if (u.protocol === 'https:' && u.hostname === host && u.pathname.startsWith(pathPrefix)) return u.href;
  }
  return null;
}

/**
 * Newest matching mail received at or after `since` (ms). Returns { code } or { link } or null.
 * rule: { from: [domains], code?: { pattern }, link?: { host, pathPrefix } }
 */
export function pick(messages, rule, since) {
  const parsed = messages.map(parseMessage).filter((m) => m.receivedAt >= since).sort((a, b) => b.receivedAt - a.receivedAt);
  for (const msg of parsed) {
    if (!domainMatches(msg.fromDomain, rule.from) || !senderVerified(msg, rule.from)) continue;
    if (rule.code) {
      const code = extractCode(msg, rule.code.pattern);
      if (code) return { code, receivedAt: msg.receivedAt };
    }
    if (rule.link) {
      const link = extractLink(msg, rule.link);
      if (link) return { link, receivedAt: msg.receivedAt };
    }
  }
  return null;
}
