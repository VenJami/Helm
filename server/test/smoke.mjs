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
const repoRoot = path.join(serverDir, '..'); // the clone the commit check asks git about
// Isolated HOME so the server's data dir (~/.helm or %LOCALAPPDATA%\Helm) lands
// in a temp folder we own — never the developer's real Helm store.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'helm-smoke-'));
const helmDir = IS_WIN ? path.join(tmp, 'Helm') : path.join(tmp, '.helm');
const wrapper = path.join(testDir, IS_WIN ? 'fake-claude.cmd' : 'fake-claude.sh');
// Stand-in for cloudflared, so share links can be driven without the real
// binary or any network (see fake-cloudflared.mjs).
const cfWrapper = path.join(testDir, IS_WIN ? 'fake-cloudflared.cmd' : 'fake-cloudflared.sh');

let child;
// Stand-in for the GitHub releases + compare APIs, so both halves of the
// update check are driven end-to-end without a network (HELM_UPDATE_URL and
// HELM_COMPARE_URL point the server at it).
let ghStub;
let ghUrl = '';
let ghCompareUrl = '';
// What /compare/... answers next. Tests reassign this to walk the cases where
// the commit check must stay SILENT. 404 = "GitHub never saw that commit".
let ghCompare = {
  status: 'ahead',
  ahead_by: 3,
  behind_by: 0,
  html_url: 'https://example.invalid/compare/abc...main',
  commits: [
    { commit: { message: 'Older thing', committer: { date: '2026-08-27T00:00:00Z' } } },
    {
      commit: {
        message: 'Newest thing\n\nbody text',
        committer: { date: '2026-08-28T00:00:00Z' },
      },
    },
  ],
};
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
    HELM_FAKE_CF_PIDDIR: tmp, // the stand-in drops its real pid here
    HELM_USAGE_TTL_MS: '0', // usage tests append + immediately re-poll
    HELM_APPROVAL_HOLD_MS: '1500', // approval tests wait out the fallback
    HELM_UPDATE_URL: ghUrl, // fake "latest release" endpoint (see ghStub)
    HELM_COMPARE_URL: ghCompareUrl, // fake branch-compare endpoint (same stub)
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
  ghStub = http.createServer((req, res) => {
    if (req.url.startsWith('/compare/')) {
      if (ghCompare === 404) {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end('{}');
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(ghCompare));
      return;
    }
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
  ghCompareUrl = `http://127.0.0.1:${ghStub.address().port}/compare`;
  // The in-process import below reads these at module load, so set them before
  // any test touches update.mjs.
  process.env.HELM_UPDATE_URL = ghUrl;
  process.env.HELM_COMPARE_URL = ghCompareUrl;
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
  await sleep(300);
  // Windows holds a directory busy while a just-killed process still has a
  // handle on it, so a single rmSync can lose the race (EBUSY on a CI runner).
  // Retry a few times, then let it go: a leftover temp dir is the OS's problem,
  // and failing the suite on cleanup would report a green run as broken.
  for (let i = 0; i < 6; i++) {
    try {
      fs.rmSync(tmp, { recursive: true, force: true });
      return;
    } catch {
      await sleep(400);
    }
  }
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

test('update check also reports unreleased commits on main', async () => {
  // The commit half needs a git checkout to know where this copy stands. In a
  // tarball download there is nothing to compare, and the documented behaviour
  // is silence — so assert whichever rule applies to the tree we're run from.
  const isGitCheckout = (() => {
    try {
      execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, stdio: 'ignore' });
      return true;
    } catch {
      return false;
    }
  })();
  const info = await (await authed('/update')).json();
  if (!isGitCheckout) {
    assert.equal(info.commits, null, 'not a git checkout: the commit line stays silent');
    return;
  }
  assert.ok(info.commits, 'a git checkout behind main should report commits');
  assert.equal(info.commits.ahead, 3);
  assert.equal(info.commits.url, 'https://example.invalid/compare/abc...main');
  assert.equal(info.commits.latest, 'Newest thing'); // subject only, body dropped
  assert.equal(info.commits.latestAt, '2026-08-28T00:00:00Z');
});

test('commit check stays silent on every ambiguous answer', async (t) => {
  const { checkCommits } = await import('../src/update.mjs');
  if ((await checkCommits()) === null) {
    t.skip('not a git checkout — the silent path is already covered above');
    return;
  }
  const previous = ghCompare;
  try {
    // Level with main.
    ghCompare = { status: 'identical', ahead_by: 0, behind_by: 0, commits: [] };
    assert.equal(await checkCommits(), null, 'identical: nothing to say');
    // This copy carries its own commits — a developer, not someone to nag.
    ghCompare = { status: 'behind', ahead_by: 0, behind_by: 2, commits: [] };
    assert.equal(await checkCommits(), null, 'behind: we are ahead of main');
    ghCompare = { status: 'diverged', ahead_by: 4, behind_by: 2, commits: [] };
    assert.equal(await checkCommits(), null, 'diverged: both sides moved');
    // Ahead but with a zero count: contradictory, so say nothing.
    ghCompare = { status: 'ahead', ahead_by: 0, behind_by: 0, commits: [] };
    assert.equal(await checkCommits(), null, 'ahead_by 0: no news');
    // GitHub has never seen this commit (local build, unpushed branch, fork).
    ghCompare = 404;
    assert.equal(await checkCommits(), null, '404: the commit is not on GitHub');
    // And it recovers once main is plainly ahead again.
    ghCompare = previous;
    const back = await checkCommits();
    assert.equal(back?.ahead, 3, 'a clean "ahead" is reported again');
  } finally {
    ghCompare = previous;
  }
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

// ------------------------------------------------------- approvals (HUD)
// Same real relay, but capturing STDOUT: for PermissionRequest the script's
// stdout IS the contract with claude, so asserting the JSON it prints is the
// only test that proves Approve/Deny actually works.
const relayOut = (sessionId, event) =>
  new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(serverDir, 'hook-post.mjs')], {
      env: {
        ...process.env,
        HELM_SESSION_ID: sessionId,
        HELM_HOOK_TOKEN: HOOK_TOKEN,
        HELM_PORT: String(PORT),
      },
      stdio: ['pipe', 'pipe', 'ignore'],
    });
    let out = '';
    child.stdout.on('data', (d) => {
      out += d;
    });
    child.on('exit', (code) => resolve({ code, out }));
    child.on('error', reject);
    child.stdin.end(JSON.stringify(event));
  });

// The REAL claude 2.1.260 payload: tool_name + tool_input, and NO tool_use_id
// (the docs describe one; the CLI does not send it — verified against the real
// binary, see docs/CLAUDE_INTERNALS.md). Helm mints its own request id, so the
// tests address a held request exactly as the HUD does: by reading `pendingId`
// off the session.
const permissionEvent = () => ({
  hook_event_name: 'PermissionRequest',
  tool_name: 'Bash',
  tool_input: { command: 'npm run db:migrate', description: 'Apply migrations' },
});

const newPane = async (name) => {
  const wsDir = mkdir(path.join(tmp, name));
  const res = await authed('/sessions', {
    method: 'POST',
    body: JSON.stringify({ workspace: wsDir }),
  });
  return (await res.json()).id;
};

// Wait for the session poll to show a held request (the HUD's own latency).
async function waitForPending(id) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const list = await (await authed('/sessions')).json();
    const s = list.find((x) => x.id === id);
    if (s && s.pendingId) return s;
    await sleep(50);
  }
  return null;
}

test('approvals stay disarmed until the HUD is open', async () => {
  const id = await newPane('approveproj');

  // No HUD heartbeat: the hook must come back at once with NO stdout, which is
  // what makes claude fall through to its own prompt exactly as before.
  const started = Date.now();
  const { code, out } = await relayOut(id, permissionEvent());
  assert.equal(code, 0);
  assert.equal(out, '', 'a disarmed Helm must print no decision');
  assert.ok(Date.now() - started < 2000, 'a disarmed answer must not hold the pane');
  const s = (await (await authed('/sessions')).json()).find((x) => x.id === id);
  assert.equal(s.pendingId, null, 'nothing is pending when nobody is watching');

  await authed(`/sessions/${id}`, { method: 'DELETE' });
});

test('approvals: the HUD heartbeat arms Approve and Deny', async () => {
  const id = await newPane('approveproj2');

  for (const decision of ['allow', 'deny']) {
    await authed('/hud/ping', { method: 'POST' });
    const pending = relayOut(id, permissionEvent()); // held open — do NOT await yet

    const s = await waitForPending(id);
    assert.ok(s, `the ${decision} request should surface on the session`);
    assert.equal(s.pendingTool, 'Bash');
    assert.equal(s.pendingDetail, 'Bash: npm run db:migrate', 'the row must say what it asks');
    assert.equal(s.activity, 'waiting', 'a held request lights the badge');

    const res = await authed(`/sessions/${id}/approve`, {
      method: 'POST',
      body: JSON.stringify({ requestId: s.pendingId, decision }),
    });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).pendingId, null, 'answering clears the row');

    // This assertion IS the contract with claude: `decision` is an OBJECT
    // keyed by `behavior`, and there must be no top-level `decision` (the
    // legacy approve|block field — including it fails claude's schema
    // validation and voids the whole reply). Verified against the real CLI;
    // see docs/CLAUDE_INTERNALS.md.
    const { code, out } = await pending;
    assert.equal(code, 0);
    const printed = JSON.parse(out);
    assert.equal(printed.decision, undefined, 'a top-level decision voids the reply');
    assert.equal(printed.hookSpecificOutput.hookEventName, 'PermissionRequest');
    assert.deepEqual(
      printed.hookSpecificOutput.decision,
      decision === 'allow'
        ? { behavior: 'allow' }
        : { behavior: 'deny', message: 'denied from Helm' },
    );
  }

  await authed(`/sessions/${id}`, { method: 'DELETE' });
});

test('approvals: an unanswered request falls back to the pane prompt', async () => {
  const id = await newPane('approveproj3');
  await authed('/hud/ping', { method: 'POST' });
  // Grab the id the HUD would have shown, then let the hold lapse without
  // clicking (HELM_APPROVAL_HOLD_MS is 1.5 s under test).
  const pending = relayOut(id, permissionEvent());
  const held = await waitForPending(id);
  assert.ok(held?.pendingId, 'request should be held first');
  const { code, out } = await pending;
  assert.equal(code, 0);
  assert.equal(out, '', 'an unanswered request must print nothing, not a guess');
  const s = (await (await authed('/sessions')).json()).find((x) => x.id === id);
  assert.equal(s.pendingId, null, 'a lapsed request stops being shown as answerable');

  // And answering one that already lapsed is a 409, not a silent no-op — the
  // UI needs to be able to say "it is asking in the pane now".
  const late = await authed(`/sessions/${id}/approve`, {
    method: 'POST',
    body: JSON.stringify({ requestId: held.pendingId, decision: 'allow' }),
  });
  assert.equal(late.status, 409);

  await authed(`/sessions/${id}`, { method: 'DELETE' });
});

test('approvals: killing a pane releases the request it was holding', async () => {
  const id = await newPane('approveproj4');
  await authed('/hud/ping', { method: 'POST' });
  const pending = relayOut(id, permissionEvent());
  assert.ok(await waitForPending(id), 'request should be held');

  const started = Date.now();
  await authed(`/sessions/${id}`, { method: 'DELETE' });
  const { out } = await pending;
  assert.equal(out, '', 'a dead pane decides nothing');
  // The point of releasing on death: the response comes back immediately
  // instead of sitting out the full hold with nothing on the other end.
  assert.ok(Date.now() - started < 1200, 'the held response must be freed at once');
});

test('approvals: the route validates, and a shapeless payload raises drift', async () => {
  const id = await newPane('approveproj5');

  assert.equal(
    (
      await authed('/sessions/nope/approve', {
        method: 'POST',
        body: JSON.stringify({ requestId: 't', decision: 'allow' }),
      })
    ).status,
    404,
  );
  assert.equal(
    (
      await authed(`/sessions/${id}/approve`, {
        method: 'POST',
        body: JSON.stringify({ requestId: 't', decision: 'maybe' }),
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await authed(`/sessions/${id}/approve`, {
        method: 'POST',
        body: JSON.stringify({ decision: 'allow' }),
      })
    ).status,
    400,
  );

  // claude dropping tool_name would silently disable Approve/Deny (a row with
  // nothing to show) — that has to surface in the drift banner, not just stop.
  await authed('/hud/ping', { method: 'POST' });
  const { out } = await relayOut(id, { hook_event_name: 'PermissionRequest' });
  assert.equal(out, '');
  const diag = await (await authed('/diagnostics')).json();
  assert.ok(
    diag.warnings.some((w) => w.key === 'permissionrequest-shape'),
    'a shapeless PermissionRequest must raise a drift warning',
  );

  await authed(`/sessions/${id}`, { method: 'DELETE' });
});

test('workspace: notch mute round-trips and is validated', async () => {
  const dir = mkdir(path.join(tmp, 'muteproj'));
  const ws = await (
    await authed('/workspaces', { method: 'POST', body: JSON.stringify({ name: 'mute', dir }) })
  ).json();
  assert.equal(ws.notch, undefined, 'showing in the notch is the default and stores nothing');

  const muted = await authed(`/workspaces/${ws.id}`, {
    method: 'PATCH',
    body: JSON.stringify({ notch: false }),
  });
  assert.equal(muted.status, 200);
  assert.equal((await muted.json()).notch, false);

  // Un-muting DELETES the field rather than storing true: absent means yes, so
  // existing workspaces need no migration.
  const back = await authed(`/workspaces/${ws.id}`, {
    method: 'PATCH',
    body: JSON.stringify({ notch: true }),
  });
  assert.equal((await back.json()).notch, undefined);

  const bad = await authed(`/workspaces/${ws.id}`, {
    method: 'PATCH',
    body: JSON.stringify({ notch: 'no' }),
  });
  assert.equal(bad.status, 400);

  await authed(`/workspaces/${ws.id}`, { method: 'DELETE' });
});

test('notch: reports whether this machine can open one, and refuses when it cannot', async () => {
  // Windows-only and built separately, so /api/notch is the UI's way to decide
  // whether to offer the entry at all rather than dangle one that cannot work.
  const state = await (await authed('/notch')).json();
  assert.equal(typeof state.supported, 'boolean');
  assert.equal(typeof state.running, 'boolean');

  if (!state.supported) {
    // The interesting half for CI: refuse with a reason, never 500.
    const res = await authed('/notch', { method: 'POST' });
    assert.equal(res.status, 400);
    assert.match((await res.json()).error, /notch/i);
  }

  const anon = await fetch(U('/api/notch'));
  assert.equal(anon.status, 401, 'launching a window is not a public capability');
});

test('settings: the notch toggle round-trips and is validated', async () => {
  // Server state rather than localStorage on purpose: the native notch runs in
  // its own WebView2 profile and shares no storage with the browser, so this
  // route is the only way the toggle can reach it.
  const initial = await (await authed('/settings')).json();
  assert.equal(initial.notchAutoCompact, true, 'resting compact is the default');
  assert.equal(
    'notchFollowsHelm' in initial,
    false,
    'hiding while Helm is up is no longer a setting - the host always does it',
  );

  const off = await authed('/settings', {
    method: 'PATCH',
    body: JSON.stringify({ notchAutoCompact: false }),
  });
  assert.equal(off.status, 200);
  assert.equal((await off.json()).notchAutoCompact, false);
  assert.equal((await (await authed('/settings')).json()).notchAutoCompact, false, 'and it sticks');

  // Untouched by a patch that does not mention it.
  await authed('/settings', { method: 'PATCH', body: JSON.stringify({ autoRevive: false }) });
  assert.equal((await (await authed('/settings')).json()).notchAutoCompact, false);

  const bad = await authed('/settings', {
    method: 'PATCH',
    body: JSON.stringify({ notchAutoCompact: 1 }),
  });
  assert.equal(bad.status, 400, 'a non-boolean is refused, not coerced');

  // The retired toggle is ignored rather than stored or refused: an older UI
  // or a stale settings.json must not break the route.
  const stale = await authed('/settings', {
    method: 'PATCH',
    body: JSON.stringify({ notchFollowsHelm: false, notchAutoCompact: true }),
  });
  assert.equal(stale.status, 200);
  const after = await stale.json();
  assert.equal(after.notchAutoCompact, true);
  assert.equal('notchFollowsHelm' in after, false, 'a retired key never comes back');
});

// ---- cross-window focus requests ------------------------------------------
// The HUD can run as its own page (/hud) in a window that is not a child of
// the app's, so "jump to that pane" has to travel through the server. A long
// poll rather than the 3 s session tick, because a click that takes seconds to
// move the app reads as broken.

test('focus: the HUD page is served with the token injected', async () => {
  const res = await fetch(U('/hud'));
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.match(html, /<div id="root">/, 'the HUD page must render a root to mount into');
  assert.ok(!html.includes('%%HELM_TOKEN%%'), 'the placeholder must be substituted, not served');
  assert.ok(html.includes(TOKEN), 'the page carries the real token, like index.html');
});

test('focus: the route validates, and stays behind the token', async () => {
  const anon = await fetch(U('/api/focus'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sessionId: 'whatever' }),
  });
  assert.equal(anon.status, 401, 'moving the user’s window is not a public capability');

  assert.equal((await authed('/focus', { method: 'POST', body: '{}' })).status, 400);
  const missing = await authed('/focus', {
    method: 'POST',
    body: JSON.stringify({ sessionId: 'no-such-session' }),
  });
  assert.equal(missing.status, 404);
});

test('focus: a parked long poll is answered the moment a request lands', async () => {
  const id = await newPane('focusproj');
  // Park first, with a cursor in the future-proof sense: `since` = now, so any
  // stale request from an earlier test can't satisfy this wait.
  const since = Date.now();
  const parked = authed(`/focus/wait?since=${since}`).then((r) => r.json());
  await sleep(150); // let the server actually register the waiter

  const started = Date.now();
  const posted = await (
    await authed('/focus', {
      method: 'POST',
      body: JSON.stringify({ sessionId: id }),
    })
  ).json();
  assert.equal(posted.ok, true);

  const got = await parked;
  assert.equal(got.sessionId, id, 'the waiting window is told which pane to show');
  assert.ok(
    Date.now() - started < 2000,
    'the whole point is that it arrives on click, not on the next poll',
  );

  await authed(`/sessions/${id}`, { method: 'DELETE' });
});

test('focus: a request that lands between polls is not lost', async () => {
  const id = await newPane('focusproj2');
  // Nobody is waiting yet — this is the reconnect gap the `since` cursor
  // exists to cover.
  const before = Date.now() - 1;
  const posted = await (
    await authed('/focus', {
      method: 'POST',
      body: JSON.stringify({ sessionId: id }),
    })
  ).json();

  const caught = await (await authed(`/focus/wait?since=${before}`)).json();
  assert.equal(caught.sessionId, id, 'a request raised before the poll still gets delivered');
  assert.equal(caught.at, posted.at);

  // ...and asking again from AFTER it does not replay it.
  const since = posted.at;
  let replayed = null;
  // Left parked on purpose: it must NOT resolve. The catch keeps the suite's
  // teardown (which kills the server under it) from raising an unhandled
  // rejection out of a promise nothing awaits.
  const race = authed(`/focus/wait?since=${since}`)
    .then((r) => r.json())
    .then((r) => (replayed = r))
    .catch(() => {});
  await Promise.race([race, sleep(600)]);
  assert.equal(replayed, null, 'an already-handled request must not repeat forever');

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

test('share links: stopping one really kills the process, not just the shell', async () => {
  // Regression. `proc.kill()` killed only the shell a .cmd is run through, so
  // the actual tunnel survived every "stop" — Helm forgot about it while it kept
  // running. The suite leaked two of these per run for weeks before anyone
  // counted them. Asserts on the stand-in's OWN pid, which it writes out,
  // because the pid Helm holds is the shim's.
  const dir = mkdir(path.join(tmp, 'tunnel-kill'));
  const port = 5199;
  const pidFile = path.join(tmp, `cf-${port}.pid`);
  fs.rmSync(pidFile, { force: true });
  const ws = await (
    await authed('/workspaces', {
      method: 'POST',
      body: JSON.stringify({ name: 'killme', dir, port }),
    })
  ).json();
  assert.equal((await authed(`/workspaces/${ws.id}/tunnel`, { method: 'POST' })).status, 201);

  for (let i = 0; i < 40 && !fs.existsSync(pidFile); i++) await sleep(100);
  assert.ok(fs.existsSync(pidFile), 'the stand-in should have reported its pid');
  const pid = Number(fs.readFileSync(pidFile, 'utf8').trim());
  // Signal 0 is an existence check: it throws ESRCH when nothing is there.
  assert.doesNotThrow(() => process.kill(pid, 0), 'it should be running before we stop it');

  assert.equal((await authed(`/workspaces/${ws.id}/tunnel`, { method: 'DELETE' })).status, 200);
  let alive = true;
  for (let i = 0; i < 40; i++) {
    await sleep(100);
    try {
      process.kill(pid, 0);
    } catch {
      alive = false;
      break;
    }
  }
  assert.equal(alive, false, 'the tunnel process itself must be gone, not just forgotten');
  await authed(`/workspaces/${ws.id}`, { method: 'DELETE' });
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

test('dictation: polish sanitizes the reply, /type lands it unsent', async () => {
  const dir = mkdir(path.join(tmp, 'dictate'));
  await authed('/workspaces', {
    method: 'POST',
    body: JSON.stringify({ name: 'dictate', dir }),
  });
  const session = await (
    await authed('/sessions', { method: 'POST', body: JSON.stringify({ workspace: dir }) })
  ).json();
  const id = session.id;

  // fake-claude answers with preamble + quotes, the messy shape a real model
  // returns; the server must hand back bare text, ready to type into a pane.
  const ok = await (
    await authed(`/sessions/${id}/polish`, {
      method: 'POST',
      body: JSON.stringify({ text: 'um, add a mic button to the pane header' }),
    })
  ).json();
  assert.equal(ok.polished, true);
  assert.equal(ok.text, 'add a mic button to the pane header');
  assert.equal(ok.cost, 0.0123);

  // A reply far longer than what was said = the model answered instead of
  // rewriting. The route falls back to the raw words rather than erroring:
  // dictation must never lose what you said.
  const raw = 'let me ramble about the login flow';
  const fell = await (
    await authed(`/sessions/${id}/polish`, { method: 'POST', body: JSON.stringify({ text: raw }) })
  ).json();
  assert.equal(fell.polished, false);
  assert.equal(fell.text, raw);

  // Empty and oversized transcripts are refused outright.
  for (const bad of ['', '   ', 'x'.repeat(4001)]) {
    const res = await authed(`/sessions/${id}/polish`, {
      method: 'POST',
      body: JSON.stringify({ text: bad }),
    });
    assert.equal(res.status, 400);
  }
  assert.equal(
    (
      await authed('/sessions/nope/polish', {
        method: 'POST',
        body: JSON.stringify({ text: 'hi' }),
      })
    ).status,
    404,
  );

  // /type writes to the PTY without submitting.
  const typed = await authed(`/sessions/${id}/type`, {
    method: 'POST',
    body: JSON.stringify({ text: 'add a mic button' }),
  });
  assert.equal(typed.status, 200);
  assert.equal(
    (await authed(`/sessions/${id}/type`, { method: 'POST', body: JSON.stringify({ text: '' }) }))
      .status,
    400,
  );

  await authed(`/sessions/${id}`, { method: 'DELETE' });
});

test('dictation: dev panes take no prompts', async () => {
  const dir = mkdir(path.join(tmp, 'devpane-voice'));
  await authed('/workspaces', {
    method: 'POST',
    body: JSON.stringify({
      name: 'devpane-voice',
      dir,
      startCommands: [process.execPath + ' -e "setInterval(()=>{},1e9)"'],
    }),
  });
  const wsRow = (await (await authed('/workspaces')).json()).find(
    (w) => w.name === 'devpane-voice',
  );
  await authed(`/workspaces/${wsRow.id}/start`, { method: 'POST' });
  const dev = (await (await authed('/sessions')).json()).find(
    (s) => s.kind === 'dev' && s.workspace === path.resolve(dir),
  );
  assert.ok(dev, 'dev pane started');

  // A dev pane runs a server, not a conversation — same refusal broadcast makes.
  const typed = await authed(`/sessions/${dev.id}/type`, {
    method: 'POST',
    body: JSON.stringify({ text: 'hello' }),
  });
  assert.equal(typed.status, 400);

  // Delete the pane, then WAIT for the process to actually be gone. On Windows
  // a live child holds a lock on its cwd, so a still-dying dev pane makes the
  // suite's temp-dir teardown fail with EBUSY — a file-level failure while
  // every subtest passes, which is a confusing way to learn this.
  await authed(`/sessions/${dev.id}`, { method: 'DELETE' });
  for (let i = 0; i < 40; i++) {
    const gone = !(await (await authed('/sessions')).json()).some((s) => s.id === dev.id);
    if (gone) break;
    await new Promise((r) => setTimeout(r, 50));
  }
  await new Promise((r) => setTimeout(r, 150)); // let Windows release the cwd handle
});

test('polish sanitizer: commentary wrapped around your words is stripped', async () => {
  const { cleanPolished } = await import('../src/claude.mjs');
  const said = 'can you make the thing do the other thing with the stuff in it';

  // Seen in the wild: the model refuses to rewrite, then quotes you back. The
  // essay is short enough to pass the length guard, so containment catches it.
  assert.equal(cleanPolished(`This is too vague to rewrite with confidence. ${said}`, said), said);
  // Whitespace/case differences must not defeat the containment check.
  assert.equal(cleanPolished(`Too vague.\n\n  ${said.toUpperCase()}  `, said), said);
  // A genuine rewrite that happens to be longer is NOT commentary.
  assert.equal(
    cleanPolished('Make the parser handle the trailing comma.', said),
    'Make the parser handle the trailing comma.',
  );
  // Unchanged output still passes through untouched.
  assert.equal(cleanPolished(said, said), said);
  // A very short transcript can't trip containment on a coincidence.
  assert.equal(cleanPolished('Fix the bug now.', 'fix the bug'), 'Fix the bug now.');
});

test('polish sanitizer: meta-commentary never reaches the pane', async () => {
  const { cleanPolished } = await import('../src/claude.mjs');
  const filler = 'um uh like you know so yeah um';

  // Both seen from the real model on a dictation with no actual instruction.
  // Short enough to pass the length guard, and sharing no text with the
  // transcript, so the containment check misses them too.
  assert.equal(
    cleanPolished(
      'The dictation contains only filler words and false starts with no actual ' +
        'instruction or content. I cannot rewrite this into a meaningful instruction.',
      filler,
    ),
    filler,
  );
  assert.equal(cleanPolished('(No instruction to rewrite.)', filler), filler);

  // But a speaker who USES those words gets them back — the guard only fires
  // when the phrasing is the model's, not theirs.
  const about = 'why did the polish say there was no instruction to rewrite';
  assert.equal(
    cleanPolished('Why did the polish say there was no instruction to rewrite?', about),
    'Why did the polish say there was no instruction to rewrite?',
  );

  // A normal rewrite mentioning nothing meta is untouched.
  assert.equal(
    cleanPolished('Add a retry to the update check.', 'um add a retry to the update check'),
    'Add a retry to the update check.',
  );
});

// ---- panes no project can show ------------------------------------------
// Two halves of one failure: the grid lists a workspace's panes by dir, so a
// pane whose project isn't in the list is invisible, unkillable from the UI,
// and respawned by auto-revive at every boot. Driven on SEPARATE servers with
// their own data dirs, because the behaviour under test happens at load and
// the suite's main server boots once.

// Boot an extra server on its own data dir. Returns a caller for its API and
// a stop(), or throws if it never came up. Retried across candidate ports for
// the same reason tryBoot is: Windows rejects scattered high ports with EACCES.
async function bootAside(dataDir, extraEnv = {}) {
  for (let i = 0; i < 5; i++) {
    const aside = await tryBootAside(dataDir, extraEnv, await freePort());
    if (aside) return aside;
    await sleep(100);
  }
  throw new Error('aside server did not come up on any candidate port');
}

async function tryBootAside(dataDir, extraEnv, port) {
  const env = {
    ...process.env,
    PORT: String(port),
    HELM_DATA_DIR: dataDir,
    HELM_CLAUDE_CMD: wrapper,
    HELM_NO_UPDATE_CHECK: '1', // nothing to say here, and it needn't reach the stub
    ...extraEnv,
  };
  delete env.CLAUDE_CONFIG_DIR;
  const proc = spawn(process.execPath, ['index.mjs'], {
    cwd: serverDir,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  proc.stdout.on('data', () => {}); // drain, so the child never blocks on a full pipe
  proc.stderr.on('data', () => {});
  const stop = () => proc.kill();
  const deadline = Date.now() + 12000;
  let token = '';
  while (Date.now() < deadline) {
    try {
      if (!token) token = fs.readFileSync(path.join(dataDir, 'token'), 'utf8').trim();
      const res = await fetch(`http://127.0.0.1:${port}/api/sessions`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.ok) {
        const call = (p, opts = {}) =>
          fetch(`http://127.0.0.1:${port}/api${p}`, {
            ...opts,
            headers: {
              Authorization: `Bearer ${token}`,
              'Content-Type': 'application/json',
              ...opts.headers,
            },
          });
        return { call, stop };
      }
    } catch {
      /* not up yet */
    }
    if (proc.exitCode !== null) break; // bind refused — try another port
    await sleep(150);
  }
  stop();
  return null;
}

// Seed a data dir with the state a server should find at boot.
function seedState(name, { workspaces, sessions }) {
  const dir = mkdir(path.join(tmp, name));
  if (workspaces) {
    fs.writeFileSync(path.join(dir, 'workspaces.json'), JSON.stringify({ version: 1, workspaces }));
  }
  if (sessions) {
    fs.writeFileSync(path.join(dir, 'sessions.json'), JSON.stringify({ version: 1, sessions }));
  }
  return dir;
}

const persistedSessions = (dataDir) => {
  try {
    return JSON.parse(fs.readFileSync(path.join(dataDir, 'sessions.json'), 'utf8')).sessions;
  } catch {
    return []; // never written = nothing persisted, which is the point
  }
};

test('one-shot install pane never outlives the server that ran it', async () => {
  // cloudflared must look ABSENT or the route refuses; the install command is
  // pinned to something harmless, since the real one is a winget install.
  const dir = seedState('oneshot', {});
  const aside = await bootAside(dir, {
    HELM_CLOUDFLARED_CMD: path.join(tmp, 'no-such-cloudflared'),
    HELM_INSTALL_CMD: `"${process.execPath}" --version`,
  });
  try {
    const res = await aside.call('/tunnels/install', { method: 'POST' });
    assert.equal(res.status, 201);
    const pane = await res.json();
    assert.equal(pane.name, 'install cloudflared');

    // It's a real pane while the server lives — that's the whole point of
    // installing in one (you watch it, and answer any elevation prompt).
    const live = await (await aside.call('/sessions')).json();
    assert.ok(live.some((s) => s.id === pane.id));

    // …but it belongs to no project, so it must not be written to disk. A dev
    // pane that has exited normally IS persisted, so this only passes if the
    // one-shot flag is doing its job.
    await sleep(1200); // let it exit and the exit-time persist run
    assert.deepEqual(
      persistedSessions(dir).filter((s) => s.name === 'install cloudflared'),
      [],
    );
  } finally {
    aside.stop();
  }
});

test('a pane whose project is gone is dropped at boot', async () => {
  const kept = mkdir(path.join(tmp, 'kept-project'));
  const gone = path.join(tmp, 'removed-project'); // never created, never listed
  const dir = seedState('sweep', {
    workspaces: [{ id: 'w1', name: 'Kept', dir: kept }],
    sessions: [
      { id: 'keep-me', name: 'Kept pane', workspace: kept, kind: 'claude' },
      { id: 'drop-me', name: 'Stranded pane', workspace: gone, kind: 'claude' },
      // The installer pane this fix stops creating — already stranded in the
      // state files of anyone who used the install button before it.
      {
        id: 'drop-installer',
        name: 'install cloudflared',
        workspace: os.homedir(),
        kind: 'dev',
        command: 'winget install --id Cloudflare.cloudflared',
      },
    ],
  });
  const aside = await bootAside(dir);
  try {
    const list = await (await aside.call('/sessions')).json();
    assert.deepEqual(
      list.map((s) => s.id),
      ['keep-me'],
    );
    // and the drop is permanent, not just hidden for this run
    assert.deepEqual(
      persistedSessions(dir).map((s) => s.id),
      ['keep-me'],
    );
  } finally {
    aside.stop();
  }
});

test('an empty workspace list never wipes panes', async () => {
  // "no projects yet" and "workspaces.json failed to load" look identical from
  // the sweep, so with nothing to compare against it must drop nothing.
  const dir = seedState('sweep-guard', {
    sessions: [{ id: 'survivor', name: 'Pane', workspace: tmp, kind: 'claude' }],
  });
  const aside = await bootAside(dir);
  try {
    const list = await (await aside.call('/sessions')).json();
    assert.deepEqual(
      list.map((s) => s.id),
      ['survivor'],
    );
  } finally {
    aside.stop();
  }
});

test('categories: CRUD, validation, and filing a pane into one', async () => {
  const ws = mkdir(path.join(tmp, 'catproj'));
  await authed('/workspaces', { method: 'POST', body: JSON.stringify({ name: 'cat', dir: ws }) });

  assert.deepEqual(await (await authed('/categories')).json(), [], 'none to begin with');

  const made = await authed('/categories', {
    method: 'POST',
    body: JSON.stringify({ name: 'Client work', color: '#ff3b30' }),
  });
  assert.equal(made.status, 200);
  const cat = await made.json();
  assert.equal(cat.name, 'Client work');
  assert.equal(cat.color, '#ff3b30');
  assert.ok(cat.id);

  for (const [body, why] of [
    [{ name: '', color: '#ff3b30' }, 'empty name'],
    [{ name: 'x'.repeat(25), color: '#ff3b30' }, 'name over 24'],
    [{ name: 'ok', color: 'red' }, 'a color that is not #rrggbb'],
    [{ name: 'ok', color: '#ff3b3' }, 'a five-digit hex'],
  ]) {
    const bad = await authed('/categories', { method: 'POST', body: JSON.stringify(body) });
    assert.equal(bad.status, 400, `rejects ${why}`);
  }

  // File a pane into it.
  const pane = await (
    await authed('/sessions', { method: 'POST', body: JSON.stringify({ workspace: ws }) })
  ).json();
  const filed = await authed(`/sessions/${pane.id}`, {
    method: 'PATCH',
    body: JSON.stringify({ categoryId: cat.id }),
  });
  assert.equal(filed.status, 200);
  assert.equal((await filed.json()).categoryId, cat.id);

  // A folder that doesn't exist is refused, so a pane can never point at one
  // the UI is unable to resolve.
  const ghost = await authed(`/sessions/${pane.id}`, {
    method: 'PATCH',
    body: JSON.stringify({ categoryId: 'no-such-folder' }),
  });
  assert.equal(ghost.status, 400);

  // null is the way out of a folder.
  const emptied = await authed(`/sessions/${pane.id}`, {
    method: 'PATCH',
    body: JSON.stringify({ categoryId: null }),
  });
  assert.equal((await emptied.json()).categoryId, null);

  // Rename + recolor.
  const patched = await authed(`/categories/${cat.id}`, {
    method: 'PATCH',
    body: JSON.stringify({ name: 'Backend', color: '#2b4c9b' }),
  });
  assert.equal(patched.status, 200);
  const after = await patched.json();
  assert.equal(after.name, 'Backend');
  assert.equal(after.color, '#2b4c9b');

  const missing = await authed('/categories/nope', {
    method: 'PATCH',
    body: JSON.stringify({ name: 'x' }),
  });
  assert.equal(missing.status, 404);

  await authed(`/sessions/${pane.id}`, { method: 'DELETE' });
  await authed(`/categories/${cat.id}`, { method: 'DELETE' });
});

test('deleting a category empties the panes filed in it', async () => {
  // The dangling-reference bug this codebase has already shipped twice
  // (workspace pins on profile delete, panes with no project): a delete has to
  // be a delete everywhere the thing is referenced, not just in its own list.
  const ws = mkdir(path.join(tmp, 'catdel'));
  await authed('/workspaces', { method: 'POST', body: JSON.stringify({ name: 'cd', dir: ws }) });
  const cat = await (
    await authed('/categories', {
      method: 'POST',
      body: JSON.stringify({ name: 'Doomed', color: '#4fc3f7' }),
    })
  ).json();

  const ids = [];
  for (let i = 0; i < 2; i++) {
    const p = await (
      await authed('/sessions', { method: 'POST', body: JSON.stringify({ workspace: ws }) })
    ).json();
    await authed(`/sessions/${p.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ categoryId: cat.id }),
    });
    ids.push(p.id);
  }

  const gone = await authed(`/categories/${cat.id}`, { method: 'DELETE' });
  assert.equal(gone.status, 200);
  assert.equal((await gone.json()).emptied, 2, 'reports how many panes it emptied');

  const list = await (await authed('/sessions')).json();
  for (const id of ids) {
    assert.equal(
      list.find((s) => s.id === id).categoryId,
      null,
      'the pane came out of the deleted category rather than keeping a ghost id',
    );
  }
  assert.equal((await authed(`/categories/${cat.id}`, { method: 'DELETE' })).status, 404);

  for (const id of ids) await authed(`/sessions/${id}`, { method: 'DELETE' });
});

test('a pane loses a category that vanished while the server was down', async () => {
  // categories.json is not written by seedState, so the id below names a folder
  // that has never existed — exactly the state a delete-while-offline leaves.
  const dir = seedState('cat-ghost', {
    workspaces: [{ id: 'w1', name: 'proj', dir: tmp }],
    sessions: [{ id: 'ghosted', name: 'Pane', workspace: tmp, kind: 'claude', categoryId: 'gone' }],
  });
  const aside = await bootAside(dir);
  try {
    const list = await (await aside.call('/sessions')).json();
    const pane = list.find((s) => s.id === 'ghosted');
    assert.ok(pane, 'the pane itself survives');
    assert.equal(pane.categoryId, null, 'but not its reference to a folder that is gone');
  } finally {
    aside.stop();
  }
});

test('favorites: a pane can be starred, and it survives a restart', async () => {
  const ws = mkdir(path.join(tmp, 'favproj'));
  await authed('/workspaces', { method: 'POST', body: JSON.stringify({ name: 'fav', dir: ws }) });
  const pane = await (
    await authed('/sessions', { method: 'POST', body: JSON.stringify({ workspace: ws }) })
  ).json();
  assert.equal(pane.favorite, false, 'panes start unstarred');

  const starred = await authed(`/sessions/${pane.id}`, {
    method: 'PATCH',
    body: JSON.stringify({ favorite: true }),
  });
  assert.equal(starred.status, 200);
  assert.equal((await starred.json()).favorite, true);

  const bad = await authed(`/sessions/${pane.id}`, {
    method: 'PATCH',
    body: JSON.stringify({ favorite: 'yes' }),
  });
  assert.equal(bad.status, 400, 'only a real boolean is accepted');

  // The star is a preference you set once — it has to be on disk, or every
  // restart silently empties the filter. (This server takes its data dir from
  // LOCALAPPDATA, so that is tmp\Helm — not tmp, which is the HELM_DATA_DIR
  // shape the seeded aside-servers use.)
  const saved = persistedSessions(path.join(tmp, 'Helm')).find((s) => s.id === pane.id);
  assert.equal(saved?.favorite, true, 'the star was persisted');

  const off = await authed(`/sessions/${pane.id}`, {
    method: 'PATCH',
    body: JSON.stringify({ favorite: false }),
  });
  assert.equal((await off.json()).favorite, false);
  await authed(`/sessions/${pane.id}`, { method: 'DELETE' });
});
