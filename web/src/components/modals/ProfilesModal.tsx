import { useState } from 'react';
import { Modal } from '../Modal';
import { IconPencil, IconTrash } from '../Icons';
import type { Profile } from '../../types';

// Manage account profiles: list, rename, delete. What used to be THREE dialog
// kinds in App (manage-profiles / edit-profile / delete-profile) is one modal
// with an internal view state — the flow never leaves this component, and the
// rename draft lives here.
type View =
  | { mode: 'list' }
  | { mode: 'rename'; profile: Profile }
  | { mode: 'delete'; profile: Profile };

export function ProfilesModal({ profiles, onClose, renameProfile, onDelete }: {
  profiles: Profile[];
  onClose: () => void;
  // Performs the rename (API + state sync) — throws on failure so the error
  // can be shown inline next to the field.
  renameProfile: (oldName: string, nextName: string) => Promise<void>;
  // Fire-and-forget delete; the parent toasts on failure.
  onDelete: (name: string) => void;
}) {
  const [view, setView] = useState<View>({ mode: 'list' });
  const [draft, setDraft] = useState('');
  const [error, setError] = useState('');

  const backToList = () => {
    setView({ mode: 'list' });
    setDraft('');
    setError('');
  };

  const submitRename = async (oldName: string) => {
    const nextName = draft.trim();
    if (!/^[\w-]+$/.test(nextName)) {
      setError('Use letters, numbers, dashes or underscores only.');
      return;
    }
    if (nextName !== oldName && profiles.some((p) => p.name === nextName)) {
      setError('That profile already exists.');
      return;
    }
    try {
      await renameProfile(oldName, nextName);
      backToList();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  if (view.mode === 'rename') {
    return (
      <Modal title={`Rename profile "${view.profile.name}"`} onClose={onClose}>
        <p className="modal-desc">
          Renaming updates any panes or workspaces pinned to this profile.
        </p>
        <input
          className="modal-input"
          placeholder="profile name — e.g. work, personal-max"
          value={draft}
          autoFocus
          onChange={(e) => {
            setDraft(e.target.value);
            setError('');
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void submitRename(view.profile.name);
          }}
        />
        {error && <div className="form-error">{error}</div>}
        <div className="modal-actions">
          <button className="btn btn-ghost" onClick={backToList}>Back</button>
          <button
            className="btn"
            onClick={() => void submitRename(view.profile.name)}
            disabled={!draft.trim()}
          >
            Save
          </button>
        </div>
      </Modal>
    );
  }

  if (view.mode === 'delete') {
    return (
      <Modal title={`Delete profile "${view.profile.name}"?`} onClose={onClose}>
        <p className="modal-desc">
          {view.profile.email ? (
            <>Signed in as <b>{view.profile.email}</b>. </>
          ) : (
            <>This profile was never signed in. </>
          )}
          Deleting removes its stored login from this PC — the Claude account
          itself is untouched, and you can add the profile again later.
        </p>
        <div className="modal-actions">
          <button className="btn btn-ghost" onClick={backToList}>Cancel</button>
          <button
            className="btn btn-danger"
            onClick={() => { onClose(); onDelete(view.profile.name); }}
          >
            Delete profile
          </button>
        </div>
      </Modal>
    );
  }

  return (
    <Modal title="Manage profiles" onClose={onClose}>
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
                  setDraft(p.name);
                  setError('');
                  setView({ mode: 'rename', profile: p });
                }}
              >
                <IconPencil size={12} />
              </button>
              <button
                className="btn btn-small btn-danger"
                title="Delete this profile (removes its stored login)"
                onClick={() => setView({ mode: 'delete', profile: p })}
              >
                <IconTrash size={12} />
              </button>
            </div>
          ))}
        </div>
      )}
      <div className="modal-actions">
        <button className="btn btn-ghost" onClick={onClose}>Close</button>
      </div>
    </Modal>
  );
}
