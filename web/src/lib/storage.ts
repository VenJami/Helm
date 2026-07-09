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
} as const;
const PANE_ORDER_PREFIX = 'helm.paneorder.';
const paneOrderKey = (wsId: string) => `${PANE_ORDER_PREFIX}${wsId}`;

// --- low-level (every access is guarded: private mode / quota / denied) ---
function getRaw(key: string): string | null {
  try { return localStorage.getItem(key); } catch { return null; }
}
function setRaw(key: string, val: string): void {
  try { localStorage.setItem(key, val); } catch { /* quota / denied — UI pref, ignore */ }
}
function remove(key: string): void {
  try { localStorage.removeItem(key); } catch { /* ignore */ }
}
function getJSON<T>(key: string, fallback: T): T {
  const raw = getRaw(key);
  if (raw == null) return fallback;
  try { return JSON.parse(raw) as T; } catch { return fallback; }
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
  // one key per workspace (pane display order within it)
  paneOrder: {
    get: (wsId: string): string[] => getJSON<string[]>(paneOrderKey(wsId), []),
    set: (wsId: string, ids: string[]): void => setJSON(paneOrderKey(wsId), ids),
    // Drop paneorder keys for workspaces that no longer exist — otherwise they
    // accumulate forever as workspaces are removed (the old sprawl bug).
    pruneOrphans: (liveWsIds: string[]): void => {
      const live = new Set(liveWsIds.map(paneOrderKey));
      try {
        const stale: string[] = [];
        for (let i = 0; i < localStorage.length; i++) {
          const k = localStorage.key(i);
          if (k && k.startsWith(PANE_ORDER_PREFIX) && !live.has(k)) stale.push(k);
        }
        for (const k of stale) localStorage.removeItem(k);
      } catch { /* ignore */ }
    },
  },
};
