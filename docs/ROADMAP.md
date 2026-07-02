# Helm — Roadmap

This file is auto-loaded into every session (via @ in CLAUDE.md) — keep it
tight. When a feature lands, move it to Done as a few words, not a paragraph.

## Done (all script-verified end-to-end)
PTY↔WS↔xterm slice (sessions outlive sockets, ring-buffer replay) · workspace
sidebar + pane grid · auth (localhost + Origin check + persistent token,
auto-reload on 401) · multi-account profiles (emails in picker, delete,
auto-/login) · hook relay → status badges (working/waiting/idle) · session
persistence + revive (`claude --resume`) · usage per pane + per-account
roll-up (rolling 1 h–30 d + all-time windows, per-model, cached) · desktop
notifications + "(N waiting)" title · pane names/colors (random, editable) ·
pane maximize · themed modals · node-pty kill-race crash guard · broadcast
prompt to many panes · auto-revive toggle · 🐞 debug drawer (live server log).

Also: GitHub release prep (2026-07-02) — MIT license, .gitignore/.gitattributes,
CI build check, public README.

## Short-term backlog (rough priority order, owner-approved direction)
1. **Drag to reorder / resize panes** in the grid.
2. Last un-themed UI bits: workspace-add as a modal, error toasts instead of
   inline red text.
3. Font-size / theme settings.

## Proposed by code review 2026-07-02 (not yet owner-prioritized)
- macOS/Linux support (spawn `claude` not `claude.cmd`, portable data dir).
- "working for 7 m" elapsed time on status badges (spot stuck agents).
- PWA install manifest ("install as app" without Electron).
- Ctrl+F scrollback search in panes (@xterm/addon-search).
- Keyboard shortcuts (cycle panes, maximize, new pane).
- Git branch + dirty indicator per workspace in the sidebar.
- Confirm dialog before killing a pane that is actively working.
- Persist resumable `exited` sessions across server restarts (today only
  running/dead ones survive as revivable).

## Bigger ideas discussed with owner (not committed)
- Remote access from phone/laptop via Tailscale (origin/token checks already
  exist; would need an HTTPS story and origin allowlist).
- "Install as app" shortcut + auto-start-server task for a native-app feel
  (deliberately chosen over Electron — see locked decisions in CLAUDE.md).
- Cost estimates ($) in usage views, not just tokens.
