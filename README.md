# Helm ⎈

A local **operations hub for Claude Code**: one screen with a workspace sidebar
and a grid of live `claude` terminal panes — real CLI sessions you can read,
type into, and monitor. Run several agents in parallel across your projects and
see their working at a glance instead of juggling terminal windows.

![Helm — a workspace sidebar and a grid of live Claude Code panes](docs/screenshot.png)

## Features

- **Live terminal grid** — every pane is a real Claude Code CLI session
  (node-pty + xterm.js), grouped by workspace (project folder). No API keys and
  no custom agent loop: these are your normal `claude` subscription sessions.
- **Status at a glance** — working / waiting-for-input / idle badges with
  elapsed time (spot a stuck agent at "working 45m"), driven by Claude Code
  hooks (not output scraping), desktop notifications when a pane needs you,
  and a "(N waiting)" tab title.
- **Sessions survive refreshes** — a browser reload never kills a session;
  panes repaint instantly from a replay buffer. After a *server* restart, panes
  come back as revivable and one click resumes the same conversation
  (`claude --resume`) — or flip on auto-revive and they come back by themselves.
- **Broadcast** — type one instruction into several panes at once
  ("commit your work, then summarize where you're at").
- **Attach images & files** — paste a screenshot, drag-drop a file, or use the
  paperclip button. Helm saves it locally and types its path into the pane —
  the same mechanism as dropping a file on a native terminal — and Claude
  reads it from disk.
- **Multi-account** — run panes on different Claude subscriptions side by side
  via isolated profiles, no logout/login switching
  (see [docs/ACCOUNTS.md](docs/ACCOUNTS.md)).
- **Usage tracking** — tokens per pane and a per-account roll-up (rolling
  windows from 1 h to 30 d plus all time, broken down by model).
- **Pane identity & comfort** — names and accent colors (random, editable),
  drag panes to reorder the grid, maximize (Ctrl+Shift+M; Esc restores),
  find-in-scrollback (Ctrl+Shift+F), copy-on-select, clickable links, and a
  live server debug drawer.
- **Install as an app** — a PWA manifest lets Chrome/Edge install Helm as a
  desktop app, no Electron involved.

## Requirements

- **Windows** is the tested platform. macOS/Linux are supported in code
  (plain `claude` spawn, `~/.helm` data dir) but not yet tested on real
  hardware — reports and fixes welcome.
- **Node.js 22+**
- **[Claude Code](https://claude.com/claude-code)** installed and logged in —
  `claude` must work in a terminal on its own

> `node-pty` is a native module. If `npm install` fails in `server/`, you may
> need the standard Windows build tools (Visual Studio Build Tools + Python).

## Quick start

```bash
cd server && npm install
cd ../web  && npm install && npm run build
cd ../server && npm start        # → http://127.0.0.1:7777
```

Open http://127.0.0.1:7777, add a project folder as a workspace, and hit
**New pane**. Set the `PORT` environment variable to use a different port.

## How it works

```
Browser (React + xterm.js grid) <--WS/REST--> Node server <--PTY--> claude.cmd
                                                   ^ hook relay POSTs (status)
```

- REST creates and kills sessions; WebSockets only *attach*. Closing the tab
  never kills a PTY — sessions outlive sockets by design.
- Each pane is spawned with `--settings` pointing at a generated hook config,
  so Claude Code's own hook events (SessionStart / UserPromptSubmit / Stop /
  Notification) are relayed back to Helm. That powers the status badges,
  conversation revive, and usage — no terminal-output scraping, and no
  profile's settings.json is ever modified.
- No database: state is a few JSON files under `%LOCALAPPDATA%\Helm`.

Details in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Security model

A terminal server without auth would let any webpage you visit run commands on
your machine. Helm's defenses:

- The server binds to **127.0.0.1 only** — nothing is exposed to your network.
- Every REST and WebSocket call requires a **bearer token**, generated on first
  run and injected into the page by the server. WebSocket upgrades also check
  the **Origin** header.
- Tokens, session state, and account profiles live in `%LOCALAPPDATA%\Helm`,
  never in this repo.
- Everything runs locally — no cloud services, no telemetry, $0.

Full threat model, what's out of scope (multi-user/remote is **not** supported),
and how to report a vulnerability: [SECURITY.md](SECURITY.md).

## Docs

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — API, spawn details, hook relay
- [docs/ACCOUNTS.md](docs/ACCOUNTS.md) — multi-account profiles
- [docs/GOTCHAS.md](docs/GOTCHAS.md) — known traps (read before touching server code)
- [docs/ROADMAP.md](docs/ROADMAP.md) — done + planned
- [CHANGELOG.md](CHANGELOG.md) — release notes
- [CLAUDE.md](CLAUDE.md) — working agreement for Claude Code sessions on this repo

## Contributing

Issues and PRs welcome — see [CONTRIBUTING.md](CONTRIBUTING.md) for dev setup,
the pre-PR checklist, and the project's simplicity/security ground rules.
Security vulnerabilities: please report privately per [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE)
