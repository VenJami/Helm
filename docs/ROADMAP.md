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
prompt to many panes · auto-revive toggle · 🐞 debug drawer (live server log) ·
drag-to-reorder panes (⠿ grip, per-workspace order in localStorage) ·
"working 7m" elapsed time on badges · find-in-scrollback (Ctrl+Shift+F) ·
Ctrl+Shift+M maximize · kill-confirm for mid-task panes · PWA install manifest
+ icon · exited sessions persist as revivable · revive falls back to fresh
when the transcript was never written (claude ≥2.1.198 — GOTCHAS) ·
usage-cache cap · macOS/Linux spawn + data dir (code support — untested
off-Windows) · attachments: paste/drop/pick a file into a pane (saved locally,
path typed into claude like native drag-drop; model-read verified).

Also: GitHub release prep (2026-07-02) — MIT license, .gitignore/.gitattributes,
CI build check, public README.

UI redesign (2026-07-02) — Linear-style dark theme (near-black surfaces,
hairline borders, amber accent; reference screenshot kept locally in
docs/context/, gitignored) + inline SVG icon set replacing all emoji icons
(web/src/components/Icons.tsx).

Hide-sidebar toggle (2026-07-02) — collapse button in the sidebar header +
reveal button in the toolbar; state persisted in localStorage.

Animated icons (2026-07-02) — owner reversed the "zero icon deps" rule; added
`motion` (framer-motion) and copied animate-ui's icons + animations VERBATIM
into web/src/components/AnimatedIcons.tsx (paperclip=attach, maximize=expand,
chart=usage, nfc=broadcast, search, chevron up/down), wired to a trimmed port of
their base in components/animate-ui/icon.tsx. Not via `shadcn add` (no shadcn
scaffolding here). Each icon-button is wrapped in <AnimateIcon asChild> so the
animation fires on the whole button's hover, not just the icon. Static Icons.tsx
still holds the non-animated icons.

Usage tracking repaired (2026-07-02) — panes had stopped writing transcript
JSONLs on claude 2.1.198 (inherited CLAUDE_CODE_CHILD_SESSION + agent-teams
mode; both dissected in GOTCHAS). spawnPty now scrubs the inherited claude env
and disables agent teams in panes; usage scans (account roll-up + per-pane)
also pick up nested subagent transcripts. Verified E2E on an isolated server.

Animated target cursor (2026-07-02) — React Bits TargetCursor ported to TS
(web/src/components/TargetCursor.tsx, adds gsap): amber dot + spinning corner
brackets that lock onto sidebar items. Scoped to the sidebar only (owner found
the full-page version overwhelming); normal cursor everywhere else; desktop only.

Amber favicon (2026-07-03) — icon-192/512.png recolored from blue to the
theme's amber accent (#e2b34c); dist copies updated too (served from disk, no
rebuild needed).

Manage profiles modal (2026-07-03) — "Manage profiles…" in the profile
dropdown opens a list of all profiles with per-row rename (pencil) and delete
(trash) actions; new PATCH /api/profiles/:name server route renames the
account dir and repoints any session/workspace still referencing the old
name. Removed the standalone "Delete profile" button from the toolbar next to
Broadcast — deletion now lives only in the manage-profiles modal.

Per-workspace pinned account (2026-07-03) — each workspace can pin its own
profile (`profile` field on the workspace, `PATCH /api/workspaces/:id`); the
toolbar picker became per-workspace (selecting a project loads its account,
changing it re-pins that project), so project 1 → account 1 and project 2 →
account 2 give separate usage. Sidebar shows each workspace's account. New
profiles and deletes keep the pins in sync. Verified against an isolated server.

Profile picker redesign (2026-07-03) — native `<select>` replaced with a themed
dropdown (web/src/components/ProfileSelect.tsx): closed trigger shows the
account name only, the open menu shows emails + a "new profile" entry; the toolbar
workspace-name text became a "Profile" label (workspace name lives in the
sidebar). Verified headless against the live server.

Move pane to another account (2026-07-03) — user-switch button on each pane
opens an account picker (emails shown; mid-task switches confirm first). The
server copies the conversation transcript into the target profile's store and
respawns claude inside the same pane with `--resume`: same chat, new login,
attached sockets survive the swap (spawnPty now ignores a replaced PTY's
stragglers). New `POST /api/sessions/:id/switch-profile`; an
imported-transcripts ledger keeps per-account usage honest (copied history
still counts against the source account only). Verified E2E on an isolated
server: conversation carried (model recalled pre-switch content), same session
id (no resume fork), ledger excluded imported turns.

Minimize pane to tray (2026-07-04) — new minimize button (`—` icon) on each
pane's header, separate from maximize/un-maximize; minimizing hides the pane
(session/PTY keeps running in the background) and drops a small pill into a
tray strip above the grid — click the pill to restore. Grid column count
adjusts to the visible (non-minimized) pane count.

Usage modal enrichment (2026-07-04) — "Usage by account" redesign: grand-total
banner across accounts, always-visible last-active + all-time per account (so a
profile last used earlier never reads as "no data" — the reported bug), totals
now include cache (read+write) and turns, plus a rough $ estimate per
model/window/account from a published-price table (server
`MODEL_PRICING`/`tokenCost`; cache priced at 0.1x read / 1.25x write). Default
window moved 5 h → 7 d so recently-used profiles show on open. `/api/usage`
gained `lastActive` + per-window cost + split cacheWrite; per-pane usage gained
per-model cost. Duplicate-login rows (same email as another account, incl. the
default) are flagged, and the default row carries a `DEFAULT` tag to
disambiguate borrowed names. Verified E2E on an isolated server (real
transcripts, headless-screenshotted modal). NB: the CLI's own Session/Weekly
limit % (native Account panel) are a live Anthropic call, not on disk — Helm
shows local token/cost only, by owner's choice ($0, no API).

Auto-map default onto its twin profile (2026-07-04) — when the bare default
account (`~/.claude`) is signed into the same email as a named profile that has
stored creds, Helm collapses them: the picker (toolbar + per-pane "move to
account") stops showing a separate "default DEFAULT" row, and panes that ask for
default spawn under that profile's config dir instead, so usage lands in one
place. Server `mappedDefaultProfile()`; `/api/profiles` returns `default.mapped`;
`createSession` resolves an empty profile through it. Default still shows as its
own account when unique or when the twin isn't signed in (bootstrap). The usage
modal's historical default row is left intact (real past tokens).

Waiting-pane jump + pane cycling + richer alerts (2026-07-04) — toolbar
"N waiting" pill jumps to the next blocked pane (rotates on repeat, crosses
workspaces, scrolls + amber-pulses it); Ctrl+Shift+←/→ cycles focus through a
workspace's visible panes (App fires a `helm:focus-pane` event the pane listens
for). Hook `Notification` messages now flow through the server
(`session.activityNote`, exposed on `sessionInfo`) and show on the pane badge
("waiting · Claude needs permission to…") and in the desktop alert instead of a
generic "needs your input". Also fixed: deleting a profile now clears its
workspace pins + session references server-side (previously only rename did —
a dangling pin could re-create an empty, logged-out account dir).

Workspace right-click menu + no browser context menu (2026-07-04) — the browser's
default right-click menu is suppressed app-wide (owner found it distracting);
real form inputs keep their native menu so paste still works, the terminal's
hidden textarea does not. Right-clicking a workspace in the sidebar opens a
themed menu: Rename / Change root directory / Remove. Rename + change-dir edit
inline in the row (Enter saves, Esc/blur cancels); `PATCH /api/workspaces/:id`
now accepts `dir` (validated as a real directory, dupe-checked; running panes
stay tied to their old cwd, only new panes use the new root).

Server console launcher + show/hide button (2026-07-04) — `start-helm.cmd` at
the repo root opens the server in a real console window (keeps it open on
crash/stop). A toolbar "Console" button toggles that window (`GET/POST
/api/console`, Windows-only via a PowerShell GetConsoleWindow+ShowWindow
P/Invoke); the button hides itself when the server was launched detached with no
console (`supported:false`). Verified E2E against the real console window.

Workspace running status (2026-07-04) — each workspace can carry a dev-server
`port` (right-click menu → "Set dev-server port…"); the sidebar shows a
green/red dot + `:port` from a TCP-connect check (`GET /api/workspaces/servers`,
1 s cap, App polls every 4 s). The claude-pane badge also split into working
(green) / waiting (amber) counts instead of one running number. POST/PATCH
`/api/workspaces` validate `port` (1–65535, null clears); covered by the smoke
test.

Git branch/dirty per workspace + smoke test (2026-07-04) — sidebar shows each
workspace's git branch, a dirty dot, and ahead/behind counts (new
`GET /api/workspaces/git`, best-effort with a 2 s cap; App polls it every 6 s).
Added a committed smoke test (`server/test/smoke.mjs`, `npm test`) that boots a
real server on an OS-assigned port + isolated data dir against a keep-alive
`claude` stand-in and drives REST + WS replay + the hook relay (auth, session
lifecycle, activityNote set/clear, git status, profile-delete pin cleanup); a
windows-latest CI job runs it (node-pty native, matches prod).

## Short-term backlog (rough priority order, owner-approved direction)
1. Last un-themed UI bits: workspace-add as a modal, error toasts instead of
   inline red text.
2. Font-size / theme settings.
3. Drag-resize pane sizes (reorder is done; resize = grid column/row weights).

## Bigger ideas discussed with owner (not committed)
- Remote access from phone/laptop via Tailscale (origin/token checks already
  exist; would need an HTTPS story and origin allowlist).
- "Install as app" shortcut + auto-start-server task for a native-app feel
  (deliberately chosen over Electron — see locked decisions in CLAUDE.md).
