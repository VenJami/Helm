import { useState } from 'react';
import { api } from '../../api';
import { Modal } from '../Modal';
import type { Profile, Workspace } from '../../types';

// Add a project folder as a workspace. Owns its draft fields AND the create
// call (validation + API errors display inline here); the parent only learns
// about the successfully created workspace.
export function AddWorkspaceModal({
  profiles,
  onClose,
  onAdded,
}: {
  profiles: Profile[];
  onClose: () => void;
  onAdded: (ws: Workspace) => void;
}) {
  const [dir, setDir] = useState('');
  const [name, setName] = useState('');
  const [profile, setProfile] = useState('');
  const [port, setPort] = useState('');
  const [error, setError] = useState('');

  const submit = async () => {
    const dirTrim = dir.trim();
    if (!dirTrim) {
      setError('A directory path is required.');
      return;
    }
    let portNum: number | null = null;
    if (port.trim()) {
      const p = Number(port);
      if (!Number.isInteger(p) || p < 1 || p > 65535) {
        setError('Port must be a whole number between 1 and 65535.');
        return;
      }
      portNum = p;
    }
    const wsName = name.trim() || dirTrim.split(/[\\/]/).filter(Boolean).pop() || dirTrim;
    try {
      const created = await api.addWorkspace(wsName, dirTrim, profile || undefined);
      // Port isn't part of the create payload — set it in a follow-up patch.
      const ws =
        portNum !== null ? await api.updateWorkspace(created.id, { port: portNum }) : created;
      onClose();
      onAdded(ws);
    } catch (err) {
      setError((err as Error).message);
    }
  };

  return (
    <Modal title="Add workspace" onClose={onClose}>
      <p className="modal-desc">
        Point Helm at a project folder. Panes you open here launch Claude in this directory.
      </p>
      <label className="field-label">Directory path</label>
      <input
        className="modal-input"
        placeholder="e.g. C:\Users\you\Projects\my-app"
        value={dir}
        autoFocus
        onChange={(e) => {
          setDir(e.target.value);
          setError('');
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') void submit();
        }}
      />
      <label className="field-label">
        Name <span className="field-hint">(optional — defaults to the folder name)</span>
      </label>
      <input
        className="modal-input"
        placeholder="workspace name"
        value={name}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') void submit();
        }}
      />
      <label className="field-label">
        Pinned account <span className="field-hint">(optional)</span>
      </label>
      <select className="modal-input" value={profile} onChange={(e) => setProfile(e.target.value)}>
        <option value="">Default account</option>
        {profiles.map((p) => (
          <option key={p.name} value={p.name}>
            {p.name}
            {p.email ? ` — ${p.email}` : ''}
          </option>
        ))}
      </select>
      <label className="field-label">
        Dev-server port <span className="field-hint">(optional — enables the up/down check)</span>
      </label>
      <input
        className="modal-input"
        placeholder="e.g. 3000"
        inputMode="numeric"
        value={port}
        onChange={(e) => {
          setPort(e.target.value);
          setError('');
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') void submit();
        }}
      />
      {error && <div className="form-error">{error}</div>}
      <div className="modal-actions">
        <button className="btn btn-ghost" onClick={onClose}>
          Cancel
        </button>
        <button className="btn" onClick={() => void submit()} disabled={!dir.trim()}>
          Add workspace
        </button>
      </div>
    </Modal>
  );
}
