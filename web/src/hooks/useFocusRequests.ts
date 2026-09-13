// Listens for "jump to this pane" requests raised by a HUD running in its own
// window (/hud). Those can't reach App's handler directly — a separate document,
// and later a separate process — so they come through the server.
//
// A long poll rather than another 3 s tick: a click that took up to three
// seconds to move the app would read as broken. The server holds the request
// open (~25 s) and answers the instant one lands; an expired hold just returns
// an empty answer and the loop reconnects. `since` carries the last handled
// timestamp so a request arriving during a reconnect is still delivered.

import { useEffect, useRef } from 'react';

import { api } from '../api';

const RETRY_MS = 2000; // server down / restarting — don't spin

export function useFocusRequests(onFocus: (sessionId: string) => void) {
  // Kept in a ref so a changing callback (it closes over `sessions`) never
  // restarts the loop and drops the parked request.
  const cb = useRef(onFocus);
  cb.current = onFocus;

  useEffect(() => {
    let stopped = false;
    const ac = new AbortController();
    let since = Date.now();

    const loop = async () => {
      while (!stopped) {
        try {
          const req = await api.waitForFocus(since, ac.signal);
          if (stopped) return;
          since = req.at;
          if (req.sessionId) cb.current(req.sessionId);
        } catch {
          // Aborted on unmount, or the server went away mid-hold. The abort
          // case exits on the next `stopped` check; the rest backs off.
          if (stopped) return;
          await new Promise((r) => setTimeout(r, RETRY_MS));
        }
      }
    };
    void loop();

    return () => {
      stopped = true;
      ac.abort();
    };
  }, []);
}
