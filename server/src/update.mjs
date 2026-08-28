// Helm ⎈ — "a newer Helm is on GitHub" check.
//
// This is the only network call Helm makes on its own: one anonymous GET to
// the GitHub Releases API at boot and every 6 h. It sends nothing about the
// user or their projects (no telemetry) — it reads a public endpoint and
// compares the latest published release tag with this checkout's
// package.json version. HELM_NO_UPDATE_CHECK=1 turns it off entirely; the
// server then reports `disabled` and never touches the network.
//
// Deliberately RELEASES, not commits on main: a release is the point where
// the owner says "this is ready", CHANGELOG and all. Unreleased commits are
// work in progress and shouldn't nag anyone.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { dbg } from './log.mjs';

const REPO = process.env.HELM_REPO || 'VenJami/Helm';
// HELM_UPDATE_URL points the check at a stub in tests; it must return the
// GitHub release shape ({ tag_name, html_url, name, published_at }).
const RELEASES_URL =
  process.env.HELM_UPDATE_URL || `https://api.github.com/repos/${REPO}/releases/latest`;
const DISABLED = process.env.HELM_NO_UPDATE_CHECK === '1';
const CHECK_EVERY_MS = 6 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 8000;

const pkgPath = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'package.json');
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
};

/** Snapshot for GET /api/update (copied so callers can't mutate our state). */
export function updateInfo() {
  return { ...state };
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

export async function checkForUpdate() {
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

/** Boot hook: check now, then every 6 h. Unref'd so it never holds the process. */
export function startUpdateChecks() {
  if (DISABLED) {
    dbg('server', 'update check disabled (HELM_NO_UPDATE_CHECK=1)');
    return;
  }
  checkForUpdate();
  setInterval(checkForUpdate, CHECK_EVERY_MS).unref();
}
