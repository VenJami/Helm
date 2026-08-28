# Changelog

All notable changes to Helm are documented here. Format follows
[Keep a Changelog](https://keepachangelog.com/); versions use
[SemVer](https://semver.org/). Dates are YYYY-MM-DD.

## [Unreleased]

### Added
- **Start a project from the sidebar** — a play button on each project card runs
  its start command(s); stop takes them down again. The command is detected from
  the project's `package.json` the first time and saved on the workspace, and
  can be edited any time (right-click → "Set start command(s)…").
- **Projects that need more than one process** — a workspace holds a *list* of
  start commands (Helm itself needs a backend and a frontend watcher), each
  getting its own dev pane, named after the folder its command runs in. One play
  starts them all; one stop stops them all.
- **"Ask Claude how to start it"** — for projects nothing can be guessed from (no
  root `package.json`, a Python service, a monorepo whose command lives in a
  subfolder), Helm asks the claude CLI headlessly and read-only, then shows the
  commands it proposes for review. Accepting them (Ctrl+Enter) saves and runs
  them; nothing is ever saved or executed unreviewed. Costs a few cents on that
  project's account, reported with the suggestion.
- Dev output lives in real terminal panes — same scrollback, colors and Ctrl+C
  as any pane — created minimized, so they sit in the tray until the card's
  terminal button opens them and never disturb the Claude grid. Stopping keeps
  the pane so a server that died on an error still shows why.
- **Double-click launcher** — `start-helm.cmd` (repo root) is now the whole
  start-up: it installs dependencies and builds the web app on a first run,
  starts the server in its own console window, and opens Helm as a chrome-less
  app window (Edge/Chrome/Brave `--app=`, falling back to a browser tab) as
  soon as the server answers. Running it again while Helm is up just opens
  another window instead of failing on the busy port.
- **Public share links** — a project with a dev-server port gets a globe button
  that publishes it to the internet through a Cloudflare quick tunnel and copies
  the `https://….trycloudflare.com` link. Those URLs have no password, so the
  safety is deliberate and layered: a warning dialog that cannot be suppressed,
  a red PUBLIC flag on the project plus an always-visible toolbar pill counting
  live links and the time left, and a 30-minute self-expiry you can extend.
  Helm’s own port is refused, and links are never persisted — a restart fails
  closed. `cloudflared` is detected on PATH and in the usual install dirs; if
  it is missing, an explainer says what it is and can install it for you in a
  visible pane.
- **Public links panel** — the toolbar pill (or the PUBLIC flag) opens a list of
  every live link: the full URL as a real clickable anchor, plus copy, open,
  extend and stop, with time remaining.

### Changed
- **Sidebar rows fit the names again** — project names get their own line while
  account, branch, port and pane count share one meta line that ellipsizes;
  row actions moved into a hover overlay instead of reserving invisible width,
  so the text column went from 50px to 182px and every card is the same height.
  The sidebar is drag-resizable from its right edge (double-click resets), and
  the toolbar wraps inside itself instead of overflowing, dropping button
  labels to icons below 1400px.

### Fixed
- **Ctrl+V pastes into a pane.** Only Ctrl+Shift+V worked before: xterm mapped
  Ctrl+V to a control character and cancelled the browser’s own paste event.
- **The animated target cursor follows the theme.** It painted its dot and
  corner brackets with an inline color, so it stayed amber through every
  accent and light/dark switch.

### Security
- Cleared four high-severity advisories in transitive dependencies
  (`body-parser`, `postcss`, `nanoid`, `brace-expansion`, `js-yaml`) — all
  patch-level, no declared dependency changed and `node-pty` still pinned.
- Public share links are the one feature that intentionally leaves loopback.
  SECURITY.md documents what that exposes and what the three safety layers do.


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
