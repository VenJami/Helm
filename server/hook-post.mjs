// Runs as a Claude Code hook inside Helm-spawned sessions (wired up via the
// generated hook-settings.json passed to `claude --settings`). Reads the hook
// payload from stdin and relays it to the Helm server so panes can show
// working / waiting / idle status and know their claude session id.
//
// Most events are fire-and-forget. `PermissionRequest` is the exception: its
// REPLY is a decision, so this script waits for one and prints it on stdout in
// claude's hookSpecificOutput shape. Printing nothing means "ask", which is
// claude's own permission prompt in the pane — so every failure here degrades
// to the behaviour Helm had before approvals existed.
//
// Must NEVER block or fail the Claude session: exits 0 no matter what.

const sessionId = process.env.HELM_SESSION_ID;
const token = process.env.HELM_HOOK_TOKEN;
const port = process.env.HELM_PORT;
if (!sessionId || !token || !port) process.exit(0); // not a Helm-spawned session

let raw = '';
process.stdin.setEncoding('utf8');
for await (const chunk of process.stdin) raw += chunk;

// Timeout budget, innermost first, so the layer we control always wins:
//   server holds ≤12 s  <  this abort at 15 s  <  settings timeout 20 s.
// Reaching claude's own timeout would work too, but it logs a hook error; this
// way an unanswered request just falls through to the pane's prompt in silence.
let event;
try {
  event = JSON.parse(raw);
} catch {
  process.exit(0); // malformed payload — nothing to relay, nothing to decide
}
const isApproval = event?.hook_event_name === 'PermissionRequest';

// process.exit() truncates a stdout write that hasn't drained, and our whole
// contract with claude is what lands on stdout — so wait for the flush.
const write = (s) => new Promise((res) => process.stdout.write(s, () => res()));

try {
  const reply = await fetch(`http://127.0.0.1:${port}/api/hook`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-helm-hook': token },
    body: JSON.stringify({ sessionId, event }),
    signal: AbortSignal.timeout(isApproval ? 15000 : 1500),
  });
  if (isApproval && reply.ok) {
    /** @type {{decision?: string, reason?: string}} */
    const { decision, reason } = await reply.json();
    if (decision === 'allow' || decision === 'deny') {
      // The shape below is claude's REAL schema, read out of its own
      // `--debug` validation error on 2.1.260 — the published docs describe
      // `decision` as a plain "allow"/"deny" string, and the CLI rejects that
      // outright. `decision` is an OBJECT keyed by `behavior`, and a top-level
      // `decision` key is the legacy approve|block field, which fails
      // validation and voids the whole reply. See docs/CLAUDE_INTERNALS.md.
      await write(
        JSON.stringify({
          hookSpecificOutput: {
            hookEventName: 'PermissionRequest',
            decision:
              decision === 'allow'
                ? { behavior: 'allow' }
                : { behavior: 'deny', ...(reason ? { message: reason } : {}) },
          },
        }),
      );
    }
    // Anything else ('ask', a shape we don't recognise) → print nothing and
    // let claude prompt in the pane.
  }
} catch {
  /* Helm unreachable, timed out, or payload malformed — never block claude */
}
process.exit(0);
