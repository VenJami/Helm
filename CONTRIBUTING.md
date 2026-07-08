# Contributing to Helm ⎈

Thanks for your interest! Helm is a local, single-user operations hub for Claude
Code. It's intentionally small and dependency-light — please read this before
opening a PR so your change fits the project's grain.

## Ground rules (the short version)

- **Simplicity first.** Do the lowest-effort thing that solves the problem.
  Before adding code, ask: does this need to exist? Is it already here? Does the
  stdlib / a `claude` CLI flag / an existing dep already do it?
- **No new dependencies, services, or paid tools without discussion.** Helm runs
  locally at $0. Open an issue first if you think a new dependency is warranted.
- **Keep the docs honest.** `CLAUDE.md`, `README.md`, and `docs/` must match
  reality — never document a feature as if it exists before it does. If you
  change behavior, update the relevant doc in the same PR (including the
  `docs/ROADMAP.md` "Done" list).
- **Security is non-negotiable.** The server must stay bound to `127.0.0.1`, with
  the Origin check on WebSocket upgrades and the bearer token on REST/WS. See
  [SECURITY.md](SECURITY.md).

## Project layout

```
server/index.mjs      backend bootstrap + sessions/PTY + routes + WebSocket
server/src/           log.mjs · persist.mjs (atomic state) · claude.mjs (ALL
                      claude-internals: transcript parsing, pricing, drift alarm)
server/hook-post.mjs  runs inside panes; relays Claude Code hook events
web/src/              React + TS frontend, built to web/dist (served by the server)
docs/                 ARCHITECTURE, GOTCHAS, ACCOUNTS, ROADMAP, CLAUDE_INTERNALS
```

`CLAUDE.md` is the working agreement (owner preferences, locked decisions);
`docs/GOTCHAS.md` collects hard-won traps — **read it before touching server
code.**

## Dev setup

Requires **Node 22+** and a working **[Claude Code](https://claude.com/claude-code)**
install (`claude` must run in a terminal on its own). Windows is the tested
platform; macOS/Linux are supported in code but not yet verified on hardware.

```bash
cd server && npm ci      # exact, reproducible install (node-pty is native)
cd ../web  && npm ci && npm run build
cd ../server && npm start # → http://127.0.0.1:7777
```

- `npm run watch` in `web/` rebuilds `web/dist` on change; a **running server
  serves the new build from disk without a restart** — just reload the tab.
- **Server-code** changes need a restart. Check port 7777 for a stale instance
  first — an old server silently missing new endpoints looks like "the feature
  is broken." (`docs/GOTCHAS.md` — the #1 recurring trap.)
- Avoid `npm run dev` (`--watch`) unless you know it will restart the server and
  drop every live pane on each save.

## Before you open a PR

1. **Frontend typechecks, tests, builds:** `cd web && npx tsc --noEmit && npm test && npm run build`
2. **Server parses:** `node --check` on `server/index.mjs`, `server/hook-post.mjs`,
   and every `server/src/*.mjs`
3. **Smoke test passes:** `cd server && npm test` (boots a real server on an
   isolated data dir against a keep-alive `claude` stand-in; drives REST + WS +
   the hook relay).
4. **Verify user-facing behavior against a real `claude` pane.** The smoke test
   and a green build are necessary but not sufficient — Helm depends on
   undocumented `claude` internals (see `docs/CLAUDE_INTERNALS.md`). The
   throwaway-script pattern in `docs/GOTCHAS.md` ("Testing pattern that works")
   is how features get verified end-to-end here. **"Build passing" ≠ "working."**

CI (`.github/workflows/ci.yml`) runs the server syntax check, frontend
typecheck + build, `npm audit`, and the Windows smoke test on every push/PR.

## Style

Match the surrounding code — same naming, comment density, and idiom. Comments
should explain *why* (a constraint or a non-obvious trap), not narrate *what*.
The codebase favors small, direct functions over abstraction; please don't add
speculative layers ahead of a concrete need.

## Reporting bugs / security issues

- Bugs and feature ideas: open a GitHub issue with repro steps and your
  `claude` / Node / OS versions.
- Security vulnerabilities: **do not** post exploit details publicly — see
  [SECURITY.md](SECURITY.md) for private reporting.
