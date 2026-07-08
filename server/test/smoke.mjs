// Helm smoke test — boots a real server on a throwaway port + isolated data
// dir, driving it end-to-end through REST + WS + the hook relay. Uses a
// keep-alive stand-in for `claude` (fake-claude) so it never needs a login,
// a network, or the real CLI. Codifies the manual "throwaway script" pattern
// from docs/GOTCHAS.md so the PTY / hook / usage / lifecycle paths a build
// can't catch stay covered.
//
// Run: cd server && npm test
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';

const IS_WIN = process.platform === 'win32';
const testDir = path.dirname(fileURLToPath(import.meta.url));
const serverDir = path.join(testDir, '..');
// Isolated HOME so the server's data dir (~/.helm or %LOCALAPPDATA%\Helm) lands
// in a temp folder we own — never the developer's real Helm store.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'helm-smoke-'));
const helmDir = IS_WIN ? path.join(tmp, 'Helm') : path.join(tmp, '.helm');
const wrapper = path.join(testDir, IS_WIN ? 'fake-claude.cmd' : 'fake-claude.sh');

let child;
let PORT = 0;
let TOKEN = '';
let HOOK_TOKEN = '';

const U = (p) => `http://127.0.0.1:${PORT}${p}`; // absolute URL for a given path
const authed = (p, opts = {}) =>
  fetch(U('/api' + p), {
    ...opts,
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json', ...opts.headers },
  });
// Hook relay POST — authed by the separate hook token, not the UI bearer token.
const hook = (sessionId, event) =>
  fetch(U('/api/hook'), {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-helm-hook': HOOK_TOKEN },
    body: JSON.stringify({ sessionId, event }),
  });
const mkdir = (p) => { fs.mkdirSync(p, { recursive: true }); return p; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Let the OS assign a free ephemeral port — dodges Windows' scattered reserved
// port ranges (which reject fixed guesses with EACCES).
const freePort = () => new Promise((resolve, reject) => {
  const srv = net.createServer();
  srv.on('error', reject);
  srv.listen(0, '127.0.0.1', () => {
    const { port } = srv.address();
    srv.close(() => resolve(port));
  });
});

// Boot the server on one port; resolve true once it answers an authed request.
// Windows reserves scattered high-port ranges (EACCES) and ports can be busy,
// so the caller retries across several candidate ports.
async function tryBoot(port) {
  PORT = port;
  TOKEN = '';
  const env = {
    ...process.env,
    PORT: String(port),
    HOME: tmp,
    USERPROFILE: tmp,
    LOCALAPPDATA: tmp,
    HELM_CLAUDE_CMD: wrapper,
    HELM_USAGE_TTL_MS: '0', // usage tests append + immediately re-poll
  };
  delete env.CLAUDE_CONFIG_DIR; // don't inherit a real default account
  child = spawn(process.execPath, ['index.mjs'], { cwd: serverDir, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  let exited = false;
  child.stdout.on('data', () => {});          // drain so the child never blocks on a full pipe
  child.stderr.on('data', (d) => { stderr += d; });
  child.on('exit', () => { exited = true; });

  const deadline = Date.now() + 6000;
  while (Date.now() < deadline && !exited) {
    try {
      if (!TOKEN) TOKEN = fs.readFileSync(path.join(helmDir, 'token'), 'utf8').trim();
      const res = await authed('/sessions');
      if (res.ok) { HOOK_TOKEN = fs.readFileSync(path.join(helmDir, 'hook-token'), 'utf8').trim(); return true; }
    } catch { /* not up yet */ }
    await sleep(150);
  }
  child.kill();
  if (stderr && !/EACCES|EADDRINUSE/.test(stderr)) console.error(`server stderr on ${port}:\n${stderr}`);
  return false;
}

before(async () => {
  if (!IS_WIN) fs.chmodSync(wrapper, 0o755);
  for (let i = 0; i < 6; i++) {
    if (await tryBoot(await freePort())) return; // retry only guards the tiny bind race
    await sleep(100);
  }
  throw new Error('server did not come up on any candidate port');
});

after(async () => {
  // Kill every live session's PTY, then the server, then the temp dir.
  try {
    const list = await (await authed('/sessions')).json();
    for (const s of list) await authed(`/sessions/${s.id}`, { method: 'DELETE' }).catch(() => {});
  } catch { /* server may already be gone */ }
  child?.kill();
  await new Promise((r) => setTimeout(r, 300));
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('REST requires the bearer token', async () => {
  const noAuth = await fetch(U('/api/sessions'));
  assert.equal(noAuth.status, 401);
  const ok = await authed('/sessions');
  assert.equal(ok.status, 200);
  assert.ok(Array.isArray(await ok.json()));
});

test('diagnostics report claude health (drift alarm)', async () => {
  // fake-claude answers `--version` at the tested floor, so the isolated
  // server should read a healthy claude and raise no drift warnings.
  let d;
  for (let i = 0; i < 20 && !(d = await (await authed('/diagnostics')).json()).claude.checked; i++) {
    await sleep(150);
  }
  assert.equal(d.claude.checked, true);
  assert.equal(d.claude.ok, true);
  assert.equal(d.claude.version, '2.1.198');
  assert.ok(Array.isArray(d.warnings));
  assert.equal(d.warnings.filter((w) => w.key.startsWith('claude-')).length, 0);
});

test('session lifecycle + hook status/activityNote + WS replay', async () => {
  const ws = mkdir(path.join(tmp, 'proj'));
  await authed('/workspaces', { method: 'POST', body: JSON.stringify({ name: 'proj', dir: ws }) });

  const created = await (await authed('/sessions', { method: 'POST', body: JSON.stringify({ workspace: ws }) })).json();
  assert.equal(created.status, 'running');
  const id = created.id;

  // A Notification hook → waiting + the message carried into activityNote.
  const msg = 'Claude needs your permission to use Bash';
  await hook(id, { hook_event_name: 'Notification', message: msg, session_id: 'c-abc' });
  let s = (await (await authed('/sessions')).json()).find((x) => x.id === id);
  assert.equal(s.activity, 'waiting');
  assert.equal(s.activityNote, msg);

  // Back to work → activity flips and the note clears.
  await hook(id, { hook_event_name: 'UserPromptSubmit' });
  s = (await (await authed('/sessions')).json()).find((x) => x.id === id);
  assert.equal(s.activity, 'working');
  assert.equal(s.activityNote, null);

  // WS attach replays the ring buffer (the stand-in printed a ready line).
  const replay = await new Promise((resolve, reject) => {
    const sock = new WebSocket(`ws://127.0.0.1:${PORT}/ws?session=${id}&token=${TOKEN}`);
    const timer = setTimeout(() => { sock.close(); reject(new Error('no replay within 3s')); }, 3000);
    sock.on('message', (raw) => {
      const m = JSON.parse(raw);
      if (m.type === 'replay') { clearTimeout(timer); sock.close(); resolve(m); }
    });
    sock.on('error', reject);
  });
  assert.equal(replay.type, 'replay');

  await authed(`/sessions/${id}`, { method: 'DELETE' });
  assert.ok(!(await (await authed('/sessions')).json()).some((x) => x.id === id));
});

test('pane summary is derived from the first real user prompt', async () => {
  const ws = mkdir(path.join(tmp, 'sumproj'));
  const created = await (await authed('/sessions', { method: 'POST', body: JSON.stringify({ workspace: ws }) })).json();
  const id = created.id;
  // A transcript whose first user line is a meta/command wrapper (should be
  // skipped) followed by the real opening prompt.
  const tpath = path.join(tmp, 'summary.jsonl');
  fs.writeFileSync(tpath, [
    JSON.stringify({ type: 'user', isMeta: true, message: { content: '<command-name>/clear</command-name>' } }),
    JSON.stringify({ type: 'user', message: { content: 'Fix the OAuth token refresh bug in the API' } }),
    JSON.stringify({ type: 'assistant', message: { content: 'ok' } }),
  ].join('\n'));
  // A hook is how a real pane reports its transcript path to the server.
  await hook(id, { hook_event_name: 'UserPromptSubmit', session_id: 'sum-1', transcript_path: tpath });
  const s = (await (await authed('/sessions')).json()).find((x) => x.id === id);
  assert.equal(s.summary, 'Fix the OAuth token refresh bug in the API');
  await authed(`/sessions/${id}`, { method: 'DELETE' });
});

// Runs the REAL in-pane relay script (hook-post.mjs) as a child — the same way
// claude invokes it — instead of POSTing /api/hook directly.
const relay = (sessionId, event) => new Promise((resolve, reject) => {
  const child = spawn(process.execPath, [path.join(serverDir, 'hook-post.mjs')], {
    env: { ...process.env, HELM_SESSION_ID: sessionId, HELM_HOOK_TOKEN: HOOK_TOKEN, HELM_PORT: String(PORT) },
    stdio: ['pipe', 'ignore', 'ignore'],
  });
  child.on('exit', resolve);
  child.on('error', reject);
  child.stdin.end(JSON.stringify(event));
});

test('hook relay (hook-post.mjs) + usage engine: dedupe, cost, incremental, partial lines', async () => {
  const wsDir = mkdir(path.join(tmp, 'usageproj'));
  const created = await (await authed('/sessions', { method: 'POST', body: JSON.stringify({ workspace: wsDir }) })).json();
  const id = created.id;

  // A realistic transcript in the DEFAULT account's store (~/.claude/projects,
  // which the isolated HOME points into tmp) so the roll-up scan finds it too.
  const claudeSid = 'facade00-0000-4000-8000-000000000001';
  const tdir = mkdir(path.join(tmp, '.claude', 'projects', 'usageproj'));
  const tpath = path.join(tdir, `${claudeSid}.jsonl`);
  const now = new Date().toISOString();
  const asst = (mid, usage) => JSON.stringify(
    { type: 'assistant', timestamp: now, message: { id: mid, model: 'claude-sonnet-4-5', usage } });
  fs.writeFileSync(tpath, [
    JSON.stringify({ type: 'user', message: { content: 'Refactor the usage engine' }, timestamp: now }),
    asst('m1', { input_tokens: 999999, output_tokens: 1 }),   // streaming: superseded…
    asst('m1', { input_tokens: 1000, output_tokens: 500, cache_read_input_tokens: 2000, cache_creation_input_tokens: 100 }), // …by the final copy
  ].join('\n') + '\n');

  // Report it through the real relay (exercises env wiring + POST /api/hook auth)
  await relay(id, { hook_event_name: 'SessionStart', session_id: claudeSid, transcript_path: tpath });
  const s = (await (await authed('/sessions')).json()).find((x) => x.id === id);
  assert.equal(s.summary, 'Refactor the usage engine');
  assert.equal(s.canResume, true);

  // Per-pane usage: duplicate message ids collapse to the LAST occurrence
  let u = await (await authed(`/sessions/${id}/usage`)).json();
  assert.equal(u.available, true);
  let m = u.models['claude-sonnet-4-5'];
  assert.deepEqual(
    { input: m.input, output: m.output, cacheRead: m.cacheRead, cacheWrite: m.cacheWrite, turns: m.turns },
    { input: 1000, output: 500, cacheRead: 2000, cacheWrite: 100, turns: 1 },
  );
  assert.ok(m.cost > 0, 'known model must carry a $ estimate');

  // Account roll-up: lands in the default account's recent windows, with cost
  const acc = (await (await authed('/usage')).json()).find((a) => a.account === 'default');
  assert.ok(acc.windows.h1.input >= 1000, 'fresh usage must appear in the 1h window');
  assert.ok(acc.windows.all.cost > 0);
  assert.ok(acc.lastActive > 0);

  // Incremental: an appended turn is picked up (byte-offset parse, not full re-read)
  fs.appendFileSync(tpath, asst('m2', { input_tokens: 111, output_tokens: 11 }) + '\n');
  u = await (await authed(`/sessions/${id}/usage`)).json();
  m = u.models['claude-sonnet-4-5'];
  assert.equal(m.turns, 2);
  assert.equal(m.input, 1111);

  // A half-written line (claude mid-write) is held back, then counted once complete
  const l3 = asst('m3', { input_tokens: 7, output_tokens: 7 }) + '\n';
  fs.appendFileSync(tpath, l3.slice(0, 40));
  u = await (await authed(`/sessions/${id}/usage`)).json();
  assert.equal(u.models['claude-sonnet-4-5'].turns, 2, 'partial tail must not be counted');
  fs.appendFileSync(tpath, l3.slice(40));
  u = await (await authed(`/sessions/${id}/usage`)).json();
  assert.equal(u.models['claude-sonnet-4-5'].turns, 3, 'completed tail must be counted');

  await authed(`/sessions/${id}`, { method: 'DELETE' });
});

test('workspace git status reports branch + dirty', async () => {
  const repo = mkdir(path.join(tmp, 'repo'));
  const git = (...args) => execFileSync('git', ['-C', repo, ...args], { stdio: 'ignore' });
  git('init', '-b', 'trunk');
  fs.writeFileSync(path.join(repo, 'file.txt'), 'hi'); // untracked → dirty
  const ws = await (await authed('/workspaces', {
    method: 'POST', body: JSON.stringify({ name: 'repo', dir: repo }),
  })).json();

  const g = (await (await authed('/workspaces/git')).json()).find((x) => x.id === ws.id);
  assert.equal(g.branch, 'trunk');
  assert.equal(g.dirty, true);
});

test('workspace dev-server check reports up/down by port', async () => {
  // Stand-in "dev server": a bare TCP listener on a free port → should read up.
  const upPort = await freePort();
  const listener = net.createServer();
  await new Promise((r) => listener.listen(upPort, '127.0.0.1', r));
  const downPort = await freePort(); // nothing listening here → down

  const upDir = mkdir(path.join(tmp, 'srv-up'));
  const downDir = mkdir(path.join(tmp, 'srv-down'));
  const noneDir = mkdir(path.join(tmp, 'srv-none'));
  const wsUp = await (await authed('/workspaces', {
    method: 'POST', body: JSON.stringify({ name: 'up', dir: upDir, port: upPort }),
  })).json();
  const wsDown = await (await authed('/workspaces', {
    method: 'POST', body: JSON.stringify({ name: 'down', dir: downDir, port: downPort }),
  })).json();
  const wsNone = await (await authed('/workspaces', {
    method: 'POST', body: JSON.stringify({ name: 'none', dir: noneDir }),
  })).json();
  assert.equal(wsUp.port, upPort);

  const list = await (await authed('/workspaces/servers')).json();
  assert.equal(list.find((x) => x.id === wsUp.id)?.up, true);
  assert.equal(list.find((x) => x.id === wsDown.id)?.up, false);
  // Workspaces without a port aren't reported at all.
  assert.equal(list.some((x) => x.id === wsNone.id), false);

  // Bad port is rejected; clearing the port (null) drops it from the report.
  const bad = await authed(`/workspaces/${wsUp.id}`, { method: 'PATCH', body: JSON.stringify({ port: 99999 }) });
  assert.equal(bad.status, 400);
  await authed(`/workspaces/${wsUp.id}`, { method: 'PATCH', body: JSON.stringify({ port: null }) });
  const list2 = await (await authed('/workspaces/servers')).json();
  assert.equal(list2.some((x) => x.id === wsUp.id), false);

  await new Promise((r) => listener.close(r));
});

test('PATCH workspace dir moves the root (and rejects a non-dir)', async () => {
  const dirA = mkdir(path.join(tmp, 'root-a'));
  const dirB = mkdir(path.join(tmp, 'root-b'));
  const ws = await (await authed('/workspaces', {
    method: 'POST', body: JSON.stringify({ name: 'movable', dir: dirA }),
  })).json();
  assert.equal(ws.dir, path.resolve(dirA));

  // Re-root onto a second real dir → the change sticks.
  const patched = await authed(`/workspaces/${ws.id}`, {
    method: 'PATCH', body: JSON.stringify({ dir: dirB }),
  });
  assert.equal(patched.status, 200);
  const after = (await (await authed('/workspaces')).json()).find((w) => w.id === ws.id);
  assert.equal(after.dir, path.resolve(dirB));

  // A path that isn't a real directory is refused (dir unchanged).
  const bad = await authed(`/workspaces/${ws.id}`, {
    method: 'PATCH', body: JSON.stringify({ dir: path.join(tmp, 'does-not-exist') }),
  });
  assert.equal(bad.status, 400);
  const still = (await (await authed('/workspaces')).json()).find((w) => w.id === ws.id);
  assert.equal(still.dir, path.resolve(dirB));
});

test('PATCH workspace port sets then clears', async () => {
  const dir = mkdir(path.join(tmp, 'ported'));
  const ws = await (await authed('/workspaces', {
    method: 'POST', body: JSON.stringify({ name: 'ported', dir }),
  })).json();
  assert.equal(ws.port, undefined); // created without a port

  const set = await authed(`/workspaces/${ws.id}`, { method: 'PATCH', body: JSON.stringify({ port: 4321 }) });
  assert.equal(set.status, 200);
  assert.equal((await set.json()).port, 4321);

  const cleared = await authed(`/workspaces/${ws.id}`, { method: 'PATCH', body: JSON.stringify({ port: null }) });
  assert.equal(cleared.status, 200);
  assert.equal((await cleared.json()).port, undefined);
});

test('GET/POST /api/console reports shape and (Windows) toggles visibility', async (t) => {
  const q = await authed('/console');
  assert.equal(q.status, 200);
  const state = await q.json();
  assert.equal(typeof state.supported, 'boolean');
  assert.equal(typeof state.visible, 'boolean');

  if (!state.supported) { t.skip('console control unsupported off-Windows / detached'); return; }

  // Non-boolean body is rejected.
  const bad = await authed('/console', { method: 'POST', body: JSON.stringify({ visible: 'yes' }) });
  assert.equal(bad.status, 400);

  // Hide then show — the returned `visible` tracks the request. Ends visible so
  // the developer's server console is left restored.
  const hidden = await (await authed('/console', { method: 'POST', body: JSON.stringify({ visible: false }) })).json();
  assert.equal(hidden.visible, false);
  const shown = await (await authed('/console', { method: 'POST', body: JSON.stringify({ visible: true }) })).json();
  assert.equal(shown.visible, true);
});

test('deleting a profile clears its workspace pins', async () => {
  mkdir(path.join(helmDir, 'accounts', 'acct1')); // pretend a profile exists
  const dir = mkdir(path.join(tmp, 'pinned'));
  const ws = await (await authed('/workspaces', {
    method: 'POST', body: JSON.stringify({ name: 'pinned', dir, profile: 'acct1' }),
  })).json();
  assert.equal(ws.profile, 'acct1');

  const del = await authed('/profiles/acct1', { method: 'DELETE' });
  assert.equal(del.status, 200);

  const after = (await (await authed('/workspaces')).json()).find((w) => w.id === ws.id);
  assert.equal(after.profile, undefined); // pin gone, not dangling
});
