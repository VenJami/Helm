import { describe, expect, it, vi, afterEach } from 'vitest';
import { age, daysSince } from './time';

const NOW = new Date('2026-09-10T12:00:00Z');
const ago = (ms: number) => new Date(NOW.getTime() - ms).toISOString();
const HOUR = 3600_000;
const DAY = 24 * HOUR;

afterEach(() => vi.useRealTimers());
const freeze = () => vi.useFakeTimers({ now: NOW });

describe('age', () => {
  it('describes the recent past in the biggest sensible unit', () => {
    freeze();
    expect(age(ago(30_000))).toBe('just now');
    expect(age(ago(3 * HOUR))).toBe('3h ago');
    expect(age(ago(2 * DAY))).toBe('2d ago');
    expect(age(ago(13 * DAY))).toBe('13d ago');
    // switches to weeks at a fortnight, so a 53-day pane doesn't read as "53d"
    expect(age(ago(14 * DAY))).toBe('2w ago');
    expect(age(ago(53 * DAY))).toBe('7w ago');
  });

  it('says nothing rather than something wrong', () => {
    freeze();
    expect(age(null)).toBe('');
    expect(age(undefined)).toBe('');
    expect(age('not a date')).toBe('');
    // a timestamp in the future (clock skew) is not "in -3h"
    expect(age(new Date(NOW.getTime() + 3 * HOUR).toISOString())).toBe('');
  });
});

describe('daysSince', () => {
  it('counts whole days', () => {
    freeze();
    expect(daysSince(ago(0))).toBe(0);
    expect(daysSince(ago(23 * HOUR))).toBe(0);
    expect(daysSince(ago(DAY))).toBe(1);
    expect(daysSince(ago(53 * DAY))).toBe(53);
  });

  it('treats an unusable date as oldest, and skew as now', () => {
    freeze();
    // Infinity sorts first and lands inside any "older than N days" cleanup
    // filter — a pane with no usable timestamp should be offered, not hidden.
    expect(daysSince(null)).toBe(Infinity);
    expect(daysSince('not a date')).toBe(Infinity);
    expect(daysSince(new Date(NOW.getTime() + DAY).toISOString())).toBe(0);
  });
});
