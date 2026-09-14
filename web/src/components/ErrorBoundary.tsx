// The whole UI is one React tree, so any component that throws while
// rendering unmounts ALL of it — every pane disappears and the window goes
// white with nothing said. The panes themselves are fine (sessions live in the
// server, not the browser), which is exactly what a blank page fails to tell
// you. This catches the throw, says what happened, and offers the reload that
// fixes it.

import { Component, ErrorInfo, ReactNode } from 'react';

interface Props {
  children: ReactNode;
}
interface State {
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // Keep the stack in the browser console for whoever debugs it — the
    // fallback below deliberately shows only the message.
    console.error('Helm UI crashed:', error, info.componentStack);
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    const detail = `${error.message}\n\n${error.stack ?? ''}`.trim();
    return (
      <div className="crash-screen">
        <div className="crash-card">
          <h1>Helm&rsquo;s window hit an error</h1>
          <p>
            Your panes are still running. They live in the Helm server, not in this page, so nothing
            was interrupted and no conversation was lost &mdash; reloading brings the window back to
            them.
          </p>
          <pre className="crash-detail">{error.message}</pre>
          <div className="crash-actions">
            <button className="btn" onClick={() => location.reload()}>
              Reload Helm
            </button>
            <button
              className="btn btn-ghost"
              onClick={() => void navigator.clipboard?.writeText(detail).catch(() => {})}
            >
              Copy details
            </button>
          </div>
          <p className="crash-hint">
            If it happens again straight after reloading, the server console (or
            <code> npm start</code> in <code>server/</code>) will say more.
          </p>
        </div>
      </div>
    );
  }
}
