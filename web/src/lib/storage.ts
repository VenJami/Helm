// Typed, centralized localStorage for Helm's UI preferences (pane layout,
// order, font size, sidebar/notify toggles). Keys live here — not as string
// literals scattered through App — and every accessor validates + defaults, so
// a corrupt or missing value can never throw into render. All UI-only state:
// losing it degrades to defaults, never data loss.
//
// (sessionStorage's `helm.reload401` stays in api.ts — it's a self-contained
// 401-reload guard that must run at module load, before this is imported.)

const KEYS = {
  wsOrder: 'helm.wsorder',
  workspaceId: 'helm.workspaceId',
  notify: 'helm.notify',
  maximized: 'helm.maximized',
  minimized: 'helm.minimized',
  fontSize: 'helm.fontSize',
  sidebarHidden: 'helm.sidebarHidden',
  theme: 'helm.theme',
  accent: 'helm.accent',
} as const;

// Appearance choices — must match the CSS preset selectors in styles.css.
export type Theme = 'dark' | 'light';
export const ACCENTS = ['amber', 'blue', 'green', 'violet', 'rose'] as const;
export type Accent = (typeof ACCENTS)[number];
const PANE_ORDER_PREFIX = 'helm.paneorder.';
const paneOrderKey = (wsId: string) => `${PANE_ORDER_PREFIX}${wsId}`;
const GRID_WEIGHTS_PREFIX = 'helm.gridweights.';
const gridWeightsKey = (wsId: string) => `${GRID_WEIGHTS_PREFIX}${wsId}`;

// --- low-level (every access is guarded: private mode / quota / denied) ---
function getRaw(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
function setRaw(key: string, val: string): void {
  try {
    localStorage.setItem(key, val);
  } catch {
    /* quota / denied — UI pref, ignore */
  }
}
function remove(key: string): void {
  try {
    localStorage.removeItem(key);
  } catch {
    /* ignore */
  }
}
function getJSON<T>(key: string, fallback: T): T {
  const raw = getRaw(key);
  if (raw == null) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}
function setJSON(key: string, val: unknown): void {
  setRaw(key, JSON.stringify(val));
}

export const storage = {
  wsOrder: {
    get: (): string[] => getJSON<string[]>(KEYS.wsOrder, []),
    set: (ids: string[]): void => setJSON(KEYS.wsOrder, ids),
  },
  workspaceId: {
    get: (): string | null => getRaw(KEYS.workspaceId),
    set: (id: string): void => setRaw(KEYS.workspaceId, id),
  },
  notify: {
    get: (): boolean => getRaw(KEYS.notify) === '1',
    set: (on: boolean): void => setRaw(KEYS.notify, on ? '1' : '0'),
  },
  // pane id, or null when nothing is maximized
  maximized: {
    get: (): string | null => getRaw(KEYS.maximized),
    set: (id: string | null): void => (id ? setRaw(KEYS.maximized, id) : remove(KEYS.maximized)),
  },
  minimized: {
    get: (): Set<string> => new Set(getJSON<string[]>(KEYS.minimized, [])),
    set: (ids: Set<string>): void => setJSON(KEYS.minimized, [...ids]),
  },
  // px in [11,20]; returns fallback when unset/out of range/non-numeric
  fontSize: {
    get: (fallback: number): number => {
      const n = Number(getRaw(KEYS.fontSize));
      return Number.isFinite(n) && n >= 11 && n <= 20 ? n : fallback;
    },
    set: (px: number): void => setRaw(KEYS.fontSize, String(px)),
  },
  sidebarHidden: {
    get: (): boolean => getRaw(KEYS.sidebarHidden) === '1',
    set: (hidden: boolean): void => setRaw(KEYS.sidebarHidden, hidden ? '1' : '0'),
  },
  // unknown/corrupt stored values fall back to the defaults (dark / amber)
  theme: {
    get: (): Theme => (getRaw(KEYS.theme) === 'light' ? 'light' : 'dark'),
    set: (t: Theme): void => setRaw(KEYS.theme, t),
  },
  accent: {
    get: (): Accent => {
      const a = getRaw(KEYS.accent);
      return (ACCENTS as readonly string[]).includes(a ?? '') ? (a as Accent) : 'amber';
    },
    set: (a: Accent): void => setRaw(KEYS.accent, a),
  },
  // one key per workspace (pane display order within it)
  paneOrder: {
    get: (wsId: string): string[] => getJSON<string[]>(paneOrderKey(wsId), []),
    set: (wsId: string, ids: string[]): void => setJSON(paneOrderKey(wsId), ids),
    // Drop per-workspace keys (pane order + grid weights) for workspaces that
    // no longer exist — otherwise they accumulate forever (the old sprawl bug).
    pruneOrphans: (liveWsIds: string[]): void => {
      const live = new Set([...liveWsIds.map(paneOrderKey), ...liveWsIds.map(gridWeightsKey)]);
      try {
        const stale: string[] = [];
        for (let i = 0; i < localStorage.length; i++) {
          const k = localStorage.key(i);
          if (
            k &&
            (k.startsWith(PANE_ORDER_PREFIX) || k.startsWith(GRID_WEIGHTS_PREFIX)) &&
            !live.has(k)
          ) {
            stale.push(k);
          }
        }
        for (const k of stale) localStorage.removeItem(k);
      } catch {
        /* ignore */
      }
    },
  },
  // one key per workspace: grid fr-weights per layout, e.g. {"c3":[1.4,1,0.6],
  // "r2":[1.2,0.8]} — column weights for the 3-wide layout, row weights for the
  // 2-tall one. Values are validated (positive finite numbers) on read.
  gridWeights: {
    get: (wsId: string): Record<string, number[]> => {
      const raw = getJSON<Record<string, unknown>>(gridWeightsKey(wsId), {});
      const out: Record<string, number[]> = {};
      if (raw && typeof raw === 'object') {
        for (const [k, v] of Object.entries(raw)) {
          if (
            Array.isArray(v) &&
            v.every((n) => typeof n === 'number' && Number.isFinite(n) && n > 0)
          ) {
            out[k] = v as number[];
          }
        }
      }
      return out;
    },
    set: (wsId: string, weights: Record<string, number[]>): void =>
      setJSON(gridWeightsKey(wsId), weights),
  },
};
