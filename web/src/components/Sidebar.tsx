import { useState } from 'react';
import type { SessionInfo, Workspace } from '../types';

interface Props {
  workspaces: Workspace[];
  sessions: SessionInfo[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onAdd: (name: string, dir: string) => Promise<void>;
  onRemove: (id: string) => void;
}

export function Sidebar({ workspaces, sessions, selectedId, onSelect, onAdd, onRemove }: Props) {
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState('');
  const [dir, setDir] = useState('');
  const [error, setError] = useState('');

  const runningIn = (ws: Workspace) =>
    sessions.filter((s) => s.workspace === ws.dir && s.status === 'running').length;

  const submit = async () => {
    if (!dir.trim()) return;
    try {
      await onAdd(name.trim() || dir.trim().split(/[\\/]/).filter(Boolean).pop()!, dir.trim());
      setName('');
      setDir('');
      setError('');
      setAdding(false);
    } catch (err) {
      setError((err as Error).message);
    }
  };

  return (
    <aside className="sidebar">
      <div className="sidebar-brand">Helm ⎈</div>
      <div className="sidebar-list">
        {workspaces.map((ws) => (
          <div
            key={ws.id}
            className={`ws-item ${ws.id === selectedId ? 'selected' : ''}`}
            onClick={() => onSelect(ws.id)}
            title={ws.dir}
          >
            <span className="ws-name">{ws.name}</span>
            {runningIn(ws) > 0 && <span className="ws-badge">{runningIn(ws)}</span>}
            <button
              className="ws-remove"
              title="Remove workspace (sessions keep running)"
              onClick={(e) => {
                e.stopPropagation();
                onRemove(ws.id);
              }}
            >
              ×
            </button>
          </div>
        ))}
        {workspaces.length === 0 && !adding && (
          <div className="sidebar-empty">No workspaces yet — add a project folder.</div>
        )}
      </div>
      {adding ? (
        <div className="ws-add-form">
          <input
            placeholder="directory path"
            value={dir}
            onChange={(e) => setDir(e.target.value)}
            autoFocus
          />
          <input placeholder="name (optional)" value={name} onChange={(e) => setName(e.target.value)} />
          {error && <div className="form-error">{error}</div>}
          <div className="ws-add-actions">
            <button className="btn" onClick={submit}>Add</button>
            <button className="btn btn-ghost" onClick={() => { setAdding(false); setError(''); }}>
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <button className="btn sidebar-add" onClick={() => setAdding(true)}>
          + Add workspace
        </button>
      )}
    </aside>
  );
}
