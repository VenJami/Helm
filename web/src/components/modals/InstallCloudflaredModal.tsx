// Shown when you ask to share a project but cloudflared isn't installed.
//
// This replaced a bare "cloudflared not found" error toast, which was a dead
// end: it named a program most people have never heard of and left them to
// work out what it was and whether they wanted it. So explain first, then
// offer the install — and run it in a VISIBLE pane, never silently, because
// it's a package manager writing to their machine.

import { useState } from 'react';
import { Modal } from '../Modal';

interface Props {
  installCommand: string | null; // null = no one-liner on this platform
  installDocs: string;
  onInstall: () => Promise<void>;
  onClose: () => void;
}

export function InstallCloudflaredModal({
  installCommand,
  installDocs,
  onInstall,
  onClose,
}: Props) {
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);

  return (
    <Modal title="Public sharing needs cloudflared" onClose={onClose}>
      <p className="modal-desc">
        To reach your project from the internet, something has to bridge the gap between the open
        web and this machine. <b>cloudflared</b> is Cloudflare&rsquo;s free, open-source program
        that does exactly that — it&rsquo;s the same idea as VS Code&rsquo;s port forwarding.
      </p>
      <p className="modal-desc">
        It dials <i>out</i> to Cloudflare, who then host a public web address and pass visitors back
        down to your dev server. Helm doesn&rsquo;t ship it, so it&rsquo;s a one-time install.
      </p>
      <ul className="share-warnings">
        <li>
          <b>Installing it does nothing on its own.</b> No background service, no startup entry, no
          Cloudflare account, no login. It just sits there until Helm runs it.
        </li>
        <li>
          <b>It opens no ports on your machine.</b> Tunnels are outgoing connections, which is why
          this works without touching your router.
        </li>
        <li>
          <b>One signed program, about 52 MB</b>, from Cloudflare. Uninstall it any time and Helm
          simply goes back to hiding the share button.
        </li>
      </ul>
      {installCommand ? (
        <>
          <p className="modal-desc">
            Helm can run the install for you in a normal terminal pane, so you can watch it and
            answer anything it asks:
          </p>
          <div className="install-cmd">
            <code>{installCommand}</code>
            <button
              className="btn btn-secondary btn-small"
              onClick={() => {
                void navigator.clipboard?.writeText(installCommand).catch(() => {});
                setCopied(true);
                setTimeout(() => setCopied(false), 1500);
              }}
            >
              {copied ? 'Copied' : 'Copy'}
            </button>
          </div>
        </>
      ) : (
        <p className="modal-desc">
          There&rsquo;s no single install command for this platform — see{' '}
          <a href={installDocs} target="_blank" rel="noreferrer">
            Cloudflare&rsquo;s download page
          </a>
          , then reopen this dialog.
        </p>
      )}
      <div className="modal-actions">
        <button className="btn btn-ghost" onClick={onClose} disabled={busy}>
          {installCommand ? 'Not now' : 'Close'}
        </button>
        {installCommand && (
          <button
            className="btn"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              try {
                await onInstall();
              } finally {
                setBusy(false);
              }
            }}
          >
            {busy ? 'Starting…' : 'Install it for me'}
          </button>
        )}
      </div>
    </Modal>
  );
}
