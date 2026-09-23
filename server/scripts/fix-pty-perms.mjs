// node-pty's published tarball loses the exec bit on its POSIX `spawn-helper`
// binary, and node-pty execs that helper for every pty.spawn on macOS/Linux.
// Without it EVERY pane dies at birth with "posix_spawnp failed." — no claude
// session, no dev pane, nothing, and the error names neither node-pty nor a
// file. Windows uses ConPTY and has no helper, so it's skipped there.
//
// Runs as `postinstall`, because `npm ci` deletes node_modules and would undo
// a manual chmod. Never fails the install: a missing helper means a platform
// or a node-pty version that doesn't use one.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

if (process.platform !== 'win32') {
  const prebuilds = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    '..',
    'node_modules',
    'node-pty',
    'prebuilds',
  );
  let fixed = 0;
  let dirs = [];
  try {
    dirs = fs.readdirSync(prebuilds);
  } catch {
    /* no node-pty here (or no prebuilds) — nothing to do */
  }
  for (const d of dirs) {
    const helper = path.join(prebuilds, d, 'spawn-helper');
    try {
      const mode = fs.statSync(helper).mode;
      if (mode & 0o111) continue; // already executable
      fs.chmodSync(helper, 0o755);
      fixed++;
    } catch {
      /* not this platform's prebuild, or unwritable — leave it */
    }
  }
  if (fixed) console.log(`node-pty: restored the exec bit on ${fixed} spawn-helper binary(ies)`);
}
