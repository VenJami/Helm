# Helm — Architecture & API

```
Browser (React + xterm.js grid) <--WS/REST--> Node server <--PTY--> claude.cmd
                                                   ^ hook relay POSTs (status)
```

## Files
- `server/index.mjs` — the whole backend: Express + `ws` + `node-pty`.
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
- `GET /api/sessions/:id/usage` — per-model tokens for that pane's transcript.
- `GET /api/usage` — roll-up per account (default + each profile) from each
  account's whole transcript store; rolling windows 1 h / 5 h / 10 h / 24 h /
  7 d / 30 d + all time, each with its own per-model breakdown.
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
- `GET/POST /api/workspaces`, `DELETE /api/workspaces/:id`.
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

Frontend notifications are edge-triggered off the 3 s session poll: flip to
`waiting` → "needs your input"; `working→idle` → "finished". Suppressed while
the tab is focused. Tab title shows "(N waiting)".

## Data locations (all local-only, NEVER in the repo — repo syncs to OneDrive!)
```
%LOCALAPPDATA%\Helm\        (~/.helm on macOS/Linux)
  token, hook-token      auth tokens (persist across restarts; delete to rotate)
  workspaces.json        sidebar workspaces
  sessions.json          running sessions → revivable as 'dead' after restart
  settings.json          server toggles (currently autoRevive)
  hook-settings.json     generated hook config passed via --settings
  attachments\<session>\ files pasted/dropped onto a pane (path typed into it)
  accounts\<profile>\    per-account CLAUDE_CONFIG_DIR (credentials, config,
                         projects\ = transcripts)
```

## Tech stack
Node 22 ESM · express · ws · node-pty (backend) — React 18 + TS + Vite ·
@xterm/xterm + fit + webgl (frontend). No DB — JSON files in
`%LOCALAPPDATA%\Helm`. Everything local; no paid services.
