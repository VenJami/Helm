// The hard warning in front of every public share link.
//
// This dialog is deliberately un-suppressible — no "don't ask again", no
// remembered choice. A quick-tunnel URL is unauthenticated (see
// server/src/tunnel.mjs), so the friction IS the feature. If a future change
// makes these links authenticated, this is the place to soften it.

import { useState } from 'react';
import { Modal } from '../Modal';
import type { Workspace } from '../../types';

interface Props {
  workspace: Workspace;
  port: number;
  ttlMs: number;
  // Is anything actually listening on that port right now? Undefined = not
  // checked yet. Sharing a dead port is legal (the link starts working when
  // the server does), but silently handing someone a Cloudflare 502 is the
  // most likely first-run confusion, so say it up front.
  serverUp?: boolean;
  onConfirm: () => Promise<void>;
  onClose: () => void;
}

export function ShareModal({ workspace, port, ttlMs, serverUp, onConfirm, onClose }: Props) {
  const [busy, setBusy] = useState(false);
  const minutes = Math.round(ttlMs / 60000);

  return (
    <Modal title={`Publish “${workspace.name}” to the internet?`} onClose={onClose}>
      <p className="modal-desc">
        This creates a public web address that anyone can open, from anywhere, and forwards it
        straight to <code>localhost:{port}</code> on this machine.
      </p>
      <ul className="share-warnings">
        <li>
          <b>There is no password.</b> The random link is the only thing standing between your dev
          server and the open internet.
        </li>
        <li>
          <b>Links get forwarded.</b> Anyone you send it to can pass it on, and it may be logged or
          crawled.
        </li>
        <li>
          <b>Whatever the server exposes, they get</b> — test data, admin pages, debug routes, file
          uploads.
        </li>
      </ul>
      {serverUp === false && (
        <p className="share-note">
          Nothing is running on <code>localhost:{port}</code> yet, so the link will show a
          Cloudflare error until you start the project (▶ in the sidebar). Sharing now is fine — the
          link starts working the moment the server does.
        </p>
      )}
      <p className="modal-desc">
        The link shuts itself off after <b>{minutes} minutes</b> unless you extend it. You can stop
        it sooner at any time.
      </p>
      <div className="modal-actions">
        <button className="btn btn-ghost" onClick={onClose} disabled={busy}>
          Cancel
        </button>
        <button
          className="btn btn-danger"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            try {
              await onConfirm();
            } finally {
              setBusy(false);
            }
          }}
        >
          {busy ? 'Starting tunnel…' : 'Publish publicly'}
        </button>
      </div>
    </Modal>
  );
}
