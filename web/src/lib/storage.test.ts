import { beforeEach, describe, expect, it } from 'vitest';
import { storage } from './storage';

// Minimal in-memory localStorage (vitest runs in node — no DOM). Matches the
// Storage surface storage.ts touches: getItem/setItem/removeItem/length/key.
class FakeStorage {
  map = new Map<string, string>();
  getItem(k: string) {
    return this.map.has(k) ? this.map.get(k)! : null;
  }
  setItem(k: string, v: string) {
    this.map.set(k, String(v));
  }
  removeItem(k: string) {
    this.map.delete(k);
  }
  get length() {
    return this.map.size;
  }
  key(i: number) {
    return [...this.map.keys()][i] ?? null;
  }
}

beforeEach(() => {
  (globalThis as unknown as { localStorage: FakeStorage }).localStorage = new FakeStorage();
});

describe('storage round-trips', () => {
  it('wsOrder / minimized default to empty then persist', () => {
    expect(storage.wsOrder.get()).toEqual([]);
    storage.wsOrder.set(['a', 'b']);
    expect(storage.wsOrder.get()).toEqual(['a', 'b']);

    expect(storage.minimized.get()).toEqual(new Set());
    storage.minimized.set(new Set(['x', 'y']));
    expect(storage.minimized.get()).toEqual(new Set(['x', 'y']));
  });

  it('maximized set(null) clears the key', () => {
    storage.maximized.set('pane-1');
    expect(storage.maximized.get()).toBe('pane-1');
    storage.maximized.set(null);
    expect(storage.maximized.get()).toBeNull();
  });

  it('boolean toggles persist as 1/0', () => {
    expect(storage.notify.get()).toBe(false);
    storage.notify.set(true);
    expect(storage.notify.get()).toBe(true);
    expect(storage.sidebarHidden.get()).toBe(false);
    storage.sidebarHidden.set(true);
    expect(storage.sidebarHidden.get()).toBe(true);
  });
});

describe('fontSize clamping', () => {
  it('returns fallback when unset, out of range, or non-numeric', () => {
    expect(storage.fontSize.get(13)).toBe(13);
    localStorage.setItem('helm.fontSize', '99');
    expect(storage.fontSize.get(13)).toBe(13);
    localStorage.setItem('helm.fontSize', 'abc');
    expect(storage.fontSize.get(13)).toBe(13);
  });
  it('returns an in-range stored value', () => {
    storage.fontSize.set(16);
    expect(storage.fontSize.get(13)).toBe(16);
  });
});

describe('theme/accent validate against the preset lists', () => {
  it('default to dark/amber and round-trip', () => {
    expect(storage.theme.get()).toBe('dark');
    expect(storage.accent.get()).toBe('amber');
    storage.theme.set('light');
    storage.accent.set('violet');
    expect(storage.theme.get()).toBe('light');
    expect(storage.accent.get()).toBe('violet');
  });
  it('unknown stored values fall back to defaults', () => {
    localStorage.setItem('helm.theme', 'hotdog');
    localStorage.setItem('helm.accent', 'neon-zebra');
    expect(storage.theme.get()).toBe('dark');
    expect(storage.accent.get()).toBe('amber');
  });
});

describe('corrupt values fall back, never throw', () => {
  it('malformed JSON yields the default', () => {
    localStorage.setItem('helm.wsorder', '{not json');
    expect(storage.wsOrder.get()).toEqual([]);
    localStorage.setItem('helm.minimized', 'nope');
    expect(storage.minimized.get()).toEqual(new Set());
  });
});

describe('paneOrder is per-workspace + prunes orphans', () => {
  it('keys are isolated per workspace', () => {
    storage.paneOrder.set('ws1', ['p1', 'p2']);
    storage.paneOrder.set('ws2', ['p3']);
    expect(storage.paneOrder.get('ws1')).toEqual(['p1', 'p2']);
    expect(storage.paneOrder.get('ws2')).toEqual(['p3']);
    expect(storage.paneOrder.get('ws3')).toEqual([]);
  });

  it('pruneOrphans drops keys for workspaces no longer present, keeps live ones + other keys', () => {
    storage.paneOrder.set('ws1', ['p1']);
    storage.paneOrder.set('ws2', ['p2']);
    storage.paneOrder.set('ws3', ['p3']);
    storage.gridWeights.set('ws1', { c2: [1.5, 0.5] });
    storage.gridWeights.set('ws2', { c2: [1, 1] });
    storage.wsOrder.set(['ws1', 'ws2']); // an unrelated key must survive

    storage.paneOrder.pruneOrphans(['ws1']); // only ws1 is live now

    expect(storage.paneOrder.get('ws1')).toEqual(['p1']);
    expect(localStorage.getItem('helm.paneorder.ws2')).toBeNull();
    expect(localStorage.getItem('helm.paneorder.ws3')).toBeNull();
    expect(storage.gridWeights.get('ws1')).toEqual({ c2: [1.5, 0.5] });
    expect(localStorage.getItem('helm.gridweights.ws2')).toBeNull();
    expect(storage.wsOrder.get()).toEqual(['ws1', 'ws2']); // untouched
  });
});

describe('gridWeights validate per-entry', () => {
  it('round-trips valid layouts and drops corrupt ones', () => {
    storage.gridWeights.set('ws1', { c3: [1.2, 1, 0.8], r2: [1.5, 0.5] });
    expect(storage.gridWeights.get('ws1')).toEqual({ c3: [1.2, 1, 0.8], r2: [1.5, 0.5] });

    localStorage.setItem(
      'helm.gridweights.ws1',
      JSON.stringify({ c2: [1, -5], c3: ['x', 1, 1], r2: [1.5, 0.5] }),
    );
    expect(storage.gridWeights.get('ws1')).toEqual({ r2: [1.5, 0.5] }); // bad entries dropped
    localStorage.setItem('helm.gridweights.ws1', '{broken');
    expect(storage.gridWeights.get('ws1')).toEqual({});
  });
});
