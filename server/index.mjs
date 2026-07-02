// Helm ⎈ — vertical slice server
// Express (HTTP + static) + ws (WebSocket) + node-pty (real `claude` sessions).
// REST creates/kills sessions; WebSockets only attach. Socket close ≠ PTY kill.

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { WebSocketServer } from 'ws';
import ptyPkg from 'node-pty';

const { spawn } = ptyPkg;

// node-pty 1.0.0 bug on Windows: killing a pty whose process already died can
// throw `TypeError: ... reading 'forEach'` inside windowsPtyAgent.js as an
// unhandled rejection, which would crash the whole server (and every other
// running session with it). Swallow exactly that case; crash on anything else.
process.on('unhandledRejection', (err) => {
  if (err instanceof TypeError && err.stack?.includes('windowsPtyAgent.js')) {
    dbg('error', `ignored node-pty kill race: ${err.message}`);
    return;
  }
  throw err;
});

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST_DIR = path.join(__dirname, '..', 'web', 'dist');

const HOST = '127.0.0.1';
const PORT = Number(process.env.PORT) || 7777;
const RING_BUFFER_MAX = 200 * 1024; // ~200 KB of output kept per session for replay
const HELM_DIR = path.join(process.env.LOCALAPPDATA || os.homedir(), 'Helm');
const ACCOUNTS_DIR = path.join(HELM_DIR, 'accounts');
const WORKSPACES_FILE = path.join(HELM_DIR, 'workspaces.json');
const SESSIONS_FILE = path.join(HELM_DIR, 'sessions.json');
const HOOK_SETTINGS_FILE = path.join(HELM_DIR, 'hook-settings.json');
const SETTINGS_FILE = path.join(HELM_DIR, 'settings.json');

// Random token per server start; embedded in the served page, required on every
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
  fs.mkdirSync(HELM_DIR, { recursive: true });
  fs.writeFileSync(file, t);
  return t;
}
const TOKEN = persistentToken('token');
// Separate token for the hook relay: passed to each spawned claude via env.
const HOOK_TOKEN = persistentToken('hook-token');
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
try {
  settings = { ...DEFAULT_SETTINGS, ...JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')) };
} catch { /* first run — defaults */ }

function saveSettings() {
  fs.mkdirSync(HELM_DIR, { recursive: true });
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2));
}

/** @type {Map<string, Session>} id → session */
const sessions = new Map();

// ----------------------------------------------------------------- debug log
// In-memory ring of server events, served at GET /api/logs and shown in the
// UI's 🐞 drawer. startedAt/pid identify the running server process — the
// quick tell for the stale-server-on-7777 trap (docs/GOTCHAS.md).
const SERVER_STARTED_AT = new Date().toISOString();
const DEBUG_LOG_MAX = 500;
const debugLog = []; // {seq, t, tag, msg}
let debugSeq = 0;
function dbg(tag, msg) {
  debugLog.push({ seq: ++debugSeq, t: new Date().toISOString(), tag, msg });
  if (debugLog.length > DEBUG_LOG_MAX) debugLog.shift();
  console.log(`[${tag}] ${msg}`);
}

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
  const env = {
    ...process.env,
    // Lets hook-post.mjs (running inside the pane) report back to this session
    HELM_SESSION_ID: session.id,
    HELM_HOOK_TOKEN: HOOK_TOKEN,
    HELM_PORT: String(PORT),
  };
  if (session.profile) {
    const profileDir = path.join(ACCOUNTS_DIR, session.profile);
    fs.mkdirSync(profileDir, { recursive: true });
    env.CLAUDE_CONFIG_DIR = profileDir;
  }

  // -n gives claude a display name too (shows up in its /resume picker)
  const nameArgs = session.name ? ['-n', session.name] : [];
  const pty = spawn('claude.cmd', ['--settings', HOOK_SETTINGS_FILE, ...nameArgs, ...extraArgs], {
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

  pty.onData((data) => {
    session.buffer.push(data);
    session.bufLen += data.length;
    while (session.bufLen > RING_BUFFER_MAX && session.buffer.length > 1) {
      session.bufLen -= session.buffer[0].length;
      session.buffer.shift();
    }
    broadcast(session, { type: 'data', data });
  });

  pty.onExit(({ exitCode }) => {
    session.status = 'exited';
    session.exitCode = exitCode;
    session.activity = null;
    dbg('exit', `${session.name} (${session.id.slice(0, 8)}) exited code=${exitCode}`);
    persistSessions();
    // Small delay lets any final ConPTY output land in onData before we
    // announce the exit and close the attached sockets.
    setTimeout(() => {
      broadcast(session, { type: 'exit', code: exitCode });
      for (const ws of session.sockets) ws.close(1000, 'process exited');
      session.sockets.clear();
    }, 150);
  });
}

function createSession({ workspace, profile, cols, rows }) {
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
  const args = session.claudeSessionId ? ['--resume', session.claudeSessionId] : [];
  spawnPty(session, args, { cols, rows });
}

// ---- persistence: running sessions survive a server restart as 'dead'
// entries that can be revived via `claude --resume <claudeSessionId>`.

function loadPersistedSessions() {
  let list = [];
  try {
    list = JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf8'));
  } catch { /* first run */ }
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
      claudeSessionId: s.claudeSessionId ?? null,
      transcriptPath: s.transcriptPath ?? null,
      createdAt: s.createdAt ?? new Date().toISOString(),
    });
  }
}
loadPersistedSessions();

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
  const list = [...sessions.values()]
    .filter((s) => s.status === 'running' || s.status === 'dead')
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
  fs.mkdirSync(HELM_DIR, { recursive: true });
  fs.writeFileSync(SESSIONS_FILE, JSON.stringify(list, null, 2));
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
    canResume: Boolean(s.claudeSessionId),
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

// Hook relay from inside panes — authed by HOOK_TOKEN (spawn env), not the UI
// token, so it must be registered before the bearer-auth middleware below.
app.post('/api/hook', (req, res) => {
  if (req.get('x-helm-hook') !== HOOK_TOKEN) {
    return res.status(401).json({ error: 'bad hook token' });
  }
  const { sessionId, event } = req.body || {};
  const session = sessions.get(sessionId);
  if (!session || !event) return res.status(404).json({ error: 'no such session' });
  if (typeof event.session_id === 'string') session.claudeSessionId = event.session_id;
  if (typeof event.transcript_path === 'string') session.transcriptPath = event.transcript_path;
  dbg('hook', `${session.name} (${sessionId.slice(0, 8)}) ${event.hook_event_name}` +
    (event.hook_event_name === 'Notification' && event.message ? `: ${event.message}` : ''));
  const activity = {
    SessionStart: 'idle',
    UserPromptSubmit: 'working',
    Stop: 'idle',
    Notification: 'waiting',
  }[event.hook_event_name];
  if (activity && session.status === 'running') session.activity = activity;
  schedulePersist();
  res.json({ ok: true });
});

app.use('/api', (req, res, next) => {
  const auth = req.get('authorization') || '';
  if (auth === `Bearer ${TOKEN}`) return next();
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
  res.json({
    seq: debugSeq,
    startedAt: SERVER_STARTED_AT,
    pid: process.pid,
    entries: debugLog.filter((e) => e.seq > after),
  });
});

// ------------------------------------------------------------ usage roll-up
// Parses transcript JSONL files (assistant messages carry a usage block).
// Per-file cache keyed by mtime+size; events keep timestamps so rolling
// windows (5h ≈ subscription session window, 7d ≈ weekly cap) stay accurate.

const fileUsageCache = new Map(); // file path → parsed

function parseTranscriptFile(file) {
  let stat;
  try { stat = fs.statSync(file); } catch { return null; }
  const cached = fileUsageCache.get(file);
  if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) return cached;

  // Streaming can log the same assistant message on several lines — dedupe by
  // message id so its usage counts once (last occurrence wins).
  const byMessage = new Map();
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return null; }
  for (const line of text.split('\n')) {
    if (!line) continue;
    let entry;
    try { entry = JSON.parse(line); } catch { continue; }
    const usage = entry?.message?.usage;
    const model = entry?.message?.model;
    // '<synthetic>' = placeholder entries (errors/retries), not real usage
    if (entry?.type === 'assistant' && usage && model && model !== '<synthetic>') {
      byMessage.set(entry.message.id ?? entry.uuid, {
        model,
        usage,
        t: Date.parse(entry.timestamp) || 0,
      });
    }
  }
  const models = {};
  const events = []; // [timestampMs, model, inTokens(+cacheWrite), outTokens, cacheRead]
  for (const { model, usage, t } of byMessage.values()) {
    const m = (models[model] ??= { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, turns: 0 });
    const input = usage.input_tokens || 0;
    const output = usage.output_tokens || 0;
    const cacheRead = usage.cache_read_input_tokens || 0;
    const cacheWrite = usage.cache_creation_input_tokens || 0;
    m.input += input;
    m.output += output;
    m.cacheRead += cacheRead;
    m.cacheWrite += cacheWrite;
    m.turns += 1;
    events.push([t, model, input + cacheWrite, output, cacheRead]);
  }
  const parsed = { mtimeMs: stat.mtimeMs, size: stat.size, models, events };
  fileUsageCache.set(file, parsed);
  return parsed;
}

// All transcripts under a config dir's projects/ store (one subdir per cwd)
function transcriptFiles(configDir) {
  const out = [];
  const root = path.join(configDir, 'projects');
  let projectDirs = [];
  try { projectDirs = fs.readdirSync(root, { withFileTypes: true }); } catch { return out; }
  for (const d of projectDirs) {
    if (!d.isDirectory()) continue;
    try {
      for (const f of fs.readdirSync(path.join(root, d.name))) {
        if (f.endsWith('.jsonl')) out.push(path.join(root, d.name, f));
      }
    } catch { /* skip unreadable */ }
  }
  return out;
}

// Rolling windows, newest → oldest. Keys are stable API; the UI labels them.
const USAGE_WINDOWS = [
  ['h1', 3600_000],
  ['h5', 5 * 3600_000],
  ['h10', 10 * 3600_000],
  ['h24', 24 * 3600_000],
  ['d7', 7 * 24 * 3600_000],
  ['d30', 30 * 24 * 3600_000],
];

function accountUsage(configDir) {
  const now = Date.now();
  // Every window (incl. 'all') carries totals + its own per-model breakdown,
  // so the UI's window selector re-slices the whole card, not just one number.
  const windows = { all: { in: 0, out: 0, models: {} } };
  for (const [key] of USAGE_WINDOWS) windows[key] = { in: 0, out: 0, models: {} };

  const add = (w, model, inTok, outTok, cacheRead) => {
    w.in += inTok;
    w.out += outTok;
    const m = (w.models[model] ??= { input: 0, output: 0, cacheRead: 0, turns: 0 });
    m.input += inTok;
    m.output += outTok;
    m.cacheRead += cacheRead;
    m.turns += 1;
  };

  for (const file of transcriptFiles(configDir)) {
    const parsed = parseTranscriptFile(file);
    if (!parsed) continue;
    for (const [t, model, inTok, outTok, cacheRead] of parsed.events) {
      add(windows.all, model, inTok, outTok, cacheRead);
      const age = now - t;
      for (const [key, span] of USAGE_WINDOWS) {
        if (age < span) add(windows[key], model, inTok, outTok, cacheRead);
      }
    }
  }
  return { windows };
}

// Roll-up across every account: the default one + each Helm profile
app.get('/api/usage', (_req, res) => {
  const accounts = [];
  // default account: config file is ~/.claude.json, data lives in ~/.claude
  const defaultRoot = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
  accounts.push({
    account: 'default',
    email: accountEmail(process.env.CLAUDE_CONFIG_DIR || os.homedir()),
    ...accountUsage(defaultRoot),
  });
  try {
    for (const d of fs.readdirSync(ACCOUNTS_DIR, { withFileTypes: true })) {
      if (!d.isDirectory()) continue;
      const dir = path.join(ACCOUNTS_DIR, d.name);
      accounts.push({ account: d.name, email: accountEmail(dir), ...accountUsage(dir) });
    }
  } catch { /* no profiles yet */ }
  res.json(accounts);
});

// Token usage per model for one pane's conversation transcript
app.get('/api/sessions/:id/usage', (req, res) => {
  const session = sessions.get(req.params.id);
  if (!session) return res.status(404).json({ error: 'no such session' });
  const parsed = session.transcriptPath ? parseTranscriptFile(session.transcriptPath) : null;
  if (!parsed) return res.json({ available: false });
  res.json({ available: true, models: parsed.models });
});

// ------------------------------------------------------------- workspaces
// Persisted as JSON in %LOCALAPPDATA%\Helm\workspaces.json (not in the
// OneDrive-synced repo). Removing a workspace does NOT kill its sessions.

function loadWorkspaces() {
  try {
    const list = JSON.parse(fs.readFileSync(WORKSPACES_FILE, 'utf8'));
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}
let workspaces = loadWorkspaces();

function saveWorkspaces() {
  fs.mkdirSync(HELM_DIR, { recursive: true });
  fs.writeFileSync(WORKSPACES_FILE, JSON.stringify(workspaces, null, 2));
}

app.get('/api/workspaces', (_req, res) => {
  res.json(workspaces);
});

app.post('/api/workspaces', (req, res) => {
  const { name, dir } = req.body || {};
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
  workspaces.push(workspace);
  saveWorkspaces();
  res.status(201).json(workspace);
});

app.delete('/api/workspaces/:id', (req, res) => {
  const before = workspaces.length;
  workspaces = workspaces.filter((w) => w.id !== req.params.id);
  if (workspaces.length === before) return res.status(404).json({ error: 'no such workspace' });
  saveWorkspaces();
  res.json({ ok: true });
});

// The logged-in account's email lives in `<config dir>\.claude.json` →
// oauthAccount.emailAddress (null until /login has been run in that profile).
function accountEmail(configDir) {
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(configDir, '.claude.json'), 'utf8'));
    return cfg.oauthAccount?.emailAddress ?? null;
  } catch {
    return null;
  }
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
    // unless the server itself was started with CLAUDE_CONFIG_DIR set)
    default: { email: accountEmail(process.env.CLAUDE_CONFIG_DIR || os.homedir()) },
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
  res.json({ ok: true });
});

// ---------------------------------------------------------------------- ws

const server = app.listen(PORT, HOST, () => {
  console.log(`Helm ⎈  http://${HOST}:${PORT}`);
  console.log(`token: ${TOKEN}`);
  const dead = [...sessions.values()].filter((s) => s.status === 'dead').length;
  dbg('server', `started (pid ${process.pid})${dead ? ` — ${dead} dead session(s) loaded, revivable` : ''}`);
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(
      `\nHelm is already running (something is listening on port ${PORT}).\n` +
      `Open http://${HOST}:${PORT} — or, to restart with new code, stop the old\n` +
      `server first. PowerShell:\n` +
      `  Get-NetTCPConnection -LocalPort ${PORT} -State Listen |\n` +
      `    ForEach-Object { Stop-Process -Id $_.OwningProcess -Force }\n` +
      `(Live panes die with it but come back as revivable.)\n`,
    );
    process.exit(1);
  }
  throw err;
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
  if (origin && !ALLOWED_ORIGINS.has(origin)) return reject('bad origin');
  if (url.searchParams.get('token') !== TOKEN) return reject('bad token');
  if (!session) return reject('no such session');

  wss.handleUpgrade(req, socket, head, (ws) => attach(ws, session));
});

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
