// Per-workspace status polling for the sidebar: git branch/dirty/ahead-behind
// and dev-server up/down. Extracted from App.tsx (P3-2). setServerInfo is
// returned so setting/clearing a workspace's port can update the dot without
// waiting out the next poll.

import { useCallback, useEffect, useState } from 'react';
import { api } from '../api';
import type { GitInfo, ServerInfo, TunnelsResponse } from '../types';

const NO_TUNNELS: TunnelsResponse = {
  available: false,
  version: null,
  installHint: '',
  installCommand: null,
  installDocs: '',
  ttlMs: 0,
  tunnels: [],
};

export function useWorkspaceStatus() {
  const [gitInfo, setGitInfo] = useState<Record<string, GitInfo>>({});
  const [serverInfo, setServerInfo] = useState<Record<string, ServerInfo>>({});
  const [tunnelState, setTunnelState] = useState<TunnelsResponse>(NO_TUNNELS);

  // Git branch/dirty per workspace — slower poll than sessions (6 s); branches
  // and working-tree state change on a human timescale, and it spawns git.
  useEffect(() => {
    const pull = () =>
      api
        .getWorkspacesGit()
        .then((list) => setGitInfo(Object.fromEntries(list.map((g) => [g.id, g]))))
        .catch(() => {});
    pull();
    const timer = setInterval(pull, 6000);
    return () => clearInterval(timer);
  }, []);

  // Dev-server up/down per workspace — polled a touch faster than git (4 s), so
  // starting/stopping a project server reflects quickly. Just a TCP connect.
  useEffect(() => {
    const pull = () =>
      api
        .getWorkspacesServers()
        .then((list) => setServerInfo(Object.fromEntries(list.map((s) => [s.id, s]))))
        .catch(() => {});
    pull();
    const timer = setInterval(pull, 4000);
    return () => clearInterval(timer);
  }, []);

  // Public share links — same 4 s cadence as the dev-server dot they sit next
  // to. `refreshTunnels` is exported so sharing/stopping updates the PUBLIC
  // pill immediately instead of waiting out a tick.
  const refreshTunnels = useCallback(
    () =>
      api
        .getTunnels()
        .then(setTunnelState)
        .catch(() => {}),
    [],
  );

  useEffect(() => {
    refreshTunnels();
    const timer = setInterval(refreshTunnels, 4000);
    return () => clearInterval(timer);
  }, [refreshTunnels]);

  const tunnels = Object.fromEntries(tunnelState.tunnels.map((t) => [t.workspaceId, t]));

  return { gitInfo, serverInfo, setServerInfo, tunnels, tunnelState, refreshTunnels };
}
