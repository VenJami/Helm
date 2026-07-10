// Helm — in-memory debug log, the feed for the UI's 🐞 drawer (GET /api/logs).
// startedAt/pid identify the running server process — the quick tell for the
// stale-server-on-7777 trap (docs/GOTCHAS.md).
//
// The ring is capped and lost on restart by design (it's a live tail, not an
// audit log). Set HELM_LOG_FILE to also append every line to disk (survives
// restarts, e.g. for filing a bug); no rotation — point it at a fresh path or
// truncate it yourself. Each entry carries a coarse `level` derived from its
// tag so the UI (and a grep) can pick out problems.

import fs from 'node:fs';

export const SERVER_STARTED_AT = new Date().toISOString();

const DEBUG_LOG_MAX = 500;
const debugLog = []; // {seq, t, level, tag, msg}
let debugSeq = 0;

const LOG_FILE = process.env.HELM_LOG_FILE || null;
// tags that mean "something went wrong" (vs routine activity like spawn/hook).
const ERROR_TAGS = new Set(['error', 'drift']);
const levelFor = (tag) => (ERROR_TAGS.has(tag) ? 'error' : 'info');

export function dbg(tag, msg) {
  const entry = { seq: ++debugSeq, t: new Date().toISOString(), level: levelFor(tag), tag, msg };
  debugLog.push(entry);
  if (debugLog.length > DEBUG_LOG_MAX) debugLog.shift();
  console.log(`[${entry.level}] [${tag}] ${msg}`);
  if (LOG_FILE) {
    // Best-effort file sink — a logging failure must never break the server.
    try {
      fs.appendFileSync(LOG_FILE, `${entry.t} [${entry.level}] [${tag}] ${msg}\n`);
    } catch {
      /* ignore */
    }
  }
}

// Snapshot for GET /api/logs: entries newer than `after`, plus the head seq
// so the client can poll incrementally.
export function logsSince(after) {
  return { seq: debugSeq, entries: debugLog.filter((e) => e.seq > after) };
}
