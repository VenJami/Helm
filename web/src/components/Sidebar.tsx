import { useEffect, useState } from 'react';
import type { GitInfo, Profile, ServerInfo, SessionInfo, Workspace } from '../types';
import { accountLabel } from '../accounts';
import { IconFolder, IconGitBranch, IconGrip, IconHelm, IconPanelLeftClose, IconPencil, IconPlus, IconSearch, IconServer, IconTrash, IconX } from './Icons';

interface Props {
  workspaces: Workspace[];
  sessions: SessionInfo[];
  git: Record<string, GitInfo>; // workspace id → git status (branch/dirty/ahead/behind)
  servers: Record<string, ServerInfo>; // workspace id → dev-server up/down (configured ports only)
  selectedId: string | null;
  defaultEmail: string | null; // used to label workspaces on the default account
  profiles: Profile[];         // to reuse a matching profile's name for the default
  onSelect: (id: string) => void;
  onAddClick: () => void;
  onRename: (id: string, name: string) => Promise<void>;
  onChangeDir: (id: string, dir: string) => Promise<void>;
  onSetPort: (id: string, port: number | null) => Promise<void>;
  onRemove: (id: string) => void;
  onHide: () => void;
  // Drag-to-reorder: grip on each row → drop on another row's slot.
  dragId: string | null;
  dragOverId: string | null;
  onDragStart: (id: string) => void;
  onDragOver: (id: string | null) => void;
  onDrop: (targetId: string) => void;
  onDragEnd: () => void;
}

export function Sidebar({
  workspaces, sessions, git, servers, selectedId, defaultEmail, profiles, onSelect, onAddClick,
  onRename, onChangeDir, onSetPort, onRemove, onHide,
  dragId, dragOverId, onDragStart, onDragOver, onDrop, onDragEnd,
}: Props) {
  const [query, setQuery] = useState('');
  const shown = query.trim()
    ? workspaces.filter((w) => w.name.toLowerCase().includes(query.trim().toLowerCase()))
    : workspaces;
  // Right-click menu (rename / change root dir / remove) + the inline editor it opens.
  const [menu, setMenu] = useState<{ id: string; x: number; y: number } | null>(null);
  const [edit, setEdit] = useState<{ id: string; field: 'name' | 'dir' | 'port'; value: string } | null>(null);
  const [editError, setEditError] = useState('');

  // Any click, scroll, or Escape dismisses the context menu.
  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setMenu(null); };
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
    const running = sessions.filter((s) => s.workspace === ws.dir && s.status === 'running');
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

  const startEdit = (id: string, field: 'name' | 'dir' | 'port', value: string) => {
    setEditError('');
    setEdit({ id, field, value });
    setMenu(null);
  };

  const submitEdit = async () => {
    if (!edit) return;
    const v = edit.value.trim();
    // Port is the one field where blank is meaningful — it clears the check.
    if (!v && edit.field !== 'port') { setEdit(null); return; }
    try {
      if (edit.field === 'name') await onRename(edit.id, v);
      else if (edit.field === 'dir') await onChangeDir(edit.id, v);
      else {
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
              <input
                className="ws-edit-input"
                value={edit.value}
                placeholder={
                  edit.field === 'dir' ? 'directory path'
                    : edit.field === 'port' ? 'dev-server port (blank to clear)'
                    : 'workspace name'
                }
                autoFocus
                onChange={(e) => setEdit({ ...edit, value: e.target.value })}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void submitEdit();
                  else if (e.key === 'Escape') { setEdit(null); setEditError(''); }
                }}
                onBlur={() => void submitEdit()}
              />
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
                <span className="ws-account">{ws.profile || accountLabel('', defaultEmail, profiles)}</span>
                {git[ws.id]?.branch && (
                  <span
                    className="ws-git"
                    title={git[ws.id].dirty ? 'uncommitted changes' : 'working tree clean'}
                  >
                    <IconGitBranch size={11} />
                    <span className="ws-git-branch">{git[ws.id].branch}</span>
                    {git[ws.id].dirty && <span className="ws-git-dirty" title="uncommitted changes" />}
                    {git[ws.id].ahead > 0 && <span className="ws-git-track">↑{git[ws.id].ahead}</span>}
                    {git[ws.id].behind > 0 && <span className="ws-git-track">↓{git[ws.id].behind}</span>}
                  </span>
                )}
                {ws.port && (
                  <span
                    className="ws-server"
                    title={
                      !servers[ws.id] ? `checking dev server on :${ws.port}…`
                        : servers[ws.id].up ? `dev server up on :${ws.port}`
                        : `dev server down on :${ws.port}`
                    }
                  >
                    <span
                      className={`ws-server-dot ${servers[ws.id] ? (servers[ws.id].up ? 'up' : 'down') : 'unknown'}`}
                    />
                    <span className="ws-server-port">:{ws.port}</span>
                  </span>
                )}
              </div>
              {(() => {
                const p = panesIn(ws);
                if (p.total === 0) return null;
                return (
                  <span className="ws-badges">
                    {p.working > 0 && (
                      <span className="ws-badge ws-badge-working" title={`${p.working} working`}>{p.working}</span>
                    )}
                    {p.waiting > 0 && (
                      <span className="ws-badge ws-badge-waiting" title={`${p.waiting} waiting`}>{p.waiting}</span>
                    )}
                    {p.working === 0 && p.waiting === 0 && (
                      <span className="ws-badge" title={`${p.total} running`}>{p.total}</span>
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
          onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); }}
        >
          <button className="ws-menu-item" onClick={() => startEdit(menuWs.id, 'name', menuWs.name)}>
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
          <div className="ws-menu-sep" />
          <button
            className="ws-menu-item ws-menu-danger"
            onClick={() => { onRemove(menuWs.id); setMenu(null); }}
          >
            <IconTrash size={13} /> Remove workspace
          </button>
        </div>
      )}
    </aside>
  );
}
