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
}

export interface UsageInfo {
  available: boolean;
  models?: Record<string, ModelUsage>;
}

export interface WindowModelUsage {
  input: number; // incl. cache writes
  output: number;
  cacheRead: number;
  turns: number;
}

export interface UsageWindow {
  in: number;
  out: number;
  models: Record<string, WindowModelUsage>;
}

export interface AccountUsage {
  account: string; // 'default' or profile name
  email: string | null;
  // rolling slices: h1, h5, h10, h24, d7, d30 + 'all' — each with its own
  // per-model breakdown so the UI selector re-slices the whole card
  windows: Record<string, UsageWindow>;
}

export interface Workspace {
  id: string;
  name: string;
  dir: string;
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

export interface Profile {
  name: string;
  email: string | null; // null = profile exists but /login not run yet
}

export interface ProfilesInfo {
  default: { email: string | null };
  profiles: Profile[];
}
