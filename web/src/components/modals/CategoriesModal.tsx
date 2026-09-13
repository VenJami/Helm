import { useState } from 'react';
import { Modal } from '../Modal';
import { IconPencil, IconTrash } from '../Icons';
import { panesIn } from '../../lib/categories';
import type { Category, SessionInfo } from '../../types';

// Manage pane categories (folders): list, rename, recolor, delete. One modal
// with an internal view state, like ProfilesModal — the edit draft lives here
// and dies with the dialog rather than being reset by hand in App.
type View =
  { mode: 'list' } | { mode: 'edit'; category: Category } | { mode: 'delete'; category: Category };

export function CategoriesModal({
  categories,
  sessions,
  onClose,
  onSave,
  onDelete,
}: {
  categories: Category[];
  // Every pane across all workspaces — only so a delete can say how many it
  // will empty before you agree to it.
  sessions: SessionInfo[];
  onClose: () => void;
  // Throws on failure so the error can show inline next to the field.
  onSave: (id: string, patch: { name?: string; color?: string }) => Promise<void>;
  onDelete: (id: string) => void;
}) {
  const [view, setView] = useState<View>({ mode: 'list' });
  const [draft, setDraft] = useState({ name: '', color: '#4fc3f7' });
  const [error, setError] = useState('');

  const backToList = () => {
    setView({ mode: 'list' });
    setError('');
  };

  const submit = async (id: string) => {
    const name = draft.name.trim();
    if (!name || name.length > 24) {
      setError('Use 1–24 characters.');
      return;
    }
    try {
      await onSave(id, { name, color: draft.color });
      backToList();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  if (view.mode === 'edit') {
    return (
      <Modal title={`Edit "${view.category.name}"`} onClose={onClose}>
        <p className="modal-desc">
          Every pane in this category takes its color, so changing the color here recolors all of
          them at once.
        </p>
        <div className="cat-edit-row">
          <input
            className="modal-input"
            placeholder="category name — e.g. client work, backend"
            value={draft.name}
            autoFocus
            maxLength={24}
            onChange={(e) => {
              setDraft({ ...draft, name: e.target.value });
              setError('');
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void submit(view.category.id);
            }}
          />
          <input
            className="cat-new-color"
            type="color"
            value={draft.color}
            title="Pick any color"
            onChange={(e) => setDraft({ ...draft, color: e.target.value })}
          />
        </div>
        {error && <div className="form-error">{error}</div>}
        <div className="modal-actions">
          <button className="btn btn-ghost" onClick={backToList}>
            Back
          </button>
          <button
            className="btn"
            onClick={() => void submit(view.category.id)}
            disabled={!draft.name.trim()}
          >
            Save
          </button>
        </div>
      </Modal>
    );
  }

  if (view.mode === 'delete') {
    const count = panesIn(view.category.id, sessions).length;
    return (
      <Modal title={`Delete "${view.category.name}"?`} onClose={onClose}>
        <p className="modal-desc">
          {count === 0 ? (
            <>No panes are in this category.</>
          ) : (
            <>
              <b>
                {count} pane{count === 1 ? '' : 's'}
              </b>{' '}
              will come out of this category and go back to {count === 1 ? 'its' : 'their'} own
              color. No pane is killed and no conversation is lost.
            </>
          )}
        </p>
        <div className="modal-actions">
          <button className="btn btn-ghost" onClick={backToList}>
            Cancel
          </button>
          <button
            className="btn btn-danger"
            onClick={() => {
              onClose();
              onDelete(view.category.id);
            }}
          >
            Delete category
          </button>
        </div>
      </Modal>
    );
  }

  return (
    <Modal title="Manage categories" onClose={onClose}>
      {categories.length === 0 ? (
        <p className="modal-desc">
          No categories yet — create one from a pane&apos;s color button in its header.
        </p>
      ) : (
        <div className="manage-list">
          {categories.map((c) => {
            const count = panesIn(c.id, sessions).length;
            return (
              <div className="manage-row" key={c.id}>
                <span className="cat-dot" style={{ background: c.color }} />
                <div className="manage-row-info">
                  <span className="manage-row-name">{c.name}</span>
                  <span className="manage-row-email">
                    {count} pane{count === 1 ? '' : 's'}
                  </span>
                </div>
                <button
                  className="btn btn-small btn-ghost"
                  title="Rename or recolor"
                  onClick={() => {
                    setDraft({ name: c.name, color: c.color });
                    setError('');
                    setView({ mode: 'edit', category: c });
                  }}
                >
                  <IconPencil size={14} />
                </button>
                <button
                  className="btn btn-small btn-ghost"
                  title="Delete category"
                  onClick={() => setView({ mode: 'delete', category: c })}
                >
                  <IconTrash size={14} />
                </button>
              </div>
            );
          })}
        </div>
      )}
      <div className="modal-actions">
        <button className="btn btn-ghost" onClick={onClose}>
          Close
        </button>
      </div>
    </Modal>
  );
}
