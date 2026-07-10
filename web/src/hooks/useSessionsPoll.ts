// The app's session/profile data layer: polls every 3 s, keeps object
// references STABLE across polls (so React.memo(TerminalPane) can skip
// untouched panes), and raises edge-triggered desktop notifications when a
// pane starts waiting / finishes. Extracted from App.tsx (P3-2) — App consumes
// the data and still owns optimistic updates via the returned setters (create
// pushes, kill filters, profile rename maps…).

import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api';
import type { Profile, SessionInfo } from '../types';

// Flat-object equality over own keys (SessionInfo/Profile are flat). Used to
// reuse the previous poll's object reference when nothing changed, so memoized
// consumers don't see every prop as new every 3 s.
function shallowEqual<T extends object>(a: T, b: T): boolean {
  const keys = Object.keys(a) as (keyof T)[];
  if (keys.length !== Object.keys(b).length) return false;
  return keys.every((k) => a[k] === b[k]);
}

export function useSessionsPoll(notifyEnabled: boolean) {
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [defaultEmail, setDefaultEmail] = useState<string | null>(null);
  const [defaultMapped, setDefaultMapped] = useState<string | null>(null);

  // Previous activity per session, for edge-triggered notifications.
  // undefined entry = first sighting (never notify on first sighting).
  const prevActivityRef = useRef<Map<string, SessionInfo['activity']>>(new Map());
  const notifyRef = useRef(notifyEnabled);
  notifyRef.current = notifyEnabled;

  const maybeNotify = useCallback((list: SessionInfo[]) => {
    const prev = prevActivityRef.current;
    const next = new Map<string, SessionInfo['activity']>();
    for (const s of list) next.set(s.id, s.activity);

    // No alerts while the user is actively looking at Helm
    const shouldAlert =
      notifyRef.current && Notification.permission === 'granted' && !document.hasFocus();
    if (shouldAlert) {
      for (const s of list) {
        if (!prev.has(s.id) || s.status !== 'running') continue;
        const was = prev.get(s.id);
        const where = s.workspace.split(/[\\/]/).filter(Boolean).pop();
        let text: string | null = null;
        if (s.activity === 'waiting' && was !== 'waiting') {
          // Prefer the hook's own message ("Claude needs permission to…") so
          // the alert says why it's blocked, not just the generic phrase.
          text = `${s.activityNote || 'needs your input'} · ${where}`;
        } else if (s.activity === 'idle' && was === 'working') {
          text = `finished · ${where}`;
        }
        if (text) {
          const n = new Notification(`${s.name} · ${text}`, { tag: s.id });
          n.onclick = () => window.focus();
        }
      }
    }
    prevActivityRef.current = next;
  }, []);

  // The polls return brand-new objects every 3 s even when nothing changed —
  // reuse the previous reference for unchanged entries (see shallowEqual).
  const sessionCacheRef = useRef<Map<string, SessionInfo>>(new Map());
  const stabilizeSessions = useCallback((list: SessionInfo[]): SessionInfo[] => {
    const cache = sessionCacheRef.current;
    const next = new Map<string, SessionInfo>();
    const out = list.map((s) => {
      const prev = cache.get(s.id);
      const chosen = prev && shallowEqual(prev, s) ? prev : s;
      next.set(s.id, chosen);
      return chosen;
    });
    sessionCacheRef.current = next;
    return out;
  }, []);
  const profilesCacheRef = useRef<Profile[]>([]);

  const refresh = useCallback(() => {
    api
      .listSessions()
      .then((list) => {
        maybeNotify(list);
        setSessions(stabilizeSessions(list));
      })
      .catch(() => {});
    // Profiles too, so the email shows up right after /login in a pane
    api
      .listProfiles()
      .then((info) => {
        const prevProfiles = profilesCacheRef.current;
        const unchanged =
          prevProfiles.length === info.profiles.length &&
          info.profiles.every((p, i) => shallowEqual(p, prevProfiles[i]));
        if (!unchanged) {
          profilesCacheRef.current = info.profiles;
          setProfiles(info.profiles);
        }
        setDefaultEmail(info.default.email);
        setDefaultMapped(info.default.mapped);
      })
      .catch(() => {});
  }, [maybeNotify, stabilizeSessions]);

  useEffect(() => {
    refresh();
    const timer = setInterval(refresh, 3000);
    return () => clearInterval(timer);
  }, [refresh]);

  return {
    sessions,
    setSessions,
    profiles,
    setProfiles,
    defaultEmail,
    defaultMapped,
    refresh,
  };
}
