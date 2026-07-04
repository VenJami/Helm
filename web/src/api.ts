import type { AccountUsage, ConsoleState, GitInfo, HelmSettings, LogsResponse, ProfilesInfo, ServerInfo, SessionInfo, UsageInfo, Workspace } from './types';

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
    const body = await res.json().catch(() => ({} as { error?: string }));
    throw new Error(body.error || res.statusText);
  }
  return res.json();
}

export const api = {
  listSessions: () => req<SessionInfo[]>('/sessions'),
  createSession: (workspace: string, profile: string | undefined, cols: number, rows: number) =>
    req<SessionInfo>('/sessions', {
      method: 'POST',
      body: JSON.stringify({ workspace, profile, cols, rows }),
    }),
  killSession: (id: string) => req<{ ok: boolean }>(`/sessions/${id}`, { method: 'DELETE' }),
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
      const body = await res.json().catch(() => ({} as { error?: string }));
      throw new Error(body.error || res.statusText);
    }
    return res.json() as Promise<{ ok: boolean; path: string }>;
  },
  updateSession: (id: string, patch: { name?: string; color?: string }) =>
    req<SessionInfo>(`/sessions/${id}`, { method: 'PATCH', body: JSON.stringify(patch) }),
  getGlobalUsage: () => req<AccountUsage[]>('/usage'),
  getLogs: (after: number) => req<LogsResponse>(`/logs?after=${after}`),
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
    patch: { name?: string; dir?: string; profile?: string | null; port?: number | null },
  ) =>
    req<Workspace>(`/workspaces/${id}`, { method: 'PATCH', body: JSON.stringify(patch) }),
  removeWorkspace: (id: string) => req<{ ok: boolean }>(`/workspaces/${id}`, { method: 'DELETE' }),

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
