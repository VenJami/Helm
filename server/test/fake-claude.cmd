@echo off
rem Windows shim so node-pty can spawn the stand-in (it can't run a .mjs
rem directly). Args are forwarded so the stub can answer `--version` (Helm's
rem boot-time drift check); pane args are ignored by the stub either way.
node "%~dp0fake-claude.mjs" %*
