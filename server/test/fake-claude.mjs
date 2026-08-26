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

// `claude -p` — Helm's "ask claude how to start this project" call. Reads the
// prompt on stdin and answers with the same JSON envelope shape the real CLI
// uses, so the smoke test can drive the whole route (spawn -> envelope -> parse
// -> validate) without a login, a network, or a token spend.
if (process.argv.includes('-p')) {
  let prompt = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (d) => (prompt += d));
  process.stdin.on('end', () => {
    const sawPrompt = /JSON array/i.test(prompt); // proves stdin carried the prompt
    process.stdout.write(
      JSON.stringify({
        type: 'result',
        subtype: 'success',
        is_error: false,
        total_cost_usd: 0.0123,
        result: sawPrompt
          ? '["cd api && npm start", "cd web && npm run watch"]'
          : '[] (no prompt arrived on stdin)',
      }) + '\n',
    );
    process.exit(0);
  });
} else {
  process.stdout.write('fake-claude ready\r\n');
  process.stdin.resume(); // consume input + keep the event loop alive
  const keep = setInterval(() => {}, 1 << 30);
  const bye = () => {
    clearInterval(keep);
    process.exit(0);
  };
  process.on('SIGTERM', bye);
  process.on('SIGINT', bye);
}
