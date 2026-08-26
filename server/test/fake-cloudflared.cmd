@echo off
rem Windows shim for the cloudflared stand-in (spawn can't run a .mjs directly).
rem Args are forwarded so the stub can answer --version and read --url.
node "%~dp0fake-cloudflared.mjs" %*
