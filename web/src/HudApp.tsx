// The agent HUD as a STANDALONE page (served at /hud), as opposed to the copy
// App portals into its picture-in-picture window.
//
// Why both exist: the picture-in-picture HUD lives in App's React tree, so it
// can call App's jumpToPane directly — but the browser owns that window and
// refuses to size it below roughly 200px, which is why AgentHud's collapsed
// pill has to pad itself out. A real window can be any shape, and this page is
// what such a window loads. It fetches its own data over the same REST API and
// sends "jump to that pane" back through the server, so it works from a plain
// second browser window today and from a separate process later.
//
// It deliberately does NOT reuse useWorkspaceStatus: that also polls dev-server
// ports and share links every 4 s, none of which the HUD renders. Only git is
// needed here (for the branch chip), so this polls just that.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AgentHud } from './components/AgentHud';
import { useSessionsPoll } from './hooks/useSessionsPoll';
import { api } from './api';
import { storage } from './lib/storage';
import { inNativeHost, onHostMessage, sendToHost } from './lib/nativeHost';
import { NotchStrip, compactWidthFor } from './components/NotchStrip';
import { foldDir, notchPanes } from './lib/paneStatus';
import type { Category, GitInfo, SessionInfo, Workspace } from './types';

const WS_POLL_MS = 6000;

// `?notch=1` — the presentation the native window (desktop/HelmNotch) asks for:
// a transparent document with one rounded card, instead of a page that fills a
// browser window. Read once; it cannot change without a navigation.
const NOTCH = new URLSearchParams(window.location.search).has('notch');

export function HudApp() {
  // `false` = never raise desktop notifications from this window. The main app
  // already does, and two windows polling the same sessions would double every
  // alert.
  const { sessions, profiles, defaultEmail, defaultMapped, refresh } = useSessionsPoll(false);
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [git, setGit] = useState<Record<string, GitInfo>>({});
  const [categories, setCategories] = useState<Category[]>([]);

  // Mirror the app's theme. Same-origin windows share localStorage, and a
  // `storage` event fires HERE when another window writes one — so switching
  // theme in the app repaints this page too, which the picture-in-picture HUD
  // got for free by sharing a document.
  useEffect(() => {
    const apply = () => {
      const root = document.documentElement;
      const theme = storage.theme.get();
      const accent = storage.accent.get();
      if (theme === 'light') root.dataset.theme = 'light';
      else delete root.dataset.theme;
      if (accent !== 'amber') root.dataset.accent = accent;
      else delete root.dataset.accent;
    };
    apply();
    window.addEventListener('storage', apply);
    return () => window.removeEventListener('storage', apply);
  }, []);

  useEffect(() => {
    const pull = () => {
      api
        .listWorkspaces()
        .then(setWorkspaces)
        .catch(() => {});
      api
        .getWorkspacesGit()
        .then((list) => setGit(Object.fromEntries(list.map((g) => [g.id, g]))))
        .catch(() => {});
      // Folders rarely change, so they ride this slow poll rather than the 3 s
      // session one — a pane recolored in Helm catches up within a tick.
      api
        .listCategories()
        .then(setCategories)
        .catch(() => {});
    };
    pull();
    const timer = setInterval(pull, WS_POLL_MS);
    return () => clearInterval(timer);
  }, []);

  // ---- notch mode: the page inside Helm's native window -------------------
  const cardRef = useRef<HTMLDivElement>(null);
  // At rest the notch is a strip of status lights; the host flips this when the
  // cursor reaches it. Host-driven because once the window is a small strip the
  // page can no longer tell where the cursor is relative to the screen edge.
  const [compact, setCompact] = useState(false);

  useEffect(() => {
    if (!NOTCH) return;
    return onHostMessage((state) => setCompact(state.compact));
  }, []);

  // Transparent document, so the window shows only what the card paints.
  // Set on <html> because that is what the browser paints the page ground from.
  useEffect(() => {
    if (!NOTCH) return;
    document.documentElement.classList.add('notch');
    return () => document.documentElement.classList.remove('notch');
  }, []);

  // Keep the OS window exactly the size of the card. This is what lets the
  // notch collapse for real — and it is why the window needs no click-through:
  // there is no dead window area around the card to click through to begin
  // with. ResizeObserver rather than reacting to the collapse toggle, so any
  // reason the content changes height (a pane starts asking) moves the window.
  useEffect(() => {
    const el = cardRef.current;
    if (!NOTCH || !inNativeHost() || !el) return;
    let last = 0;
    const send = () => {
      const h = Math.ceil(el.getBoundingClientRect().height);
      // A dead band on top of the height-only rule: sub-pixel rounding between
      // CSS pixels and the window's device-independent ones can otherwise have
      // the window twitching by a pixel forever.
      if (Math.abs(h - last) < 2) return;
      last = h;
      sendToHost({ cmd: 'resize', h });
    };
    const ro = new ResizeObserver(send);
    ro.observe(el);
    send();
    return () => ro.disconnect();
  }, []);

  // Re-measure when the mode changes: the strip and the full list are very
  // different heights, and the observer alone can miss the swap's first frame.
  useEffect(() => {
    const el = cardRef.current;
    if (!NOTCH || !inNativeHost() || !el) return;
    const id = requestAnimationFrame(() =>
      sendToHost({ cmd: 'resize', h: Math.ceil(el.getBoundingClientRect().height) }),
    );
    return () => cancelAnimationFrame(id);
  }, [compact]);

  // Tell the host whether to hide while Helm's own window is up. Polled rather
  // than fetched once, so flipping the toggle in Helm reaches the notch without
  // restarting it; the host ignores a repeat of what it already knows.
  useEffect(() => {
    if (!NOTCH || !inNativeHost()) return;
    const pull = () =>
      api
        .getSettings()
        .then((s) =>
          sendToHost({
            cmd: 'config',
            follow: s.notchFollowsHelm,
            autoCompact: s.notchAutoCompact,
          }),
        )
        .catch(() => {});
    pull();
    const timer = setInterval(pull, 4000);
    return () => clearInterval(timer);
  }, []);

  // What the notch lists. Muted projects go first, then panes that have gone
  // quiet - see notchPanes. Only in NOTCH mode: /hud in a browser window is the
  // full view, and the notch is the glanceable one.
  const muted = useMemo(
    () => new Set(workspaces.filter((w) => w.notch === false).map((w) => foldDir(w.dir))),
    [workspaces],
  );
  const { shown, quiet } = useMemo(
    () => (NOTCH ? notchPanes(sessions, muted) : { shown: sessions, quiet: 0 }),
    [sessions, muted],
  );

  // The compact strip is wider when it has to name a project ("storefront !
  // Needs you") than when it is just lights. Sent as a discrete constant, and
  // only when it changes, so the host can size the window without measuring.
  const compactWidth = compactWidthFor(shown);
  useEffect(() => {
    if (!NOTCH || !inNativeHost()) return;
    sendToHost({ cmd: 'compactWidth', w: compactWidth });
  }, [compactWidth]);

  // The one thing this window cannot do itself: bring a pane to the front in
  // the app's window. The server relays it (see /api/focus).
  const jump = useCallback((s: SessionInfo) => {
    // Raise FIRST, while the click that got us here still counts as recent
    // input - Windows only grants foreground rights to a process that has it.
    // Then ask Helm to select the pane; that half travels through the server.
    if (inNativeHost()) sendToHost({ cmd: 'raiseHelm' });
    void api.requestFocus(s.id).catch(() => {});
  }, []);

  // The notch has no close button - it is a strip, and a title bar of its own
  // is the chrome it exists to avoid - so right-clicking it closes it. The
  // host disables the web view's own context menu, so nothing else wants this
  // gesture.
  useEffect(() => {
    if (!NOTCH || !inNativeHost()) return;
    const onContext = (e: MouseEvent) => {
      e.preventDefault();
      sendToHost({ cmd: 'close' });
    };
    document.addEventListener('contextmenu', onContext);
    return () => document.removeEventListener('contextmenu', onContext);
  }, []);

  // In a browser window this is window.close(); in the native one the page
  // cannot close its host, so it asks.
  const close = useCallback(() => {
    if (inNativeHost()) sendToHost({ cmd: 'close' });
    else window.close();
  }, []);

  return (
    <div className={`hud-page${NOTCH ? ' notch' : ''}${compact ? ' compact' : ''}`} ref={cardRef}>
      {compact ? (
        <NotchStrip sessions={shown} />
      ) : (
        <AgentHud
          sessions={shown}
          workspaces={workspaces}
          git={git}
          profiles={profiles}
          defaultEmail={defaultEmail}
          defaultMapped={defaultMapped}
          onJumpToPane={jump}
          onChanged={refresh}
          onClose={close}
          chrome={!NOTCH}
          showTask={NOTCH}
          quietCount={quiet}
          categories={categories}
        />
      )}
    </div>
  );
}
