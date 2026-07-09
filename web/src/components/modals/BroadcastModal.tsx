import { useState } from 'react';
import { api } from '../../api';
import { Modal } from '../Modal';
import type { SessionInfo } from '../../types';

// Type one instruction into several panes at once. Owns the draft text, the
// target set (seeded by the parent — current workspace's non-waiting panes),
// the busy flag, and the send call; failure shows inline, success closes.
export function BroadcastModal({ panes, initialIds, wsName, onClose }: {
  panes: SessionInfo[];               // every running pane, across workspaces
  initialIds: Set<string>;            // default-checked targets
  wsName: (dir: string) => string;    // pretty workspace label for a pane row
  onClose: () => void;
}) {
  const [text, setText] = useState('');
  const [ids, setIds] = useState<Set<string>>(initialIds);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const send = async () => {
    const trimmed = text.trim();
    const targets = [...ids];
    if (!trimmed || !targets.length || busy) return;
    setBusy(true);
    setError('');
    try {
      await api.broadcast(trimmed, targets);
      onClose();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title="Broadcast to panes" onClose={onClose}>
      <p className="modal-desc">
        Types one instruction into every selected pane and presses Enter —
        as if you'd typed it in each terminal yourself. Panes waiting on a
        question start unchecked (Enter could answer their dialog).
      </p>
      <input
        className="modal-input"
        placeholder="e.g. commit your work, then summarize where you're at"
        value={text}
        autoFocus
        maxLength={4000}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') void send();
        }}
      />
      <div className="bc-list">
        {panes.map((s) => (
          <label key={s.id} className="bc-row">
            <input
              type="checkbox"
              checked={ids.has(s.id)}
              onChange={(e) => {
                setIds((prev) => {
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
      {error && <div className="form-error">{error}</div>}
      <div className="modal-actions">
        <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
        <button
          className="btn"
          onClick={() => void send()}
          disabled={busy || !text.trim() || !ids.size}
        >
          {busy ? 'sending…' : `Send to ${ids.size} pane${ids.size === 1 ? '' : 's'}`}
        </button>
      </div>
    </Modal>
  );
}
