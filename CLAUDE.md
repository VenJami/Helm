# CLAUDE.md — Helm ⎈

## Project Overview
Helm is a local **operations hub for Claude Code**: a workspace sidebar + a grid
of live `claude` terminal panes (real CLI sessions on PTYs), each with a status
badge, name/color, and usage — run several agents in parallel across projects
and see their working at a glance. Owner is low-code — explain in plain
language, lead with the outcome.

**Status: fully working** (slice → grid → hooks/status → revive → usage →
notifications, all script-verified). Current backlog: see docs/ROADMAP.md.

## Core Principles (Always Follow)
- **Keep docs honest.** This file and docs/ must match reality. Never document
  aspirational commands/features as if they exist. When state changes, update
  the relevant doc (ROADMAP "Done" list included).
- **Test end-to-end against a real `claude.cmd` pane** before declaring a
  feature done. Build passing ≠ working. `cd server && npm run e2e` codifies
  this (real claude: spawn→hooks→usage→revive; docs/GOTCHAS.md). The fast smoke
  test (`cd server && npm test`, keep-alive stand-in) + `cd web && npm test`
  (vitest) run in CI but are no substitute for the real-pane check on
  user-facing behavior.
- **Simplicity first.** Lowest-effort thing that solves the request.
  *Decision ladder:* Does this need to exist? → Already in this codebase? →
  Stdlib/runtime does it? → A claude CLI flag/hook already does it? → An
  installed dependency? → One line? → Only then: the minimum that works.
- **Security is non-negotiable:** bind 127.0.0.1 + Origin check on WS + bearer
  token on REST/WS. An unauthenticated terminal server on localhost = RCE from
  any webpage.
- **IMPORTANT:** No new services, paid tools, or dependencies without explicit
  approval. Everything runs locally, $0.

## Tech Stack
- **Backend:** Node 22 ESM · express · ws · node-pty (`server/index.mjs` is the
  whole server). **Frontend:** React 18 + TS + Vite · @xterm/xterm (+fit/webgl).
- **No DB** — JSON files + tokens + account profiles in `%LOCALAPPDATA%\Helm\`
  (`~/.helm` on macOS/Linux).
- **Panes ARE the product:** real `claude` CLI subscriptions via PTY — never a
  custom Anthropic-API agent loop.

## Project Structure
```
helm/
├── CLAUDE.md               # this file
├── README.md · LICENSE     # public-facing (repo is on GitHub, MIT)
├── .github/workflows/ci.yml # CI: server syntax-check + web typecheck/build + smoke test
├── docs/
│   ├── ARCHITECTURE.md     # files, REST/WS API, spawn specifics, hook relay, data dirs
│   ├── GOTCHAS.md          # hard-won traps — READ BEFORE TOUCHING SERVER CODE
│   ├── ACCOUNTS.md         # multi-account profiles via CLAUDE_CONFIG_DIR
│   └── ROADMAP.md          # done list + prioritized backlog
├── server/
│   ├── index.mjs           # backend bootstrap + sessions/PTY + routes + WS
│   ├── src/                # log.mjs · persist.mjs (atomic state) · claude.mjs
│   │                       #   (ALL claude-internals: parsing/pricing/drift)
│   └── hook-post.mjs       # runs inside panes; relays Claude Code hook events
└── web/                    # React frontend → built to web/dist (server serves it)
    └── src/                # App.tsx (composition) · hooks/ (data polling, theme,
                            #   grid weights) · lib/storage.ts (typed localStorage)
                            #   · components/ (panes, sidebar, modals/…) · api.ts · types.ts
```

## Development Commands
```bash
cd server && npm start     # USE this when just using Helm → http://127.0.0.1:7777
cd server && npm run dev   # DEV only: --watch restarts on edits and KILLS live panes
cd server && npm test      # fast smoke test (real server + keep-alive claude stand-in)
cd server && npm run e2e   # real-claude end-to-end (spawn→hooks→usage→revive); needs
                           #   a logged-in claude, spends a few tokens, NOT in CI
cd web && npm test         # vitest unit tests (accounts.ts usage math)
cd web && npm run build    # after frontend changes (or `npm run watch` while developing)
# npm install once in server/ and web/. NO vite dev server — the Node server
# must serve web/dist to inject the auth token.
```
A running server picks up new frontend builds without restart (serves dist from
disk); server-code changes DO need a restart — check port 7777 for a stale
instance first (docs/GOTCHAS.md).

## Do Not
- Upgrade or swap `node-pty` casually — prebuilt binary is version-sensitive;
  its kill-race crash is guarded in index.mjs (docs/GOTCHAS.md).
- Kill a server process that has live claude children without checking
  (`Get-CimInstance Win32_Process -Filter "ParentProcessId=<pid>"`).
- Put credentials, tokens, or account dirs in the repo — it syncs to OneDrive.
- Use the placeholder string `%%HELM_TOKEN%%` anywhere in web/index.html except
  the token script line.
- Modify any profile's settings.json for hooks — the `--settings` relay file
  exists precisely to avoid that.
- Build ahead of the roadmap or add speculative abstraction.

## Owner Preferences & Key Decisions
(Locked — do not relitigate without owner.)
- **Standalone project** — not a module in the owner's serverless "Nocturne" app.
- **Real Claude Code CLI sessions** via node-pty — NOT an API agent loop, NOT a
  shell-only mux.
- **Sessions outlive sockets** — REST creates/kills sessions, WebSockets only
  attach; a WS drop or browser refresh never kills a PTY.
- **Webapp, not Electron** — rejected Electron (node-pty ABI rebuilds, packaging
  pain); "install as app" in the browser gives the native feel and keeps
  remote access (Tailscale, future) open.
- **Stay on Opus/high-capability models for build sessions** — owner values
  output quality over marginal cost savings.
- Multi-account profiles = separately-paid accounts owned by the same person
  (owner confirmed legit; details in docs/ACCOUNTS.md).

## Key References
Always loaded (so every session knows the plan):
- @docs/ROADMAP.md

Read on demand (open the one you need; not auto-loaded, to save context):
- docs/GOTCHAS.md — **read before touching server code or debugging "feature
  doesn't work"** (usual culprit: stale server on port 7777)
- docs/ARCHITECTURE.md — read before API/protocol/spawn changes
- docs/ACCOUNTS.md — read before profile/login work
- docs/CLAUDE_INTERNALS.md — the catalogue of every undocumented claude format/
  field/env/flag Helm parses; read first when usage/status/revive "shows
  nothing" (likely claude drift — the UI banner + /api/diagnostics flag it)

## Workflow Reminders
- Plan first for anything non-trivial; confirm before destructive actions
  (killing servers with sessions, deleting profiles/dirs).
- After finishing a feature: update ROADMAP.md (move to Done), rebuild web if
  frontend changed, verify end-to-end, and tell the owner to reload the page.
- When a decision gets made or a lesson is learned, record it here or in the
  relevant doc so it isn't repeated.
