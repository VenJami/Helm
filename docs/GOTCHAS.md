# Helm — Hard-won gotchas (read before touching server code)

- **node-pty 1.0.0 kill-race crash:** killing a pty whose process already died
  can throw an unhandled `TypeError … 'forEach'` from `windowsPtyAgent.js` and
  it WILL take down the whole server. Guarded in `server/index.mjs` by a
  targeted `unhandledRejection` handler (swallows exactly that, rethrows the
  rest). Don't "fix" by upgrading node-pty casually — the prebuilt binary
  install is version-sensitive; an upgrade may require a native toolchain this
  box lacks.
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
