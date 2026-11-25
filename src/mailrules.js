// Sites that send the sign-in step by email. One row per site.
// site:        the page's host must be this domain or a subdomain of it (taken from Chrome, never from the page)
// paths:       optional, only these page paths (regex source)
// from:        the mail must come from these domains, and Gmail must have verified that
// sendButton:  a button to press that asks the site to email the code (regex source on its text); pressed at most once per 3 minutes
// pageHint:    page text that shows this is the "check your email" step (regex source)
// code:        { pattern } regex source, group 1 = the code in the mail
// link:        { host, pathPrefix } the only link Auth Buddy may open from the mail
export const MAIL_RULES = [
  {
    id: 'authorize.net',
    name: 'Authorize.net',
    site: 'authorize.net',
    from: ['authorize.net'],
    sendButton: '^\\s*email pin to\\b',
    pageHint: '\\bPIN\\b',
    code: { pattern: 'Verification PIN is:?\\s*(\\d{8})\\b' },
  },
  {
    id: 'claude.ai',
    name: 'Claude',
    site: 'claude.ai',
    paths: '^/(login|signup)',
    from: ['anthropic.com'],
    pageHint: 'check your (e-?mail|inbox)|sent (you )?(a |an )?(secure |sign.?in |login |magic )?(link|e-?mail)|secure link',
    link: { host: 'claude.ai', pathPrefix: '/magic-link' },
  },
];

const hostMatch = (host, site) => host === site || host.endsWith('.' + site);

export function mailRuleFor(url) {
  const u = new URL(url);
  return MAIL_RULES.find((r) => hostMatch(u.hostname, r.site) && (!r.paths || new RegExp(r.paths).test(u.pathname))) || null;
}
