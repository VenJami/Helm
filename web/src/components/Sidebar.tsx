import { useEffect, useState } from 'react';
import type { GitInfo, Profile, ServerInfo, SessionInfo, TunnelInfo, Workspace } from '../types';
import { accountLabel } from '../accounts';
import {
  IconFolder,
  IconGitBranch,
  IconGlobe,
  IconGrip,
  IconHelm,
  IconPanelLeftClose,
  IconPencil,
  IconPlay,
  IconPlus,
  IconSearch,
  IconServer,
  IconSparkle,
  IconStop,
  IconTerminal,
  IconTrash,
  IconX,
} from './Icons';

interface Props {
  workspaces: Workspace[];
  sessions: SessionInfo[];
  git: Record<string, GitInfo>; // workspace id → git status (branch/dirty/ahead/behind)
  servers: Record<string, ServerInfo>; // workspace id → dev-server up/down (configured ports only)
  // Public share links. `tunnels` is keyed by workspace id; absent = not shared.
  // tunnelsAvailable false = cloudflared isn't installed, so sharing is offered
  // only as an install hint (Helm never installs it — owner's call).
  tunnels: Record<string, TunnelInfo>;
  tunnelsAvailable: boolean;
  installHint: string;
  selectedId: string | null;
  defaultEmail: string | null; // used to label workspaces on the default account
  profiles: Profile[]; // to reuse a matching profile's name for the default
  onSelect: (id: string) => void;
  onAddClick: () => void;
  onRename: (id: string, name: string) => Promise<void>;
  onChangeDir: (id: string, dir: string) => Promise<void>;
  onSetPort: (id: string, port: number | null) => Promise<void>;
  onSetStartCommands: (id: string, commands: string[] | null) => Promise<void>;
  onRemove: (id: string) => void;
  onHide: () => void;
  // ▶ / ■ on the workspace card: run (or stop) the project's start commands —
  // one dev pane each, hidden in the tray until `onShowDev` opens them.
  // onStartDev resolves to 'needs-command' when the project has none and none
  // could be detected, which opens the editor pre-filled by claude.
  onStartDev: (id: string) => Promise<'started' | 'needs-command' | 'failed'>;
  onStopDev: (id: string) => void;
  onShowDev: (id: string) => void; // open this project's dev panes (or send them back)
  devPanesOpen: (id: string) => boolean; // false = minimized/not on screen
  // Ask claude how the project starts (headless, read-only, costs a few cents).
  onSuggestStart: (id: string) => Promise<string[]>;
  // Share this project's dev server publicly (opens the warning dialog first),
  // or take an existing link down.
  onShare: (id: string) => void;
  onUnshare: (id: string) => void;
  onShowShares: () => void; // open the panel listing every live public link
  // Drag-to-reorder: grip on each row → drop on another row's slot.
  dragId: string | null;
  dragOverId: string | null;
  onDragStart: (id: string) => void;
  onDragOver: (id: string | null) => void;
  onDrop: (targetId: string) => void;
  onDragEnd: () => void;
}

// "in 27m" / "in 40s" — how long a share link has left. Refreshed by the 4 s
// tunnel poll re-rendering the sidebar, so it doesn't need its own timer.
function expiryLabel(expiresAt: number) {
  const left = expiresAt - Date.now();
  if (left <= 0) return 'now';
  const mins = Math.floor(left / 60000);
  return mins >= 1 ? `${mins}m` : `${Math.floor(left / 1000)}s`;
}

export function Sidebar({
  workspaces,
  sessions,
  git,
  servers,
  tunnels,
  tunnelsAvailable,
  installHint,
  selectedId,
  defaultEmail,
  profiles,
  onSelect,
  onAddClick,
  onRename,
  onChangeDir,
  onSetPort,
  onSetStartCommands,
  onRemove,
  onHide,
  onStartDev,
  onStopDev,
  onShowDev,
  devPanesOpen,
  onSuggestStart,
  onShare,
  onUnshare,
  onShowShares,
  dragId,
  dragOverId,
  onDragStart,
  onDragOver,
  onDrop,
  onDragEnd,
}: Props) {
  const [query, setQuery] = useState('');
  const shown = query.trim()
    ? workspaces.filter((w) => w.name.toLowerCase().includes(query.trim().toLowerCase()))
    : workspaces;
  // Right-click menu (rename / change root dir / remove) + the inline editor it opens.
  const [menu, setMenu] = useState<{ id: string; x: number; y: number } | null>(null);
  const [edit, setEdit] = useState<{
    id: string;
    field: 'name' | 'dir' | 'port' | 'start';
    value: string;
    // Set when the editor was opened by ▶ rather than the right-click menu:
    // accepting the commands then starts the project straight away.
    run?: boolean;
  } | null>(null);
  const [editError, setEditError] = useState('');
  // Workspace id whose start command claude is currently working out.
  const [asking, setAsking] = useState<string | null>(null);

  // Ask claude how this project starts and drop the answer into the editor —
  // the owner still has to accept it, so nothing runs unreviewed.
  const askClaude = async (id: string) => {
    setAsking(id);
    setEditError('');
    try {
      const commands = await onSuggestStart(id);
      if (!commands.length) {
        setEditError("claude couldn't work out how to start this one — type it yourself");
      } else {
        setEdit((prev) => ({
          id,
          field: 'start',
          value: commands.join('\n'),
          run: prev?.id === id ? prev.run : undefined,
        }));
      }
    } catch (err) {
      setEditError((err as Error).message);
    } finally {
      setAsking(null);
    }
  };

  // ▶: start the project; if it has no command (and none could be detected),
  // fall straight into asking claude and open the editor pre-filled.
  const startOrAsk = async (id: string) => {
    if ((await onStartDev(id)) === 'needs-command') {
      setEdit({ id, field: 'start', value: '', run: true });
      await askClaude(id);
    }
  };

  // Any click, scroll, or Escape dismisses the context menu.
  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMenu(null);
    };
    window.addEventListener('click', close);
    window.addEventListener('scroll', close, true);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('click', close);
      window.removeEventListener('scroll', close, true);
      window.removeEventListener('keydown', onKey);
    };
  }, [menu]);

  // Breakdown of live claude panes in a workspace by hook activity, for the
  // sidebar badges: working (green) + waiting (amber) called out separately;
  // `total` covers all running panes (idle included).
  const panesIn = (ws: Workspace) => {
    const running = sessions.filter(
      (s) => s.workspace === ws.dir && s.status === 'running' && s.kind !== 'dev',
    );
    return {
      total: running.length,
      working: running.filter((s) => s.activity === 'working').length,
      waiting: running.filter((s) => s.activity === 'waiting').length,
    };
  };

  const openMenu = (e: React.MouseEvent, id: string) => {
    e.preventDefault();
    e.stopPropagation();
    setMenu({ id, x: e.clientX, y: e.clientY });
  };

  // A workspace's dev panes (one per start command).
  const devPanesFor = (ws: Workspace) =>
    sessions.filter((s) => s.kind === 'dev' && s.workspace === ws.dir);

  const startEdit = (id: string, field: 'name' | 'dir' | 'port' | 'start', value: string) => {
    setEditError('');
    setEdit({ id, field, value });
    setMenu(null);
  };

  const submitEdit = async () => {
    if (!edit) return;
    const v = edit.value.trim();
    // Port and start command are the fields where blank is meaningful — it
    // clears them.
    if (!v && edit.field !== 'port' && edit.field !== 'start') {
      setEdit(null);
      return;
    }
    try {
      if (edit.field === 'name') await onRename(edit.id, v);
      else if (edit.field === 'dir') await onChangeDir(edit.id, v);
      else if (edit.field === 'start') {
        const lines = v
          .split('\n')
          .map((l) => l.trim())
          .filter(Boolean);
        await onSetStartCommands(edit.id, lines.length ? lines : null);
        // Opened by ▶: the owner has now seen the commands, so run them.
        if (edit.run && lines.length) void onStartDev(edit.id);
      } else {
        const port = v ? Number(v) : null;
        if (port !== null && (!Number.isInteger(port) || port < 1 || port > 65535)) {
          throw new Error('port must be 1–65535');
        }
        await onSetPort(edit.id, port);
      }
      setEdit(null);
      setEditError('');
    } catch (err) {
      setEditError((err as Error).message);
    }
  };

  const menuWs = menu && workspaces.find((w) => w.id === menu.id);

  return (
    <aside className="sidebar">
      <div className="sidebar-brand">
        <IconHelm size={17} /> Helm
        <button className="sidebar-hide" title="Hide sidebar" onClick={onHide}>
          <IconPanelLeftClose size={16} />
        </button>
      </div>
      <div className="sidebar-search">
        <IconSearch size={13} />
        <input
          className="sidebar-search-input"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search workspaces…"
        />
      </div>
      <div className="sidebar-list">
        {shown.map((ws) =>
          edit && edit.id === ws.id ? (
            <div key={ws.id} className="ws-item ws-editing">
              {edit.field === 'start' ? (
                // Start commands are a LIST (one per line) — a project can need
                // a backend and a frontend watcher. Enter adds a line here, so
                // Ctrl+Enter (or clicking away) saves.
                <>
                  <textarea
                    className="ws-edit-input ws-edit-area"
                    value={edit.value}
                    rows={Math.min(Math.max(edit.value.split('\n').length, 2), 6)}
                    placeholder={
                      'one command per line, e.g.\ncd server && npm start\ncd web && npm run watch'
                    }
                    autoFocus
                    disabled={asking === edit.id}
                    onChange={(e) => setEdit({ ...edit, value: e.target.value })}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) void submitEdit();
                      else if (e.key === 'Escape') {
                        setEdit(null);
                        setEditError('');
                      }
                    }}
                    onBlur={() => void submitEdit()}
                  />
                  <div className="ws-edit-row">
                    <button
                      className="ws-edit-ask"
                      disabled={asking === edit.id}
                      // onMouseDown, not onClick: the textarea's blur would
                      // save-and-close the editor before a click landed.
                      onMouseDown={(e) => {
                        e.preventDefault();
                        void askClaude(edit.id);
                      }}
                    >
                      <IconSparkle size={12} />
                      {asking === edit.id ? 'asking Claude…' : 'Ask Claude'}
                    </button>
                    <span className="ws-edit-hint">Ctrl+Enter saves · Esc cancels</span>
                  </div>
                </>
              ) : (
                <input
                  className="ws-edit-input"
                  value={edit.value}
                  placeholder={
                    edit.field === 'dir'
                      ? 'directory path'
                      : edit.field === 'port'
                        ? 'dev-server port (blank to clear)'
                        : 'workspace name'
                  }
                  autoFocus
                  onChange={(e) => setEdit({ ...edit, value: e.target.value })}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') void submitEdit();
                    else if (e.key === 'Escape') {
                      setEdit(null);
                      setEditError('');
                    }
                  }}
                  onBlur={() => void submitEdit()}
                />
              )}
              {editError && <div className="form-error ws-edit-error">{editError}</div>}
            </div>
          ) : (
            <div
              key={ws.id}
              className={`ws-item ${ws.id === selectedId ? 'selected' : ''}${dragOverId === ws.id && dragId && dragId !== ws.id ? ' drag-over' : ''}`}
              onClick={() => onSelect(ws.id)}
              onContextMenu={(e) => openMenu(e, ws.id)}
              onDragOver={(e) => {
                if (!dragId) return;
                e.preventDefault();
                onDragOver(ws.id);
              }}
              onDragLeave={() => onDragOver(null)}
              onDrop={(e) => {
                e.preventDefault();
                onDrop(ws.id);
              }}
              title={ws.dir}
            >
              <span
                className="ws-grip"
                draggable
                title="Drag to reorder"
                onClick={(e) => e.stopPropagation()}
                onDragStart={(e) => {
                  e.dataTransfer.effectAllowed = 'move';
                  e.dataTransfer.setData('text/plain', ws.id);
                  onDragStart(ws.id);
                }}
                onDragEnd={onDragEnd}
              >
                <IconGrip size={13} />
              </span>
              <IconFolder size={14} />
              <div className="ws-text">
                <span className="ws-name">{ws.name}</span>
                <span className="ws-account">
                  {ws.profile || accountLabel('', defaultEmail, profiles)}
                </span>
                {git[ws.id]?.branch && (
                  <span
                    className="ws-git"
                    title={git[ws.id].dirty ? 'uncommitted changes' : 'working tree clean'}
                  >
                    <IconGitBranch size={11} />
                    <span className="ws-git-branch">{git[ws.id].branch}</span>
                    {git[ws.id].dirty && (
                      <span className="ws-git-dirty" title="uncommitted changes" />
                    )}
                    {git[ws.id].ahead > 0 && (
                      <span className="ws-git-track">↑{git[ws.id].ahead}</span>
                    )}
                    {git[ws.id].behind > 0 && (
                      <span className="ws-git-track">↓{git[ws.id].behind}</span>
                    )}
                  </span>
                )}
                {ws.port && (
                  <span
                    className="ws-server"
                    title={
                      !servers[ws.id]
                        ? `checking dev server on :${ws.port}…`
                        : servers[ws.id].up
                          ? `dev server up on :${ws.port}`
                          : `dev server down on :${ws.port}`
                    }
                  >
                    <span
                      className={`ws-server-dot ${servers[ws.id] ? (servers[ws.id].up ? 'up' : 'down') : 'unknown'}`}
                    />
                    <span className="ws-server-port">:{ws.port}</span>
                  </span>
                )}
                {tunnels[ws.id] && (
                  <span
                    className={`ws-public ws-public-${tunnels[ws.id].status}`}
                    title={
                      tunnels[ws.id].status === 'live'
                        ? `PUBLIC on the internet — ${tunnels[ws.id].url}
Click to open the link panel. Expires in ${expiryLabel(tunnels[ws.id].expiresAt)}.`
                        : tunnels[ws.id].status === 'starting'
                          ? 'opening the public tunnel…'
                          : tunnels[ws.id].error || 'the tunnel failed'
                    }
                    onClick={(e) => {
                      // Opens the panel rather than copying silently: a click
                      // that does something invisible reads as a dead button.
                      e.stopPropagation();
                      onShowShares();
                    }}
                  >
                    <IconGlobe size={10} />
                    {tunnels[ws.id].status === 'live' ? (
                      // Just the flag here: the sidebar column is ~60px, so
                      // the countdown lives in the toolbar pill (which has the
                      // room and is visible from every workspace) and in the
                      // tooltip below.
                      <b>PUBLIC</b>
                    ) : (
                      <b>{tunnels[ws.id].status === 'starting' ? 'OPENING…' : 'FAILED'}</b>
                    )}
                  </span>
                )}
              </div>
              {(() => {
                const p = panesIn(ws);
                if (p.total === 0) return null;
                return (
                  <span className="ws-badges">
                    {p.working > 0 && (
                      <span className="ws-badge ws-badge-working" title={`${p.working} working`}>
                        {p.working}
                      </span>
                    )}
                    {p.waiting > 0 && (
                      <span className="ws-badge ws-badge-waiting" title={`${p.waiting} waiting`}>
                        {p.waiting}
                      </span>
                    )}
                    {p.working === 0 && p.waiting === 0 && (
                      <span className="ws-badge" title={`${p.total} running`}>
                        {p.total}
                      </span>
                    )}
                  </span>
                );
              })()}
              {(() => {
                // Start / stop the project itself. The dev pane's output opens
                // from the terminal button next to it.
                const panes = devPanesFor(ws);
                const liveCount = panes.filter((p) => p.status === 'running').length;
                const live = liveCount > 0;
                const cmds = ws.startCommands ?? [];
                const busy = asking === ws.id;
                return (
                  <span className="ws-run" onClick={(e) => e.stopPropagation()}>
                    <button
                      className={`ws-run-btn ${live ? 'live' : ''}`}
                      disabled={busy}
                      title={
                        busy
                          ? 'asking Claude how this project starts…'
                          : live
                            ? `Stop ${liveCount > 1 ? `${liveCount} processes` : `"${cmds[0] ?? 'dev server'}"`}`
                            : cmds.length
                              ? `Start: ${cmds.join(' · ')}`
                              : 'Start project (Helm works out the command)'
                      }
                      onClick={() => (live ? onStopDev(ws.id) : void startOrAsk(ws.id))}
                    >
                      {live ? <IconStop size={16} /> : <IconPlay size={16} />}
                    </button>
                    {panes.length > 0 && (
                      <button
                        className={`ws-run-btn ${devPanesOpen(ws.id) ? 'open' : live ? 'live' : ''}`}
                        title={
                          devPanesOpen(ws.id)
                            ? `Hide the dev output (${panes.length} pane${panes.length > 1 ? 's' : ''})`
                            : `Show the dev output (${panes.length} pane${panes.length > 1 ? 's' : ''})`
                        }
                        onClick={() => onShowDev(ws.id)}
                      >
                        <IconTerminal size={16} />
                        {panes.length > 1 && <span className="ws-run-count">{panes.length}</span>}
                      </button>
                    )}
                    {ws.port && (
                      <button
                        className={`ws-run-btn ${tunnels[ws.id] ? 'public' : ''}`}
                        title={
                          tunnels[ws.id]
                            ? `Stop sharing :${ws.port} publicly`
                            : tunnelsAvailable
                              ? `Share :${ws.port} on the internet (unauthenticated — warns first)`
                              : `Public sharing needs cloudflared. Install it with: ${installHint}`
                        }
                        onClick={() => (tunnels[ws.id] ? onUnshare(ws.id) : onShare(ws.id))}
                      >
                        <IconGlobe size={16} />
                      </button>
                    )}
                  </span>
                );
              })()}
              <button
                className="ws-remove"
                title="Remove workspace (sessions keep running)"
                onClick={(e) => {
                  e.stopPropagation();
                  onRemove(ws.id);
                }}
              >
                <IconX size={13} />
              </button>
            </div>
          ),
        )}
        {workspaces.length === 0 && (
          <div className="sidebar-empty">No workspaces yet — add a project folder.</div>
        )}
      </div>
      <button className="btn btn-secondary sidebar-add" onClick={onAddClick}>
        <IconPlus size={13} /> Add workspace
      </button>

      {menu && menuWs && (
        <div
          className="ws-menu"
          style={{ top: menu.y, left: menu.x }}
          onClick={(e) => e.stopPropagation()}
          onContextMenu={(e) => {
            e.preventDefault();
            e.stopPropagation();
          }}
        >
          <button
            className="ws-menu-item"
            onClick={() => startEdit(menuWs.id, 'name', menuWs.name)}
          >
            <IconPencil size={13} /> Rename
          </button>
          <button className="ws-menu-item" onClick={() => startEdit(menuWs.id, 'dir', menuWs.dir)}>
            <IconFolder size={13} /> Change root directory
          </button>
          <button
            className="ws-menu-item"
            onClick={() => startEdit(menuWs.id, 'port', menuWs.port ? String(menuWs.port) : '')}
          >
            <IconServer size={13} /> Set dev-server port…
          </button>
          {menuWs.port && (
            <button
              className={`ws-menu-item ${tunnels[menuWs.id] ? '' : 'ws-menu-danger'}`}
              onClick={() => {
                if (tunnels[menuWs.id]) onUnshare(menuWs.id);
                else onShare(menuWs.id);
                setMenu(null);
              }}
            >
              <IconGlobe size={13} />{' '}
              {tunnels[menuWs.id] ? 'Stop sharing publicly' : 'Share on the internet…'}
            </button>
          )}
          <button
            className="ws-menu-item"
            onClick={() => startEdit(menuWs.id, 'start', (menuWs.startCommands ?? []).join('\n'))}
          >
            <IconPlay size={13} /> Set start command(s)…
          </button>
          <button
            className="ws-menu-item"
            onClick={() => {
              setMenu(null);
              setEdit({ id: menuWs.id, field: 'start', value: '' });
              void askClaude(menuWs.id);
            }}
          >
            <IconSparkle size={13} /> Ask Claude how to start it…
          </button>
          <div className="ws-menu-sep" />
          <button
            className="ws-menu-item ws-menu-danger"
            onClick={() => {
              onRemove(menuWs.id);
              setMenu(null);
            }}
          >
            <IconTrash size={13} /> Remove workspace
          </button>
        </div>
      )}
    </aside>
  );
}
