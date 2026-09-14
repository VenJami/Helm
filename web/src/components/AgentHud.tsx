// The floating agent HUD: every claude pane across every project, in one small
// always-on-top strip you can park beside VS Code. Rendered into the Document
// Picture-in-Picture window by App (see the createPortal at the bottom of
// App.tsx), so it lives in the SAME React tree as the grid — which is why it
// can call App's own focusPane/jump handlers directly instead of inventing a
// message channel back to the main window.
//
// It also ARMS Approve/Deny. While this component is mounted it heartbeats the
// server; without a live heartbeat every permission request is answered the
// instant it arrives and panes prompt exactly as they always did. So the whole
// approval feature is scoped to "the HUD is open", which is the point: nobody
// pays for it when it's closed.
//
// Shape: ONE dense line per agent (dot · name · branch · account · elapsed),
// because this sits on top of everything you do all day and every extra pixel
// is one you took from the editor underneath. A row only grows a second line
// when it actually needs you. Collapsed, it's a single pill — status lights
// plus whoever is waiting — and the window shrinks to match.

import { useCallback, useEffect, useMemo, useState } from 'react';
import { ApiError, api } from '../api';
import { accountLabel, foldMappedDefault } from '../accounts';
import { elapsed } from '../lib/time';
import { storage } from '../lib/storage';
import { dotFor, projectOf, rankOf } from '../lib/paneStatus';
import { paneAccent } from '../lib/categories';
import type { AccountUsage, Category, GitInfo, Profile, SessionInfo, Workspace } from '../types';

const PING_MS = 3000; // must stay under the server's HUD_ARM_MS (8 s)
const USAGE_MS = 60_000;
const USAGE_WINDOW = 'd7'; // matches the Usage modal's default window
// Outer height to request when collapsing. NOT the pill's own height (~28px):
// Chrome/Edge enforce a minimum size on a picture-in-picture window and REJECT
// a resize below it outright rather than clamping to it, so asking for 52 does
// nothing at all while asking for 200 works. Measured against the real browser.
const COLLAPSED_WINDOW_H = 200;

interface Props {
  sessions: SessionInfo[];
  workspaces: Workspace[];
  git: Record<string, GitInfo>;
  profiles: Profile[];
  defaultEmail: string | null;
  defaultMapped: string | null;
  /** Jump the MAIN window to this pane (select workspace, un-minimize, pulse). */
  onJumpToPane: (s: SessionInfo) => void;
  /** Re-poll sessions now, so an answered row clears without waiting 3 s. */
  onChanged: () => void;
  onClose: () => void;
  /**
   * Draw the header (agent count, local spend, collapse, close)? The NOTCH
   * turns it off: it is a strip at the top of the screen, the whole of it is
   * the thing you are meant to read, and a title bar of its own is the kind of
   * chrome a notch exists to avoid. It has no need of the collapse button
   * either — it compacts itself on hover — and it closes on right-click.
   */
  chrome?: boolean;
  /**
   * Show each agent's TASK - the auto-title Helm derives from that pane's first
   * real prompt. "Beacon - storefront" tells you where an agent is; the task
   * line tells you what it is doing, which is the question you actually have.
   * Off for the compact HUD, which the owner deliberately tuned to one dense
   * line per agent; on for the notch, where it is the point.
   */
  showTask?: boolean;
  /**
   * How many panes the caller filtered out. Reported rather than silently
   * dropped: a list that quietly omits things is worse than a longer one.
   */
  quietCount?: number;
  /** Pane folders, so a filed pane shows its category's color here too rather
   *  than its own stale one. Defaults to none. */
  categories?: Category[];
}

// 1.2M / 43k / 900 — the reference's compact token readout.
function compact(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1000) return `${Math.round(n / 1000)}k`;
  return String(n);
}

export function AgentHud({
  sessions,
  workspaces,
  git,
  profiles,
  defaultEmail,
  defaultMapped,
  onJumpToPane,
  onChanged,
  onClose,
  chrome = true,
  showTask = false,
  quietCount = 0,
  categories = [],
}: Props) {
  const [usage, setUsage] = useState<AccountUsage[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null); // request id being answered
  const [collapsed, setCollapsed] = useState(() => storage.hudCollapsed.get());
  // Outcome of the last answer, per pane. Shown IN the row rather than as a
  // toast: the Toaster lives in the main window, and the whole point of the
  // HUD is that you're looking somewhere else.
  const [result, setResult] = useState<Record<string, string>>({});

  // Heartbeat — the thing that arms Approve/Deny. Fires immediately on mount
  // so the first permission request after opening the HUD is already covered.
  useEffect(() => {
    const ping = () => void api.hudPing().catch(() => {});
    ping();
    const t = setInterval(ping, PING_MS);
    return () => clearInterval(t);
  }, []);

  // Local cost, honestly labelled. Helm has no access to Anthropic's plan
  // percentages (a live API call; "local only, $0" is a project decision), so
  // the HUD shows what Helm actually knows: its own 7-day totals.
  useEffect(() => {
    const load = () =>
      api
        .getGlobalUsage()
        .then(setUsage)
        .catch(() => {});
    load();
    const t = setInterval(load, USAGE_MS);
    return () => clearInterval(t);
  }, []);

  // "working 7m" has to keep counting even though activitySince never changes
  // and the poll hands back the same object — same trick TerminalPane uses.
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 20_000);
    return () => clearInterval(t);
  }, []);

  const panes = useMemo(
    () =>
      sessions
        .filter((s) => s.kind !== 'dev')
        .slice()
        .sort((a, b) => rankOf(a) - rankOf(b) || a.createdAt.localeCompare(b.createdAt)),
    [sessions],
  );
  const waiting = panes.filter((p) => p.status === 'running' && p.activity === 'waiting');
  const asking = panes.find((p) => p.pendingId);

  // dir → workspace, so a row can show its project's branch without the HUD
  // needing its own git poll.
  const wsByDir = useMemo(() => {
    const m = new Map<string, Workspace>();
    for (const w of workspaces) m.set(w.dir, w);
    return m;
  }, [workspaces]);
  const branchOf = (s: SessionInfo) => {
    const ws = wsByDir.get(s.workspace);
    return ws ? (git[ws.id]?.branch ?? null) : null;
  };
  const accountOf = (s: SessionInfo) =>
    accountLabel(s.profile ?? '', s.profile ? null : defaultEmail, profiles);

  const spend = useMemo(() => {
    if (!usage) return null;
    const rows = foldMappedDefault(usage, defaultMapped);
    let cost = 0;
    let tokens = 0;
    for (const r of rows) {
      const w = r.windows[USAGE_WINDOW];
      if (!w) continue;
      cost += w.cost;
      tokens += w.input + w.output + w.cacheRead + w.cacheWrite;
    }
    return { cost, tokens };
  }, [usage, defaultMapped]);

  // Shrink the OS window to match the pill, so collapsing actually gives the
  // screen back instead of leaving a mostly-empty window on top of your editor.
  // resizeTo is best-effort here: the browser owns this window and may refuse.
  const setCollapsedAndResize = useCallback((next: boolean) => {
    setCollapsed(next);
    storage.hudCollapsed.set(next);
    try {
      if (next) {
        // Remember the size we're leaving, under its own key — see storage.ts.
        storage.hudExpanded.set({ w: window.innerWidth, h: window.innerHeight });
        window.resizeTo(window.outerWidth, COLLAPSED_WINDOW_H);
      } else {
        const { w, h } = storage.hudExpanded.get();
        window.resizeTo(w, h);
      }
    } catch {
      /* the window said no — the content is still correct, just not resized */
    }
  }, []);

  // Reopening while collapsed: the window comes back at whatever size it was
  // last closed at, which could be the full list's worth of height.
  useEffect(() => {
    if (!collapsed) return;
    try {
      window.resizeTo(window.outerWidth, COLLAPSED_WINDOW_H);
    } catch {
      /* best effort */
    }
    // Mount only: later collapses are handled by setCollapsedAndResize.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const answer = useCallback(
    async (s: SessionInfo, decision: 'allow' | 'deny') => {
      if (!s.pendingId) return;
      setBusy(s.pendingId);
      const say = (msg: string) => {
        setResult((r) => ({ ...r, [s.id]: msg }));
        setTimeout(() => setResult((r) => ({ ...r, [s.id]: '' })), 6000);
      };
      try {
        await api.approve(s.id, s.pendingId, decision);
        say(decision === 'allow' ? 'approved' : 'denied');
      } catch (err) {
        // 409 isn't a failure: the request already lapsed back into the pane's
        // own prompt (or the pane died). Say what happened, don't cry wolf.
        if (err instanceof ApiError && err.status === 409) {
          say('it is asking in the pane now — answer it there');
        } else {
          say(err instanceof Error ? err.message : 'could not answer');
        }
      } finally {
        setBusy(null);
        onChanged();
      }
    },
    [onChanged],
  );

  const row = (s: SessionInfo) => {
    const live = s.status === 'running';
    const since =
      live && (s.activity === 'working' || s.activity === 'waiting') && s.activitySince
        ? elapsed(s.activitySince).trim()
        : '';
    const branch = branchOf(s);
    const note = s.pendingDetail || (s.activity === 'waiting' ? s.activityNote : null);
    return (
      <div
        key={s.id}
        className={`hud-row${s.pendingId ? ' hud-row-asking' : ''}`}
        onClick={() => onJumpToPane(s)}
        title={`${s.name} · ${projectOf(s.workspace)} — click to jump to this pane`}
      >
        <div className="hud-line">
          <span className={`dot ${dotFor(s)}`} />
          <span className="hud-name" style={{ color: paneAccent(s, categories) }}>
            {s.name}
          </span>
          <span className="hud-chip hud-chip-project">{projectOf(s.workspace)}</span>
          {branch && <span className="hud-chip hud-chip-branch">⑂ {branch}</span>}
          <span className="hud-chip hud-chip-acct">{accountOf(s)}</span>
          <span className="hud-since">{live ? since : s.status}</span>
        </div>
        {/* What this agent is working on, when we know and the caller wants it. */}
        {showTask && s.summary && <div className="hud-task">{s.summary}</div>}
        {/* A row only earns extra height when it actually needs you. */}
        {s.pendingId && note && <div className="hud-ask">{note}</div>}
        {result[s.id] && <div className="hud-result">{result[s.id]}</div>}
        {s.pendingId && (
          // Stop propagation: the row is a jump target, and clicking Approve
          // must not also yank the main window to this pane.
          <div className="hud-actions" onClick={(e) => e.stopPropagation()}>
            <button
              className="hud-btn hud-deny"
              disabled={busy === s.pendingId}
              onClick={() => void answer(s, 'deny')}
            >
              Deny
            </button>
            <button
              className="hud-btn hud-approve"
              disabled={busy === s.pendingId}
              onClick={() => void answer(s, 'allow')}
            >
              Approve
            </button>
          </div>
        )}
        {!s.pendingId && note && <div className="hud-note">{note}</div>}
      </div>
    );
  };

  // ---- collapsed: lights, plus only what needs you ------------------------
  // The window can't go below the browser's PiP floor (~200px), so a bare pill
  // would leave dead space. Spend it on the rows that actually want an answer.
  if (collapsed) {
    const headline = asking ?? waiting[0] ?? panes.find((p) => p.activity === 'working');
    return (
      <div className="hud">
        <div className="hud-pill">
          <button
            className="hud-pill-body"
            onClick={() => setCollapsedAndResize(false)}
            title="Show every agent"
          >
            <span className="hud-lights">
              {panes.slice(0, 12).map((p) => (
                <span key={p.id} className={`dot ${dotFor(p)}`} />
              ))}
            </span>
            {headline ? (
              <span className="hud-pill-name" style={{ color: paneAccent(headline, categories) }}>
                {headline.name}
              </span>
            ) : (
              <span className="hud-pill-name hud-pill-quiet">
                {panes.length ? 'all quiet' : 'no agents'}
              </span>
            )}
          </button>
          <button
            className="hud-ibtn"
            onClick={onClose}
            title="Close the HUD"
            aria-label="Close the HUD"
          >
            ×
          </button>
        </div>
        {waiting.length > 0 && <div className="hud-rows">{waiting.map(row)}</div>}
      </div>
    );
  }

  // ---- expanded -----------------------------------------------------------
  return (
    <div className="hud">
      {chrome && (
        <div className="hud-head">
          <span className="hud-title">
            {panes.length} agent{panes.length === 1 ? '' : 's'}
          </span>
          {waiting.length > 0 && <span className="hud-chip hud-chip-alert">{waiting.length}</span>}
          <span className="hud-head-right">
            {spend && (
              <span
                className="hud-spend"
                title={`Helm's own estimate from transcripts on disk over the last 7 days — not an Anthropic plan limit ($${spend.cost.toFixed(2)})`}
              >
                {compact(spend.tokens)} · ${spend.cost.toFixed(2)}
              </span>
            )}
            <button
              className="hud-ibtn"
              onClick={() => setCollapsedAndResize(true)}
              title="Collapse to a pill"
              aria-label="Collapse the HUD"
            >
              ▾
            </button>
            <button
              className="hud-ibtn"
              onClick={onClose}
              title="Close the HUD"
              aria-label="Close the HUD"
            >
              ×
            </button>
          </span>
        </div>
      )}

      <div className="hud-rows">
        {panes.length === 0 && quietCount === 0 && (
          <div className="hud-empty">No claude panes yet.</div>
        )}
        {panes.map(row)}
        {quietCount > 0 && (
          <div className="hud-quiet" title="Idle or exited — open Helm to use them">
            +{quietCount} idle
          </div>
        )}
      </div>
    </div>
  );
}
