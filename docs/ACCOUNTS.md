# Helm — Multi-account profiles (money-saver — verified working)

Goal: run 2–3 separately-paid Claude subscriptions at once — different panes on
different accounts, no logout/login switching.

**Mechanism (tested on this box):** Claude Code stores all auth + config in one
directory and honors the `CLAUDE_CONFIG_DIR` env var to relocate it. Auth on
Windows is file-based (`<dir>/.credentials.json`), so a per-process env var
gives each spawned `claude` its own isolated account, side-by-side,
simultaneously.

- Profile = dir under `%LOCALAPPDATA%\Helm\accounts\<name>` (never in the repo
  — OneDrive would sync OAuth tokens to the cloud).
- Email shown in the picker comes from
  `<dir>/.claude.json → oauthAccount.emailAddress` (null = never logged in).
- **Add account:** "+ new profile…" in the picker → pane opens claude's
  first-run setup → sign in with that account in the browser. If a profile
  finished onboarding but skipped login, its next pane auto-boots into the
  login screen (`/login` startup arg — handled server-side).
- **Signing in a SECOND account:** claude auto-opens the default browser,
  which is usually already logged into claude.ai as account A — clicking
  through logs the profile into the SAME account (happened twice). Instead:
  copy the OAuth URL from the pane (select it — copy-on-select — or
  Ctrl+Shift+C, or press `c` at claude's prompt) and open it in an
  **incognito window**, then sign in as account B. Panes also make URLs
  clickable (web-links addon), but clicking uses the default browser —
  fine for account A only.
- `CLAUDE_CONFIG_DIR` isolates *everything*, not just creds: settings, history,
  MCP config, folder-trust. Per-profile hooks are why Helm's hook relay uses
  `--settings` instead of touching profile settings.
- Conversations are **portable across profiles**: transcripts live in
  `<dir>/projects/<munged-cwd>/<session-id>.jsonl`, and copying one into
  another profile's matching folder lets `claude --resume <id>` continue that
  chat under the other account (verified 2026-07-03: resume keeps the same
  session id, no fork). This powers each pane's **"move to another account"**
  button — the server copies the transcript over and respawns claude in the
  same pane with `--resume`. A running claude can never change accounts in
  place (`CLAUDE_CONFIG_DIR` is read once, at spawn).
- Usage attribution across a move: the copy would double-count its history in
  the target account's roll-up, so the server records copies in
  `%LOCALAPPDATA%\Helm\imported-transcripts.json` and the roll-up skips a
  copied file's events from before the import. Known small gap: moving a pane
  A→B→A overwrites A's file and re-marks it imported, so A's roll-up loses the
  pre-move history (rolling windows age it out anyway). Per-pane usage is
  deliberately unfiltered — it shows the pane's whole story.
- Only the main transcript moves — nested subagent transcripts stay with the
  source account (their usage already happened there; resume doesn't need them).
- **A profile logged into the same account as default gains nothing** — the
  owner has done this twice by accident; the usage modal exposes it (same
  email on two rows). Helm now *auto-collapses* this case: when a named profile
  shares the default's login (and has stored creds), the account pickers hide
  the separate "default" row and panes that request default spawn under that
  profile's dir instead (server `mappedDefaultProfile()` /
  `/api/profiles → default.mapped`), so new usage lands on the profile, not the
  duplicate `~/.claude` row. The historical default row in the usage modal is
  left as-is (it holds real past tokens).
- Legit: separately paid accounts owned by the same person (owner confirmed);
  don't share one subscription across people. Re-verify Anthropic's consumer
  terms if usage patterns change.
