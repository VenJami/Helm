import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from './api';
import { accountLabel, foldMappedDefault } from './accounts';
import type { AccountUsage, GitInfo, LogEntry, Profile, ServerInfo, SessionInfo, Workspace } from './types';
import { Sidebar } from './components/Sidebar';
import { TerminalPane } from './components/TerminalPane';
import { Modal } from './components/Modal';
import { ProfileSelect } from './components/ProfileSelect';
import { TargetCursor } from './components/TargetCursor';
import { Toaster, toast } from './components/Toaster';
import { DriftBanner } from './components/DriftBanner';
import { CommandPalette } from './components/CommandPalette';
import { IconBug, IconMinus, IconPanelLeftOpen, IconPencil, IconPlus, IconTrash } from './components/Icons';
import {
  AnimateIcon, IconBellOff, IconBellRing, IconChart, IconNfc, IconRefreshCcw, IconSearch, IconTerminal,
} from './components/AnimatedIcons';

type Dialog =
  | { kind: 'new-profile' }
  | { kind: 'manage-profiles' }
  | { kind: 'edit-profile'; profile: Profile }
  | { kind: 'delete-profile'; profile: Profile }
  | { kind: 'usage' }
  | { kind: 'broadcast' }
  | { kind: 'add-workspace' }
  | null;

// ⌘K on Mac, Ctrl K elsewhere — for the command-palette hint.
const IS_MAC = typeof navigator !== 'undefined' && /Mac/i.test(navigator.platform);

const fmt = (n: number) =>
  n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(1) + 'k' : String(n);

// Field-by-field equality for flat, primitive-only objects (SessionInfo,
// Profile). Used to reuse the previous poll's object reference when nothing
// changed, so React.memo on TerminalPane can actually skip untouched panes
// instead of every prop looking new every 3 s.
function shallowEqual<T extends object>(a: T, b: T): boolean {
  const keys = Object.keys(a) as (keyof T)[];
  if (keys.length !== Object.keys(b).length) return false;
  return keys.every((k) => a[k] === b[k]);
}

// Rough dollar figure — cents matter at the low end, so surface <$0.01 rather
// than a flat $0.00 that reads as "free".
const fmtCost = (n: number) =>
  n <= 0 ? '$0'
    : n < 0.01 ? '<$0.01'
    : n < 100 ? '$' + n.toFixed(2)
    : '$' + Math.round(n).toLocaleString();

// "just now" / "2h ago" / "3d ago" from an epoch-ms timestamp (null = never).
const relTime = (ms: number | null): string => {
  if (!ms) return 'never used';
  const s = Math.max(0, (Date.now() - ms) / 1000);
  if (s < 90) return 'used just now';
  const m = s / 60;
  if (m < 60) return `used ${Math.round(m)}m ago`;
  const h = m / 60;
  if (h < 24) return `used ${Math.round(h)}h ago`;
  const d = h / 24;
  if (d < 7) return `used ${Math.round(d)}d ago`;
  return `used ${Math.round(d / 7)}w ago`;
};

const USAGE_WINDOWS = [
  ['h1', '1 h'],
  ['h5', '5 h'],
  ['h10', '10 h'],
  ['h24', '24 h'],
  ['d7', '7 d'],
  ['d30', '30 d'],
  ['all', 'all'],
] as const;

export function App() {
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  // Sidebar order — presentational, kept in localStorage; unlisted (new)
  // workspaces fall to the end in fetch order.
  const [wsOrder, setWsOrder] = useState<string[]>(() => {
    try {
      return JSON.parse(localStorage.getItem('helm.wsorder') || '[]');
    } catch {
      return [];
    }
  });
  const orderedWorkspaces = useMemo(() => {
    const idx = new Map(wsOrder.map((id, i) => [id, i]));
    return [...workspaces].sort(
      (a, b) => (idx.get(a.id) ?? Infinity) - (idx.get(b.id) ?? Infinity),
    );
  }, [workspaces, wsOrder]);
  const [dragWsId, setDragWsId] = useState<string | null>(null);
  const [dragOverWsId, setDragOverWsId] = useState<string | null>(null);
  const dropWorkspace = (targetId: string) => {
    if (!dragWsId || dragWsId === targetId) return;
    const ids = orderedWorkspaces.map((w) => w.id);
    const from = ids.indexOf(dragWsId);
    const to = ids.indexOf(targetId);
    if (from === -1 || to === -1) return;
    ids.splice(from, 1);
    ids.splice(to, 0, dragWsId);
    setWsOrder(ids);
    localStorage.setItem('helm.wsorder', JSON.stringify(ids));
  };
  const [gitInfo, setGitInfo] = useState<Record<string, GitInfo>>({});
  const [serverInfo, setServerInfo] = useState<Record<string, ServerInfo>>({});
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [defaultEmail, setDefaultEmail] = useState<string | null>(null);
  const [defaultMapped, setDefaultMapped] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(
    localStorage.getItem('helm.workspaceId'),
  );
  const [profileChoice, setProfileChoice] = useState('');
  const [dialog, setDialog] = useState<Dialog>(null);
  const [draftName, setDraftName] = useState('');
  const [draftError, setDraftError] = useState('');
  const [notify, setNotify] = useState(
    () => localStorage.getItem('helm.notify') === '1' && Notification.permission === 'granted',
  );
  const [globalUsage, setGlobalUsage] = useState<AccountUsage[] | null>(null);
  // 5h ≈ the subscription session window — the slice that matters most
  const [usageWindow, setUsageWindow] = useState('d7');
  // Maximize/minimize layout survives a reload — restored from localStorage,
  // pruned against the live session list once it loads (stale ids dropped).
  const [maximizedId, setMaximizedId] = useState<string | null>(
    () => localStorage.getItem('helm.maximized'),
  );
  const [minimizedIds, setMinimizedIds] = useState<Set<string>>(() => {
    try {
      return new Set(JSON.parse(localStorage.getItem('helm.minimized') || '[]') as string[]);
    } catch {
      return new Set();
    }
  });
  useEffect(() => {
    localStorage.setItem('helm.minimized', JSON.stringify([...minimizedIds]));
  }, [minimizedIds]);
  useEffect(() => {
    if (maximizedId) localStorage.setItem('helm.maximized', maximizedId);
    else localStorage.removeItem('helm.maximized');
  }, [maximizedId]);
  // Drop restored ids that point at sessions which no longer exist (killed while
  // Helm was closed). Guarded on a loaded list so pre-fetch emptiness is ignored.
  useEffect(() => {
    if (!sessions.length) return;
    const live = new Set(sessions.map((s) => s.id));
    setMinimizedIds((prev) => {
      let changed = false;
      const next = new Set<string>();
      for (const id of prev) (live.has(id) ? next.add(id) : (changed = true));
      return changed ? next : prev;
    });
    setMaximizedId((prev) => (prev && !live.has(prev) ? null : prev));
  }, [sessions]);
  // Global terminal font size (px), shared by every pane and user-adjustable.
  const [fontSize, setFontSize] = useState<number>(() => {
    const n = Number(localStorage.getItem('helm.fontSize'));
    return Number.isFinite(n) && n >= 11 && n <= 20 ? n : 13;
  });
  const changeFont = (delta: number) =>
    setFontSize((f) => {
      const next = Math.min(20, Math.max(11, f + delta));
      localStorage.setItem('helm.fontSize', String(next));
      return next;
    });
  // Ctrl+K command palette / quick pane switcher.
  const [paletteOpen, setPaletteOpen] = useState(false);
  // Add-workspace modal fields.
  const [wsDir, setWsDir] = useState('');
  const [wsName2, setWsName2] = useState('');
  const [wsProfile, setWsProfile] = useState('');
  const [wsPort, setWsPort] = useState('');
  const [wsAddError, setWsAddError] = useState('');
  // Pane that briefly pulses after a jump/cycle so the eye can find it.
  const [flashId, setFlashId] = useState<string | null>(null);
  // Which pane's terminal last held focus — the anchor for Ctrl+Shift+←/→ cycling.
  const activePaneRef = useRef<string | null>(null);
  const flashTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [sidebarHidden, setSidebarHidden] = useState(
    () => localStorage.getItem('helm.sidebarHidden') === '1',
  );
  const toggleSidebar = () =>
    setSidebarHidden((h) => {
      const next = !h;
      localStorage.setItem('helm.sidebarHidden', next ? '1' : '0');
      return next;
    });
  const [autoRevive, setAutoRevive] = useState(false); // mirrors server settings
  // Broadcast dialog: one instruction typed into several panes at once
  const [bcText, setBcText] = useState('');
  const [bcIds, setBcIds] = useState<Set<string>>(new Set());
  const [bcBusy, setBcBusy] = useState(false);
  const [bcError, setBcError] = useState('');

  // Server console window (start-helm.cmd terminal) show/hide toggle.
  const [consoleState, setConsoleState] = useState<{ supported: boolean; visible: boolean }>(
    { supported: false, visible: true },
  );
  useEffect(() => {
    api.getConsole().then(setConsoleState).catch(() => {});
  }, []);
  const toggleConsole = async () => {
    try {
      setConsoleState(await api.setConsole(!consoleState.visible));
    } catch (err) {
      toast.error((err as Error).message);
    }
  };

  // Debug drawer: tails the server's event log while open
  const [debugOpen, setDebugOpen] = useState(false);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  // Which server process we're talking to — catches stale servers on 7777
  const [serverMeta, setServerMeta] = useState<{ startedAt: string; pid: number } | null>(null);
  const logSeqRef = useRef(0);
  const logEndRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!debugOpen) return;
    let live = true;
    const pull = () =>
      api.getLogs(logSeqRef.current).then(({ seq, entries, startedAt, pid }) => {
        if (!live) return;
        setServerMeta({ startedAt, pid });
        logSeqRef.current = seq;
        if (entries.length) setLogs((prev) => [...prev, ...entries].slice(-500));
      }).catch(() => {});
    pull();
    const timer = setInterval(pull, 2000);
    return () => { live = false; clearInterval(timer); };
  }, [debugOpen]);
  useEffect(() => {
    logEndRef.current?.scrollIntoView({ block: 'end' });
  }, [logs]);

  // Suppress the browser's default right-click menu app-wide — the owner finds
  // it distracting. Real form fields (the add-workspace inputs, broadcast box)
  // keep their native menu so paste still works; the terminal's hidden textarea
  // does NOT, so right-clicking a pane no longer pops the browser menu. The
  // sidebar's own workspace menu (Sidebar.tsx) opens on top of this.
  useEffect(() => {
    const onCtx = (e: MouseEvent) => {
      const t = e.target as HTMLElement | null;
      if (t?.closest('input, textarea') && !t.closest('.xterm')) return;
      e.preventDefault();
    };
    document.addEventListener('contextmenu', onCtx);
    return () => document.removeEventListener('contextmenu', onCtx);
  }, []);

  const openUsage = () => {
    setDialog({ kind: 'usage' });
    setGlobalUsage(null);
    api.getGlobalUsage().then(setGlobalUsage).catch(() => setGlobalUsage([]));
  };

  // When the bare default account is the same login as a named profile, fold
  // default's history into that profile's row and hide the standalone default
  // row — same collapse the profile picker does. Grand total is unchanged.
  const usageRows = useMemo(
    () => (globalUsage ? foldMappedDefault(globalUsage, defaultMapped) : null),
    [globalUsage, defaultMapped],
  );

  // Esc leaves maximized mode
  useEffect(() => {
    if (!maximizedId) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMaximizedId(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [maximizedId]);

  // Ctrl+K / Cmd+K toggles the command palette (quick pane/workspace switcher).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && (e.key === 'k' || e.key === 'K')) {
        e.preventDefault();
        setPaletteOpen((o) => !o);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // Previous activity per session, for edge-triggered notifications.
  // undefined entry = first sighting (never notify on first sighting).
  const prevActivityRef = useRef<Map<string, SessionInfo['activity']>>(new Map());
  const notifyRef = useRef(notify);
  notifyRef.current = notify;

  const maybeNotify = useCallback((list: SessionInfo[]) => {
    const prev = prevActivityRef.current;
    const next = new Map<string, SessionInfo['activity']>();
    for (const s of list) next.set(s.id, s.activity);

    // No alerts while the user is actively looking at Helm
    const shouldAlert =
      notifyRef.current && Notification.permission === 'granted' && !document.hasFocus();
    if (shouldAlert) {
      for (const s of list) {
        if (!prev.has(s.id) || s.status !== 'running') continue;
        const was = prev.get(s.id);
        const where = s.workspace.split(/[\\/]/).filter(Boolean).pop();
        let text: string | null = null;
        if (s.activity === 'waiting' && was !== 'waiting') {
          // Prefer the hook's own message ("Claude needs permission to…") so
          // the alert says why it's blocked, not just the generic phrase.
          text = `${s.activityNote || 'needs your input'} · ${where}`;
        } else if (s.activity === 'idle' && was === 'working') {
          text = `finished · ${where}`;
        }
        if (text) {
          const n = new Notification(`${s.name} · ${text}`, { tag: s.id });
          n.onclick = () => window.focus();
        }
      }
    }
    prevActivityRef.current = next;
  }, []);

  // The session/profile polls return brand-new objects every 3 s even when
  // nothing changed. Reusing the previous reference for unchanged entries lets
  // React.memo(TerminalPane) actually skip untouched panes instead of every
  // pane's xterm subtree reconciling on a wall-clock timer forever.
  const sessionCacheRef = useRef<Map<string, SessionInfo>>(new Map());
  const stabilizeSessions = useCallback((list: SessionInfo[]): SessionInfo[] => {
    const cache = sessionCacheRef.current;
    const next = new Map<string, SessionInfo>();
    const out = list.map((s) => {
      const prev = cache.get(s.id);
      const chosen = prev && shallowEqual(prev, s) ? prev : s;
      next.set(s.id, chosen);
      return chosen;
    });
    sessionCacheRef.current = next;
    return out;
  }, []);
  const profilesCacheRef = useRef<Profile[]>([]);

  const refresh = useCallback(() => {
    api.listSessions().then((list) => {
      maybeNotify(list);
      setSessions(stabilizeSessions(list));
    }).catch(() => {});
    // Profiles too, so the email shows up right after /login in a pane
    api.listProfiles().then((info) => {
      const prevProfiles = profilesCacheRef.current;
      const unchanged = prevProfiles.length === info.profiles.length
        && info.profiles.every((p, i) => shallowEqual(p, prevProfiles[i]));
      if (!unchanged) {
        profilesCacheRef.current = info.profiles;
        setProfiles(info.profiles);
      }
      setDefaultEmail(info.default.email);
      setDefaultMapped(info.default.mapped);
    }).catch(() => {});
  }, [maybeNotify, stabilizeSessions]);

  const toggleNotify = async () => {
    if (notify) {
      setNotify(false);
      localStorage.setItem('helm.notify', '0');
      return;
    }
    const perm = await Notification.requestPermission();
    if (perm !== 'granted') {
      toast.error('notifications are blocked for this site in the browser');
      return;
    }
    setNotify(true);
    localStorage.setItem('helm.notify', '1');
  };

  // Tab title shows how many panes are blocked on you
  const waiting = sessions.filter((s) => s.status === 'running' && s.activity === 'waiting').length;
  useEffect(() => {
    document.title = waiting > 0 ? `(${waiting} waiting) Helm ⎈` : 'Helm ⎈';
  }, [waiting]);

  useEffect(() => {
    api.listWorkspaces().then(setWorkspaces).catch(() => {});
    api.getSettings().then((s) => setAutoRevive(s.autoRevive)).catch(() => {});
    refresh();
    const timer = setInterval(refresh, 3000);
    return () => clearInterval(timer);
  }, [refresh]);

  // Git branch/dirty per workspace — slower poll than sessions (6 s); branches
  // and working-tree state change on a human timescale, and it spawns git.
  useEffect(() => {
    const pull = () =>
      api.getWorkspacesGit()
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
      api.getWorkspacesServers()
        .then((list) => setServerInfo(Object.fromEntries(list.map((s) => [s.id, s]))))
        .catch(() => {});
    pull();
    const timer = setInterval(pull, 4000);
    return () => clearInterval(timer);
  }, []);

  const toggleAutoRevive = async () => {
    try {
      const s = await api.updateSettings({ autoRevive: !autoRevive });
      setAutoRevive(s.autoRevive);
    } catch (err) {
      toast.error((err as Error).message);
    }
  };

  const selected = workspaces.find((w) => w.id === selectedId) ?? workspaces[0] ?? null;

  // The profile picker is per-workspace: selecting a workspace loads its pinned
  // account into the picker so new panes there run on it (→ separate usage).
  useEffect(() => {
    setProfileChoice(selected?.profile ?? '');
  }, [selected?.id, selected?.profile]);

  // Pane order per workspace — presentational, kept in localStorage.
  // Unlisted panes (new ones) fall to the end in creation order.
  const orderKey = selected ? `helm.paneorder.${selected.id}` : null;
  const [paneOrder, setPaneOrder] = useState<string[]>([]);
  useEffect(() => {
    if (!orderKey) return;
    try {
      setPaneOrder(JSON.parse(localStorage.getItem(orderKey) || '[]'));
    } catch {
      setPaneOrder([]);
    }
  }, [orderKey]);

  const panes = useMemo(() => {
    const idx = new Map(paneOrder.map((id, i) => [id, i]));
    return sessions
      .filter((s) => selected && s.workspace === selected.dir)
      .sort(
        (a, b) =>
          (idx.get(a.id) ?? Infinity) - (idx.get(b.id) ?? Infinity) ||
          a.createdAt.localeCompare(b.createdAt),
      );
  }, [sessions, selected, paneOrder]);

  // Panes minimized to the tray are excluded from the grid's column count.
  const minimizedPanes = useMemo(
    () => panes.filter((p) => minimizedIds.has(p.id)),
    [panes, minimizedIds],
  );
  const shownPanes = useMemo(
    () => panes.filter((p) => !minimizedIds.has(p.id)),
    [panes, minimizedIds],
  );
  // A restored maximizedId can point at a pane in another workspace; only honor
  // it for display when that pane is actually on screen, else the grid blanks.
  const viewMax = maximizedId && panes.some((p) => p.id === maximizedId) ? maximizedId : null;
  // Panes actually mounted in the grid — minimized/non-maximized ones used to
  // stay mounted (just CSS-hidden), each still holding a WebSocket + its own
  // WebGL context (browsers cap ~16 live contexts). Unmounting them frees both;
  // restoring reconnects and the server's ring buffer replays recent output.
  const visiblePanes = useMemo(
    () => (viewMax ? panes.filter((p) => p.id === viewMax) : shownPanes),
    [viewMax, panes, shownPanes],
  );

  // Drag-to-reorder: grip in a pane header → drop on another pane's slot
  const [dragId, setDragId] = useState<string | null>(null);
  const [dragOverId, setDragOverId] = useState<string | null>(null);
  const onGripDragStart = useCallback((id: string) => setDragId(id), []);
  const onGripDragEnd = useCallback(() => { setDragId(null); setDragOverId(null); }, []);
  const dropPane = (targetId: string) => {
    if (!dragId || !orderKey || dragId === targetId) return;
    const ids = panes.map((p) => p.id);
    const from = ids.indexOf(dragId);
    const to = ids.indexOf(targetId);
    if (from === -1 || to === -1) return;
    ids.splice(from, 1);
    ids.splice(to, 0, dragId); // dragged pane takes the target's slot
    setPaneOrder(ids);
    localStorage.setItem(orderKey, JSON.stringify(ids));
  };

  // Every running pane across all workspaces — broadcast can target any of them
  const wsName = useCallback(
    (dir: string) =>
      workspaces.find((w) => w.dir === dir)?.name ??
      dir.split(/[\\/]/).filter(Boolean).pop() ?? dir,
    [workspaces],
  );
  const runningPanes = useMemo(
    () =>
      sessions
        .filter((s) => s.status === 'running')
        .sort((a, b) =>
          a.workspace === b.workspace
            ? a.createdAt.localeCompare(b.createdAt)
            : wsName(a.workspace).localeCompare(wsName(b.workspace))),
    [sessions, wsName],
  );

  const openBroadcast = () => {
    setBcText('');
    setBcError('');
    // Default targets: this workspace's running panes — minus ones waiting on
    // a question, since the trailing Enter could answer their dialog.
    setBcIds(new Set(
      runningPanes
        .filter((s) => selected && s.workspace === selected.dir && s.activity !== 'waiting')
        .map((s) => s.id),
    ));
    setDialog({ kind: 'broadcast' });
  };

  const sendBroadcast = async () => {
    const text = bcText.trim();
    const ids = [...bcIds];
    if (!text || !ids.length || bcBusy) return;
    setBcBusy(true);
    setBcError('');
    try {
      await api.broadcast(text, ids);
      setDialog(null);
    } catch (err) {
      setBcError((err as Error).message);
    } finally {
      setBcBusy(false);
    }
  };

  const select = (id: string) => {
    setSelectedId(id);
    localStorage.setItem('helm.workspaceId', id);
  };

  const submitAddWorkspace = async () => {
    const dir = wsDir.trim();
    if (!dir) {
      setWsAddError('A directory path is required.');
      return;
    }
    let port: number | null = null;
    if (wsPort.trim()) {
      const p = Number(wsPort);
      if (!Number.isInteger(p) || p < 1 || p > 65535) {
        setWsAddError('Port must be a whole number between 1 and 65535.');
        return;
      }
      port = p;
    }
    const name = wsName2.trim() || dir.split(/[\\/]/).filter(Boolean).pop() || dir;
    try {
      const created = await api.addWorkspace(name, dir, wsProfile || undefined);
      // Port isn't part of the create payload — set it in a follow-up patch.
      const ws = port !== null ? await api.updateWorkspace(created.id, { port }) : created;
      setWorkspaces((prev) => [...prev, ws]);
      select(ws.id);
      closeDialog();
    } catch (err) {
      setWsAddError((err as Error).message);
    }
  };

  const renameWorkspace = async (id: string, name: string) => {
    const ws = await api.updateWorkspace(id, { name });
    setWorkspaces((prev) => prev.map((w) => (w.id === id ? ws : w)));
  };

  const changeWorkspaceDir = async (id: string, dir: string) => {
    const ws = await api.updateWorkspace(id, { dir });
    setWorkspaces((prev) => prev.map((w) => (w.id === id ? ws : w)));
  };

  // port null clears the dev-server check; a new value refreshes the poll below.
  const setWorkspacePort = async (id: string, port: number | null) => {
    const ws = await api.updateWorkspace(id, { port });
    setWorkspaces((prev) => prev.map((w) => (w.id === id ? ws : w)));
    if (port === null) setServerInfo((prev) => { const next = { ...prev }; delete next[id]; return next; });
    api.getWorkspacesServers()
      .then((list) => setServerInfo(Object.fromEntries(list.map((s) => [s.id, s]))))
      .catch(() => {});
  };

  const removeWorkspace = async (id: string) => {
    await api.removeWorkspace(id).catch(() => {});
    setWorkspaces((prev) => prev.filter((w) => w.id !== id));
    if (selectedId === id) setSelectedId(null);
  };

  const createPane = async (profile: string) => {
    if (!selected) return;
    try {
      // Panes start ~80x24; the pane itself sends the real size on attach.
      const s = await api.createSession(selected.dir, profile || undefined, 80, 24);
      setSessions((prev) => [...prev, s]);
      if (profile && !profiles.some((p) => p.name === profile)) {
        setProfiles((prev) => [...prev, { name: profile, email: null }]);
      }
    } catch (err) {
      toast.error((err as Error).message);
    }
  };

  const newPane = () => void createPane(profileChoice);

  // Picking an account pins it to the current workspace (persisted), so the
  // choice sticks per project rather than being a transient global toggle.
  const chooseProfile = (name: string) => {
    setProfileChoice(name);
    if (!selected) return;
    setWorkspaces((prev) =>
      prev.map((w) => (w.id === selected.id ? { ...w, profile: name || undefined } : w)),
    );
    api.updateWorkspace(selected.id, { profile: name || null }).catch(() => {});
  };

  // Stable identities (empty deps — each only uses functional setState) so
  // they pass through React.memo(TerminalPane) as unchanged props every poll.
  const onKilled = useCallback((id: string) => {
    setSessions((prev) => prev.filter((s) => s.id !== id));
    setMaximizedId((m) => (m === id ? null : m));
    setMinimizedIds((prev) => {
      if (!prev.has(id)) return prev;
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
  }, []);

  const minimizePane = useCallback((id: string) => {
    setMinimizedIds((prev) => new Set(prev).add(id));
  }, []);

  const restorePane = useCallback((id: string) => {
    setMinimizedIds((prev) => {
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
  }, []);

  const toggleMaxPane = useCallback((id: string) => {
    restorePane(id);
    setMaximizedId((m) => (m === id ? null : id));
  }, [restorePane]);

  // Bring a pane front-and-center: scroll it into view, focus its terminal
  // (the pane listens for this event), and pulse it so the eye lands on it.
  const focusPane = (id: string) => {
    activePaneRef.current = id;
    setFlashId(id);
    setTimeout(() => {
      document.getElementById(`pane-${id}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      window.dispatchEvent(new CustomEvent('helm:focus-pane', { detail: id }));
    }, 60);
    if (flashTimer.current) clearTimeout(flashTimer.current);
    flashTimer.current = setTimeout(() => setFlashId((f) => (f === id ? null : f)), 1600);
  };

  // Command-palette jump: switch to the pane's workspace, pull it out of the
  // tray/maximize, and focus it. Reuses the same path as the "N waiting" hop.
  const jumpToPane = (s: SessionInfo) => {
    const ws = workspaces.find((w) => w.dir === s.workspace);
    if (ws && ws.id !== selected?.id) select(ws.id);
    setMaximizedId((m) => (m && m !== s.id ? null : m));
    restorePane(s.id);
    focusPane(s.id);
  };

  // Click "N waiting" → hop to the next pane blocked on you, across workspaces,
  // rotating through them on repeated clicks.
  const waitingRotor = useRef(0);
  const jumpToWaiting = () => {
    const blocked = sessions.filter((s) => s.status === 'running' && s.activity === 'waiting');
    if (!blocked.length) return;
    const target = blocked[waitingRotor.current % blocked.length];
    waitingRotor.current += 1;
    const ws = workspaces.find((w) => w.dir === target.workspace);
    if (ws && ws.id !== selected?.id) select(ws.id);
    setMaximizedId(null);
    restorePane(target.id);
    focusPane(target.id);
  };

  // Ctrl+Shift+←/→ cycles focus through the visible panes of this workspace.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey && e.shiftKey) || (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft')) return;
      if (!shownPanes.length) return;
      e.preventDefault();
      const cur = activePaneRef.current;
      const at = shownPanes.findIndex((p) => p.id === cur);
      const step = e.key === 'ArrowRight' ? 1 : shownPanes.length - 1;
      const next = at === -1 ? shownPanes[0] : shownPanes[(at + step) % shownPanes.length];
      focusPane(next.id);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [shownPanes]);

  const submitNewProfile = () => {
    const name = draftName.trim();
    if (!/^[\w-]+$/.test(name)) {
      setDraftError('Use letters, numbers, dashes or underscores only.');
      return;
    }
    if (profiles.some((p) => p.name === name)) {
      setDraftError('That profile already exists.');
      return;
    }
    setDialog(null);
    setDraftName('');
    setDraftError('');
    chooseProfile(name); // pin the new account to this workspace
    void createPane(name);
  };

  const closeDialog = () => {
    setDialog(null);
    setDraftName('');
    setDraftError('');
    setBcError('');
    setWsDir('');
    setWsName2('');
    setWsProfile('');
    setWsPort('');
    setWsAddError('');
  };

  const confirmDeleteProfile = async (name: string) => {
    setDialog(null);
    try {
      await api.deleteProfile(name);
      setProfiles((prev) => prev.filter((p) => p.name !== name));
      setProfileChoice('');
      // Unpin the deleted account from any workspace that had it pinned.
      workspaces.forEach((w) => {
        if (w.profile === name) api.updateWorkspace(w.id, { profile: null }).catch(() => {});
      });
      setWorkspaces((prev) =>
        prev.map((w) => (w.profile === name ? { ...w, profile: undefined } : w)),
      );
    } catch (err) {
      toast.error((err as Error).message);
    }
  };

  const submitRenameProfile = async (oldName: string) => {
    const nextName = draftName.trim();
    if (!/^[\w-]+$/.test(nextName)) {
      setDraftError('Use letters, numbers, dashes or underscores only.');
      return;
    }
    if (nextName !== oldName && profiles.some((p) => p.name === nextName)) {
      setDraftError('That profile already exists.');
      return;
    }
    try {
      await api.renameProfile(oldName, nextName);
      setProfiles((prev) => prev.map((p) => (p.name === oldName ? { ...p, name: nextName } : p)));
      if (profileChoice === oldName) setProfileChoice(nextName);
      setWorkspaces((prev) =>
        prev.map((w) => (w.profile === oldName ? { ...w, profile: nextName } : w)),
      );
      setDialog({ kind: 'manage-profiles' });
      setDraftName('');
      setDraftError('');
    } catch (err) {
      setDraftError((err as Error).message);
    }
  };

  return (
    <div className="app">
      {/* Custom cursor lives in the sidebar only — everywhere else the
          normal cursor is untouched. Targets matched by selector, no
          .cursor-target classes needed. */}
      <TargetCursor
        scopeSelector=".sidebar"
        targetSelector=".ws-item, .sidebar button, .sidebar input"
        spinDuration={3}
        hideDefaultCursor={true}
        parallaxOn={true}
      />
      {!sidebarHidden && (
        <Sidebar
          workspaces={orderedWorkspaces}
          sessions={sessions}
          git={gitInfo}
          servers={serverInfo}
          selectedId={selected?.id ?? null}
          defaultEmail={defaultEmail}
          profiles={profiles}
          onSelect={select}
          onAddClick={() => setDialog({ kind: 'add-workspace' })}
          onRename={renameWorkspace}
          onChangeDir={changeWorkspaceDir}
          onSetPort={setWorkspacePort}
          onRemove={removeWorkspace}
          onHide={toggleSidebar}
          dragId={dragWsId}
          dragOverId={dragOverWsId}
          onDragStart={setDragWsId}
          onDragOver={setDragOverWsId}
          onDrop={dropWorkspace}
          onDragEnd={() => { setDragWsId(null); setDragOverWsId(null); }}
        />
      )}
      <main className="main">
        <DriftBanner />
        {selected ? (
          <>
            <div className="main-bar">
              {sidebarHidden && (
                <button className="tbtn tbtn-icon" title="Show sidebar" onClick={toggleSidebar}>
                  <IconPanelLeftOpen />
                </button>
              )}
              <AnimateIcon asChild>
                <button
                  className="omni-search"
                  onClick={() => setPaletteOpen(true)}
                  title="Search & jump to any pane or workspace"
                >
                  <IconSearch size={13} />
                  <span className="omni-search-text">Search panes…</span>
                  <kbd className="omni-kbd">{IS_MAC ? '⌘' : 'Ctrl'} K</kbd>
                </button>
              </AnimateIcon>
              <span className="main-label">Profile</span>
              <ProfileSelect
                profiles={profiles}
                defaultEmail={defaultEmail}
                mappedDefault={defaultMapped}
                value={profileChoice}
                onChange={chooseProfile}
                onNewProfile={() => setDialog({ kind: 'new-profile' })}
                onManageProfiles={() => setDialog({ kind: 'manage-profiles' })}
              />
              <button className="btn" onClick={newPane}>
                <IconPlus size={13} /> New pane
              </button>
              <AnimateIcon asChild>
                <button
                  className="btn btn-secondary"
                  onClick={openBroadcast}
                  disabled={!runningPanes.length}
                  title="Send one instruction to several panes at once"
                >
                  <IconNfc size={13} /> Broadcast
                </button>
              </AnimateIcon>
              <div className="toolbar-right">
                <div className="font-stepper" title="Terminal font size">
                  <button
                    className="ibtn"
                    onClick={() => changeFont(-1)}
                    disabled={fontSize <= 11}
                    title="Smaller terminal text"
                    aria-label="Smaller terminal text"
                  >
                    <IconMinus size={14} />
                  </button>
                  <span className="font-stepper-val">{fontSize}px</span>
                  <button
                    className="ibtn"
                    onClick={() => changeFont(1)}
                    disabled={fontSize >= 20}
                    title="Larger terminal text"
                    aria-label="Larger terminal text"
                  >
                    <IconPlus size={14} />
                  </button>
                </div>
                {waiting > 0 && (
                  <button
                    className="tbtn waiting-jump"
                    onClick={jumpToWaiting}
                    title="Jump to a pane waiting on you (repeat to cycle through them)"
                  >
                    <span className="dot dot-waiting" /> {waiting} waiting
                  </button>
                )}
                <AnimateIcon asChild>
                  <button
                    className="tbtn"
                    onClick={openUsage}
                    title="Token usage per account — rolling windows from 1 h to 30 d, plus all time"
                  >
                    <IconChart /> Usage
                  </button>
                </AnimateIcon>
                <AnimateIcon asChild>
                  <button
                    className={`tbtn ${autoRevive ? 'on' : ''}`}
                    onClick={toggleAutoRevive}
                    title={autoRevive
                      ? 'Auto-revive on: dead panes come back automatically when the server starts'
                      : 'Auto-revive off — after a server restart, each dead pane needs a revive click'}
                  >
                    <IconRefreshCcw /> Auto-revive
                  </button>
                </AnimateIcon>
                {consoleState.supported && (
                  <AnimateIcon asChild>
                    <button
                      className={`tbtn ${consoleState.visible ? 'on' : ''}`}
                      onClick={toggleConsole}
                      title={consoleState.visible
                        ? 'Hide the Helm server console window'
                        : 'Show the Helm server console window'}
                    >
                      <IconTerminal /> Console
                    </button>
                  </AnimateIcon>
                )}
                <button
                  className={`tbtn ${debugOpen ? 'on' : ''}`}
                  onClick={() => setDebugOpen((o) => !o)}
                  title="Live server event log (spawns, attaches, hooks, errors)"
                >
                  <IconBug /> Debug
                </button>
                <AnimateIcon asChild>
                  <button
                    className={`tbtn ${notify ? 'on' : ''}`}
                    onClick={toggleNotify}
                    title={notify
                      ? 'Alerts on: you get a desktop notification when a pane needs input or finishes (while this tab is unfocused)'
                      : 'Alerts off — click to get desktop notifications when a pane needs input or finishes'}
                  >
                    {notify ? <IconBellRing /> : <IconBellOff />} Alerts
                  </button>
                </AnimateIcon>
              </div>
            </div>
            {minimizedPanes.length > 0 && (
              <div className="pane-tray">
                {minimizedPanes.map((s) => (
                  <button
                    key={s.id}
                    className="tray-chip"
                    style={{ borderColor: s.color }}
                    title={`Restore "${s.name}"`}
                    onClick={() => restorePane(s.id)}
                  >
                    <span
                      className={`dot ${
                        { working: 'dot-working', waiting: 'dot-waiting', idle: 'dot-live' }[
                          s.activity ?? 'idle'
                        ]
                      }`}
                    />
                    <span style={{ color: s.color }}>{s.name}</span>
                  </button>
                ))}
              </div>
            )}
            {panes.length ? (
              <div className={viewMax ? 'grid cols-1' : `grid cols-${Math.min(Math.max(shownPanes.length, 1), 3)}`}>
                {visiblePanes.map((s) => (
                  <div
                    key={s.id}
                    id={`pane-${s.id}`}
                    className={`pane-slot ${dragOverId === s.id && dragId && dragId !== s.id ? 'drag-over' : ''}${flashId === s.id ? ' pane-flash' : ''}`}
                    onFocusCapture={() => { activePaneRef.current = s.id; }}
                    onDragOver={(e) => {
                      if (!dragId) return;
                      e.preventDefault();
                      setDragOverId(s.id);
                    }}
                    onDragLeave={() => setDragOverId((d) => (d === s.id ? null : d))}
                    onDrop={(e) => {
                      e.preventDefault();
                      dropPane(s.id);
                      setDragOverId(null);
                      setDragId(null);
                    }}
                  >
                    <TerminalPane
                      session={s}
                      onKilled={onKilled}
                      onChanged={refresh}
                      isMaximized={viewMax === s.id}
                      onToggleMax={toggleMaxPane}
                      onMinimize={minimizePane}
                      onGripDragStart={onGripDragStart}
                      onGripDragEnd={onGripDragEnd}
                      isPasteFallback={viewMax === s.id || (!viewMax && panes.length === 1)}
                      profiles={profiles}
                      defaultEmail={defaultEmail}
                      mappedDefault={defaultMapped}
                      fontSize={fontSize}
                    />
                  </div>
                ))}
              </div>
            ) : (
              <div className="main-empty">
                <div className="main-empty-inner">
                  <span>No panes in this workspace.</span>
                  <button className="btn" onClick={newPane}>
                    <IconPlus size={13} /> New pane
                  </button>
                </div>
              </div>
            )}
          </>
        ) : (
          <div className="main-empty">
            {sidebarHidden && (
              <button className="btn btn-secondary" onClick={toggleSidebar}>
                <IconPanelLeftOpen size={13} /> Show sidebar
              </button>
            )}
            <div>Add a workspace to get started.</div>
          </div>
        )}
        {debugOpen && (
          <div className="debug-drawer">
            <div className="debug-head">
              <span>
                server events
                {serverMeta &&
                  ` — up since ${new Date(serverMeta.startedAt).toLocaleTimeString()} · pid ${serverMeta.pid}`}
              </span>
              <button className="btn btn-small btn-ghost" onClick={() => setLogs([])}>Clear</button>
              <button className="btn btn-small btn-ghost" onClick={() => setDebugOpen(false)}>Close</button>
            </div>
            <div className="debug-body">
              {logs.length === 0 && <div className="debug-line muted">waiting for events…</div>}
              {logs.map((l) => (
                <div key={l.seq} className="debug-line">
                  <span className="debug-time">{l.t.slice(11, 19)}</span>
                  <span className={`debug-tag tag-${l.tag}`}>{l.tag}</span>
                  <span>{l.msg}</span>
                </div>
              ))}
              <div ref={logEndRef} />
            </div>
          </div>
        )}
      </main>

      {dialog?.kind === 'new-profile' && (
        <Modal title="New account profile" onClose={closeDialog}>
          <p className="modal-desc">
            Each profile is an isolated Claude Code account. A pane will open with
            Claude's setup — sign in there with the account this profile is for.
          </p>
          <input
            className="modal-input"
            placeholder="profile name — e.g. work, personal-max"
            value={draftName}
            autoFocus
            onChange={(e) => {
              setDraftName(e.target.value);
              setDraftError('');
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') submitNewProfile();
            }}
          />
          {draftError && <div className="form-error">{draftError}</div>}
          <div className="modal-actions">
            <button className="btn btn-ghost" onClick={closeDialog}>Cancel</button>
            <button className="btn" onClick={submitNewProfile} disabled={!draftName.trim()}>
              Create &amp; open login pane
            </button>
          </div>
        </Modal>
      )}

      {dialog?.kind === 'add-workspace' && (
        <Modal title="Add workspace" onClose={closeDialog}>
          <p className="modal-desc">
            Point Helm at a project folder. Panes you open here launch Claude in
            this directory.
          </p>
          <label className="field-label">Directory path</label>
          <input
            className="modal-input"
            placeholder="e.g. C:\Users\you\Projects\my-app"
            value={wsDir}
            autoFocus
            onChange={(e) => { setWsDir(e.target.value); setWsAddError(''); }}
            onKeyDown={(e) => { if (e.key === 'Enter') void submitAddWorkspace(); }}
          />
          <label className="field-label">Name <span className="field-hint">(optional — defaults to the folder name)</span></label>
          <input
            className="modal-input"
            placeholder="workspace name"
            value={wsName2}
            onChange={(e) => setWsName2(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') void submitAddWorkspace(); }}
          />
          <label className="field-label">Pinned account <span className="field-hint">(optional)</span></label>
          <select
            className="modal-input"
            value={wsProfile}
            onChange={(e) => setWsProfile(e.target.value)}
          >
            <option value="">Default account</option>
            {profiles.map((p) => (
              <option key={p.name} value={p.name}>
                {p.name}{p.email ? ` — ${p.email}` : ''}
              </option>
            ))}
          </select>
          <label className="field-label">Dev-server port <span className="field-hint">(optional — enables the up/down check)</span></label>
          <input
            className="modal-input"
            placeholder="e.g. 3000"
            inputMode="numeric"
            value={wsPort}
            onChange={(e) => { setWsPort(e.target.value); setWsAddError(''); }}
            onKeyDown={(e) => { if (e.key === 'Enter') void submitAddWorkspace(); }}
          />
          {wsAddError && <div className="form-error">{wsAddError}</div>}
          <div className="modal-actions">
            <button className="btn btn-ghost" onClick={closeDialog}>Cancel</button>
            <button className="btn" onClick={() => void submitAddWorkspace()} disabled={!wsDir.trim()}>
              Add workspace
            </button>
          </div>
        </Modal>
      )}

      {dialog?.kind === 'manage-profiles' && (
        <Modal title="Manage profiles" onClose={closeDialog}>
          {profiles.length === 0 ? (
            <p className="modal-desc">No profiles yet — create one from the profile picker.</p>
          ) : (
            <div className="manage-list">
              {profiles.map((p) => (
                <div className="manage-row" key={p.name}>
                  <div className="manage-row-info">
                    <span className="manage-row-name">{p.name}</span>
                    <span className="manage-row-email">{p.email ?? 'not logged in'}</span>
                  </div>
                  <button
                    className="btn btn-small btn-ghost"
                    title="Rename profile"
                    onClick={() => {
                      setDraftName(p.name);
                      setDraftError('');
                      setDialog({ kind: 'edit-profile', profile: p });
                    }}
                  >
                    <IconPencil size={12} />
                  </button>
                  <button
                    className="btn btn-small btn-danger"
                    title="Delete this profile (removes its stored login)"
                    onClick={() => setDialog({ kind: 'delete-profile', profile: p })}
                  >
                    <IconTrash size={12} />
                  </button>
                </div>
              ))}
            </div>
          )}
          <div className="modal-actions">
            <button className="btn btn-ghost" onClick={closeDialog}>Close</button>
          </div>
        </Modal>
      )}

      {dialog?.kind === 'edit-profile' && (
        <Modal title={`Rename profile "${dialog.profile.name}"`} onClose={closeDialog}>
          <p className="modal-desc">
            Renaming updates any panes or workspaces pinned to this profile.
          </p>
          <input
            className="modal-input"
            placeholder="profile name — e.g. work, personal-max"
            value={draftName}
            autoFocus
            onChange={(e) => {
              setDraftName(e.target.value);
              setDraftError('');
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void submitRenameProfile(dialog.profile.name);
            }}
          />
          {draftError && <div className="form-error">{draftError}</div>}
          <div className="modal-actions">
            <button
              className="btn btn-ghost"
              onClick={() => {
                setDraftName('');
                setDraftError('');
                setDialog({ kind: 'manage-profiles' });
              }}
            >
              Back
            </button>
            <button
              className="btn"
              onClick={() => void submitRenameProfile(dialog.profile.name)}
              disabled={!draftName.trim()}
            >
              Save
            </button>
          </div>
        </Modal>
      )}

      {dialog?.kind === 'usage' && (
        <Modal title="Usage by account" onClose={closeDialog}>
          <div className="chip-row">
            {USAGE_WINDOWS.map(([key, label]) => (
              <button
                key={key}
                className={`chip ${usageWindow === key ? 'selected' : ''}`}
                onClick={() => setUsageWindow(key)}
              >
                {label}
              </button>
            ))}
          </div>
          {!usageRows ? (
            <p className="modal-desc">crunching transcripts…</p>
          ) : !usageRows.length ? (
            <p className="modal-desc">No usage data found.</p>
          ) : (() => {
            const windowLabel = USAGE_WINDOWS.find(([k]) => k === usageWindow)?.[1] ?? '';
            const phrase = usageWindow === 'all' ? 'all time' : `last ${windowLabel}`;
            const keyName = (a: AccountUsage) => (a.account === 'default' ? 'default' : a.account);
            const total = usageRows.reduce(
              (acc, a) => {
                const w = a.windows[usageWindow];
                if (w) { acc.tokens += w.input + w.output + w.cacheRead + w.cacheWrite; acc.cost += w.cost; }
                return acc;
              },
              { tokens: 0, cost: 0 },
            );
            return (
              <>
                <div className="usage-total">
                  <span>All accounts · {phrase}</span>
                  <span className="usage-total-nums">
                    <b>{fmt(total.tokens)}</b> tokens · {fmtCost(total.cost)} est
                  </span>
                </div>
                {usageRows.map((a, i) => {
                  const label = accountLabel(a.account === 'default' ? '' : a.account, a.email, profiles);
                  const tag = a.account === 'default' ? 'default' : label !== a.account ? a.account : null;
                  const dupOf = a.email
                    ? usageRows.slice(0, i).find((o) => o.email === a.email)
                    : undefined;
                  const w = a.windows[usageWindow];
                  const all = a.windows.all;
                  const allTokens = all ? all.input + all.output + all.cacheRead + all.cacheWrite : 0;
                  const winTokens = w ? w.input + w.output + w.cacheRead + w.cacheWrite : 0;
                  const models = w ? Object.entries(w.models).sort(([, x], [, y]) => y.output - x.output) : [];
                  const maxOut = Math.max(...models.map(([, m]) => m.output), 1);
                  return (
                    <div key={a.account} className="usage-account">
                      <div className="usage-account-head">
                        <b>{label}</b>
                        {tag && <span className="usage-tag">{tag}</span>}
                        <span className="usage-email">{a.email ?? 'not logged in'}</span>
                      </div>
                      <div className="usage-account-meta">
                        {relTime(a.lastActive)}
                        {allTokens > 0 && <> · {fmt(allTokens)} tokens · {fmtCost(all.cost)} all-time</>}
                        {dupOf && <span className="usage-dup"> · same login as “{keyName(dupOf)}”</span>}
                      </div>
                      {models.length > 0 ? (
                        <>
                          <div className="usage-stats">
                            <span><b>{fmt(winTokens)}</b> tokens</span>
                            <span>{fmt(w.output)} out · {fmt(w.input)} in · {fmt(w.cacheRead + w.cacheWrite)} cache</span>
                            <span>{w.turns} turns</span>
                            <span className="usage-cost">{fmtCost(w.cost)} est</span>
                          </div>
                          <div className="usage-bars">
                            {models.map(([model, m]) => (
                              <div key={model} className="usage-bar-row">
                                <span className="usage-bar-label" title={model}>
                                  {model.replace(/^claude-/, '')}
                                </span>
                                <span className="usage-bar-track">
                                  <span className="usage-bar-plot">
                                    <span
                                      className="usage-bar-fill"
                                      style={{ width: `${Math.max((m.output / maxOut) * 100, 1)}%` }}
                                    />
                                  </span>
                                  <span className="usage-bar-val">{fmt(m.output)}</span>
                                </span>
                                <span className="usage-tip">
                                  <b>{model}</b><br />
                                  {fmt(m.output)} out · {fmt(m.input)} in ·{' '}
                                  {fmt(m.cacheRead)} cache · {m.turns} turns<br />
                                  {fmtCost(m.cost ?? 0)} est
                                </span>
                              </div>
                            ))}
                          </div>
                        </>
                      ) : (
                        <div className="usage-empty">
                          {usageWindow === 'all' ? 'no usage recorded' : `no usage in the ${phrase}`}
                        </div>
                      )}
                    </div>
                  );
                })}
              </>
            );
          })()}
          <div className="modal-actions">
            <button className="btn" onClick={closeDialog}>Close</button>
          </div>
        </Modal>
      )}

      {dialog?.kind === 'broadcast' && (
        <Modal title="Broadcast to panes" onClose={closeDialog}>
          <p className="modal-desc">
            Types one instruction into every selected pane and presses Enter —
            as if you'd typed it in each terminal yourself. Panes waiting on a
            question start unchecked (Enter could answer their dialog).
          </p>
          <input
            className="modal-input"
            placeholder="e.g. commit your work, then summarize where you're at"
            value={bcText}
            autoFocus
            maxLength={4000}
            onChange={(e) => setBcText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void sendBroadcast();
            }}
          />
          <div className="bc-list">
            {runningPanes.map((s) => (
              <label key={s.id} className="bc-row">
                <input
                  type="checkbox"
                  checked={bcIds.has(s.id)}
                  onChange={(e) => {
                    setBcIds((prev) => {
                      const next = new Set(prev);
                      if (e.target.checked) next.add(s.id);
                      else next.delete(s.id);
                      return next;
                    });
                  }}
                />
                <span
                  className={`dot ${
                    { working: 'dot-working', waiting: 'dot-waiting', idle: 'dot-live' }[
                      s.activity ?? 'idle'
                    ]
                  }`}
                />
                <span className="bc-name" style={{ color: s.color }}>{s.name}</span>
                <span className="bc-where" title={s.workspace}>{wsName(s.workspace)}</span>
                <span className="bc-activity">{s.activity ?? 'starting'}</span>
              </label>
            ))}
          </div>
          {bcError && <div className="form-error">{bcError}</div>}
          <div className="modal-actions">
            <button className="btn btn-ghost" onClick={closeDialog}>Cancel</button>
            <button
              className="btn"
              onClick={() => void sendBroadcast()}
              disabled={bcBusy || !bcText.trim() || !bcIds.size}
            >
              {bcBusy ? 'sending…' : `Send to ${bcIds.size} pane${bcIds.size === 1 ? '' : 's'}`}
            </button>
          </div>
        </Modal>
      )}

      {dialog?.kind === 'delete-profile' && (
        <Modal title={`Delete profile "${dialog.profile.name}"?`} onClose={closeDialog}>
          <p className="modal-desc">
            {dialog.profile.email ? (
              <>Signed in as <b>{dialog.profile.email}</b>. </>
            ) : (
              <>This profile was never signed in. </>
            )}
            Deleting removes its stored login from this PC — the Claude account
            itself is untouched, and you can add the profile again later.
          </p>
          <div className="modal-actions">
            <button className="btn btn-ghost" onClick={closeDialog}>Cancel</button>
            <button className="btn btn-danger" onClick={() => confirmDeleteProfile(dialog.profile.name)}>
              Delete profile
            </button>
          </div>
        </Modal>
      )}
      {paletteOpen && (
        <CommandPalette
          onClose={() => setPaletteOpen(false)}
          sessions={sessions}
          workspaces={workspaces}
          onJumpToPane={jumpToPane}
          onSelectWorkspace={select}
          onNewPane={selected ? newPane : undefined}
          onBroadcast={runningPanes.length ? openBroadcast : undefined}
          onUsage={openUsage}
        />
      )}
      <Toaster />
    </div>
  );
}
