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
