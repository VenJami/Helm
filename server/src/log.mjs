// Helm — in-memory debug log, the feed for the UI's 🐞 drawer (GET /api/logs).
// startedAt/pid identify the running server process — the quick tell for the
// stale-server-on-7777 trap (docs/GOTCHAS.md).

export const SERVER_STARTED_AT = new Date().toISOString();

const DEBUG_LOG_MAX = 500;
const debugLog = []; // {seq, t, tag, msg}
let debugSeq = 0;

export function dbg(tag, msg) {
  debugLog.push({ seq: ++debugSeq, t: new Date().toISOString(), tag, msg });
  if (debugLog.length > DEBUG_LOG_MAX) debugLog.shift();
  console.log(`[${tag}] ${msg}`);
}

// Snapshot for GET /api/logs: entries newer than `after`, plus the head seq
// so the client can poll incrementally.
export function logsSince(after) {
  return { seq: debugSeq, entries: debugLog.filter((e) => e.seq > after) };
}
