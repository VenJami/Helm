// Theme + accent state: persisted in localStorage, applied as data attributes
// on <html> that the CSS preset blocks in styles.css key off. Dark/amber is
// the default (no attributes). Terminal panes stay dark in light mode by
// design — see the light-theme comment in styles.css.

import { useEffect, useState } from 'react';
import { storage, type Accent, type Theme } from '../lib/storage';

export function useTheme() {
  const [theme, setTheme] = useState<Theme>(() => storage.theme.get());
  const [accent, setAccent] = useState<Accent>(() => storage.accent.get());

  useEffect(() => {
    const root = document.documentElement;
    if (theme === 'light') root.dataset.theme = 'light';
    else delete root.dataset.theme;
    storage.theme.set(theme);
  }, [theme]);

  useEffect(() => {
    const root = document.documentElement;
    if (accent !== 'amber') root.dataset.accent = accent;
    else delete root.dataset.accent;
    storage.accent.set(accent);
  }, [accent]);

  return { theme, setTheme, accent, setAccent };
}
