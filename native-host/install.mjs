// Registers the mail helper with Chrome for the current user.
// Run: node native-host/install.mjs [--id <extension id>]...   (no --id: finds Auth Buddy in your Chrome profiles)
// Writes (all gitignored, machine-specific): host.cmd, config.json, the host manifest.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const HOST_NAME = 'co.kivimedia.authbuddy_mail';
const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '..');
const win = process.platform === 'win32';

// Where your gws command really lives. On Windows a .cmd shim of the form `node "<script>" %*` is unwrapped,
// because Node cannot start .cmd files without a shell.
export function detectGws() {
  if (process.env.AUTHBUDDY_GWS) return JSON.parse(process.env.AUTHBUDDY_GWS);
  if (!win) return ['gws'];
  let shim = '';
  try {
    shim = execFileSync('where', ['gws.cmd'], { encoding: 'utf8' }).split(/\r?\n/)[0].trim();
  } catch {}
  if (shim) {
    const m = fs.readFileSync(shim, 'utf8').match(/^\s*node(?:\.exe)?\s+"([^"]+)"\s+%\*/im);
    if (m) return [process.execPath, m[1]];
  }
  const npmCli = path.join(process.env.APPDATA || '', 'npm', 'node_modules', '@googleworkspace', 'cli', 'run-gws.js');
  if (fs.existsSync(npmCli)) return [process.execPath, npmCli];
  throw new Error('Could not find the gws command. Set AUTHBUDDY_GWS to a JSON argv, e.g. ["node","C:/path/run-gws.js"]');
}

// Every Chrome profile that has this folder loaded unpacked.
export function findExtensionIds() {
  const base = win
    ? path.join(process.env.LOCALAPPDATA || '', 'Google', 'Chrome', 'User Data')
    : path.join(os.homedir(), '.config', 'google-chrome');
  const ids = new Set();
  if (!fs.existsSync(base)) return [];
  for (const dir of fs.readdirSync(base)) {
    for (const file of ['Secure Preferences', 'Preferences']) {
      try {
        const prefs = JSON.parse(fs.readFileSync(path.join(base, dir, file), 'utf8'));
        for (const [id, v] of Object.entries(prefs.extensions?.settings || {}))
          if (v.path && path.resolve(v.path).toLowerCase() === repo.toLowerCase()) ids.add(id);
      } catch {}
    }
  }
  return [...ids];
}

/** Writes the launcher and manifest into `dir`. Returns the manifest path. */
export function writeHost(dir, ids, gws) {
  fs.mkdirSync(dir, { recursive: true });
  const script = path.join(here, 'authbuddy-mail.mjs');
  let launcher;
  if (win) {
    launcher = path.join(dir, 'host.cmd');
    fs.writeFileSync(launcher, `@echo off\r\n"${process.execPath}" "${script}" %*\r\n`);
  } else {
    launcher = path.join(dir, 'host.sh');
    fs.writeFileSync(launcher, `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`, { mode: 0o755 });
  }
  if (gws) fs.writeFileSync(path.join(here, 'config.json'), JSON.stringify({ gws }, null, 2));
  const manifest = path.join(dir, `${HOST_NAME}.json`);
  fs.writeFileSync(
    manifest,
    JSON.stringify(
      {
        name: HOST_NAME,
        description: 'Auth Buddy mail helper: reads sign-in codes and links from your inbox',
        path: launcher,
        type: 'stdio',
        allowed_origins: ids.map((id) => `chrome-extension://${id}/`),
      },
      null,
      2,
    ),
  );
  return manifest;
}

/** browsers: registry sub-keys under HKCU\Software (Windows) or config folders (Linux). */
export function register(manifest, browsers = ['Google\\Chrome']) {
  for (const b of browsers) {
    if (win) {
      execFileSync('reg', ['add', `HKCU\\Software\\${b}\\NativeMessagingHosts\\${HOST_NAME}`, '/ve', '/t', 'REG_SZ', '/d', manifest, '/f'], { stdio: 'ignore' });
    } else {
      const d = path.join(os.homedir(), '.config', b === 'Google\\Chrome' ? 'google-chrome' : 'chromium', 'NativeMessagingHosts');
      fs.mkdirSync(d, { recursive: true });
      fs.copyFileSync(manifest, path.join(d, `${HOST_NAME}.json`));
    }
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const ids = [];
  for (let i = 0; i < args.length; i++) if (args[i] === '--id') ids.push(args[++i]);
  if (!ids.length) ids.push(...findExtensionIds());
  if (!ids.length) {
    console.error('Auth Buddy is not loaded in any Chrome profile yet. Load it, then run this again (or pass --id).');
    process.exit(1);
  }
  const gws = detectGws();
  const manifest = writeHost(path.join(here, 'out'), ids, gws);
  register(manifest);
  console.log(`Registered ${HOST_NAME} for ${ids.join(', ')}\n  manifest: ${manifest}\n  gws: ${gws.join(' ')}`);
}
