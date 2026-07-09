import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from './api';
import { storage } from './lib/storage';
import { useSessionsPoll } from './hooks/useSessionsPoll';
import { useWorkspaceStatus } from './hooks/useWorkspaceStatus';
import type { LogEntry, Profile, SessionInfo, Workspace } from './types';
import { Sidebar } from './components/Sidebar';
import { TerminalPane } from './components/TerminalPane';
import { ProfileSelect } from './components/ProfileSelect';
import { TargetCursor } from './components/TargetCursor';
import { Toaster, toast } from './components/Toaster';
import { DriftBanner } from './components/DriftBanner';
import { CommandPalette } from './components/CommandPalette';
import { NewProfileModal } from './components/modals/NewProfileModal';
import { ProfilesModal } from './components/modals/ProfilesModal';
import { UsageModal } from './components/modals/UsageModal';
import { BroadcastModal } from './components/modals/BroadcastModal';
import { AddWorkspaceModal } from './components/modals/AddWorkspaceModal';
import { IconBug, IconMinus, IconPanelLeftOpen, IconPlus } from './components/Icons';
import {
  AnimateIcon, IconBellOff, IconBellRing, IconChart, IconNfc, IconRefreshCcw, IconSearch, IconTerminal,
} from './components/AnimatedIcons';

// Which modal is open. Each modal component owns its own draft state — App
// only tracks the kind (plus any payload computed at open time).
type Dialog =
  | { kind: 'new-profile' }
  | { kind: 'profiles' }
  | { kind: 'usage' }
  | { kind: 'broadcast'; initialIds: Set<string> }
  | { kind: 'add-workspace' }
  | null;

// ⌘K on Mac, Ctrl K elsewhere — for the command-palette hint.
const IS_MAC = typeof navigator !== 'undefined' && /Mac/i.test(navigator.platform);

export function App() {
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  // Sidebar order — presentational, kept in localStorage; unlisted (new)
  // workspaces fall to the end in fetch order.
  const [wsOrder, setWsOrder] = useState<string[]>(() => storage.wsOrder.get());
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
    storage.wsOrder.set(ids);
  };
  const [selectedId, setSelectedId] = useState<string | null>(storage.workspaceId.get());
  const [profileChoice, setProfileChoice] = useState('');
  const [dialog, setDialog] = useState<Dialog>(null);
  const [notify, setNotify] = useState(
    () => storage.notify.get() && Notification.permission === 'granted',
  );
  // Data layer (extracted hooks): sessions+profiles poll w/ stable references
  // and edge-triggered notifications, plus per-workspace git/dev-server status.
  const {
    sessions, setSessions, profiles, setProfiles, defaultEmail, defaultMapped, refresh,
  } = useSessionsPoll(notify);
  const { gitInfo, serverInfo, setServerInfo } = useWorkspaceStatus();
  // Maximize/minimize layout survives a reload — restored from localStorage,
  // pruned against the live session list once it loads (stale ids dropped).
  const [maximizedId, setMaximizedId] = useState<string | null>(() => storage.maximized.get());
  const [minimizedIds, setMinimizedIds] = useState<Set<string>>(() => storage.minimized.get());
  useEffect(() => {
    storage.minimized.set(minimizedIds);
  }, [minimizedIds]);
  useEffect(() => {
    storage.maximized.set(maximizedId);
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
  const [fontSize, setFontSize] = useState<number>(() => storage.fontSize.get(13));
  const changeFont = (delta: number) =>
    setFontSize((f) => {
      const next = Math.min(20, Math.max(11, f + delta));
      storage.fontSize.set(next);
      return next;
    });
  // Ctrl+K command palette / quick pane switcher.
  const [paletteOpen, setPaletteOpen] = useState(false);
  // Pane that briefly pulses after a jump/cycle so the eye can find it.
  const [flashId, setFlashId] = useState<string | null>(null);
  // Which pane's terminal last held focus — the anchor for Ctrl+Shift+←/→ cycling.
  const activePaneRef = useRef<string | null>(null);
  const flashTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [sidebarHidden, setSidebarHidden] = useState(() => storage.sidebarHidden.get());
  const toggleSidebar = () =>
    setSidebarHidden((h) => {
      const next = !h;
      storage.sidebarHidden.set(next);
      return next;
    });
  const [autoRevive, setAutoRevive] = useState(false); // mirrors server settings

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

  const openUsage = () => setDialog({ kind: 'usage' }); // the modal fetches on mount

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

  const toggleNotify = async () => {
    if (notify) {
      setNotify(false);
      storage.notify.set(false);
      return;
    }
    const perm = await Notification.requestPermission();
    if (perm !== 'granted') {
      toast.error('notifications are blocked for this site in the browser');
      return;
    }
    setNotify(true);
    storage.notify.set(true);
  };

  // Tab title shows how many panes are blocked on you
  const waiting = sessions.filter((s) => s.status === 'running' && s.activity === 'waiting').length;
  useEffect(() => {
    document.title = waiting > 0 ? `(${waiting} waiting) Helm ⎈` : 'Helm ⎈';
  }, [waiting]);

  // One-shot boot fetches (session/profile/git/server polling lives in hooks).
  useEffect(() => {
    api.listWorkspaces().then(setWorkspaces).catch(() => {});
    api.getSettings().then((s) => setAutoRevive(s.autoRevive)).catch(() => {});
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
  const [paneOrder, setPaneOrder] = useState<string[]>([]);
  useEffect(() => {
    if (selected) setPaneOrder(storage.paneOrder.get(selected.id));
  }, [selected?.id]);

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
    if (!dragId || !selected || dragId === targetId) return;
    const ids = panes.map((p) => p.id);
    const from = ids.indexOf(dragId);
    const to = ids.indexOf(targetId);
    if (from === -1 || to === -1) return;
    ids.splice(from, 1);
    ids.splice(to, 0, dragId); // dragged pane takes the target's slot
    setPaneOrder(ids);
    storage.paneOrder.set(selected.id, ids);
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
    // Default targets: this workspace's running panes — minus ones waiting on
    // a question, since the trailing Enter could answer their dialog.
    setDialog({
      kind: 'broadcast',
      initialIds: new Set(
        runningPanes
          .filter((s) => selected && s.workspace === selected.dir && s.activity !== 'waiting')
          .map((s) => s.id),
      ),
    });
  };

  const select = (id: string) => {
    setSelectedId(id);
    storage.workspaceId.set(id);
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
    setWorkspaces((prev) => {
      const next = prev.filter((w) => w.id !== id);
      storage.paneOrder.pruneOrphans(next.map((w) => w.id)); // drop the gone ws's pane-order key
      return next;
    });
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

  // Modal callbacks — the modals validate + own their drafts; App handles the
  // state fallout. closeDialog is trivial now (no draft fields to reset).
  const closeDialog = () => setDialog(null);

  const createProfile = (name: string) => {
    chooseProfile(name); // pin the new account to this workspace
    void createPane(name);
  };

  const confirmDeleteProfile = async (name: string) => {
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

  // API + state sync only — validation and inline errors live in ProfilesModal
  // (a thrown error surfaces next to its input field).
  const renameProfile = async (oldName: string, nextName: string) => {
    await api.renameProfile(oldName, nextName);
    setProfiles((prev) => prev.map((p) => (p.name === oldName ? { ...p, name: nextName } : p)));
    if (profileChoice === oldName) setProfileChoice(nextName);
    setWorkspaces((prev) =>
      prev.map((w) => (w.profile === oldName ? { ...w, profile: nextName } : w)),
    );
  };

  const addedWorkspace = (ws: Workspace) => {
    setWorkspaces((prev) => [...prev, ws]);
    select(ws.id);
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
                onManageProfiles={() => setDialog({ kind: 'profiles' })}
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
        <NewProfileModal profiles={profiles} onClose={closeDialog} onCreate={createProfile} />
      )}

      {dialog?.kind === 'add-workspace' && (
        <AddWorkspaceModal profiles={profiles} onClose={closeDialog} onAdded={addedWorkspace} />
      )}

      {dialog?.kind === 'profiles' && (
        <ProfilesModal
          profiles={profiles}
          onClose={closeDialog}
          renameProfile={renameProfile}
          onDelete={(name) => void confirmDeleteProfile(name)}
        />
      )}

      {dialog?.kind === 'usage' && (
        <UsageModal profiles={profiles} defaultMapped={defaultMapped} onClose={closeDialog} />
      )}

      {dialog?.kind === 'broadcast' && (
        <BroadcastModal
          panes={runningPanes}
          initialIds={dialog.initialIds}
          wsName={wsName}
          onClose={closeDialog}
        />
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
