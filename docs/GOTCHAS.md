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
  only appends). The incremental parser (`readAppendedLines` in index.mjs) reads
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

## Testing pattern that works
Write a throwaway node script (in the session scratchpad, not the repo) that
hits the REST API + WS of a locally started server and drives a real
`claude.cmd` pane: accept the trust dialog by sending `\r`, wait generously
(claude takes 5–10 s to boot/respond), assert on stripped-ANSI output. Verify
features end-to-end before declaring them done. Clean up test
sessions/profiles afterwards.
