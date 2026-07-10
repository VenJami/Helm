// Per-workspace status polling for the sidebar: git branch/dirty/ahead-behind
// and dev-server up/down. Extracted from App.tsx (P3-2). setServerInfo is
// returned so setting/clearing a workspace's port can update the dot without
// waiting out the next poll.

import { useEffect, useState } from 'react';
import { api } from '../api';
import type { GitInfo, ServerInfo } from '../types';

export function useWorkspaceStatus() {
  const [gitInfo, setGitInfo] = useState<Record<string, GitInfo>>({});
  const [serverInfo, setServerInfo] = useState<Record<string, ServerInfo>>({});

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

  return { gitInfo, serverInfo, setServerInfo };
}
