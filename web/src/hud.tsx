// Entry point for /hud — the floating agent HUD as its own page. Mirrors
// main.tsx; the server serves hud.html with the same token injection.
import { createRoot } from 'react-dom/client';
import { HudApp } from './HudApp';
import { ErrorBoundary } from './components/ErrorBoundary';
import './styles.css';

createRoot(document.getElementById('root')!).render(
  <ErrorBoundary>
    <HudApp />
  </ErrorBoundary>,
);
