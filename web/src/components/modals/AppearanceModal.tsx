import { Modal } from '../Modal';
import { ACCENTS, type Accent, type Theme } from '../../lib/storage';

// Theme (dark/light) + accent color picker. Selections apply instantly (data
// attributes on <html> — see useTheme) and persist; there's nothing to submit.
// Swatch colors mirror the CSS preset values in styles.css per theme.
const SWATCH: Record<Accent, { dark: string; light: string }> = {
  amber: { dark: '#e2b34c', light: '#9a7418' },
  blue: { dark: '#5eb1ef', light: '#2563eb' },
  green: { dark: '#4cc38a', light: '#178a55' },
  violet: { dark: '#b085e8', light: '#7c3aed' },
  rose: { dark: '#ef6d9b', light: '#db2777' },
};

export function AppearanceModal({
  theme,
  accent,
  onTheme,
  onAccent,
  onClose,
}: {
  theme: Theme;
  accent: Accent;
  onTheme: (t: Theme) => void;
  onAccent: (a: Accent) => void;
  onClose: () => void;
}) {
  return (
    <Modal title="Appearance" onClose={onClose}>
      <label className="field-label">Theme</label>
      <div className="chip-row">
        {(['dark', 'light'] as const).map((t) => (
          <button
            key={t}
            className={`chip ${theme === t ? 'selected' : ''}`}
            onClick={() => onTheme(t)}
          >
            {t === 'dark' ? 'Dark' : 'Light'}
          </button>
        ))}
      </div>
      <label className="field-label">Accent</label>
      <div className="accent-row">
        {ACCENTS.map((a) => (
          <button
            key={a}
            className={`accent-swatch ${accent === a ? 'active' : ''}`}
            style={{ background: SWATCH[a][theme] }}
            title={a}
            onClick={() => onAccent(a)}
          />
        ))}
      </div>
      <p className="modal-desc">
        Terminals stay dark in the light theme — Claude's own output colors assume a dark
        background.
      </p>
      <div className="modal-actions">
        <button className="btn" onClick={onClose}>
          Done
        </button>
      </div>
    </Modal>
  );
}
