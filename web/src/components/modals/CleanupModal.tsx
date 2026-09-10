// Old panes pile up. A pane whose process died with a server restart stays as
// a revivable 'dead' tile forever, and after a few weeks of daily use a
// project's grid is mostly panes you finished with in July. They all look
// alike, too — nothing on a dead tile says whether it's from yesterday or two
// months ago.
//
// So: one list, oldest first, with the age spelled out and everything past the
// threshold pre-ticked. Deleting is per-pane through the existing endpoint —
// no bulk route on the server, because "delete these ids" is a loop, not a
// feature.

import { useMemo, useState } from 'react';
import { Modal } from '../Modal';
import { age, daysSince } from '../../lib/time';
import type { SessionInfo, Workspace } from '../../types';

interface Props {
  sessions: SessionInfo[];
  workspaces: Workspace[];
  onRemove: (ids: string[]) => Promise<void>;
  onClose: () => void;
}

// Pre-tick anything older than this. Two weeks is past "I'll get back to it"
// but short of claude's own ~30-day transcript cleanup, so a pane offered here
// can usually still be revived if you'd rather keep it.
const STALE_DAYS = 14;

export function CleanupModal({ sessions, workspaces, onRemove, onClose }: Props) {
  const dead = useMemo(
    () =>
      sessions
        .filter((s) => s.status === 'dead' || s.status === 'exited')
        .sort((a, b) => daysSince(b.createdAt) - daysSince(a.createdAt)),
    [sessions],
  );
  const [picked, setPicked] = useState<Set<string>>(
    () => new Set(dead.filter((s) => daysSince(s.createdAt) >= STALE_DAYS).map((s) => s.id)),
  );
  const [busy, setBusy] = useState(false);

  const projectOf = (dir: string) => workspaces.find((w) => w.dir === dir)?.name ?? dir;

  const toggle = (id: string) =>
    setPicked((prev) => {
      const next = new Set(prev);
      if (!next.delete(id)) next.add(id);
      return next;
    });

  const remove = async () => {
    setBusy(true);
    try {
      await onRemove([...picked]);
      onClose();
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title="Clean up old panes" onClose={onClose}>
      {dead.length === 0 ? (
        <p className="modal-desc">
          Nothing to clean up &mdash; every pane you have is still running.
        </p>
      ) : (
        <>
          <p className="modal-desc">
            These panes aren&rsquo;t running. Removing one deletes the pane and its uploaded files;
            the conversation itself stays in Claude&rsquo;s own history either way. Anything older
            than {STALE_DAYS} days is ticked already.
          </p>
          <div className="cleanup-list">
            {dead.map((s) => (
              <label className="cleanup-row" key={s.id}>
                <input
                  type="checkbox"
                  checked={picked.has(s.id)}
                  onChange={() => toggle(s.id)}
                  disabled={busy}
                />
                <span className="cleanup-dot" style={{ background: s.color }} />
                <span className="cleanup-name">
                  {s.name}
                  {s.summary && <span className="cleanup-summary"> {s.summary}</span>}
                </span>
                <span className="cleanup-meta">
                  {projectOf(s.workspace)} &middot; {age(s.createdAt) || 'unknown age'}
                  {s.kind === 'claude' && !s.canResume && ' · no conversation to resume'}
                </span>
              </label>
            ))}
          </div>
          <div className="modal-actions">
            <button className="btn btn-ghost" onClick={onClose} disabled={busy}>
              Cancel
            </button>
            <button className="btn" onClick={() => void remove()} disabled={busy || !picked.size}>
              {busy ? 'Removing…' : `Remove ${picked.size} pane${picked.size === 1 ? '' : 's'}`}
            </button>
          </div>
        </>
      )}
    </Modal>
  );
}
