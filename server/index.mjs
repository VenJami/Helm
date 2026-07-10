// Helm ⎈ — vertical slice server
// Express (HTTP + static) + ws (WebSocket) + node-pty (real `claude` sessions).
// REST creates/kills sessions; WebSockets only attach. Socket close ≠ PTY kill.

import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { WebSocketServer } from 'ws';
import ptyPkg from 'node-pty';
import { dbg, logsSince, SERVER_STARTED_AT } from './src/log.mjs';
import { readJsonWithBackup, writeFileAtomic, writeJsonAtomic } from './src/persist.mjs';
import {
  CLAUDE_CMD, accountEmail, checkClaudeVersion, diagnostics, firstPromptSummary,
  noteDrift, parseTranscriptFile, tokenCost, transcriptFiles,
} from './src/claude.mjs';

const { spawn } = ptyPkg;

// Process-level guards. One process hosts every pane, so an uncaught error
// crashing it would take all live terminals down with it — after boot, log
// loudly (🐞 drawer + console) and keep serving. During boot we stay
// fail-fast: a broken start should exit visibly, not hang half-initialized.
// Known node-pty bug kept from before (version pinned in package.json — the
// stack match below silently disarms if that file is ever renamed upstream,
// so don't float it): killing a pty whose process already died can throw
// `TypeError: ... reading 'forEach'` from windowsPtyAgent.js as a rejection.
let booted = false; // flipped once app.listen succeeds
function absorbProcessError(kind, err) {
  if (err instanceof TypeError && err.stack?.includes('windowsPtyAgent.js')) {
    dbg('error', `ignored node-pty kill race: ${err.message}`);
    return;
  }
  if (!booted) throw err; // boot failure: crash loud
  const msg = `${kind} (server kept alive): ${err?.stack || err}`;
  try { dbg('error', msg); } catch { console.error(msg); }
}
process.on('unhandledRejection', (err) => absorbProcessError('unhandled rejection', err));
process.on('uncaughtException', (err) => absorbProcessError('uncaught exception', err));

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST_DIR = path.join(__dirname, '..', 'web', 'dist');

const HOST = '127.0.0.1';
const PORT = Number(process.env.PORT) || 7777;
const RING_BUFFER_MAX = 200 * 1024; // ~200 KB of output kept per session for replay
const IS_WIN = process.platform === 'win32';
// HELM_DATA_DIR overrides the state dir wholesale — used by the e2e script to
// isolate Helm state while the real ~/.claude login stays untouched.
const HELM_DIR = process.env.HELM_DATA_DIR || (IS_WIN
  ? path.join(process.env.LOCALAPPDATA || os.homedir(), 'Helm')
  : path.join(os.homedir(), '.helm'));
const ACCOUNTS_DIR = path.join(HELM_DIR, 'accounts');
const ATTACHMENTS_DIR = path.join(HELM_DIR, 'attachments');
const WORKSPACES_FILE = path.join(HELM_DIR, 'workspaces.json');
const SESSIONS_FILE = path.join(HELM_DIR, 'sessions.json');
const HOOK_SETTINGS_FILE = path.join(HELM_DIR, 'hook-settings.json');
const SETTINGS_FILE = path.join(HELM_DIR, 'settings.json');

// Random persistent token; embedded in the served page, required on every
// REST call and WS connect (defense against cross-origin drive-by = RCE).
// Tokens persist across server restarts (in %LOCALAPPDATA%\Helm, never the
// OneDrive-synced repo) so open tabs and running panes keep working after a
// restart instead of dying with "bad or missing token". Delete the files to
// rotate.
function persistentToken(filename) {
  const file = path.join(HELM_DIR, filename);
  try {
    const t = fs.readFileSync(file, 'utf8').trim();
    if (/^[0-9a-f]{48}$/.test(t)) return t;
  } catch { /* first run */ }
  const t = crypto.randomBytes(24).toString('hex');
  writeFileAtomic(file, t);
  return t;
}
const TOKEN = persistentToken('token');
// Separate token for the hook relay: passed to each spawned claude via env.
const HOOK_TOKEN = persistentToken('hook-token');
// Constant-time token compare — a plain === bails at the first wrong char, so
// a cross-origin page hammering the API could in principle recover the token
// byte-by-byte from response timing. Length mismatch short-circuits, which
// leaks only the length (fixed and public: 48 hex chars).
function safeEqual(a, b) {
  const ab = Buffer.from(String(a ?? ''));
  const bb = Buffer.from(String(b ?? ''));
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}
const ALLOWED_ORIGINS = new Set([
  `http://127.0.0.1:${PORT}`,
  `http://localhost:${PORT}`,
]);

// Hook config injected into every pane via `claude --settings <file>` — no
// permanent changes to any profile's settings.json. Each event relays to
// POST /api/hook through hook-post.mjs (which no-ops outside Helm sessions).
function writeHookSettings() {
  const command = `"${process.execPath}" "${path.join(__dirname, 'hook-post.mjs')}"`;
  const relay = [{ hooks: [{ type: 'command', command, timeout: 10 }] }];
  fs.mkdirSync(HELM_DIR, { recursive: true });
  fs.writeFileSync(HOOK_SETTINGS_FILE, JSON.stringify({
    hooks: {
      SessionStart: relay,
      UserPromptSubmit: relay,
      Stop: relay,
      Notification: relay,
    },
  }, null, 2));
}
writeHookSettings();

// ---------------------------------------------------------- server settings
// Small user-facing toggles, persisted in %LOCALAPPDATA%\Helm\settings.json.
// autoRevive: respawn every 'dead' session automatically at server start.
const DEFAULT_SETTINGS = { autoRevive: false };
let settings = { ...DEFAULT_SETTINGS };
{
  const saved = readJsonWithBackup(SETTINGS_FILE, 'settings');
  if (saved && typeof saved === 'object') settings = { ...DEFAULT_SETTINGS, ...saved };
}

function saveSettings() {
  writeJsonAtomic(SETTINGS_FILE, settings);
}

/**
 * @typedef {object} Session
 * @property {string} id
 * @property {string} name
 * @property {string} color
 * @property {string} workspace
 * @property {string|null} profile
 * @property {import('node-pty').IPty|null} pty
 * @property {string[]} buffer            ring buffer of raw PTY output for replay
 * @property {number} bufLen
 * @property {Set<import('ws').WebSocket>} sockets
 * @property {'running'|'exited'|'dead'} status
 * @property {number|null} exitCode
 * @property {'working'|'waiting'|'idle'|null} activity
 * @property {string|null} activitySince
 * @property {string|null} activityNote
 * @property {string|null} claudeSessionId  claude's own session id (from hooks) — for --resume
 * @property {string|null} transcriptPath
 * @property {string} createdAt
 */

/** @type {Map<string, Session>} id → session */
const sessions = new Map();

// Random pane identity — nautical/star names to match the Helm theme, and
// accent colors picked to read well on the dark UI.
const PANE_NAMES = [
  'Polaris', 'Rigel', 'Vega', 'Altair', 'Sirius', 'Lyra', 'Orion', 'Atlas',
  'Nova', 'Comet', 'Zephyr', 'Ember', 'Onyx', 'Jade', 'Indigo', 'Cobalt',
  'Argo', 'Beacon', 'Compass', 'Anchor', 'Harbor', 'Tide', 'Reef', 'Gale',
  'Drift', 'Sextant', 'Keel', 'Bosun', 'Sonar', 'Rudder', 'Lantern', 'Buoy',
];
const PANE_COLORS = [
  '#4fc3f7', '#81c784', '#ffb74d', '#f06292', '#ba68c8',
  '#ffd54f', '#4dd0e1', '#ff8a65', '#90a4ae', '#aed581',
];

function randomPaneIdentity() {
  const taken = new Set([...sessions.values()].map((s) => s.name));
  const free = PANE_NAMES.filter((n) => !taken.has(n));
  const name = free.length
    ? free[Math.floor(Math.random() * free.length)]
    : `Pane-${Math.floor(Math.random() * 900) + 100}`;
  const color = PANE_COLORS[Math.floor(Math.random() * PANE_COLORS.length)];
  return { name, color };
}

// ---------------------------------------------------------------- sessions

// Spawn (or respawn, for revive) the claude PTY for a session.
function spawnPty(session, extraArgs, { cols, rows }) {
  /** @type {Record<string, string|undefined>} */
  const env = {
    ...process.env,
    // Lets hook-post.mjs (running inside the pane) report back to this session
    HELM_SESSION_ID: session.id,
    HELM_HOOK_TOKEN: HOOK_TOKEN,
    HELM_PORT: String(PORT),
    // Agent teams (claude ≥2.1.198) silently stop writing assistant lines to
    // the transcript JSONL the moment a team forms — which kills usage
    // tracking AND --resume revive. Classic subagents are unaffected and keep
    // working with teams off. Overrides the user-level settings.json env.
    // Verified end-to-end 2026-07-02 (docs/GOTCHAS.md).
    CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '0',
  };
  // If this server was started from inside a Claude Code session (a pane, the
  // VS Code extension, an agent), the shell carries session-identity vars —
  // and CLAUDE_CODE_CHILD_SESSION makes claude skip writing the transcript
  // JSONL entirely (no usage, no revive). Panes are fresh top-level sessions:
  // scrub the inherited identity. (docs/GOTCHAS.md, verified 2026-07-02)
  for (const k of [
    'CLAUDECODE',
    'CLAUDE_CODE_CHILD_SESSION',
    'CLAUDE_CODE_ENTRYPOINT',
    'CLAUDE_CODE_SESSION_ID',
    'CLAUDE_CODE_SSE_PORT',
    'CLAUDE_AGENT_SDK_VERSION',
  ]) delete env[k];
  if (session.profile) {
    const profileDir = path.join(ACCOUNTS_DIR, session.profile);
    fs.mkdirSync(profileDir, { recursive: true });
    env.CLAUDE_CONFIG_DIR = profileDir;
  }

  // -n gives claude a display name too (shows up in its /resume picker)
  const nameArgs = session.name ? ['-n', session.name] : [];
  const pty = spawn(CLAUDE_CMD, ['--settings', HOOK_SETTINGS_FILE, ...nameArgs, ...extraArgs], {
    name: 'xterm-color',
    cwd: session.workspace,
    cols,
    rows,
    env,
  });
  session.pty = pty;
  session.status = 'running';
  session.exitCode = null;
  dbg('spawn', `${session.name} (${session.id.slice(0, 8)}) pid=${pty.pid} cwd=${session.workspace}` +
    `${session.profile ? ` profile=${session.profile}` : ''}${extraArgs.length ? ` args=${extraArgs.join(' ')}` : ''}`);

  // Both callbacks check `session.pty === pty`: an account switch kills this
  // process and respawns a new one on the same session, and the old process's
  // stragglers (final ConPTY output, its exit event) must not pollute the new
  // one's ring buffer or mark the freshly respawned session as exited.
  pty.onData((data) => {
    if (session.pty !== pty) return;
    session.buffer.push(data);
    session.bufLen += data.length;
    while (session.bufLen > RING_BUFFER_MAX && session.buffer.length > 1) {
      session.bufLen -= session.buffer[0].length;
      session.buffer.shift();
    }
    broadcast(session, { type: 'data', data });
  });

  pty.onExit(({ exitCode }) => {
    if (session.pty !== pty) return; // replaced by a newer spawn — stay silent
    session.status = 'exited';
    session.exitCode = exitCode;
    session.activity = null;
    session.activitySince = null;
    session.activityNote = null;
    dbg('exit', `${session.name} (${session.id.slice(0, 8)}) exited code=${exitCode}`);
    persistSessions();
    // Small delay lets any final ConPTY output land in onData before we
    // announce the exit and close the attached sockets.
    setTimeout(() => {
      if (session.pty !== pty) return; // respawned within the delay window
      broadcast(session, { type: 'exit', code: exitCode });
      for (const ws of session.sockets) ws.close(1000, 'process exited');
      session.sockets.clear();
    }, 150);
  });
}

function createSession({ workspace, profile, cols, rows }) {
  // Auto-map the bare default account onto the named profile signed into the
  // same email, when one exists — so a "default" pane runs in that profile's
  // isolated config dir and its usage is tracked there, instead of the
  // duplicate ~/.claude account. (Owner had default + a profile on the same
  // login; see docs/ACCOUNTS.md.)
  if (!profile) profile = mappedDefaultProfile() || profile;
  // Profile finished onboarding but has no credentials (logged out / login
  // skipped) → boot the pane straight into the login screen (`claude /login`).
  // Fresh or mid-onboarding profiles are left alone: claude's own first-run
  // onboarding includes the login step, and forcing /login there would queue
  // a second login dialog behind it.
  const args = [];
  if (profile) {
    const profileDir = path.join(ACCOUNTS_DIR, profile);
    let onboarded = false;
    try {
      onboarded = JSON.parse(
        fs.readFileSync(path.join(profileDir, '.claude.json'), 'utf8'),
      ).hasCompletedOnboarding === true;
    } catch { /* no config yet — fresh profile */ }
    const hasCreds = fs.existsSync(path.join(profileDir, '.credentials.json'));
    if (onboarded && !hasCreds) args.push('/login');
  }
  /** @type {Session} */
  const session = {
    id: crypto.randomUUID(),
    ...randomPaneIdentity(), // name + color (both customizable via PATCH)
    workspace,
    profile: profile || null,
    pty: null,
    buffer: [],      // ring buffer of output chunks
    bufLen: 0,
    sockets: new Set(),
    status: 'running',
    exitCode: null,
    activity: null,          // 'working' | 'waiting' | 'idle' (from hooks)
    activitySince: null,     // when activity last changed — powers "working 7m"
    activityNote: null,      // latest Notification message while waiting (why it's blocked)
    claudeSessionId: null,   // claude's internal session id (from hooks)
    transcriptPath: null,    // conversation JSONL (from hooks) — usage source
    createdAt: new Date().toISOString(),
  };
  spawnPty(session, args, { cols, rows });
  sessions.set(session.id, session);
  persistSessions();
  return session;
}

// Respawn the claude PTY for a session that is no longer running — 'dead'
// (PTY lost to a server restart) or 'exited' (claude ended or crashed).
// Resumes the same conversation when hooks captured its id, else starts fresh.
function reviveSession(session, { cols, rows }) {
  session.buffer = [];
  session.bufLen = 0;
  // `claude --resume` reads the conversation's transcript JSONL. Some claude
  // versions (≥2.1.198 team-mode sessions) report a transcript_path via hooks
  // but never write the file — --resume would just die with "No conversation
  // found". Detect that up front and fall back to a fresh session.
  if (session.claudeSessionId && session.transcriptPath && !fs.existsSync(session.transcriptPath)) {
    dbg('revive', `${session.name} (${session.id.slice(0, 8)}) transcript never written — cannot resume, starting fresh`);
    session.claudeSessionId = null;
    session.transcriptPath = null;
  }
  const args = session.claudeSessionId ? ['--resume', session.claudeSessionId] : [];
  spawnPty(session, args, { cols, rows });
}

// ---- persistence: running sessions survive a server restart as 'dead'
// entries that can be revived via `claude --resume <claudeSessionId>`.

function loadPersistedSessions() {
  const saved = readJsonWithBackup(SESSIONS_FILE, 'sessions');
  // v1 files wrap the list ({version, sessions}); pre-version files were bare arrays
  const list = Array.isArray(saved) ? saved : saved?.sessions;
  if (!Array.isArray(list)) return;
  for (const s of list) {
    if (!s?.id || !s?.workspace) continue;
    sessions.set(s.id, {
      id: s.id,
      name: s.name ?? 'Pane',
      color: s.color ?? '#90a4ae',
      workspace: s.workspace,
      profile: s.profile ?? null,
      pty: null,
      buffer: [],
      bufLen: 0,
      sockets: new Set(),
      status: 'dead', // its PTY died with the previous server process
      exitCode: null,
      activity: null,
      activitySince: null,
      activityNote: null,
      claudeSessionId: s.claudeSessionId ?? null,
      transcriptPath: s.transcriptPath ?? null,
      createdAt: s.createdAt ?? new Date().toISOString(),
    });
  }
}
loadPersistedSessions();

// Attachments belong to a session — sweep dirs whose session no longer exists
// (killed while the server was down, or cleaned sessions.json).
try {
  for (const d of fs.readdirSync(ATTACHMENTS_DIR, { withFileTypes: true })) {
    if (d.isDirectory() && !sessions.has(d.name)) {
      fs.rmSync(path.join(ATTACHMENTS_DIR, d.name), { recursive: true, force: true });
    }
  }
} catch { /* no attachments yet */ }

// Auto-revive (settings.autoRevive): respawn every dead session right at
// server start instead of one revive click per pane. Panes send their real
// size on attach, so the 80x24 default here is fine.
if (settings.autoRevive) {
  for (const session of sessions.values()) {
    if (session.status !== 'dead') continue;
    try {
      reviveSession(session, { cols: 80, rows: 24 });
      dbg('revive', `auto-revived ${session.name} (${session.id.slice(0, 8)})` +
        (session.claudeSessionId ? ' (resuming)' : ' (fresh)'));
    } catch (err) {
      dbg('error', `auto-revive failed for ${session.name}: ${err.message}`);
    }
  }
}

let persistTimer = null;

function persistSessions() {
  clearTimeout(persistTimer);
  persistTimer = null;
  // running/dead sessions always survive a restart; exited ones only when a
  // conversation id was captured — they reload as revivable 'dead' entries.
  const list = [...sessions.values()]
    .filter((s) => s.status === 'running' || s.status === 'dead' ||
      (s.status === 'exited' && s.claudeSessionId))
    .map((s) => ({
      id: s.id,
      name: s.name,
      color: s.color,
      workspace: s.workspace,
      profile: s.profile,
      claudeSessionId: s.claudeSessionId,
      transcriptPath: s.transcriptPath,
      createdAt: s.createdAt,
    }));
  // Runs inside PTY onExit callbacks and timers — a disk hiccup (full disk,
  // AV/OneDrive lock) must not crash the server and take every pane with it.
  try {
    writeJsonAtomic(SESSIONS_FILE, { version: 1, sessions: list });
  } catch (err) {
    dbg('error', `failed to persist sessions: ${err.message}`);
  }
}

// Debounced variant for chatty updates (hook events). Lifecycle changes
// (create/delete/exit/revive) must call persistSessions() directly — a server
// killed within the debounce window would otherwise leave a stale file that
// resurrects deleted sessions on next start.
function schedulePersist() {
  clearTimeout(persistTimer);
  persistTimer = setTimeout(persistSessions, 300);
}

function broadcast(session, msg) {
  const json = JSON.stringify(msg);
  for (const ws of session.sockets) {
    if (ws.readyState === ws.OPEN) ws.send(json);
  }
}

function sessionInfo(s) {
  return {
    id: s.id,
    name: s.name,
    color: s.color,
    workspace: s.workspace,
    profile: s.profile,
    status: s.status,
    exitCode: s.exitCode,
    activity: s.activity,
    activitySince: s.activitySince,
    activityNote: s.activityNote ?? null,
    // auto-title from the conversation's opening prompt (search/palette label)
    summary: firstPromptSummary(s.transcriptPath),
    // resumable = we have claude's session id AND its transcript actually
    // exists on disk (team-mode claude can report a path it never writes)
    canResume: Boolean(s.claudeSessionId &&
      (!s.transcriptPath || fs.existsSync(s.transcriptPath))),
    hasTranscript: Boolean(s.transcriptPath),
    attached: s.sockets.size,
    createdAt: s.createdAt,
  };
}

// -------------------------------------------------------------------- http

const app = express();
app.use(express.json());

// Serve the built app with the token injected. Everything under /api requires it.
app.get('/', (_req, res) => {
  let html;
  try {
    html = fs.readFileSync(path.join(DIST_DIR, 'index.html'), 'utf8');
  } catch {
    return res
      .status(503)
      .type('text')
      .send('Frontend not built yet — run: cd web && npm install && npm run build');
  }
  res.type('html').send(html.replaceAll('%%HELM_TOKEN%%', TOKEN));
});
app.use(express.static(DIST_DIR, { index: false }));

// Liveness/status — unauthenticated on purpose so `curl 127.0.0.1:7777/health`
// answers the "is a server up here, which pid/version?" question (the
// stale-server-on-7777 trap) without needing the token from the served page.
// Safe: it's loopback-only, sends no CORS headers (so a cross-origin page can't
// read the body), and exposes nothing actionable — no token, no paths.
app.get('/health', (_req, res) => {
  const counts = { total: sessions.size, running: 0, waiting: 0, exited: 0, dead: 0 };
  for (const s of sessions.values()) {
    if (s.status === 'running') counts[s.activity === 'waiting' ? 'waiting' : 'running'] += 1;
    else if (s.status === 'exited') counts.exited += 1;
    else if (s.status === 'dead') counts.dead += 1;
  }
  res.json({
    ok: true,
    pid: process.pid,
    startedAt: SERVER_STARTED_AT,
    uptimeSec: Math.round(process.uptime()),
    claude: { version: diagnostics.claude.version, ok: diagnostics.claude.ok },
    sessions: counts,
  });
});

// A pane's hooks are the only writer of session.transcriptPath, and that path
// is later fed to file reads/copies (usage, summary, revive check,
// switch-profile). Every child process inside a pane inherits the hook token,
// so don't trust the reported path blindly: accept only a .jsonl inside the
// session's own account store. A rejection is surfaced as claude drift — if a
// claude update moves its transcript dir, this must be loud, not silent zeros.
function validTranscriptPath(session, p) {
  if (typeof p !== 'string' || !p.toLowerCase().endsWith('.jsonl')) return false;
  const root = path.resolve(configRoot(session.profile), 'projects') + path.sep;
  const resolved = path.resolve(p);
  const fold = (s) => (IS_WIN ? s.toLowerCase() : s); // win paths are case-insensitive
  return fold(resolved).startsWith(fold(root));
}

// Hook relay from inside panes — authed by HOOK_TOKEN (spawn env), not the UI
// token, so it must be registered before the bearer-auth middleware below.
app.post('/api/hook', (req, res) => {
  if (!safeEqual(req.get('x-helm-hook'), HOOK_TOKEN)) {
    return res.status(401).json({ error: 'bad hook token' });
  }
  const { sessionId, event } = req.body || {};
  const session = sessions.get(sessionId);
  if (!session || !event) return res.status(404).json({ error: 'no such session' });
  // HELM_DEBUG_HOOKS=1 dumps the raw claude hook payload — the fastest way to
  // spot claude-side field drift (session_id/transcript_path shape) when
  // status/usage/revive stop working. Off by default.
  if (process.env.HELM_DEBUG_HOOKS) dbg('hook-raw', JSON.stringify(event));
  if (typeof event.session_id === 'string') session.claudeSessionId = event.session_id;
  if (typeof event.transcript_path === 'string') {
    if (validTranscriptPath(session, event.transcript_path)) {
      session.transcriptPath = event.transcript_path;
    } else {
      noteDrift('transcript-path-rejected',
        `a pane reported a transcript outside its account store (${event.transcript_path}) — ` +
        'either claude moved its transcript dir (update Helm) or something in the pane is spoofing hooks');
    }
  }
  dbg('hook', `${session.name} (${sessionId.slice(0, 8)}) ${event.hook_event_name}` +
    (event.hook_event_name === 'Notification' && event.message ? `: ${event.message}` : ''));
  const activity = {
    SessionStart: 'idle',
    UserPromptSubmit: 'working',
    Stop: 'idle',
    Notification: 'waiting',
  }[event.hook_event_name];
  // Only a *change* resets the clock — repeated Notifications while waiting
  // keep the original "waiting since".
  if (activity && session.status === 'running' && session.activity !== activity) {
    session.activity = activity;
    session.activitySince = new Date().toISOString();
  }
  // Carry the Notification's own message (e.g. "Claude needs permission to run
  // X") so the pane badge / desktop alert can say *why* it's blocked, not just
  // "needs input". Cleared the moment it starts working or goes idle again.
  if (event.hook_event_name === 'Notification' && typeof event.message === 'string') {
    session.activityNote = event.message;
  } else if (activity && activity !== 'waiting') {
    session.activityNote = null;
  }
  schedulePersist();
  res.json({ ok: true });
});

app.use('/api', (req, res, next) => {
  if (safeEqual(req.get('authorization'), `Bearer ${TOKEN}`)) return next();
  res.status(401).json({ error: 'bad or missing token' });
});

app.get('/api/sessions', (_req, res) => {
  res.json([...sessions.values()].map(sessionInfo));
});

app.post('/api/sessions', (req, res) => {
  let { workspace, profile, cols = 80, rows = 24 } = req.body || {};
  if (!workspace || typeof workspace !== 'string') {
    return res.status(400).json({ error: 'workspace (directory path) is required' });
  }
  let stat;
  try { stat = fs.statSync(workspace); } catch { /* handled below */ }
  if (!stat?.isDirectory()) {
    return res.status(400).json({ error: `workspace is not a directory: ${workspace}` });
  }
  workspace = path.resolve(workspace);
  if (profile && !/^[\w-]+$/.test(profile)) {
    return res.status(400).json({ error: 'profile must be alphanumeric/dash/underscore' });
  }
  try {
    const session = createSession({ workspace, profile, cols: Number(cols) || 80, rows: Number(rows) || 24 });
    res.status(201).json(sessionInfo(session));
  } catch (err) {
    res.status(500).json({ error: `failed to spawn: ${err.message}` });
  }
});

app.delete('/api/sessions/:id', (req, res) => {
  const session = sessions.get(req.params.id);
  if (!session) return res.status(404).json({ error: 'no such session' });
  if (session.status === 'running' && session.pty) {
    try { session.pty.kill(); } catch { /* already dead */ }
  }
  for (const ws of session.sockets) ws.close(1000, 'session killed');
  sessions.delete(session.id);
  // its uploaded attachments go with it
  try {
    fs.rmSync(path.join(ATTACHMENTS_DIR, session.id), { recursive: true, force: true });
  } catch { /* none */ }
  dbg('kill', `${session.name} (${session.id.slice(0, 8)}) deleted (was ${session.status})`);
  persistSessions();
  res.json({ ok: true });
});

// Customize a pane's identity (name shows in the header; color is the accent)
app.patch('/api/sessions/:id', (req, res) => {
  const session = sessions.get(req.params.id);
  if (!session) return res.status(404).json({ error: 'no such session' });
  const { name, color } = req.body || {};
  if (name !== undefined) {
    if (typeof name !== 'string' || !name.trim() || name.trim().length > 32) {
      return res.status(400).json({ error: 'name must be 1–32 characters' });
    }
    session.name = name.trim();
  }
  if (color !== undefined) {
    if (typeof color !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(color)) {
      return res.status(400).json({ error: 'color must be a #rrggbb hex value' });
    }
    session.color = color;
  }
  persistSessions();
  res.json(sessionInfo(session));
});

// ---- attachments: paste/drop a file in the browser → bytes land here → we
// save them locally and type the file's PATH into the pane, exactly like
// dropping a file onto a native terminal window. Claude reads it from disk.
let attachSeq = 0;

// keep a safe basename (+extension); never trust client-supplied paths
function sanitizeFilename(name) {
  const base = String(name || '').split(/[\\/]/).pop() || '';
  const clean = base.replace(/[^\w. -]/g, '').replace(/^\.+/, '').trim();
  return clean.slice(0, 80) || 'paste.png';
}

app.post('/api/sessions/:id/attach',
  express.raw({ type: '*/*', limit: '25mb' }),
  (req, res) => {
    const session = sessions.get(req.params.id);
    if (!session) return res.status(404).json({ error: 'no such session' });
    if (session.status !== 'running' || !session.pty) {
      return res.status(409).json({ error: 'session is not running' });
    }
    if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
      return res.status(400).json({ error: 'empty file' });
    }
    const name = sanitizeFilename(req.query.name);
    const dir = path.join(ATTACHMENTS_DIR, session.id);
    const file = path.join(dir, `${++attachSeq}-${name}`);
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(file, req.body);
    } catch (err) {
      return res.status(500).json({ error: `failed to save: ${err.message}` });
    }
    // Type the path into the pane's input (quoted if it has spaces, trailing
    // space, NO Enter — the user finishes their prompt and submits).
    session.pty.write((/\s/.test(file) ? `"${file}"` : file) + ' ');
    dbg('attach', `${session.name} (${session.id.slice(0, 8)}) ${name} (${req.body.length} bytes)`);
    res.json({ ok: true, path: file });
  });

// Revive a session that is no longer running: 'dead' (PTY died with a previous
// server process) or 'exited' (claude ended or crashed). Resumes the same
// claude conversation when we captured its session id via hooks; otherwise
// starts fresh in the same workspace/profile.
app.post('/api/sessions/:id/revive', (req, res) => {
  const session = sessions.get(req.params.id);
  if (!session) return res.status(404).json({ error: 'no such session' });
  if (session.status === 'running') return res.status(409).json({ error: 'session is still running' });
  const { cols = 80, rows = 24 } = req.body || {};
  try {
    reviveSession(session, { cols: Number(cols) || 80, rows: Number(rows) || 24 });
  } catch (err) {
    dbg('error', `revive failed for ${session.id.slice(0, 8)}: ${err.message}`);
    return res.status(500).json({ error: `failed to respawn: ${err.message}` });
  }
  dbg('revive', `${session.name} (${session.id.slice(0, 8)})` +
    (session.claudeSessionId ? ` resuming claude session ${session.claudeSessionId.slice(0, 8)}` : ' fresh (no claude session id)'));
  persistSessions();
  res.json(sessionInfo(session));
});

// The config dir whose credentials a session on this profile uses
// ('' / null = the default account).
function configRoot(profile) {
  return profile
    ? path.join(ACCOUNTS_DIR, profile)
    : process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
}

// Move a pane to another account. A running claude can't change accounts in
// place (CLAUDE_CONFIG_DIR is read once, at spawn), but the conversation is
// just a transcript file — so: copy it into the target account's store, kill
// the old process, and respawn claude in the same pane with --resume. Same
// pane, same chat, new account. Attached sockets stay open through the swap.
app.post('/api/sessions/:id/switch-profile', (req, res) => {
  const session = sessions.get(req.params.id);
  if (!session) return res.status(404).json({ error: 'no such session' });
  const { profile, cols = 80, rows = 24 } = req.body || {};
  const next = typeof profile === 'string' && profile ? profile : null;
  if (next && !/^[\w-]+$/.test(next)) {
    return res.status(400).json({ error: 'profile must be alphanumeric/dash/underscore' });
  }
  if (next === session.profile) {
    return res.status(409).json({ error: 'session is already on that account' });
  }
  // The target must be able to work without an interactive login — a login
  // screen and --resume at once is a mess. (The default account is assumed
  // usable; profiles need credentials from a previous sign-in.)
  if (next && !fs.existsSync(path.join(configRoot(next), '.credentials.json'))) {
    return res.status(409).json({
      error: `profile "${next}" has no stored login — open a pane on it and sign in first`,
    });
  }

  // Carry the conversation when there is one to carry: --resume resolves the
  // id against the NEW config dir, so the transcript must exist there. The
  // copy (not move) leaves the old account's history intact for its usage.
  if (session.claudeSessionId && session.transcriptPath && fs.existsSync(session.transcriptPath)) {
    const destDir = path.join(
      configRoot(next), 'projects', path.basename(path.dirname(session.transcriptPath)),
    );
    const dest = path.join(destDir, path.basename(session.transcriptPath));
    try {
      fs.mkdirSync(destDir, { recursive: true });
      fs.copyFileSync(session.transcriptPath, dest); // overwrite: newest history wins
    } catch (err) {
      return res.status(500).json({ error: `failed to copy the conversation: ${err.message}` });
    }
    markImported(dest);
    session.transcriptPath = dest;
  } else {
    // nothing resumable — the pane still switches, it just starts fresh
    session.claudeSessionId = null;
    session.transcriptPath = null;
  }

  const from = session.profile || 'default';
  if (session.status === 'running' && session.pty) {
    try { session.pty.kill(); } catch { /* already dead */ }
  }
  session.profile = next;
  try {
    reviveSession(session, { cols: Number(cols) || 80, rows: Number(rows) || 24 });
  } catch (err) {
    session.status = 'exited'; // old process is gone — leave the pane revivable
    persistSessions();
    return res.status(500).json({ error: `failed to respawn: ${err.message}` });
  }
  dbg('switch', `${session.name} (${session.id.slice(0, 8)}) ${from} → ${next || 'default'}` +
    (session.claudeSessionId ? ' (conversation carried over)' : ' (fresh start)'));
  persistSessions();
  res.json(sessionInfo(session));
});

// Broadcast one instruction to several running panes at once. The text is
// written to each PTY in one chunk (claude's input treats a fast burst as a
// paste), then Enter follows as a separate keypress a moment later — sending
// "text\r" in a single write risks the \r being swallowed as part of the
// paste instead of submitting it.
app.post('/api/broadcast', (req, res) => {
  const { text, sessionIds } = req.body || {};
  if (typeof text !== 'string' || !text.trim() || text.length > 4000) {
    return res.status(400).json({ error: 'text (1–4000 chars) is required' });
  }
  if (!Array.isArray(sessionIds) || sessionIds.length === 0) {
    return res.status(400).json({ error: 'sessionIds (non-empty array) is required' });
  }
  const payload = text.replace(/\r\n/g, '\n');
  const results = {};
  for (const id of sessionIds) {
    const session = sessions.get(id);
    if (!session || session.status !== 'running' || !session.pty) {
      results[id] = 'skipped';
      continue;
    }
    session.pty.write(payload);
    setTimeout(() => {
      if (session.status === 'running' && session.pty) {
        try { session.pty.write('\r'); } catch { /* exited in between */ }
      }
    }, 250);
    results[id] = 'sent';
  }
  const sent = Object.values(results).filter((r) => r === 'sent').length;
  dbg('broadcast', `"${text.slice(0, 60)}${text.length > 60 ? '…' : ''}" → ${sent}/${sessionIds.length} pane(s)`);
  res.json({ ok: true, results });
});

// Server settings (currently just the auto-revive toggle)
app.get('/api/settings', (_req, res) => res.json(settings));

app.patch('/api/settings', (req, res) => {
  const { autoRevive } = req.body || {};
  if (autoRevive !== undefined) {
    if (typeof autoRevive !== 'boolean') {
      return res.status(400).json({ error: 'autoRevive must be true or false' });
    }
    settings.autoRevive = autoRevive;
  }
  saveSettings();
  dbg('settings', `autoRevive=${settings.autoRevive}`);
  res.json(settings);
});

// Debug console feed for the UI's 🐞 drawer; startedAt/pid let the UI show
// which server process it is talking to (staleness check).
app.get('/api/logs', (req, res) => {
  const after = Number(req.query.after) || 0;
  res.json({ startedAt: SERVER_STARTED_AT, pid: process.pid, ...logsSince(after) });
});

// claude-CLI health + accumulated drift warnings — drives the UI's drift banner.
app.get('/api/diagnostics', (_req, res) => {
  res.json({ claude: diagnostics.claude, warnings: [...diagnostics.warnings.values()] });
});

// ------------------------------------------------------ console window toggle
// Show/hide the OS console window this server is running in (the "Helm server"
// terminal from start-helm.cmd) so the UI can offer a button for it. Windows
// only: we shell out to PowerShell to call GetConsoleWindow + ShowWindow via a
// tiny inline P/Invoke — Node can't touch Win32 window APIs without a native
// dep, and this is a rare, click-driven action so a ~half-second spawn is fine.
// A server launched detached (no console) reports supported:false and the UI
// hides the button. IsWindowVisible tells us the current state for the toggle.
const SW = { hide: 0, show: 9 }; // 9 = SW_RESTORE (un-minimise + activate)

function controlConsole(action) {
  return new Promise((resolve) => {
    if (process.platform !== 'win32') return resolve({ supported: false, visible: false });
    const set = action === 'show' || action === 'hide'
      ? `if ($h -ne [IntPtr]::Zero) { [W.N]::ShowWindow($h, ${SW[action]}) | Out-Null }`
      : '';
    const script = `
$s = @'
[DllImport("kernel32.dll")] public static extern System.IntPtr GetConsoleWindow();
[DllImport("user32.dll")] public static extern bool ShowWindow(System.IntPtr h, int n);
[DllImport("user32.dll")] public static extern bool IsWindowVisible(System.IntPtr h);
'@
Add-Type -MemberDefinition $s -Name N -Namespace W | Out-Null
$h = [W.N]::GetConsoleWindow()
${set}
$vis = if ($h -ne [IntPtr]::Zero) { [W.N]::IsWindowVisible($h) } else { $false }
Write-Output ("{0}|{1}" -f ($h -ne [IntPtr]::Zero), $vis)`;
    execFile('powershell', ['-NoProfile', '-NonInteractive', '-Command', script],
      { timeout: 5000, windowsHide: false }, // inherit this console so the handle is ours
      (err, stdout) => {
        if (err) return resolve({ supported: false, visible: false });
        const [sup, vis] = String(stdout).trim().split('|');
        resolve({ supported: sup === 'True', visible: vis === 'True' });
      });
  });
}

app.get('/api/console', async (_req, res) => res.json(await controlConsole('query')));

app.post('/api/console', async (req, res) => {
  const visible = req.body?.visible;
  if (typeof visible !== 'boolean') return res.status(400).json({ error: 'visible must be a boolean' });
  res.json(await controlConsole(visible ? 'show' : 'hide'));
});

// ------------------------------------------------------------ usage roll-up
// Aggregates parsed transcripts (src/claude.mjs owns the parsing) into
// per-account rolling windows + costs.

// Transcript copies made by account switches: dest path → import time (ms).
// The account roll-up skips a copied file's events from before its import so
// moved history keeps counting against the account it actually ran on.
const IMPORTED_FILE = path.join(HELM_DIR, 'imported-transcripts.json');
let importedTranscripts = {};
{
  const saved = readJsonWithBackup(IMPORTED_FILE, 'imported-transcripts ledger');
  if (saved && typeof saved === 'object') importedTranscripts = saved;
}

function markImported(file) {
  // prune entries whose file is gone so the ledger can't grow forever
  for (const f of Object.keys(importedTranscripts)) {
    if (!fs.existsSync(f)) delete importedTranscripts[f];
  }
  importedTranscripts[file] = Date.now();
  writeJsonAtomic(IMPORTED_FILE, importedTranscripts);
  invalidateUsageRollup(); // attribution changed — a cached roll-up is now wrong
}

// Rolling windows, newest → oldest. Keys are stable API; the UI labels them.
/** @type {[string, number][]} */
const USAGE_WINDOWS = [
  ['h1', 3600_000],
  ['h5', 5 * 3600_000],
  ['h10', 10 * 3600_000],
  ['h24', 24 * 3600_000],
  ['d7', 7 * 24 * 3600_000],
  ['d30', 30 * 24 * 3600_000],
];

async function accountUsage(configDir) {
  const now = Date.now();
  // Every window (incl. 'all') carries totals + its own per-model breakdown,
  // so the UI's window selector re-slices the whole card, not just one number.
  const blank = () => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, turns: 0, cost: 0, models: {} });
  const windows = { all: blank() };
  for (const [key] of USAGE_WINDOWS) windows[key] = blank();

  const add = (w, model, input, output, cacheRead, cacheWrite) => {
    w.input += input;
    w.output += output;
    w.cacheRead += cacheRead;
    w.cacheWrite += cacheWrite;
    w.turns += 1;
    const m = (w.models[model] ??= { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, turns: 0 });
    m.input += input;
    m.output += output;
    m.cacheRead += cacheRead;
    m.cacheWrite += cacheWrite;
    m.turns += 1;
  };

  let lastActive = 0; // most recent counted usage → "used 2h ago" in the UI
  for (const file of transcriptFiles(configDir)) {
    // Yield between files so PTY output / WS writes aren't starved during a
    // cold scan (a heavy account can hold hundreds of transcripts; warm-cache
    // files cost one statSync each, so the yields dominate nothing).
    await new Promise((r) => setImmediate(r));
    const parsed = parseTranscriptFile(file);
    if (!parsed) continue;
    // for transcript copies made by an account switch, only count what
    // happened after the switch — the rest ran on the source account
    const importedAt = importedTranscripts[file] || 0;
    for (const [t, model, input, output, cacheRead, cacheWrite] of parsed.events) {
      if (t < importedAt) continue;
      if (t > lastActive) lastActive = t;
      add(windows.all, model, input, output, cacheRead, cacheWrite);
      const age = now - t;
      for (const [key, span] of USAGE_WINDOWS) {
        if (age < span) add(windows[key], model, input, output, cacheRead, cacheWrite);
      }
    }
  }
  // fold in dollar estimates once token totals are settled (per model + window)
  for (const w of Object.values(windows)) {
    for (const [model, m] of Object.entries(w.models)) {
      m.cost = tokenCost(model, m);
      w.cost += m.cost;
    }
  }
  return { windows, lastActive: lastActive || null };
}

// Roll-up across every account: the default one + each Helm profile.
// Cached for a short TTL with in-flight dedupe — the usage modal polls, and a
// cold scan across every profile's transcripts is the most expensive thing
// this server does. HELM_USAGE_TTL_MS overrides (0 = always fresh; tests).
const USAGE_ROLLUP_TTL = Number(process.env.HELM_USAGE_TTL_MS ?? 15_000);
let usageRollup = { at: 0, promise: null };
function invalidateUsageRollup() { usageRollup = { at: 0, promise: null }; }

async function buildUsageRollup() {
  const accounts = [];
  // default account: config file is ~/.claude.json, data lives in ~/.claude
  const defaultRoot = configRoot(null);
  accounts.push({
    account: 'default',
    email: accountEmail(process.env.CLAUDE_CONFIG_DIR || os.homedir()),
    ...(await accountUsage(defaultRoot)),
  });
  try {
    for (const d of fs.readdirSync(ACCOUNTS_DIR, { withFileTypes: true })) {
      if (!d.isDirectory()) continue;
      const dir = path.join(ACCOUNTS_DIR, d.name);
      accounts.push({ account: d.name, email: accountEmail(dir), ...(await accountUsage(dir)) });
    }
  } catch { /* no profiles yet */ }
  return accounts;
}

app.get('/api/usage', async (_req, res) => {
  try {
    if (!usageRollup.promise || Date.now() - usageRollup.at >= USAGE_ROLLUP_TTL) {
      usageRollup = { at: Date.now(), promise: buildUsageRollup() };
    }
    res.json(await usageRollup.promise);
  } catch (err) {
    invalidateUsageRollup(); // never cache a failure
    res.status(500).json({ error: err.message });
  }
});

// Token usage per model for one pane's conversation transcript, including
// any subagent transcripts nested in <transcript dir>/<sessionId>/subagents/
app.get('/api/sessions/:id/usage', (req, res) => {
  const session = sessions.get(req.params.id);
  if (!session) return res.status(404).json({ error: 'no such session' });
  if (!session.transcriptPath) return res.json({ available: false });

  const files = [session.transcriptPath];
  const subagentsDir = path.join(
    path.dirname(session.transcriptPath),
    path.basename(session.transcriptPath, '.jsonl'),
    'subagents',
  );
  try {
    for (const f of fs.readdirSync(subagentsDir)) {
      if (f.endsWith('.jsonl')) files.push(path.join(subagentsDir, f));
    }
  } catch { /* no subagents */ }

  const models = {};
  let available = false;
  for (const file of files) {
    const parsed = parseTranscriptFile(file);
    if (!parsed) continue;
    available = true;
    for (const [name, m] of Object.entries(parsed.models)) {
      const t = (models[name] ??= { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, turns: 0 });
      t.input += m.input;
      t.output += m.output;
      t.cacheRead += m.cacheRead;
      t.cacheWrite += m.cacheWrite;
      t.turns += m.turns;
    }
  }
  if (!available) return res.json({ available: false });
  for (const [name, m] of Object.entries(models)) m.cost = tokenCost(name, m);
  res.json({ available: true, models });
});

// ------------------------------------------------------------- workspaces
// Persisted as JSON in %LOCALAPPDATA%\Helm\workspaces.json (not in the
// OneDrive-synced repo). Removing a workspace does NOT kill its sessions.

function loadWorkspaces() {
  const saved = readJsonWithBackup(WORKSPACES_FILE, 'workspaces');
  // v1 files wrap the list ({version, workspaces}); pre-version files were bare arrays
  const list = Array.isArray(saved) ? saved : saved?.workspaces;
  return Array.isArray(list) ? list : [];
}
let workspaces = loadWorkspaces();

function saveWorkspaces() {
  writeJsonAtomic(WORKSPACES_FILE, { version: 1, workspaces });
}

app.get('/api/workspaces', (_req, res) => {
  res.json(workspaces);
});

// Best-effort git status per workspace (branch + dirty flag + ahead/behind),
// for the sidebar's at-a-glance indicator. A non-repo, or a box without git,
// reports branch:null. Each call is capped at 2 s so a slow/huge repo can't
// stall the sidebar. Registered before any /api/workspaces/:id route so the
// literal 'git' segment isn't swallowed as an :id.
function workspaceGit(dir) {
  return new Promise((resolve) => {
    execFile('git', ['-C', dir, 'status', '--porcelain=v1', '--branch'],
      { timeout: 2000, windowsHide: true },
      (err, stdout) => {
        if (err) return resolve({ branch: null, dirty: false, ahead: 0, behind: 0 });
        const lines = String(stdout).split('\n');
        const head = lines[0] || '';
        // "## main...origin/main [ahead 1, behind 2]" | "## main" |
        // "## No commits yet on main" | "## HEAD (no branch)" (detached)
        const m = head.match(/^## (?:No commits yet on )?(.+?)(?:\.\.\.|\s\[|$)/);
        let branch = m ? m[1] : null;
        if (branch === 'HEAD (no branch)') branch = 'detached';
        const ahead = Number(head.match(/ahead (\d+)/)?.[1]) || 0;
        const behind = Number(head.match(/behind (\d+)/)?.[1]) || 0;
        const dirty = lines.slice(1).some((l) => l.trim() !== '');
        resolve({ branch, dirty, ahead, behind });
      });
  });
}

app.get('/api/workspaces/git', async (_req, res) => {
  const out = await Promise.all(
    workspaces.map(async (w) => ({ id: w.id, ...(await workspaceGit(w.dir)) })),
  );
  res.json(out);
});

// Best-effort liveness of each workspace's own dev server: a bare TCP connect
// to 127.0.0.1:<port>. `up` means something accepted the connection (server is
// listening); refused/timeout = down. Capped at 1 s so a black-holed port can't
// stall the poll. Only workspaces with a configured port are reported.
// Registered before /api/workspaces/:id so 'servers' isn't read as an :id.
function portListening(port) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let done = false;
    const finish = (up) => {
      if (done) return;
      done = true;
      socket.destroy();
      resolve(up);
    };
    socket.setTimeout(1000);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
    socket.connect(port, '127.0.0.1');
  });
}

app.get('/api/workspaces/servers', async (_req, res) => {
  const withPort = workspaces.filter((w) => Number.isInteger(w.port));
  const out = await Promise.all(
    withPort.map(async (w) => ({ id: w.id, port: w.port, up: await portListening(w.port) })),
  );
  res.json(out);
});

// Coerce a request `port` field to a valid TCP port (1–65535) or null.
// Returns undefined when the value is unusable (caller reports a 400).
function parsePort(v) {
  if (v === null || v === '' || v === undefined) return null;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1 || n > 65535) return undefined;
  return n;
}

app.post('/api/workspaces', (req, res) => {
  const { name, dir, profile, port } = req.body || {};
  if (!name || typeof name !== 'string' || !dir || typeof dir !== 'string') {
    return res.status(400).json({ error: 'name and dir are required' });
  }
  let stat;
  try { stat = fs.statSync(dir); } catch { /* handled below */ }
  if (!stat?.isDirectory()) {
    return res.status(400).json({ error: `not a directory: ${dir}` });
  }
  const normalized = path.resolve(dir);
  const existing = workspaces.find((w) => path.resolve(w.dir) === normalized);
  if (existing) return res.status(409).json({ error: `already added as "${existing.name}"` });
  const workspace = { id: crypto.randomUUID(), name, dir: normalized };
  // Optional pinned account — panes made in this workspace default to it.
  // Same name rule as everywhere a profile enters (it becomes a dir under
  // accounts\, so a stray ..\ would be a path traversal).
  if (typeof profile === 'string' && profile) {
    if (!/^[\w-]+$/.test(profile)) {
      return res.status(400).json({ error: 'profile must be alphanumeric/dash/underscore' });
    }
    workspace.profile = profile;
  }
  // Optional dev-server port for the sidebar's up/down check.
  const wsPort = parsePort(port);
  if (wsPort === undefined) return res.status(400).json({ error: 'port must be 1–65535' });
  if (wsPort !== null) workspace.port = wsPort;
  workspaces.push(workspace);
  saveWorkspaces();
  res.status(201).json(workspace);
});

// Pin (or re-pin) a workspace's default account, or rename it. profile '' / null
// clears the pin → new panes there use the default account again.
app.patch('/api/workspaces/:id', (req, res) => {
  const ws = workspaces.find((w) => w.id === req.params.id);
  if (!ws) return res.status(404).json({ error: 'no such workspace' });
  const { name, dir, profile, port } = req.body || {};
  if (typeof name === 'string' && name.trim()) ws.name = name.trim();
  if (typeof dir === 'string' && dir.trim()) {
    let stat;
    try { stat = fs.statSync(dir); } catch { /* handled below */ }
    if (!stat?.isDirectory()) return res.status(400).json({ error: `not a directory: ${dir}` });
    const normalized = path.resolve(dir);
    const clash = workspaces.find((w) => w.id !== ws.id && path.resolve(w.dir) === normalized);
    if (clash) return res.status(409).json({ error: `already added as "${clash.name}"` });
    // Running panes were spawned in the old cwd and stay tied to it; only new
    // panes here use the new root.
    ws.dir = normalized;
  }
  if (profile !== undefined) {
    if (typeof profile === 'string' && profile) {
      if (!/^[\w-]+$/.test(profile)) {
        return res.status(400).json({ error: 'profile must be alphanumeric/dash/underscore' });
      }
      ws.profile = profile;
    } else delete ws.profile;
  }
  if (port !== undefined) {
    const wsPort = parsePort(port);
    if (wsPort === undefined) return res.status(400).json({ error: 'port must be 1–65535' });
    if (wsPort !== null) ws.port = wsPort;
    else delete ws.port;
  }
  saveWorkspaces();
  res.json(ws);
});

app.delete('/api/workspaces/:id', (req, res) => {
  const before = workspaces.length;
  workspaces = workspaces.filter((w) => w.id !== req.params.id);
  if (workspaces.length === before) return res.status(404).json({ error: 'no such workspace' });
  saveWorkspaces();
  res.json({ ok: true });
});

// The named profile signed into the same account as the bare default, if any:
// same oauth email AND a stored login (so a pane can spawn there without a
// login screen). null when default is unique or the twin isn't signed in.
// Panes that ask for "default" get routed here (createSession) so the account's
// usage lands in one place instead of a duplicate ~/.claude row.
function mappedDefaultProfile() {
  const defaultEmail = accountEmail(process.env.CLAUDE_CONFIG_DIR || os.homedir());
  if (!defaultEmail) return null; // default never logged in — nothing to map
  try {
    for (const d of fs.readdirSync(ACCOUNTS_DIR, { withFileTypes: true })) {
      if (!d.isDirectory()) continue;
      const dir = path.join(ACCOUNTS_DIR, d.name);
      if (accountEmail(dir) === defaultEmail
        && fs.existsSync(path.join(dir, '.credentials.json'))) {
        return d.name;
      }
    }
  } catch { /* accounts dir doesn't exist yet */ }
  return null;
}

app.get('/api/profiles', (_req, res) => {
  let profiles = [];
  try {
    profiles = fs.readdirSync(ACCOUNTS_DIR, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => ({ name: d.name, email: accountEmail(path.join(ACCOUNTS_DIR, d.name)) }));
  } catch { /* accounts dir doesn't exist yet */ }
  res.json({
    // default = whatever config dir spawned sessions inherit (~/.claude.json
    // unless the server itself was started with CLAUDE_CONFIG_DIR set).
    // `mapped` = the named profile it collapses onto (see mappedDefaultProfile).
    default: {
      email: accountEmail(process.env.CLAUDE_CONFIG_DIR || os.homedir()),
      mapped: mappedDefaultProfile(),
    },
    profiles,
  });
});

// Deletes the profile's whole account dir — including its stored login
// (.credentials.json). Refused while any live session is using the profile.
app.delete('/api/profiles/:name', (req, res) => {
  const name = req.params.name;
  if (!/^[\w-]+$/.test(name)) {
    return res.status(400).json({ error: 'bad profile name' });
  }
  const dir = path.join(ACCOUNTS_DIR, name);
  if (!fs.existsSync(dir)) return res.status(404).json({ error: 'no such profile' });
  const inUse = [...sessions.values()].some((s) => s.profile === name && s.status === 'running');
  if (inUse) {
    return res.status(409).json({ error: 'profile is in use by a running session — kill it first' });
  }
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch (err) {
    return res.status(500).json({ error: `failed to delete: ${err.message}` });
  }
  // Cut every dangling reference to the now-gone profile (mirrors the rename
  // handler). Non-running sessions fall back to the default account on revive;
  // workspaces lose the pin so new panes there don't re-create an empty,
  // logged-out account dir under the old name.
  sessions.forEach((s) => { if (s.profile === name) s.profile = null; });
  persistSessions();
  workspaces.forEach((w) => { if (w.profile === name) delete w.profile; });
  saveWorkspaces();
  res.json({ ok: true });
});

// Renames a profile: renames its account dir and repoints any session or
// workspace that referenced the old name. Refused while any live session is
// using the profile (its spawned process still has the old CLAUDE_CONFIG_DIR
// open).
app.patch('/api/profiles/:name', (req, res) => {
  const name = req.params.name;
  const nextName = (req.body || {}).name;
  if (!/^[\w-]+$/.test(name)) {
    return res.status(400).json({ error: 'bad profile name' });
  }
  if (typeof nextName !== 'string' || !/^[\w-]+$/.test(nextName)) {
    return res.status(400).json({ error: 'new name must be letters, numbers, dashes or underscores' });
  }
  if (nextName === name) return res.json({ ok: true });
  const dir = path.join(ACCOUNTS_DIR, name);
  const nextDir = path.join(ACCOUNTS_DIR, nextName);
  if (!fs.existsSync(dir)) return res.status(404).json({ error: 'no such profile' });
  if (fs.existsSync(nextDir)) return res.status(409).json({ error: 'a profile with that name already exists' });
  const inUse = [...sessions.values()].some((s) => s.profile === name && s.status === 'running');
  if (inUse) {
    return res.status(409).json({ error: 'profile is in use by a running session — kill it first' });
  }
  try {
    fs.renameSync(dir, nextDir);
  } catch (err) {
    return res.status(500).json({ error: `failed to rename: ${err.message}` });
  }
  sessions.forEach((s) => { if (s.profile === name) s.profile = nextName; });
  persistSessions();
  workspaces.forEach((w) => { if (w.profile === name) w.profile = nextName; });
  saveWorkspaces();
  res.json({ ok: true });
});

// ------------------------------------------------------------- shutdown
// One process hosts every pane; on Ctrl-C / a kill signal, persist sessions
// (so they reload as revivable 'dead') then stop the claude children so they
// don't orphan (a known hazard — GOTCHAS). Best-effort and idempotent; exit
// after a short grace so kills can flush.
let shuttingDown = false;
function gracefulShutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  dbg('server', `${signal} received — persisting ${sessions.size} session(s), stopping panes`);
  try { persistSessions(); } catch (err) { dbg('error', `shutdown persist failed: ${err.message}`); }
  for (const s of sessions.values()) {
    try { s.pty?.kill(); } catch { /* already gone / node-pty kill race */ }
  }
  setTimeout(() => process.exit(0), 300).unref();
}
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));

// ---------------------------------------------------------------------- ws

const server = app.listen(PORT, HOST, () => {
  booted = true; // from here on, uncaught errors log instead of killing every pane
  console.log(`Helm ⎈  http://${HOST}:${PORT}`);
  console.log(`token: ${TOKEN}`);
  const dead = [...sessions.values()].filter((s) => s.status === 'dead').length;
  dbg('server', `started (pid ${process.pid})${dead ? ` — ${dead} dead session(s) loaded, revivable` : ''}`);
  checkClaudeVersion(); // async; populates /api/diagnostics for the drift banner
});

server.on('error', (/** @type {NodeJS.ErrnoException} */ err) => {
  if (err.code === 'EADDRINUSE') {
    const killTip = IS_WIN
      ? `  Get-NetTCPConnection -LocalPort ${PORT} -State Listen |\n` +
        `    ForEach-Object { Stop-Process -Id $_.OwningProcess -Force }`
      : `  lsof -ti :${PORT} | xargs kill`;
    console.error(
      `\nHelm is already running (something is listening on port ${PORT}).\n` +
      `Open http://${HOST}:${PORT} — or, to restart with new code, stop the old\n` +
      `server first:\n${killTip}\n` +
      `(Live panes die with it but come back as revivable.)\n`,
    );
    process.exit(1);
  }
  // Any other listen failure: exit loudly (don't rely on the process guards —
  // a server that never bound has nothing to keep alive).
  console.error(`fatal server error: ${err?.stack || err}`);
  process.exit(1);
});

const wss = new WebSocketServer({ noServer: true });

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, `http://${HOST}:${PORT}`);
  const origin = req.headers.origin;
  const session = sessions.get(url.searchParams.get('session'));

  const reject = (msg) => {
    dbg('ws', `upgrade rejected: ${msg} (origin=${origin ?? 'none'})`);
    socket.write(`HTTP/1.1 403 Forbidden\r\n\r\n${msg}`);
    socket.destroy();
  };
  if (url.pathname !== '/ws') return reject('unknown path');
  // Origin is only checked when present — deliberate: browsers ALWAYS send
  // Origin on WS upgrades, so a cross-origin page can't dodge this by omitting
  // it. An absent Origin means a non-browser client (node script, curl), which
  // the token alone gates; requiring the header would only break local tooling.
  if (origin && !ALLOWED_ORIGINS.has(origin)) return reject('bad origin');
  if (!safeEqual(url.searchParams.get('token'), TOKEN)) return reject('bad token');
  if (!session) return reject('no such session');

  wss.handleUpgrade(req, socket, head, (ws) => attach(ws, session));
});

// WS wire contract — typed on the client as WsServerMsg/WsClientMsg in
// web/src/types.ts. If you rename or reshape a message here (including the
// PTY onData/onExit broadcasts in spawnPty), update that union too.
//   server → client: {type:'replay',data} | {type:'data',data} | {type:'exit',code}
//   client → server: {type:'input',data}  | {type:'resize',cols,rows}
function attach(ws, session) {
  dbg('ws', `${session.name} (${session.id.slice(0, 8)}) attached (replay ${session.bufLen} bytes)`);
  // Replay the ring buffer so the pane repaints instantly on (re)attach.
  ws.send(JSON.stringify({ type: 'replay', data: session.buffer.join('') }));
  if (session.status === 'exited') {
    ws.send(JSON.stringify({ type: 'exit', code: session.exitCode }));
    ws.close(1000, 'process exited');
    return;
  }

  session.sockets.add(ws);

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    if (session.status !== 'running') return;
    if (msg.type === 'input' && typeof msg.data === 'string') {
      session.pty.write(msg.data);
    } else if (msg.type === 'resize' && msg.cols > 0 && msg.rows > 0) {
      try { session.pty.resize(Math.floor(msg.cols), Math.floor(msg.rows)); } catch { /* exited race */ }
    }
  });

  // Socket close ≠ PTY kill (locked decision 4) — just detach.
  ws.on('close', () => {
    session.sockets.delete(ws);
    dbg('ws', `${session.name} (${session.id.slice(0, 8)}) detached (pty keeps running)`);
  });
  ws.on('error', () => session.sockets.delete(ws));
}
