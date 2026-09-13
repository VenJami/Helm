# Helm — Hard-won gotchas (read before touching server code)

- **node-pty kill-race crash:** killing a pty whose process already died can
  throw an unhandled `TypeError … 'forEach'` from `windowsPtyAgent.js` and
  would take down the whole server. Guarded in `server/index.mjs` by a
  targeted stack-string match inside the process guards. node-pty is **pinned
  exact (1.1.0)** in package.json — the `^1.0.0` range had already silently
  floated 1.0.0 → 1.1.0, and a future rename of `windowsPtyAgent.js` would
  disarm the guard without any error. Don't upgrade casually — the prebuilt
  binary is version-sensitive, and if you do, re-verify the guard's filename
  match.
- **Crash policy (2026-07-05): fail-fast during boot, keep-alive after.**
  One process hosts every pane, so post-boot uncaught exceptions/rejections
  are logged (🐞 drawer + console) instead of crashing all terminals; boot
  failures still exit loudly. Don't add code that relies on a crash-restart
  to recover state.
- **Boot-time code runs during module evaluation — mind the temporal dead
  zone (2026-09-09).** `loadPersistedSessions()` is called where it is
  defined, part-way down index.mjs, so anything it touches must already be
  initialized. It calls `persistSessions()`, whose `let persistTimer` used to
  be declared further down: the server then died at start-up with "Cannot
  access 'persistTimer' before initialization" — but ONLY for someone whose
  state actually had a pane to drop, which is exactly the case a build and a
  quick manual start don't reach. Function declarations hoist; `let`/`const`
  do not. The smoke test that seeds a stranded pane is what caught it.
- **A pane belongs to a project, and the grid lists panes by workspace dir.**
  A pane whose dir isn't in `workspaces.json` cannot be rendered, killed, or
  reached at all — while auto-revive still respawns it at every boot. So never
  create a pane for a directory that isn't a workspace unless it is marked
  `ephemeral` (never persisted; the cloudflared installer is the one case).
  Sessions loaded with no matching workspace are swept at start-up, but the
  sweep is skipped when the workspace list is empty, because a failed
  `workspaces.json` read is indistinguishable from "no projects yet" and must
  never wipe every pane.
- **State files are atomic + versioned + backed up (2026-07-05):** all JSON
  state (`sessions`, `workspaces`, `settings`, imported-transcripts ledger,
  tokens) is written temp+rename with the previous good copy kept as
  `<file>.bak`; corrupt files recover from `.bak` loudly (a corrupt file used
  to be treated as first-run and silently wiped state). `sessions.json` /
  `workspaces.json` are now `{version: 1, ...}` wraps — loaders still accept
  the legacy bare-array shape. Use `writeJsonAtomic`/`readJsonWithBackup` for
  any new persisted file; never raw `writeFileSync`.
- **"AttachConsole failed" stacks in the server log** when killing sessions:
  node-pty's forked console-list helper dying. Harmless; ignore.
- **Stale server on port 7777** — the #1 recurring issue. If `EADDRINUSE`:
  find the owner, check it has no live claude children before killing
  (`Get-CimInstance Win32_Process -Filter "ParentProcessId=<pid>"`), then
  restart. An old server silently missing new endpoints looks like "the
  feature is broken" — always suspect stale code first when a feature
  "doesn't work".
- **`npm run dev` (--watch) restarts on server-file edits and kills all live
  panes** (they become revivable `dead` sessions, but still). `npm start` for
  daily use.
- **Token injection:** the built `index.html` contains the placeholder
  `%%HELM_TOKEN%%`; the server `replaceAll`s it when serving `/`. Don't put
  that placeholder string anywhere else in the HTML (a comment containing it
  once broke injection — replace hit the comment first).
- **Trust dialog per profile:** claude's folder-trust choice lives in each
  profile's own `.claude.json`, so a new profile re-asks even for a folder the
  default account trusts.
- **Frontend changes need `npm run build`** (or `watch`) — the server serves
  `web/dist` from disk per request, so a running server picks up new builds
  without restart; server-code changes DO need a restart.
- **Two ways claude ≥2.1.198 silently stops writing transcript JSONLs**
  (symptoms: per-pane usage "no usage recorded", account roll-up missing new
  sessions, `claude --resume <id>` dies with "No conversation found"). Hooks
  still fire and report a `transcript_path` in both cases, so Helm looks fine
  until you check the disk. Root causes, isolated 2026-07-02:
  1. **Inherited `CLAUDE_CODE_CHILD_SESSION=1`.** Claude Code injects it into
     every shell/process it spawns. A Helm server started from *inside* any
     claude session (a Helm pane, the VS Code extension, an agent) passes it
     on to every pane, and those panes skip session persistence entirely — no
     JSONL is ever written, not even user lines. Fix: `spawnPty` scrubs the
     inherited claude session-identity env vars.
  2. **Agent teams.** With `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS` enabled
     (the owner's user settings.json sets it globally), the moment a session
     spawns a teammate the lead stops logging assistant lines (user lines keep
     appearing — the "user-lines-only transcript" signature) and teammate
     conversations are never written anywhere. Fix: `spawnPty` forces
     `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=0` in panes; asking for a teammate
     then falls back to a classic subagent, whose transcript lands in
     `projects\<cwd>\<sessionId>\subagents\` (usage scans include it).
  Both fixes verified end-to-end (isolated server on :7791 → real pane →
  teammate prompt → usage API returns tokens). Helm still degrades gracefully
  when a transcript is missing: `canResume` checks existence, revive falls
  back to fresh.
- **Everything Helm parses out of claude is undocumented** and can drift on a
  claude update (usage/cost/status/revive all silently return zeros when it
  does). The full catalogue of assumed formats/fields/env/flags is
  `docs/CLAUDE_INTERNALS.md` — check it first when a feature "shows nothing."
  As of 2026-07-05 drift is no longer silent: a boot-time `claude --version`
  check (floor `2.1.198`) + parse-time signals (unknown model, empty-but-large
  transcript) feed `GET /api/diagnostics` and a dismissible UI banner
  (`web/src/components/DriftBanner.tsx`). When you fix a drift, bump
  `CLAUDE_VERSION_FLOOR` and update CLAUDE_INTERNALS.md.
- **Transcript parsing assumes JSONL files are append-only** (they are — claude
  only appends). The incremental parser (`readAppendedLines` in src/claude.mjs) reads
  just the bytes added since the last poll and keeps a partial-line tail buffer;
  a file that *shrank* triggers a clean full re-parse. Consequence to know: a
  line isn't counted until its trailing `\n` lands (mid-write safety), so a
  transcript whose final line is unterminated won't include it — real claude
  always terminates lines.
- **Session persistence must be immediate for lifecycle changes**
  (create/delete/exit/revive call `persistSessions()` directly; only chatty
  hook updates use the debounced `schedulePersist()`). A hard-killed server
  inside a debounce window once left a stale `sessions.json` that resurrected
  a deleted session as a revivable ghost. Don't re-debounce lifecycle writes.

- **`/voice` works in a pane, but only in tap mode.** claude's built-in
  dictation defaults to `voice.mode: "hold"` ("hold space to record"), and
  hold-to-talk needs a key-RELEASE event. A browser terminal only ever
  transmits characters: xterm.js implements no kitty keyboard protocol, so
  Helm can never tell claude that space came back up. Measured on claude
  2.1.246 in a real pane: hold mode → pressing space does nothing at all (no
  REC, no waveform); `/voice tap` → `● REC · tap to send` with a live
  waveform, real mic capture, second tap sends. So dictation in Helm = run
  `/voice tap` once (it persists in `~/.claude/settings.json`). Two traps if
  you go poking at this: `/voice` is a TOGGLE (running it to "see what it
  does" turns a user's working setup OFF), and it writes to the REAL
  `~/.claude/settings.json` even when Helm's own state is isolated via
  `HELM_DATA_DIR` — pass `/voice hold|tap|off` explicitly instead of bare
  `/voice`, and put the setting back. Consequence for Helm: do NOT build a
  browser-side dictation feature. The CLI's is better (audio goes to
  Anthropic on the user's own account instead of Google/Microsoft, native
  composer integration, zero code here).

- **Public share links: verified against the real Cloudflare edge
  (2026-08-26, cloudflared 2026.8.2).** A throwaway origin was published and
  fetched back over the public internet, so the banner regex, the anonymous
  quick-tunnel path, and teardown are all confirmed — not just stub-verified.
  Facts worth keeping:
  - The URL appears on **stderr** inside an ASCII box, and took **~6 s** to
    arrive (the route waits up to 15 s before handing back a `starting`
    record, so that's comfortable — but a slow link is normal, not a bug).
  - Quick tunnels still need **no Cloudflare account and no login**. The
    hostname is four random words, e.g.
    `agency-webcams-neighbor-farmer.trycloudflare.com`.
  - After stopping, the hostname keeps resolving for a while but the edge
    returns **502** — the link is dead, it just doesn't vanish instantly.
    Don't read a 502 as "teardown failed".
  - `cloudflared` is a single signed Go binary (Authenticode: Cloudflare,
    Inc.); Helm only detects it on PATH and never installs it. Two traps still
    apply: a `.cmd`/`.bat` wrapper needs `shell:true` on Node 22 (same trap as
    `claude.cmd` — a real `.exe` doesn't), and Vite rejects requests from an
    unknown Host, so a tunnelled Vite project 403s until `server.allowedHosts`
    is set (Next has `allowedDevOrigins`).
  - `npm test` still covers the whole lifecycle against
    `test/fake-cloudflared.mjs` (no network, no 52 MB download in CI); the
    real-binary script lives outside the repo, in the session scratchpad.

- **"cloudflared is installed but Helm keeps asking me to install it"
  (2026-08-26, hit for real).** Two separate traps, both worth knowing beyond
  this feature:
  1. **A running process keeps the PATH it was spawned with.** winget put
     cloudflared in `C:\Program Files (x86)\cloudflared` and added that to the
     *machine* PATH — but the long-lived Helm server never sees a PATH change,
     so detection failed forever no matter how often it re-ran. Restarting the
     server fixes it and kills every live pane, which is the trade this feature
     must not force. Fix: `cloudflaredCandidates()` probes known install dirs
     (Program Files, WinGet\Links, chocolateyin, brew paths) as well as
     PATH, and the resolved ABSOLUTE path is what gets spawned. Apply the same
     thinking to any future external tool Helm shells out to.
  2. **`winget` on PATH is an App Execution Alias, not an exe.** It does not
     resolve for spawned child processes, so a pane running bare `winget …`
     dies instantly with exit 1. Its real file under
     `%LOCALAPPDATA%\Microsoft\WindowsApps\winget.exe` runs fine, including
     through cmd.exe — so Helm quotes that absolute path. Sub-trap:
     that file is a **symlink whose target isn't normally resolvable**, so
     `fs.existsSync()` returns FALSE for a file that executes perfectly.
     Use `fs.lstatSync()` (or `accessSync`) to test for it; `existsSync`
     silently sends you down the broken fallback.
  Both are pinned by smoke tests that lstat the alias, run it through cmd.exe,
  and assert detection resolves an absolute path that was never on PATH.

- **Frontend layout: `visibility: hidden` still reserves the box.** The
  sidebar's row buttons were hidden that way and silently ate ~72px of every
  workspace row (more than the name column itself), which is why project names
  read as "N…" at a 220px sidebar. Hover-revealed controls must either be
  `display: none` or taken out of flow (`position: absolute`) — Helm's rows
  now overlay them. Measure a row's children in the browser before blaming the
  font or the width.
- **Never run `prettier --write` on `web/src/styles.css`.** The `format`
  script is scoped to `.ts/.tsx` on purpose; CSS is hand-formatted (one-line
  rules for small selectors). Running Prettier over it reformats ~1,000 lines
  and buries the real change. Cost a full revert-and-reapply on 2026-08-27.

- **Build Windows paths with `path.join`, not template literals.** A single
  backslash in a JS string is an escape: `` `${dir}\cloudflared\cloudflared.exe` ``
  silently collapses to `dircloudflaredcloudflared.exe`, and the only symptom
  is "the program isn't installed". Cost a debugging round on 2026-08-26.

- **`powershell -Command "..."` invoked from a .cmd file eats commas.** The
  launcher's browser probe was `foreach($p in @('a','b','c'))`; powershell.exe
  treats command-line commas as argument separators, so the array arrived as
  ONE space-joined string, every `Test-Path` failed, and Helm silently opened
  in a browser tab instead of an app window. Keep inline PowerShell comma-free,
  or do the work in cmd (`start-helm.cmd` now uses plain `if exist` probes).
  Same neighbourhood: unbraced `$env:ProgramFiles+'\x'` swallows the `+` into
  the variable name - write `${env:ProgramFiles}` or cmd's `%ProgramFiles%`.
- **An Edge/Chrome `--app=` window is hosted by the ALREADY-RUNNING browser
  process**, so the process you spawned exits and no `msedge.exe` command line
  contains `--app`. Don't verify the launcher that way; check the window
  TITLE - an app window's title is just the page title (`Helm`), with no
  "and N more pages - Microsoft Edge" suffix.

## The floating (picture-in-picture) pane can only be tested headed
Document Picture-in-Picture is how a pane leaves the grid for an always-on-top
window (`web/src/hooks/usePipWindow.ts`). In **headless** Edge,
`'documentPictureInPicture' in window` is TRUE and `requestWindow()` resolves —
the app state even advances (the pane leaves the grid) — but no separate window
or CDP target is ever created, so every assertion about the floating window
fails while the feature is fine. Launch a headed browser for this one.

**Never close the old floating window before opening the new one.**
`requestWindow()` needs *transient user activation* — the few seconds of
permission a click grants — and `Window.close()` can spend it, so a
close-then-request sequence throws `Document PiP requires user activation` even
though the user really did click. There is only ever one such window per
document, so requesting a new one already replaces the old: just request, and
let the old window's `pagehide` teardown run on its own (the caller's
in-flight guard is what stops that teardown from clearing the state you are
about to set). A rejected open must also reset the "it's floating" state, or
the grid is left missing a pane that is nowhere on screen.

Two related traps in the same area, both fixed but easy to reintroduce:
- Anything bound to the page's `document`/`window` (a document-level paste
  fallback, a Modal's Esc handler) is invisible to the floating window, which
  is a *different document*. Bind to `el.ownerDocument` instead.
- The floating document starts BLANK: no stylesheets, no `data-theme`/
  `data-accent`. They are copied/mirrored on open, and the mirror is a
  MutationObserver because the Appearance dialog can change them mid-float.

When driving a REAL claude pane in a script of your own, note that the
folder-trust dialog's default option is **"No, exit"** — a blind `
` nudge into
a fresh temp dir can quit claude with exit 1 (the pane then reads `exited (1)`
and, because the TUI's alternate screen is discarded on exit, the replay shows
the trust dialog again, which looks like it never got past it). `npm run e2e`
handles this correctly; the cheap alternative for one-off scripts is to point
the workspace at an ALREADY-TRUSTED directory so no dialog appears at all, and
to send a `resize` on the attached socket before waiting for `activity`.

## `mkdirSync`'s return value is a `\\?\` path, and ConPTY silently rejects it
`fs.mkdirSync(p, { recursive: true })` does not return `p` — on Windows it
returns the extended-length form, `\\?\C:\Users\...`. Node accepts that
everywhere, so it looks fine; node-pty does not, and rather than failing it
starts the process in **`C:\Windows`**. The pane runs, hooks fire, the
transcript appears — and every relative file operation inside it lands in a
directory that isn't writable, which surfaces as claude reporting
`EPERM ... C:\Windows\<file>` long after the real mistake.

```js
const dir = fs.mkdirSync(path.join(tmp, 'proj'), { recursive: true }); // WRONG
const dir = path.join(tmp, 'proj');                                    // right
fs.mkdirSync(dir, { recursive: true });
```

This sat unnoticed in `test/e2e-real.mjs` until a check finally depended on the
pane's cwd being writable.

## `--allowed-tools ""` does NOT disable tools (it cost 28x)
For a headless `claude -p` call that only rewrites text (the dictation polish),
the obvious flag is wrong in an expensive, silent way:

- **`--allowed-tools ""`** is a *permission allowlist*. The built-in tool
  DEFINITIONS still load — measured at 33,943 cache-creation tokens — and the
  model still attempts a tool call, spending its single turn and ending on
  `terminal_reason: max_turns` with **no `result` text at all**. $0.070 for
  nothing, on every call, and the route silently falls back to raw so it looks
  like the model is just bad.
- **`--tools ""`** removes them from the context. Same prompt: 508 input
  tokens, `stop_reason: end_turn`, $0.0025.
- Pair it with **`--system-prompt`** (replaces claude's agent system prompt,
  which a text rewriter needs none of). Keep that string short and quote-free —
  it rides on the command line; put the real instructions on **stdin**.
- **`--bare`** looks perfect for this (skips CLAUDE.md discovery, hooks, memory)
  but it **refuses OAuth and demands `ANTHROPIC_API_KEY`** — it would turn a
  subscription feature into a metered one. Not an option here.

Also: a `claude -p` call racing a *pane's* claude boot can exceed 30 s (two CLI
cold starts competing) where a settled machine answers in 5–10 s. Size timeouts
around the contended case, not the quiet one.

**A `claude -p` process cannot be pre-warmed.** The obvious latency trick —
spawn it when the mic opens so its startup happens while you talk, then write
the prompt when you stop — does not work, in two different ways:

- Plain `-p` **gives up on stdin after 3 seconds**: `Warning: no stdin data
  received in 3s, proceeding without it` followed by `Error: Input must be
  provided either through stdin or as a prompt argument`, exit 1. A process
  cannot be parked for the length of a spoken sentence. The failure is quiet
  from the caller's side — the polish route just falls back to raw in ~50 ms,
  which looks like a 96% speed-up until you check the `polished` flag.
- `--input-format stream-json` **does** park indefinitely and answers correctly,
  but it reloads the full agent context regardless of `--tools ""`: 98,850
  cache-creation tokens, **$0.199 a call** against $0.0011 for spawning late.

So the polish process is spawned when dictation STOPS, and the ~0.5–1.4 s of
CLI startup is simply part of the 2.1 s. If you try this again, assert on
`polished === true`, not on wall-clock time.

**And check where the time actually goes before optimising anything else.** On
the polish call the answer was not process startup (~0.4–1.4 s) or the network
— it was **extended thinking**, burning ~984 of ~1000 output tokens on a task
whose answer is 24 tokens. `MAX_THINKING_TOKENS=0` took it from 16 s / $0.0083
to 2.1 s / $0.0011 per dictation with the 10-case bench still at 10/10. For any
short, mechanical `claude -p` call, turn thinking off first and measure second;
for a call that genuinely reasons (suggest-start), leave it on.

## The native notch: two Windows traps that look like "it doesn't work"
Both cost a debugging cycle on the WPF + WebView2 notch (`desktop/HelmNotch`).

**1. `AllowsTransparency="True"` on a WPF window hosting WebView2 renders
beautifully and accepts NO MOUSE INPUT.** The flag makes WPF host the window as
a LAYERED window (`WS_EX_LAYERED`), and the hosted WebView2 never receives a
mouse message. Shipped exactly once; the owner reported "i cant click the notch,
i cant close it". Every visual check passed — transparent corners, drop shadow
over the live desktop, the window resizing to its content — because rendering
and input are different subsystems and I had only tested the first.
A/B, same binary, same synthetic OS click at the window's centre:
`WS_EX_LAYERED=True` → the click goes nowhere; `WS_EX_LAYERED=False` → the click
reaches the page. So: NO `AllowsTransparency`. Shape comes from DWM instead —
`DwmSetWindowAttribute(hwnd, DWMWA_WINDOW_CORNER_PREFERENCE=33, DWMWCP_ROUND=2)`
in `SourceInitialized` — which rounds the window itself, costs no input, and is
ignored harmlessly on pre-22H2 Windows. The trade is real: no per-pixel alpha
and no soft shadow. Worth it, because a window you cannot click is not a window.

**Two testing lessons under this one.** A screenshot proves rendering and
NOTHING about input — for anything interactive, assert on an interaction with a
consequence (here: click the close button, assert the PROCESS exits). And CDP's
`Input.dispatchMouseEvent` injects straight into the renderer, BYPASSING the OS
window message queue — precisely the path a layered window breaks — so it would
have passed against the broken build. Real `SetCursorPos` + `mouse_event` is
what actually proves a window is clickable. `HELMNOTCH_DEBUG_PORT` opens the
notch's DevTools port for the DOM-level half of such a test.

**2. Sizing a window from the page it hosts is a FEEDBACK LOOP if you do both
axes.** Shipped and immediately reported as "it's shaking left and right on my
screen". The page measured its own width and asked the window to match; the new
window width reflowed the content and made the page-level scrollbar appear or
disappear, which changed the measured width straight back. It settled into an
oscillation between two widths, and because the window re-centred itself after
each change (`Left += (before - Width) / 2`), that read as the whole notch
shaking sideways several times a second. Three parts to the fix, all needed:
**the window owns its WIDTH and only height follows content** (content height
depends on width, not the reverse, so height alone cannot loop); `overflow:
hidden` on the notch document so no scrollbar can flip the layout; and a 2px
dead band at both ends for CSS-pixel-vs-DIP rounding. Cap long content with a
FIXED pixel `max-height`, never a `vh` one — the viewport height is the thing
being driven, so sizing content off it is circular again. Regression-checked by
sampling `GetWindowRect` 40 times over 10 s and asserting one distinct left and
one distinct width.

**3. Animating a window: proportional steps and separate property sets both
show up as jitter.** Owner-reported on the notch's open/close morph. Three
causes, all in one small loop: (a) moving a FRACTION of the remaining distance
per tick never really converges, so it ran a long tail of sub-pixel frames, each
repainting and re-cutting the window region; (b) setting WPF's `Left`, `Width`
and `Height` separately issues a window reposition PER PROPERTY, so one
animation frame moved the window two or three times — visible as wobble; (c)
fractional sizes made each frame land on a different sub-pixel rounding. Fix:
time-based easing over a fixed duration (easeOutCubic, 160 ms) that lands
exactly, whole-pixel sizes, and ONE `SetWindowPos` per frame with the region
re-cut only when the size actually changed. Jitter is measurable, so measure it:
sample `GetWindowRect` every ~8 ms through the transition and assert the width
never reverses, the window stays centred on every frame, it lands exactly on the
target, and nothing moves afterwards.

**4. A page cannot raise its own window; a native process can.** The notch's
"click an agent to go to it" did the pane selection correctly and then called
`window.focus()` in Helm's page to bring it forward — which browsers ignore for
a minimised or background window. So the right pane was selected inside a Helm
that stayed hidden, in exactly the situation the notch exists for. The notch
raises it instead (`ShowWindow(SW_RESTORE)` + `SetForegroundWindow`); Windows
only grants foreground rights to a process with recent input, and the user has
just clicked the notch, so it qualifies. A CDP-injected click would NOT qualify
— test this one with a real `SetCursorPos`+`mouse_event`.

**5. Stale `--app=` windows will frame the app for your test's bug.** Killing the
launcher PID does not close an `--app=` window (it is hosted by the shared
browser process — see the title-matching note above), so failed runs pile up
Helm windows. The raise test then minimised ITS window while the notch quite
correctly raised a leftover one that was NOT minimised, and the result read as
"the feature is broken". Close them by title with `WM_CLOSE` at the start of any
test that cares, and assert on the handle the host reports rather than one the
test found independently.

**6. `Process.MainWindowHandle` is 0 for a frameless, taskbar-less window.**
The .NET heuristic wants a visible top-level window with a title bar, and the
notch has `WindowStyle="None"` + `ShowInTaskbar="False"`. Any script that
measures or drives the window must enumerate instead — `EnumWindows` +
`GetWindowThreadProcessId`, first visible top-level window for the pid. A check
written against `MainWindowHandle` reports `0x0` and reads as "the window never
opened" when it is sitting right there on screen.

Related: `DragMove()` throws unless called during a mouse-down, and the notch's
drag request arrives asynchronously from the page. Post
`WM_NCLBUTTONDOWN`/`HTCAPTION` to the window instead — it also gets you snapping
and Aero shake for free.

## `proc.kill()` kills the shell, not the program, whenever you spawned via one
`spawn(cmd, { shell: true })` — which Node needs for a `.cmd`/`.bat` — makes
`proc` the shell, and the thing you actually wanted is its CHILD. Killing the
parent orphans the child, and nothing ever reaps it. Helm's share links hit this:
`stopTunnel` deleted the tunnel from its map and called `proc.kill()`, so the
bookkeeping was right and `/api/tunnels` correctly reported none — while the
process kept running. The smoke suite leaked exactly TWO stand-in processes per
run, on every machine that ran it, for weeks; 24 had piled up before anyone
counted. NOT only a test artifact: `needsShell` fires for any `.cmd`, and
`cloudflared` on PATH is a `.cmd` shim under several package managers, so a REAL
tunnel could survive being closed — a live public URL nobody is left holding.
Fix: kill the TREE (`taskkill /PID <pid> /T /F` on Windows), synchronously,
because shutdown exits a few hundred ms later and an async kill loses that race.

**Test it by pid, not by absence of complaints.** The regression test has the
stand-in write its OWN pid to a file (the pid Helm holds is the shim's) and
asserts `process.kill(pid, 0)` throws after the stop. Verified to have teeth by
reverting the fix and watching it fail. A leak like this is invisible to every
green test run — the suite passed the whole time.

## Line endings are MIXED in this repo, and prettier will fail you for it
`.gitattributes` says `* text=auto` and `.prettierrc` says `endOfLine: "auto"`,
so files are checked out with CRLF on Windows — but not all of them: some
(`server/index.mjs`, `web/vite.config.ts`, `web/src/components/AgentHud.tsx`)
are LF in the working copy while others (`web/src/App.tsx`, `api.ts`,
`types.ts`, `docs/*.md`) are CRLF. Two traps follow:

1. **A multi-line anchor written with `
` silently will not match a CRLF
   file.** Single-line anchors match either way, which is worse — a script can
   half-apply and look like it worked. Read with universal newlines
   (`open(p, encoding='utf-8')`) and write the file's own ending back
   (`newline='

'`), or use the Edit tool.
2. **`endOfLine: "auto"` means "match the file's FIRST line ending"**, so
   appending LF content to a CRLF file makes it MIXED and `npm run format:check`
   fails on it — a confusing failure, since the diff looks like whitespace-only
   noise. Normalize the whole file, or just run `npx prettier --write <file>`
   after editing and let it settle both formatting and endings.

Markdown and CSS are not in prettier's globs (`*.{ts,tsx,mjs}` only), so a
mixed `.md`/`.css` breaks nothing — but keep them uniform anyway so diffs stay
readable.

## The smoke suite needs `web/dist`, and CI does not build it for free
Two tests ask the server for `/` and `/hud` and assert the auth token was
injected into the HTML. `servePage` reads those files off disk from
`web/dist`, which is GITIGNORED — so on a runner that only installed the
server, both answer **503** and the failure looks like a broken route rather
than a missing build. The smoke job installs and builds `web/` first for
exactly this reason; don't drop those steps to make CI faster.

Locally the same trap is invisible, because your `web/dist` is already there
from the last build. To reproduce a CI-shaped run: `mv web/dist web/dist.bak`,
`npm test`, then move it back.

## Three ways a CDP check LIES about a filter or a shortcut
All three hit while building pane categories + favourites, and each one reads
as a broken feature when only the test is broken.

1. **A "the expected rows are there" assertion passes VACUOUSLY against an
   unfiltered list.** The first Ctrl+K category check asserted that both
   matching panes appeared — and they did, in a list of all 21 rows, because
   the query never reached the input. Always assert **exclusion** too: the row
   that must NOT survive the filter is the half that has teeth.
2. **Ctrl+K is a TOGGLE** (`setPaletteOpen((o) => !o)`). A script that leaves
   the palette open means the next script's Ctrl+K CLOSES it, and the symptom
   is "the keyboard shortcut stopped working". Reload the page between scripts
   rather than assuming a fresh DOM.
3. **A synthetic `Enter` on `document` does not select a palette row.** The
   jump ran nowhere, so the guard under test looked broken. Click the actual
   `.cmdk-item` element instead — and generally prefer clicking the real thing
   over dispatching the key that would have clicked it.

Related, in the smoke suite: the MAIN test server takes its data dir from
`LOCALAPPDATA`, so its state is `tmp\Helm`, while the seeded aside-servers use
`HELM_DATA_DIR` and theirs is the dir itself. `persistedSessions(tmp)` silently
returns `[]` against the main server — pass `path.join(tmp, 'Helm')`.

## Testing pattern that works
`cd server && npm run e2e` now codifies this permanently
(`server/test/e2e-real.mjs`): it drives a real `claude` pane through
spawn → trust dialog → hooks/status → transcript/usage/title → server restart →
revive, against isolated Helm state (`HELM_DATA_DIR`) so your real store is
untouched. Not in `npm test`/CI (needs a logged-in claude, spends tokens). Run
it after spawn/hook/usage/revive changes and after any claude CLI update.

Hard-won specifics it encodes (useful if you write another throwaway script):
- **ConPTY collapses on-screen spaces** — pane output reads `trustthisfolder`,
  not `trust this folder`, so matching dialog *text* is unreliable. Just send
  `\r` a few times early to accept the trust dialog (idempotent once past it).
- **The public API never exposes `claudeSessionId`/`transcriptPath`** — assert
  on `canResume` / `hasTranscript` / `summary` instead (see `sessionInfo`).
- **Hooks carry `session_id` + `transcript_path`**; SessionStart's `source` is
  `startup`. `HELM_DEBUG_HOOKS=1` dumps the raw payload to the 🐞 log — the
  fastest way to spot claude-side field drift.
- claude takes 5–10 s to boot/respond; wait generously. Clean up sessions after.
