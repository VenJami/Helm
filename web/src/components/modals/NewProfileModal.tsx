import { useState } from 'react';
import { Modal } from '../Modal';
import type { Profile } from '../../types';

// Create an isolated account profile. Owns its own draft state — closing the
// dialog discards it (no parent-level field resets to forget).
export function NewProfileModal({ profiles, onClose, onCreate }: {
  profiles: Profile[];
  onClose: () => void;
  // Called with a validated, unique name; the parent pins it + opens the login pane.
  onCreate: (name: string) => void;
}) {
  const [name, setName] = useState('');
  const [error, setError] = useState('');

  const submit = () => {
    const trimmed = name.trim();
    if (!/^[\w-]+$/.test(trimmed)) {
      setError('Use letters, numbers, dashes or underscores only.');
      return;
    }
    if (profiles.some((p) => p.name === trimmed)) {
      setError('That profile already exists.');
      return;
    }
    onClose();
    onCreate(trimmed);
  };

  return (
    <Modal title="New account profile" onClose={onClose}>
      <p className="modal-desc">
        Each profile is an isolated Claude Code account. A pane will open with
        Claude's setup — sign in there with the account this profile is for.
      </p>
      <input
        className="modal-input"
        placeholder="profile name — e.g. work, personal-max"
        value={name}
        autoFocus
        onChange={(e) => {
          setName(e.target.value);
          setError('');
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') submit();
        }}
      />
      {error && <div className="form-error">{error}</div>}
      <div className="modal-actions">
        <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
        <button className="btn" onClick={submit} disabled={!name.trim()}>
          Create &amp; open login pane
        </button>
      </div>
    </Modal>
  );
}
