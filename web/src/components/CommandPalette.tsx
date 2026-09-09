import { useEffect, useMemo, useRef, useState } from 'react';
import type { SessionInfo, Workspace } from '../types';
import {
  IconBell,
  IconBug,
  IconChart,
  IconChevronDown,
  IconChevronUp,
  IconFolder,
  IconMaximize,
  IconMegaphone,
  IconMinus,
  IconPalette,
  IconPlus,
  IconPopOut,
  IconServer,
  IconTerminal,
} from './Icons';
import { IconSearch } from './AnimatedIcons';

// Ctrl+K: jump to any pane across every workspace, hop to a workspace, or run
// a command. Prop-driven — App owns every action's wiring and passes them in,
// so this stays presentational and the action list is one array to read.
//
// Commands live here rather than behind their own key chords on purpose: one
// shortcut to remember, everything findable by name, and the rows carry the
// chord for anything that HAS one — which is also the only place those chords
// are discoverable in the app.

export type PaletteIcon =
  | 'plus'
  | 'broadcast'
  | 'chart'
  | 'folder'
  | 'palette'
  | 'bell'
  | 'bug'
  | 'terminal'
  | 'server'
  | 'maximize'
  | 'minimize'
  | 'popout'
  | 'up'
  | 'down';

export interface PaletteAction {
  key: string;
  label: string;
  icon: PaletteIcon;
  /** Extra search terms — "dark", "light" and "accent" should all find Appearance. */
  keywords?: string;
  /** Existing key chord, shown on the row. Purely informational. */
  hint?: string;
  run: () => void;
}

type PaletteItem =
  | { kind: 'pane'; key: string; session: SessionInfo; ws: string }
  | { kind: 'workspace'; key: string; id: string; name: string; dir: string }
  | ({ kind: 'action' } & PaletteAction);

interface Props {
  onClose: () => void;
  sessions: SessionInfo[];
  workspaces: Workspace[];
  onJumpToPane: (s: SessionInfo) => void;
  onSelectWorkspace: (id: string) => void;
  actions: PaletteAction[];
}

const paneDot = (s: SessionInfo) =>
  s.status !== 'running'
    ? 'dot-dead'
    : { working: 'dot-working', waiting: 'dot-waiting', idle: 'dot-live' }[s.activity ?? 'idle'];

const paneStatus = (s: SessionInfo) => (s.status === 'running' ? (s.activity ?? 'live') : s.status);

export function CommandPalette({
  onClose,
  sessions,
  workspaces,
  onJumpToPane,
  onSelectWorkspace,
  actions,
}: Props) {
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  const wsName = useMemo(() => {
    const byDir = new Map(workspaces.map((w) => [w.dir, w.name]));
    return (dir: string) => byDir.get(dir) ?? dir.split(/[\\/]/).filter(Boolean).pop() ?? dir;
  }, [workspaces]);

  const items = useMemo<PaletteItem[]>(() => {
    const q = query.trim().toLowerCase();
    const paneItems: PaletteItem[] = sessions
      .map((s) => ({
        kind: 'pane' as const,
        key: `pane-${s.id}`,
        session: s,
        ws: wsName(s.workspace),
      }))
      .filter(
        (it) =>
          !q ||
          it.session.name.toLowerCase().includes(q) ||
          it.ws.toLowerCase().includes(q) ||
          (it.session.summary?.toLowerCase().includes(q) ?? false),
      );

    const wsItems: PaletteItem[] = workspaces
      .map((w) => ({
        kind: 'workspace' as const,
        key: `ws-${w.id}`,
        id: w.id,
        name: w.name,
        dir: w.dir,
      }))
      .filter((it) => !q || it.name.toLowerCase().includes(q) || it.dir.toLowerCase().includes(q));

    const actionItems: PaletteItem[] = actions
      .map((a) => ({ kind: 'action' as const, ...a }))
      .filter(
        (it) =>
          !q ||
          it.label.toLowerCase().includes(q) ||
          (it.keywords?.toLowerCase().includes(q) ?? false),
      );

    // With no query this is a switcher, so panes lead. The moment you type
    // something that names a command, you almost certainly want the command —
    // not the pane whose project happens to share a letter with it.
    return q && actionItems.length
      ? [...actionItems, ...paneItems, ...wsItems]
      : [...paneItems, ...wsItems, ...actionItems];
  }, [query, sessions, workspaces, wsName, actions]);

  // Reset the highlight whenever the result set changes shape.
  useEffect(() => {
    setActive(0);
  }, [query]);

  // Keep the highlighted row visible as arrow keys move through a long list.
  useEffect(() => {
    listRef.current
      ?.querySelector<HTMLElement>('.cmdk-item.active')
      ?.scrollIntoView({ block: 'nearest' });
  }, [active, items.length]);

  const activate = (it: PaletteItem) => {
    if (it.kind === 'pane') onJumpToPane(it.session);
    else if (it.kind === 'workspace') onSelectWorkspace(it.id);
    else it.run();
    onClose();
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
      return;
    }
    if (!items.length) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((a) => (a + 1) % items.length);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((a) => (a - 1 + items.length) % items.length);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      activate(items[Math.min(active, items.length - 1)]);
    }
  };

  // Section boundaries for labelled headers, without breaking the flat index.
  const firstOf = (kind: PaletteItem['kind']) => items.findIndex((it) => it.kind === kind);
  const firstPane = firstOf('pane');
  const firstWs = firstOf('workspace');
  const firstAction = firstOf('action');

  return (
    <div
      className="cmdk-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="cmdk-card" onKeyDown={onKeyDown}>
        <div className="cmdk-search">
          <IconSearch size={15} />
          <input
            className="cmdk-input"
            placeholder="Run a command, or jump to a pane or workspace…"
            value={query}
            autoFocus
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
        <div className="cmdk-list" ref={listRef}>
          {items.length === 0 && <div className="cmdk-empty">No matches</div>}
          {items.map((it, i) => (
            <div key={it.key}>
              {i === firstPane && <div className="cmdk-section">Panes</div>}
              {i === firstWs && <div className="cmdk-section">Workspaces</div>}
              {i === firstAction && <div className="cmdk-section">Actions</div>}
              <button
                className={`cmdk-item ${i === active ? 'active' : ''}`}
                onMouseMove={() => setActive(i)}
                onClick={() => activate(it)}
              >
                {it.kind === 'pane' && (
                  <>
                    <span className={`dot ${paneDot(it.session)}`} />
                    <span className="cmdk-name" style={{ color: it.session.color }}>
                      {it.session.name}
                    </span>
                    <span className="cmdk-summary">
                      {it.session.summary ?? <em>no prompt yet</em>}
                    </span>
                    <span className="cmdk-where">{it.ws}</span>
                    <span className="cmdk-status">{paneStatus(it.session)}</span>
                  </>
                )}
                {it.kind === 'workspace' && (
                  <>
                    <span className="cmdk-glyph">
                      <IconFolder size={13} />
                    </span>
                    <span className="cmdk-name">{it.name}</span>
                    <span className="cmdk-where" title={it.dir}>
                      {it.dir}
                    </span>
                  </>
                )}
                {it.kind === 'action' && (
                  <>
                    <span className="cmdk-glyph">
                      {it.icon === 'plus' && <IconPlus size={13} />}
                      {it.icon === 'broadcast' && <IconMegaphone size={13} />}
                      {it.icon === 'chart' && <IconChart size={13} />}
                      {it.icon === 'folder' && <IconFolder size={13} />}
                      {it.icon === 'palette' && <IconPalette size={13} />}
                      {it.icon === 'bell' && <IconBell size={13} />}
                      {it.icon === 'bug' && <IconBug size={13} />}
                      {it.icon === 'terminal' && <IconTerminal size={13} />}
                      {it.icon === 'server' && <IconServer size={13} />}
                      {it.icon === 'maximize' && <IconMaximize size={13} />}
                      {it.icon === 'minimize' && <IconMinus size={13} />}
                      {it.icon === 'popout' && <IconPopOut size={13} />}
                      {it.icon === 'up' && <IconChevronUp size={13} />}
                      {it.icon === 'down' && <IconChevronDown size={13} />}
                    </span>
                    <span className="cmdk-name">{it.label}</span>
                    {it.hint && <span className="cmdk-hint">{it.hint}</span>}
                  </>
                )}
              </button>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
