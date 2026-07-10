# Changelog

All notable changes to Helm are documented here. Format follows
[Keep a Changelog](https://keepachangelog.com/); versions use
[SemVer](https://semver.org/). Dates are YYYY-MM-DD.

## [Unreleased]

## [0.2.0] — 2026-07-10

### Added
- **Theme settings** — Appearance dialog (palette button in the toolbar):
  dark/light theme plus five accent presets (amber, blue, green, violet, rose),
  applied instantly and persisted. Terminal panes stay dark in light mode by
  design (claude's TUI colors assume a dark background).
- **Drag-resize panes** — gutters between grid columns/rows trade space between
  adjacent panes; double-click resets an axis. Sizes persist per workspace and
  per layout (3-column proportions survive independently of 2-column).

### Security
- Hardening pass on the trust seams: token compares are constant-time (REST
  bearer, hook header, WS query token); profile names are validated everywhere
  they enter the API (a workspace's pinned profile could previously carry a
  path); and a pane's hooks can no longer point the server at a transcript file
  outside that pane's own account store — a rejected path surfaces as a drift
  warning instead of being read/copied.

### Changed
- Frontend internals decomposed (no behavior change): typed localStorage module
  with orphan-key pruning, data-polling extracted to hooks, all five dialogs
  extracted to modal components owning their draft state, and pane focus
  addressed via a ref map instead of a window event. `App.tsx` ~1,379 → ~840
  lines.
- CI: the windows-latest smoke step retries once (cold-runner flake; a real
  regression still fails twice).
- Dev tooling: ESLint (correctness rules, zero warnings) + Prettier across both
  packages, enforced in CI; one mechanical reformat commit, listed in
  `.git-blame-ignore-revs` so blame skips it.
- README overhauled for the public release: badges, a "Why Helm?" section, an
  FAQ, and a new hero screenshot staged on an isolated server with generic
  project names (the old one showed the author's real project list).

## [0.1.0] — 2026-07-05

First tagged release: Helm is a local operations hub for Claude Code — a
workspace sidebar plus a grid of live `claude` CLI panes (real sessions on
PTYs), each with a status badge, name/color, and usage.

### Features
- **Live terminal grid** of real Claude Code CLI sessions (node-pty + xterm.js),
  grouped by workspace. Sessions outlive sockets — a browser reload never kills
  a pane; a server restart leaves panes revivable (`claude --resume`), with an
  optional auto-revive.
- **Status at a glance** — working / waiting / idle badges with elapsed time,
  driven by Claude Code hooks (not output scraping); desktop notifications and a
  "(N waiting)" tab title; a toolbar pill that jumps to the next blocked pane.
- **Usage & cost** — per-pane and per-account roll-ups over rolling windows
  (1 h → 30 d + all-time), per model, with rough $ estimates.
- **Multi-account** — run panes on separate Claude subscriptions side by side
  via isolated profiles; move a pane between accounts (keeps the conversation).
- **Productivity** — broadcast one prompt to many panes, attach images/files
  (paste/drop/pick), command palette (Ctrl/Cmd+K), find-in-scrollback, drag to
  reorder, maximize/minimize, per-workspace git + dev-server status.
- **Local & $0** — no database (JSON state under `%LOCALAPPDATA%\Helm`), no
  cloud, no telemetry. PWA installable.

### Security
- Binds `127.0.0.1` only; bearer token on every REST/WS call; Origin check on WS
  upgrades. See [SECURITY.md](SECURITY.md).

### Reliability & operations
- Atomic, versioned state writes with `.bak` recovery (corruption no longer
  silently wipes sessions/workspaces).
- Fail-fast on boot, keep-alive after: a post-boot uncaught error logs instead
  of crashing every pane. `node-pty` pinned exact.
- Loud `claude`-CLI drift detection (boot `--version` check + parse-time
  signals) surfaced as a dismissible banner and `GET /api/diagnostics`.
- Usage parsing moved off the request path (incremental, TTL-cached) so a usage
  poll can't stall live terminals.
- `GET /health` (unauthenticated liveness), leveled logging with an optional
  `HELM_LOG_FILE` sink, and graceful shutdown that persists sessions and stops
  panes on SIGINT/SIGTERM.

### Developer experience
- Typed WebSocket protocol; backend type-checked via JSDoc + `tsc --checkJs`;
  backend split into `server/src/` modules (`log`, `persist`, `claude`).
- Tests: a smoke suite (real server + hook relay), frontend unit tests
  (vitest), and a real-`claude` end-to-end check (`npm run e2e`). CI on
  push/PR (lint-free typecheck + build + audit + smoke).

### Platform
- Windows is the tested platform. macOS/Linux are supported in code but not yet
  verified on hardware.

[Unreleased]: https://github.com/VenJami/Helm/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/VenJami/Helm/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/VenJami/Helm/releases/tag/v0.1.0
