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
```

Set `CHROMIUM_PATH` if Playwright's bundled browser is not installed.

## License

MIT. Bundles [jsQR](https://github.com/cozmo/jsQR) 1.4.0 (`vendor/jsQR.js`, Apache-2.0) for reading QR images.
