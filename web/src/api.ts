import type {
  AccountUsage,
  ConsoleState,
  Diagnostics,
  GitInfo,
  HelmSettings,
  LogsResponse,
  ProfilesInfo,
  ServerInfo,
  SessionInfo,
  TunnelInfo,
  TunnelsResponse,
  UpdateInfo,
  UsageInfo,
  Workspace,
} from './types';

const TOKEN = (window as unknown as { __HELM_TOKEN__: string }).__HELM_TOKEN__;

async function req<T>(path: string, opts: RequestInit = {}): Promise<T> {
  const res = await fetch('/api' + path, {
    ...opts,
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      'Content-Type': 'application/json',
      ...opts.headers,
    },
  });
  if (res.status === 401) {
    // Our token no longer matches the server (token was rotated) — a fresh
    // page load picks up the current one. Guard against a reload loop.
    const last = Number(sessionStorage.getItem('helm.reload401') || 0);
    if (Date.now() - last > 30_000) {
      sessionStorage.setItem('helm.reload401', String(Date.now()));
      location.reload();
    }
    throw new Error('session token expired — reloading page');
  }
  if (!res.ok) {
    const body = await res.json().catch(() => ({}) as { error?: string });
    throw new ApiError(body.error || res.statusText, res.status, body);
  }
  return res.json();
}

// Carries the server's JSON body, so a caller can react to a flag on it (e.g.
// `needsCommand` on ▶ → offer to ask claude) instead of matching on message text.
export class ApiError extends Error {
  status: number;
  body: Record<string, unknown>;
  constructor(message: string, status: number, body: Record<string, unknown>) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.body = body;
  }
}

export const api = {
  listSessions: () => req<SessionInfo[]>('/sessions'),
  createSession: (workspace: string, profile: string | undefined, cols: number, rows: number) =>
    req<SessionInfo>('/sessions', {
      method: 'POST',
      body: JSON.stringify({ workspace, profile, cols, rows }),
    }),
  killSession: (id: string) => req<{ ok: boolean }>(`/sessions/${id}`, { method: 'DELETE' }),
  // Stop a pane's process but keep the pane (its output stays readable).
  stopSession: (id: string) => req<SessionInfo>(`/sessions/${id}/stop`, { method: 'POST' }),
  reviveSession: (id: string, cols: number, rows: number) =>
    req<SessionInfo>(`/sessions/${id}/revive`, {
      method: 'POST',
      body: JSON.stringify({ cols, rows }),
    }),
  // Move a pane to another account: claude restarts inside the same pane and
  // resumes the same conversation there. profile null = the default account.
  switchProfile: (id: string, profile: string | null, cols: number, rows: number) =>
    req<SessionInfo>(`/sessions/${id}/switch-profile`, {
      method: 'POST',
      body: JSON.stringify({ profile, cols, rows }),
    }),
  getUsage: (id: string) => req<UsageInfo>(`/sessions/${id}/usage`),
  // Raw-body upload (not the JSON helper): the server saves the file locally
  // and types its path into the pane, like native-terminal drag-drop.
  attachFile: async (id: string, file: Blob, name: string) => {
    const res = await fetch(`/api/sessions/${id}/attach?name=${encodeURIComponent(name)}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/octet-stream' },
      body: file,
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}) as { error?: string });
      throw new Error(body.error || res.statusText);
    }
    return res.json() as Promise<{ ok: boolean; path: string }>;
  },
  // Dictation: clean a raw speech transcript into a written instruction. Never
  // rejects on a bad polish — the server answers with the raw text and
  // `polished: false` rather than losing what you said.
  polish: (id: string, text: string) =>
    req<{ text: string; polished: boolean; cost: number | null; ms: number }>(
      `/sessions/${id}/polish`,
      { method: 'POST', body: JSON.stringify({ text }) },
    ),
  // Type into a pane's input without submitting — you press Enter.
  typeText: (id: string, text: string) =>
    req<{ ok: boolean }>(`/sessions/${id}/type`, {
      method: 'POST',
      body: JSON.stringify({ text }),
    }),
  updateSession: (id: string, patch: { name?: string; color?: string }) =>
    req<SessionInfo>(`/sessions/${id}`, { method: 'PATCH', body: JSON.stringify(patch) }),
  getGlobalUsage: () => req<AccountUsage[]>('/usage'),
  getLogs: (after: number) => req<LogsResponse>(`/logs?after=${after}`),
  getDiagnostics: () => req<Diagnostics>('/diagnostics'),
  getUpdate: () => req<UpdateInfo>('/update'),
  broadcast: (text: string, sessionIds: string[]) =>
    req<{ ok: boolean; results: Record<string, 'sent' | 'skipped'> }>('/broadcast', {
      method: 'POST',
      body: JSON.stringify({ text, sessionIds }),
    }),
  getSettings: () => req<HelmSettings>('/settings'),
  updateSettings: (patch: Partial<HelmSettings>) =>
    req<HelmSettings>('/settings', { method: 'PATCH', body: JSON.stringify(patch) }),

  getConsole: () => req<ConsoleState>('/console'),
  setConsole: (visible: boolean) =>
    req<ConsoleState>('/console', { method: 'POST', body: JSON.stringify({ visible }) }),

  listWorkspaces: () => req<Workspace[]>('/workspaces'),
  getWorkspacesGit: () => req<GitInfo[]>('/workspaces/git'),
  getWorkspacesServers: () => req<ServerInfo[]>('/workspaces/servers'),
  addWorkspace: (name: string, dir: string, profile?: string) =>
    req<Workspace>('/workspaces', { method: 'POST', body: JSON.stringify({ name, dir, profile }) }),
  updateWorkspace: (
    id: string,
    patch: {
      name?: string;
      dir?: string;
      profile?: string | null;
      port?: number | null;
      startCommands?: string[] | null;
    },
  ) => req<Workspace>(`/workspaces/${id}`, { method: 'PATCH', body: JSON.stringify(patch) }),
  // ▶ — run the project's start command(s), one dev pane each (created on first
  // use). Throws with `needsCommand` when nothing is configured or detectable.
  startWorkspace: (id: string, cols: number, rows: number) =>
    req<{ sessions: SessionInfo[]; started: number }>(`/workspaces/${id}/start`, {
      method: 'POST',
      body: JSON.stringify({ cols, rows }),
    }),
  // ■ — stop every dev pane this project has running (the panes stay).
  stopWorkspace: (id: string) =>
    req<{ stopped: number; sessions: SessionInfo[] }>(`/workspaces/${id}/stop`, { method: 'POST' }),
  // Ask claude (headless, read-only) how this project starts. Suggests only —
  // the commands land in the editor for the owner to accept.
  suggestStart: (id: string) =>
    req<{ commands: string[]; cost: number | null }>(`/workspaces/${id}/suggest-start`, {
      method: 'POST',
    }),
  removeWorkspace: (id: string) => req<{ ok: boolean }>(`/workspaces/${id}`, { method: 'DELETE' }),

  // Public share links (Cloudflare quick tunnels). The URLs are
  // UNAUTHENTICATED by design of the free tier — callers must warn first.
  getTunnels: () => req<TunnelsResponse>('/tunnels'),
  // Runs the install in a visible dev pane — never silently in the background.
  installCloudflared: (cols: number, rows: number) =>
    req<SessionInfo>('/tunnels/install', {
      method: 'POST',
      body: JSON.stringify({ cols, rows }),
    }),
  shareWorkspace: (id: string, port?: number) =>
    req<TunnelInfo>(`/workspaces/${id}/tunnel`, {
      method: 'POST',
      body: JSON.stringify({ port }),
    }),
  extendShare: (id: string) =>
    req<TunnelInfo>(`/workspaces/${id}/tunnel/extend`, { method: 'POST' }),
  unshareWorkspace: (id: string) =>
    req<{ ok: boolean }>(`/workspaces/${id}/tunnel`, { method: 'DELETE' }),

  listProfiles: () => req<ProfilesInfo>('/profiles'),
  deleteProfile: (name: string) =>
    req<{ ok: boolean }>(`/profiles/${encodeURIComponent(name)}`, { method: 'DELETE' }),
  renameProfile: (name: string, nextName: string) =>
    req<{ ok: boolean }>(`/profiles/${encodeURIComponent(name)}`, {
      method: 'PATCH',
      body: JSON.stringify({ name: nextName }),
    }),
};

export const wsUrl = (sessionId: string) =>
  `ws://${location.host}/ws?session=${sessionId}&token=${TOKEN}`;
