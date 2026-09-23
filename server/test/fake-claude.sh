#!/bin/sh
# POSIX shim for the stand-in (see fake-claude.cmd). Args are forwarded so the
# stub can answer `--version`; pane args are ignored by the stub either way.
exec node "$(dirname "$0")/fake-claude.mjs" "$@"
