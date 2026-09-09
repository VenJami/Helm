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
    /** @type {{ahead: number, url: string|null, latest: string|null, latestAt: string|null}|null} */ (
      null
    ),
};

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
    const newest = Array.isArray(body?.commits) ? body.commits[body.commits.length - 1] : null;
    state.commits = {
      ahead,
      url: body?.html_url || null,
      latest: String(newest?.commit?.message || '').split('\n')[0] || null,
      latestAt: newest?.commit?.committer?.date || null,
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

/** Boot hook: check now, then every 2 h. Unref'd so it never holds the process. */
export function startUpdateChecks() {
  if (DISABLED) {
    dbg('server', 'update check disabled (HELM_NO_UPDATE_CHECK=1)');
    return;
  }
  checkForUpdate();
  setInterval(checkForUpdate, CHECK_EVERY_MS).unref();
}
