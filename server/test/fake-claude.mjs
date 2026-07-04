// Stand-in for the real `claude` CLI, used only by the smoke test. It stays
// alive (so a Helm session reads as 'running' and can be attached, hooked and
// killed) and never touches the network. Helm's spawn args (--settings, -n …)
// are irrelevant here and ignored. Exits cleanly on kill so node-pty teardown
// stays quiet.
process.stdout.write('fake-claude ready\r\n');
process.stdin.resume(); // consume input + keep the event loop alive
const keep = setInterval(() => {}, 1 << 30);
const bye = () => { clearInterval(keep); process.exit(0); };
process.on('SIGTERM', bye);
process.on('SIGINT', bye);
