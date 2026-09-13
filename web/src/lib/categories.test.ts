// The folder/pane color rule. Worth unit-testing because it is the one place
// the rule "the folder owns the color" is actually expressed — get it wrong and
// panes silently keep a stale color that no longer means anything.
import { describe, expect, it } from 'vitest';
import { categoryOf, groupByCategory, paneAccent, panesIn } from './categories';
import type { Category, SessionInfo } from '../types';

const pane = (over: Partial<SessionInfo>): SessionInfo =>
  ({
    id: over.id ?? 'x',
    name: over.name ?? 'Pane',
    color: over.color ?? '#90a4ae',
    categoryId: over.categoryId ?? null,
    workspace: String.raw`C:\proj\storefront`,
    profile: null,
    kind: 'claude',
    command: null,
    status: 'running',
    exitCode: null,
    activity: 'idle',
    activitySince: null,
    activityNote: null,
    pendingId: null,
    pendingTool: null,
    pendingDetail: null,
    pendingSince: null,
    summary: null,
    canResume: false,
    hasTranscript: false,
    attached: 0,
    createdAt: new Date().toISOString(),
  }) as SessionInfo;

const red: Category = { id: 'c1', name: 'Client work', color: '#ff3b30' };
const navy: Category = { id: 'c2', name: 'Backend', color: '#2b4c9b' };
const cats = [red, navy];

describe('categoryOf', () => {
  it('finds the folder a pane is filed in', () => {
    expect(categoryOf(pane({ categoryId: 'c2' }), cats)).toEqual(navy);
  });

  it('is null for an unfiled pane', () => {
    expect(categoryOf(pane({}), cats)).toBeNull();
  });

  it('is null for an id no folder matches, rather than throwing', () => {
    // A folder deleted in another tab leaves this state behind for one poll.
    expect(categoryOf(pane({ categoryId: 'gone' }), cats)).toBeNull();
  });

  it('is null when there are no folders at all', () => {
    expect(categoryOf(pane({ categoryId: 'c1' }), [])).toBeNull();
  });
});

describe('paneAccent', () => {
  it('takes the folder colour when the pane is filed', () => {
    expect(paneAccent(pane({ categoryId: 'c1', color: '#4fc3f7' }), cats)).toBe('#ff3b30');
  });

  it('falls back to the pane own colour when unfiled', () => {
    expect(paneAccent(pane({ color: '#4fc3f7' }), cats)).toBe('#4fc3f7');
  });

  it('falls back when the folder is gone, so a pane is never left colourless', () => {
    expect(paneAccent(pane({ categoryId: 'gone', color: '#4fc3f7' }), cats)).toBe('#4fc3f7');
  });

  it('recolouring the folder repaints every pane in it', () => {
    const panes = [pane({ id: 'a', categoryId: 'c1' }), pane({ id: 'b', categoryId: 'c1' })];
    const recoloured = [{ ...red, color: '#81c784' }, navy];
    expect(panes.map((p) => paneAccent(p, recoloured))).toEqual(['#81c784', '#81c784']);
  });
});

describe('panesIn', () => {
  it('counts only the panes filed in that folder', () => {
    const panes = [
      pane({ id: 'a', categoryId: 'c1' }),
      pane({ id: 'b', categoryId: 'c2' }),
      pane({ id: 'c', categoryId: 'c1' }),
      pane({ id: 'd' }),
    ];
    expect(panesIn('c1', panes).map((p) => p.id)).toEqual(['a', 'c']);
    expect(panesIn('c2', panes)).toHaveLength(1);
    expect(panesIn('nope', panes)).toHaveLength(0);
  });
});

describe('groupByCategory', () => {
  const panes = [
    pane({ id: 'a', categoryId: 'c1' }),
    pane({ id: 'b', categoryId: 'c2' }),
    pane({ id: 'c', categoryId: 'c1' }),
    pane({ id: 'd' }),
  ];

  it('buckets panes under their category', () => {
    expect(
      groupByCategory(panes, cats).map((g) => [g.category?.name ?? null, g.panes.map((p) => p.id)]),
    ).toEqual([
      ['Client work', ['a', 'c']],
      ['Backend', ['b']],
      [null, ['d']],
    ]);
  });

  it('orders groups by the CATEGORY list, not by the panes', () => {
    // Same panes, categories the other way round — the tray must follow the
    // category order or groups jump about as panes are minimized/restored.
    expect(groupByCategory(panes, [navy, red]).map((g) => g.category?.name ?? null)).toEqual([
      'Backend',
      'Client work',
      null,
    ]);
  });

  it('drops empty categories — the tray shows only what is in it', () => {
    expect(groupByCategory([pane({ id: 'a', categoryId: 'c1' })], cats)).toHaveLength(1);
  });

  it('puts uncategorized panes last, in one unlabelled group', () => {
    const groups = groupByCategory(panes, cats);
    expect(groups.at(-1)?.category).toBeNull();
  });

  it('treats a pane whose category is gone as uncategorized, not as its own group', () => {
    const groups = groupByCategory([pane({ id: 'x', categoryId: 'gone' })], cats);
    expect(groups).toEqual([{ category: null, panes: [expect.objectContaining({ id: 'x' })] }]);
  });

  it('is empty when there is nothing in the tray', () => {
    expect(groupByCategory([], cats)).toEqual([]);
  });
});
