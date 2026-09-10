// Small time helpers shared by anything that has to say "how old is this".
// The update banner grew the first copy of `age`; dead panes needed the same
// thing, so it lives here rather than being written twice.

/** Short "how old" label: just now, 3h ago, 2d ago, 3w ago. '' if unusable. */
export function age(iso: string | null | undefined): string {
  if (!iso) return '';
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return '';
  const h = Math.floor(ms / 3600000);
  if (h < 1) return 'just now';
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return d < 14 ? `${d}d ago` : `${Math.floor(d / 7)}w ago`;
}

/**
 * Whole days since `iso`. Infinity for a missing or unparseable date, so a
 * pane with no usable timestamp sorts as "oldest" and is offered for cleanup
 * rather than quietly kept forever; negative clock skew reads as 0.
 */
export function daysSince(iso: string | null | undefined): number {
  if (!iso) return Infinity;
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms)) return Infinity;
  return Math.max(0, Math.floor(ms / 86400000));
}
