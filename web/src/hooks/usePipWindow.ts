// Document Picture-in-Picture: a real, always-on-top OS window that Helm can
// render a pane into, so one agent stays visible over VS Code / the browser
// while you work. This is the ONLY way a web page gets a window above other
// apps — an in-page "floating" pane would only float above other Helm panes.
//
// Constraints that shape the API below (all browser-imposed, not choices):
//   · ONE window per document. Popping out pane B closes pane A's window.
//   · Needs a user gesture (a click), so it can never be restored on load —
//     which is why the popped pane id is deliberately NOT persisted.
//   · The window starts as a blank document: stylesheets must be copied in,
//     and the theme attributes mirrored (and kept mirrored — the Appearance
//     dialog can change them while a pane is popped out).
//   · Position is not controllable; size is only a *request* at open time.
// Chrome/Edge/Brave support it (the browsers start-helm.cmd launches); the
// caller hides the pop-out button entirely where `pipSupported` is false.

import { useCallback, useEffect, useRef, useState } from 'react';
import { storage } from '../lib/storage';

// Not in TS's DOM lib yet. Kept as a local shape rather than a `declare global`
// augmentation of Window, which would collide the day the lib does ship it.
interface PipApi {
  readonly window: Window | null;
  requestWindow(options?: { width?: number; height?: number }): Promise<Window>;
}
const pipApi = (): PipApi | null =>
  typeof window !== 'undefined' && 'documentPictureInPicture' in window
    ? (window as unknown as { documentPictureInPicture: PipApi }).documentPictureInPicture
    : null;

export const pipSupported = (): boolean => pipApi() !== null;

// The PiP document is blank — clone every stylesheet in. Same-origin sheets
// expose cssRules and are inlined; anything that throws (cross-origin) is
// re-linked by href instead so it still loads.
function copyStyles(target: Window): void {
  for (const sheet of Array.from(document.styleSheets)) {
    try {
      const css = Array.from(sheet.cssRules)
        .map((r) => r.cssText)
        .join('\n');
      const style = target.document.createElement('style');
      style.textContent = css;
      target.document.head.appendChild(style);
    } catch {
      if (sheet.href) {
        const link = target.document.createElement('link');
        link.rel = 'stylesheet';
        link.href = sheet.href;
        target.document.head.appendChild(link);
      }
    }
  }
}

// data-theme / data-accent live on <html> and the CSS presets key off them, so
// the popped window needs them too — and needs to follow later changes.
function mirrorTheme(target: Window): () => void {
  const src = document.documentElement;
  const apply = () => {
    const dst = target.document.documentElement;
    for (const attr of ['data-theme', 'data-accent']) {
      const val = src.getAttribute(attr);
      if (val === null) dst.removeAttribute(attr);
      else dst.setAttribute(attr, val);
    }
  };
  apply();
  const obs = new MutationObserver(apply);
  obs.observe(src, { attributes: true, attributeFilter: ['data-theme', 'data-accent'] });
  return () => obs.disconnect();
}

export function usePipWindow() {
  const [pipWindow, setPipWindow] = useState<Window | null>(null);
  const winRef = useRef<Window | null>(null);
  const cleanupRef = useRef<(() => void) | null>(null);

  const close = useCallback(() => {
    winRef.current?.close();
    // 'pagehide' does the state teardown; calling close() on an already-closed
    // window is a no-op, so this stays safe to call defensively.
  }, []);

  const open = useCallback(async (): Promise<Window | null> => {
    const api = pipApi();
    if (!api) return null;
    winRef.current?.close(); // one window per document — replace, don't stack
    const size = storage.pipSize.get();
    const win = await api.requestWindow({ width: size.w, height: size.h });
    copyStyles(win);
    const stopMirror = mirrorTheme(win);
    win.document.body.classList.add('pip-body');

    // Remember the size the user settled on for the next pop-out. Read on
    // resize rather than at pagehide, where the window may already be torn down.
    let last = size;
    const onResize = () => {
      if (win.innerWidth > 0 && win.innerHeight > 0)
        last = { w: win.innerWidth, h: win.innerHeight };
    };
    win.addEventListener('resize', onResize);

    const teardown = () => {
      stopMirror();
      win.removeEventListener('resize', onResize);
      storage.pipSize.set(last);
      cleanupRef.current = null;
      if (winRef.current === win) {
        winRef.current = null;
        setPipWindow(null); // the pane goes back to the grid
      }
    };
    cleanupRef.current = teardown;
    win.addEventListener('pagehide', teardown);

    winRef.current = win;
    setPipWindow(win);
    return win;
  }, []);

  // A leftover floating window with a dead React tree inside it would be a
  // ghost, so it dies with the app.
  useEffect(
    () => () => {
      cleanupRef.current?.();
      winRef.current?.close();
    },
    [],
  );

  return { pipWindow, open, close };
}
