// Helm — public share links for a workspace's dev server, via Cloudflare
// "quick tunnels" (`cloudflared tunnel --url …`).
//
// WHAT THIS IS: cloudflared dials OUT to Cloudflare's edge, which then serves
// a `https://<random-words>.trycloudflare.com` URL to the whole internet and
// proxies it back down to 127.0.0.1:<port>. It is the same shape as VS Code's
// port forwarding (which uses Microsoft's dev-tunnel service instead).
//
// SECURITY — read before changing anything here:
//   * A quick-tunnel URL is COMPLETELY UNAUTHENTICATED. The random hostname is
//     not a password: anyone who has the link, or who is forwarded it, reaches
//     the dev server. The UI warns hard and every tunnel self-expires; do not
//     quietly weaken either.
//   * Helm's own port must NEVER be tunnelled — the served index.html carries
//     the auth token, so a public link to it hands out a terminal on this
//     machine. Enforced here (`blockedPorts`), not just in the UI.
//   * Tunnels are deliberately NOT persisted. A server restart drops every
//     one, which is the fail-closed direction: you must consciously re-share.
//
// Helm never downloads a binary itself. It detects cloudflared on PATH and,
// when it's missing, can run the platform's package-manager install command
// (INSTALL_COMMAND) — but only on an explicit click, and in a VISIBLE pane so
// the owner watches it happen and answers any elevation prompt themselves.
// (Revised 2026-08-26: the original "detect, never install" call left a dead
// end — an error naming a program most people have never heard of.)

import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { dbg } from './log.mjs';

// How long a share link lives before it kills itself, and how much an
// "extend" buys. The real failure mode isn't a misclick, it's a tunnel still
// up tomorrow morning — so this is the load-bearing safety net, not the modal.
export const TUNNEL_TTL_MS = 30 * 60 * 1000;

// Where to look for cloudflared, in order. PATH FIRST, then the places the
// package managers actually put it.
//
// Why the absolute paths matter (learned the hard way, 2026-08-26): winget put
// cloudflared in `C:\Program Files (x86)\cloudflared` and added that to the
// MACHINE PATH — but a process only ever sees the PATH it inherited when it
// was spawned. The long-running Helm server therefore stayed blind to a
// freshly installed cloudflared and kept insisting it wasn't there, no matter
// how often detection re-ran. Restarting the server would fix it and kill
// every live pane — exactly the trade this feature must not force. So probe
// known locations too, and drive whatever absolute path answers.
function cloudflaredCandidates() {
  // The test suite pins one exact stand-in; never widen the search past it.
  if (process.env.HELM_CLOUDFLARED_CMD) return [process.env.HELM_CLOUDFLARED_CMD];
  const env = process.env;
  if (process.platform === 'win32') {
    // path.join, not template literals — a Windows path in a JS string is a
    // backslash-escaping trap, and a silently mangled path just looks like
    // "cloudflared isn't installed".
    const dirs = [
      [env.ProgramFiles || 'C:\\Program Files', 'cloudflared'],
      [env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'cloudflared'],
      // winget's shim dir, then chocolatey's
      env.LOCALAPPDATA && [env.LOCALAPPDATA, 'Microsoft', 'WinGet', 'Links'],
      [env.ProgramData || 'C:\\ProgramData', 'chocolatey', 'bin'],
    ].filter(Boolean);
    return [
      'cloudflared', // inherited PATH — the common case
      ...dirs.map((d) => path.join(...d, 'cloudflared.exe')),
    ];
  }
  return [
    'cloudflared',
    '/opt/homebrew/bin/cloudflared', // Apple-silicon brew
    '/usr/local/bin/cloudflared', // intel brew / manual
    '/usr/bin/cloudflared',
  ];
}

// A .cmd/.bat needs a shell on Node 22 (spawn won't exec it directly) — the
// same trap the headless-claude call hit. A real cloudflared is a plain .exe
// and takes the no-shell path.
const needsShell = (cmd) => /\.(cmd|bat)$/i.test(cmd);

// Cloudflare prints the quick-tunnel URL inside an ASCII box on stderr.
const URL_RE = /https:\/\/[a-z0-9][a-z0-9-]*\.trycloudflare\.com/i;

// The command Helm can run FOR the user (in a visible pane, so nothing is
// hidden and any UAC/permission prompt is theirs to answer). null where there
// is no single reliable one-liner — the UI then shows the docs link only.
// `winget` on PATH is an App Execution Alias — a zero-byte reparse point that
// does NOT resolve for spawned child processes, so a pane running bare
// `winget ...` dies instantly with exit 1 ("not recognized"). Its real
// executable under WindowsApps works fine, including from cmd.exe, so prefer
// that and keep the bare name as a fallback. (Hit for real 2026-08-26.)
function wingetCommand() {
  const exe = process.env.LOCALAPPDATA
    ? path.join(process.env.LOCALAPPDATA, 'Microsoft', 'WindowsApps', 'winget.exe')
    : null;
  // Test with lstat, NOT existsSync: the alias is a symlink whose target isn't
  // a normally resolvable path, so existsSync follows it and reports false for
  // a file that runs perfectly well. lstat looks at the link itself.
  let present = false;
  try {
    present = Boolean(exe) && fs.lstatSync(exe).size >= 0;
  } catch {
    present = false;
  }
  const bin = present ? `"${exe}"` : 'winget';
  return `${bin} install --id Cloudflare.cloudflared -e --accept-source-agreements --accept-package-agreements`;
}

export const INSTALL_COMMAND =
  process.platform === 'win32'
    ? wingetCommand()
    : process.platform === 'darwin'
      ? 'brew install cloudflared'
      : null;

export const INSTALL_DOCS =
  'https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/';

export const INSTALL_HINT =
  process.platform === 'win32'
    ? 'winget install --id Cloudflare.cloudflared'
    : process.platform === 'darwin'
      ? 'brew install cloudflared'
      : 'see https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/';

/**
 * @typedef {object} Tunnel
 * @property {string} workspaceId
 * @property {number} port
 * @property {'starting'|'live'|'error'} status
 * @property {string|null} url
 * @property {string|null} error
 * @property {number} startedAt   ms epoch
 * @property {number} expiresAt   ms epoch — self-kill deadline
 * @property {import('node:child_process').ChildProcess|null} proc
 * @property {NodeJS.Timeout|null} timer
 */

/** @type {Map<string, Tunnel>} workspace id → tunnel */
const tunnels = new Map();

// A FOUND cloudflared is cached for good (it won't vanish mid-session), but a
// MISS is only cached briefly. Installing cloudflared is the obvious next step
// after Helm says it's missing, and a permanent negative would mean restarting
// the server to pick it up — which kills every live pane. The throttle keeps
// the 4 s /api/tunnels poll from spawning processes every tick.
const MISS_RECHECK_MS = 10_000;
/**
 * @type {{checked: boolean, available: boolean, version: string|null,
 *         path: string|null, at: number}}
 */
const cli = { checked: false, available: false, version: null, path: null, at: 0 };

/** Ask one candidate for its version. Resolves null when it isn't there. */
function probe(cmd) {
  return new Promise((resolve) => {
    execFile(
      cmd,
      ['--version'],
      { timeout: 5000, windowsHide: true, shell: needsShell(cmd) },
      (err, stdout) => {
        if (err) return resolve(null);
        resolve(String(stdout).trim().split('\n')[0] || 'cloudflared');
      },
    );
  });
}

export async function checkCloudflared() {
  const fresh = cli.available || Date.now() - cli.at < MISS_RECHECK_MS;
  if (cli.checked && fresh) return cli;
  const wasAvailable = cli.available;
  let found = null;
  for (const cmd of cloudflaredCandidates()) {
    const version = await probe(cmd);
    if (version) {
      found = { cmd, version };
      break;
    }
  }
  cli.checked = true;
  cli.at = Date.now();
  cli.available = Boolean(found);
  cli.version = found?.version ?? null;
  cli.path = found?.cmd ?? null;
  // Only announce a state CHANGE, or the recheck would spam the 🐞 log.
  if (found && !wasAvailable) dbg('tunnel', `cloudflared found: ${found.version} (${found.cmd})`);
  return cli;
}

/** Public shape for the API — never leaks the child process handle. */
export function tunnelInfo(t) {
  return {
    workspaceId: t.workspaceId,
    port: t.port,
    status: t.status,
    url: t.url,
    error: t.error,
    startedAt: t.startedAt,
    expiresAt: t.expiresAt,
  };
}

export function listTunnels() {
  return [...tunnels.values()].map(tunnelInfo);
}

export function getTunnel(workspaceId) {
  return tunnels.get(workspaceId) || null;
}

// (Re)arm a tunnel's self-kill deadline. The timer checks it is still the
// REGISTERED tunnel before firing: a failed share that gets retried leaves the
// old record's timer pending, and an identity-blind callback would then take
// down its healthy replacement half an hour later.
function armExpiry(tunnel, label) {
  if (tunnel.timer) clearTimeout(tunnel.timer);
  tunnel.expiresAt = Date.now() + TUNNEL_TTL_MS;
  tunnel.timer = setTimeout(() => {
    if (tunnels.get(tunnel.workspaceId) !== tunnel) return; // superseded
    dbg('tunnel', `${label}: share link expired — closing`);
    stopTunnel(tunnel.workspaceId);
  }, TUNNEL_TTL_MS);
}

/**
 * Start a public tunnel to 127.0.0.1:<port> for a workspace.
 * Rejects (throws) on a blocked port or a missing cloudflared; resolves with
 * the tunnel record as soon as cloudflared hands us a URL.
 * @param {{workspaceId: string, port: number, label: string, blockedPorts: number[]}} opts
 */
export async function startTunnel({ workspaceId, port, label, blockedPorts = [] }) {
  if (blockedPorts.includes(port)) {
    // Helm itself. See the security note at the top of this file.
    throw Object.assign(
      new Error(
        `refusing to share port ${port} — that is Helm's own port, and its pages carry the auth token`,
      ),
      { code: 'BLOCKED_PORT' },
    );
  }
  const existing = tunnels.get(workspaceId);
  if (existing && existing.status !== 'error') {
    throw Object.assign(new Error('this project is already shared'), { code: 'ALREADY_SHARED' });
  }
  const { available } = await checkCloudflared();
  if (!available) {
    throw Object.assign(new Error(`cloudflared not found. Install it with: ${INSTALL_HINT}`), {
      code: 'NO_CLOUDFLARED',
    });
  }

  const now = Date.now();
  /** @type {Tunnel} */
  const tunnel = {
    workspaceId,
    port,
    status: 'starting',
    url: null,
    error: null,
    startedAt: now,
    expiresAt: now + TUNNEL_TTL_MS,
    proc: null,
    timer: null,
  };
  tunnels.set(workspaceId, tunnel);

  const bin = cli.path || 'cloudflared'; // absolute path when PATH didn't have it
  const proc = spawn(bin, ['tunnel', '--no-autoupdate', '--url', `http://localhost:${port}`], {
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: needsShell(bin),
  });
  tunnel.proc = proc;

  // cloudflared logs to stderr, but scan both so an upstream change doesn't
  // silently lose us the URL.
  const scan = (chunk) => {
    if (tunnel.url) return;
    const m = String(chunk).match(URL_RE);
    if (!m) return;
    tunnel.url = m[0];
    tunnel.status = 'live';
    dbg('tunnel', `${label} :${port} is PUBLIC at ${tunnel.url} (expires in 30m)`);
  };
  proc.stdout?.on('data', scan);
  proc.stderr?.on('data', scan);

  proc.on('error', (err) => {
    tunnel.status = 'error';
    tunnel.error = err.message;
    // ENOENT emits 'error' but never 'exit', so the deadline is released here
    // rather than leaving a pending timer behind.
    if (tunnel.timer) clearTimeout(tunnel.timer);
    tunnel.timer = null;
    dbg('error', `tunnel for ${label} failed to launch: ${err.message}`);
  });
  proc.on('exit', (code) => {
    // Any exit means the link is dead — drop it so the UI stops advertising a
    // URL that no longer resolves.
    if (tunnel.timer) clearTimeout(tunnel.timer);
    if (tunnels.get(workspaceId) === tunnel) {
      if (tunnel.status === 'starting') {
        tunnel.status = 'error';
        tunnel.error = tunnel.error || `cloudflared exited (code ${code}) before giving a URL`;
        dbg('error', `tunnel for ${label} exited early: ${tunnel.error}`);
      } else {
        tunnels.delete(workspaceId);
        dbg('tunnel', `${label} is no longer public (cloudflared exited, code ${code})`);
      }
    }
  });

  armExpiry(tunnel, label);

  // Give cloudflared a moment to produce the URL so the caller can return it
  // directly; if it's slow, the record stays 'starting' and the sidebar poll
  // picks the URL up. 15 s is generous — a quick tunnel is usually ~3 s.
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline && tunnel.status === 'starting') {
    await new Promise((r) => setTimeout(r, 150));
  }
  return tunnel;
}

/** Push a live tunnel's deadline out by another full TTL. */
export function extendTunnel(workspaceId) {
  const tunnel = tunnels.get(workspaceId);
  if (!tunnel) return null;
  armExpiry(tunnel, `workspace ${workspaceId}`);
  dbg('tunnel', `workspace ${workspaceId}: share link extended by 30m`);
  return tunnel;
}

export function stopTunnel(workspaceId) {
  const tunnel = tunnels.get(workspaceId);
  if (!tunnel) return false;
  tunnels.delete(workspaceId);
  if (tunnel.timer) clearTimeout(tunnel.timer);
  try {
    tunnel.proc?.kill();
  } catch {
    /* already gone */
  }
  dbg('tunnel', `workspace ${workspaceId}: share link closed`);
  return true;
}

/** Shutdown / workspace-delete cleanup. */
export function stopAllTunnels() {
  const n = tunnels.size;
  for (const id of [...tunnels.keys()]) stopTunnel(id);
  return n;
}
