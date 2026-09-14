// The notch at rest. Two faces:
//
//   quiet   — one light per claude pane, coloured by what that pane is doing.
//   needy   — when something is actually blocked, the lights give way to the
//             project's name and "Needs you". A row of dots can tell you
//             SOMETHING is amber; it cannot tell you which project, and at a
//             glance from across the desk that is the only thing you want.
//
// Both are FIXED widths (the host sizes the window from `compactWidthFor`, not
// from measuring this), so the strip never resizes itself as panes come and go
// — a notch that changed shape on its own would pull the eye constantly.

import { claudePanes, dotFor, isBlocked, needyPane, projectOf } from '../lib/paneStatus';
import { elapsed } from '../lib/time';
import type { SessionInfo } from '../types';

export { needyPane };

// How many lights fit the quiet width before we start counting instead.
const MAX_LIGHTS = 14;

/** Window widths the host uses for each face, in device-independent pixels. */
export const COMPACT_WIDTH_QUIET = 200;
export const COMPACT_WIDTH_NEEDY = 330;

/** Which fixed width the host should give the compact window right now. */
export const compactWidthFor = (sessions: SessionInfo[]) =>
  needyPane(sessions) ? COMPACT_WIDTH_NEEDY : COMPACT_WIDTH_QUIET;

export function NotchStrip({ sessions }: { sessions: SessionInfo[] }) {
  const panes = claudePanes(sessions);
  const needy = needyPane(sessions);
  const waiting = panes.filter(isBlocked).length;

  if (needy) {
    const blockedFor = needy.activitySince ? elapsed(needy.activitySince).trim() : '';
    return (
      <div
        className="notch-strip notch-strip-needy"
        title={`${needy.name} in ${projectOf(needy.workspace)} needs you — hover to open`}
      >
        <span className={`dot ${dotFor(needy)}`} />
        <span className="notch-needy-project">{projectOf(needy.workspace)}</span>
        {/* How long it has been stuck. "Just asked" and "stuck for twenty
            minutes" are the same amber dot otherwise, and they are not the
            same problem. Ticks on the 3 s session poll. */}
        {blockedFor && <span className="notch-needy-since">{blockedFor}</span>}
        <span className="notch-needy-sep" />
        <span className="notch-needy-bang">!</span>
        <span className="notch-needy-text">
          {waiting > 1 ? `${waiting} need you` : 'Needs you'}
        </span>
      </div>
    );
  }

  const shown = panes.slice(0, MAX_LIGHTS);
  const rest = panes.length - shown.length;
  return (
    <div className="notch-strip" title={`${panes.length} agents — hover to open`}>
      {panes.length === 0 ? (
        <span className="notch-strip-quiet">no agents</span>
      ) : (
        <span className="notch-strip-lights">
          {shown.map((p) => (
            <span key={p.id} className={`dot ${dotFor(p)}`} />
          ))}
          {rest > 0 && <span className="notch-strip-more">+{rest}</span>}
        </span>
      )}
    </div>
  );
}
