#!/bin/sh
# POSIX shim for the cloudflared stand-in (see fake-cloudflared.mjs).
exec node "$(dirname "$0")/fake-cloudflared.mjs" "$@"
