// Which pane the resting notch names, and how wide it has to be to say it.
// Worth unit-testing because it is the one bit of the notch a human can't check
// at a glance: the strip is a couple of dozen pixels tall and only appears when
// you are looking somewhere else.
import { describe, expect, it } from 'vitest';
import { COMPACT_WIDTH_NEEDY, COMPACT_WIDTH_QUIET, compactWidthFor } from './NotchStrip';
import { QUIET_AFTER_MS, foldDir, needyPane, notchPanes, projectOf } from '../lib/paneStatus';
import type { SessionInfo } from '../types';

const minsAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString();

const pane = (over: Partial<SessionInfo>): SessionInfo =>
  ({
    id: over.id ?? 'x',
    name: over.name ?? 'Pane',
    color: '#fff',
    workspace: over.workspace ?? String.raw`C:\proj\storefront`,
    profile: null,
    kind: over.kind ?? 'claude',
    command: null,
    status: over.status ?? 'running',
    exitCode: null,
    activity: over.activity ?? 'idle',
    // Relative, never a fixed date: a hardcoded ISO string can land in the
    // FUTURE depending on the runner's timezone, which quietly inverts every
    // age-based rule below.
    activitySince: over.activitySince ?? null,
    activityNote: null,
    pendingId: over.pendingId ?? null,
    pendingTool: null,
    pendingDetail: null,
    pendingSince: null,
    summary: null,
    canResume: false,
    hasTranscript: false,
    attached: 0,
    createdAt: over.createdAt ?? minsAgo(1),
  }) as SessionInfo;

describe('needyPane', () => {
  it('is null when nothing is blocked', () => {
    expect(needyPane([pane({ id: 'a' }), pane({ id: 'b', activity: 'working' })])).toBeNull();
  });

  it('picks a waiting pane', () => {
    const p = needyPane([pane({ id: 'a' }), pane({ id: 'b', activity: 'waiting' })]);
    expect(p?.id).toBe('b');
  });

  it('prefers a pane actively ASKING over one merely waiting', () => {
    // A held permission request is answerable right now; "waiting" may just be
    // claude's own prompt sitting there.
    const p = needyPane([
      pane({ id: 'waiting', activity: 'waiting', createdAt: minsAgo(999) }),
      pane({ id: 'asking', pendingId: 'req-1' }),
    ]);
    expect(p?.id).toBe('asking');
  });

  it('ignores dev panes — they have no hooks and never ask for anything', () => {
    expect(needyPane([pane({ id: 'dev', kind: 'dev', activity: 'waiting' })])).toBeNull();
  });

  it('ignores a pane that is waiting but no longer running', () => {
    expect(needyPane([pane({ id: 'dead', status: 'dead', activity: 'waiting' })])).toBeNull();
  });
});

describe('projectOf', () => {
  // Regression: a lost backslash in the split regex made this a no-op on
  // Windows paths, so the notch would have named the whole path instead of the
  // project. Nothing else covered it, and it reads fine until you try it.
  it('takes the last segment of a Windows path', () => {
    expect(projectOf(String.raw`C:\Users\me\Projects\storefront`)).toBe('storefront');
  });

  it('takes the last segment of a posix path', () => {
    expect(projectOf('/home/me/projects/storefront')).toBe('storefront');
  });

  it('tolerates a trailing separator', () => {
    expect(projectOf('/home/me/storefront/')).toBe('storefront');
  });

  it('falls back to the whole string when there is nothing to split', () => {
    expect(projectOf('storefront')).toBe('storefront');
  });
});

describe('compactWidthFor', () => {
  it('is the narrow lights width when all is quiet', () => {
    expect(compactWidthFor([pane({ id: 'a' })])).toBe(COMPACT_WIDTH_QUIET);
  });

  it('is the wider naming width when something needs you', () => {
    expect(compactWidthFor([pane({ id: 'a', activity: 'waiting' })])).toBe(COMPACT_WIDTH_NEEDY);
  });

  it('returns one of a FIXED set — never a measured value', () => {
    // The whole reason the notch stopped shaking: width comes from state, not
    // from measuring a layout that reflows when the width changes.
    for (const sessions of [[], [pane({ id: 'a' })], [pane({ id: 'b', pendingId: 'r' })]]) {
      expect([COMPACT_WIDTH_QUIET, COMPACT_WIDTH_NEEDY]).toContain(compactWidthFor(sessions));
    }
  });
});

describe('notchPanes', () => {
  const busy = pane({ id: 'busy', activity: 'working', activitySince: minsAgo(5) });
  const blocked = pane({ id: 'blocked', activity: 'waiting', activitySince: minsAgo(120) });
  const justDone = pane({ id: 'done', activity: 'idle', activitySince: minsAgo(2) });
  const forgotten = pane({ id: 'old', activity: 'idle', activitySince: minsAgo(240) });
  const dead = pane({ id: 'dead', status: 'dead', activitySince: minsAgo(1) });

  it('keeps working and blocked panes however long they have been at it', () => {
    const { shown } = notchPanes([busy, blocked], new Set());
    expect(shown.map((s) => s.id).sort()).toEqual(['blocked', 'busy']);
  });

  it('keeps a pane that JUST finished — that is the thing you want to see', () => {
    const { shown } = notchPanes([justDone], new Set());
    expect(shown.map((s) => s.id)).toEqual(['done']);
  });

  it('drops one that has been idle a long time, and says how many', () => {
    const { shown, quiet } = notchPanes([busy, forgotten], new Set());
    expect(shown.map((s) => s.id)).toEqual(['busy']);
    expect(quiet).toBe(1);
  });

  it('drops dead panes — you revive those from Helm, not the notch', () => {
    const { shown, quiet } = notchPanes([dead], new Set());
    expect(shown).toEqual([]);
    expect(quiet).toBe(1);
  });

  it('drops a muted project entirely, blocked or not, and does NOT count it', () => {
    // Muting is deliberate and permanent; a "+2 quiet" note for a project you
    // muted on purpose would be a reminder that never goes away.
    const muted = new Set([foldDir(String.raw`C:\proj\storefront`)]);
    const { shown, quiet } = notchPanes([busy, blocked], muted);
    expect(shown).toEqual([]);
    expect(quiet).toBe(0);
  });

  it('matches muted dirs case-insensitively and past a trailing separator', () => {
    // Windows paths; the sidebar stores whatever the user typed.
    const muted = new Set([foldDir('c:/PROJ/Storefront/')]);
    expect(notchPanes([busy], muted).shown).toEqual([]);
  });

  it('treats a pane with no activity timestamp by its age, not as fresh', () => {
    const old = pane({
      id: 'nohooks',
      activity: null,
      activitySince: null,
      createdAt: new Date(Date.now() - QUIET_AFTER_MS - 60_000).toISOString(),
    });
    expect(notchPanes([old], new Set()).shown).toEqual([]);
  });
});
