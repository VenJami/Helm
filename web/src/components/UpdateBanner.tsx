import { useEffect, useState } from 'react';
import { api } from '../api';
import type { UpdateInfo, UpdateResult } from '../types';
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
// quieter panel below it — every docs fixup lands on main, so a full banner
// for each would train people to dismiss the one that matters. The release
// always wins: they are never both on screen.

const DISMISS_KEY = 'helm.updateDismissed';
const COMMITS_DISMISS_KEY = 'helm.commitsDismissed';
const POLL_MS = 30 * 60 * 1000; // server refreshes every 2 h; this just picks it up
// Dismissing the commit panel can't be remembered per-commit — the next push
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
  // The Update button's lifecycle. `result` outlives the check that produced
  // it: a successful pull makes the server report "you're level", which would
  // otherwise yank the panel away before anyone read what happened.
  const [updating, setUpdating] = useState(false);
  const [result, setResult] = useState<UpdateResult | null>(null);
  const [listOpen, setListOpen] = useState(true);

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

  // No release to announce → the "you're behind main" panel.
  if (releaseHidden) {
    const c = info?.commits;
    const co = info?.checkout;
    // Once an update has run, the panel belongs to its result until dismissed.
    if (!result && (!c || c.ahead <= 0)) return null;
    const d = commitsDismissal;
    const stillDismissed =
      !result &&
      c &&
      d &&
      c.ahead < d.ahead + RENAG_AFTER_COMMITS &&
      Date.now() - d.at < RENAG_AFTER_MS;
    if (stillDismissed) return null;

    const dismissCommits = () => {
      const next = { ahead: c?.ahead ?? 0, at: Date.now() };
      setCommitsDismissal(next);
      setResult(null);
      try {
        localStorage.setItem(COMMITS_DISMISS_KEY, JSON.stringify(next));
      } catch {
        /* private mode / quota — the panel just returns next load */
      }
    };

    // One press, and the label says exactly what that press will do. Someone
    // who doesn't use git should never be told to "switch branches and try
    // again" — that is a dead end, not an instruction.
    const onFeatureBranch = !!co && co.branch !== co.tracked;
    const runUpdate = () => {
      setUpdating(true);
      setResult(null);
      api
        .pullUpdate(onFeatureBranch)
        .then(setResult)
        .catch((err: Error) =>
          setResult({
            ok: false,
            reason: 'unreachable',
            // A build can outlive the request; say so rather than claiming failure.
            detail: `Couldn't finish: ${err.message}. Check the server console before trying again.`,
            steps: [],
            needsRestart: false,
            needsServerInstall: false,
          }),
        )
        .finally(() => setUpdating(false));
    };

    const when = age(c?.latestAt);
    const list = c?.list ?? [];
    return (
      <div className="commits-note" role="status">
        <div className="commits-head">
          {list.length > 0 && (
            <button
              className="commits-toggle"
              onClick={() => setListOpen((v) => !v)}
              title={listOpen ? 'Hide the commit list' : 'Show the commit list'}
              aria-expanded={listOpen}
            >
              {listOpen ? '▾' : '▸'}
            </button>
          )}
          {c && (
            <span className="commits-count">
              {c.ahead} new commit{c.ahead === 1 ? '' : 's'}
            </span>
          )}
          <span className="commits-msg">
            {c ? 'on main since your copy' : 'Update'}
            {when && !listOpen ? ` (newest ${when})` : ''}
          </span>
          {c?.url && (
            <a className="update-link" href={c.url} target="_blank" rel="noreferrer">
              View changes ↗
            </a>
          )}
          {/* Hidden once an update has run: the panel is then reporting what
              happened, and a second run would only say "already up to date". */}
          {!result && co?.selfUpdate !== false && (
            <button
              className="btn btn-small commits-update"
              onClick={runUpdate}
              disabled={updating}
              title={
                onFeatureBranch
                  ? `You're on "${co?.branch}". This moves you to ${co?.tracked} — that branch stays exactly where it is — and pulls.`
                  : 'Pull the new commits and rebuild'
              }
            >
              {updating
                ? 'Updating…'
                : onFeatureBranch
                  ? `Switch to ${co?.tracked} & update`
                  : 'Update'}
            </button>
          )}
          <button
            className="drift-close"
            title="Dismiss (returns when main moves further ahead)"
            onClick={dismissCommits}
          >
            <IconX size={13} />
          </button>
        </div>

        {listOpen && !result && list.length > 0 && (
          <ul className="commits-list">
            {list.map((commit) => (
              <li key={commit.sha}>
                <code className="commits-sha">{commit.sha}</code>
                <span className="commits-subject" title={commit.message}>
                  {commit.message}
                </span>
                <span className="commits-when">{age(commit.at)}</span>
              </li>
            ))}
          </ul>
        )}

        {updating && (
          <div className="commits-progress">
            Pulling and rebuilding — this can take a minute. Your panes are untouched.
          </div>
        )}

        {result && <UpdateOutcome result={result} />}
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

/**
 * What the Update button did. Three outcomes worth telling apart: it refused
 * (and why, in a sentence), it worked and a reload is all that's left, or it
 * worked but the server's own code changed — which only a restart picks up,
 * and a restart is the one thing here that costs you your live panes.
 */
function UpdateOutcome({ result }: { result: UpdateResult }) {
  if (!result.ok && result.steps.length === 0) {
    return (
      <div className="commits-outcome commits-outcome-bad">
        <strong>Didn&rsquo;t update.</strong> {result.detail}
      </div>
    );
  }

  const failed = result.steps.filter((s) => !s.ok);
  return (
    <div className={`commits-outcome${failed.length ? ' commits-outcome-bad' : ''}`}>
      {result.pulled === 0 ? (
        <div>Already up to date — nothing to pull.</div>
      ) : (
        <div>
          <strong>
            Updated {result.from} → {result.to}
          </strong>{' '}
          ({result.pulled} file{result.pulled === 1 ? '' : 's'})
          {result.steps.map((s) => (
            <span key={s.name} className={s.ok ? 'commits-step' : 'commits-step commits-step-bad'}>
              {s.ok ? '✓' : '✕'} {s.name}
              {s.ok ? '' : ` — ${s.detail}`}
            </span>
          ))}
        </div>
      )}

      {result.needsRestart ? (
        <div className="commits-next">
          Server code changed, so a <strong>restart</strong> is needed to finish.
          {result.needsServerInstall && (
            <>
              {' '}
              Run <code className="update-cmd">npm install</code> in <code>server/</code> first —
              Helm can&rsquo;t do that to itself while it&rsquo;s running.
            </>
          )}{' '}
          Live panes come back as revivable.
        </div>
      ) : result.pulled ? (
        <div className="commits-next">
          <button className="btn btn-small commits-update" onClick={() => window.location.reload()}>
            Reload
          </button>{' '}
          to pick it up. No restart needed — your panes keep running.
        </div>
      ) : null}

      {result.notchChanged && (
        <div className="commits-next">
          The notch changed too — rerun <code className="update-cmd">desktop\start-notch.cmd</code>{' '}
          to rebuild it.
        </div>
      )}
    </div>
  );
}
