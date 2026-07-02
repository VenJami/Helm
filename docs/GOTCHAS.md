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
