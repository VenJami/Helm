// Helm ⎈ — "a newer Helm is on GitHub" check.
//
// This is the only network call Helm makes on its own: one anonymous GET to
// the GitHub Releases API at boot and every 2 h. It sends nothing about the
// user or their projects (no telemetry) — it reads a public endpoint and
// compares the latest published release tag with this checkout's
// package.json version. HELM_NO_UPDATE_CHECK=1 turns it off entirely; the
// server then reports `disabled` and never touches the network.
//
// TWO signals, at deliberately different volumes:
//
//   1. A newer RELEASE than this checkout's package version. A release is the
//      point where the owner says "this is ready", CHANGELOG and all, so this
//      one gets the loud banner.
//   2. Otherwise: how many commits `main` is ahead of the commit this copy is
//      checked out at. Helm is installed by `git clone`, so people track main
//      and can sit weeks ahead of the last release (v0.2.0 was 7 weeks and 17
//      commits behind main when this was written). But every docs fixup lands
//      on main too, so this is NEWS, not an alarm — the UI shows it as one
//      quiet line, and only when there is no release to announce.
//
// Signal 2 stays SILENT on every ambiguous case (no git checkout, unknown
// commit, or a checkout with its own commits) — same rule as the rest of this
// module: only a positive, unambiguous result is ever shown.

import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { dbg } from './log.mjs';

const execFileAsync = promisify(execFile);

const REPO = process.env.HELM_REPO || 'VenJami/Helm';
// HELM_UPDATE_URL points the check at a stub in tests; it must return the
// GitHub release shape ({ tag_name, html_url, name, published_at }).
const RELEASES_URL =
  process.env.HELM_UPDATE_URL || `https://api.github.com/repos/${REPO}/releases/latest`;
// The branch people track, and the compare endpoint that says how far behind
// this checkout is. HELM_COMPARE_URL points at a stub in tests; the real one
// answers { status, ahead_by, behind_by, html_url, commits: [...] }.
const REPO_BRANCH = process.env.HELM_REPO_BRANCH || 'main';
const COMPARE_URL = process.env.HELM_COMPARE_URL || `https://api.github.com/repos/${REPO}/compare`;
const DISABLED = process.env.HELM_NO_UPDATE_CHECK === '1';
// Separate switch from the CHECK above: a managed or shared install may want
// to be told about updates but never apply them itself. The test suite sets
// it too, so `npm test` can exercise the route with no chance of a real pull.
const SELF_UPDATE_OFF = process.env.HELM_NO_SELF_UPDATE === '1';
const CHECK_EVERY_MS = 2 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 8000;

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const pkgPath = path.join(moduleDir, '..', 'package.json');
const repoRoot = path.join(moduleDir, '..', '..'); // server/src → the clone root
function readVersion() {
  try {
    return String(JSON.parse(fs.readFileSync(pkgPath, 'utf8')).version || '0.0.0');
  } catch {
    return '0.0.0'; // unreadable package.json: report 0.0.0 rather than crash the boot
  }
}

export const CURRENT_VERSION = readVersion();

const state = {
  current: CURRENT_VERSION,
  latest: /** @type {string|null} */ (null),
  available: false,
  url: /** @type {string|null} */ (null),
  name: /** @type {string|null} */ (null),
  publishedAt: /** @type {string|null} */ (null),
  checkedAt: /** @type {string|null} */ (null),
  disabled: DISABLED,
  error: /** @type {string|null} */ (null),
  // Unreleased commits on `main` this checkout doesn't have. null whenever we
  // can't say so unambiguously (not a git clone, git missing, commit not on
  // GitHub, or this copy has commits of its own) — see checkCommits.
  commits:
    /** @type {{ahead: number, url: string|null, latest: string|null, latestAt: string|null, list: {sha: string, message: string, at: string|null, url: string|null}[]}|null} */ (
      null
    ),
};

// How many commit subjects to hand the UI. The compare endpoint returns up to
// 250; the banner is a list to skim before deciding to update, not a log.
const MAX_LISTED_COMMITS = 30;

/** Snapshot for GET /api/update (copied so callers can't mutate our state). */
export function updateInfo() {
  return { ...state, commits: state.commits ? { ...state.commits } : null };
}

// Release tags carry a `v` prefix and sometimes a prerelease suffix, which
// claude.mjs's cmpVersion (a claude-internals helper) doesn't handle — hence
// this small local parse instead of reaching across modules for it.
function parseVersion(v) {
  const m = String(v || '')
    .trim()
    .replace(/^v/i, '')
    .match(/^(\d+)\.(\d+)\.(\d+)/);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/** True when `latest` is a strictly higher version than `current`. */
export function isNewer(latest, current) {
  const a = parseVersion(latest);
  const b = parseVersion(current);
  if (!a || !b) return false; // unparseable either side: never claim an update
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i];
  return false;
}

async function checkRelease() {
  if (DISABLED) return updateInfo();
  try {
    const res = await fetch(RELEASES_URL, {
      headers: { accept: 'application/vnd.github+json', 'user-agent': `Helm/${CURRENT_VERSION}` },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    // 404 = the repo has no published release yet. Not an error worth showing.
    if (res.status === 404) {
      state.checkedAt = new Date().toISOString();
      state.error = null;
      return updateInfo();
    }
    if (!res.ok) throw new Error(`GitHub returned ${res.status}`);
    /** @type {{ tag_name?: string, html_url?: string, name?: string, published_at?: string }} */
    const body = await res.json();
    const tag = String(body?.tag_name || '');
    state.latest = tag.replace(/^v/i, '') || null;
    state.url = body?.html_url || null;
    state.name = body?.name || null;
    state.publishedAt = body?.published_at || null;
    state.available = isNewer(tag, CURRENT_VERSION);
    state.error = null;
    state.checkedAt = new Date().toISOString();
    if (state.available) dbg('server', `update available: ${tag} (running ${CURRENT_VERSION})`);
  } catch (err) {
    // Offline, rate-limited, DNS-blocked: all normal for a local-first app.
    // Record it and stay quiet — the UI only ever shows a POSITIVE result.
    state.error = err?.message || String(err);
    state.checkedAt = new Date().toISOString();
    dbg('server', `update check failed: ${state.error}`);
  }
  return updateInfo();
}

// The commit this copy is checked out at. Cached for the life of the process:
// it only changes on a `git pull`, and picking up a pull means restarting the
// server anyway. undefined = not looked up yet, null = not a git checkout.
let headSha = /** @type {string|null|undefined} */ (undefined);

async function localHeadSha() {
  if (headSha !== undefined) return headSha;
  try {
    const { stdout } = await execFileAsync('git', ['rev-parse', 'HEAD'], {
      cwd: repoRoot,
      timeout: 3000,
      windowsHide: true,
    });
    const sha = stdout.trim();
    headSha = /^[0-9a-f]{40}$/.test(sha) ? sha : null;
  } catch {
    headSha = null; // downloaded as a ZIP, or git isn't on PATH: stay quiet
  }
  return headSha;
}

/**
 * How far ahead of this checkout `main` is. Sets state.commits, or leaves it
 * null on every case where the answer would be a guess. Failures here never
 * touch state.error: that one belongs to the release check, and an unreachable
 * compare endpoint is not something to report to a user.
 */
export async function checkCommits() {
  if (DISABLED) return null;
  const sha = await localHeadSha();
  if (!sha) return null;
  try {
    const res = await fetch(`${COMPARE_URL}/${sha}...${REPO_BRANCH}`, {
      headers: { accept: 'application/vnd.github+json', 'user-agent': `Helm/${CURRENT_VERSION}` },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    // 404 = GitHub has never seen this commit: a local build, an unpushed
    // branch, or a fork. Nothing honest to say.
    if (res.status === 404) {
      state.commits = null;
      return null;
    }
    if (!res.ok) throw new Error(`GitHub returned ${res.status}`);
    /** @type {{ status?: string, ahead_by?: number, html_url?: string, commits?: any[] }} */
    const body = await res.json();
    // `ahead_by` counts commits the BRANCH has that we don't, and `status` is
    // the branch's position relative to us. Only a clean 'ahead' means "you
    // are simply behind"; 'identical' is up to date, and 'behind'/'diverged'
    // mean this checkout carries commits of its own — a developer, not someone
    // to nag.
    const ahead = Number(body?.ahead_by || 0);
    if (body?.status !== 'ahead' || ahead <= 0) {
      state.commits = null;
      return null;
    }
    // GitHub returns the range oldest-first; the UI reads newest-first.
    const all = Array.isArray(body?.commits) ? body.commits : [];
    const newest = all[all.length - 1] || null;
    state.commits = {
      ahead,
      url: body?.html_url || null,
      latest: String(newest?.commit?.message || '').split('\n')[0] || null,
      latestAt: newest?.commit?.committer?.date || null,
      list: all
        .slice(-MAX_LISTED_COMMITS)
        .reverse()
        .map((c) => ({
          sha: String(c?.sha || '').slice(0, 7),
          message: String(c?.commit?.message || '').split('\n')[0],
          at: c?.commit?.committer?.date || null,
          url: c?.html_url || null,
        }))
        .filter((c) => c.message),
    };
    dbg('server', `${ahead} new commit(s) on ${REPO_BRANCH} (checkout at ${sha.slice(0, 7)})`);
  } catch (err) {
    state.commits = null;
    dbg('server', `commit check failed: ${err?.message || err}`);
  }
  return state.commits;
}

/** One pass of both signals: is there a newer release, and how far behind main. */
export async function checkForUpdate() {
  await checkRelease();
  await checkCommits();
  return updateInfo();
}

// ---------------------------------------------------------------- applying it
// The banner's Update button. Everything here is deliberately conservative:
// this runs git and npm against the user's own checkout, so it refuses on any
// case it cannot complete cleanly rather than leaving a half-merged tree.
//
// What it will NOT do, by design:
//   - merge. `--ff-only` means the pull either moves the branch pointer or
//     fails; it can never produce a conflict or a merge commit to untangle.
//   - touch server/node_modules. The running server has node-pty's .node
//     binary LOADED, and on Windows npm cannot replace a locked file — so a
//     server dependency change is reported for the restart, never installed
//     underneath a live process.
//   - restart the server. That kills every live pane, so it is the caller's
//     decision, made with the pane count in front of them.
const NPM = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const GIT_TIMEOUT_MS = 60_000;
const NPM_TIMEOUT_MS = 5 * 60_000;
// git must never sit waiting on a credential prompt with nobody at the
// terminal: fail fast instead. The repo is public, so fetching needs no auth.
const GIT_ENV = { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: '', GCM_INTERACTIVE: '0' };

/** @param {string[]} args */
async function git(args, timeout = GIT_TIMEOUT_MS) {
  const { stdout } = await execFileAsync('git', args, {
    cwd: repoRoot,
    timeout,
    windowsHide: true,
    env: GIT_ENV,
    maxBuffer: 8 * 1024 * 1024,
  });
  return stdout.trim();
}

/** npm in one of the workspaces. `shell` because npm is a .cmd on Windows. */
async function npm(args, cwd) {
  const { stdout, stderr } = await execFileAsync(NPM, args, {
    cwd: path.join(repoRoot, cwd),
    timeout: NPM_TIMEOUT_MS,
    windowsHide: true,
    shell: process.platform === 'win32',
    maxBuffer: 16 * 1024 * 1024,
  });
  return (stdout + stderr).trim();
}

/**
 * Where this checkout stands right now: which branch, and whether it is clean.
 * Read fresh on every GET /api/update (two cheap git calls) rather than cached
 * with the 2-hourly GitHub answer, because the button LABELS ITSELF from this —
 * a stale branch here would promise one thing and do another.
 *
 * @returns {Promise<{branch: string, tracked: string, dirty: boolean, selfUpdate: boolean}|null>}
 */
export async function checkoutState() {
  try {
    const branch = await git(['rev-parse', '--abbrev-ref', 'HEAD'], 5000);
    const dirty = !!(await git(['status', '--porcelain', '--untracked-files=no'], 10_000));
    return { branch, tracked: REPO_BRANCH, dirty, selfUpdate: !SELF_UPDATE_OFF };
  } catch {
    return null; // not a git checkout, or git isn't on PATH
  }
}

const refuse = (reason, detail) => ({
  ok: false,
  reason,
  detail,
  steps: [],
  needsRestart: false,
  needsServerInstall: false,
});

/**
 * Fast-forward this checkout to the tracked branch and rebuild what changed.
 *
 * @returns {Promise<{ok: boolean, reason?: string, detail?: string, from?: string,
 *   to?: string, pulled?: number, steps: {name: string, ok: boolean, detail: string}[],
 *   needsRestart: boolean, needsServerInstall: boolean, notchChanged?: boolean}>}
 */
async function performUpdate({ switchBranch = false } = {}) {
  if (SELF_UPDATE_OFF) {
    return refuse(
      'disabled',
      'Self-update is switched off here (HELM_NO_SELF_UPDATE=1). Pull it yourself with git.',
    );
  }
  let branch = '';
  let from = '';
  try {
    branch = await git(['rev-parse', '--abbrev-ref', 'HEAD']);
    from = await git(['rev-parse', 'HEAD']);
  } catch {
    return refuse(
      'not-a-checkout',
      'This copy of Helm is not a git clone (or git is not on PATH), so there is nothing to pull. Download the new version from GitHub instead.',
    );
  }

  /** @type {{name: string, ok: boolean, detail: string}[]} */
  const steps = [];

  // The banner compares against main, so anything else has to move first.
  // Doing that is the caller's explicit decision (the button SAYS "switch to
  // main and update" when it will), not something that happens by surprise —
  // but refusing with "go and switch branches" is no use to someone who does
  // not use git, which is most of the people this button is for. Nothing is
  // lost either way: the branch being left keeps existing, and the tree is
  // verified clean below before anything moves.
  if (branch !== REPO_BRANCH) {
    if (!switchBranch) {
      return refuse('wrong-branch', `You are on branch "${branch}", not "${REPO_BRANCH}".`);
    }
    const stray = await git(['status', '--porcelain', '--untracked-files=no']);
    if (stray) {
      return refuse(
        'dirty',
        `You have uncommitted changes on "${branch}". Commit or stash them first — Helm will not move branches over your own edits.`,
      );
    }
    try {
      await git(['checkout', REPO_BRANCH]);
    } catch {
      // No local branch of that name yet (a shallow or single-branch clone):
      // create it from the remote rather than giving up.
      try {
        await git(['checkout', '-b', REPO_BRANCH, `origin/${REPO_BRANCH}`]);
      } catch (err) {
        return refuse(
          'checkout-failed',
          `Couldn't switch to ${REPO_BRANCH}: ${
            String(err?.stderr || err?.message || err)
              .trim()
              .split('\n')[0]
          }`,
        );
      }
    }
    const left = branch;
    branch = REPO_BRANCH;
    from = await git(['rev-parse', 'HEAD']);
    steps.push({
      name: `switched to ${REPO_BRANCH}`,
      ok: true,
      detail: `"${left}" is still there, untouched`,
    });
  }

  // Tracked changes only: an untracked scratch file is not a reason to refuse,
  // and git itself will stop the pull if one is genuinely in the way.
  const dirty = await git(['status', '--porcelain', '--untracked-files=no']);
  if (dirty) {
    const n = dirty.split('\n').length;
    return refuse(
      'dirty',
      `You have ${n} uncommitted change${n === 1 ? '' : 's'} here. Commit or stash them first — Helm will not pull over your own edits.`,
    );
  }

  let out = '';
  try {
    out = await git(['pull', '--ff-only']);
  } catch (err) {
    return refuse(
      'pull-failed',
      `git pull could not fast-forward: ${
        String(err?.stderr || err?.message || err)
          .trim()
          .split('\n')[0]
      }`,
    );
  }
  const to = await git(['rev-parse', 'HEAD']);
  steps.push({ name: 'git pull', ok: true, detail: out.split('\n').slice(-1)[0] || 'pulled' });
  if (to === from) {
    // Nothing came down: the banner was stale (someone already pulled).
    headSha = undefined;
    await checkCommits();
    return {
      ok: true,
      from: from.slice(0, 7),
      to: to.slice(0, 7),
      pulled: 0,
      steps,
      needsRestart: false,
      needsServerInstall: false,
    };
  }

  const changed = (await git(['diff', '--name-only', from, to])).split('\n').filter(Boolean);
  const touched = (prefix) => changed.some((f) => f.startsWith(prefix));
  const webDeps = changed.some((f) => /^web\/package(-lock)?\.json$/.test(f));
  const needsServerInstall = changed.some((f) => /^server\/package(-lock)?\.json$/.test(f));

  if (touched('web/')) {
    if (webDeps) {
      try {
        await npm(['install'], 'web');
        steps.push({ name: 'npm install (web)', ok: true, detail: 'dependencies updated' });
      } catch (err) {
        steps.push({
          name: 'npm install (web)',
          ok: false,
          detail: String(err?.stderr || err?.message || err)
            .trim()
            .split('\n')
            .slice(-1)[0],
        });
      }
    }
    try {
      await npm(['run', 'build'], 'web');
      steps.push({ name: 'npm run build (web)', ok: true, detail: 'frontend rebuilt' });
    } catch (err) {
      steps.push({
        name: 'npm run build (web)',
        ok: false,
        detail: String(err?.stderr || err?.message || err)
          .trim()
          .split('\n')
          .slice(-1)[0],
      });
    }
  }

  // The pull moved HEAD, so the cached sha and the "behind main" answer are
  // both stale — re-ask before the UI polls again.
  headSha = undefined;
  await checkCommits();
  const ok = steps.every((s) => s.ok);
  dbg(
    'server',
    `update: ${from.slice(0, 7)} → ${to.slice(0, 7)}, ${changed.length} file(s), ok=${ok}`,
  );
  return {
    ok,
    from: from.slice(0, 7),
    to: to.slice(0, 7),
    pulled: changed.length,
    steps,
    needsRestart: touched('server/'),
    needsServerInstall,
    notchChanged: touched('desktop/'),
  };
}

// A double-click must not start a second pull on top of the first. Every
// caller joins the one run in flight and gets the same report.
let updateInFlight = /** @type {Promise<any>|null} */ (null);

/** @type {typeof performUpdate} */
export function runUpdate(opts) {
  if (!updateInFlight) {
    updateInFlight = performUpdate(opts).finally(() => {
      updateInFlight = null;
    });
  }
  return updateInFlight;
}

/** Boot hook: check now, then every 2 h. Unref'd so it never holds the process. */
export function startUpdateChecks() {
  if (DISABLED) {
    dbg('server', 'update check disabled (HELM_NO_UPDATE_CHECK=1)');
    return;
  }
  checkForUpdate();
  setInterval(checkForUpdate, CHECK_EVERY_MS).unref();
}
