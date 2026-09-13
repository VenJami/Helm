# Helm — Architecture & API

```
Browser (React + xterm.js grid) <--WS/REST--> Node server <--PTY--> claude.cmd
                                                   ^ hook relay POSTs (status)
```

## Files
- `server/index.mjs` — backend core: Express + `ws` + `node-pty` (sessions/PTY,
  routes, WebSocket attach). Shared concerns live in `server/src/`:
  `log.mjs` (🐞 drawer feed) · `persist.mjs` (atomic JSON state) ·
  `claude.mjs` (ALL claude-internals: transcript parsing, pricing, drift alarm
  — see docs/CLAUDE_INTERNALS.md) · `tunnel.mjs` (public share links via
  cloudflared quick tunnels — read its header comment before touching it, it
  is the one place Helm leaves loopback) · `update.mjs` (is a newer Helm
  released, and how far is `main` ahead of this checkout? two anonymous GitHub
  calls, off with `HELM_NO_UPDATE_CHECK=1`).
  Sessions map (id → {pty, ring buffer, sockets, name, color, activity,
  claudeSessionId, transcriptPath…}), REST under `/api`, WS attach, hook
  endpoint, usage parsing, persistence.
- `server/hook-post.mjs` — runs *inside* panes as a Claude Code hook; relays
  hook payloads to `POST /api/hook`. No-ops outside Helm (exits 0 always).
- `web/src/App.tsx` — composition root: top bar, pane grid (weights +
  resize gutters), workspace selection, jump/cycle focus (pane ref map).
- `web/src/hooks/` — `useSessionsPoll` (3 s session+profile poll, stable
  references, desktop notifications) · `useWorkspaceStatus` (git/dev-server
  dots + share-link state) · `useTheme` (dark/light + accent → `data-*` attrs) ·
  `useGridWeights` (per-workspace pane sizing) · `usePipWindow` (floating
  always-on-top pane) · `useFocusRequests` (the app's end of the focus long
  poll — a click in another window moves this one) · `useDictation` (browser Web Speech API for the mic
  button; reports `supported:false` where the API is missing so the caller can
  hide the button, and restarts the recogniser across pauses).
- `web/src/lib/storage.ts` — ALL localStorage behind typed, validated
  accessors (corrupt values fall back; per-workspace keys pruned on removal).
- `web/src/components/` — `TerminalPane.tsx` (xterm +fit/webgl, WS
  attach/replay, per-pane usage, revive overlay) · `Sidebar.tsx` ·
  `GridResizers.tsx` (drag gutters) · `modals/` (each dialog owns its draft
  state: NewProfile, AddWorkspace, Profiles, Usage, Broadcast, Appearance, Share,
  Shares = the live public-link panel, InstallCloudflared) ·
  `Modal.tsx` (shell) · `Toaster.tsx` · `DriftBanner.tsx` ·
  `CommandPalette.tsx` (Ctrl+K: panes + workspaces to jump to, and the app's
  commands — App passes them in as one `actions: PaletteAction[]` array, so the
  palette stays presentational; each action carries optional `keywords` for
  search-by-meaning and a `hint` naming its key chord).
- `desktop/HelmNotch/` — the NATIVE notch window (C# / WPF, Windows-only,
  entirely optional; Helm runs fine without it). It renders nothing itself: a
  frameless, always-on-top WPF window hosting a WebView2 pointed at
  `/hud?notch=1`, so the whole UI stays React + CSS in `web/`. Deliberately NOT
  `AllowsTransparency` — that hosts it as a layered window, which renders the
  prettier version and then swallows all mouse input (GOTCHAS). The silhouette
  is a window REGION instead: flush to the top of the screen with square top
  corners, a deep curve on the bottom two, re-cut on every resize. `HELMNOTCH_DEBUG_PORT` opens its DevTools port, the only
  way to drive the window from a test. The page talks to
  it through `window.chrome.webview` (`web/src/lib/nativeHost.ts` ↔
  `MainWindow.OnWebMessage`): `config`, `resize`, `close`, and one message the
  other way (host→page `{compact}`, via `PostWebMessageAsJson` → `onHostMessage`)
  — the host owns hover detection because a 24px strip cannot tell where the
  cursor is relative to the screen edge. Window WIDTH is a function of the mode
  (200 compact / 460 expanded), never of measured content; only height comes
  from the page. It is deliberately
  NOT movable. While following (the default) it hides whenever a visible,
  non-minimised window whose title ends "Helm ⎈" exists, so it is only ever on
  screen when Helm is not; while auto-compacting (also default) it rests as a
  strip of per-pane status lights (`NotchStrip`), or — when a pane is blocked —
  that project's name and "Needs you", and grows into the full list on hover.
  The compact window has two FIXED widths for those two faces; the page picks
  one by state (`compactWidthFor`) and never measures. Pure pane-state helpers
  live in `lib/paneStatus.ts` so both faces and the HUD share one definition.
  What it lists is filtered by `notchPanes`: panes idle beyond 30 min (and dead
  ones) collapse to a "+N quiet" line, and projects muted with `notch:false`
  drop out entirely and are not counted. The notch only — `/hud` in a browser
  window stays the full view.
  The notch renders `AgentHud` with `chrome={false}` — no header, no count, no
  spend, no collapse or close buttons — and closes on right-click instead. Following outranks compacting. There is deliberately NO
  click-through message — a window that ignores the mouse stops receiving mouse
  messages, so the page could never turn it back off; instead the window HUGS its
  content (a `ResizeObserver` drives `resize`), which leaves nothing around the
  card to click through. Built with `desktop/start-notch.cmd` (needs a .NET SDK;
  the WebView2 + WindowsDesktop runtimes ship with Windows). Traps in GOTCHAS.
- `web/index.html` + `web/hud.html` — TWO built pages (Vite `rollupOptions.input`),
  each served by the Node server with `%%HELM_TOKEN%%` substituted: the app at
  `/`, and the floating agent HUD at `/hud`. The HUD exists as a standalone
  document so it can live in a window that is NOT a child of the app's — a
  second browser window today, a native always-on-top shell later. `HudApp.tsx`
  is its root: it fetches its own data over the same REST API (polling only what
  it renders — sessions, profiles, workspaces, git), mirrors the app's theme out
  of localStorage, and sends jumps through `POST /api/focus`. `AgentHud.tsx`
  itself is shared verbatim with the picture-in-picture copy App portals — only
  the `onJumpToPane`/`onClose` props differ.
- `web/src/api.ts` — token + fetch wrapper (auto-reloads page once on 401),
  `types.ts` — shared shapes incl. the typed WS protocol union.

## REST API (Bearer token on everything except /api/hook)
- `GET/POST /api/sessions`, `DELETE /api/sessions/:id` — lifecycle.
  POST body `{workspace, profile?, cols?, rows?}`. Session statuses:
  `running` | `exited` (process ended) | `dead` (PTY lost to server restart).
  Every session carries a `kind`: `claude` (a claude CLI pane — everything
  below assumes this) or `dev` (a workspace's dev-server pane, see
  `POST /api/workspaces/:id/start`).
- `POST /api/sessions/:id/stop` — kill the process, KEEP the pane (its
  scrollback stays readable; it lands in `exited` and can be started again).
  409 when it isn't running. Deleting the pane outright is the DELETE above.
- `PATCH /api/sessions/:id {name?, color?, categoryId?, favorite?}` — pane identity
  (persisted). `categoryId: null` files the pane out of its category; any other
  value must name one that exists, else 400 — a pane must never hold a
  reference the UI cannot resolve. `favorite` is the star the "favorites only"
  grid filter keeps; the filter is client-side (`helm.favoritesOnly`) and never
  hides a pane you jump to.
- `POST /api/sessions/:id/revive` — respawn a `dead` session; uses
  `claude --resume <claudeSessionId>` when hooks captured the id (same
  conversation), else a fresh claude in the same workspace/profile. If the
  recorded transcript was never written (claude team-mode sessions — see
  GOTCHAS) it falls back to fresh instead of a doomed --resume.
- `POST /api/sessions/:id/switch-profile {profile, cols?, rows?}` — move a
  pane to another account (`profile` ''/null = default). Copies the
  conversation transcript into the target account's store, kills the old
  claude, respawns in the same pane with `--resume` — same chat under the new
  login; attached sockets stay open through the swap. 409 if the target
  profile has no stored login. Copies are recorded in
  `imported-transcripts.json` so the usage roll-up doesn't double-count moved
  history (details in ACCOUNTS.md).
- `GET /api/sessions/:id/usage` — per-model tokens for that pane's transcript.
- `GET /api/usage` — roll-up per account (default + each profile) from each
  account's whole transcript store; rolling windows 1 h / 5 h / 10 h / 24 h /
  7 d / 30 d + all time, each with its own per-model breakdown. Cached ~15 s
  (`HELM_USAGE_TTL_MS` overrides; account switches invalidate). Transcripts are
  parsed *incrementally* — only bytes appended since the last poll are read, so
  an active multi-MB transcript no longer blocks the event loop (and with it
  every pane) on each poll.
- `GET /api/diagnostics` — claude-CLI health (boot-time `--version` vs the
  tested floor) + accumulated drift warnings; drives the UI's top banner
  (docs/CLAUDE_INTERNALS.md).
- `GET /api/update` → `{current, latest, available, url, name, publishedAt,
  checkedAt, disabled, error, commits}` — two signals, checked at boot and
  every 2 h and cached server-side (one shared answer for every tab, kind to
  the anonymous API's 60-requests/hour limit):
  - the latest published GitHub RELEASE vs this checkout's package version
    (`available`) — drives the loud update banner;
  - `commits: {ahead, url, latest, latestAt} | null` — how far `main` is ahead
    of the commit `git rev-parse HEAD` reports here, via GitHub's compare API.
    Drives one quiet line, shown only when there is no release to announce.
    It is `null` on every ambiguous case: not a git checkout, git missing, the
    commit unknown to GitHub (404), or a checkout carrying its own commits
    (compare status `identical`/`behind`/`diverged`).

  Failures stay silent throughout (offline is normal for a local-first app).
- `GET /health` — **unauthenticated** liveness (loopback-only, no CORS): `{ok,
  pid, startedAt, uptimeSec, claude:{version,ok}, sessions:{total,running,
  waiting,exited,dead}}`. For the stale-server-on-7777 check without the token.
- Env knobs: `HELM_LOG_FILE` (append the debug log to a file — survives
  restarts), `HELM_USAGE_TTL_MS` (usage roll-up cache TTL, default 15 000),
  `HELM_DATA_DIR` (override the state dir; used by the e2e), `HELM_DEBUG_HOOKS`
  (dump raw hook payloads), `HELM_NO_UPDATE_CHECK=1` (never contact GitHub),
  `HELM_REPO` / `HELM_UPDATE_URL` / `HELM_COMPARE_URL` / `HELM_REPO_BRANCH`
  (point the update check elsewhere — a fork, another tracked branch, or the
  smoke test's stub). Log entries carry a coarse `level` (`error` for
  error/drift tags, else `info`). On SIGINT/SIGTERM the server persists sessions
  and stops panes (no orphaned claude children).
- `POST /api/broadcast {text, sessionIds[]}` — type one instruction into
  several running panes (text lands as a paste; Enter follows ~250 ms later
  as its own keypress).
- `POST /api/sessions/:id/attach?name=<file>` — raw file body (≤25 MB), saved
  under `attachments\<session>\`; the file's PATH is then typed into the pane
  (quoted if spaced, no Enter) — the native-terminal drag-drop mechanism, so
  claude reads the file from disk. Session must be running (409 otherwise).
  Deleted with the session; orphan dirs swept at server start. Note: claude
  2.1.198 shows the path as plain text (no [Image #N] chip) but reads the
  file fine when the prompt is submitted.
- `POST /api/sessions/:id/polish` — `{text}` (1–4000 chars): clean a raw
  dictation transcript into a written instruction via headless `claude -p` on
  the pane's account. Returns `{text, polished, cost, ms}` and **never fails
  closed** — on a timeout, a refused model or a reply that fails the sanity
  check it answers with the raw transcript and `polished:false`, because
  dictation must not lose what you said. See CLAUDE_INTERNALS §7 for the flags
  (Haiku, no tools, neutral cwd) and why each one is there.
- `POST /api/sessions/:id/type` — `{text}` (1–4000 chars): write into a running
  pane's input WITHOUT Enter (the dictation path's last step, so you read the
  text before the agent acts on it). Dev panes refuse it, like broadcast.
- `POST /api/hud/ping` — heartbeat from the floating agent HUD. This and only
  this ARMS Approve/Deny: with no ping in the last 8 s, every `PermissionRequest`
  hook is answered the instant it arrives, so a Helm without the HUD open adds
  no latency to any pane and behaves exactly as it did before the feature.
- `POST /api/sessions/:id/approve` — `{requestId, decision:'allow'|'deny'}`:
  answer the tool call the pane is blocked on. `requestId` is Helm's own id for
  the held request (from `pendingId` on the session — claude sends no id of its
  own). 409 = that request is no longer waiting: it lapsed back into the pane's
  own prompt after 12 s, or the pane died. The UI treats 409 as information,
  not failure.
- `POST /api/focus` — `{sessionId}`: "bring that pane to the front", raised by
  a HUD running in its own window. `GET /api/focus/wait?since=<ms>` is the other
  half: the app parks a LONG POLL there and the server answers the instant a
  request lands (or after ~25 s with a null `sessionId`, and the client
  reconnects). Deliberately server-mediated rather than a `BroadcastChannel`,
  which only reaches documents in the same browser — the window this exists for
  may be a separate process. `since` is the cursor: a request raised while
  nobody was parked is still delivered to the next poll that asks from before
  it, and never replayed to one that asks from after.
- `GET/POST /api/notch` — `{supported, running, started}`: open the native notch
  window. `supported` is false off Windows and in a checkout that has never
  built it, so the UI hides the entry instead of offering something that cannot
  work; POST is a no-op when one is already up (checked with `tasklist` at click
  time rather than polled). Spawned detached and unref'd, so the notch outlives
  the request and a Helm shutdown doesn't close a window you opened on purpose.
- `GET/PATCH /api/settings` — server toggles:
  `{autoRevive, notchFollowsHelm, notchAutoHide}`.
  `notchFollowsHelm` lives here rather than in localStorage because the native
  notch runs in its own WebView2 profile and shares no storage with the browser;
  the notch page polls it and relays it to the host, so the auth token stays in
  the page.
- `GET /api/logs?after=<seq>` — in-memory server event log for the UI's 🐞
  drawer; `startedAt`/`pid` identify the process (stale-server check).
- `GET/POST /api/console` → `{supported, visible}` — show/hide the server's own
  console window (the `start-helm.cmd` terminal). Windows-only, via a PowerShell
  `GetConsoleWindow`+`ShowWindow` P/Invoke; `supported:false` when non-Windows or
  launched detached (UI hides the button). POST body `{visible:boolean}`.
- `GET /api/workspaces/git` → `[{id, branch, dirty, ahead, behind}]` — best-effort
  `git status` per workspace for the sidebar indicator (branch null = not a repo;
  each call capped at 2 s). Registered before the `:id` routes so 'git' isn't
  read as an id. Polled ~6 s by the UI.
- `GET /api/workspaces/servers` → `[{id, port, up}]` — dev-server liveness for
  workspaces with a configured `port`: a bare TCP connect to `127.0.0.1:port`
  (`up` = accepted, capped at 1 s). Also registered before `:id`. Polled ~4 s.
- `GET/POST /api/workspaces`, `DELETE /api/workspaces/:id`. Workspace =
  `{id, name, dir, profile?, port?, startCommands?}` — `profile` pins a default
  account to that project (panes made there run on it → per-project usage);
  `port` is the project's dev-server port for the liveness check above;
  `startCommands` is the LIST of commands ▶ runs (a project can need a backend
  *and* a frontend watcher — this repo does). `PATCH /api/workspaces/:id
  {name?, dir?, profile?, port?, startCommands?}` re-pins/renames/re-roots or
  sets the port/commands; `profile: null|''` clears the pin, `port: null`
  clears the check, `startCommands: null|[]` clears the commands. Commands may
  be sent as an array or as one newline-separated string (what the sidebar's
  editor does); over 6 commands, or one over 500 chars, is a 400. A legacy
  single `startCommand` is still accepted on the wire and migrated on load.
- `POST /api/workspaces/:id/start {cols?, rows?}` — ▶: run each start command
  as its own **dev pane** (`kind:'dev'`), returning
  `{sessions:[…], started:n}`. Panes are matched to commands by command string,
  so an existing stopped/dead pane is respawned in place instead of duplicated;
  409 when every command is already running. With no `startCommands` set, they
  are guessed from the ROOT `package.json` scripts (`dev` → `start` → `serve`,
  as `npm run <script>`) and saved onto the workspace. Nothing guessable → 400
  with `needsCommand:true`, which is the UI's cue to offer /suggest-start.
- `POST /api/workspaces/:id/stop` — ■: stop every running dev pane of that
  workspace (`{stopped:n}`); the panes stay so their output is still readable.
  409 when none is running.
- `POST /api/workspaces/:id/suggest-start` → `{commands:[…], cost}` — asks the
  REAL claude CLI, headlessly and read-only, how this project starts (see
  CLAUDE_INTERNALS §6 for the exact invocation). Costs a real few cents and
  takes ~5–20 s. It **only suggests**: nothing is saved and nothing is spawned,
  because the UI shows the commands for the owner to accept first.
### Public share links (Cloudflare quick tunnels)
Publishes a **project's dev server** — never Helm's own port — to the internet.
The URLs are unauthenticated, so the guards are load-bearing; see SECURITY.md
and the header of `server/src/tunnel.mjs`.
- `GET /api/tunnels` → `{available, version, installHint, ttlMs, tunnels:[…]}`.
  `available:false` = cloudflared isn't on PATH; the UI then opens an explainer
  dialog instead of sharing. A *found* result is cached for the process, a MISS
  only for 10 s, so installing mid-session needs no restart.
- `POST /api/tunnels/install {cols?, rows?}` → a dev-pane `sessionInfo` running
  `installCommand` (winget/brew) in a **visible** pane — never a silent
  background install. 409 when cloudflared is already present, 501 where there
  is no one-line installer (the UI shows `installDocs` instead).
- `POST /api/workspaces/:id/tunnel {port?}` → the tunnel record (201), blocking
  until cloudflared yields a URL (15 s cap; a slower one stays `starting` and
  the poll picks it up). Refusals: **400 `code:'BLOCKED_PORT'` for Helm's own
  port** (its pages carry the auth token), 400 for an unset/invalid port, 409
  when already shared, 501 when cloudflared is missing, 502 when it dies before
  producing a URL.
- `POST /api/workspaces/:id/tunnel/extend` — push the deadline out by another
  `ttlMs`. `DELETE /api/workspaces/:id/tunnel` — take the link down.
- Links live **30 min** by default, are **never persisted** (a restart drops
  them — fail-closed), and are torn down on workspace delete and on shutdown.
  `HELM_CLOUDFLARED_CMD` overrides the binary (the test suite points it at a
  stand-in).

- `GET /api/categories` → `[{id,name,color}]` — pane categories ("folders",
  the Chrome-tab-group shape: a named, colored grouping panes are filed into).
  `POST /api/categories {name, color}` (name 1-24 chars, color `#rrggbb`),
  `PATCH /api/categories/:id {name?, color?}`,
  `DELETE /api/categories/:id` → `{ok, emptied}`. The delete also clears
  `categoryId` on every session filed there and reports how many it emptied —
  a delete has to be a delete everywhere the id is referenced, or panes are
  left pointing at a category that no longer exists. The category owns the
  COLOR: a filed pane renders in its category's color (derived client-side in
  `web/src/lib/categories.ts`, never written onto the session), so recoloring
  a category repaints every pane in it with no migration.
- `GET /api/profiles` → `{default:{email}, profiles:[{name,email}]}`;
  `DELETE /api/profiles/:name` (refused while a running session uses it).
- `POST /api/hook` — hook relay (own token via `x-helm-hook` header). Answers
  `{ok:true}` for every event except `PermissionRequest`, where the reply is a
  DECISION (`{decision:'allow'|'deny'|'ask'}`) and the response may be HELD
  OPEN for up to 12 s while the HUD offers Approve/Deny. `'ask'` — the answer
  whenever the HUD is closed, the hold lapses, or the pane dies — means "no
  opinion", and the pane prompts for itself exactly as it always did. The relay
  turns a decision into claude's own reply shape on stdout
  (CLAUDE_INTERNALS §5a; the shape is undocumented and the published docs are
  wrong about it).
- `GET /ws?session=<id>&token=<t>` — attach. Server→client: `data`, `replay`
  (ring-buffer catch-up), `exit {code}`. Client→server: `input {data}`,
  `resize {cols, rows}`.

## How panes are spawned
`pty.spawn(CLAUDE_CMD, ['--settings', <hook-settings>, '-n', <paneName>,
...extra], { cwd: workspace, env: {...process.env, CLAUDE_CONFIG_DIR?,
HELM_SESSION_ID, HELM_HOOK_TOKEN, HELM_PORT} })`
- `CLAUDE_CMD` = `claude.cmd` on Windows (node-pty can't spawn the `.ps1`),
  plain `claude` elsewhere; override via the `HELM_CLAUDE_CMD` env var.
  Needs Node 22+ and `claude` on PATH. macOS/Linux: code support only, not
  yet tested on real hardware.
- `-n <name>` = claude display name (shows in its /resume picker).
- `extra` = `['/login']` when the profile finished onboarding but has no
  credentials → pane boots straight into the login screen. Fresh profiles are
  left to claude's own onboarding (it includes login; forcing /login there
  would queue a duplicate dialog).
- Ring buffer: ~200 KB of output kept per session, replayed on (re)attach so
  panes repaint instantly. Socket close ≠ PTY kill (locked decision).

### Dev panes (`kind:'dev'`)
A workspace's ▶ spawns each of its start commands through the platform shell instead of
claude — `%ComSpec% /d /s /c <command>` on Windows, `$SHELL -lc <command>`
elsewhere — in the same PTY/session machinery, so npm's colors, its prompts and
Ctrl+C behave as they do in a normal terminal. Deliberately NOT a claude
session: no hook settings, no `CLAUDE_CONFIG_DIR`, no profile, no transcript
(so it never touches usage), and it's refused as a broadcast or account-switch
target. `FORCE_COLOR=1` is set, and Helm's own `PORT` is scrubbed from the env
(Vite/Next read it — inheriting Helm's would point the dev server at Helm).
Killing the pty tears the whole chain down (cmd → npm → node), so stopping
frees the project's port. The UI creates these panes minimized: they live in
the tray, out of the claude grid, until the sidebar card's terminal button
opens them. A project with several commands gets one pane each, named after the
folder its command cds into (`cd server && npm start` → "<project> server").

## Hooks → status/usage (how panes report state)
Every pane gets `--settings %LOCALAPPDATA%\Helm\hook-settings.json` (generated
at server start; **no profile's settings.json is ever modified**). Events
SessionStart / UserPromptSubmit / Stop / Notification run `hook-post.mjs`,
which POSTs to Helm. This yields per-pane `activity` (working=blue pulsing,
waiting=amber, idle=green), plus `claudeSessionId` + `transcriptPath` — which
power revive and usage. Never scrape ANSI output for status; hooks are the way.

A `Notification` event also carries its `message` into `session.activityNote`
(cleared when the pane starts working or goes idle), surfaced on `sessionInfo`
so the badge and desktop alert can say *why* a pane is blocked.

`sessionInfo` also exposes `summary` — an auto-title derived server-side from the
conversation's first real user prompt (`firstPromptSummary` reads the transcript,
skips meta/command/system-reminder lines, truncates to 100 chars; cached, and
never re-read once found since the opening prompt is immutable). Shown in each
pane header and used by the Ctrl+K command palette so search matches on what a
pane is actually working on, not just its random star-name.

Frontend notifications are edge-triggered off the 3 s session poll: flip to
`waiting` → the hook's message (or "needs your input"); `working→idle` →
"finished". Suppressed while the tab is focused. Tab title shows "(N waiting)";
a toolbar "N waiting" pill jumps to the next blocked pane (rotates on repeat),
and Ctrl+Shift+←/→ cycles focus through a workspace's visible panes. Ctrl/Cmd+K
opens a command palette (`components/CommandPalette.tsx`) to filter and jump to
any pane or workspace. Transient action errors surface as toasts
(`components/Toaster.tsx`, `toast.error(...)`), not inline red text.

## Data locations (all local-only, NEVER in the repo — repo syncs to OneDrive!)
```
%LOCALAPPDATA%\Helm\        (~/.helm on macOS/Linux)
  token, hook-token      auth tokens (persist across restarts; delete to rotate)
  workspaces.json        sidebar workspaces
  categories.json        pane categories ("folders": id/name/color). A pane
                         references one by id and renders in ITS color, so
                         recoloring a category recolors every pane in it. At
                         load, a pane naming a category that is gone has the
                         reference cleared rather than kept as a ghost.
  sessions.json          running sessions → revivable as 'dead' after restart
                         (at load, panes whose workspace dir is no longer in
                         workspaces.json are dropped — the grid lists panes per
                         project, so they could never be shown again; skipped
                         when the workspace list is empty. One-shot panes, e.g.
                         the cloudflared installer, are never written here)
  settings.json          server toggles (currently autoRevive)
  hook-settings.json     generated hook config passed via --settings
  imported-transcripts.json  transcript copies made by account switches
                         (path → import time; usage roll-up skips older events)
  attachments\<session>\ files pasted/dropped onto a pane (path typed into it)
  accounts\<profile>\    per-account CLAUDE_CONFIG_DIR (credentials, config,
                         projects\ = transcripts)
```

## Tech stack
Node 22 ESM · express · ws · node-pty (backend) — React 18 + TS + Vite ·
@xterm/xterm + fit + webgl (frontend). No DB — JSON files in
`%LOCALAPPDATA%\Helm`. Everything local; no paid services.
