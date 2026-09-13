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
own account when unique or when the twin isn't signed in (bootstrap). (The usage
modal originally kept a separate historical default row; superseded 2026-07-04 —
see "Fold default into its twin in usage" below.)

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

Error toasts (2026-07-04) — themed bottom-right toast stack
(`components/Toaster.tsx`) with a module-level `toast.error/success/info` event
bus (like `helm:focus-pane`, no prop-drilling); above modals so an action's
failure shows even with a dialog open. Replaced the toolbar's jammed inline red
text and pane revive-error overlay; in-modal field validation stays inline.

Command palette + font size + persisted layout + build hygiene (2026-07-04) —
Ctrl/Cmd+K opens a quick switcher (`components/CommandPalette.tsx`): filters
panes (by pane + workspace name) and workspaces across everything, arrow/enter
nav, reuses `focusPane` to jump (selects workspace, un-minimizes, scrolls +
pulses). Workspace-add is now a themed modal (dir/name/pinned-profile/port),
replacing the inline sidebar form. Global terminal font size (toolbar A−/A+,
`helm.fontSize`, 11–20 px) applied live to every xterm with a refit + WS resize.
Maximize/minimize layout persists across reloads (`helm.maximized` /
`helm.minimized`, stale ids pruned once sessions load). Bundle code-split via
Vite `manualChunks` (xterm/react/motion/gsap split out; main chunk 835 KB → ~69
KB, size warning gone). Smoke test grown to 8 (workspace dir-change, port
set/clear, console shape/toggle).

Content-based pane titles + search discoverability (2026-07-04) — each pane gets
an auto-title from its conversation's first real user prompt (server
`firstPromptSummary` off the transcript, skips meta/command/system lines, cached;
`summary` on `sessionInfo`), shown in the pane header and matched by Ctrl+K
search so you can find a pane by what it's doing, not just its star-name. A
visible toolbar search pill (🔍 "Search panes…" + ⌘/Ctrl K hint) makes the
palette discoverable instead of a hidden shortcut. Smoke test covers the
summary derivation (now 9 tests).

Empty-workspace fix + drag-to-reorder workspaces + sidebar search (2026-07-04)
— the "no panes" placeholder had 3 CSS-grid children (text/`<b>`/text) each
blockified into its own auto-row that stretched to fill the pane and centered
independently, spreading the message across the whole canvas; fixed by
wrapping it in one child, and it now also carries a "+ New pane" button.
Sidebar workspaces get the same grip-drag reorder panes already had
(`helm.wsorder` in localStorage, unlisted new workspaces fall to the end) plus
a search-workspaces input above the list. Verified against the live server
(headless-Edge screenshots: empty state, filtered list, grip present on every
row).

Fold default into its twin in usage (2026-07-04) — when the bare default
account is the same login as a named profile (`default.mapped`, the existing
auto-map), the usage roll-up now folds default's local history into that
profile's row and hides the standalone default row — matching what the profile
picker already does, so one Anthropic login reads as one account instead of two
split rows. Client-side only (`foldMappedDefault` in web/src/accounts.ts sums
windows+models; App uses it via a `usageRows` memo) so no server restart / no
pane deaths; grand total is unchanged (fold only moves numbers between rows).
Owner context: their default account is heavily used by the VS Code Claude
extension (dev work) and shares its login with the Claude-2
profile — folding gives Claude-2 the true combined total (~978M tokens E2E-
verified: default row gone, "same login" tag gone, Claude-2 carries the sum).

Hardening pass 1 (2026-07-05) — atomic state writes (temp+rename + `.bak`,
loud recovery from corruption instead of silent first-run wipe;
`sessions`/`workspaces` files now `{version:1,...}` wraps, legacy bare-array
shape still loads) + crash policy (fail-fast boot, keep-alive after: post-boot
uncaught errors log to the 🐞 drawer instead of killing every pane; the
persist call inside PTY callbacks/timers guarded) + node-pty pinned exact
1.1.0 (the `^1.0.0` range had already silently floated 1.0.0→1.1.0; a float
can disarm the kill-race guard's filename match). First slice of the
improvement plan (P1-1/P1-2; plan folder lives outside the repo, in
`../helm-improvement-plan`). Verified E2E on an isolated server: 6/6
corruption/recovery checks + the 9-test smoke suite green.

Loud claude-drift alarm (2026-07-05) — Helm parses claude's undocumented
on-disk formats, so a claude update used to silently zero out usage/status/
revive. Now surfaced: boot-time `claude --version` check (floor 2.1.198) +
parse-time signals (unknown model in `MODEL_PRICING`, a >16 KB transcript that
yields 0 usage entries) → `GET /api/diagnostics` → dismissible top-of-main
banner (`web/src/components/DriftBanner.tsx`, per-warning-key dismissal in
localStorage). New `docs/CLAUDE_INTERNALS.md` catalogues every assumed
format/field/env/flag in one place. Improvement-plan P1-3. Verified E2E: 9/9
drift checks (healthy/below-floor/missing/unknown-model/transcript-shape) on
isolated servers; committed smoke test now asserts diagnostics health (10
tests, 1 skip).

Pane render perf (2026-07-05) — the 3 s session poll returned fresh objects
every tick, so every `TerminalPane` reconciled forever, and all panes stayed
mounted when minimized/behind a maximized one (each holding a WebSocket + its
own WebGL context; browsers cap ~16). Now `TerminalPane` is `React.memo` with
stabilized `session`/`profiles` references (reuse the prior poll's object when
unchanged, via a `shallowEqual` cache) + stable callbacks; the grid mounts only
visible panes (`visiblePanes`), so minimized/hidden ones unmount and free their
socket + WebGL context (restore reconnects, ring buffer replays). A 20 s
internal tick keeps "working Nm" labels advancing despite the stabilized object.
Improvement-plan P1-4. Verified E2E via headless Edge against an isolated 6-pane
server (13/13: minimize unmount + tray, restore remount + replay, maximize
mounts one, grid columns track visible count, memo skips unchanged panes).

Open-source hygiene (2026-07-05) — added SECURITY.md (honest threat model:
loopback + token + Origin; explicitly out-of-scope = multi-user/remote; the
token file is the whole boundary; private vuln reporting) and CONTRIBUTING.md
(dev setup, pre-PR checklist, simplicity/security ground rules, the real-pane
verification requirement). README gained the screenshot + links to both. CI
switched the server job to `npm ci` (reproducible, matches the pinned node-pty)
and added `npm audit --audit-level=high` to both jobs (still a hard gate).
Improvement-plan P1-5, finishing Phase 1. Deliberately deferred ESLint/Prettier
to the Phase 3 tooling pass — bolting a linter onto a never-linted ~2.6k-line
codebase risks a red CI that blocks pushes, and it pairs naturally with the
planned backend-typecheck work.

Usage off the hot path + typed WS protocol (2026-07-05) — a usage poll used to
synchronously re-read every changed transcript in full (an active multi-MB
JSONL re-parsed every tick) on the same thread as all PTY I/O, stuttering every
pane. Now: transcripts parse incrementally (byte-offset + partial-line tail
buffer, `readAppendedLines`; dedupe map persists across increments), the
account roll-up is TTL-cached ~15 s with in-flight dedupe
(`HELM_USAGE_TTL_MS`, invalidated on account switch), scans yield between
files, `firstPromptSummary` reads only appended bytes and its cache is capped.
Measured on a 9.4 MB transcript: 99 ms cold → 6 ms after append → 2 ms
unchanged; roll-up cache hit 1 ms. Also: the WS wire contract is now a shared
TS union (`WsServerMsg`/`WsClientMsg` in web/src/types.ts; all client frames go
through a typed `sendWs`), mirrored in a server comment. New committed smoke
test drives the REAL `hook-post.mjs` relay as a child process and asserts the
usage engine end-to-end (streaming dedupe last-wins, $ cost, 1 h window,
incremental append, half-written-line holdback) — 11 tests, 1 skip.
Improvement-plan P2-1 + P2-2 + P2-5 (server side).

Backend module split, slice 1 (2026-07-05) — extracted from the ~1.6k-line
index.mjs into `server/src/`: `log.mjs` (dbg + 🐞 ring buffer, `logsSince`),
`persist.mjs` (atomic writes + .bak recovery), and `claude.mjs` — the single
home for every claude-internals assumption (version check + drift diagnostics,
MODEL_PRICING/tokenCost, incremental transcript parsing, transcriptFiles,
firstPromptSummary, accountEmail), so claude drift is a one-file fix. index.mjs
keeps sessions/PTY/routes/WS (further split deferred until it earns its cost).
CI syntax-checks `server/src/*.mjs`; docs repointed (CLAUDE.md, ARCHITECTURE,
CONTRIBUTING, CLAUDE_INTERNALS, GOTCHAS). Improvement-plan P2-3 slice 1.
Behavior-preserving — verified: 11-test smoke suite + all three E2E suites
(atomic 6/6, drift 9/9, usage-perf 6/6, identical timings).

Frontend unit tests (2026-07-05) — vitest (dev-only dep, owner-approved) +
`web npm test` in CI; covers the money-adjacent client math in
web/src/accounts.ts: `accountLabel` naming rules and `foldMappedDefault`
(fold-into-twin, grand-total invariance, window-key union, per-model merge,
lastActive max, input immutability, no-op cases). 10 tests. Finishes
improvement-plan P2-5 → Phase 2 complete.

Real-claude e2e check (2026-07-05) — `cd server && npm run e2e`
(`server/test/e2e-real.mjs`) drives the ACTUAL claude CLI end-to-end: spawn →
folder-trust dialog → SessionStart/UserPromptSubmit/Stop hooks → status badges
→ transcript + usage + auto-title → server restart (dead+revivable) → revive
(--resume keeps the same conversation). Runs against isolated Helm state
(`HELM_DATA_DIR`, new) so the real store is untouched; needs a logged-in claude
and spends a few tokens, so it's NOT in CI. Verified 10/10 against claude
2.1.201 (fable-5). Also added `HELM_DEBUG_HOOKS=1` (dumps raw hook payloads to
the 🐞 log — spot claude field drift fast). Turns the throwaway-script pattern
from GOTCHAS into a permanent artifact. Improvement-plan P3-3.

Backend typechecking (2026-07-05) — the server ships as plain `.mjs` but is now
type-CHECKED: `server/tsconfig.json` (`checkJs`+`noEmit`, lenient — strict off,
noImplicitAny off) + `npm run typecheck` (`tsc`), wired into CI's smoke job.
Types come from JSDoc: `@typedef Session` + a `ParsedTranscript`-style tuple for
`USAGE_WINDOWS`/`MODEL_PRICING`, `NodeJS.ErrnoException` on the listen handler,
env as `Record<string,string|undefined>`. Dev deps added (owner-approved P3-1
direction): typescript + `@types/node|express|ws`. Tests excluded from the check
(validated by running; loose `res.json()` shapes = noise). 0 errors; zero
runtime change (JSDoc is comments). Improvement-plan P3-1.

Observability + graceful shutdown + first release (2026-07-05) — `GET /health`
(unauthenticated loopback liveness: pid/uptime/claude version/session counts —
the stale-server check without the token); `dbg` entries now carry a coarse
`level` (error for error/drift tags) + an optional `HELM_LOG_FILE` disk sink
(survives restarts, no rotation); SIGINT/SIGTERM handler persists sessions and
stops panes so claude children don't orphan. Cut the first tagged release:
`CHANGELOG.md` (Keep a Changelog) + `v0.1.0`. Smoke test now covers /health (12
tests). Improvement-plan P3-5.

Typed localStorage module (2026-07-09) — new `web/src/lib/storage.ts`
centralizes every UI-preference key (wsorder, workspaceId, notify, maximized,
minimized, fontSize, sidebarHidden, per-workspace paneorder) behind typed,
validated accessors: corrupt/missing values fall back to defaults instead of
throwing into render, every access is guarded (private mode/quota), and
removing a workspace now prunes its orphaned `helm.paneorder.<id>` key (they
used to accumulate forever). App.tsx no longer touches localStorage directly
(9 scattered string-literal sites removed); `api.ts` keeps its self-contained
`helm.reload401` sessionStorage guard. 8 new vitest tests (18 total). First
slice of improvement-plan P3-2 (App decomposition). Verified: tsc + build +
headless-Edge render against an isolated seeded server.

Data-layer hooks (2026-07-09) — App decomposition slice 2: the polling engine
moved out of App.tsx into `web/src/hooks/` — `useSessionsPoll` (3 s session +
profile poll, stable-reference cache for React.memo, edge-triggered desktop
notifications) and `useWorkspaceStatus` (git 6 s / dev-server 4 s). App now
consumes `{sessions, profiles, refresh, …}` and keeps only optimistic updates
via the returned setters + one-shot boot fetches. Behavior-preserving move
(logic byte-identical); App.tsx 1,379 → 1,238 lines. Improvement-plan P3-2
slice 2. Verified: strict tsc, 18 vitest tests, build, headless-Edge render on
an isolated seeded server (badge counts, profile email, live pane all polling).

Modal extraction (2026-07-09) — App decomposition slice 3: all five dialogs
moved out of App.tsx into `web/src/components/modals/` (NewProfile,
AddWorkspace, Profiles, Usage, Broadcast), each owning its draft state and —
where sensible — its API call (add-workspace create, broadcast send, usage
fetch-on-open). The old manage/edit/delete-profile trio collapsed into ONE
ProfilesModal with an internal view state, so App's Dialog union is 5 simple
kinds and `closeDialog` is just `setDialog(null)` (the fragile 8-field manual
reset is gone — a modal's draft dies with the modal). App.tsx 1,238 → 786
lines (1,379 at the start of P3-2). Verified: strict tsc, 18 vitest tests,
build, and a CDP-driven headless-Edge check that clicks the toolbar Usage
button and screenshots the extracted modal fully rendered (chips, grand total,
per-model bars). Improvement-plan P3-2 slice 3.

Focus ref-map (2026-07-09) — App decomposition slice 4 (final): jumping/cycling
to a pane now goes through registered imperative handles (each grid slot
registers its element for scrollIntoView; each TerminalPane registers a
"focus my terminal" fn via a stable `onRegisterFocus` prop) instead of the old
dual coupling — `getElementById('pane-<id>')` + a `helm:focus-pane` window
event every pane string-matched. The toast bus stays (it's a legitimate
broadcast). Improvement-plan P3-2 complete. Verified: tsc/vitest/build + a
CDP check driving Ctrl+Shift+→ and confirming focus lands in the pane's xterm
textarea with the flash pulse firing.

Theme settings (2026-07-09) — Appearance dialog (palette icon next to the font
stepper): dark/light theme toggle + five accent presets (amber default, blue,
green, violet, rose), applied instantly as `data-theme`/`data-accent`
attributes on `<html>` and persisted (`helm.theme`/`helm.accent`, validated in
lib/storage). The whole palette now lives in CSS variables (the ~18 stray
hardcoded colors were promoted to vars: hover/border-hover/scroll-thumb/
overlay/backdrop/on-inverse…), with a full light palette and per-theme accent
values so contrast holds on white. Terminal panes deliberately STAY dark in
light mode — claude's TUI/ANSI colors assume a dark background, so panes read
as dark cards on light chrome. New `hooks/useTheme` + `modals/AppearanceModal`.
20 vitest tests. Verified via CDP: opened the dialog, switched light+rose
(screenshot), back to dark+blue (screenshot), attributes + localStorage
round-trip asserted. Backlog item #1 done. (2026-08-27: the animated target
cursor was missing from that sweep — TargetCursor paints its dot/corners with
an INLINE style, which outranked the var(--accent) rules in its own CSS, so it
stayed amber through every accent/theme switch. Its cursorColor default is now
`var(--accent)`; CDP-verified amber→rose in dark and light.)

Drag-resize panes (2026-07-09) — thin gutters between grid columns/rows (amber
line on hover): dragging trades fr-weight between the two adjacent tracks (grid
total never changes), double-click resets an axis to equal. Weights persist per
workspace AND per layout (`helm.gridweights.<ws>` → `{c3:[…], r2:[…]}` —
3-column weights survive independently of 2-column), validated on read, pruned
with the workspace. Min 0.3fr per track keeps every pane usable; maximized view
has no gutters. New `hooks/useGridWeights` + `components/GridResizers` (pointer
capture, absolute snapshot math — no drift compounding). 21 vitest tests.
Verified via CDP: dragged a column and a row on a 4-pane grid (template
0.53fr/1.47fr/1fr…), asserted persistence + restore across reload, screenshot.
Backlog item #2 done — the short-term backlog is now EMPTY.

Hardening pass 2 (2026-07-10) — closed the critique's remaining security soft
spots (improvement-plan finding M3): constant-time token compares
(bearer/hook/WS — no timing oracle for a drive-by page); profile names now
regex-validated on the workspace pin routes too (the one unvalidated entry
point — latent path traversal into `accounts\`); hook-reported transcript
paths accepted only when inside the session's own account store (`.jsonl`
under `configRoot/projects`; the path is later fed to file reads/copies), with
rejections surfacing as a loud drift warning since a claude update that moves
its transcript dir must not fail silent; WS Origin-absent decision documented
in code + SECURITY.md (browsers always send Origin; absent = non-browser
client, gated by the token alone). Smoke suite grown to 13 (trust-seams test);
verified with the real-claude e2e 10/10 on claude 2.1.205. Left open by
choice: per-session hook tokens (a malicious local process is out of scope —
SECURITY.md; it can read the UI token file directly), the console toggle's
Add-Type recompile (M7, cost smell only), one-frame replay gap (L2, cosmetic).

ESLint + Prettier (2026-07-10, owner-approved deps) — the tooling pass
deferred since P1-5: flat ESLint configs in both packages (correctness rules
only — js/ts recommended + react-hooks; vendor animate-ui/ excluded; zero
warnings enforced) and Prettier owning style (single quotes, 100 cols; scoped
to code files — CSS left alone). Lint findings were few and real: unused
import, expression-as-statement, two mechanical hook-deps gaps fixed, one
load-bearing deps omission kept + documented with a targeted disable
(TerminalPane's build-once-per-session effect), dead e2e collector removed.
The whole-codebase reformat is its own commit, listed in
.git-blame-ignore-revs so blame skips it. `npm run lint / format /
format:check` in both packages; CI enforces lint + format. Verified: web
tsc/vitest 21/build, server typecheck/smoke 13, real-claude e2e 10/10.

Public-release polish (2026-07-10) — README overhauled around high-ROI
tactics (badges, "Why Helm?", FAQ, keyboard list); hero screenshot re-staged
on an isolated server with real claude panes but generic project names (the
old shot leaked the owner's real project/client list, and the ROADMAP leaked
an account username — both scrubbed at HEAD). CHANGELOG cut to v0.2.0 +
package versions bumped. Staging recipe (fake workspaces on a subst drive,
hook-event status pinning at zero token cost, headless-Edge capture at
deviceScaleFactor 1) lives in auto-memory, script in the session scratchpad.

Git history scrub (2026-07-11) — the two leaks above also lived in old
history (the `jaminaraven` username in prior ROADMAP versions; the leaky
screenshot blob from its first commit onward). Rewrote all 35 commits with
`git filter-repo` (username → `redacted`, old screenshot blob → the safe one)
and force-pushed `main` + both tags. HEAD tree unchanged (content preserved
byte-for-byte); every author/committer name+email+date+message identical to a
pre-rewrite backup bundle, so the contribution graph is intact. Old commit
hashes (≤ `e8ef2d6`) are dead. Residual: force-push doesn't purge GitHub's
dangling objects immediately — old blobs may linger by direct SHA until GitHub
GC; low-stakes here (username + project-name pixels), contact GH Support to
purge if it ever matters.

Ctrl+V paste in panes (2026-08-26) — plain Ctrl+V never pasted: xterm maps
ctrl+letter to a control char and calls preventDefault, so the browser's native
paste event never fired and the PTY just got ^V (Ctrl+Shift+V worked, and
right-click paste was off since the app-wide context-menu suppression). The
pane's custom key handler now returns false for Ctrl+V, which exits xterm's
key handling before that preventDefault and lets the native paste reach its
textarea. Image/file pastes still short-circuit earlier into the attach path.

Start button per project (2026-08-26) — each workspace card in the sidebar got
▶ / ■: it runs the project's start command (auto-detected from package.json
scripts the first time — `dev` → `start` → `serve` — then editable via
right-click → "Set start command…", stored as `startCommand` on the workspace).
The command runs in a real PTY as a **dev pane** (`kind:'dev'` session): same
terminal, scrollback, colors and Ctrl+C as any pane, but no hooks, no account,
no transcript/usage, and never a broadcast target. The pane is created
minimized — it sits in the existing tray so the claude grid is undisturbed, and
the card's terminal button opens/hides it (owner's requested shape). ■ is
`POST /api/sessions/:id/stop`, which kills the process but KEEPS the pane so a
crashed start stays readable; ▶ then restarts the same pane. Killing the pty
takes the whole cmd→npm→node chain with it (port really frees), and Helm's own
PORT is scrubbed from the dev env. Verified E2E on isolated servers against a
REAL npm dev server: 14/14 (detect→start→port up→output in pane→stop frees
port→restart→survives a Helm restart→delete stops the server) plus a CDP UI
pass (▶ → tray chip, grid untouched, logs open/close, green port dot). Smoke
suite now 15.

Multi-command start + "ask Claude how to start it" (2026-08-26) — the ▶ above
turned out to cover half of the owner's projects: `startCommand` became
`startCommands` (a LIST — this repo needs `cd server && npm start` AND
`cd web && npm run watch`; one dev pane each, named after the folder they cd
into), with `POST /api/workspaces/:id/start` starting them all and a new
`/stop` stopping them all. For projects whose files can't be guessed from (no
root package.json, a Python service, a subfolder monorepo — Helm, Nocturne,
CloseBy, Backend, Game1 among the owner's), ▶ now falls into a new
`POST /api/workspaces/:id/suggest-start`: the REAL claude CLI, headless and
read-only (`-p`, prompt on STDIN — claude.cmd needs a shell on Node 22 and the
prompt contains `&&`), answers with the commands, which land in the sidebar's
editor for the owner to accept (Ctrl+Enter saves *and* runs). It only ever
suggests — nothing saved or spawned unreviewed. No model pinned: Opus found
both of this repo's processes where Sonnet found one, and the owner's rule is
quality over marginal cost (~$0.12–0.56 a call, shown in the toast). Parser
lives in claude.mjs with two new drift keys; fake-claude grew a `-p` branch so
CI covers the whole route. Verified: smoke 17, plus 16/16 real-process E2E
(two servers up on their own ports, one ■ frees both, revive-in-place, claude
proposing this repo's real commands and NOT the pane-killing `npm run dev`) and
11/11 CDP UI (▶ → editor pre-filled → accept → both panes in the tray → logs
open/close → ■).

Audit advisories cleared (2026-08-26) — `npm audit --audit-level=high` had gone
red on BOTH jobs (main included): body-parser via express, postcss + nanoid via
vite, brace-expansion/js-yaml in dev tooling. First response was to make the
step informational, on a WRONG reading of `npm audit fix --dry-run` (its summary
line reports the pre-fix count, which was mistaken for "the fix changes
nothing"). Owner pasted the actual advisory list, all of which say "fix
available"; `npm audit fix` cleared every one — all patch-level, no declared
dependency changed, node-pty still pinned at exactly 1.1.0, web bundle hashes
byte-identical. The CI gate is a hard failure again. Lesson: read what a
dry-run actually reports before drawing a conclusion from it, and don't loosen
a gate until the cheap fix has genuinely been tried.

Public share links (2026-08-26, owner-approved dep) — VS-Code-style port
forwarding: each workspace with a dev-server port gets a globe button that
publishes it to the internet through a **Cloudflare quick tunnel**
(`server/src/tunnel.mjs`, `cloudflared tunnel --url`), giving a
`https://<random>.trycloudflare.com` link that's copied to the clipboard.
Because those URLs are UNAUTHENTICATED, the safety is three-layered and
deliberate: an un-suppressible warning dialog (no "don't ask again") spelling
out that there is no password; a red PUBLIC flag on the project plus an
always-visible red toolbar pill (`N public · Nm left`) so a forgotten link
can't hide; and a 30-minute self-expiry (click the pill to extend all, toast
warns at 5 min). Helm's own port is refused server-side (`BLOCKED_PORT`) since
its pages carry the auth token; links are never persisted (restart = fail
closed), and die with the workspace and on shutdown. cloudflared is detected on
PATH; a miss is re-probed every 10 s so installing it mid-session needs no
server restart (a permanent negative would have meant restarting and killing
every pane). Missing cloudflared opens an explainer dialog — what it is, that
installing it starts no service and opens no ports, the exact command, a copy
button, and "Install it for me" which runs winget/brew in a VISIBLE pane
(`POST /api/tunnels/install`, reusing the dev-pane machinery) so the owner
watches it and answers any elevation prompt. That revises the original
"detect, never install" call: the bare error toast was a dead end. The share
dialog also warns when nothing is listening on the port yet, so a Cloudflare
502 isn't a mystery. Owner testing then found the install loop broken two ways
(both now regression-tested, both in GOTCHAS): the pane ran bare `winget`,
which is an App Execution Alias that doesn't resolve for child processes (exit
1 in one second) — Helm now quotes the absolute WindowsApps path, found via
`lstat` since `existsSync` reports false for that symlink; and detection was
PATH-only, so a freshly installed cloudflared stayed invisible to the
already-running server (a process keeps its spawn-time PATH), which is why it
kept re-prompting even after a manual install — detection now probes known
install dirs and spawns the resolved absolute path. Re-verified 10/10 against
the real Cloudflare edge with cloudflared deliberately absent from PATH. Owner
then reported the link itself was invisible — correctly: the URL only existed
in a hover tooltip and a toast that vanished, and the sidebar pill copied
SILENTLY so it read as a dead button. Added a **Public links panel**
(`modals/SharesModal`) opened by the toolbar pill or the PUBLIC flag: every
live link with its full wrapped URL as a real clickable anchor, plus Copy
(with visible "Copied"), Open, Extend and Stop per link, and time remaining.
Verified 26/26 by CDP against a REAL tunnel (not the stub), including that the
whole URL is readable rather than scrolled out of sight. Smoke suite 21 (every refusal + the full
lifecycle against a `fake-cloudflared` stand-in) and 17/17 CDP UI checks, plus
10/10 against the REAL binary and the REAL Cloudflare edge (cloudflared
2026.8.2, run from a throwaway copy so the owner's machine stays clean): a
test origin was published, fetched back over the public internet, then torn
down — banner parse ~6 s, anonymous (no account), edge 502s after stop, no
stray processes. SECURITY.md gained a section: this is the one feature that
intentionally leaves loopback.

Sidebar + toolbar layout fix (2026-08-27) — project names in the sidebar were
being crushed to "N…" / "W.": the row's action buttons were hidden with
`visibility: hidden`, which still reserves the box, so ~72px of every 192px row
went to invisible buttons (GOTCHAS). Rows were also four stacked lines tall
(82px) and ragged. Now: the name gets its own line and account · branch · port ·
pane-count share ONE meta line that ellipsizes instead of growing (every card
43px, uniform), the actions moved out of flow into a hover overlay that fades
over the row (only the dev-logs button stands without hover, and it's the one
line of reserved width), and the meta chips have a shrink order — the branch
gives up space first, the port never does. Text column 50px → 182px, twice as
many projects visible. The sidebar is also drag-resizable from its right edge
(170–460px, double-click resets, persisted as `helm.sidebarWidth`; the
responsive rules clamp with max-width since the stored width is inline).
Toolbar: the right-hand group used to be one unbreakable ~600px block that
overflowed off-screen on a narrow window and wrapped to a second row even at
1440 — it now wraps inside itself, and below 1400px the toggles drop their
labels to icons (tooltips already existed), so the bar stays one row down to
~1000px and gives that height back to the panes. Verified headlessly (CDP)
against the live server and a seeded isolated one: row/name/height measurements,
hover overlay, dev-logs row, drag-resize + clamp + persistence across reload,
light theme, and 1440/1100/820 widths with no horizontal overflow.

One-click launcher + app window (2026-08-28) - `start-helm.cmd` now covers the
whole job for a non-terminal user: on a first run it installs both packages and
builds the web app, then starts the server in its own console window and, as
soon as /health answers, opens Helm as a CHROME-LESS APP WINDOW (Edge, then
Chrome, then Brave, `--app=`; plain tab in the default browser if none is
found) - no tabs, no address bar, which is what the owner meant by "make it a
web app" (the PWA manifest was already there; nothing was launching it as one).
Double-clicking while Helm runs opens another window instead of a second server
that dies on the busy port; a failed install stops with a build-tools hint
instead of a vanishing window. Honours `PORT`. Two traps recorded in GOTCHAS:
powershell.exe strips commas off a .cmd command line (killed the first
browser-probe array, silently falling back to a tab), and an `--app=` window is
hosted by the already-running browser process, so verify by window TITLE, not
by command line. Verified on an isolated port + data dir: cold start - app
window titled "Helm" appeared at bind time; re-run - "already running", exit 0,
no second server.

Update notification (2026-08-28) - Helm now tells you when a newer version is
out instead of leaving you to notice the repo moved. `server/src/update.mjs`
asks GitHub for the latest published RELEASE at boot and every 2 h (tagged
releases, not commits on main - unreleased work in progress should not nag),
compares it with this checkout's package version, and caches the answer so
every tab shares one request; `GET /api/update` exposes it and a dismissible
banner (`web/src/components/UpdateBanner.tsx`, same shell as the drift banner,
green rather than amber) shows the new version, the update commands and a link
to the release notes. Dismissal is per-version, so hiding v0.3.0 stays hidden
but v0.4.0 speaks up again. Only positive results render - offline, rate-limited
or "no releases yet" stay silent, because a local-first app that cannot reach
GitHub is not broken. This is the ONLY outbound request Helm makes on its own
(anonymous, no telemetry); `HELM_NO_UPDATE_CHECK=1` disables it and SECURITY.md
+ the README FAQ say so plainly. Verified: smoke suite 26 (a stub releases
endpoint drives the route end-to-end + version-compare cases), a real GitHub
call parsing the actual v0.2.0 release, and 10/10 CDP checks in a real browser
(banner renders with version/commands/link, dismiss sticks across a reload, a
newer version re-opens it).

Pop-out pane / floating window (2026-08-29) - a pane can leave the grid for a
real always-on-top OS window that sits over VS Code and the browser, so one
agent stays watchable (and typeable) while you work in the project it is
working on. A web page cannot do this by itself; the mechanism is **Document
Picture-in-Picture** (`web/src/hooks/usePipWindow.ts`), which Chrome/Edge/Brave
expose - the browsers start-helm.cmd already launches - and the pop-out button
hides itself where it is missing. The pane is portalled into that window's
document, which re-mounts it: the terminal is rebuilt there and the socket
reattaches with a ring-buffer replay, i.e. the exact path minimize/restore
already took, so no scrollback is lost and the claude process never notices.
Browser-imposed limits, documented in the hook: ONE window per page (popping B
returns A), it needs a click so it can never be restored on load (the popped id
is deliberately not persisted - only the window SIZE is, `helm.pipSize`), and
the window starts blank, so stylesheets are copied in and `data-theme`/
`data-accent` are mirrored with a MutationObserver (the Appearance dialog can
change them mid-float). The popped pane is excluded from the grid's column
count and shows a dashed "floating" chip in the existing tray; it is looked up
across ALL workspaces so switching project doesn't yank it. Two small
correctness fixes fell out: the pane's document-level paste fallback and the
Modal's Esc handler were bound to the main `document`/`window`, which the
floating window never sees - both now use their own document. Verified 18/18 by
CDP against an isolated 3-pane server (window opens, grid re-flows, terminal +
WebGL rebuilt, replay on the wire, keystrokes and resize reach the PTY, theme
mirrors, close returns the pane) and 10/10 against the REAL claude CLI
(TUI rebuilt in the floating window, a prompt typed THERE drove
working -> idle and became the pane's recorded title, process untouched).
NB: headless Edge reports the API as present but never opens a real window -
this feature can only be checked in a headed browser.

Dictation with claude-side clean-up (2026-08-29) - a mic button on each pane:
talk, and the words arrive in the pane as a written instruction, unsent, for
you to read and press Enter. No second subscription and no download, which
took splitting the job in two, because **Claude has no audio input** - the
subscription can polish words but cannot hear them. So the BROWSER does the
speech-to-text (Web Speech API, built into Edge/Chrome, free, no key) and the
REAL claude CLI does the clean-up, headless, on that pane's own account:
filler and false starts out, self-corrections resolved to what you settled on,
mis-heard identifiers restored ("use effect" -> useEffect), punctuation back.
The polish prompt is aggressive about FORM and near-paranoid about SUBSTANCE -
its NEVER block exists because the output goes to an agent that will act on
it, so an invented requirement is far worse than a rough sentence (without the
"do not answer it" rule, dictating a question returns an essay instead of the
question). Because prompts are not contracts, `cleanPolished` also strips
preamble/fences/quotes in code, rejects a reply >3x the transcript (the
signature of the model answering rather than rewriting), and - when a reply
CONTAINS your whole transcript plus extra prose - keeps the words and drops the
essay, which is how "This is too vague to rewrite with confidence. <your exact
words>" gets caught despite being short enough to pass the length guard.
Adversarial bench (`npm run voice-rough`, 24 cases) found three more and is
committed so prompt edits get regression-checked: meta-commentary reaching the
pane when a dictation was all filler ("The dictation contains only filler
words... I cannot rewrite this" - both sanitizer guards missed it, so
cleanPolished now echoes the transcript when the reply TALKS ABOUT it),
inconsistent number spelling (1.2.3 and 7777 converted, "eight pixels" not),
and one KNOWN LIMITATION left unfixed: filler-looking words inside text the
speaker marked literal ("make the button say um yeah ok in quotes") still get
stripped. That case is genuinely ambiguous - a human listener would likely drop
the "um" too - and more prompt weight risks the filler removal that is the
feature's core value, so the design's read-before-Enter is the mitigation.
Negation ("dont add any tests"), stacked and self-reversing corrections,
homophones, delimiter-spoofing and social-engineering injection all hold.
Owner-driven prompt round 2 (2026-08-29): dictating "the square thingy that the
content is living" got "the square BRACKET that says living" - a confident
WRONG guess, the exact failure the NEVER block exists to stop. Two rules were
added and A/B'd against the regression cases before shipping: name a thing the
speaker described but could not name ONLY when the description points at one
standard term (-> "Create text inside the div where the content lives", 3/3),
and never ask the speaker a question or comment on the text. The first rule
alone made ambiguous input come back as a clarifying question, which is why the
second exists. Every failure path
returns the RAW transcript, so the worst case is plain dictation, never lost
words. Two cost decisions, both measured: Haiku (a grammar fix is not Opus
work, and latency is the feature) and a NEUTRAL cwd - running in the project
dir makes claude auto-load its CLAUDE.md, which in this repo drags ROADMAP.md
along: ~13k tokens per dictation to rewrite one sentence. Third and biggest:
`MAX_THINKING_TOKENS=0`, found by measuring where the 16s actually went -
extended thinking was ~984 of ~1000 output tokens, the model deliberating over
comma placement, for an answer 24 tokens long. MEASURED over a 10-dictation
bench against the real CLI: **2.1s and $0.0011 a dictation** (from 16s and
$0.0083 with thinking on), same 10/10 rule compliance. The naive first draft
(`--allowed-tools ""`, which is a permission allowlist and leaves the 34k
tokens of tool DEFINITIONS in context) cost $0.07 and returned nothing usable
because the model spent its one turn attempting a tool call - `--tools ""` plus
`--system-prompt` is what actually strips the agent harness. On a subscription
this is rate-limit budget rather than a bill, and still a small fraction of one
pane turn. New `POST /sessions/:id/polish` + `/type` (types without Enter),
`hooks/useDictation.ts`, Ctrl+Shift+D, and `npm run voice-bench` +
`HELM_VOICE_BENCH=1` to review raw/polished pairs side by side, since prompt
quality is empirical and nobody can eyeball it. The audio trade (Chrome/Edge
stream it to their vendor while the mic is on; the second feature to leave
loopback) is spelled out in SECURITY.md, and the button hides itself where the
API is missing (Firefox, Brave). Smoke suite 28.

Commit-level update signal (2026-08-30) - the update banner had never fired
for anyone, and the reason was not a bug: the newest RELEASE was v0.2.0 while
main had moved 17 commits and 7 weeks past it, so `isNewer` was correctly
false. Since Helm is installed by cloning main, releases alone are the wrong
yardstick. `update.mjs` now asks a second question - GitHub's compare API,
`<local HEAD>...main`, with the SHA from `git rev-parse HEAD` - and reports
`commits:{ahead,url,latest,latestAt}` alongside the release answer. The two
signals are deliberately at DIFFERENT volumes: a release keeps the green
banner, being behind main gets ONE quiet muted line (count, newest subject, its
age, a compare link, `git pull`), and they are never both on screen. Reason:
every docs fixup lands on main, and a full banner per commit trains people to
dismiss the one that matters. Dismissal cannot be per-commit either (the next
push would reopen what you just closed), so it returns after +5 commits or 7
days. Silent on every ambiguous case, same rule as the rest of the module: no
git checkout, no git on PATH, a commit GitHub 404s (local build/unpushed/fork),
or compare status identical/behind/diverged (a copy with its own commits is a
developer, not someone to nag). Verified: 16/16 CDP checks in a real browser
against an isolated server with stubbed GitHub endpoints (renders, wording,
age, compare link, one slim line at 30px, dismiss + persist across reload,
returns at +5, release outranks it, silence when level) plus a live call
against the real API (this checkout read as 6 behind main). Smoke suite 32.
NB still open: anyone on the actual v0.2.0 TAG has neither checker, so the
first release after this one needs a manual nudge to those users.

Ctrl+K runs commands (2026-08-30) - the "command palette" had been a quick
switcher with three actions bolted on (New pane, Broadcast, Usage) sitting
BELOW every pane and workspace, so typing a verb showed you panes first. It now
carries 14 commands: pane ones that act on whatever pane you were last typing
in (maximize/restore, minimize, pop out - target resolved when the command RUNS,
since the active-pane anchor is a ref), plus add-workspace, appearance, sidebar,
alerts, font size, debug log, server console and public links. Each carries
`keywords` so "dark" or "accent" finds Appearance and "tokens"/"cost" finds
Usage, and any command with an existing chord shows it on the row - which is the
only place those chords are discoverable in the app. Ranking rule: with no query
this is still a switcher so panes lead; the moment the query matches a command,
commands go first. Deliberately NOT more key chords: one shortcut to remember
beats six nobody does. The three optional callbacks became one `actions` array
so App owns the wiring and the palette stays presentational; built fresh each
render rather than memoised, since memoising would mean wrapping seven handlers
in useCallback to buy nothing. Verified 7/7 by CDP in a real browser (Ctrl+K
opens, 14 commands listed, keyword search, ranking, the chord badge).

Panes no project can show (2026-09-09) - found by audit, not by report: the
owner's real state held 13 persisted panes, two of them `install cloudflared`
dev panes created by the share-link installer, whose workspace is the HOME dir
and therefore matches no project. The grid lists a workspace's panes by dir, so
those two were invisible, unkillable from the UI, and - autoRevive being on -
re-ran `winget install cloudflared` at every server start, forever. Two closes:
one-shot panes are marked `ephemeral` (createDevSession; never written to
sessions.json, so an exited dev pane's normal persistence doesn't catch them),
and loadPersistedSessions now sweeps panes whose dir isn't in workspaces.json,
logging each drop under a `prune` tag and rewriting the file so a drop is a
drop. The sweep is SKIPPED when the workspace list is empty: "no projects yet"
and "workspaces.json failed to load" are indistinguishable from there, and the
second must never wipe every pane. Writing the test found a second bug it would
have shipped: persistSessions' `let persistTimer` was declared BELOW the load
call, so the first server that actually had a pane to drop died at boot with a
TDZ error - invisible to a build, a lint, and a manual start on clean state
(both traps now in GOTCHAS). Verified: smoke 35 (one-shot pane not persisted,
stranded pane dropped, empty-list guard), real-claude e2e 10/10 on claude
2.1.260, and a boot against a COPY of the owner's real state - the two
installer panes gone, all 11 real panes kept.

Crash screen + old-pane cleanup (2026-09-10) - the two hygiene items left over
from the v0.3.0 audit. (1) `main.tsx` rendered `<App/>` bare, so any render
throw unmounted the entire tree: a white window, no message, no hint that the
panes were fine and a reload would bring them back. New
`components/ErrorBoundary.tsx` catches it and says exactly that (message shown,
stack to the console + a Copy details button). (2) Dead panes accumulated with
nothing showing their age - the owner's own store held 5-53 day-old panes, all
looking alike. A dead pane's badge and revive overlay now say "started 7w ago",
and a new `modals/CleanupModal` (Ctrl+K -> "Clean up old panes...") lists every
non-running pane oldest-first with project + age, pre-ticking anything older
than 14 days (past "I'll get back to it", short of claude's own ~30-day
transcript cleanup, so a listed pane can usually still be revived). Removal is
one DELETE per pane through the existing route - Promise.allSettled, so one
failure doesn't strand the rest - since "delete these ids" is a loop, not a
server feature. The duplicated `age()` formatter in UpdateBanner moved to a
shared `lib/time.ts` (+`daysSince`, which returns Infinity for an unusable date
so such a pane is offered for cleanup rather than hidden forever). 26 vitest
tests. Verified by CDP in a real browser against a seeded isolated server:
13/13 on the cleanup path (ages rendered, oldest-first, the 14-day pre-tick,
the count following a tick, and the server REALLY deleting the three), 7/7 on
the boundary (a deliberately injected render throw caught, real message shown,
normal render restored after), and 4/4 that a LIVE pane still renders with the
changed component and carries no age line.

Floating agent HUD + Approve/Deny (2026-09-11) — owner saw AgentNotch (a macOS
notch app for coding agents) and asked for the same. Most of that panel was
data Helm already had, so the work split in two. (1) The HUD
(`components/AgentHud.tsx`): a small always-on-top strip listing every claude
pane across ALL projects — dot, name, project, elapsed, what it's blocked on —
that reuses the existing Document-PiP window. **First cut was too loose** (the
owner: "doesn't look like the notch, not really a useful small compact
toolbar") — rebuilt dense to match the reference: a 26px header carrying the
agent count, a waiting badge and a compact `1.2M · $12.40` local-usage readout;
ONE 25px line per agent (dot · name · project · ⑂branch · account · elapsed)
with chips that give way in a fixed order as the window narrows, branch first;
a row only grows a second line when it actually needs you, and only the asking
row takes the accent. Branch comes from the git poll App already runs and
account from the session, so neither costs a request. A collapse toggle drops
to a status-light pill plus just the rows wanting an answer. It (`usePipWindow`, which now takes a
`kind` so the HUD remembers its own size) and is portalled into it from App, so
it sits in the same React tree and calls `jumpToPane` directly rather than
inventing a channel back. Toolbar button + Ctrl+K entry, both hidden where PiP
is missing. The usage footer is Helm's LOCAL 7-day cost, labelled as an
estimate: plan percentages are a live Anthropic call and "local only, $0" is
locked. (2) Approve/Deny, the half Helm genuinely lacked, via claude's
`PermissionRequest` hook — a real decision channel, not keystrokes fired at a
menu whose shape moves. Armed ONLY while the HUD is open (it heartbeats
`POST /api/hud/ping`; without one the hook is answered the instant it arrives,
so non-users pay nothing and no pane is ever delayed). An armed request is held
≤12 s in `pendingApprovals` and surfaces as four FLAT `pending*` fields on
`sessionInfo` (flat because `useSessionsPoll`'s shallowEqual would otherwise
churn every pane's reference each poll); `POST /api/sessions/:id/approve`
answers it, 409 = it already lapsed to the pane's own prompt. Every exit path —
click, lapse, pane death, shutdown — releases the held response, because a
stranded one hangs a pane. Getting this working took the real CLI, and the
published docs were wrong twice: `PermissionRequest` sends NO `tool_use_id`
(Helm mints its own id), and the reply's `decision` is an OBJECT
(`{behavior:'allow'}`), not the documented string — a top-level `decision` key
voids the whole reply. The true schema came out of `claude --debug`'s
validation error; all of it is now in CLAUDE_INTERNALS §5a with a drift key.
Three traps found and recorded in GOTCHAS: `fs.mkdirSync(p,{recursive:true})`
returns a `\\?\` path that ConPTY silently rejects, starting the pane in
C:\Windows (this had been latent in e2e-real.mjs all along); Document PiP's
`requestWindow` needs transient user activation that `Window.close()` spends,
so the old window must never be closed first (the owner hit exactly this);
and an account on `permissions.defaultMode: auto` rarely asks at all, so the
buttons rarely appear — correct, not a bug. Verified: smoke 40 (5 new, driving
the REAL hook-post as a child and asserting its stdout), real-claude e2e 14/14
on 2.1.260 (approve let a real Write run, deny stopped it, HUD closed held
nothing) — that suite's trust-dialog nudge was also fixed, it had been sending
a bare Enter into a dialog defaulting to "No, exit" — and headed-CDP in a real browser (24/26),
including clicking Approve and watching the hook print `{behavior:'allow'}`,
plus the density measurements above. OPEN: in the automated browser the PiP
window ignored BOTH the requested open size (asked 400x460, got the opener's
1264x818) and `window.resizeTo`, so the collapse toggle changes the content but
not the window. Unconfirmed whether that is the automation profile or real
Chrome/Edge — the pop-out pane has shipped for weeks at a requested 560x420
without complaint, which points at the harness. Needs a look in a normal
browser before either chasing it or dropping the collapse toggle.

The HUD as its own page (2026-09-11) — first step toward a native always-on-top
notch, and the answer to the open item above: the picture-in-picture window
CANNOT be a notch. Chrome/Edge enforce a minimum size and REJECT a smaller
request outright rather than clamping, which is why `COLLAPSED_WINDOW_H` is
padded to 200px for a pill that wants ~28. That is the platform saying no, not
a bug to chase. So `AgentHud` now has a second home: `web/hud.html` +
`HudApp.tsx`, a STANDALONE document built as a second Vite entry and served at
`/hud` with the same `%%HELM_TOKEN%%` injection. It fetches its own data (and
polls only what it renders — deliberately not `useWorkspaceStatus`, which would
add dev-server and share-link polls the HUD never shows) and mirrors the app's
theme out of localStorage. `AgentHud.tsx` itself is UNCHANGED and still shared
with the picture-in-picture copy; only the `onJumpToPane`/`onClose` props
differ, so there is one HUD, not two.

The piece that needed designing is "jump to that pane", which the PiP HUD got
for free by living in App's React tree. A separate document cannot call App's
handler, so it goes through the server: `POST /api/focus` +
`GET /api/focus/wait?since=` (long poll, ~25 s ceiling, `useFocusRequests` at
the app's end). A long poll rather than the existing 3 s tick because a click
that takes seconds to move the app reads as broken, and server-mediated rather
than a `BroadcastChannel` because that only reaches documents in the SAME
browser — the window this is being built for is a separate process. `since` is
a cursor, so a request raised while nobody was parked still lands and an
answered one never replays. Reachable from Ctrl+K ("Open the agent HUD in its
own window"); the PiP HUD button is untouched. Verified: smoke 44 (4 new — page
+ token injection, validation + auth, parked poll answered on click, the
between-polls gap) and 11/11 by CDP driving TWO browser targets against an
isolated server — clicking a row in the HUD window really moved the app window
to that pane's project. NOT yet done: the native shell itself (Rust/Tauri
approval still open), so the window is still a browser window and still
rectangular.

Native notch window (2026-09-11) — the thing the browser could not do. Owner's
ask was a notch that can be any shape, with animation gestures; a browser only
ever hands you an opaque rectangle it owns, and picture-in-picture additionally
refuses to shrink below ~200px. So `desktop/HelmNotch` — a frameless,
always-on-top WPF window whose entire content is a WebView2 pointed
at `/hud?notch=1`. Nothing about the UI moved to C#: the notch's shape, rounding,
shadow and animation are CSS on the page we already had, and `AgentHud.tsx` is
STILL untouched.

Shell choice changed mid-flight, on evidence. Tauri was approved, but this
machine has no Visual Studio at all (node-pty works off a prebuilt binary), and
Rust on Windows links through MSVC — so Tauri meant rustup plus 3–7GB of Build
Tools and an admin prompt. WPF + WebView2 reaches the same place for a ~200MB
per-user .NET SDK and no elevation, and the earlier claim that it would cost us
React/motion was simply WRONG: hosting WebView2 keeps the whole web stack.
Owner picked it once the real numbers were on the table. Cost: Windows-only,
which matches a project whose macOS/Linux support is already untested.

Page ↔ window bridge is three messages (`drag`, `resize`, `close`) over
`window.chrome.webview`. No click-through message, deliberately: a window that
ignores the mouse stops RECEIVING mouse messages, so the page could never turn
it off again — instead the window hugs its content via a `ResizeObserver`, so
there is no dead window area to click through in the first place. Launch with
`desktop/start-notch.cmd` (builds on first run, finds a per-user or machine-wide
SDK, says so if Helm isn't listening). Verified ON SCREEN, which is the only way
this can be verified: transparency confirmed against the live desktop (corners
and drop shadow showing through), then 4/4 against a real isolated Helm — window
opens, hugs its content (460x180 → 450x99), and GREW to 450x115 when a pane
started asking for permission, proving the resize bridge; plus a clean-build run
of the launcher. TWO owner-reported bugs followed, both from verifying the
wrong things, both now in GOTCHAS. (1) It SHOOK sideways: the window took its
WIDTH from the page, and resizing reflowed the content and flipped the page
scrollbar, which changed the measured width straight back — an oscillation, made
visible by the window re-centring after each change. The window now owns its
width and only HEIGHT follows content, with a dead band and no page scrollbar.
(2) Worse: it could not be CLICKED AT ALL — `AllowsTransparency` hosts the
window as a LAYERED window, which renders the pretty version (alpha corners,
soft shadow, all verified on screen) and then swallows every mouse message the
WebView2 should get. Transparency is gone; the shape now comes from DWM's own
rounded corners (`DWMWA_WINDOW_CORNER_PREFERENCE`), which costs no input. The
lesson is the real deliverable: a screenshot proves rendering and NOTHING about
input, and CDP-injected clicks bypass the OS message queue, so they would have
passed against the broken build. Regression-checked now by a real
`SetCursorPos`+`mouse_event` click (asserting the process exits) plus 8/8
DOM-level checks through the notch's new `HELMNOTCH_DEBUG_PORT`, and by sampling
the real window rect 40 times over 10 s for a single distinct left and width.
(3) Owner: "it has a space above and not really touching the top" — it sat at
`Top = 8`, and DWM's corner preference rounds all four corners or none, which is
wrong for something meant to hang FROM an edge. Now `Top = 0` and the silhouette
is a window REGION (`SetWindowRgn`): a round-rect unioned with a rectangle over
the top strip, which squares the top two corners back off and leaves a deep
14px panel corner on the bottom two (it went 26 → 55 → 14: the deep sweep
the owner first picked then read as "too angled" against a reference panel, and
an aggressive curve also eats into the last row's text — the rows' bottom
padding is solved from the radius, so it followed it down from 27px to 2px).
DWM is told `DWMWCP_DONOTROUND` so it doesn't
fight. Region coordinates are PHYSICAL pixels, so it scales by `VisualTreeHelper
.GetDpi`, and it is re-cut on every height change or the curve is left at the
old size. CSS mirrors the radius, and the rows carry a computed 27px bottom
padding — the curve insets the shape by `R - sqrt(R²-(R-d)²)` at distance d above
the bottom, which would otherwise clip the last row's text. Verified by asking
the region itself whether each corner pixel is inside (top two true, bottom two
false) plus an on-screen capture.

Notch: fixed in place, and it follows Helm (2026-09-12) — three owner asks.
(1) NOT movable: the drag bridge is gone entirely (page handler, host
`WM_NCLBUTTONDOWN` trick, grab cursors), so it stays where it is put — top
centre, flush with the screen edge. (2) It gets OUT OF THE WAY: the host polls
every 600 ms for a visible, non-minimised window whose title ENDS with
"Helm ⎈" and hides itself while one is up, reappearing the moment Helm is
minimised or closed. Matched by title because an `--app=` window is hosted by an
already-running browser process, so its command line says nothing (GOTCHAS);
matched on the SUFFIX because the count prefix varies ("(2 waiting) Helm ⎈")
while an editor that merely mentions helm does not end that way. (3) AUTO-HIDE, modelled on Windows' own auto-hidden
taskbar: when the notch is on screen at all it eases up out of sight, leaving a
4px sliver, and slides back down when the cursor reaches the top edge within its
width. One 100 ms timer drives both the hover check (`GetCursorPos`, cheap) and
— every sixth tick — the Helm-window scan (which enumerates every top-level
window, so it is the expensive half). The reveal test widens once revealed, with
10px of slack, so a shaky hand on the way to Approve doesn't dismiss it, and it
parks only after ~500ms of the cursor being elsewhere. Sliding is an ease-out on
`Top` (35% of the remaining distance per 16ms frame, retargetable mid-flight, so
reaching for it while it is still parking reverses rather than queues). The
parked position is recomputed every tick rather than cached, because the notch's
height tracks its content and a pane starting to ask makes it taller mid-park.
Following outranks auto-hide: while Helm itself is up the notch is not wanted at
all, so it goes away properly instead of parking at the edge. Two toggles:
`notchFollowsHelm` and `notchAutoHide` in server settings, surfaced in
Appearance → Notch. Server
state, not localStorage — the notch runs in its OWN WebView2 profile and shares
no storage with the browser, which is the whole reason it cannot be a UI pref.
The page polls the setting (4 s) and relays it to the host, keeping the auth
token out of C#. `start-helm.cmd` now also starts the notch if it has ever been
built, guarded by a `tasklist` check so a second launch never stacks one — so
"auto-launch when Helm is minimised" needs no launching at all: it is already
running and simply un-hides. Verified 5/5 against the owner's REAL Helm window
(hidden while it was on screen, back when following was turned off, header drag
moved it 0px), 6/6 on auto-hide driving the REAL cursor (parked at top=-125 with
a 4px sliver showing, top=0 within 2s of touching the screen edge, parked again
on leave, stays down with the toggle off), plus a launcher run on a throwaway
server (one notch, still one after a second launch). Smoke 45. NB the minimised-vs-closed distinction uses
`IsIconic` on the same path and was not exercised against the real window, since
that meant minimising the owner's editor mid-session.

Notch rests as a status strip, not a hidden window (2026-09-12) — owner:
"instead of hiding the whole notch we will display panes color based on their
status". The previous auto-hide slid the window off-screen and left a 4px sliver
of nothing, which told you nothing; now at rest it SHRINKS to a 200x24 strip of
lights, one per claude pane, coloured by what that pane is doing, with a count
badge when something is waiting. Reach it with the cursor and it grows into the
full list. That is the point of a notch: a glance answers "does anything want
me?" without costing screen.

New `components/NotchStrip.tsx` (HudApp renders it instead of `AgentHud` when
compact); `dotFor`/`rankOf` are now EXPORTED from AgentHud rather than copied,
so a new status can't drift between the two faces. `AgentHud` itself is still
otherwise untouched. The bridge gained its first host→page direction
(`onHostMessage`, `PostWebMessageAsJson`): the HOST owns hover detection,
because once the window is a 24px strip the page can no longer tell where the
cursor is relative to the screen edge. Width is set from the MODE (200/460),
never measured — measuring width is what once made the notch oscillate — and the
fixed compact width also stops the strip resizing itself every time a pane
appears. Height still comes from the page. Both are eased by one animator so the
two faces read as one shape growing, pinned to the top edge and re-centred each
frame, with the region re-cut as it goes. `notchAutoHide` became
`notchAutoCompact` (it no longer hides anything), chips now "Compact until
hovered" / "Always expanded".

Two bugs found while verifying, both real: the mode was posted only on CHANGE,
so a decision taken while the page was still loading reached nobody and the page
would render the wrong face forever (now re-stated on every successful
navigation); and the first test run measured a startup transient and read as a
total inversion — chasing that is what produced `HELMNOTCH_LOG`, an opt-in
per-tick decision dump (cursor, rect, revealed, targets) that settled it in one
run. Verified 10/10 driving the REAL cursor (200x24 at rest, flush at top, still
ON SCREEN; 460x196 hovered; back to the strip on leave; pinned open with the
toggle off) plus a host trace showing both states stable. The morph was then
reported JITTERY and rebuilt: the first cut eased by a fraction of the remaining
distance per tick (a long tail of sub-pixel frames) and set Left/Width/Height
separately (two or three window repositions per frame). Now time-based over a
fixed 160 ms, whole pixels, one `SetWindowPos` per frame, region re-cut only on
change — 6/6 measured by sampling `GetWindowRect` every 8 ms through both
directions: monotonic, centred every frame, lands exactly, still afterwards, and
the open grows in one motion rather than wide-then-tall. Details in GOTCHAS. Smoke 45. NB an
exclusive-fullscreen app (a game) covers the notch — it sits above topmost
windows; correct OS behaviour, not a bug.

One way to the notch (2026-09-12) — closing the confusion that cost the owner
real time: Ctrl+K offered "Open the agent HUD in its own window", which opened
/hud in a BROWSER popup, and that is what got mistaken for the notch ("it just
looks like a window" — the screenshot showed a title bar reading 127.0.0.1:7777).
Two entries that read identically in a palette, one of them obsolete. The popup
entry is gone; Ctrl+K → "Open the agent notch" now launches the real one through
a new `GET/POST /api/notch`, and the entry hides itself where it cannot work
(not Windows, or never built). Verified end-to-end against an isolated server:
GET reports supported, POST starts exactly one, a second POST reports
`started:false` without stacking a window. Smoke 46 (shape + auth + the refusal
path, which is the half CI actually exercises since the exe isn't built there).

Notch says WHICH project needs you (2026-09-12) — owner supplied a reference of
a resting notch reading `✳ storefront | ! Needs you`. A row of dots can tell you
something is amber; it cannot tell you which project, which is the only thing
worth knowing at a glance from across the desk. So the resting strip now has two
faces: quiet (one light per pane) and needy (the blocked project's name, a red
`!`, and "Needs you" — or "N need you"). A pane actively ASKING outranks one
merely waiting, since a held permission request is answerable right now where
"waiting" may just be claude's own prompt sitting there.

The naming face needs more room, so the compact window has TWO fixed widths
(200 quiet / 300 needy) and the page sends `compactWidth` when the state flips.
That is not the measurement loop that once made the notch shake: it is a
constant chosen by STATE, not a measured layout, so it cannot feed back into
itself. The host applies it in place when already resting, so an alert widens
without waiting for a hover.

Pulled `dotFor`/`rankOf`/`projectOf`/`claudePanes`/`isBlocked`/`needyPane` out of
AgentHud into `lib/paneStatus.ts` — pure, no React, no api. That was forced by a
test (importing them from the component dragged in api.ts, which reads `window`
at import time) and is the better shape anyway. Writing those tests found a real
bug: `projectOf`'s split regex had lost a backslash, so it split on `/` only and
would have shown the whole Windows path instead of the project name — nothing
else covered it and it reads fine until you try it. 38 vitest tests (12 new).
Verified 5/5 on the live window: 200 quiet, 300 when a pane blocks, still a
one-line strip, still centred, back to lights when unblocked.

Clicking an agent in the notch actually takes you there (2026-09-12) — owner
asked what the click should do; the honest answer was that it half-worked. The
pane selection was fine (focus request → Helm selects the workspace, un-minimises
the pane, scrolls, pulses), but bringing Helm FORWARD was `window.focus()` from
the page, which browsers ignore for a minimised or background window. So you
clicked "storefront needs you" and the right pane was selected inside a window
that stayed hidden — precisely the case the notch exists for. The notch raises
it now (`ShowWindow(SW_RESTORE)` + `SetForegroundWindow`, reusing the window it
already finds every 600ms for following); Windows grants foreground rights to a
process with recent input and the user has just clicked it. `window.focus()`
stays as the fallback for the browser-window HUD, which has no host.
`FindHelmWindow` had to stop skipping minimised windows — the previous check
only cared whether one was ON SCREEN. Verified 5/5 with a REAL OS click (a
CDP-injected one would not earn foreground rights): window restored, brought to
the front, focus request raised. Two testing traps recorded in GOTCHAS, the
second of which cost two runs: stale `--app=` Helm windows from earlier attempts
(killing the launcher PID does not close them) meant the notch was correctly
raising a leftover while the test watched its own minimised one.

Notch loses its chrome (2026-09-12) — owner: drop the agent count, the
token/cost readout, the close button and the collapse-to-pill toggle. All four
were HUD furniture that made sense in a picture-in-picture window and none of it
in a strip at the top of the screen, where the whole point is that everything
shown is worth reading. `AgentHud` gained a `chrome` prop (default true, so the
browser-window HUD is unchanged) and the notch passes false: no header at all,
just the agent rows. 460x121 → 460x95. The collapse button is redundant anyway
now that it compacts itself on hover. Closing moved to RIGHT-CLICK, since
removing the × would otherwise leave no way out but Task Manager — the web
view's own context menu is already disabled, so nothing else wanted the gesture.

Notch says what each agent is DOING (2026-09-12) — two additions chosen for
using data Helm already had. (1) Each row carries that pane's task: the
auto-title Helm derives from its first real prompt (`summary`, the same thing
Ctrl+K searches). "Beacon · storefront" says where an agent is; the task line
says what it is doing, which is the question you actually have. Behind a
`showTask` prop, OFF for the compact HUD — the owner deliberately tuned that to
one dense line per agent — and ON for the notch, where it is the point.
(2) The compact strip's alert face now says how long a pane has been stuck:
`storefront 4m ! Needs you`. "Just asked" and "stuck twenty minutes" were the
same amber dot before, and they are not the same problem. Ticks on the existing
3 s poll (`elapsed` returns '' under a minute, so it appears when it means
something); the needy width went 300 → 330 to fit it.

Verified 6/6 against a real isolated Helm with SEEDED TRANSCRIPTS — fake-claude
writes none, so the panes were given real JSONLs reported through the hook relay,
inside an isolated account store (the server rejects transcript paths outside
it). Deliberately NOT added: multi-provider quota bars (Helm only knows Claude),
diff stats (not tracked), terminal output in the notch (a feature, not a tweak).
Still open from the same discussion: a desktop alert when Helm's window is
CLOSED — alerts come from the main window today, so the notch's own use case is
the one case nothing tells you — and a brief auto-expand when a pane starts
needing you.

Two testing traps, both mine: a capture script set HOME but not USERPROFILE, so
the server's account store stayed the REAL one and rejected the seeded
transcripts — the notch then correctly showed no task lines and it read as a
broken feature. And the notch must NOT inherit that isolated USERPROFILE:
WebView2 needs the real one and will not start without it.

Notch filtering: auto-quiet, then mute (2026-09-12) — owner asked for a settings
filter over which workspaces and panes reach the notch. Real problem (11 panes
× ~40px with the new task line ≈ 440px hanging off the screen) but a filter
alone is config you maintain forever, so it got the cheaper half first.

AUTO-QUIET (no config): blocked and working panes always list; ones idle beyond
30 min, and dead ones, drop to a "+N quiet" line. TIME-based, not state-based,
and that distinction is the whole design — in Helm a pane that has just FINISHED
is `idle`, and that is exactly what you want to see; an hour later it is
furniture. MUTE is the escape hatch: right-click a project → "Hide from the
notch" (`notch:false` on the workspace, stored only when muted so absent still
means yes and nothing needs migrating). Muted panes are NOT counted in "+N
quiet" — you muted them on purpose, and a reminder that never goes away is worse
than nothing. Filtering applies to the NOTCH only; `/hud` in a browser window
stays the full view.

Logic is pure in `lib/paneStatus.ts` (`isQuiet`, `foldDir`, `notchPanes`), which
paid off twice while testing: the unit tests caught that a fixed ISO date in the
test helper can land in the FUTURE depending on the runner's timezone (inverting
every age rule), and that `foldDir` compared case but not slash direction, so a
mute would silently miss a dir written with the other separator. 45 vitest (7
new), smoke 47, and 7/7 against a real notch — muted project vanishes, others
untouched, nothing counted as quiet, un-muting brings it back, and an unmuted
workspace stores no field at all.

Share links: stopping one now really stops it (2026-09-12) — found by counting
processes, not by any failing test. `stopTunnel` removed the tunnel from its map
and called `proc.kill()`, so Helm's bookkeeping was right and `/api/tunnels`
correctly showed none — while the process kept running. Cause: a `.cmd` must be
spawned through a shell, so `proc` is cmd.exe and the tunnel is its CHILD;
killing the parent orphaned it. Measured at exactly two leaked stand-ins per
smoke run, forever, on any machine that ran the suite (24 had accumulated).
NOT just a test artifact — `needsShell` fires for any `.cmd` and `cloudflared`
on PATH is a `.cmd` shim under several package managers, so a REAL tunnel could
outlive being closed, leaving a live public URL nobody is holding. Now kills the
TREE (`taskkill /T /F`), synchronously because shutdown exits ~300ms later.
Regression test has the stand-in write its OWN pid (the one Helm holds is the
shim's) and asserts it is gone after the stop; proven to have teeth by reverting
the fix and watching it fail. Smoke 48, and a full run now leaks zero.

Pane categories + a real color picker (2026-09-14) — a friend asked for bright
red and navy pane colors and "categories for the panes, depending on the
color"; owner's framing was Chrome's tab groups. Both halves were real gaps:
`PANE_COLORS` was ten soft mid-tones with no red, no deep blue and no way to
type your own, and a pane's color was random decoration that meant nothing. Now
a **category** is a folder you create (name + any color from the browser's own
color wheel), panes are filed into one from the swatch button in their header,
and **the category owns the color** — a filed pane renders in its category's,
derived at render (`web/src/lib/categories.ts`, `paneAccent`) rather than
written onto the session, so recoloring a folder repaints every pane in it at
once with nothing to migrate or keep in sync. New `categories.json` +
`GET/POST/PATCH/DELETE /api/categories`, `categoryId` on the session and its
PATCH route. Scoped by the owner to **label + search**: a chip beside the pane
name and Ctrl+K matching the category, deliberately NOT grid grouping or a
toolbar filter (they fight the existing drag-to-reorder and saved grid weights,
and Chrome's other tab-group behaviour — visual clustering and collapse — can
follow as its own piece). Red and navy are picker-only, never in the RANDOM
pool: red is load-bearing in Helm (the PUBLIC share flag, the notch's "needs
you") and a pane coming up red by chance would dilute a real alarm. Two
dangling-reference guards, the bug this codebase has already shipped twice:
deleting a category empties every pane filed there (and reports the count, so
the confirm can name the blast radius), and a pane naming a category that
vanished while the server was down has the reference cleared at load. The HUD
and notch take the category color too — the same pane was otherwise two
different colors in two places. Verified: smoke 51 (3 new, incl. a
delete-clears test proven to have teeth by reverting the fix and watching it
fail), 54 vitest (9 new on the pure color rule), and 25/25 by CDP in a real
browser against an isolated 3-pane server — category created from a pane
header, chip rendered, both filed panes repainted, recolor propagated across a
reload, Ctrl+K narrowing 21 rows to exactly the 2 filed panes (the first cut of
that check passed VACUOUSLY against an unfiltered list), the manage dialog
naming how many panes a delete would empty, and after the delete the panes
back on their own colors with no ghost ids left.

Minimized panes keep their group (2026-09-14) — owner spotted the surface the
above had missed: the tray chips still painted `session.color`, so minimizing a
pane threw away the one thing its color was supposed to say, and panes from the
same category scattered across the strip. The tray now renders one CONTAINER
per category — tinted and labelled with that category's color, its chips in
that color too — with uncategorized panes in a last, unlabelled group.
Ordering comes from the categories list rather than the panes
(`groupByCategory` in lib/categories.ts), so a group doesn't jump around as
panes are minimized and restored, and an empty category never shows. The
floating-pane chip takes the category color as well. 60 vitest (6 new on the
grouping rule) and 11/11 by CDP against a real isolated server: two containers
with the right chips in each, both borders and both chip colors matching their
category, an unfiled pane landing loose and last, restore still working from
inside a container, and the strip checked in light theme as well as dark.

Favorite panes + a favorites-only filter (2026-09-14) — a star on every pane
header (`favorite` on the session, persisted through the existing PATCH route)
and a toolbar toggle that shows only starred panes. Owner picked the FILTER
over sort-to-top, which is the version that can genuinely lose a pane: hiding a
RUNNING one is the invisible-pane bug class this repo has already shipped
(stranded panes with no project). So the filter is guarded three ways rather
than trusted — it never turns itself on, the toggle carries the count it is
hiding ("Favorites (1 hidden)") and an emptied grid says why and offers the way
out instead of reading as lost panes, and **any jump to a pane it would hide
turns it off**: both `jumpToPane` (Ctrl+K, the HUD/notch focus request) and
`jumpToWaiting` (the "N waiting" pill). Ctrl+K itself is deliberately NOT
filtered — the filter is about what the grid shows, not what you can find.
Verified: smoke 52 (star round-trip, boolean validation, persisted to disk) and
by CDP in a real browser — 9/9 on the filter and its reporting, plus the two
cases that matter most, each staged for real: clicking a hidden pane in Ctrl+K
reveals it rather than landing on an empty grid, and a pane driven to `waiting`
through the REAL hook relay while unstarred stays reachable from the waiting
pill, which turns the filter off to show it. Two testing traps of my own here:
Ctrl+K is a TOGGLE, so a palette left open by a previous script reads as "the
shortcut is broken", and the first jump check passed a synthetic Enter that
never selected anything — the guard looked broken when only the test was.

## Short-term backlog (rough priority order, owner-approved direction)
(empty — next items to be chosen with the owner)

## Bigger ideas discussed with owner (not committed)
- Remote access from phone/laptop via Tailscale (origin/token checks already
  exist; would need an HTTPS story and origin allowlist).
- "Install as app" shortcut + auto-start-server task for a native-app feel
  (deliberately chosen over Electron — see locked decisions in CLAUDE.md).
