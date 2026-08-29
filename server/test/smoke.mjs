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
import http from 'node:http';
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
// Stand-in for cloudflared, so share links can be driven without the real
// binary or any network (see fake-cloudflared.mjs).
const cfWrapper = path.join(testDir, IS_WIN ? 'fake-cloudflared.cmd' : 'fake-cloudflared.sh');

let child;
// Stand-in for the GitHub releases API, so the update check is driven
// end-to-end without a network (HELM_UPDATE_URL points the server at it).
let ghStub;
let ghUrl = '';
let PORT = 0;
let TOKEN = '';
let HOOK_TOKEN = '';

const U = (p) => `http://127.0.0.1:${PORT}${p}`; // absolute URL for a given path
const authed = (p, opts = {}) =>
  fetch(U('/api' + p), {
    ...opts,
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      'Content-Type': 'application/json',
      ...opts.headers,
    },
  });
// Hook relay POST — authed by the separate hook token, not the UI bearer token.
const hook = (sessionId, event) =>
  fetch(U('/api/hook'), {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-helm-hook': HOOK_TOKEN },
    body: JSON.stringify({ sessionId, event }),
  });
const mkdir = (p) => {
  fs.mkdirSync(p, { recursive: true });
  return p;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Let the OS assign a free ephemeral port — dodges Windows' scattered reserved
// port ranges (which reject fixed guesses with EACCES).
const freePort = () =>
  new Promise((resolve, reject) => {
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
    HELM_CLOUDFLARED_CMD: cfWrapper,
    HELM_USAGE_TTL_MS: '0', // usage tests append + immediately re-poll
    HELM_UPDATE_URL: ghUrl, // fake "latest release" endpoint (see ghStub)
  };
  delete env.CLAUDE_CONFIG_DIR; // don't inherit a real default account
  child = spawn(process.execPath, ['index.mjs'], {
    cwd: serverDir,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  let exited = false;
  child.stdout.on('data', () => {}); // drain so the child never blocks on a full pipe
  child.stderr.on('data', (d) => {
    stderr += d;
  });
  child.on('exit', () => {
    exited = true;
  });

  const deadline = Date.now() + 12000; // generous — cold CI runners boot slowly
  while (Date.now() < deadline && !exited) {
    try {
      if (!TOKEN) TOKEN = fs.readFileSync(path.join(helmDir, 'token'), 'utf8').trim();
      const res = await authed('/sessions');
      if (res.ok) {
        HOOK_TOKEN = fs.readFileSync(path.join(helmDir, 'hook-token'), 'utf8').trim();
        return true;
      }
    } catch {
      /* not up yet */
    }
    await sleep(150);
  }
  child.kill();
  if (stderr && !/EACCES|EADDRINUSE/.test(stderr))
    console.error(`server stderr on ${port}:\n${stderr}`);
  return false;
}

before(async () => {
  if (!IS_WIN) fs.chmodSync(wrapper, 0o755);
  ghStub = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        tag_name: 'v9.9.9',
        html_url: 'https://example.invalid/releases/v9.9.9',
        name: 'Test release',
        published_at: '2026-08-28T00:00:00.000Z',
      }),
    );
  });
  await new Promise((r) => ghStub.listen(0, '127.0.0.1', r));
  ghUrl = `http://127.0.0.1:${ghStub.address().port}/releases/latest`;
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
  } catch {
    /* server may already be gone */
  }
  child?.kill();
  ghStub?.close();
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
  // server should read a healthy claude and raise no drift warnings. The
  // version check spawns cmd → node, which a cold CI runner can take seconds
  // to do — poll up to 10 s rather than a tight wall.
  let d;
  const deadline = Date.now() + 10000;
  while (
    !(d = await (await authed('/diagnostics')).json()).claude.checked &&
    Date.now() < deadline
  ) {
    await sleep(200);
  }
  assert.equal(d.claude.checked, true);
  assert.equal(d.claude.ok, true);
  assert.equal(d.claude.version, '2.1.198');
  assert.ok(Array.isArray(d.warnings));
  assert.equal(d.warnings.filter((w) => w.key.startsWith('claude-')).length, 0);
});

test('update check reports a newer release (cached server-side)', async () => {
  let info;
  for (let i = 0; i < 50; i++) {
    info = await (await authed('/update')).json();
    if (info.checkedAt) break; // the boot check has returned
    await sleep(100);
  }
  assert.ok(info.checkedAt, 'the update check should run at boot');
  assert.equal(info.error, null);
  assert.equal(info.disabled, false);
  assert.equal(info.available, true);
  assert.equal(info.latest, '9.9.9'); // the `v` prefix is stripped
  assert.equal(info.url, 'https://example.invalid/releases/v9.9.9');
  assert.equal(
    info.current,
    JSON.parse(fs.readFileSync(path.join(serverDir, 'package.json'))).version,
  );
});

test('update check only flags a strictly newer version', async () => {
  const { isNewer } = await import('../src/update.mjs');
  assert.equal(isNewer('v0.3.0', '0.2.0'), true);
  assert.equal(isNewer('0.2.1', '0.2.0'), true);
  assert.equal(isNewer('1.0.0', '0.9.9'), true);
  assert.equal(isNewer('v0.2.0', '0.2.0'), false); // same version: silent
  assert.equal(isNewer('0.1.0', '0.2.0'), false); // older release: silent
  assert.equal(isNewer('v0.10.0', '0.9.0'), true); // numeric, not lexical
  assert.equal(isNewer('nightly', '0.2.0'), false); // unparseable: never claim one
  assert.equal(isNewer('', '0.2.0'), false);
});

test('GET /health is unauthenticated and reports liveness', async () => {
  const res = await fetch(U('/health')); // no bearer token on purpose
  assert.equal(res.status, 200);
  const h = await res.json();
  assert.equal(h.ok, true);
  assert.equal(h.pid > 0, true);
  assert.equal(typeof h.startedAt, 'string');
  assert.equal(typeof h.uptimeSec, 'number');
  assert.ok(h.sessions && typeof h.sessions.total === 'number');
});

test('session lifecycle + hook status/activityNote + WS replay', async () => {
  const ws = mkdir(path.join(tmp, 'proj'));
  await authed('/workspaces', { method: 'POST', body: JSON.stringify({ name: 'proj', dir: ws }) });

  const created = await (
    await authed('/sessions', { method: 'POST', body: JSON.stringify({ workspace: ws }) })
  ).json();
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
  // 10 s, not 3 — a cold CI runner can be slow to complete the WS upgrade.
  const replay = await new Promise((resolve, reject) => {
    const sock = new WebSocket(`ws://127.0.0.1:${PORT}/ws?session=${id}&token=${TOKEN}`);
    const timer = setTimeout(() => {
      sock.close();
      reject(new Error('no replay within 10s'));
    }, 10000);
    sock.on('message', (raw) => {
      const m = JSON.parse(raw);
      if (m.type === 'replay') {
        clearTimeout(timer);
        sock.close();
        resolve(m);
      }
    });
    sock.on('error', reject);
  });
  assert.equal(replay.type, 'replay');

  await authed(`/sessions/${id}`, { method: 'DELETE' });
  assert.ok(!(await (await authed('/sessions')).json()).some((x) => x.id === id));
});

test('pane summary is derived from the first real user prompt', async () => {
  const ws = mkdir(path.join(tmp, 'sumproj'));
  const created = await (
    await authed('/sessions', { method: 'POST', body: JSON.stringify({ workspace: ws }) })
  ).json();
  const id = created.id;
  // A transcript whose first user line is a meta/command wrapper (should be
  // skipped) followed by the real opening prompt. Must live inside the default
  // account's store — the server rejects hook paths outside it.
  const tpath = path.join(mkdir(path.join(tmp, '.claude', 'projects', 'sumproj')), 'sum-1.jsonl');
  fs.writeFileSync(
    tpath,
    [
      JSON.stringify({
        type: 'user',
        isMeta: true,
        message: { content: '<command-name>/clear</command-name>' },
      }),
      JSON.stringify({
        type: 'user',
        message: { content: 'Fix the OAuth token refresh bug in the API' },
      }),
      JSON.stringify({ type: 'assistant', message: { content: 'ok' } }),
    ].join('\n'),
  );
  // A hook is how a real pane reports its transcript path to the server.
  await hook(id, {
    hook_event_name: 'UserPromptSubmit',
    session_id: 'sum-1',
    transcript_path: tpath,
  });
  const s = (await (await authed('/sessions')).json()).find((x) => x.id === id);
  assert.equal(s.summary, 'Fix the OAuth token refresh bug in the API');
  await authed(`/sessions/${id}`, { method: 'DELETE' });
});

// Runs the REAL in-pane relay script (hook-post.mjs) as a child — the same way
// claude invokes it — instead of POSTing /api/hook directly.
const relay = (sessionId, event) =>
  new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(serverDir, 'hook-post.mjs')], {
      env: {
        ...process.env,
        HELM_SESSION_ID: sessionId,
        HELM_HOOK_TOKEN: HOOK_TOKEN,
        HELM_PORT: String(PORT),
      },
      stdio: ['pipe', 'ignore', 'ignore'],
    });
    child.on('exit', resolve);
    child.on('error', reject);
    child.stdin.end(JSON.stringify(event));
  });

test('hook relay (hook-post.mjs) + usage engine: dedupe, cost, incremental, partial lines', async () => {
  const wsDir = mkdir(path.join(tmp, 'usageproj'));
  const created = await (
    await authed('/sessions', { method: 'POST', body: JSON.stringify({ workspace: wsDir }) })
  ).json();
  const id = created.id;

  // A realistic transcript in the DEFAULT account's store (~/.claude/projects,
  // which the isolated HOME points into tmp) so the roll-up scan finds it too.
  const claudeSid = 'facade00-0000-4000-8000-000000000001';
  const tdir = mkdir(path.join(tmp, '.claude', 'projects', 'usageproj'));
  const tpath = path.join(tdir, `${claudeSid}.jsonl`);
  const now = new Date().toISOString();
  const asst = (mid, usage) =>
    JSON.stringify({
      type: 'assistant',
      timestamp: now,
      message: { id: mid, model: 'claude-sonnet-4-5', usage },
    });
  fs.writeFileSync(
    tpath,
    [
      JSON.stringify({
        type: 'user',
        message: { content: 'Refactor the usage engine' },
        timestamp: now,
      }),
      asst('m1', { input_tokens: 999999, output_tokens: 1 }), // streaming: superseded…
      asst('m1', {
        input_tokens: 1000,
        output_tokens: 500,
        cache_read_input_tokens: 2000,
        cache_creation_input_tokens: 100,
      }), // …by the final copy
    ].join('\n') + '\n',
  );

  // Report it through the real relay (exercises env wiring + POST /api/hook auth).
  // hook-post.mjs aborts its POST after 1.5 s and never blocks claude, so on a
  // slow/cold runner the first hook can be dropped — poll (and re-relay) until
  // the session reflects it rather than asserting on a single fire.
  let s;
  const relayDeadline = Date.now() + 15000;
  do {
    await relay(id, {
      hook_event_name: 'SessionStart',
      session_id: claudeSid,
      transcript_path: tpath,
    });
    s = (await (await authed('/sessions')).json()).find((x) => x.id === id);
    if (s?.canResume) break;
    await sleep(500);
  } while (Date.now() < relayDeadline);
  assert.equal(s.summary, 'Refactor the usage engine');
  assert.equal(s.canResume, true);

  // Per-pane usage: duplicate message ids collapse to the LAST occurrence
  let u = await (await authed(`/sessions/${id}/usage`)).json();
  assert.equal(u.available, true);
  let m = u.models['claude-sonnet-4-5'];
  assert.deepEqual(
    {
      input: m.input,
      output: m.output,
      cacheRead: m.cacheRead,
      cacheWrite: m.cacheWrite,
      turns: m.turns,
    },
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

test('trust seams are validated: profile names + hook transcript paths', async () => {
  // A profile name becomes a directory under accounts\ — traversal must 400.
  const dir = mkdir(path.join(tmp, 'valproj'));
  let res = await authed('/workspaces', {
    method: 'POST',
    body: JSON.stringify({ name: 'val', dir, profile: '..\\..\\evil' }),
  });
  assert.equal(res.status, 400);
  const ws = await (
    await authed('/workspaces', {
      method: 'POST',
      body: JSON.stringify({ name: 'val', dir }),
    })
  ).json();
  res = await authed(`/workspaces/${ws.id}`, {
    method: 'PATCH',
    body: JSON.stringify({ profile: '../evil' }),
  });
  assert.equal(res.status, 400);

  // A hook-reported transcript path outside the session's account store is
  // ignored (the path is later fed to file reads/copies) and flagged as drift.
  const created = await (
    await authed('/sessions', { method: 'POST', body: JSON.stringify({ workspace: dir }) })
  ).json();
  const evil = path.join(tmp, 'outside-the-store.jsonl');
  fs.writeFileSync(evil, JSON.stringify({ type: 'user', message: { content: 'nope' } }) + '\n');
  await hook(created.id, {
    hook_event_name: 'SessionStart',
    session_id: 'val-1',
    transcript_path: evil,
  });
  const s = (await (await authed('/sessions')).json()).find((x) => x.id === created.id);
  assert.equal(s.hasTranscript, false, 'out-of-store transcript path must be ignored');
  const diag = await (await authed('/diagnostics')).json();
  assert.ok(
    diag.warnings.some((w) => w.key === 'transcript-path-rejected'),
    'rejection must surface as a loud drift warning, not silence',
  );
  await authed(`/sessions/${created.id}`, { method: 'DELETE' });
});

test('workspace git status reports branch + dirty', async () => {
  const repo = mkdir(path.join(tmp, 'repo'));
  const git = (...args) => execFileSync('git', ['-C', repo, ...args], { stdio: 'ignore' });
  git('init', '-b', 'trunk');
  fs.writeFileSync(path.join(repo, 'file.txt'), 'hi'); // untracked → dirty
  const ws = await (
    await authed('/workspaces', {
      method: 'POST',
      body: JSON.stringify({ name: 'repo', dir: repo }),
    })
  ).json();

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
  const wsUp = await (
    await authed('/workspaces', {
      method: 'POST',
      body: JSON.stringify({ name: 'up', dir: upDir, port: upPort }),
    })
  ).json();
  const wsDown = await (
    await authed('/workspaces', {
      method: 'POST',
      body: JSON.stringify({ name: 'down', dir: downDir, port: downPort }),
    })
  ).json();
  const wsNone = await (
    await authed('/workspaces', {
      method: 'POST',
      body: JSON.stringify({ name: 'none', dir: noneDir }),
    })
  ).json();
  assert.equal(wsUp.port, upPort);

  const list = await (await authed('/workspaces/servers')).json();
  assert.equal(list.find((x) => x.id === wsUp.id)?.up, true);
  assert.equal(list.find((x) => x.id === wsDown.id)?.up, false);
  // Workspaces without a port aren't reported at all.
  assert.equal(
    list.some((x) => x.id === wsNone.id),
    false,
  );

  // Bad port is rejected; clearing the port (null) drops it from the report.
  const bad = await authed(`/workspaces/${wsUp.id}`, {
    method: 'PATCH',
    body: JSON.stringify({ port: 99999 }),
  });
  assert.equal(bad.status, 400);
  await authed(`/workspaces/${wsUp.id}`, { method: 'PATCH', body: JSON.stringify({ port: null }) });
  const list2 = await (await authed('/workspaces/servers')).json();
  assert.equal(
    list2.some((x) => x.id === wsUp.id),
    false,
  );

  await new Promise((r) => listener.close(r));
});

test('PATCH workspace dir moves the root (and rejects a non-dir)', async () => {
  const dirA = mkdir(path.join(tmp, 'root-a'));
  const dirB = mkdir(path.join(tmp, 'root-b'));
  const ws = await (
    await authed('/workspaces', {
      method: 'POST',
      body: JSON.stringify({ name: 'movable', dir: dirA }),
    })
  ).json();
  assert.equal(ws.dir, path.resolve(dirA));

  // Re-root onto a second real dir → the change sticks.
  const patched = await authed(`/workspaces/${ws.id}`, {
    method: 'PATCH',
    body: JSON.stringify({ dir: dirB }),
  });
  assert.equal(patched.status, 200);
  const after = (await (await authed('/workspaces')).json()).find((w) => w.id === ws.id);
  assert.equal(after.dir, path.resolve(dirB));

  // A path that isn't a real directory is refused (dir unchanged).
  const bad = await authed(`/workspaces/${ws.id}`, {
    method: 'PATCH',
    body: JSON.stringify({ dir: path.join(tmp, 'does-not-exist') }),
  });
  assert.equal(bad.status, 400);
  const still = (await (await authed('/workspaces')).json()).find((w) => w.id === ws.id);
  assert.equal(still.dir, path.resolve(dirB));
});

test('PATCH workspace port sets then clears', async () => {
  const dir = mkdir(path.join(tmp, 'ported'));
  const ws = await (
    await authed('/workspaces', {
      method: 'POST',
      body: JSON.stringify({ name: 'ported', dir }),
    })
  ).json();
  assert.equal(ws.port, undefined); // created without a port

  const set = await authed(`/workspaces/${ws.id}`, {
    method: 'PATCH',
    body: JSON.stringify({ port: 4321 }),
  });
  assert.equal(set.status, 200);
  assert.equal((await set.json()).port, 4321);

  const cleared = await authed(`/workspaces/${ws.id}`, {
    method: 'PATCH',
    body: JSON.stringify({ port: null }),
  });
  assert.equal(cleared.status, 200);
  assert.equal((await cleared.json()).port, undefined);
});

// Public share links. The happy path needs a real cloudflared + real internet,
// so it lives outside CI (see docs/GOTCHAS.md); what IS covered here is every
// refusal, because those are the security-critical half — a share link is
// unauthenticated, so the port guard is the thing that must never regress.
test('share links: refuses Helm’s own port, an unset port, and unknown workspaces', async () => {
  const dir = mkdir(path.join(tmp, 'shared'));
  const ws = await (
    await authed('/workspaces', {
      method: 'POST',
      body: JSON.stringify({ name: 'shared', dir }),
    })
  ).json();

  // No port configured yet → refuse with an actionable message, not a crash.
  const noPort = await authed(`/workspaces/${ws.id}/tunnel`, { method: 'POST' });
  assert.equal(noPort.status, 400);
  assert.match((await noPort.json()).error, /port/i);

  // THE load-bearing guard: Helm serves its own token in index.html, so a
  // public link to its port would hand out a terminal on this machine.
  // Enforced server-side, so a UI bug or a direct curl can't get past it.
  const helmPort = await authed(`/workspaces/${ws.id}/tunnel`, {
    method: 'POST',
    body: JSON.stringify({ port: PORT }),
  });
  assert.equal(helmPort.status, 400);
  assert.equal((await helmPort.json()).code, 'BLOCKED_PORT');

  // Out-of-range ports are rejected before cloudflared is ever consulted.
  const badPort = await authed(`/workspaces/${ws.id}/tunnel`, {
    method: 'POST',
    body: JSON.stringify({ port: 99999 }),
  });
  assert.equal(badPort.status, 400);

  const noSuchWs = await authed('/workspaces/nope/tunnel', {
    method: 'POST',
    body: JSON.stringify({ port: 4321 }),
  });
  assert.equal(noSuchWs.status, 404);

  // Stopping / extending something that isn't shared is a clean 404.
  assert.equal((await authed(`/workspaces/${ws.id}/tunnel`, { method: 'DELETE' })).status, 404);
  assert.equal(
    (await authed(`/workspaces/${ws.id}/tunnel/extend`, { method: 'POST' })).status,
    404,
  );
});

test('share links: /api/tunnels reports cloudflared availability and an install hint', async () => {
  const res = await authed('/tunnels');
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.available, true); // the stand-in answers --version
  assert.match(body.version, /cloudflared version/);
  assert.ok(body.installHint.length > 0); // shown instead of a share button when absent
  assert.equal(body.ttlMs, 30 * 60 * 1000); // links self-expire — don't silently lengthen this
});

// The full lifecycle against the cloudflared stand-in: spawn, scrape the URL
// out of its banner, expose it, extend the deadline, then tear it down. Proves
// everything except that Cloudflare's edge really serves the URL — that needs
// the real binary and is deliberately out of CI.
test('share links: start → live URL → extend → stop', async () => {
  const dir = mkdir(path.join(tmp, 'tunnelled'));
  const ws = await (
    await authed('/workspaces', {
      method: 'POST',
      body: JSON.stringify({ name: 'tunnelled', dir, port: 5173 }),
    })
  ).json();

  const started = await authed(`/workspaces/${ws.id}/tunnel`, { method: 'POST' });
  assert.equal(started.status, 201);
  const tunnel = await started.json();
  assert.equal(tunnel.status, 'live');
  assert.match(tunnel.url, /^https:\/\/fake-[0-9a-f]+\.trycloudflare\.com$/);
  assert.equal(tunnel.port, 5173);
  // Expiry is set at creation, not bolted on later — a link can never exist
  // without a deadline. (Armed a few ms after startedAt is captured.)
  const ttl = tunnel.expiresAt - tunnel.startedAt;
  assert.ok(ttl >= 30 * 60 * 1000 && ttl < 31 * 60 * 1000, `ttl was ${ttl}ms`);
  // The process handle must never leak through the API.
  assert.equal(tunnel.proc, undefined);

  // It shows up in the list the sidebar/toolbar poll.
  const listed = (await (await authed('/tunnels')).json()).tunnels;
  assert.equal(listed.length, 1);
  assert.equal(listed[0].workspaceId, ws.id);

  // Sharing the same project twice is refused rather than orphaning a process.
  const again = await authed(`/workspaces/${ws.id}/tunnel`, { method: 'POST' });
  assert.equal(again.status, 409);

  // Extend pushes the deadline out.
  const extended = await (
    await authed(`/workspaces/${ws.id}/tunnel/extend`, { method: 'POST' })
  ).json();
  assert.ok(extended.expiresAt > tunnel.expiresAt);

  // Stop takes it down and removes it from the list.
  assert.equal((await authed(`/workspaces/${ws.id}/tunnel`, { method: 'DELETE' })).status, 200);
  assert.deepEqual((await (await authed('/tunnels')).json()).tunnels, []);
});

test('share links: removing a workspace takes its public link down with it', async () => {
  const dir = mkdir(path.join(tmp, 'tunnel-doomed'));
  const ws = await (
    await authed('/workspaces', {
      method: 'POST',
      body: JSON.stringify({ name: 'doomed', dir, port: 5174 }),
    })
  ).json();
  assert.equal((await authed(`/workspaces/${ws.id}/tunnel`, { method: 'POST' })).status, 201);
  assert.equal((await (await authed('/tunnels')).json()).tunnels.length, 1);

  assert.equal((await authed(`/workspaces/${ws.id}`, { method: 'DELETE' })).status, 200);
  // A public link pointing at a project you just removed would be the worst
  // kind of leftover — it must die with the workspace.
  assert.deepEqual((await (await authed('/tunnels')).json()).tunnels, []);
});

test('share links: the installer route refuses when cloudflared is already there', async () => {
  // The stand-in answers --version, so this suite always looks "installed".
  const res = await authed('/tunnels/install', { method: 'POST' });
  assert.equal(res.status, 409);
  assert.match((await res.json()).error, /already installed/);
  // And the command Helm would run is exposed for the UI to show verbatim,
  // so the owner can read it before agreeing to it.
  const body = await (await authed('/tunnels')).json();
  if (process.platform === 'win32') {
    assert.ok(
      body.installCommand.startsWith('winget install --id Cloudflare.cloudflared '),
      body.installCommand,
    );
  }
  assert.ok(body.installDocs.startsWith('https://developers.cloudflare.com/'), body.installDocs);
});

// Regression guards for the two bugs that made the installed-but-invisible
// loop possible (2026-08-26, both hit for real by the owner).
test('share links: install command is a real, runnable executable path', async () => {
  const { installCommand } = await (await authed('/tunnels')).json();
  if (process.platform !== 'win32') {
    assert.equal(installCommand, 'brew install cloudflared');
    return;
  }
  // BUG 1 was a bare `winget`, which is an App Execution Alias: it does NOT
  // resolve for spawned children, so the install pane died instantly (exit 1).
  // The alias file is a SYMLINK whose target isn't normally resolvable, so
  // existsSync() reports false for a file that runs fine — lstat is the check.
  const quoted = /^"([^"]+winget\.exe)"/.exec(installCommand);
  if (quoted) {
    const st = fs.lstatSync(quoted[1]); // throws if we pointed at nothing
    assert.ok(st.size >= 0);
    // and it must actually run the way a pane runs it (through cmd.exe)
    const out = execFileSync(process.env.ComSpec || 'cmd.exe', [
      '/d',
      '/s',
      '/c',
      `"${quoted[1]}" --version`,
    ]);
    assert.match(out.toString(), /^v?\d+\./m);
  } else {
    assert.equal(installCommand.startsWith('winget install '), true);
  }
});

test('share links: cloudflared is found by absolute path, not just PATH', async () => {
  // BUG 2: winget installs cloudflared into Program Files and adds it to the
  // MACHINE PATH — but a running process keeps the PATH it was spawned with,
  // so the long-lived server stayed blind to it and re-prompted forever.
  // Detection must therefore probe known install dirs too. Proven here by
  // handing the resolver a candidate list with NO PATH entry in it.
  const mod = await import('../src/tunnel.mjs');
  const probe = path.join(testDir, IS_WIN ? 'fake-cloudflared.cmd' : 'fake-cloudflared.sh');
  const prev = process.env.HELM_CLOUDFLARED_CMD;
  process.env.HELM_CLOUDFLARED_CMD = probe; // an absolute path, never on PATH
  try {
    const r = await mod.checkCloudflared();
    assert.equal(r.available, true);
    assert.equal(r.path, probe); // the resolved absolute path is what gets spawned
  } finally {
    if (prev === undefined) delete process.env.HELM_CLOUDFLARED_CMD;
    else process.env.HELM_CLOUDFLARED_CMD = prev;
  }
});

test('dev pane: start / stop / restart a project, keeping the pane', async () => {
  const dir = mkdir(path.join(tmp, 'devproj'));
  const ws = await (
    await authed('/workspaces', { method: 'POST', body: JSON.stringify({ name: 'devproj', dir }) })
  ).json();

  // No start command and no package.json to guess from → a clear 400, not a spawn.
  const noCmd = await authed(`/workspaces/${ws.id}/start`, { method: 'POST' });
  assert.equal(noCmd.status, 400);

  // A keep-alive stand-in for a dev server (no npm, no network).
  const command = 'node -e "setInterval(() => {}, 1000)"';
  const set = await authed(`/workspaces/${ws.id}`, {
    method: 'PATCH',
    body: JSON.stringify({ startCommands: [command] }),
  });
  assert.equal(set.status, 200);
  assert.deepEqual((await set.json()).startCommands, [command]);

  const started = await authed(`/workspaces/${ws.id}/start`, { method: 'POST' });
  assert.equal(started.status, 201);
  const dev = (await started.json()).sessions[0];
  assert.equal(dev.kind, 'dev');
  assert.equal(dev.command, command);
  assert.equal(dev.status, 'running');
  assert.equal(dev.profile, null); // dev panes carry no claude account

  // One pane per command — a second start while it runs is refused.
  assert.equal((await authed(`/workspaces/${ws.id}/start`, { method: 'POST' })).status, 409);

  // Stop keeps the pane (so its output stays readable) — only the process dies.
  assert.equal((await authed(`/sessions/${dev.id}/stop`, { method: 'POST' })).status, 200);
  let after = null;
  for (let i = 0; i < 40 && after?.status !== 'exited'; i++) {
    await sleep(100);
    after = (await (await authed('/sessions')).json()).find((x) => x.id === dev.id);
  }
  assert.equal(after?.status, 'exited');
  assert.equal((await authed(`/sessions/${dev.id}/stop`, { method: 'POST' })).status, 409);

  // ▶ again reuses the same pane rather than piling up a second one.
  const restarted = await authed(`/workspaces/${ws.id}/start`, { method: 'POST' });
  assert.equal(restarted.status, 201);
  const again = (await restarted.json()).sessions[0];
  assert.equal(again.id, dev.id);
  assert.equal(again.status, 'running');
  const devPanes = (await (await authed('/sessions')).json()).filter(
    (x) => x.kind === 'dev' && x.workspace === path.resolve(dir),
  );
  assert.equal(devPanes.length, 1);

  // A dev pane is not a claude pane: no account to switch, never a broadcast target.
  assert.equal(
    (
      await authed(`/sessions/${dev.id}/switch-profile`, {
        method: 'POST',
        body: JSON.stringify({ profile: 'nope' }),
      })
    ).status,
    400,
  );
  const bc = await (
    await authed('/broadcast', {
      method: 'POST',
      body: JSON.stringify({ text: 'hello', sessionIds: [dev.id] }),
    })
  ).json();
  assert.equal(bc.results[dev.id], 'skipped');

  await authed(`/sessions/${dev.id}`, { method: 'DELETE' });
});

test('dev pane: start command is auto-detected from package.json once', async () => {
  const dir = mkdir(path.join(tmp, 'detectproj'));
  fs.writeFileSync(
    path.join(dir, 'package.json'),
    JSON.stringify({ name: 'detectproj', scripts: { build: 'x', dev: 'x', start: 'x' } }),
  );
  const ws = await (
    await authed('/workspaces', {
      method: 'POST',
      body: JSON.stringify({ name: 'detectproj', dir }),
    })
  ).json();
  assert.equal(ws.startCommands, undefined);

  // 'dev' wins over 'start'; the guess is saved so it's editable afterwards.
  const started = await authed(`/workspaces/${ws.id}/start`, { method: 'POST' });
  assert.equal(started.status, 201);
  const dev = (await started.json()).sessions[0];
  assert.equal(dev.command, 'npm run dev');
  const saved = (await (await authed('/workspaces')).json()).find((w) => w.id === ws.id);
  assert.deepEqual(saved.startCommands, ['npm run dev']);

  await authed(`/sessions/${dev.id}`, { method: 'DELETE' });
  // Clearing it puts the workspace back to "no command set".
  await authed(`/workspaces/${ws.id}`, {
    method: 'PATCH',
    body: JSON.stringify({ startCommands: null }),
  });
  const cleared = (await (await authed('/workspaces')).json()).find((w) => w.id === ws.id);
  assert.equal(cleared.startCommands, undefined);
});

test('dev panes: a project with several start commands runs one pane each', async () => {
  const dir = mkdir(path.join(tmp, 'multiproj'));
  const ws = await (
    await authed('/workspaces', {
      method: 'POST',
      body: JSON.stringify({ name: 'multiproj', dir }),
    })
  ).json();

  // Two keep-alive stand-ins, given as one string (the editor's one-per-line
  // shape) to prove that path parses too.
  const a = 'node -e "setInterval(() => {}, 1000) /* api */"';
  const b = 'node -e "setInterval(() => {}, 1000) /* web */"';
  const set = await authed(`/workspaces/${ws.id}`, {
    method: 'PATCH',
    body: JSON.stringify({ startCommands: [a, b].join('\n') }),
  });
  assert.equal(set.status, 200);
  assert.deepEqual((await set.json()).startCommands, [a, b]);

  const started = await authed(`/workspaces/${ws.id}/start`, { method: 'POST' });
  assert.equal(started.status, 201);
  const body = await started.json();
  assert.equal(body.started, 2);
  assert.deepEqual(body.sessions.map((x) => x.command).sort(), [a, b].sort());
  assert.ok(body.sessions.every((x) => x.status === 'running'));

  // One workspace-level stop takes them all down; the panes survive it.
  const stopped = await authed(`/workspaces/${ws.id}/stop`, { method: 'POST' });
  assert.equal(stopped.status, 200);
  assert.equal((await stopped.json()).stopped, 2);
  let panes = [];
  for (let i = 0; i < 40; i++) {
    await sleep(100);
    panes = (await (await authed('/sessions')).json()).filter(
      (x) => x.kind === 'dev' && x.workspace === path.resolve(dir),
    );
    if (panes.every((x) => x.status === 'exited')) break;
  }
  assert.equal(panes.length, 2);
  assert.ok(panes.every((x) => x.status === 'exited'));
  assert.equal((await authed(`/workspaces/${ws.id}/stop`, { method: 'POST' })).status, 409);

  // ▶ again revives both in place — still two panes, not four.
  assert.equal((await authed(`/workspaces/${ws.id}/start`, { method: 'POST' })).status, 201);
  const after = (await (await authed('/sessions')).json()).filter(
    (x) => x.kind === 'dev' && x.workspace === path.resolve(dir),
  );
  assert.equal(after.length, 2);
  assert.ok(after.every((x) => x.status === 'running'));

  // Too many commands, or one that is far too long, are refused.
  assert.equal(
    (
      await authed(`/workspaces/${ws.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ startCommands: Array(7).fill('node -e ""') }),
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await authed(`/workspaces/${ws.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ startCommands: ['x'.repeat(501)] }),
      })
    ).status,
    400,
  );

  for (const pane of after) await authed(`/sessions/${pane.id}`, { method: 'DELETE' });
});

test('suggest-start: claude is asked how a project starts, and only suggests', async () => {
  const dir = mkdir(path.join(tmp, 'suggestproj'));
  const ws = await (
    await authed('/workspaces', {
      method: 'POST',
      body: JSON.stringify({ name: 'suggestproj', dir }),
    })
  ).json();

  const r = await authed(`/workspaces/${ws.id}/suggest-start`, { method: 'POST' });
  assert.equal(r.status, 200);
  const body = await r.json();
  // The stand-in only answers with commands when the PROMPT reached it on
  // stdin — which is the contract that keeps prompt text off the command line.
  assert.deepEqual(body.commands, ['cd api && npm start', 'cd web && npm run watch']);
  assert.equal(body.cost, 0.0123); // cost read off claude's own envelope

  // A suggestion is only a suggestion: nothing saved, nothing spawned.
  const after = (await (await authed('/workspaces')).json()).find((w) => w.id === ws.id);
  assert.equal(after.startCommands, undefined);
  const panes = (await (await authed('/sessions')).json()).filter(
    (x) => x.kind === 'dev' && x.workspace === path.resolve(dir),
  );
  assert.equal(panes.length, 0);

  assert.equal((await authed('/workspaces/nope/suggest-start', { method: 'POST' })).status, 404);
});

test('GET/POST /api/console reports shape and (Windows) toggles visibility', async (t) => {
  const q = await authed('/console');
  assert.equal(q.status, 200);
  const state = await q.json();
  assert.equal(typeof state.supported, 'boolean');
  assert.equal(typeof state.visible, 'boolean');

  if (!state.supported) {
    t.skip('console control unsupported off-Windows / detached');
    return;
  }

  // Non-boolean body is rejected.
  const bad = await authed('/console', {
    method: 'POST',
    body: JSON.stringify({ visible: 'yes' }),
  });
  assert.equal(bad.status, 400);

  // Hide then show — the returned `visible` tracks the request. Ends visible so
  // the developer's server console is left restored.
  const hidden = await (
    await authed('/console', { method: 'POST', body: JSON.stringify({ visible: false }) })
  ).json();
  assert.equal(hidden.visible, false);
  const shown = await (
    await authed('/console', { method: 'POST', body: JSON.stringify({ visible: true }) })
  ).json();
  assert.equal(shown.visible, true);
});

test('deleting a profile clears its workspace pins', async () => {
  mkdir(path.join(helmDir, 'accounts', 'acct1')); // pretend a profile exists
  const dir = mkdir(path.join(tmp, 'pinned'));
  const ws = await (
    await authed('/workspaces', {
      method: 'POST',
      body: JSON.stringify({ name: 'pinned', dir, profile: 'acct1' }),
    })
  ).json();
  assert.equal(ws.profile, 'acct1');

  const del = await authed('/profiles/acct1', { method: 'DELETE' });
  assert.equal(del.status, 200);

  const after = (await (await authed('/workspaces')).json()).find((w) => w.id === ws.id);
  assert.equal(after.profile, undefined); // pin gone, not dangling
});
