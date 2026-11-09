import { useEffect, useState } from 'react';
import { api } from '../../api';
import { Modal } from '../Modal';
import { ACCENTS, type Accent, type Theme } from '../../lib/storage';
import type { DiscordStatus } from '../../types';

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

/** One line on where the Discord card stands. Discord being closed is normal, not a fault. */
function discordLine(status: DiscordStatus | null) {
  if (!status || status.connecting) return 'Connecting to Discord…';
  if (status.error) {
    return status.connected
      ? `Connected, but Discord refused the card: ${status.error}`
      : `Not connected: ${status.error}`;
  }
  if (status.connected) return status.user ? `Connected as ${status.user}.` : 'Connected.';
  return "The Discord desktop app isn't running. Helm will connect when it opens.";
}

export function AppearanceModal({
  theme,
  accent,
  onTheme,
  onAccent,
  notchFollowsHelm,
  onNotchFollowsHelm,
  notchAutoCompact,
  onNotchAutoCompact,
  discordPresence,
  onDiscordPresence,
  sharedProjects,
  onClose,
}: {
  theme: Theme;
  accent: Accent;
  onTheme: (t: Theme) => void;
  onAccent: (a: Accent) => void;
  notchFollowsHelm: boolean;
  onNotchFollowsHelm: (on: boolean) => void;
  notchAutoCompact: boolean;
  onNotchAutoCompact: (on: boolean) => void;
  discordPresence: boolean;
  onDiscordPresence: (on: boolean) => void;
  sharedProjects: string[]; // the projects whose names are public on the card
  onClose: () => void;
}) {
  // Only while this dialog is open and the card is on; nothing else needs to know.
  const [discordStatus, setDiscordStatus] = useState<DiscordStatus | null>(null);
  useEffect(() => {
    if (!discordPresence) return;
    let live = true;
    const poll = () =>
      api
        .getDiscord()
        .then((s) => {
          if (live) setDiscordStatus(s);
        })
        .catch(() => {});
    void poll();
    const timer = window.setInterval(() => void poll(), 1000);
    return () => {
      live = false;
      window.clearInterval(timer);
      setDiscordStatus(null);
    };
  }, [discordPresence]);

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
      <label className="field-label">Notch</label>
      <div className="chip-row">
        {(
          [
            [true, 'Hide while Helm is open'],
            [false, 'Always on screen'],
          ] as const
        ).map(([on, label]) => (
          <button
            key={String(on)}
            className={`chip ${notchFollowsHelm === on ? 'selected' : ''}`}
            onClick={() => onNotchFollowsHelm(on)}
          >
            {label}
          </button>
        ))}
      </div>
      <p className="modal-desc">
        The floating notch (desktop/start-notch.cmd) is for when Helm is not in front of you, so by
        default it gets out of the way while this window is up and comes back when you minimise or
        close it.
      </p>
      <div className="chip-row">
        {(
          [
            [true, 'Compact until hovered'],
            [false, 'Always expanded'],
          ] as const
        ).map(([on, label]) => (
          <button
            key={String(on)}
            className={`chip ${notchAutoCompact === on ? 'selected' : ''}`}
            onClick={() => onNotchAutoCompact(on)}
          >
            {label}
          </button>
        ))}
      </div>
      <p className="modal-desc">
        At rest it shrinks to a strip of coloured lights, one per agent, so a glance tells you
        whether anything needs you. Reach it with your cursor and it opens to the full list.
      </p>
      <label className="field-label">Discord</label>
      <div className="chip-row">
        {(
          [
            [false, 'Off'],
            [true, 'Show on my profile'],
          ] as const
        ).map(([on, label]) => (
          <button
            key={String(on)}
            className={`chip ${discordPresence === on ? 'selected' : ''}`}
            onClick={() => onDiscordPresence(on)}
          >
            {label}
          </button>
        ))}
      </div>
      <p className="modal-desc">
        Puts a public card on your Discord profile saying you are in Helm and how many agents are
        working. Prompts, file paths, branches and accounts are never sent.
      </p>
      {discordPresence && (
        <p className="modal-desc">
          <span data-testid="discord-status">{discordLine(discordStatus)}</span>{' '}
          <span data-testid="discord-names">
            {sharedProjects.length
              ? `Names shown: ${sharedProjects.join(', ')}. Right-click a project to change this.`
              : 'No project names are shown. Right-click a project to show its name.'}
          </span>
        </p>
      )}
      <div className="modal-actions">
        <button className="btn" onClick={onClose}>
          Done
        </button>
      </div>
    </Modal>
  );
}
