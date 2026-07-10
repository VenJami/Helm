import { useEffect, useRef, useState } from 'react';
import type { Profile } from '../types';
import { accountLabel } from '../accounts';
import { IconCheck, IconChevronDown, IconPlus, IconUserRound, IconUsersGear } from './Icons';

interface Props {
  profiles: Profile[];
  defaultEmail: string | null;
  mappedDefault?: string | null; // named profile the default collapses onto
  value: string; // '' = default account
  onChange: (name: string) => void;
  onNewProfile: () => void;
  onManageProfiles: () => void;
}

// Themed replacement for the native <select> account picker. Closed it shows
// just the profile name (keeps the toolbar clean); the open menu shows each
// account's email underneath its name.
export function ProfileSelect({
  profiles,
  defaultEmail,
  mappedDefault,
  value,
  onChange,
  onNewProfile,
  onManageProfiles,
}: Props) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  // Close on click-outside or Escape while open
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  // When the default account collapses onto a named profile (same login), drop
  // the separate default row and treat a "default" selection as that profile —
  // no duplicate line for the same account.
  const entries: Profile[] = mappedDefault
    ? profiles
    : [{ name: '', email: defaultEmail }, ...profiles];
  const effectiveValue = value === '' && mappedDefault ? mappedDefault : value;
  const current = entries.find((e) => e.name === effectiveValue) ?? entries[0];
  const label = (e: Profile) => accountLabel(e.name, e.email, profiles);

  const pick = (name: string) => {
    onChange(name);
    setOpen(false);
  };

  return (
    <div className="pselect" ref={rootRef}>
      <button
        className={`pselect-trigger ${open ? 'open' : ''}`}
        onClick={() => setOpen((o) => !o)}
        title={current.email ?? 'not logged in'}
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        <IconUserRound size={13} />
        <span className="pselect-name">{label(current)}</span>
        <IconChevronDown size={12} className="pselect-chevron" />
      </button>
      {open && (
        <div className="pselect-menu" role="listbox">
          {entries.map((e) => (
            <button
              key={e.name || '__default__'}
              className={`pselect-item ${e.name === current.name ? 'selected' : ''}`}
              role="option"
              aria-selected={e.name === current.name}
              onClick={() => pick(e.name)}
            >
              <span className="pselect-item-name">
                <span className="pselect-item-label">
                  {label(e)}
                  {e.name === '' && <span className="pselect-tag">default</span>}
                </span>
                {e.name === current.name && <IconCheck size={13} />}
              </span>
              <span className="pselect-item-email">{e.email ?? 'not logged in'}</span>
            </button>
          ))}
          <div className="pselect-sep" />
          <button
            className="pselect-item pselect-new"
            onClick={() => {
              setOpen(false);
              onNewProfile();
            }}
          >
            <IconPlus size={13} /> New profile…
          </button>
          <button
            className="pselect-item pselect-new"
            onClick={() => {
              setOpen(false);
              onManageProfiles();
            }}
          >
            <IconUsersGear size={13} /> Manage profiles…
          </button>
        </div>
      )}
    </div>
  );
}
