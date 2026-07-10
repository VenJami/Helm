import { useEffect, useState } from 'react';
import { api } from '../api';
import type { DriftWarning } from '../types';
import { IconX } from './Icons';

// Loud alarm for claude-CLI drift. Helm reads claude's undocumented on-disk
// formats and model names; when they change, usage/status/revive quietly return
// zeros. The server detects that (boot-time `claude --version` + parse-time
// signals) and exposes it at /api/diagnostics — this banner surfaces it in plain
// language instead of letting the user think Helm is silently broken.
//
// Self-contained on purpose (fetch + poll + dismiss all live here) so it adds
// nothing to the already-overloaded App component. Dismissals are per-warning
// key in localStorage, so a dismissed warning stays gone but a NEW drift signal
// re-opens the banner.

const DISMISS_KEY = 'helm.driftDismissed';

function loadDismissed(): Set<string> {
  try {
    const raw = JSON.parse(localStorage.getItem(DISMISS_KEY) || '[]');
    return new Set(Array.isArray(raw) ? raw : []);
  } catch {
    return new Set();
  }
}

export function DriftBanner() {
  const [warnings, setWarnings] = useState<DriftWarning[]>([]);
  const [dismissed, setDismissed] = useState<Set<string>>(loadDismissed);

  useEffect(() => {
    let alive = true;
    const pull = () =>
      api
        .getDiagnostics()
        .then((d) => {
          if (alive) setWarnings(d.warnings);
        })
        .catch(() => {
          /* server down / transient — banner just stays as-is */
        });
    pull();
    const timer = setInterval(pull, 20_000); // drift is rare; a slow poll is plenty
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, []);

  const visible = warnings.filter((w) => !dismissed.has(w.key));
  if (visible.length === 0) return null;

  const dismissAll = () => {
    const next = new Set(dismissed);
    for (const w of visible) next.add(w.key);
    setDismissed(next);
    localStorage.setItem(DISMISS_KEY, JSON.stringify([...next]));
  };

  return (
    <div className="drift-banner" role="alert">
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
        <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0Z" />
        <line x1="12" y1="9" x2="12" y2="13" />
        <line x1="12" y1="17" x2="12.01" y2="17" />
      </svg>
      <div className="drift-body">
        <div className="drift-title">
          claude compatibility warning{visible.length > 1 ? `s (${visible.length})` : ''}
        </div>
        {visible.map((w) => (
          <div className="drift-msg" key={w.key}>
            {w.message}
          </div>
        ))}
      </div>
      <button className="drift-close" title="Dismiss" onClick={dismissAll}>
        <IconX size={13} />
      </button>
    </div>
  );
}
