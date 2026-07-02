import { useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebglAddon } from '@xterm/addon-webgl';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { SearchAddon } from '@xterm/addon-search';
import '@xterm/xterm/css/xterm.css';
import { api, wsUrl } from '../api';
import { Modal } from './Modal';
import {
  IconChart, IconChevronDown, IconChevronUp, IconGrip, IconMaximize, IconMinimize, IconPaperclip,
  IconSearch, IconX,
} from './Icons';
import type { SessionInfo, UsageInfo } from '../types';

type Conn = 'connecting' | 'live' | 'disconnected' | 'exited' | 'dead';

interface Props {
  session: SessionInfo;
  onKilled: (id: string) => void;
  onChanged: () => void; // parent re-fetches sessions (e.g. after revive)
  isMaximized: boolean;
  onToggleMax: () => void;
  onGripDragStart: () => void; // drag-to-reorder, handled by the grid
  onGripDragEnd: () => void;
}

const fmt = (n: number) =>
  n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(1) + 'k' : String(n);

const shortModel = (m: string) => m.replace(/^claude-/, '');

// " 7m" / " 1h05m" since the given ISO time; '' under a minute. Refreshes with
// the 3 s session poll — minute granularity is all the badge needs.
const elapsed = (iso: string) => {
  const m = Math.floor((Date.now() - Date.parse(iso)) / 60000);
  if (m < 1) return '';
  return m < 60 ? ` ${m}m` : ` ${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}m`;
};

// Keep in sync with PANE_COLORS in server/index.mjs
const PANE_COLORS = [
  '#4fc3f7', '#81c784', '#ffb74d', '#f06292', '#ba68c8',
  '#ffd54f', '#4dd0e1', '#ff8a65', '#90a4ae', '#aed581',
];

export function TerminalPane({
  session, onKilled, onChanged, isMaximized, onToggleMax, onGripDragStart, onGripDragEnd,
}: Props) {
  const holderRef = useRef<HTMLDivElement>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const [conn, setConn] = useState<Conn>(session.status === 'dead' ? 'dead' : 'connecting');
  const [exitCode, setExitCode] = useState<number | null>(null);
  const [reviving, setReviving] = useState(false);
  const [usage, setUsage] = useState<UsageInfo | null>(null);
  const [usageOpen, setUsageOpen] = useState(false);
  const [editName, setEditName] = useState<string | null>(null); // null = not editing
  const [colorOpen, setColorOpen] = useState(false);
  const [reviveError, setReviveError] = useState('');
  const [confirmKill, setConfirmKill] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchText, setSearchText] = useState('');
  const [dropActive, setDropActive] = useState(false); // file dragged over the pane
  const fileInputRef = useRef<HTMLInputElement>(null);
  const searchRef = useRef<SearchAddon | null>(null);
  // Latest onToggleMax for the key handler (registered once per terminal life)
  const onToggleMaxRef = useRef(onToggleMax);
  onToggleMaxRef.current = onToggleMax;
  // Bumping this re-runs the connect effect (manual reconnect after a drop).
  const [connectNonce, setConnectNonce] = useState(0);

  // Upload files to the server, which saves them locally and types each file's
  // path into this pane — the same mechanism as dropping a file on a native
  // terminal. Only uses session.id + refs, so the paste listener registered in
  // the terminal-lifetime effect can safely capture one instance.
  const uploadFiles = async (files: ArrayLike<File>) => {
    for (const file of Array.from(files)) {
      try {
        await api.attachFile(session.id, file, file.name || 'paste.png');
      } catch (err) {
        termRef.current?.write(`\r\n\x1b[31m[attach failed: ${(err as Error).message}]\x1b[0m\r\n`);
      }
    }
    termRef.current?.focus(); // keep typing the prompt around the path
  };

  // Terminal lives for the lifetime of the pane; sockets may come and go.
  useEffect(() => {
    const holder = holderRef.current!;
    const term = new Terminal({
      fontFamily: '"Cascadia Mono", Consolas, monospace',
      fontSize: 13,
      cursorBlink: true,
      scrollback: 5000,
      theme: { background: '#0a0a0b' },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    const search = new SearchAddon();
    term.loadAddon(search);
    searchRef.current = search;
    // URLs in pane output (e.g. the OAuth sign-in link) become clickable
    term.loadAddon(new WebLinksAddon((_e, uri) => window.open(uri, '_blank')));
    term.open(holder);
    try {
      const webgl = new WebglAddon();
      webgl.onContextLoss(() => webgl.dispose()); // xterm falls back to DOM renderer
      term.loadAddon(webgl);
    } catch {
      /* WebGL unavailable — DOM renderer is fine */
    }
    fit.fit();

    // Terminal copy semantics: Ctrl+C must stay the interrupt key, so copy is
    // (a) automatic on mouse selection and (b) explicit via Ctrl+Shift+C.
    const copySelection = () => {
      if (term.hasSelection()) {
        navigator.clipboard.writeText(term.getSelection()).catch(() => {});
      }
    };
    const onMouseUp = () => copySelection();
    holder.addEventListener('mouseup', onMouseUp);
    // Pasting an image (screenshot) attaches it; text pastes fall through to
    // xterm untouched. Capture phase so xterm's own paste handler never runs
    // for file pastes.
    const onPaste = (e: ClipboardEvent) => {
      const files = e.clipboardData?.files;
      if (files && files.length > 0) {
        e.preventDefault();
        e.stopPropagation();
        void uploadFiles(files);
      }
    };
    holder.addEventListener('paste', onPaste, true);
    // Pane shortcuts intercepted before the PTY sees them:
    // Ctrl+Shift+C copy · Ctrl+Shift+F find · Ctrl+Shift+M maximize
    term.attachCustomKeyEventHandler((e) => {
      if (e.type !== 'keydown' || !e.ctrlKey || !e.shiftKey) return true;
      if (e.code === 'KeyC') {
        copySelection();
        return false; // handled — don't send to the PTY
      }
      if (e.code === 'KeyF') {
        setSearchOpen(true);
        return false;
      }
      if (e.code === 'KeyM') {
        onToggleMaxRef.current();
        return false;
      }
      return true;
    });
    termRef.current = term;
    fitRef.current = fit;

    const sendResize = () => {
      fit.fit();
      const ws = wsRef.current;
      if (ws?.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
      }
    };
    let raf = 0;
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(sendResize);
    });
    observer.observe(holder);

    const inputSub = term.onData((data) => {
      const ws = wsRef.current;
      if (ws?.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'input', data }));
      }
    });

    return () => {
      observer.disconnect();
      cancelAnimationFrame(raf);
      holder.removeEventListener('mouseup', onMouseUp);
      holder.removeEventListener('paste', onPaste, true);
      inputSub.dispose();
      term.dispose();
      termRef.current = null;
      searchRef.current = null;
    };
  }, [session.id]);

  // Attach a WebSocket; detaching (unmount/drop) never kills the session.
  // Dead sessions have no PTY to attach to — the revive overlay handles them.
  useEffect(() => {
    if (session.status === 'dead') {
      setConn('dead');
      return;
    }
    const term = termRef.current;
    if (!term) return;
    setConn('connecting');
    const ws = new WebSocket(wsUrl(session.id));
    wsRef.current = ws;
    let exited = false;

    ws.onopen = () => setConn('live');
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.type === 'replay') {
        term.reset();
        term.write(msg.data);
        // Sync the PTY to this pane's size after repaint
        const fit = fitRef.current;
        if (fit) {
          fit.fit();
          ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
        }
      } else if (msg.type === 'data') {
        term.write(msg.data);
      } else if (msg.type === 'exit') {
        exited = true;
        setExitCode(msg.code);
        setConn('exited');
        term.write(`\r\n\x1b[31m[process exited with code ${msg.code}]\x1b[0m\r\n`);
      }
    };
    ws.onclose = () => {
      if (!exited) setConn((c) => (c === 'exited' || c === 'dead' ? c : 'disconnected'));
    };

    return () => {
      wsRef.current = null;
      ws.close();
    };
  }, [session.id, session.status, connectNonce]);

  const kill = async () => {
    try {
      await api.killSession(session.id);
    } catch {
      /* already gone */
    }
    onKilled(session.id);
  };

  const revive = async () => {
    setReviving(true);
    setReviveError('');
    try {
      const term = termRef.current;
      await api.reviveSession(session.id, term?.cols ?? 80, term?.rows ?? 24);
      onChanged(); // parent poll flips status to running → connect effect fires
    } catch (err) {
      const msg = (err as Error).message;
      setReviveError(msg); // dead panes show it in the overlay …
      // … exited panes have no overlay, so surface it in the terminal itself
      termRef.current?.write(`\r\n\x1b[31m[revive failed: ${msg}]\x1b[0m\r\n`);
    } finally {
      setReviving(false);
    }
  };

  const toggleUsage = async () => {
    if (usageOpen) {
      setUsageOpen(false);
      return;
    }
    setUsageOpen(true);
    try {
      setUsage(await api.getUsage(session.id));
    } catch {
      setUsage({ available: false });
    }
  };

  const saveName = async () => {
    const name = editName?.trim();
    setEditName(null);
    if (!name || name === session.name) return;
    try {
      await api.updateSession(session.id, { name });
      onChanged();
    } catch {
      /* validation error — keep old name */
    }
  };

  const saveColor = async (color: string) => {
    setColorOpen(false);
    try {
      await api.updateSession(session.id, { color });
      onChanged();
    } catch {
      /* ignore */
    }
  };

  const closeSearch = () => {
    setSearchOpen(false);
    setSearchText('');
    termRef.current?.focus();
  };

  const activity = conn === 'live' ? session.activity : null;
  const dotClass =
    conn === 'live'
      ? { working: 'dot-working', waiting: 'dot-waiting', idle: 'dot-live' }[activity ?? 'idle']
      : conn === 'exited' || conn === 'dead'
        ? 'dot-dead'
        : 'dot-idle';
  // "working 7m" / "waiting 12m" — how long a pane has been busy or blocked
  const since =
    (activity === 'working' || activity === 'waiting') && session.activitySince
      ? elapsed(session.activitySince)
      : '';
  const label = {
    connecting: 'connecting…',
    live: `${activity ?? 'live'}${since}${session.profile ? ` · ${session.profile}` : ''}`,
    disconnected: 'disconnected',
    exited: `exited (${exitCode ?? session.exitCode})`,
    dead: 'dead — server restarted',
  }[conn];

  return (
    <div className="pane" style={{ borderTopColor: session.color }}>
      <div className="pane-header">
        {!isMaximized && (
          <span
            className="pane-grip"
            draggable
            title="Drag onto another pane to reorder"
            onDragStart={(e) => {
              e.dataTransfer.effectAllowed = 'move';
              e.dataTransfer.setData('text/plain', session.id);
              onGripDragStart();
            }}
            onDragEnd={onGripDragEnd}
          >
            <IconGrip size={13} />
          </span>
        )}
        <span className={`dot ${dotClass}`} />
        <button
          className="pane-swatch"
          style={{ background: session.color }}
          title="Change pane color"
          onClick={() => setColorOpen((o) => !o)}
        />
        {editName !== null ? (
          <input
            className="pane-name-input"
            value={editName}
            autoFocus
            maxLength={32}
            onChange={(e) => setEditName(e.target.value)}
            onBlur={saveName}
            onKeyDown={(e) => {
              if (e.key === 'Enter') saveName();
              if (e.key === 'Escape') setEditName(null);
            }}
          />
        ) : (
          <span
            className="pane-name"
            style={{ color: session.color }}
            title="Click to rename"
            onClick={() => setEditName(session.name)}
          >
            {session.name}
          </span>
        )}
        <span className="pane-title" title={session.workspace}>
          {label}
        </span>
        <button
          className="ibtn"
          disabled={conn !== 'live'}
          onClick={() => fileInputRef.current?.click()}
          title="Attach a file — or paste/drop one onto the pane"
        >
          <IconPaperclip size={14} />
        </button>
        <button
          className="ibtn"
          onClick={() => (searchOpen ? closeSearch() : setSearchOpen(true))}
          title="Find in scrollback (Ctrl+Shift+F)"
        >
          <IconSearch size={14} />
        </button>
        {session.hasTranscript && (
          <button className="ibtn" onClick={toggleUsage} title="Token usage by model">
            <IconChart size={14} />
          </button>
        )}
        <button
          className="ibtn"
          onClick={onToggleMax}
          title={isMaximized ? 'Back to grid (Esc)' : 'Maximize this pane (Ctrl+Shift+M)'}
        >
          {isMaximized ? <IconMinimize size={14} /> : <IconMaximize size={14} />}
        </button>
        {conn === 'disconnected' && (
          <button className="btn btn-small" onClick={() => setConnectNonce((n) => n + 1)}>
            Reconnect
          </button>
        )}
        {conn === 'exited' && (
          <button
            className="btn btn-small"
            onClick={revive}
            disabled={reviving}
            title={session.canResume
              ? 'Start claude again and resume this conversation'
              : 'Start a fresh claude in this folder'}
          >
            {reviving ? 'Reviving…' : session.canResume ? 'Resume' : 'Restart'}
          </button>
        )}
        <button
          className="btn btn-small btn-danger"
          onClick={() => {
            // Mid-task kills are the misclick that hurts — confirm those only
            if (conn === 'live' && session.activity === 'working') setConfirmKill(true);
            else void kill();
          }}
          title="Kill this session"
        >
          {conn === 'exited' || conn === 'dead' ? 'Close' : 'Kill'}
        </button>
      </div>
      <div
        className="pane-body"
        // Files dragged from the OS attach to this pane; the grip's
        // reorder drag carries text/plain only, so it passes through here.
        onDragOver={(e) => {
          if (!e.dataTransfer.types.includes('Files')) return;
          e.preventDefault();
          e.dataTransfer.dropEffect = 'copy';
          setDropActive(true);
        }}
        onDragLeave={(e) => {
          if (e.currentTarget.contains(e.relatedTarget as Node)) return; // still inside
          setDropActive(false);
        }}
        onDrop={(e) => {
          setDropActive(false);
          if (!e.dataTransfer.files.length) return;
          e.preventDefault();
          e.stopPropagation(); // a file drop is not a pane-reorder drop
          void uploadFiles(e.dataTransfer.files);
        }}
      >
        <div className="pane-term" ref={holderRef} />
        {dropActive && <div className="drop-overlay">Drop to attach</div>}
        {searchOpen && (
          <div className="search-bar">
            <input
              placeholder="find in scrollback"
              value={searchText}
              autoFocus
              onChange={(e) => {
                setSearchText(e.target.value);
                searchRef.current?.findNext(e.target.value, { incremental: true });
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && e.shiftKey) searchRef.current?.findPrevious(searchText);
                else if (e.key === 'Enter') searchRef.current?.findNext(searchText);
                else if (e.key === 'Escape') {
                  e.stopPropagation(); // Esc here closes search, not maximize
                  closeSearch();
                }
              }}
            />
            <button
              className="ibtn"
              title="Previous match (Shift+Enter)"
              onClick={() => searchRef.current?.findPrevious(searchText)}
            >
              <IconChevronUp size={14} />
            </button>
            <button
              className="ibtn"
              title="Next match (Enter)"
              onClick={() => searchRef.current?.findNext(searchText)}
            >
              <IconChevronDown size={14} />
            </button>
            <button className="ibtn" title="Close (Esc)" onClick={closeSearch}>
              <IconX size={14} />
            </button>
          </div>
        )}
        {colorOpen && (
          <div className="color-panel">
            {PANE_COLORS.map((c) => (
              <button
                key={c}
                className={`color-swatch ${c === session.color ? 'active' : ''}`}
                style={{ background: c }}
                onClick={() => saveColor(c)}
              />
            ))}
          </div>
        )}
        {usageOpen && (
          <div className="usage-panel">
            {!usage ? (
              <div className="usage-empty">loading…</div>
            ) : !usage.available || !Object.keys(usage.models ?? {}).length ? (
              <div className="usage-empty">no usage recorded yet</div>
            ) : (
              <table>
                <thead>
                  <tr><th>model</th><th>in</th><th>out</th><th>cache⇢</th><th>turns</th></tr>
                </thead>
                <tbody>
                  {Object.entries(usage.models!).map(([model, m]) => (
                    <tr key={model}>
                      <td title={model}>{shortModel(model)}</td>
                      <td>{fmt(m.input + m.cacheWrite)}</td>
                      <td>{fmt(m.output)}</td>
                      <td>{fmt(m.cacheRead)}</td>
                      <td>{m.turns}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        )}
        {conn === 'dead' && (
          <div className="pane-overlay">
            <p>
              This pane's process died with a server restart.
              {session.canResume
                ? ' Its conversation was saved and can be resumed.'
                : ' No conversation id was captured — revive starts fresh in the same folder.'}
            </p>
            <button className="btn" onClick={revive} disabled={reviving}>
              {reviving ? 'reviving…' : session.canResume ? 'Revive (resume conversation)' : 'Restart (fresh session)'}
            </button>
            {reviveError && <div className="form-error">revive failed: {reviveError}</div>}
          </div>
        )}
      </div>
      <input
        ref={fileInputRef}
        type="file"
        multiple
        style={{ display: 'none' }}
        onChange={(e) => {
          if (e.target.files?.length) void uploadFiles(e.target.files);
          e.target.value = ''; // allow re-picking the same file later
        }}
      />
      {confirmKill && (
        <Modal title={`Kill "${session.name}" mid-task?`} onClose={() => setConfirmKill(false)}>
          <p className="modal-desc">
            This pane is still working
            {session.activitySince && elapsed(session.activitySince)
              ? ` (${elapsed(session.activitySince).trim()} in)`
              : ''}
            {' '}— killing stops the Claude process immediately and removes the pane.
          </p>
          <div className="modal-actions">
            <button className="btn btn-ghost" onClick={() => setConfirmKill(false)}>Cancel</button>
            <button
              className="btn btn-danger"
              onClick={() => {
                setConfirmKill(false);
                void kill();
              }}
            >
              Kill pane
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}
