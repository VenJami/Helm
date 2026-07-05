export interface SessionInfo {
  id: string;
  name: string;
  color: string; // #rrggbb accent
  workspace: string;
  profile: string | null;
  status: 'running' | 'exited' | 'dead'; // dead = PTY lost to a server restart
  exitCode: number | null;
  activity: 'working' | 'waiting' | 'idle' | null; // from Claude Code hooks
  activitySince: string | null; // ISO — when activity last changed ("working 7m")
  activityNote: string | null; // latest Notification message while waiting (why it's blocked)
  summary: string | null; // auto-title from the conversation's first prompt (search/palette)
  canResume: boolean;    // claude session id captured → revive resumes it
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
  port?: number;    // project's dev-server port; absent = no server check
}

// Per-workspace dev-server liveness for the sidebar. Only workspaces with a
// configured port appear; `up` = 127.0.0.1:port accepted a connection.
export interface ServerInfo {
  id: string;
  port: number;
  up: boolean;
}

// Per-workspace git status for the sidebar. branch null = not a git repo
// (or git unavailable). Best-effort, refreshed on a slow poll.
export interface GitInfo {
  id: string;
  branch: string | null;
  dirty: boolean;   // uncommitted changes present
  ahead: number;    // commits ahead of upstream
  behind: number;   // commits behind upstream
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

export interface HelmSettings {
  autoRevive: boolean; // respawn dead panes automatically at server start
}

// claude-CLI drift diagnostics — Helm reads undocumented claude formats, so
// when they change, features quietly return zeros. These surface it loudly.
export interface DriftWarning {
  key: string;     // stable id (dedupes repeats; also the dismiss key)
  message: string; // human-readable, plain language
  since: string;   // ISO — first seen
  count: number;   // times observed
}

export interface Diagnostics {
  claude: {
    version: string | null;
    ok: boolean;      // false = not found or below the tested floor
    floor: string;    // version Helm was verified against
    checked: boolean; // has the boot-time `claude --version` returned yet
    error: string | null;
  };
  warnings: DriftWarning[];
}

// State of the server's own console window (start-helm.cmd terminal).
// supported:false = non-Windows or launched detached with no console → hide the
// toggle button entirely.
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
