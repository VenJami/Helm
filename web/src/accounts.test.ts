import { describe, expect, it } from 'vitest';
import { accountLabel, foldMappedDefault } from './accounts';
import type { AccountUsage, UsageWindow } from './types';

// Money-adjacent math (the usage modal's numbers) — the reason these two
// functions get unit tests while presentational code doesn't.

const win = (input: number, models: Record<string, number> = {}): UsageWindow => ({
  input,
  output: input / 2,
  cacheRead: 0,
  cacheWrite: 0,
  turns: 1,
  cost: input / 1e6,
  models: Object.fromEntries(Object.entries(models).map(([name, mIn]) => [
    name,
    { input: mIn, output: mIn / 2, cacheRead: 0, cacheWrite: 0, turns: 1, cost: mIn / 1e6 },
  ])),
});

const account = (name: string, windows: Record<string, UsageWindow>, lastActive: number | null = null): AccountUsage => ({
  account: name,
  email: `${name}@example.com`,
  lastActive,
  windows,
});

describe('accountLabel', () => {
  const profiles = [{ name: 'Claude-2', email: 'shared@example.com' }];

  it('named profiles use their own name', () => {
    expect(accountLabel('Claude-1', 'x@example.com', profiles)).toBe('Claude-1');
  });

  it("default logged into a profile's email borrows that profile's name", () => {
    expect(accountLabel('', 'shared@example.com', profiles)).toBe('Claude-2');
  });

  it('default with an unmatched email derives a name from the local part', () => {
    expect(accountLabel('', 'jamin@example.com', profiles)).toBe('Jamin');
  });

  it('default with no login yet reads "Default"', () => {
    expect(accountLabel('', null, profiles)).toBe('Default');
  });
});

describe('foldMappedDefault', () => {
  it('is a no-op when default is its own distinct account (mapped=null)', () => {
    const rows = [account('default', { all: win(100) })];
    expect(foldMappedDefault(rows, null)).toBe(rows);
  });

  it('is a no-op when the mapped twin is not in the list', () => {
    const rows = [account('default', { all: win(100) })];
    expect(foldMappedDefault(rows, 'Claude-2')).toBe(rows);
  });

  it('folds default into its twin and drops the default row', () => {
    const rows = [
      account('default', { all: win(100, { 'claude-opus-4': 100 }) }, 50),
      account('Claude-2', { all: win(900, { 'claude-sonnet-4-5': 900 }) }, 200),
      account('Claude-1', { all: win(7) }, 10),
    ];
    const out = foldMappedDefault(rows, 'Claude-2');

    expect(out.map((a) => a.account)).toEqual(['Claude-2', 'Claude-1']);
    const merged = out[0];
    expect(merged.windows.all.input).toBe(1000);
    expect(merged.windows.all.turns).toBe(2);
    expect(merged.windows.all.cost).toBeCloseTo(1000 / 1e6);
    // per-model breakdown carries models that existed on only one side
    expect(merged.windows.all.models['claude-opus-4'].input).toBe(100);
    expect(merged.windows.all.models['claude-sonnet-4-5'].input).toBe(900);
    expect(merged.lastActive).toBe(200); // max of the two
    // unrelated account untouched
    expect(out[1]).toBe(rows[2]);
  });

  it('keeps the grand total unchanged (fold only moves numbers between rows)', () => {
    const rows = [
      account('default', { all: win(123), d7: win(23) }),
      account('Claude-2', { all: win(877) }), // no d7 window on the target
    ];
    const total = (list: AccountUsage[], key: string) =>
      list.reduce((n, a) => n + (a.windows[key]?.input ?? 0), 0);
    const out = foldMappedDefault(rows, 'Claude-2');

    expect(total(out, 'all')).toBe(total(rows, 'all'));
    // window keys are the union — a window only default had still appears
    expect(out[0].windows.d7.input).toBe(23);
  });

  it('does not mutate its inputs', () => {
    const target = account('Claude-2', { all: win(900) });
    const rows = [account('default', { all: win(100) }), target];
    foldMappedDefault(rows, 'Claude-2');
    expect(target.windows.all.input).toBe(900);
    expect(rows).toHaveLength(2);
  });

  it('reports null lastActive when neither row has one', () => {
    const rows = [
      account('default', { all: win(1) }, null),
      account('Claude-2', { all: win(2) }, null),
    ];
    expect(foldMappedDefault(rows, 'Claude-2')[0].lastActive).toBeNull();
  });
});
