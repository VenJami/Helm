# Security Policy

Helm runs a **real terminal server** on your machine — every pane is a live
`claude` CLI process on a PTY, and anything typed into a pane runs with your
user account's full privileges. That makes its security model worth stating
plainly. This is a $0, local, single-user tool; the model below is designed for
exactly that, and *not* for exposing Helm to a network or multiple users.

## Threat model (what Helm defends against)

The core threat is a **cross-origin drive-by**: a webpage you visit in the same
browser trying to reach Helm's local server and run commands on your machine. An
unauthenticated localhost terminal server would be remote code execution from
any website. Helm's defenses:

1. **Loopback only.** The server binds `127.0.0.1` — it is never exposed to your
   LAN or the internet. (`HOST` in `server/index.mjs`.)
2. **Bearer token on every REST + WebSocket call.** A 192-bit random token is
   generated on first run, stored in `%LOCALAPPDATA%\Helm\token` (`~/.helm` on
   macOS/Linux), and injected into the served page. Requests without it get 401.
   The hook relay uses a *separate* token passed to panes via env.
3. **Origin check on WebSocket upgrades** — only `127.0.0.1`/`localhost` origins
   on the server's port are accepted (defense-in-depth behind the token).
4. **No command injection surface** in Helm's own shell-outs: git status and the
   console toggle use `execFile` with argument arrays (no shell string), PTYs are
   spawned with argv arrays, and uploaded filenames are sanitized.
5. **Validated trust seams.** Token compares are constant-time (no timing
   oracle). Profile names are restricted to letters/digits/dash/underscore
   everywhere they enter the API — they become directory names under
   `accounts\`. And a pane's hooks can only point the server at a transcript
   file inside that pane's own account store (the hook token is visible to
   every process running inside a pane, and the reported path is later fed to
   file reads/copies).

   On WebSocket upgrades the Origin header is only enforced when present —
   browsers always send it, so a cross-origin page can't dodge the check by
   omitting it; an absent Origin means a non-browser client, which the bearer
   token alone gates.

## What is explicitly out of scope

- **Multi-user / remote access.** Helm assumes one trusted user on the local
  machine. Do **not** expose port 7777 to a network, reverse-proxy it to the
  public internet, or run it on a shared machine. There is no per-user
  authorization, rate limiting, or audit logging — by design.
- **A malicious local process.** The token file, session state, and OAuth
  credentials live under `%LOCALAPPDATA%\Helm\` and are readable by any process
  running as your user. **That token file is effectively the whole security
  boundary** — any local process that can read it can drive the server (register
  a workspace, spawn `claude`). This is the same trust level as your shell
  history or SSH keys: protect your user account, and don't run untrusted code.
- **Secrets in transcripts.** Claude conversation transcripts (used for usage,
  revive, and titles) are stored in plaintext under the account dirs. Treat that
  directory as sensitive; it is deliberately excluded from the git repo.

## Sensitive data locations (never committed)

Everything below lives under `%LOCALAPPDATA%\Helm\` (`~/.helm` on macOS/Linux)
and is kept out of the repo via `.gitignore` — the repo folder syncs to OneDrive:

- `token`, `hook-token` — auth tokens (delete to rotate)
- `accounts\<profile>\` — per-account `CLAUDE_CONFIG_DIR`: OAuth **credentials**,
  config, and all conversation **transcripts**
- `sessions.json`, `workspaces.json`, `settings.json`, `imported-transcripts.json`
- `attachments\<session>\` — files you pasted/dropped into panes

If you lose this directory, every profile must re-login and history is gone —
there is currently no backup/export (tracked in the roadmap).

## Reporting a vulnerability

This is a personal open-source project, not a funded product with a security
team. If you find a vulnerability:

- **Do not** open a public issue with exploit details for anything that could
  compromise a user running Helm as intended (e.g. a real cross-origin bypass,
  a command-injection path, a token-leak).
- Instead, use **GitHub's private vulnerability reporting** ("Report a
  vulnerability" under the repo's *Security* tab) so it can be fixed before
  disclosure.
- For low-risk or theoretical issues, a normal issue is fine.

Please include repro steps and the `claude`/Node/OS versions. Best-effort
response — no formal SLA.
