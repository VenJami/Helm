@echo off
rem Windows shim so node-pty can spawn the stand-in (it can't run a .mjs
rem directly). Helm's args are ignored — the stub just needs to stay alive.
node "%~dp0fake-claude.mjs"
