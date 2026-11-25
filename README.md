# Auth Buddy

A Chrome extension that fills in your authenticator (TOTP) codes on the sites you choose.

Add an account once from a picture of its QR code. After that, when that site asks for your
6-digit code, Auth Buddy types it in for you, and submits it when the page has one clear button.

## How it works

- **Add accounts** in Settings: drop, paste or choose a QR image. Both a single-site
  `otpauth://` QR and a Google Authenticator "Transfer accounts" export QR (many accounts at
  once) work. You can also paste a setup key.
- **Pick the sites**: each account fills codes only on the addresses you list for it
  (`github.com` also covers `login.github.com`, but not `evilgithub.com`).
- **On the site**: Auth Buddy finds the code box (one field, or six single-digit boxes, even when
  they appear late), fills the current code, and clicks the submit button when there is exactly
  one. If a code has less than 3 seconds left, it waits for the next one.
- **Toolbar popup**: shows the code for the site you are on, with a copy button.

## Codes and sign-in links sent by email

Some sites email the second step instead. For the sites in `src/mailrules.js` Auth Buddy does it
for you, and a box in the corner of the page says what it is doing, second by second:

- **Authorize.net** "Verify Your Identity": presses "EMAIL PIN TO ...", waits for the PIN email,
  fills the 8-digit PIN and submits.
- **Claude** (claude.ai): after you ask for the sign-in email, opens the "Sign in" link from it
  in the same tab.

Adding a site is one row in `src/mailrules.js` (who sends the mail, the code pattern or the
link's host and path, and the button to press, if any).

It reads your inbox through a small local helper (`native-host/`) that uses the
[`gws`](https://github.com/googleworkspace/cli) command line you are already signed in to.
Set it up once:

```
node native-host/install.mjs     # finds Auth Buddy in your Chrome profiles and registers the helper
node test/live-mail-read.mjs 24  # read-only check: finds the last day's codes and links, masked
```

Safety rules:
- Only this extension can start the helper (Chrome checks the extension id).
- The site is taken from Chrome, never from the page. A mail counts only if Gmail's own
  check says it really came from the site's domain (DMARC or DKIM pass), and only if it arrived
  after you asked for it. A code or link is never used twice.
- A link is opened only when its address matches the rule exactly; the page never sees it.
- The "email me" button is pressed at most once every 3 minutes, so a wrong PIN cannot loop.
- Email codes work while the PIN vault is locked; they do not use your saved secrets.

## Security

- Secrets are encrypted with AES-GCM using a key derived from your PIN (PBKDF2-SHA256,
  310,000 rounds) and stored only in this Chrome profile. Nothing is sent anywhere.
- You unlock once per browser session. The unlocked key lives in `chrome.storage.session`,
  which Chrome clears when the browser closes, and which page scripts cannot read.
- A page only ever gets the current 6-digit code, only for its own address (taken from Chrome,
  not from the page), and only while unlocked.
- Stored in the clear: which sites have an account (so a locked page can tell you to unlock).
- Forgot your PIN: erase and re-add your accounts. There is no recovery by design.

Auto-filling a second factor means anyone who can use your unlocked browser can pass that
factor. Lock it (popup or Settings) when you step away.

## Install (unpacked)

1. Download or clone this repository.
2. Open `chrome://extensions`, turn on **Developer mode**.
3. Click **Load unpacked** and choose the repository folder.
4. Settings opens: choose a PIN, then add your first QR code.

## Development

```
npm install
npm test                 # unit tests, including the RFC 6238 test vectors
node test/e2e.mjs        # loads the extension in Chromium and logs in to a local test site
node test/e2e-mail.mjs   # email codes and links: real helper over native messaging, test mailbox
```

Set `CHROMIUM_PATH` if Playwright's bundled browser is not installed.

## License

MIT. Bundles [jsQR](https://github.com/cozmo/jsQR) 1.4.0 (`vendor/jsQR.js`, Apache-2.0) for reading QR images.
