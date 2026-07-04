import type { AccountUsage, ModelUsage, Profile, UsageWindow } from './types';

// Display name for an account. Named profiles use their own name. The default
// account has no name of its own, so:
//   1. if a named profile is logged into the same email, reuse that profile's
//      name (the account the user already labeled) — "auto change to existing
//      profile";
//   2. else derive a name from the email's local part (profile1@… → "Profile1");
//   3. else "Default" (before it has been logged in — no email yet).
export function accountLabel(name: string, email: string | null, profiles: Profile[] = []): string {
  if (name) return name;
  if (email) {
    const match = profiles.find((p) => p.email === email);
    if (match) return match.name;
    const local = email.split('@')[0];
    return local.charAt(0).toUpperCase() + local.slice(1);
  }
  return 'Default';
}

// Sum window `b` into a fresh copy of window `a` (scalars + per-model breakdown).
// cost is linear in tokens, so summing per-window/per-model costs is exact.
function addWindow(a: UsageWindow | undefined, b: UsageWindow | undefined): UsageWindow {
  const out: UsageWindow = a
    ? { ...a, models: { ...a.models } }
    : { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, turns: 0, cost: 0, models: {} };
  if (!b) return out;
  out.input += b.input;
  out.output += b.output;
  out.cacheRead += b.cacheRead;
  out.cacheWrite += b.cacheWrite;
  out.turns += b.turns;
  out.cost += b.cost;
  for (const [model, m] of Object.entries(b.models)) {
    const base: ModelUsage = out.models[model]
      ? { ...out.models[model] }
      : { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, turns: 0, cost: 0 };
    base.input += m.input;
    base.output += m.output;
    base.cacheRead += m.cacheRead;
    base.cacheWrite += m.cacheWrite;
    base.turns += m.turns;
    base.cost = (base.cost ?? 0) + (m.cost ?? 0);
    out.models[model] = base;
  }
  return out;
}

// The bare default account (~/.claude) and a named profile can be the same
// Anthropic login (auto-map "twin" — same email + stored creds). When they are,
// the profile picker already hides the separate default entry; this does the
// same for the usage roll-up: fold default's local history into the mapped
// profile's row and drop the standalone default row, so one login reads as one
// account (with its true combined total) instead of two split rows. Grand total
// is unchanged — folding only moves numbers between rows. No-op when default is
// its own distinct account (mapped = null).
export function foldMappedDefault(accounts: AccountUsage[], mapped: string | null): AccountUsage[] {
  if (!mapped) return accounts;
  const def = accounts.find((a) => a.account === 'default');
  const target = accounts.find((a) => a.account === mapped);
  if (!def || !target) return accounts;
  const windows: Record<string, UsageWindow> = {};
  for (const k of new Set([...Object.keys(target.windows), ...Object.keys(def.windows)])) {
    windows[k] = addWindow(target.windows[k], def.windows[k]);
  }
  const merged: AccountUsage = {
    ...target,
    lastActive: Math.max(target.lastActive ?? 0, def.lastActive ?? 0) || null,
    windows,
  };
  return accounts.flatMap((a) =>
    a.account === 'default' ? [] : a.account === mapped ? [merged] : [a],
  );
}
