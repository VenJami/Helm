// A pane "folder" — Chrome's tab groups, for panes. Named, colored, and panes
// are filed into it by id. The folder owns the color: a pane in one renders in
// the folder's color (see lib/categories.ts), so recoloring the folder
// recolors every pane in it at once.
export interface Category {
  id: string;
  name: string;
  color: string; // #rrggbb
}

export interface SessionInfo {
  id: string;
  name: string;
  color: string; // #rrggbb accent — used when the pane is in no category
  categoryId: string | null; // folder this pane belongs to, if any
  favorite: boolean; // starred — the one thing the "favorites only" filter keeps
  workspace: string;
  profile: string | null;
  kind: 'claude' | 'dev'; // 'dev' = the workspace's dev-server pane, not a claude session
  command: string | null; // dev panes: the shell command they run
  status: 'running' | 'exited' | 'dead'; // dead = PTY lost to a server restart
  exitCode: number | null;
  activity: 'working' | 'waiting' | 'idle' | null; // from Claude Code hooks
  activitySince: string | null; // ISO — when activity last changed ("working 7m")
  activityNote: string | null; // latest Notification message while waiting (why it's blocked)
  // A tool call claude is holding open while the floating HUD offers
  // Approve/Deny. Only ever set while the HUD is open (it heartbeats to arm
  // the channel); null everywhere else, including for dev panes. Flat fields,
  // not a nested object — useSessionsPoll's shallowEqual compares with ===.
  pendingId: string | null; // Helm's own id for the held request — what /approve answers
  pendingTool: string | null; // 'Bash', 'Edit', an MCP tool name…
  pendingDetail: string | null; // one human line: "Bash: npm run db:migrate"
  pendingSince: string | null; // ISO — when it arrived
  summary: string | null; // auto-title from the conversation's first prompt (search/palette)
  canResume: boolean; // claude session id captured → revive resumes it
  hasTranscript: boolean;
  attached: number;
  createdAt: string;
}

export interface ModelUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  turns: number;
  cost?: number; // rough $ estimate from published per-model prices
}

export interface UsageInfo {
  available: boolean;
  models?: Record<string, ModelUsage>;
}

// Per-window totals + per-model breakdown share the same shape now.
export type WindowModelUsage = ModelUsage;

export interface UsageWindow {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  turns: number;
  cost: number; // sum of per-model estimates in this window
  models: Record<string, WindowModelUsage>;
}

export interface AccountUsage {
  account: string; // 'default' or profile name
  email: string | null;
  lastActive: number | null; // ms epoch of the most recent counted usage
  // rolling slices: h1, h5, h10, h24, d7, d30 + 'all' — each with its own
  // per-model breakdown so the UI selector re-slices the whole card
  windows: Record<string, UsageWindow>;
}

export interface Workspace {
  id: string;
  name: string;
  dir: string;
  profile?: string; // pinned account name; absent = default account
  port?: number; // project's dev-server port; absent = no server check
  startCommands?: string[]; // what ▶ runs — one dev pane per command (a project
  // can need a backend AND a frontend watcher)
  // Show this project's panes in the floating notch? Absent = yes. Muting is
  // the escape hatch for a project you never want glancing at; the notch drops
  // long-idle panes on its own without any of this.
  notch?: boolean;
}

// Per-workspace dev-server liveness for the sidebar. Only workspaces with a
// configured port appear; `up` = 127.0.0.1:port accepted a connection.
export interface ServerInfo {
  id: string;
  port: number;
  up: boolean;
}

// A public share link for a workspace's dev server (Cloudflare quick tunnel).
// These URLs are UNAUTHENTICATED — anyone holding one reaches the dev server —
// so the UI warns before creating one, flags it loudly while live, and the
// server expires it. See server/src/tunnel.mjs.
export interface TunnelInfo {
  workspaceId: string;
  port: number;
  status: 'starting' | 'live' | 'error';
  url: string | null; // https://<random>.trycloudflare.com once cloudflared reports it
  error: string | null;
  startedAt: number; // ms epoch
  expiresAt: number; // ms epoch — server self-kills the tunnel at this point
}

export interface TunnelsResponse {
  available: boolean; // is cloudflared on PATH? false → show installHint, no share button
  version: string | null;
  installHint: string; // platform-specific install command (short, for tooltips)
  installCommand: string | null; // what "Install it for me" runs; null = no one-liner here
  installDocs: string; // Cloudflare's download page, for platforms without one
  ttlMs: number; // how long a link lives, and what "extend" adds
  tunnels: TunnelInfo[];
}

// Per-workspace git status for the sidebar. branch null = not a git repo
// (or git unavailable). Best-effort, refreshed on a slow poll.
export interface GitInfo {
  id: string;
  branch: string | null;
  dirty: boolean; // uncommitted changes present
  ahead: number; // commits ahead of upstream
  behind: number; // commits behind upstream
}

export interface LogEntry {
  seq: number;
  t: string; // ISO timestamp
  tag: string;
  msg: string;
}

export interface LogsResponse {
  seq: number;
  startedAt: string; // ISO — when this server process started (staleness check)
  pid: number;
  entries: LogEntry[];
}

// ---- WebSocket protocol -----------------------------------------------
// The wire contract for /ws, carrying ALL terminal I/O. The server side lives
// in server/index.mjs (`attach` + the PTY onData/onExit broadcasts) — if you
// rename or reshape a message, change BOTH sides; the server mirrors this
// union in a JSDoc comment.

// server → client
export type WsServerMsg =
  | { type: 'replay'; data: string } // ring-buffer snapshot on (re)attach
  | { type: 'data'; data: string } // live PTY output
  | { type: 'exit'; code: number | null }; // process ended; socket closes after

// client → server
export type WsClientMsg =
  | { type: 'input'; data: string } // keystrokes/paste → PTY stdin
  | { type: 'resize'; cols: number; rows: number };

export interface HelmSettings {
  autoRevive: boolean; // respawn dead panes automatically at server start
  // The native notch hides itself while Helm's own window is on screen. Server
  // state, not localStorage: the notch runs in its own WebView2 profile and
  // shares no storage with the browser.
  notchFollowsHelm: boolean;
  // ...and when it IS on screen, rests as a strip of status lights, expanding
  // to the full list when the cursor reaches it.
  notchAutoCompact: boolean;
}

// claude-CLI drift diagnostics — Helm reads undocumented claude formats, so
// when they change, features quietly return zeros. These surface it loudly.
export interface DriftWarning {
  key: string; // stable id (dedupes repeats; also the dismiss key)
  message: string; // human-readable, plain language
  since: string; // ISO — first seen
  count: number; // times observed
}

export interface Diagnostics {
  claude: {
    version: string | null;
    ok: boolean; // false = not found or below the tested floor
    floor: string; // version Helm was verified against
    checked: boolean; // has the boot-time `claude --version` returned yet
    error: string | null;
  };
  warnings: DriftWarning[];
}

// "A newer Helm is on GitHub" — the server checks the repo's latest RELEASE
// (not commits on main) at boot and every 2 h, and caches the answer here.
// `available` is the only field the banner reacts to; errors stay silent
// because being offline is normal for a local-first app.
export interface UpdateInfo {
  current: string; // this checkout's package version
  latest: string | null; // latest published release tag, `v` stripped
  available: boolean; // latest is strictly newer than current
  url: string | null; // release page (notes)
  name: string | null; // release title
  publishedAt: string | null; // ISO
  checkedAt: string | null; // ISO — null until the first check returns
  disabled: boolean; // HELM_NO_UPDATE_CHECK=1: no network call is ever made
  error: string | null; // last failure (offline, rate limit) — not shown in the UI
  commits: CommitsBehind | null; // null whenever the answer would be a guess
}

// Unreleased work: how far the tracked branch is ahead of this checkout. The
// quiet half of the update check — most people run Helm from a `git clone` of
// main, where the last release can be weeks behind. Only ever set when the
// checkout is plainly behind (never when it carries commits of its own).
export interface CommitsBehind {
  ahead: number; // commits on main this copy doesn't have
  url: string | null; // GitHub compare page for exactly that range
  latest: string | null; // newest commit's subject line
  latestAt: string | null; // ISO — when that commit landed
}

// State of the server's own console window (start-helm.cmd terminal).
// supported:false = non-Windows or launched detached with no console → hide the
// toggle button entirely.
// The native notch window (desktop/HelmNotch). `supported` is false off Windows
// and in a checkout that has never built it, so the UI can hide the entry
// rather than offer something that cannot work.
export interface NotchState {
  supported: boolean;
  running: boolean;
  started?: boolean;
}

export interface ConsoleState {
  supported: boolean;
  visible: boolean;
}

export interface Profile {
  name: string;
  email: string | null; // null = profile exists but /login not run yet
}

export interface ProfilesInfo {
  // `mapped` = named profile the default account collapses onto (same login),
  // or null when default is its own distinct account.
  default: { email: string | null; mapped: string | null };
  profiles: Profile[];
}

// A cross-window "jump to this pane" request. The HUD raises one when it runs
// as its own page (/hud) and cannot reach the main window's handler directly;
// `at` doubles as the cursor the main window's long poll resumes from, so a
// request landing between reconnects still gets delivered.
export interface FocusRequest {
  sessionId: string | null;
  at: number;
}
