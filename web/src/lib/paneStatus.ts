// Pure helpers for reading a pane's state — no React, no api, no window. Both
// faces of the notch and the HUD share them, and keeping them here rather than
// in a component means the logic can be unit-tested without dragging in the
// auth token module (which reads `window` the moment it is imported).

import type { SessionInfo } from '../types';

/** Last path segment: "C:\proj\storefront" -> "storefront". */
export const projectOf = (dir: string) => dir.split(/[\\/]/).filter(Boolean).pop() || dir;

/** Sort order: whatever needs you first, then working, then idle, then dead. */
export const RANK: Record<string, number> = { waiting: 0, working: 1, idle: 2 };
export const rankOf = (s: SessionInfo) =>
  s.status !== 'running' ? 3 : (RANK[s.activity ?? 'idle'] ?? 2);

/** The status-light class for a pane. One source of truth for both faces. */
export const dotFor = (s: SessionInfo) =>
  s.status !== 'running'
    ? 'dot-dead'
    : ({ working: 'dot-working', waiting: 'dot-waiting', idle: 'dot-live' }[s.activity ?? 'idle'] ??
      'dot-live');

/** Claude panes only (dev panes have no hooks and never ask for anything), ranked. */
export const claudePanes = (sessions: SessionInfo[]) =>
  sessions
    .filter((s) => s.kind !== 'dev')
    .slice()
    .sort((a, b) => rankOf(a) - rankOf(b) || a.createdAt.localeCompare(b.createdAt));

/** Is this pane blocked on you right now? */
export const isBlocked = (s: SessionInfo) =>
  !!s.pendingId || (s.status === 'running' && s.activity === 'waiting');

/**
 * The pane the resting notch should name, if any. A pane actively ASKING beats
 * one merely waiting: a held permission request is answerable right now, where
 * "waiting" may just be claude's own prompt sitting there.
 */
export const needyPane = (sessions: SessionInfo[]): SessionInfo | null => {
  const panes = claudePanes(sessions);
  return panes.find((p) => p.pendingId) ?? panes.find((p) => isBlocked(p)) ?? null;
};

/**
 * Is this pane something the notch should NOT list? Only ACTIVE panes make the
 * cut - working, or waiting on you. Idle ones are out the moment they go idle
 * (this used to be time-based, listing a just-finished pane for 30 minutes;
 * the owner wants the notch to be only what is happening right now), and so
 * are dead ones, which you revive from Helm.
 */
export const isQuiet = (s: SessionInfo) =>
  s.status !== 'running' || !(isBlocked(s) || s.activity === 'working');

/**
 * Fold a workspace dir for comparison: separators normalised, trailing ones
 * dropped, lowercased. In practice a pane's workspace string comes from the
 * same field as the project's, so they already match - but a mute that fails
 * because one of them was typed with the other slash would be baffling.
 */
export const foldDir = (dir: string) => dir.replace(/\\/g, '/').replace(/[/]+$/, '').toLowerCase();

/**
 * What the notch should list, and how many it left out.
 *
 * Two filters, and the count covers only ONE of them. A muted project is gone
 * on purpose and permanently, so counting it would be a reminder that never
 * goes away; idle panes are still yours, so the notch says how many rather
 * than reading as "no agents" when there are several.
 */
export const notchPanes = (
  sessions: SessionInfo[],
  mutedDirs: Set<string>,
): { shown: SessionInfo[]; quiet: number } => {
  const all = claudePanes(sessions).filter((s) => !mutedDirs.has(foldDir(s.workspace)));
  const shown = all.filter((s) => !isQuiet(s));
  return { shown, quiet: all.length - shown.length };
};
