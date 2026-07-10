<!--
Thanks for contributing! Please read CONTRIBUTING.md first — Helm favors the
lowest-effort change that fits, and asks for real-pane verification because
"build passing" ≠ "working" here.
-->

## What & why

<!-- What does this change, and what problem does it solve? Link any issue. -->

Closes #

## How I verified it

<!-- Describe what you actually ran/observed — not just "it builds". -->

## Pre-PR checklist

- [ ] **Lint + format clean** in both packages (`npm run lint` and `npm run format:check`).
- [ ] **Frontend** typechecks, tests, and builds (`cd web && npx tsc --noEmit && npm test && npm run build`).
- [ ] **Server** parses + typechecks (`cd server && npm run typecheck`) and the **smoke test passes** (`cd server && npm test`).
- [ ] For spawn/hook/usage/revive changes: I ran the **real-`claude` end-to-end check** (`cd server && npm run e2e`) and watched a real pane behave. (See CONTRIBUTING.md — a green build is necessary but not sufficient.)
- [ ] **Docs updated** to match (`README.md` / `docs/` / the `docs/ROADMAP.md` "Done" list) if behavior changed.
- [ ] **No new dependencies, services, or paid tools** (or I opened an issue to discuss first).
- [ ] Security invariants intact: server stays bound to `127.0.0.1`, Origin check + bearer token on REST/WS.
