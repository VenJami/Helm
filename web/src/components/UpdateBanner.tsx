import { useEffect, useState } from 'react';
import { api } from '../api';
import type { UpdateInfo } from '../types';
import { IconX } from './Icons';
import { age } from '../lib/time';

// "A newer Helm is out" notice. The server does the actual GitHub check (once,
// cached, shared by every tab — see server/src/update.mjs); this only renders a
// positive result. Failures, rate limits and being offline never show: a local
// app that can't reach GitHub is not broken.
//
// Self-contained like DriftBanner (fetch + dismiss live here) so App stays out
// of it. The dismissal remembers the VERSION, so hiding v0.3.0 stays hidden
// but v0.4.0 speaks up again.
//
// Two volumes, because the server reports two things (server/src/update.mjs):
// a newer RELEASE gets this banner, while merely being behind `main` gets the
// one quiet line below it — every docs fixup lands on main, so a full banner
// for each would train people to dismiss the one that matters. The release
// always wins: they are never both on screen.

const DISMISS_KEY = 'helm.updateDismissed';
const COMMITS_DISMISS_KEY = 'helm.commitsDismissed';
const POLL_MS = 30 * 60 * 1000; // server refreshes every 2 h; this just picks it up
// Dismissing the commit line can't be remembered per-commit — the next push
// would re-open what you just closed. It comes back once main has moved on
// meaningfully, or after a week.
const RENAG_AFTER_COMMITS = 5;
const RENAG_AFTER_MS = 7 * 24 * 60 * 60 * 1000;

function loadDismissed(): string {
  try {
    return localStorage.getItem(DISMISS_KEY) || '';
  } catch {
    return '';
  }
}

type CommitsDismissal = { ahead: number; at: number };

function loadCommitsDismissal(): CommitsDismissal | null {
  try {
    const raw = JSON.parse(localStorage.getItem(COMMITS_DISMISS_KEY) || 'null');
    if (raw && typeof raw.ahead === 'number' && typeof raw.at === 'number') return raw;
  } catch {
    /* corrupt or unavailable — treat as never dismissed */
  }
  return null;
}

export function UpdateBanner() {
  const [info, setInfo] = useState<UpdateInfo | null>(null);
  const [dismissed, setDismissed] = useState<string>(loadDismissed);
  const [commitsDismissal, setCommitsDismissal] = useState<CommitsDismissal | null>(
    loadCommitsDismissal,
  );

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

  const releaseHidden = !info?.available || !info.latest || dismissed === info.latest;

  // No release to announce → fall back to the quiet "you're behind main" line.
  if (releaseHidden) {
    const c = info?.commits;
    if (!c || c.ahead <= 0) return null;
    const d = commitsDismissal;
    const stillDismissed =
      d && c.ahead < d.ahead + RENAG_AFTER_COMMITS && Date.now() - d.at < RENAG_AFTER_MS;
    if (stillDismissed) return null;

    const dismissCommits = () => {
      const next = { ahead: c.ahead, at: Date.now() };
      setCommitsDismissal(next);
      try {
        localStorage.setItem(COMMITS_DISMISS_KEY, JSON.stringify(next));
      } catch {
        /* private mode / quota — the line just returns next load */
      }
    };

    const when = age(c.latestAt);
    return (
      <div className="commits-note" role="status">
        <span className="commits-count">
          {c.ahead} new commit{c.ahead === 1 ? '' : 's'}
        </span>
        <span className="commits-msg">
          on main since your copy{c.latest ? ` — ${c.latest}` : ''}
          {when ? ` (${when})` : ''}
        </span>
        {c.url && (
          <a className="update-link" href={c.url} target="_blank" rel="noreferrer">
            View changes ↗
          </a>
        )}
        <code className="update-cmd">git pull</code>
        <button
          className="drift-close"
          title="Dismiss (returns when main moves further ahead)"
          onClick={dismissCommits}
        >
          <IconX size={13} />
        </button>
      </div>
    );
  }
  if (!info?.latest) return null; // narrowing for TS; releaseHidden covers it

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
