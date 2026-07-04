#!/bin/sh
# POSIX shim for the stand-in (see fake-claude.cmd). Helm's args are ignored.
exec node "$(dirname "$0")/fake-claude.mjs"
