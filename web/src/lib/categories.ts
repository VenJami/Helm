// Pure helpers for pane folders (categories) — no React, no api, no window, for
// the same reason as lib/paneStatus.ts: importing these out of a component
// would drag in the auth token module, which reads `window` at import time and
// breaks the unit tests.

import type { Category, SessionInfo } from '../types';

/** The folder a pane is filed in, or null — including when it names a folder
 *  that no longer exists, so a stale id renders as "no folder" rather than
 *  throwing or showing a blank chip. */
export const categoryOf = (s: SessionInfo, categories: Category[]): Category | null =>
  categories.find((c) => c.id === s.categoryId) ?? null;

/** The color a pane should actually render in.
 *
 *  The folder owns the color: a filed pane takes its folder's, an unfiled one
 *  keeps its own. Derived here rather than written onto the session, so
 *  recoloring a folder repaints every pane in it on the next poll with no
 *  migration and nothing to keep in sync. */
export const paneAccent = (s: SessionInfo, categories: Category[]): string =>
  categoryOf(s, categories)?.color ?? s.color;

/** Panes filed in a given folder — what the manage dialog counts before a
 *  delete, so it can say how many panes it is about to empty. */
export const panesIn = (id: string, sessions: SessionInfo[]): SessionInfo[] =>
  sessions.filter((s) => s.categoryId === id);

/** A tray group: one category's panes, or the loose ones (`category: null`). */
export interface PaneGroup {
  category: Category | null;
  panes: SessionInfo[];
}

/** Bucket panes by the category they are filed in, so minimized panes from the
 *  same category can sit together in one container instead of scattered across
 *  the tray.
 *
 *  Order is taken from the `categories` list, NOT from the panes, so a group
 *  doesn't jump around as panes are minimized and restored; uncategorized panes
 *  come last, in their own unlabelled group. Empty categories are dropped —
 *  the tray only ever shows what is actually in it. */
export const groupByCategory = (panes: SessionInfo[], categories: Category[]): PaneGroup[] => {
  const groups: PaneGroup[] = [];
  for (const c of categories) {
    const mine = panes.filter((p) => p.categoryId === c.id);
    if (mine.length) groups.push({ category: c, panes: mine });
  }
  const loose = panes.filter((p) => !categories.some((c) => c.id === p.categoryId));
  if (loose.length) groups.push({ category: null, panes: loose });
  return groups;
};
