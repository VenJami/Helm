import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from './api';
import type { AccountUsage, LogEntry, Profile, SessionInfo, Workspace } from './types';
import { Sidebar } from './components/Sidebar';
import { TerminalPane } from './components/TerminalPane';
import { Modal } from './components/Modal';
import {
  IconBell, IconBellOff, IconBug, IconChart, IconMegaphone, IconPlus, IconRefresh, IconTrash,
} from './components/Icons';

const NEW_PROFILE = '__new__';

type Dialog =
  | { kind: 'new-profile' }
  | { kind: 'delete-profile'; profile: Profile }
  | { kind: 'usage' }
  | { kind: 'broadcast' }
  | null;

const fmt = (n: number) =>
  n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(1) + 'k' : String(n);

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
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [defaultEmail, setDefaultEmail] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(
    localStorage.getItem('helm.workspaceId'),
  );
  const [profileChoice, setProfileChoice] = useState('');
  const [error, setError] = useState('');
  const [dialog, setDialog] = useState<Dialog>(null);
  const [draftName, setDraftName] = useState('');
  const [draftError, setDraftError] = useState('');
  const [notify, setNotify] = useState(
    () => localStorage.getItem('helm.notify') === '1' && Notification.permission === 'granted',
  );
  const [globalUsage, setGlobalUsage] = useState<AccountUsage[] | null>(null);
  // 5h ≈ the subscription session window — the slice that matters most
  const [usageWindow, setUsageWindow] = useState('h5');
  const [maximizedId, setMaximizedId] = useState<string | null>(null);
  const [autoRevive, setAutoRevive] = useState(false); // mirrors server settings
  // Broadcast dialog: one instruction typed into several panes at once
  const [bcText, setBcText] = useState('');
  const [bcIds, setBcIds] = useState<Set<string>>(new Set());
  const [bcBusy, setBcBusy] = useState(false);
  const [bcError, setBcError] = useState('');

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

  const openUsage = () => {
    setDialog({ kind: 'usage' });
    setGlobalUsage(null);
    api.getGlobalUsage().then(setGlobalUsage).catch(() => setGlobalUsage([]));
  };

  // Esc leaves maximized mode
  useEffect(() => {
    if (!maximizedId) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMaximizedId(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [maximizedId]);

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
          text = `needs your input · ${where}`;
        } else if (s.activity === 'idle' && was === 'working') {
          text = `finished · ${where}`;
        }
        if (text) {
          const n = new Notification(`${s.name} ${text}`, { tag: s.id });
          n.onclick = () => window.focus();
        }
      }
    }
    prevActivityRef.current = next;
  }, []);

  const refresh = useCallback(() => {
    api.listSessions().then((list) => {
      maybeNotify(list);
      setSessions(list);
    }).catch(() => {});
    // Profiles too, so the email shows up right after /login in a pane
    api.listProfiles().then((info) => {
      setProfiles(info.profiles);
      setDefaultEmail(info.default.email);
    }).catch(() => {});
  }, [maybeNotify]);

  const toggleNotify = async () => {
    if (notify) {
      setNotify(false);
      localStorage.setItem('helm.notify', '0');
      return;
    }
    const perm = await Notification.requestPermission();
    if (perm !== 'granted') {
      setError('notifications are blocked for this site in the browser');
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

  const toggleAutoRevive = async () => {
    try {
      const s = await api.updateSettings({ autoRevive: !autoRevive });
      setAutoRevive(s.autoRevive);
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const selected = workspaces.find((w) => w.id === selectedId) ?? workspaces[0] ?? null;

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

  // Drag-to-reorder: grip in a pane header → drop on another pane's slot
  const [dragId, setDragId] = useState<string | null>(null);
  const [dragOverId, setDragOverId] = useState<string | null>(null);
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

  const addWorkspace = async (name: string, dir: string) => {
    const ws = await api.addWorkspace(name, dir);
    setWorkspaces((prev) => [...prev, ws]);
    select(ws.id);
  };

  const removeWorkspace = async (id: string) => {
    await api.removeWorkspace(id).catch(() => {});
    setWorkspaces((prev) => prev.filter((w) => w.id !== id));
    if (selectedId === id) setSelectedId(null);
  };

  const createPane = async (profile: string) => {
    if (!selected) return;
    setError('');
    try {
      // Panes start ~80x24; the pane itself sends the real size on attach.
      const s = await api.createSession(selected.dir, profile || undefined, 80, 24);
      setSessions((prev) => [...prev, s]);
      if (profile && !profiles.some((p) => p.name === profile)) {
        setProfiles((prev) => [...prev, { name: profile, email: null }]);
      }
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const newPane = () => {
    if (profileChoice === NEW_PROFILE) {
      setDialog({ kind: 'new-profile' });
      return;
    }
    void createPane(profileChoice);
  };

  const onKilled = (id: string) => {
    setSessions((prev) => prev.filter((s) => s.id !== id));
    setMaximizedId((m) => (m === id ? null : m));
  };

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
    setProfileChoice(name);
    void createPane(name);
  };

  const closeDialog = () => {
    setDialog(null);
    setDraftName('');
    setDraftError('');
    setBcError('');
  };

  const confirmDeleteProfile = async (name: string) => {
    setDialog(null);
    setError('');
    try {
      await api.deleteProfile(name);
      setProfiles((prev) => prev.filter((p) => p.name !== name));
      setProfileChoice('');
    } catch (err) {
      setError((err as Error).message);
    }
  };

  return (
    <div className="app">
      <Sidebar
        workspaces={workspaces}
        sessions={sessions}
        selectedId={selected?.id ?? null}
        onSelect={select}
        onAdd={addWorkspace}
        onRemove={removeWorkspace}
      />
      <main className="main">
        {selected ? (
          <>
            <div className="main-bar">
              <span className="main-title" title={selected.dir}>{selected.name}</span>
              <select value={profileChoice} onChange={(e) => setProfileChoice(e.target.value)}>
                <option value="">
                  default{defaultEmail ? ` — ${defaultEmail}` : ''}
                </option>
                {profiles.map((p) => (
                  <option key={p.name} value={p.name}>
                    {p.name} — {p.email ?? 'not logged in'}
                  </option>
                ))}
                <option value={NEW_PROFILE}>+ new profile…</option>
              </select>
              <button className="btn" onClick={newPane}>
                <IconPlus size={13} /> New pane
              </button>
              <button
                className="btn btn-secondary"
                onClick={openBroadcast}
                disabled={!runningPanes.length}
                title="Send one instruction to several panes at once"
              >
                <IconMegaphone size={13} /> Broadcast
              </button>
              {profileChoice && profileChoice !== NEW_PROFILE && (
                <button
                  className="btn btn-small btn-danger"
                  onClick={() => {
                    const p = profiles.find((x) => x.name === profileChoice);
                    if (p) setDialog({ kind: 'delete-profile', profile: p });
                  }}
                  title="Delete this profile (removes its stored login)"
                >
                  <IconTrash size={12} /> Delete profile
                </button>
              )}
              {error && <span className="form-error">{error}</span>}
              <div className="toolbar-right">
                <button
                  className="tbtn"
                  onClick={openUsage}
                  title="Token usage per account — rolling windows from 1 h to 30 d, plus all time"
                >
                  <IconChart /> Usage
                </button>
                <button
                  className={`tbtn ${autoRevive ? 'on' : ''}`}
                  onClick={toggleAutoRevive}
                  title={autoRevive
                    ? 'Auto-revive on: dead panes come back automatically when the server starts'
                    : 'Auto-revive off — after a server restart, each dead pane needs a revive click'}
                >
                  <IconRefresh /> Auto-revive
                </button>
                <button
                  className={`tbtn ${debugOpen ? 'on' : ''}`}
                  onClick={() => setDebugOpen((o) => !o)}
                  title="Live server event log (spawns, attaches, hooks, errors)"
                >
                  <IconBug /> Debug
                </button>
                <button
                  className={`tbtn ${notify ? 'on' : ''}`}
                  onClick={toggleNotify}
                  title={notify
                    ? 'Alerts on: you get a desktop notification when a pane needs input or finishes (while this tab is unfocused)'
                    : 'Alerts off — click to get desktop notifications when a pane needs input or finishes'}
                >
                  {notify ? <IconBell /> : <IconBellOff />} Alerts
                </button>
              </div>
            </div>
            {panes.length ? (
              <div className={maximizedId ? 'grid cols-1' : `grid cols-${Math.min(panes.length, 3)}`}>
                {panes.map((s) => (
                  <div
                    key={s.id}
                    className={`pane-slot ${dragOverId === s.id && dragId && dragId !== s.id ? 'drag-over' : ''}`}
                    style={maximizedId && maximizedId !== s.id ? { display: 'none' } : undefined}
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
                      isMaximized={maximizedId === s.id}
                      onToggleMax={() => setMaximizedId((m) => (m === s.id ? null : s.id))}
                      onGripDragStart={() => setDragId(s.id)}
                      onGripDragEnd={() => { setDragId(null); setDragOverId(null); }}
                      isPasteFallback={maximizedId === s.id || (!maximizedId && panes.length === 1)}
                    />
                  </div>
                ))}
              </div>
            ) : (
              <div className="main-empty">
                No panes in this workspace — hit <b>New pane</b> to launch a Claude session.
              </div>
            )}
          </>
        ) : (
          <div className="main-empty">Add a workspace to get started.</div>
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
          {!globalUsage ? (
            <p className="modal-desc">crunching transcripts…</p>
          ) : !globalUsage.length ? (
            <p className="modal-desc">No usage data found.</p>
          ) : (
            globalUsage.map((a) => {
              const w = a.windows[usageWindow] ?? { in: 0, out: 0, models: {} };
              const models = Object.entries(w.models).sort(([, x], [, y]) => y.output - x.output);
              const maxOut = Math.max(...models.map(([, m]) => m.output), 1);
              return (
                <div key={a.account} className="usage-account">
                  <div className="usage-account-head">
                    <b>{a.account}</b>
                    <span className="usage-email">{a.email ?? 'not logged in'}</span>
                    <span className="usage-headline">
                      <b>{fmt(w.out)}</b> out · {fmt(w.in)} in
                    </span>
                  </div>
                  {models.length > 0 && w.out > 0 ? (
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
                            {fmt(m.cacheRead)} cache · {m.turns} turns
                          </span>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div className="usage-empty">no usage in this window</div>
                  )}
                </div>
              );
            })
          )}
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
    </div>
  );
}
