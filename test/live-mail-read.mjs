// Live check of the mail helper against YOUR real inbox through gws (read-only).
// Looks back N hours (default 24) for each rule and prints what it found, masked.
// Run: node test/live-mail-read.mjs [hours]
import { find } from '../native-host/authbuddy-mail.mjs';
import { detectGws } from '../native-host/install.mjs';
import { MAIL_RULES } from '../src/mailrules.js';

process.env.AUTHBUDDY_GWS ||= JSON.stringify(detectGws());
const hours = Number(process.argv[2] || 24);
const since = Date.now() - hours * 3600e3;
let failed = 0;
for (const rule of MAIL_RULES) {
  const t = Date.now();
  const r = await find({ since, rule });
  const ms = Date.now() - t;
  if (r.error || !r.found) {
    failed++;
    console.log(`MISS ${rule.id}: ${r.error || `nothing in ${r.checked} mails`} (${ms} ms)`);
    continue;
  }
  const what = r.code ? `code ${r.code.slice(0, 2)}${'*'.repeat(r.code.length - 2)} (${r.code.length} digits)` : `link ${new URL(r.link).origin}${new URL(r.link).pathname}#<masked>`;
  console.log(`OK   ${rule.id}: ${what}, received ${new Date(r.receivedAt).toISOString()} (${ms} ms)`);
}
process.exit(failed ? 1 : 0);
