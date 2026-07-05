# Helm — claude CLI internals Helm depends on

Helm's features (usage, cost, status, revive, pane titles, account email) are
parsed out of the `claude` CLI's **undocumented** on-disk formats, env vars, and
flags. None of this is a public API, so a claude release can change it and
Helm's features quietly return zeros / "no data".

**This file is the single catalogue of every such assumption**, so drift can be
fixed fast. When a claude update breaks something, check here first, fix the
parse in `server/index.mjs`, bump the floor below, and update this doc.

- **Known-good floor:** `2.1.198` (constant `CLAUDE_VERSION_FLOOR` in
  `server/index.mjs`). Verified end-to-end at this version.
- **Drift is now surfaced loudly** (see "Drift detection" at the bottom) — a
  boot-time version check + parse-time signals feed `GET /api/diagnostics` and a
  dismissible banner (`web/src/components/DriftBanner.tsx`). It won't fix drift,
  but it stops it being silent.

---

## 1. Transcript files (usage, cost, revive, titles)

- **Location:** `<configDir>/projects/<encoded-cwd>/<sessionId>.jsonl`; subagent
  transcripts nest in `<...>/<sessionId>/subagents/*.jsonl`. Walked recursively
  by `transcriptFiles()`.
- **`<configDir>`** = `CLAUDE_CONFIG_DIR` if set, else `~/.claude` (the default
  account); named profiles live under `%LOCALAPPDATA%\Helm\accounts\<name>`
  and are passed to claude as `CLAUDE_CONFIG_DIR`. See `configRoot()`.
- **Assistant usage line** (parsed in `parseTranscriptFile()`):
  ```jsonc
  { "type": "assistant", "timestamp": "<ISO>",
    "message": { "id": "<dedupe key>", "model": "claude-…",
      "usage": { "input_tokens", "output_tokens",
                 "cache_read_input_tokens", "cache_creation_input_tokens" } } }
  ```
  - Deduped by `message.id ?? uuid` (streaming logs a message on several lines).
  - `model === '<synthetic>'` is skipped (error/retry placeholders).
- **First-prompt title** (`firstPromptSummary()`): first `type:'user'`,
  non-`isMeta` line; `message.content` is a string or an array of
  `{ type:'text', text }` blocks; slash-command / system-reminder wrappers are
  skipped.

## 2. Model names → pricing

`MODEL_PRICING` in `server/index.mjs` matches model ids by **name prefix**
regex: `claude-(fable|mythos)`, `claude-opus`, `claude-sonnet`, `claude-haiku`.
An unmatched model contributes **$0** (never a guess) — and now raises an
`unknown-model` drift warning. **A new model family = add a row here.**

## 3. Account config files (email, login state)

- `<configDir>/.claude.json` → `oauthAccount.emailAddress` (account email).
- `<configDir>/.credentials.json` — presence ≈ "logged in".
- `hasCompletedOnboarding` (in `.claude.json`) — used when bootstrapping a
  profile dir.

## 4. Environment variables (spawn hygiene — see GOTCHAS)

`spawnPty()` scrubs/sets these because inheriting them silently broke transcript
writing (dissected in `docs/GOTCHAS.md`):
- **Scrubbed:** `CLAUDECODE`, `CLAUDE_CODE_*` (esp. `CLAUDE_CODE_CHILD_SESSION`)
  — inherited when Helm is started from inside a claude session; makes panes
  skip session persistence (no JSONL written at all).
- **Forced `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=0`** — with agent-teams on, a
  lead stops logging assistant lines once it spawns a teammate.
- **Set `CLAUDE_CONFIG_DIR`** (per profile) and `HELM_HOOK_TOKEN` (hook relay).

## 5. Hooks (status badges, session id / transcript path capture)

- Events relayed via `claude --settings <hook-settings.json>` (never edits a
  profile's own settings): `SessionStart`, `UserPromptSubmit`, `Stop`,
  `Notification`. Relay script: `server/hook-post.mjs`.
- Hook payload fields read: `session_id`, `transcript_path`, `hook_event_name`,
  `message` (Notification text → the pane's `activityNote`).

## 6. CLI flags

`--settings <file>`, `-n <name>` (pane title), `--resume <sessionId>` (revive),
`--login`, `--version` (the drift check). On Windows the executable is the
`claude.cmd` shim (node-pty can't run the `.ps1`).

---

## Drift detection (what fires the banner)

Implemented in `server/index.mjs` (`checkClaudeVersion`, `noteDrift`, and inline
signals), exposed at `GET /api/diagnostics`:

| Signal | Key | Trigger |
|---|---|---|
| CLI missing | `claude-missing` | `claude --version` fails to run |
| Below floor | `claude-below-floor` | version < `CLAUDE_VERSION_FLOOR` |
| Unknown model | `unknown-model:<model>` | a real model with tokens matches no `MODEL_PRICING` row |
| Transcript shape | `transcript-shape` | a >16 KB transcript parses as JSON but yields 0 usage entries |

Warnings are deduped by key, counted, and shown until dismissed; a *new* key
re-opens the banner.
