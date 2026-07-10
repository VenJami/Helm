// Helm real-claude end-to-end check — `npm run e2e` (NOT part of `npm test`/CI).
//
// The smoke suite drives a keep-alive stand-in; this drives the REAL `claude`
// CLI, because Helm's value-bearing features (hooks → status, transcript →
// usage/titles, --resume revive) depend on claude's undocumented behavior that
// only the real binary exhibits (docs/CLAUDE_INTERNALS.md). It codifies the
// throwaway-script pattern from docs/GOTCHAS.md as a permanent, repeatable
// check: run it after changes to spawn/hook/usage/revive code, and after a
// claude CLI update.
//
// What it costs/touches: one tiny conversation on the machine's DEFAULT claude
// account (a few hundred tokens; the transcript lands in ~/.claude/projects
// like any real session). Helm state is isolated in a temp dir — your real
// %LOCALAPPDATA%\Helm is never touched. A live Helm on :7777 is unaffected
// (OS-assigned port).
//
// Flow: boot isolated server → real pane in a temp workspace → accept the
// folder-trust dialog if it appears → prompt → assert SessionStart/
// UserPromptSubmit/Stop hook transitions, transcript on disk, usage tokens,
// first-prompt summary → RESTART the server → assert the pane came back dead+
// resumable → revive → assert the SAME claude session id (no fork).

import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';

const serverDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'helm-e2e-'));
const helmDir = path.join(tmp, 'Helm');
const projDir =
  fs.mkdirSync(path.join(tmp, 'e2e-project'), { recursive: true }) ?? path.join(tmp, 'e2e-project');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
let failed = false;
const check = (name, ok, extra = '') => {
  results.push([name, ok]);
  if (!ok) failed = true;
  console.log(`${ok ? 'PASS' : 'FAIL'} - ${name}${extra ? ` (${extra})` : ''}`);
};
const bail = async (msg) => {
  console.error(`ABORT - ${msg}`);
  await cleanup();
  process.exit(1);
};

let PORT = 0,
  TOKEN = '',
  child = null;
const api = (p, opts = {}) =>
  fetch(`http://127.0.0.1:${PORT}/api${p}`, {
    ...opts,
    headers: {
      authorization: `Bearer ${TOKEN}`,
      'content-type': 'application/json',
      ...opts.headers,
    },
  });
const sessionInfo = async (id) => (await (await api('/sessions')).json()).find((s) => s.id === id);
// Poll a session until `pred` holds or the deadline passes; returns last info.
async function waitFor(id, pred, ms, label) {
  const deadline = Date.now() + ms;
  let s;
  while (Date.now() < deadline) {
    s = await sessionInfo(id);
    if (s && pred(s)) return s;
    await sleep(500);
  }
  console.error(`  (timeout waiting for: ${label})`);
  return s;
}

async function freePort() {
  return new Promise((res) => {
    const s = net.createServer().listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => res(port));
    });
  });
}

async function boot() {
  PORT = await freePort();
  TOKEN = '';
  // HELM_DATA_DIR isolates Helm's state; HOME/USERPROFILE stay REAL so the
  // machine's actual ~/.claude login is what the pane runs on.
  const env = { ...process.env, PORT: String(PORT), HELM_DATA_DIR: helmDir };
  delete env.CLAUDE_CONFIG_DIR; // default account = the machine's real ~/.claude
  child = spawn(process.execPath, ['index.mjs'], {
    cwd: serverDir,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let err = '';
  child.stderr.on('data', (d) => {
    err += d;
  });
  child.stdout.on('data', () => {});
  const deadline = Date.now() + 12000;
  while (Date.now() < deadline) {
    try {
      if (!TOKEN) TOKEN = fs.readFileSync(path.join(helmDir, 'token'), 'utf8').trim();
      if ((await api('/sessions')).ok) return;
    } catch {
      /* not up yet */
    }
    await sleep(200);
  }
  await bail(`server did not boot\n${err}`);
}
const stopServer = () =>
  new Promise((res) => {
    child.once('exit', res);
    child.kill();
  });
async function cleanup() {
  try {
    await stopServer();
  } catch {
    /* already down */
  }
  await sleep(1500); // node-pty children can hold cwd for a beat (EBUSY)
  try {
    fs.rmSync(tmp, { recursive: true, force: true });
  } catch {
    /* temp — OS cleans it */
  }
}

// ---------------------------------------------------------------- phase 1: boot
console.log('booting isolated server (real claude)…');
await boot();

// The drift check must see a real, current claude.
{
  let d = { claude: { checked: false } };
  const deadline = Date.now() + 15000;
  while (!(d = await (await api('/diagnostics')).json()).claude.checked && Date.now() < deadline)
    await sleep(300);
  check(
    'real claude CLI present + at/above tested floor',
    d.claude.ok === true,
    `version=${d.claude.version}`,
  );
}

await api('/workspaces', { method: 'POST', body: JSON.stringify({ name: 'e2e', dir: projDir }) });
const created = await (
  await api('/sessions', {
    method: 'POST',
    body: JSON.stringify({ workspace: projDir, cols: 120, rows: 30 }),
  })
).json();
const id = created.id;
check('pane spawned (status running)', created.status === 'running');

// WS attach: watch output + type into the pane like the browser does.
const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws?session=${id}&token=${TOKEN}`);
const type = (data) => ws.send(JSON.stringify({ type: 'input', data }));
await new Promise((res, rej) => {
  ws.once('open', res);
  ws.once('error', rej);
});

// ------------------------------------------- phase 2: trust dialog + first hook
// A fresh temp dir always shows the folder-trust dialog on the default profile;
// SessionStart only fires once past it. ConPTY collapses on-screen spaces so
// matching the dialog text is unreliable — just send Enter (= the default "Yes,
// trust") a few times early; harmless once claude is up. `canResume` going true
// (via the SessionStart hook's session_id + transcript_path) is the ready signal.
console.log('waiting for claude to boot (nudging Enter to accept trust)…');
let s = null;
{
  const deadline = Date.now() + 90000;
  let nudges = 0;
  while (Date.now() < deadline) {
    s = await sessionInfo(id);
    if (s?.activity) break; // SessionStart landed → claude is up
    if (nudges++ < 6) type('\r'); // accept trust (idempotent once past it)
    await sleep(3000);
  }
}
check(
  'SessionStart hook → pane became ready (activity set)',
  Boolean(s?.activity),
  `activity=${s?.activity}`,
);
if (!s?.activity) {
  await bail('claude never reported a session — likely stuck at a prompt');
}

// ------------------------------------------------- phase 3: prompt → work → idle
const PROMPT = 'Reply with exactly: pong';
console.log('sending prompt…');
type(PROMPT);
await sleep(400); // paste-then-Enter as its own keypress (broadcast pattern)
type('\r');

s = await waitFor(id, (x) => x.activity === 'working', 30000, 'UserPromptSubmit → working');
check(
  'UserPromptSubmit hook → badge "working"',
  s?.activity === 'working',
  `activity=${s?.activity}`,
);

s = await waitFor(id, (x) => x.activity === 'idle', 120000, 'Stop → idle');
check(
  'Stop hook → badge "idle" (turn finished)',
  s?.activity === 'idle',
  `activity=${s?.activity}`,
);

// -------------------------------------- phase 4: transcript, usage, title
// The public API exposes hasTranscript/canResume/summary (not the raw path/id).
check(
  'transcript captured + resumable (hasTranscript && canResume)',
  s?.hasTranscript === true && s?.canResume === true,
  `hasTranscript=${s?.hasTranscript} canResume=${s?.canResume}`,
);
check(
  'pane auto-title = the opening prompt',
  s?.summary === PROMPT,
  `summary=${JSON.stringify(s?.summary)}`,
);

{
  // The transcript flushes around Stop; give usage a few polls to show up.
  let u = { available: false };
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    u = await (await api(`/sessions/${id}/usage`)).json();
    if (u.available) break;
    await sleep(1000);
  }
  const totalIn = Object.values(u.models ?? {}).reduce(
    (n, m) => n + m.input + m.cacheRead + m.cacheWrite,
    0,
  );
  const totalOut = Object.values(u.models ?? {}).reduce((n, m) => n + m.output, 0);
  check(
    'real usage parsed from transcript (tokens > 0)',
    u.available && totalIn > 0 && totalOut > 0,
    `in+cache=${totalIn} out=${totalOut} models=${Object.keys(u.models ?? {}).join(',')}`,
  );
}

// --------------------------------- phase 5: server restart → revive (--resume)
console.log('restarting server to test crash-recovery + revive…');
ws.close();
await stopServer();
await boot();

s = await sessionInfo(id);
check(
  'after restart: pane persisted as dead + resumable',
  s?.status === 'dead' && s?.canResume === true,
  `status=${s?.status} canResume=${s?.canResume}`,
);

await api(`/sessions/${id}/revive`, {
  method: 'POST',
  body: JSON.stringify({ cols: 120, rows: 30 }),
});
s = await waitFor(
  id,
  (x) => x.status === 'running' && x.hasTranscript,
  90000,
  'revive back to running',
);
// Same conversation (not a fork): --resume keeps the ORIGINAL opening prompt as
// the title. A fresh session would reset the summary to null. Combined with
// canResume (claude session id preserved) this proves the resume, using only
// public fields.
check(
  'revive resumed the SAME conversation (opening prompt preserved)',
  s?.status === 'running' && s?.summary === PROMPT && s?.canResume === true,
  `status=${s?.status} summary=${JSON.stringify(s?.summary)}`,
);

// ------------------------------------------------------------------- cleanup
await api(`/sessions/${id}`, { method: 'DELETE' }).catch(() => {});
await cleanup();
console.log(`\n${results.filter(([, ok]) => ok).length}/${results.length} checks passed`);
process.exit(failed ? 1 : 0);
