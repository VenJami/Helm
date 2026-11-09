// Helm ⎈ — Discord Rich Presence: the card on your Discord profile that says
// "Coding with Helm / Agents working (3 of 5)", with Helm's status dot on a logo
// that turns while agents work, the way the VS Code extensions show what you do.
//
// HOW: the Discord desktop app listens on a local pipe (discord-ipc-0 to 9).
// Helm connects as a client and says what the card should read; Discord does the
// publishing. A browser page cannot open that pipe, which is why this lives in
// the server, and browser Discord has no pipe at all, so it only works with the
// desktop app. Discord's RPC page says every command needs OAuth, but
// SET_ACTIVITY does not. Checked against the real client: see GOTCHAS.
//
// PRIVACY, read before changing what goes on the card: the card is PUBLIC, anyone
// who can see the profile can read it, and it is off until the owner turns it on.
// This module is handed only { activity, since, project, task } per pane, with
// project null unless the owner opted that project in, and task (the one-line
// sentence Task lines writes from a prompt) null unless that project is opted in
// AND Task lines is on (presencePanes in index.mjs). It never sees prompts, paths,
// pane names or accounts, so it cannot leak them.
//
// Failing quietly is correct here: Discord being closed is normal, not a problem
// to report. Dropping the connection is what clears the card, so a Helm crash
// cannot leave a stale one behind (also checked against the real client).

import crypto from 'node:crypto';
import net from 'node:net';
import path from 'node:path';
import { dbg } from './log.mjs';

// The Discord application the card runs under. It holds the uploaded logo, and its
// name is only a fallback, since the card sets its own title (CARD.name). An
// application id is public by design and Helm never needs the app's client
// secret. A fork can point at its own.
const APP_ID = process.env.HELM_DISCORD_APP_ID || '1567725173568831508';
const REPO_URL = `https://github.com/${process.env.HELM_REPO || 'VenJami/Helm'}`;
// The card's images, loaded by LINK: Discord only animates linked images, never
// uploaded art, and links need no portal upload. They live on the `discord-art-v1`
// tag, which holds those five files and nothing else, so the links survive
// whatever happens to the branches. New art goes on a new tag, never a moved one:
// Discord caches each link, so changed bytes behind an old link may never show.
const ART =
  process.env.HELM_DISCORD_ART ||
  `https://raw.githubusercontent.com/${process.env.HELM_REPO || 'VenJami/Helm'}/discord-art-v1/docs/discord`;

// One timer drives everything. At 5 s it cannot send more than 4 updates in 20 s,
// inside Discord's limit of 5, so there is no throttling code to get wrong.
const TICK_MS = Number(process.env.HELM_DISCORD_TICK_MS) || 5000;
const RETRY_TICKS = 3; // look for Discord again every 15 s
const HANDSHAKE_TICKS = 2; // give up on a pipe that accepts but never says READY
const MAX_FRAME_BYTES = 64 * 1024; // READY and acks are tiny; bigger isn't Discord

// Same 30 minutes as the notch's "quiet" rule, but a different question: the
// notch asks what needs you, so a blocked pane stays listed forever. This card
// says what you are doing now, and someone away for 6 hours is not "playing", so
// here a waiting pane ages out too.
const QUIET_AFTER_MS = 30 * 60 * 1000;
const MAX_PROJECT_NAME = 40; // the card's lines are short, and a cut is better than a wrap
const MAX_LINE = 128; // Discord's own limit for a card line
// With several agents busy, their task lines take turns on line 1, this long each.
// Changing every 20 s stays well inside Discord's limit of 5 updates per 20 s.
const ROTATE_MS = Number(process.env.HELM_DISCORD_ROTATE_MS) || 20_000;
// Which line Discord shows under the owner's name in member lists:
// 0 the title (the default), 1 line 2, 2 line 1.
const STATUS_DISPLAY_DETAILS = 2;

const OP_HANDSHAKE = 0;
const OP_FRAME = 1;
const OP_CLOSE = 2;
const OP_PING = 3;
const OP_PONG = 4;

const CARD = {
  // The title, so the card reads as someone coding rather than a game called
  // "Helm". Discord honours it on the real client: it's the card's title and the
  // short status reads "Playing Coding with Helm".
  name: 'Coding with Helm',
  // The verb can't be changed: SET_ACTIVITY allows only Playing, Listening,
  // Watching or Competing, and "Playing" fits a working session best.
  type: 0,
  buttons: [{ label: 'Helm on GitHub', url: REPO_URL }],
};
// Any id will do: it only groups the "(3 of 5)" count. With no join secret, no one
// is offered a way to join anything.
const PARTY_ID = 'helm-agents';

const agents = (n) => `${n} agent${n === 1 ? '' : 's'}`;

/**
 * What the card should say. Pure, so every rule can be tested without a pipe.
 *
 * @param {{activity: string|null, since: number, project: string|null, task?: string|null}[]} panes
 *   the running claude panes; since is in milliseconds
 * @param {number|null} activeSince when the card appeared, or null if it is down
 * @param {number} now
 * @returns {{activity: object|null, activeSince: number|null}} a null activity
 *   means take the card down. activeSince is kept across updates so the elapsed
 *   timer on the card never jumps.
 */
export function buildActivity(panes, activeSince, now = Date.now()) {
  const fresh = panes.filter((p) => p.activity === 'working' || now - p.since <= QUIET_AFTER_MS);
  if (!fresh.length) return { activity: null, activeSince: null };

  const working = panes.filter((p) => p.activity === 'working').length;
  const waiting = panes.filter((p) => p.activity === 'waiting').length;
  const open = panes.length;

  // Only a pane that is itself still active can name a project, or a stale name
  // would sit on the card while the real work happens in a private project.
  // Longest in that state wins, so the name doesn't flip each time another pane
  // changes. sort() is stable, so a tie keeps a steady order too.
  const rank = (p) => ({ working: 0, waiting: 1 })[p.activity] ?? 2;
  const [named] = fresh
    .filter((p) => p.project)
    .sort((a, b) => rank(a) - rank(b) || a.since - b.since);

  const clip = (s, n) => [...String(s)].slice(0, n).join('');
  const name = named ? clip(named.project, MAX_PROJECT_NAME) : null;
  // With Task lines on, a sentence ("Debugging the reported bug on ticket 7") is
  // line 1 while its pane works or waits. Between tasks it would describe finished
  // work, so the card goes back to saying what it always did. Several such panes
  // take turns, ROTATE_MS each, in a steady order (longest in that state first),
  // worked out from the clock so this stays a pure function of `now`. Only panes in
  // the named pane's state get a turn, so while anything works line 1 never shows
  // a finished task next to "Agents working". One turn per distinct sentence, so a
  // broadcast doesn't repeat the same line.
  const top = named ? rank(named) : 2;
  const turns =
    top < 2
      ? [
          ...new Map(
            fresh
              .filter((p) => p.project && p.task && rank(p) === top)
              .sort((a, b) => a.since - b.since)
              .map((p) => [`${p.project}\n${p.task}`, p]),
          ).values(),
        ]
      : [];
  const shown = turns.length ? turns[Math.floor(now / ROTATE_MS) % turns.length] : null;
  const task = shown ? clip(shown.task, MAX_LINE) : null;

  // Line 1 only when it says something: the sentence, the opted-in project, or
  // who needs me. Left out otherwise, rather than filled with a line repeating
  // the count.
  let details;
  if (task) {
    details = task;
  } else if (named) {
    const verb = { working: 'Working on', waiting: 'Waiting in' }[named.activity] ?? 'In';
    details = `${verb} ${name}`;
  } else if (waiting) {
    details = `${agents(waiting)} waiting on me`;
  }

  // Line 2 carries the count, drawn by Discord itself as "(3 of 5)". When line 1
  // is a sentence, the project that sentence belongs to leads line 2.
  let state = 'Between tasks';
  let party;
  if (working) {
    state = 'Agents working';
    party = { id: PARTY_ID, size: [working, open] };
  } else if (waiting) {
    state = 'Waiting on me';
    party = { id: PARTY_ID, size: [waiting, open] };
  }
  if (task) state = clip(`${clip(shown.project, MAX_PROJECT_NAME)} · ${state}`, MAX_LINE);

  // The badge is Helm's own status dot: amber if anything needs me, else blue
  // while working, else green. The logo turns only while agents are working.
  const badge = waiting ? 'waiting' : working ? 'working' : 'idle';
  const assets = {
    large_image: `${ART}/${working ? 'helm-working.gif' : 'helm.png'}`,
    large_text: 'Helm, an operations hub for Claude Code',
    small_image: `${ART}/${badge}.png`,
    small_text: [
      working && `${working} working`,
      waiting && `${waiting} waiting on me`,
      `${open} open`,
    ]
      .filter(Boolean)
      .join(' · '),
  };

  const start = activeSince ?? now;
  /** @type {Record<string, any>} */
  const activity = { ...CARD, details, state, party, assets, timestamps: { start } };
  // The member list shows the sentence under the owner's name instead of the
  // title. Only when there is one: otherwise it keeps saying "Coding with Helm".
  if (task) activity.status_display_type = STATUS_DISPLAY_DETAILS;
  return { activity, activeSince: start };
}

/**
 * The card as a person would read it: "Working on x / Agents working (3 of 5) ·
 * [working]", plus where the member list takes its line from when that isn't the title.
 */
export function describeCard(a) {
  const count = a.party ? ` (${a.party.size[0]} of ${a.party.size[1]})` : '';
  const badge = a.assets.small_image.split('/').pop().replace('.png', '');
  const list = a.status_display_type === STATUS_DISPLAY_DETAILS ? ' · list: line 1' : '';
  return `${[a.details, `${a.state}${count}`].filter(Boolean).join(' / ')} · [${badge}]${list}`;
}

// ---------------------------------------------------------------- the pipe

let isEnabled = () => false;
/** @type {() => {activity: string|null, since: number, project: string|null, task?: string|null}[]} */
let getPanes = () => [];

/** @type {net.Socket|null} */
let socket = null;
let connecting = false;
let connected = false; // READY received, so the card can be set
let user = /** @type {string|null} */ (null); // shown only in Helm's own settings
let lastError = /** @type {string|null} */ (null);
let lastSent = /** @type {string|undefined} */ (undefined); // undefined: nothing sent yet
let lastActivity = /** @type {Record<string, any>|null} */ (null); // the card last sent
let lastDropped = ''; // what Discord last left out of it, logged only on change
let activeSince = /** @type {number|null} */ (null);
let retryIn = 0;
let handshakeTicks = 0;

/** Every message is an 8-byte header (opcode, length, little-endian) plus JSON. */
function encodeRaw(op, body) {
  const header = Buffer.alloc(8);
  header.writeUInt32LE(op, 0);
  header.writeUInt32LE(body.length, 4);
  return Buffer.concat([header, body]);
}
const encode = (op, payload) => encodeRaw(op, Buffer.from(JSON.stringify(payload)));

function pipeTargets() {
  // The test suite pins one exact stand-in; never widen the search past it.
  if (process.env.HELM_DISCORD_PIPE) return [process.env.HELM_DISCORD_PIPE];
  const env = process.env;
  const unixDir = env.XDG_RUNTIME_DIR || env.TMPDIR || env.TMP || env.TEMP || '/tmp';
  // Discord can sit on any of the ten.
  return Array.from({ length: 10 }, (_, n) =>
    process.platform === 'win32'
      ? `\\\\.\\pipe\\discord-ipc-${n}`
      : path.join(unixDir, `discord-ipc-${n}`),
  );
}

// Discord leaves out what it won't take without saying so: an image link it
// can't load, a field it doesn't know. Its echo of the card is the only evidence,
// so compare that with what was sent. This is how Helm can tell from its own side
// whether the member-list line (status_display_type) took.
function noteDropped(echo) {
  if (!lastActivity || !echo || typeof echo !== 'object') return;
  const dropped = ['status_display_type', 'party', 'buttons'].filter(
    (k) => lastActivity[k] !== undefined && echo[k] === undefined,
  );
  for (const k of ['large_image', 'small_image']) {
    if (lastActivity.assets?.[k] && !echo.assets?.[k]) dropped.push(k);
  }
  const note = dropped.join(', ');
  if (note && note !== lastDropped) dbg('discord', `Discord dropped: ${note}`);
  lastDropped = note;
}

// Logged only when it changes: a bad app id comes back on every 15 s retry.
function noteError(message) {
  if (message !== lastError) dbg('discord', `error: ${message}`);
  lastError = message;
}

function drop() {
  const s = socket;
  socket = null;
  connected = false;
  user = null;
  lastSent = undefined; // whatever comes next has to resend the card
  handshakeTicks = 0;
  s?.destroy();
}

function onFrame(op, body) {
  if (op === OP_PING) {
    socket.write(encodeRaw(OP_PONG, body));
    return;
  }
  let msg;
  try {
    msg = JSON.parse(body.toString('utf8'));
  } catch {
    return; // not something we asked for, and nothing depends on it
  }
  if (op === OP_CLOSE) {
    // A bad app id lands here: {code: 4000, message: 'Invalid Client ID'}
    noteError(msg?.message || `Discord closed the connection (${msg?.code})`);
    drop();
    return;
  }
  if (op !== OP_FRAME) return;
  if (msg?.evt === 'READY') {
    connected = true;
    user = msg.data?.user?.global_name || msg.data?.user?.username || null;
    lastError = null;
    dbg('discord', `connected as ${user}`);
    tick(); // put the card up now rather than on the next tick
  } else if (msg?.evt === 'ERROR') {
    // Not resent: lastSent already holds this payload, so a card Discord refuses
    // isn't retried every 5 s, only when its text next changes.
    noteError(msg.data?.message || 'Discord refused the update');
  } else if (msg?.cmd === 'SET_ACTIVITY') {
    lastError = null;
    noteDropped(msg.data);
  }
}

function attach(s) {
  let buf = Buffer.alloc(0);
  // `socket !== s` guards every handler: a socket we have already dropped must
  // not be able to clobber the connection that replaced it.
  s.on('data', (chunk) => {
    if (socket !== s) return;
    buf = Buffer.concat([buf, chunk]);
    // A message can arrive in pieces, or several can arrive at once.
    while (socket === s && buf.length >= 8) {
      const op = buf.readUInt32LE(0);
      const length = buf.readUInt32LE(4);
      if (length > MAX_FRAME_BYTES) {
        noteError('Discord sent a message Helm could not read');
        drop();
        return;
      }
      if (buf.length < 8 + length) return;
      const body = buf.subarray(8, 8 + length);
      buf = buf.subarray(8 + length);
      onFrame(op, body);
    }
  });
  s.on('close', () => {
    if (socket !== s) return;
    if (connected) dbg('discord', 'disconnected');
    drop();
  });
}

function connect(targets = pipeTargets()) {
  const target = targets.shift();
  if (!target) {
    // No pipe answered: Discord isn't running. That outranks any older error,
    // because it is the true reason the card isn't up right now.
    connecting = false;
    lastError = null;
    return;
  }
  connecting = true;
  const s = net.connect(target);
  s.once('error', () => connect(targets));
  s.once('connect', () => {
    connecting = false;
    s.removeAllListeners('error');
    s.on('error', () => {}); // a 'close' always follows, and that handles it
    if (!isEnabled()) {
      s.destroy(); // switched off while we were looking
      return;
    }
    socket = s;
    attach(s);
    s.write(encode(OP_HANDSHAKE, { v: 1, client_id: APP_ID }));
  });
}

function tick() {
  if (!isEnabled()) {
    activeSince = null;
    lastError = null;
    if (socket) drop();
    return; // off means the pipe is never even opened
  }
  // Worked out even with Discord closed, so activeSince stays true to what the
  // panes did, rather than a timer resuming from before a long gap.
  const next = buildActivity(getPanes(), activeSince, Date.now());
  activeSince = next.activeSince;
  if (!socket) {
    if (!connecting && --retryIn <= 0) {
      retryIn = RETRY_TICKS;
      connect();
    }
    return;
  }
  if (!connected) {
    if (++handshakeTicks >= HANDSHAKE_TICKS) {
      noteError('Discord did not answer');
      drop();
    }
    return;
  }
  const json = JSON.stringify(next.activity);
  if (json === lastSent) return;
  lastSent = json;
  lastActivity = next.activity;
  // In the debug drawer on purpose: what Helm has published should be checkable.
  dbg('discord', next.activity ? `card: ${describeCard(next.activity)}` : 'card cleared');
  socket.write(
    encode(OP_FRAME, {
      cmd: 'SET_ACTIVITY',
      args: { pid: process.pid, activity: next.activity },
      nonce: crypto.randomUUID(),
    }),
  );
}

/** Boot hook. Unref'd, so the timer never holds the process open. */
export function startPresence({ enabled, panes }) {
  isEnabled = enabled;
  getPanes = panes;
  tick();
  setInterval(tick, TICK_MS).unref();
}

/** Run now rather than on the next tick, so the settings toggle answers at once. */
export function syncPresence() {
  retryIn = 0;
  tick();
}

/** Snapshot for GET /api/discord. */
export function presenceInfo() {
  return {
    enabled: isEnabled(),
    connected,
    // Looking, or waiting on READY: the UI must not call that "Discord is closed".
    connecting: connecting || (socket !== null && !connected),
    user,
    error: lastError,
  };
}

/** Shutdown: dropping the connection is what takes the card down. */
export function stopPresence() {
  isEnabled = () => false; // a tick in the exit window must not reconnect
  if (socket) drop();
}
