// Everything about your live public links, in one place.
//
// The first cut of this feature put the URL in a tooltip and a toast that
// vanished, and made the sidebar pill copy silently — so once the toast was
// gone there was no way to see the link, no feedback when you clicked, and no
// way to open it. A public URL is the whole deliverable of the feature; it
// needs somewhere permanent to live.

import { useState } from 'react';
import { Modal } from '../Modal';
import { IconCopy, IconGlobe } from '../Icons';
import type { TunnelInfo, Workspace } from '../../types';

interface Props {
  tunnels: TunnelInfo[];
  workspaces: Workspace[];
  onExtend: (workspaceId: string) => Promise<void>;
  onStop: (workspaceId: string) => Promise<void>;
  onClose: () => void;
}

function timeLeft(expiresAt: number) {
  const left = expiresAt - Date.now();
  if (left <= 0) return 'expiring now';
  const mins = Math.floor(left / 60_000);
  return mins >= 1 ? `${mins} min left` : `${Math.floor(left / 1000)}s left`;
}

export function SharesModal({ tunnels, workspaces, onExtend, onStop, onClose }: Props) {
  const [copied, setCopied] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const nameOf = (id: string) => workspaces.find((w) => w.id === id)?.name ?? 'Project';

  const copy = (url: string) => {
    void navigator.clipboard?.writeText(url).catch(() => {});
    setCopied(url);
    setTimeout(() => setCopied((c) => (c === url ? null : c)), 1500);
  };

  return (
    <Modal title="Public links" onClose={onClose}>
      {tunnels.length === 0 ? (
        <p className="modal-desc">Nothing is shared right now.</p>
      ) : (
        <>
          <p className="modal-desc">
            These addresses are reachable by anyone on the internet, with no password. Stop one as
            soon as you&rsquo;re done with it.
          </p>
          <div className="share-list">
            {tunnels.map((t) => (
              <div className="share-row" key={t.workspaceId}>
                <div className="share-row-head">
                  <span className="share-row-name">
                    <IconGlobe size={12} /> {nameOf(t.workspaceId)}
                    <span className="share-row-port">:{t.port}</span>
                  </span>
                  <span className="share-row-ttl">{timeLeft(t.expiresAt)}</span>
                </div>
                {t.status === 'live' && t.url ? (
                  <>
                    {/* Selectable AND clickable — reading it out loud, copying
                        it, and just opening it are all normal things to want. */}
                    <a className="share-url" href={t.url} target="_blank" rel="noreferrer">
                      {t.url}
                    </a>
                    <div className="share-row-actions">
                      <button className="btn btn-secondary btn-small" onClick={() => copy(t.url!)}>
                        <IconCopy size={11} /> {copied === t.url ? 'Copied' : 'Copy link'}
                      </button>
                      <a
                        className="btn btn-secondary btn-small"
                        href={t.url}
                        target="_blank"
                        rel="noreferrer"
                      >
                        Open
                      </a>
                      <button
                        className="btn btn-secondary btn-small"
                        disabled={busy === t.workspaceId}
                        onClick={async () => {
                          setBusy(t.workspaceId);
                          try {
                            await onExtend(t.workspaceId);
                          } finally {
                            setBusy(null);
                          }
                        }}
                      >
                        Extend
                      </button>
                      <button
                        className="btn btn-danger btn-small"
                        disabled={busy === t.workspaceId}
                        onClick={async () => {
                          setBusy(t.workspaceId);
                          try {
                            await onStop(t.workspaceId);
                          } finally {
                            setBusy(null);
                          }
                        }}
                      >
                        Stop sharing
                      </button>
                    </div>
                  </>
                ) : (
                  <div className="share-url share-url-pending">
                    {t.status === 'starting'
                      ? 'opening the tunnel…'
                      : t.error || 'the tunnel failed'}
                  </div>
                )}
              </div>
            ))}
          </div>
        </>
      )}
      <div className="modal-actions">
        <button className="btn btn-ghost" onClick={onClose}>
          Close
        </button>
      </div>
    </Modal>
  );
}
