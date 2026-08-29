import { useEffect, useState } from 'react';
import { api } from '../api';
import type { UpdateInfo } from '../types';
import { IconX } from './Icons';

// "A newer Helm is out" notice. The server does the actual GitHub check (once,
// cached, shared by every tab — see server/src/update.mjs); this only renders a
// positive result. Failures, rate limits and being offline never show: a local
// app that can't reach GitHub is not broken.
//
// Self-contained like DriftBanner (fetch + dismiss live here) so App stays out
// of it. The dismissal remembers the VERSION, so hiding v0.3.0 stays hidden
// but v0.4.0 speaks up again.

const DISMISS_KEY = 'helm.updateDismissed';
const POLL_MS = 30 * 60 * 1000; // server refreshes every 2 h; this just picks it up

function loadDismissed(): string {
  try {
    return localStorage.getItem(DISMISS_KEY) || '';
  } catch {
    return '';
  }
}

export function UpdateBanner() {
  const [info, setInfo] = useState<UpdateInfo | null>(null);
  const [dismissed, setDismissed] = useState<string>(loadDismissed);

  useEffect(() => {
    let alive = true;
    const pull = () =>
      api
        .getUpdate()
        .then((u) => {
          if (alive) setInfo(u);
        })
        .catch(() => {
          /* server down / transient — nothing to show */
        });
    pull();
    const timer = setInterval(pull, POLL_MS);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, []);

  if (!info?.available || !info.latest || dismissed === info.latest) return null;

  const dismiss = () => {
    setDismissed(info.latest as string);
    try {
      localStorage.setItem(DISMISS_KEY, info.latest as string);
    } catch {
      /* private mode / quota — the banner just returns next load */
    }
  };

  return (
    <div className="drift-banner update-banner" role="status">
      <svg
        className="drift-icon"
        width="16"
        height="16"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
        <polyline points="7 10 12 15 17 10" />
        <line x1="12" y1="15" x2="12" y2="3" />
      </svg>
      <div className="drift-body">
        <div className="drift-title">
          Helm v{info.latest} is available{' '}
          <span className="update-current">(you&rsquo;re on v{info.current})</span>
        </div>
        <div className="drift-msg">
          Update with <code className="update-cmd">git pull</code>, then{' '}
          <code className="update-cmd">npm install</code> in <code>server/</code> and{' '}
          <code>web/</code>, <code className="update-cmd">npm run build</code> in <code>web/</code>,
          and restart the server. Live panes come back as revivable.
          {info.url && (
            <>
              {' '}
              <a className="update-link" href={info.url} target="_blank" rel="noreferrer">
                Release notes ↗
              </a>
            </>
          )}
        </div>
      </div>
      <button className="drift-close" title="Dismiss until the next version" onClick={dismiss}>
        <IconX size={13} />
      </button>
    </div>
  );
}
