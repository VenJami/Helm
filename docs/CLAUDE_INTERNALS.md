# Helm — claude CLI internals Helm depends on

Helm's features (usage, cost, status, revive, pane titles, account email) are
parsed out of the `claude` CLI's **undocumented** on-disk formats, env vars, and
flags. None of this is a public API, so a claude release can change it and
Helm's features quietly return zeros / "no data".

**This file is the single catalogue of every such assumption**, so drift can be
fixed fast. When a claude update breaks something, check here first, fix the
parse in `server/index.mjs`, bump the floor below, and update this doc.

- **Where the code lives:** everything below is implemented in
  `server/src/claude.mjs` — the single module for claude-internals, so drift is
  a one-file fix.
- **Known-good floor:** `2.1.198` (constant `CLAUDE_VERSION_FLOOR` in
  `server/src/claude.mjs`). Verified end-to-end at this version.
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

`MODEL_PRICING` in `server/src/claude.mjs` matches model ids by **name prefix**
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

`MAX_THINKING_TOKENS=0` is set on the **dictation-polish call only**, and it is
the largest single performance lever in Helm. Extended thinking was consuming
~984 of ~1000 output tokens while the actual answer is ~24 tokens of rewritten
English — the model deliberating over where a comma goes. Measured over the
same 10-dictation bench:

| | Per dictation | Cost | Bench |
|---|---|---|---|
| thinking on | 5.0–35.5 s (avg 16 s) | $0.0083 | 10/10 |
| thinking off | 2.0–2.3 s (avg 2.1 s) | $0.0011 | 10/10 |

7.6x faster, 7.5x cheaper, identical rule compliance. `suggest-start`
deliberately KEEPS thinking — working out how a project starts really is a
reasoning task. This env var is undocumented, so if a claude update drops it
the polish call gets slow again but never wrong.

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

Headless (the "ask claude how to start this project" call, `POST
/api/workspaces/:id/suggest-start`): `-p` with the prompt on **stdin**,
`--output-format json`, `--allowed-tools "Read,Glob,Grep"` (read-only: it works
the command out, it never runs one), `--max-turns 12`. No model is pinned — the
account's default is used, because a cheaper model missed one of two required
processes in testing. Two notes that are easy to trip over:

- The prompt goes on stdin, never in argv. `claude.cmd` is a batch file and
  Node 22 refuses to spawn one without a shell (`EINVAL`), and a prompt
  containing `&&` and quotes would be interpreted by that shell.
- No PTY, no hooks, no pane — but the same inherited-identity env scrub as a
  pane (section 4), and the workspace's pinned profile via `CLAUDE_CONFIG_DIR`.

## 7. `claude -p --output-format json` envelope

Parsed by `parseClaudeEnvelope` in `server/src/claude.mjs`, shared by both
headless callers. Fields Helm reads (verified on 2.1.246):

| Field | Used for |
|---|---|
| `result` | the model's reply text |
| `total_cost_usd` | the "$0.02" shown with the suggestion (optional) |

Everything else in the envelope is ignored. Output is normally one JSON line;
the parser also accepts a trailing/leading extra line by taking the last line
that parses. A shape change here is drift, not a caller bug — see below.

Two callers use it:

| Call | Flags | Notes |
|---|---|---|
| suggest-start | `-p --output-format json --allowed-tools "Read,Glob,Grep" --max-turns 12` | runs in the project dir; the reply's first JSON array is the command list |
| dictation polish | `-p --output-format json --model haiku --tools "" --max-turns 1 --system-prompt "…"` | **runs in a neutral cwd on purpose** |

Three of those flags were measured against the real CLI, and the naive version
of this call cost **28x more and returned nothing usable**. Numbers from
2.1.246 on the same one-sentence dictation:

| Call | Input tokens | Result | Cost |
|---|---|---|---|
| `--allowed-tools ""` (wrong) | 33,943 cache-creation | `stop_reason: tool_use`, `terminal_reason: max_turns` — no text | $0.070 |
| `--tools "" --system-prompt` | 508 | `stop_reason: end_turn` | $0.0025 |

- **`--tools ""`** is the one that matters. `--allowed-tools` is a *permission
  allowlist*: the built-in tool DEFINITIONS still load (~34k tokens) and the
  model still tries to call one, spending the single turn and ending on
  `max_turns` with no answer. `--tools ""` removes them from the context.
- **`--system-prompt`** replaces claude's agent system prompt, which a
  dictation cleaner needs none of. Kept short and quote-free because it rides
  on the command line; the detailed rules go in on **stdin**, out of the
  shell's reach.
- **The neutral cwd** is load-bearing too: `claude -p` auto-loads the CLAUDE.md
  of whatever directory it starts in, and in this repo CLAUDE.md pulls
  `docs/ROADMAP.md` with it — ~13k tokens per dictation to rewrite one
  sentence. The call runs in `<HELM_DIR>/voice`, which has no CLAUDE.md.

User-level `~/.claude` memory still loads and isn't ours to skip. `--bare`
would skip it, but it also refuses OAuth and requires `ANTHROPIC_API_KEY` —
exactly the second bill this feature exists to avoid, so it is not an option.
`HELM_POLISH_MODEL` overrides the model if `haiku` is ever refused.

The polish reply is then run through `cleanPolished`, because a prompt is not a
contract: it strips a "Here's the cleaned version:" preamble, a code fence, and
quotes wrapped around the whole answer, and **rejects a reply more than 3x the
length of the transcript** — the signature of the model answering the request
instead of rewriting it. A rejected reply is not an error; the route returns the
raw transcript, so dictation degrades to plain speech-to-text and never loses
what you said.

---

## Drift detection (what fires the banner)

Implemented in `server/src/claude.mjs` (`checkClaudeVersion`, `noteDrift`, and
inline signals), exposed at `GET /api/diagnostics`:

| Signal | Key | Trigger |
|---|---|---|
| CLI missing | `claude-missing` | `claude --version` fails to run |
| Below floor | `claude-below-floor` | version < `CLAUDE_VERSION_FLOOR` |
| Unknown model | `unknown-model:<model>` | a real model with tokens matches no `MODEL_PRICING` row |
| Transcript shape | `transcript-shape` | a >16 KB transcript parses as JSON but yields 0 usage entries |
| Suggest: not JSON | `suggest-nonjson` | `claude -p --output-format json` printed something unparseable |
| Suggest: no result | `suggest-noresult` | that envelope had no string `result` field |
| Polish: not JSON | `polish-nonjson` | the dictation-polish call printed something unparseable |
| Polish: no result | `polish-noresult` | that envelope had no string `result` field |

Warnings are deduped by key, counted, and shown until dismissed; a *new* key
re-opens the banner.
