// Stand-in for the real `cloudflared` binary, so the smoke suite can drive the
// whole share-link lifecycle (detect → spawn → parse URL → live → stop) with
// no network, no Cloudflare account, and no 70 MB download in CI.
//
// It reproduces the two behaviours Helm actually depends on:
//   1. `--version` prints a version line and exits 0  (detection)
//   2. `tunnel --url http://localhost:N` prints the quick-tunnel banner to
//      STDERR — where the real one puts it — then stays alive until killed.
//
// What it deliberately does NOT prove: that Cloudflare's edge really serves
// the URL. That needs a real cloudflared and is out of CI by design.

const args = process.argv.slice(2);

if (args.includes('--version')) {
  console.log('cloudflared version 9999.9.9 (fake-cloudflared, smoke test)');
  process.exit(0);
}

const target = args[args.indexOf('--url') + 1] || 'http://localhost:0';
const host = `fake-${Buffer.from(target).toString('hex').slice(-8)}.trycloudflare.com`;

// The real banner is an ASCII box on stderr; Helm only regex-matches the URL,
// but keep the shape so a parser change is tested against something realistic.
process.stderr.write(
  [
    'INF +------------------------------------------------------------+',
    'INF |  Your quick Tunnel has been created! Visit it at:           |',
    `INF |  https://${host}`,
    'INF +------------------------------------------------------------+',
    '',
  ].join('\n'),
);

// Stay up until Helm kills us, like a real tunnel process.
setInterval(() => {}, 1 << 30);
