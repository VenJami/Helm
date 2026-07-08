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
  — see docs/CLAUDE_INTERNALS.md).
  Sessions map (id → {pty, ring buffer, sockets, name, color, activity,
  claudeSessionId, transcriptPath…}), REST under `/api`, WS attach, hook
  endpoint, usage parsing, persistence.
- `server/hook-post.mjs` — runs *inside* panes as a Claude Code hook; relays
  hook payloads to `POST /api/hook`. No-ops outside Helm (exits 0 always).
- `web/src/App.tsx` — top bar (profile picker, usage 📊, alerts 🔔), grid,
  modals (new/delete profile, usage roll-up), notifications, maximize state.
- `web/src/components/TerminalPane.tsx` — one pane: xterm (+fit/webgl), WS
  attach/replay, name/color editing, per-pane usage, revive overlay.
- `web/src/components/Sidebar.tsx` — workspaces. `Modal.tsx` — dialog shell.
- `web/src/api.ts` — token + fetch wrapper (auto-reloads page once on 401),
  `types.ts` — shared shapes.

## REST API (Bearer token on everything except /api/hook)
- `GET/POST /api/sessions`, `DELETE /api/sessions/:id` — lifecycle.
  POST body `{workspace, profile?, cols?, rows?}`. Session statuses:
  `running` | `exited` (process ended) | `dead` (PTY lost to server restart).
- `PATCH /api/sessions/:id {name?, color?}` — pane identity (persisted).
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
- `GET /health` — **unauthenticated** liveness (loopback-only, no CORS): `{ok,
  pid, startedAt, uptimeSec, claude:{version,ok}, sessions:{total,running,
  waiting,exited,dead}}`. For the stale-server-on-7777 check without the token.
- Env knobs: `HELM_LOG_FILE` (append the debug log to a file — survives
  restarts), `HELM_USAGE_TTL_MS` (usage roll-up cache TTL, default 15 000),
  `HELM_DATA_DIR` (override the state dir; used by the e2e), `HELM_DEBUG_HOOKS`
  (dump raw hook payloads). Log entries carry a coarse `level` (`error` for
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
- `GET/PATCH /api/settings` — server toggles, currently `{autoRevive}`.
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
  `{id, name, dir, profile?, port?}` — `profile` pins a default account to that
  project (panes made there run on it → per-project usage); `port` is the
  project's dev-server port for the liveness check above. `PATCH
  /api/workspaces/:id {name?, dir?, profile?, port?}` re-pins/renames/re-roots or
  sets the port; `profile: null|''` clears the pin, `port: null` clears the
  check, and a `port` outside 1–65535 is a 400.
- `GET /api/profiles` → `{default:{email}, profiles:[{name,email}]}`;
  `DELETE /api/profiles/:name` (refused while a running session uses it).
- `POST /api/hook` — hook relay (own token via `x-helm-hook` header).
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
  sessions.json          running sessions → revivable as 'dead' after restart
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
