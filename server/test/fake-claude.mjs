// Stand-in for the real `claude` CLI, used only by the smoke test. It stays
// alive (so a Helm session reads as 'running' and can be attached, hooked and
// killed) and never touches the network. Helm's spawn args (--settings, -n …)
// are irrelevant here and ignored. Exits cleanly on kill so node-pty teardown
// stays quiet.
// `claude --version` — Helm's boot-time drift check calls this; answer at the
// tested floor so the isolated test server reads as a healthy claude and exits.
if (process.argv.includes('--version')) {
  process.stdout.write('2.1.198 (fake-claude)\n');
  process.exit(0);
}

process.stdout.write('fake-claude ready\r\n');
process.stdin.resume(); // consume input + keep the event loop alive
const keep = setInterval(() => {}, 1 << 30);
const bye = () => { clearInterval(keep); process.exit(0); };
process.on('SIGTERM', bye);
process.on('SIGINT', bye);
