// Helm — everything that touches the claude CLI's UNDOCUMENTED internals,
// kept in one module so drift is a one-file fix: model names → pricing,
// transcript JSONL parsing (usage + pane titles), account config files, and
// the boot-time version check. The full catalogue of assumptions lives in
// docs/CLAUDE_INTERNALS.md — update it when anything here changes.
//
// Drift is surfaced LOUDLY (a dismissible UI banner via GET /api/diagnostics)
// instead of the old failure mode: a claude update silently zeroing out
// usage/status/revive and making Helm look broken.

import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { dbg } from './log.mjs';

const IS_WIN = process.platform === 'win32';
// Windows must spawn the .cmd shim (node-pty can't run the .ps1); elsewhere
// plain `claude` from PATH. HELM_CLAUDE_CMD overrides for unusual installs.
export const CLAUDE_CMD = process.env.HELM_CLAUDE_CMD || (IS_WIN ? 'claude.cmd' : 'claude');

// ------------------------------------------------------ claude-CLI drift alarm
const CLAUDE_VERSION_FLOOR = '2.1.198'; // last version verified end-to-end (GOTCHAS)
export const diagnostics = {
  claude: { version: null, ok: true, floor: CLAUDE_VERSION_FLOOR, checked: false, error: null },
  warnings: new Map(), // key → { key, message, since, count } (key dedupes the spam)
};

export function noteDrift(key, message) {
  const hit = diagnostics.warnings.get(key);
  if (hit) {
    hit.count += 1;
    return;
  } // already surfaced — just count it
  diagnostics.warnings.set(key, { key, message, since: new Date().toISOString(), count: 1 });
  dbg('drift', message);
}

// Numeric semver compare (major.minor.patch). Returns -1 / 0 / 1.
function cmpVersion(a, b) {
  const pa = String(a)
    .split('.')
    .map((n) => parseInt(n, 10) || 0);
  const pb = String(b)
    .split('.')
    .map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) < (pb[i] || 0) ? -1 : 1;
  }
  return 0;
}

// Runs once after boot. shell:true so Windows can launch the `claude.cmd` shim.
export function checkClaudeVersion() {
  execFile(
    CLAUDE_CMD,
    ['--version'],
    { shell: true, windowsHide: true, timeout: 8000 },
    (err, stdout) => {
      diagnostics.claude.checked = true;
      if (err) {
        diagnostics.claude.ok = false;
        diagnostics.claude.error = err.message;
        noteDrift(
          'claude-missing',
          `Couldn't run \`${CLAUDE_CMD} --version\` — is the claude CLI installed and on PATH? ` +
            `Panes, usage and revive all need it. (${err.message})`,
        );
        return;
      }
      const m = String(stdout).match(/(\d+\.\d+\.\d+)/);
      diagnostics.claude.version = m ? m[1] : String(stdout).trim() || null;
      if (m && cmpVersion(m[1], CLAUDE_VERSION_FLOOR) < 0) {
        diagnostics.claude.ok = false;
        noteDrift(
          'claude-below-floor',
          `claude ${m[1]} is below the version Helm was verified against (${CLAUDE_VERSION_FLOOR}). ` +
            `Usage, status and revive may misbehave — update claude if these look wrong.`,
        );
      } else {
        dbg('server', `claude version ${diagnostics.claude.version ?? '(unparsed)'}`);
      }
    },
  );
}

// ------------------------------------------------------------ model pricing
// Rough published per-model prices ($ per 1M tokens): input + output. Cache is
// derived (read = 0.1x input, write = 1.25x input). Keyed by name prefix so
// dated ids (claude-haiku-4-5-20251001) and future point releases still match.
// Deliberately approximate — ignores Sonnet intro pricing/tiers; UI labels "est".
/** @type {[RegExp, { in: number, out: number }][]} */
const MODEL_PRICING = [
  [/^claude-(fable|mythos)/, { in: 10, out: 50 }],
  [/^claude-opus/, { in: 5, out: 25 }],
  [/^claude-sonnet/, { in: 3, out: 15 }],
  [/^claude-haiku/, { in: 1, out: 5 }],
];

// Dollar estimate for one model's token bundle. Unknown model → 0 (no guess),
// so it simply doesn't contribute to the total rather than inventing a number.
export function tokenCost(model, { input = 0, output = 0, cacheRead = 0, cacheWrite = 0 }) {
  const p = MODEL_PRICING.find(([re]) => re.test(model))?.[1];
  if (!p) {
    // A real model with real tokens that matches none of our price regexes =
    // claude shipped a new family; cost silently under-reports until we add it.
    if (model && model !== '<synthetic>' && (input || output || cacheRead || cacheWrite)) {
      noteDrift(
        `unknown-model:${model}`,
        `Unknown model "${model}" — its cost isn't counted (add it to MODEL_PRICING). ` +
          `A newer claude model family has probably shipped, so $ estimates read low.`,
      );
    }
    return 0;
  }
  return (input * p.in + output * p.out + cacheRead * p.in * 0.1 + cacheWrite * p.in * 1.25) / 1e6;
}

// -------------------------------------------------------- transcript parsing
// Growing files are parsed INCREMENTALLY (only appended bytes) — an active
// session rewrites its multi-MB transcript every turn, and a full re-read per
// poll used to block the event loop (and with it every pane's output).

const fileUsageCache = new Map(); // file path → parsed (insertion order ≈ recency)
const FILE_USAGE_CACHE_MAX = 512; // bound memory — oldest-touched entries drop first

// Read only the bytes of `file` from `from` to `size`, prepend the previous
// call's partial tail, and return the complete lines (a trailing partial line
// — claude may be mid-write — is handed back as `pending` for the next call).
// Splitting on '\n' at the byte level is UTF-8 safe.
function readAppendedLines(file, from, pending, size) {
  const fd = fs.openSync(file, 'r');
  const chunk = Buffer.alloc(size - from);
  try {
    fs.readSync(fd, chunk, 0, chunk.length, from);
  } finally {
    fs.closeSync(fd);
  }
  const data = pending?.length ? Buffer.concat([pending, chunk]) : chunk;
  const lines = [];
  let start = 0;
  for (let i = 0; i < data.length; i++) {
    if (data[i] === 0x0a) {
      // '\n'
      if (i > start) lines.push(data.subarray(start, i).toString('utf8'));
      start = i + 1;
    }
  }
  // copy the tail — subarray would pin the whole chunk in memory until next call
  return { lines, pending: Buffer.from(data.subarray(start)) };
}

export function parseTranscriptFile(file) {
  let stat;
  try {
    stat = fs.statSync(file);
  } catch {
    return null;
  }
  let entry = fileUsageCache.get(file);
  if (entry && entry.mtimeMs === stat.mtimeMs && entry.size === stat.size) {
    fileUsageCache.delete(file); // re-insert to mark most-recently-used
    fileUsageCache.set(file, entry);
    return entry;
  }

  // Transcripts are append-only, so when the file only grew we parse just the
  // appended bytes; a shrunk/replaced file falls back to a full parse.
  // `byMessage` dedupes streaming (the same assistant message can be logged on
  // several lines — last occurrence wins) and persists across increments.
  const incremental = entry?.byMessage && stat.size > entry.size;
  if (!incremental) entry = { byMessage: new Map(), pending: Buffer.alloc(0), sawJson: false };
  let lines;
  try {
    ({ lines, pending: entry.pending } = readAppendedLines(
      file,
      incremental ? entry.size : 0,
      entry.pending,
      stat.size,
    ));
  } catch {
    return null;
  }
  for (const line of lines) {
    let e;
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    entry.sawJson = true; // any JSON at all → drift signal below can trust "shape" verdicts
    const usage = e?.message?.usage;
    const model = e?.message?.model;
    // '<synthetic>' = placeholder entries (errors/retries), not real usage
    if (e?.type === 'assistant' && usage && model && model !== '<synthetic>') {
      entry.byMessage.set(e.message.id ?? e.uuid, {
        model,
        usage,
        t: Date.parse(e.timestamp) || 0,
      });
    }
  }
  // Rebuild the aggregate views from the deduped messages (cheap vs parsing).
  const models = {};
  const events = []; // [timestampMs, model, input, output, cacheRead, cacheWrite]
  for (const { model, usage, t } of entry.byMessage.values()) {
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
    events.push([t, model, input, output, cacheRead, cacheWrite]);
  }
  entry.models = models;
  entry.events = events;
  entry.mtimeMs = stat.mtimeMs;
  entry.size = stat.size;
  // Drift signal: a substantial, well-formed transcript that yields zero usage
  // events almost certainly means the JSONL shape changed (assistant/usage
  // fields renamed or moved). Gated by size so fresh/short sessions with no
  // assistant turn yet don't false-alarm. (noteDrift dedupes by key.)
  if (entry.sawJson && events.length === 0 && stat.size > 16 * 1024) {
    noteDrift(
      'transcript-shape',
      `A ${Math.round(stat.size / 1024)} KB transcript parsed as JSON but produced 0 usage entries ` +
        `(e.g. ${path.basename(file)}) — the claude transcript format may have changed, so usage reads low. ` +
        `See docs/CLAUDE_INTERNALS.md.`,
    );
  }
  fileUsageCache.delete(file); // re-insert to mark most-recently-used
  fileUsageCache.set(file, entry);
  while (fileUsageCache.size > FILE_USAGE_CACHE_MAX) {
    fileUsageCache.delete(fileUsageCache.keys().next().value);
  }
  return entry;
}

// All transcripts under a config dir's projects/ store (one subdir per cwd).
// Recursive: newer claude nests subagent transcripts in
// projects/<cwd>/<sessionId>/subagents/*.jsonl.
export function transcriptFiles(configDir) {
  const root = path.join(configDir, 'projects');
  /** @type {string[]} */
  let entries = [];
  // recursive readdir returns string[] here (no Buffer encoding requested)
  try {
    entries = /** @type {string[]} */ (fs.readdirSync(root, { recursive: true }));
  } catch {
    return [];
  }
  return entries.filter((f) => f.endsWith('.jsonl')).map((f) => path.join(root, f));
}

// A short, human-readable title for a pane derived from its conversation: the
// first real user prompt in the transcript. Gives the command palette / search
// something meaningful to match instead of the random star-name. The opening
// prompt is immutable once written, so we cache it and never re-read after it's
// found; before then only the bytes APPENDED since the last poll are read (this
// runs for every session on every 3 s /api/sessions poll — a full re-read of a
// growing multi-MB transcript here used to stall the event loop).
const summaryCache = new Map(); // transcript path → {mtimeMs, size, pending, summary}
const SUMMARY_CACHE_MAX = 512; // bound memory like fileUsageCache (sessions churn)

export function firstPromptSummary(file) {
  if (!file) return null;
  let stat;
  try {
    stat = fs.statSync(file);
  } catch {
    return null;
  }
  let c = summaryCache.get(file);
  if (c && c.summary) return c.summary; // first prompt never changes
  if (c && c.mtimeMs === stat.mtimeMs && c.size === stat.size) return null; // unchanged, still none
  const grew = Boolean(c && stat.size > c.size); // append-only → incremental; else full scan
  if (!grew) c = { size: 0, pending: Buffer.alloc(0), summary: null };
  let lines;
  try {
    ({ lines, pending: c.pending } = readAppendedLines(
      file,
      grew ? c.size : 0,
      c.pending,
      stat.size,
    ));
  } catch {
    return null;
  }
  for (const line of lines) {
    let e;
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    if (e?.type !== 'user' || e.isMeta) continue;
    const content = e.message?.content;
    let str =
      typeof content === 'string'
        ? content
        : Array.isArray(content)
          ? content
              .filter((b) => b?.type === 'text' && typeof b.text === 'string')
              .map((b) => b.text)
              .join(' ')
          : '';
    str = str.replace(/\s+/g, ' ').trim();
    // Skip tool results (no text), slash-command wrappers, and system-reminder
    // injections — we want the human's actual opening ask.
    if (
      !str ||
      str.startsWith('<command-') ||
      str.startsWith('<local-command') ||
      str.startsWith('<system-reminder') ||
      str.startsWith('Caveat:')
    )
      continue;
    c.summary = str.slice(0, 100);
    break;
  }
  c.mtimeMs = stat.mtimeMs;
  c.size = stat.size;
  summaryCache.set(file, c);
  while (summaryCache.size > SUMMARY_CACHE_MAX) {
    summaryCache.delete(summaryCache.keys().next().value);
  }
  return c.summary;
}

// --------------------------------------------------------- account config
// The logged-in account's email lives in `<config dir>\.claude.json` →
// oauthAccount.emailAddress (null until /login has been run in that profile).
export function accountEmail(configDir) {
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(configDir, '.claude.json'), 'utf8'));
    return cfg.oauthAccount?.emailAddress ?? null;
  } catch {
    return null;
  }
}
