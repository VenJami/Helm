// Runs as a Claude Code hook inside Helm-spawned sessions (wired up via the
// generated hook-settings.json passed to `claude --settings`). Reads the hook
// payload from stdin and relays it to the Helm server so panes can show
// working / waiting / idle status and know their claude session id.
//
// Must NEVER block or fail the Claude session: exits 0 no matter what.

const sessionId = process.env.HELM_SESSION_ID;
const token = process.env.HELM_HOOK_TOKEN;
const port = process.env.HELM_PORT;
if (!sessionId || !token || !port) process.exit(0); // not a Helm-spawned session

let raw = '';
process.stdin.setEncoding('utf8');
for await (const chunk of process.stdin) raw += chunk;

try {
  await fetch(`http://127.0.0.1:${port}/api/hook`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-helm-hook': token },
    body: JSON.stringify({ sessionId, event: JSON.parse(raw) }),
    signal: AbortSignal.timeout(1500),
  });
} catch {
  /* Helm unreachable or payload malformed — never block claude */
}
process.exit(0);
