import { useEffect, useMemo, useState } from 'react';
import { api } from '../../api';
import { Modal } from '../Modal';
import { accountLabel, foldMappedDefault } from '../../accounts';
import type { AccountUsage } from '../../types';
import type { Profile } from '../../types';

// "Usage by account" — fetches the roll-up on open and owns the window
// selector. Numbers are local token counts + rough $ estimates (the CLI's own
// Session/Weekly limit % is a live Anthropic call, deliberately not made).

const fmt = (n: number) =>
  n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(1) + 'k' : String(n);

// Rough dollar figure — cents matter at the low end, so surface <$0.01 rather
// than a flat $0.00 that reads as "free".
const fmtCost = (n: number) =>
  n <= 0 ? '$0'
    : n < 0.01 ? '<$0.01'
    : n < 100 ? '$' + n.toFixed(2)
    : '$' + Math.round(n).toLocaleString();

// "just now" / "2h ago" / "3d ago" from an epoch-ms timestamp (null = never).
const relTime = (ms: number | null): string => {
  if (!ms) return 'never used';
  const s = Math.max(0, (Date.now() - ms) / 1000);
  if (s < 90) return 'used just now';
  const m = s / 60;
  if (m < 60) return `used ${Math.round(m)}m ago`;
  const h = m / 60;
  if (h < 24) return `used ${Math.round(h)}h ago`;
  const d = h / 24;
  if (d < 7) return `used ${Math.round(d)}d ago`;
  return `used ${Math.round(d / 7)}w ago`;
};

const USAGE_WINDOWS = [
  ['h1', '1 h'],
  ['h5', '5 h'],
  ['h10', '10 h'],
  ['h24', '24 h'],
  ['d7', '7 d'],
  ['d30', '30 d'],
  ['all', 'all'],
] as const;

export function UsageModal({ profiles, defaultMapped, onClose }: {
  profiles: Profile[];
  defaultMapped: string | null;
  onClose: () => void;
}) {
  const [globalUsage, setGlobalUsage] = useState<AccountUsage[] | null>(null);
  // 7d default so recently-used profiles show something on open.
  const [usageWindow, setUsageWindow] = useState('d7');

  useEffect(() => {
    api.getGlobalUsage().then(setGlobalUsage).catch(() => setGlobalUsage([]));
  }, []);

  // When the bare default account is the same login as a named profile, fold
  // default's history into that profile's row and hide the standalone default
  // row — same collapse the profile picker does. Grand total is unchanged.
  const usageRows = useMemo(
    () => (globalUsage ? foldMappedDefault(globalUsage, defaultMapped) : null),
    [globalUsage, defaultMapped],
  );

  return (
    <Modal title="Usage by account" onClose={onClose}>
      <div className="chip-row">
        {USAGE_WINDOWS.map(([key, label]) => (
          <button
            key={key}
            className={`chip ${usageWindow === key ? 'selected' : ''}`}
            onClick={() => setUsageWindow(key)}
          >
            {label}
          </button>
        ))}
      </div>
      {!usageRows ? (
        <p className="modal-desc">crunching transcripts…</p>
      ) : !usageRows.length ? (
        <p className="modal-desc">No usage data found.</p>
      ) : (() => {
        const windowLabel = USAGE_WINDOWS.find(([k]) => k === usageWindow)?.[1] ?? '';
        const phrase = usageWindow === 'all' ? 'all time' : `last ${windowLabel}`;
        const keyName = (a: AccountUsage) => (a.account === 'default' ? 'default' : a.account);
        const total = usageRows.reduce(
          (acc, a) => {
            const w = a.windows[usageWindow];
            if (w) { acc.tokens += w.input + w.output + w.cacheRead + w.cacheWrite; acc.cost += w.cost; }
            return acc;
          },
          { tokens: 0, cost: 0 },
        );
        return (
          <>
            <div className="usage-total">
              <span>All accounts · {phrase}</span>
              <span className="usage-total-nums">
                <b>{fmt(total.tokens)}</b> tokens · {fmtCost(total.cost)} est
              </span>
            </div>
            {usageRows.map((a, i) => {
              const label = accountLabel(a.account === 'default' ? '' : a.account, a.email, profiles);
              const tag = a.account === 'default' ? 'default' : label !== a.account ? a.account : null;
              const dupOf = a.email
                ? usageRows.slice(0, i).find((o) => o.email === a.email)
                : undefined;
              const w = a.windows[usageWindow];
              const all = a.windows.all;
              const allTokens = all ? all.input + all.output + all.cacheRead + all.cacheWrite : 0;
              const winTokens = w ? w.input + w.output + w.cacheRead + w.cacheWrite : 0;
              const models = w ? Object.entries(w.models).sort(([, x], [, y]) => y.output - x.output) : [];
              const maxOut = Math.max(...models.map(([, m]) => m.output), 1);
              return (
                <div key={a.account} className="usage-account">
                  <div className="usage-account-head">
                    <b>{label}</b>
                    {tag && <span className="usage-tag">{tag}</span>}
                    <span className="usage-email">{a.email ?? 'not logged in'}</span>
                  </div>
                  <div className="usage-account-meta">
                    {relTime(a.lastActive)}
                    {allTokens > 0 && <> · {fmt(allTokens)} tokens · {fmtCost(all.cost)} all-time</>}
                    {dupOf && <span className="usage-dup"> · same login as “{keyName(dupOf)}”</span>}
                  </div>
                  {models.length > 0 ? (
                    <>
                      <div className="usage-stats">
                        <span><b>{fmt(winTokens)}</b> tokens</span>
                        <span>{fmt(w.output)} out · {fmt(w.input)} in · {fmt(w.cacheRead + w.cacheWrite)} cache</span>
                        <span>{w.turns} turns</span>
                        <span className="usage-cost">{fmtCost(w.cost)} est</span>
                      </div>
                      <div className="usage-bars">
                        {models.map(([model, m]) => (
                          <div key={model} className="usage-bar-row">
                            <span className="usage-bar-label" title={model}>
                              {model.replace(/^claude-/, '')}
                            </span>
                            <span className="usage-bar-track">
                              <span className="usage-bar-plot">
                                <span
                                  className="usage-bar-fill"
                                  style={{ width: `${Math.max((m.output / maxOut) * 100, 1)}%` }}
                                />
                              </span>
                              <span className="usage-bar-val">{fmt(m.output)}</span>
                            </span>
                            <span className="usage-tip">
                              <b>{model}</b><br />
                              {fmt(m.output)} out · {fmt(m.input)} in ·{' '}
                              {fmt(m.cacheRead)} cache · {m.turns} turns<br />
                              {fmtCost(m.cost ?? 0)} est
                            </span>
                          </div>
                        ))}
                      </div>
                    </>
                  ) : (
                    <div className="usage-empty">
                      {usageWindow === 'all' ? 'no usage recorded' : `no usage in the ${phrase}`}
                    </div>
                  )}
                </div>
              );
            })}
          </>
        );
      })()}
      <div className="modal-actions">
        <button className="btn" onClick={onClose}>Close</button>
      </div>
    </Modal>
  );
}
