// The page's end of the bridge to a native window host.
//
// When /hud is loaded inside a native shell (the WPF + WebView2 notch in
// desktop/), that host exposes `window.chrome.webview`. The page uses it for
// the handful of things only the OS window can do — move itself, size itself to
// its content, let clicks fall through to whatever is underneath, close.
//
// Everything here is a no-op in an ordinary browser tab, which is the point:
// /hud stays a normal page, and the same build serves both.

// No click-through message here on purpose. The obvious design — the page
// turning WS_EX_TRANSPARENT on over its own transparent margin — cannot work:
// once a window ignores the mouse it stops receiving mouse messages, so the
// page would never see the pointer come back and could never turn it off. The
// window instead HUGS its content (see 'resize'), which leaves nothing to click
// through; anything outside the notch is already the editor underneath.
/** Messages the page sends to a native host. Mirrored in desktop/HelmNotch. */
export type HostMessage =
  // How the notch should behave. The page owns these because they live behind
  // the server's auth token, which the host has no way to read.
  //   follow      - hide entirely while Helm's own window is on screen
  //   autoCompact - otherwise rest as a strip of status lights and expand on
  //                 hover, the way an auto-hidden taskbar slides back
  | { cmd: 'config'; follow: boolean; autoCompact: boolean }
  // HEIGHT ONLY, and that is load-bearing. Driving the window's WIDTH from the
  // page is a feedback loop: a narrower window reflows the content, which
  // changes the measured width, which resizes the window again — it oscillated
  // between two values and, with the window re-centring each time, visibly
  // shook on screen. The window owns its width; only height follows content.
  | { cmd: 'resize'; h: number }
  // Which fixed width the compact strip needs. NOT a measurement - it is one of
  // a couple of constants chosen by STATE (quiet vs something-needs-you), so it
  // cannot feed back into itself the way measuring a reflowing layout did.
  | { cmd: 'compactWidth'; w: number }
  // Bring Helm's own window to the front (restoring it if minimised). Has to be
  // the HOST: the page's window.focus() is a web page asking politely, which
  // browsers ignore for a background window - so clicking an agent used to
  // select the right pane inside a Helm that stayed hidden.
  | { cmd: 'raiseHelm' }
  | { cmd: 'close' };

/** What the host tells the page. Mirrors PostState in MainWindow.xaml.cs. */
export interface HostState {
  /** At rest the notch shows only its status lights; hovered, the full list. */
  compact: boolean;
}

interface WebView2Bridge {
  postMessage(message: unknown): void;
  addEventListener(type: 'message', fn: (e: { data: unknown }) => void): void;
  removeEventListener(type: 'message', fn: (e: { data: unknown }) => void): void;
}

const bridge = (): WebView2Bridge | null => {
  const w = window as unknown as { chrome?: { webview?: WebView2Bridge } };
  return w.chrome?.webview ?? null;
};

/** True when this page is running inside Helm's native window, not a browser. */
export const inNativeHost = (): boolean => bridge() !== null;

export function sendToHost(msg: HostMessage): void {
  try {
    bridge()?.postMessage(msg);
  } catch {
    // A host that went away mid-call must never take the page down with it.
  }
}

/**
 * Listen for the host's state. The host owns hover detection (the page cannot
 * see the cursor once the window is small), so it decides compact vs expanded
 * and tells the page here. No-op in a browser, where there is no host.
 */
export function onHostMessage(cb: (state: HostState) => void): () => void {
  const b = bridge();
  if (!b) return () => {};
  const handler = (e: { data: unknown }) => {
    const d = e.data;
    if (d && typeof d === 'object' && typeof (d as HostState).compact === 'boolean') {
      cb(d as HostState);
    }
  };
  b.addEventListener('message', handler);
  return () => b.removeEventListener('message', handler);
}
