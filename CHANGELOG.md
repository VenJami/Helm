# Changelog

All notable changes to Helm are documented here. Format follows
[Keep a Changelog](https://keepachangelog.com/); versions use
[SemVer](https://semver.org/). Dates are YYYY-MM-DD.

## [Unreleased]
### Added
- **A floating agent HUD, and Approve/Deny from it.** A small always-on-top
  strip listing every claude pane across every project — status, project,
  how long it has been at it, and what it is blocked on — so five agents stay
  glanceable while you work in your editor. Click a row to jump to that pane.
  When a pane asks permission to run something, the HUD shows exactly what
  (`Bash: npm run db:migrate`) with Approve and Deny, and answering there is the
  same decision as answering in the pane. It is armed only while the HUD is
  open: with it closed, panes prompt for themselves with no added delay, and
  nothing is ever auto-approved. The footer shows Helm's own local 7-day cost
  estimate — Helm has no access to Anthropic's plan percentages, and says so.
- **The notch stops filling up.** Agents that have been idle a while collapse to
  a "+3 quiet" line instead of taking rows, while anything working or waiting
  always shows — and a pane that has *just* finished still shows, because that is
  the thing you want to see. Right-click a project in the sidebar to hide it from
  the notch entirely.
- **The notch says what each agent is doing.** Every row now carries that
  agent's task under its name, and when one is blocked the compact strip says
  how long it has been waiting — "storefront 4m, needs you" rather than an amber
  dot you have to go and investigate.
- **The notch is just the agents now.** The header — agent count, token and cost
  readout, collapse and close buttons — is gone; it was picture-in-picture
  furniture that earned no room in a strip at the top of your screen. Right-click
  the notch to close it.
- **Clicking an agent in the notch brings Helm back.** It restores and
  foregrounds the window if it was minimised, then selects that pane. Before, it
  selected the pane inside a window that stayed hidden.
- **One way to open the notch.** Ctrl+K → "Open the agent notch" launches the
  real floating window. It replaces an older entry that opened the same page in
  an ordinary browser window — two commands that read the same in the palette,
  and the browser one was easy to mistake for the notch itself.
- **The notch stays put and knows when to disappear.** It sits flush at the top
  of your screen and can't be dragged out of place, and by default it hides
  itself whenever Helm's own window is up — so it is there when you minimise
  Helm and gone when you are looking at it. Appearance → Notch switches that off
  if you would rather it were always visible. At rest it shrinks to a small strip of
  coloured lights — one per agent, green for working, amber for waiting — so a
  glance tells you whether anything needs you without it taking up room. When
  something IS blocked it stops showing lights and names the project instead
  ("storefront — Needs you"), because knowing which one is the point. Reach it
  with your cursor and it grows into the full list. `start-helm.cmd` brings it up for you once it has been built.
- **A real notch.** `desktop/start-notch.cmd` opens Helm's agent list as a
  frameless, rounded, always-on-top window that floats over your editor. It
  sizes itself to whatever it is showing, so it shrinks when the agents are
  quiet and grows when one needs you, and you drag it around by its header.
  Click a row to jump to that pane; Approve and Deny work from it. Windows only,
  entirely optional, and Helm works exactly as before without it.
- **The agent HUD can open in its own window** (Ctrl+K → "Open the agent HUD in
  its own window"). The floating version borrows the browser's
  picture-in-picture window, which can only be one per page and refuses to
  shrink below a few hundred pixels. The HUD is now also a page in its own
  right, so it can go in an ordinary window you size and place yourself — and
  clicking an agent in it still jumps the main window to that pane.
- **A crash in the window no longer looks like Helm dying.** Any error while
  drawing the page used to blank the whole window with nothing said, even
  though every pane was still running in the server. Now you get a card that
  says so, shows what broke, and offers the reload that fixes it.
- **Clean up old panes** (Ctrl+K → "Clean up old panes…"). Panes whose process
  died with a server restart used to pile up forever, and one from July looked
  exactly like one from this morning. Dead panes now say how old they are, and
  one dialog lists every non-running pane oldest-first with its project and
  age, pre-ticking anything past a fortnight.

### Fixed
- **Stopping a public share link now really stops it.** Helm closed the link and
  forgot about it, but on some setups the underlying process kept running — a
  public URL still live with nothing left holding it. It is killed properly now.

## [0.3.0] — 2026-09-09
### Added
- **"You're N commits behind" as well as "a new version is out"** — Helm is
  installed by cloning `main`, where the newest release can be weeks old, so
  the update check now also reports how far `main` has moved ahead of the copy
  you are running, with the newest commit's subject and a link to exactly those
  changes on GitHub. It is deliberately quieter than the release banner (one
  small line, and never both at once): a release is news, a commit is not.
  Dismissing it brings it back only once main has moved meaningfully further
  ahead, or after a week. It stays silent whenever the answer would be a guess
  — a ZIP download rather than a clone, no `git` installed, a commit GitHub has
  never seen, or a copy carrying commits of its own.
- **Ctrl+K now runs commands** — the palette was a way to jump to a pane; it is
  now also the way to *do* things: new pane, add workspace, broadcast, usage,
  appearance, show/hide the sidebar, desktop alerts, terminal text size, the
  debug log, the server console, public links, and maximize/minimize/pop-out of
  the pane you were last working in. Search by what you mean rather than the
  exact name — "dark" finds Appearance, "cost" finds Usage — and any command
  that also has a keyboard shortcut shows it, which makes the shortcuts
  discoverable for the first time.
- **Talk to a pane instead of typing** — a mic button on each pane (or
  Ctrl+Shift+D) turns speech into a cleaned-up prompt: filler and false starts
  removed, self-corrections resolved, mis-heard identifiers like "use effect"
  restored to `useEffect`, punctuation put back. The text lands in the pane
  **unsent**, so you read it before the agent acts on it. No extra subscription
  and nothing to install — your browser does the speech-to-text and your
  existing Claude Code account does the clean-up — about two seconds and a
  tenth of a cent per dictation, on Haiku. If the clean-up fails for any reason you still get
  exactly what you said. Note that while the mic is on, your browser sends the
  audio to its speech service; SECURITY.md explains this in full. The button
  only appears in browsers that support the API (Edge and Chrome; not Firefox
  or Brave).
- **Pop a pane out into a floating window** — a pane can leave the grid for its
  own always-on-top window that stays visible over your editor and browser, so
  you can watch an agent work while you use the project it is working on, and
  type into it without switching windows. The button sits in the pane header;
  closing the window (or clicking the button again) puts the pane back. One pane
  at a time, and only in browsers that support it — the button hides itself
  elsewhere.
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

- **Update notification** — Helm checks GitHub for a newer *released* version at
  startup and every 2 hours, and shows a dismissible banner with the new
  version, the update commands and a link to the release notes. Dismissing it
  hides that version only. It is the one outbound request Helm makes on its
  own: anonymous, no telemetry, and `HELM_NO_UPDATE_CHECK=1` switches it off.

### Changed
- **Sidebar rows fit the names again** — project names get their own line while
  account, branch, port and pane count share one meta line that ellipsizes;
  row actions moved into a hover overlay instead of reserving invisible width,
  so the text column went from 50px to 182px and every card is the same height.
  The sidebar is drag-resizable from its right edge (double-click resets), and
  the toolbar wraps inside itself instead of overflowing, dropping button
  labels to icons below 1400px.

### Fixed
- **Panes no project can show no longer haunt you.** A pane is listed under its
  project, so one whose project isn't in the sidebar was invisible: you couldn't
  see it, couldn't kill it, and auto-revive respawned it at every start. Two
  ways in are closed. The cloudflared installer ran in a pane belonging to no
  project, which was then saved forever — it is now a one-shot pane that lives
  only as long as the server that ran it. And any pane already stranded, from
  that or from a removed project, is dropped at start-up with a line in the
  debug log saying which and why. If the project list is empty the sweep does
  nothing at all, since "no projects yet" and "the file failed to load" look
  identical from there and the second must never wipe your panes.
- **Ctrl+V pastes into a pane.** Only Ctrl+Shift+V worked before: xterm mapped
  Ctrl+V to a control character and cancelled the browser’s own paste event.
- **The animated target cursor follows the theme.** It painted its dot and
  corner brackets with an inline color, so it stayed amber through every
  accent and light/dark switch.

### Security
- Cleared new high-severity advisories in transitive dependencies (js-yaml and
  qs on the server, js-yaml and browserslist in the frontend's dev tooling) —
  lockfile-only, no declared dependency moved and node-pty stays pinned exact.
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

[Unreleased]: https://github.com/VenJami/Helm/compare/v0.3.0...HEAD
[0.3.0]: https://github.com/VenJami/Helm/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/VenJami/Helm/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/VenJami/Helm/releases/tag/v0.1.0
