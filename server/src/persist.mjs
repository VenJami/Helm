// Helm — crash-safe JSON persistence.
// All state writes go through temp-file + rename (atomic on the same volume),
// keeping the previous good copy as <file>.bak. A server killed mid-write can
// no longer leave a truncated file — and a corrupt file recovers from its .bak
// loudly instead of being treated as first-run, which used to silently wipe
// every persisted session/workspace. Use these for ANY new persisted file;
// never raw writeFileSync (docs/GOTCHAS.md).

import fs from 'node:fs';
import path from 'node:path';
import { dbg } from './log.mjs';

export function writeFileAtomic(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, data);
  try {
    fs.copyFileSync(file, `${file}.bak`);
  } catch {
    /* first write — nothing to back up */
  }
  fs.renameSync(tmp, file);
}

export function writeJsonAtomic(file, obj) {
  writeFileAtomic(file, JSON.stringify(obj, null, 2));
}

// undefined = file missing (a normal first run).
export function readJsonWithBackup(file, label) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return undefined;
  } // first run
  try {
    return JSON.parse(raw);
  } catch {
    /* corrupt — fall through to .bak */
  }
  try {
    const val = JSON.parse(fs.readFileSync(`${file}.bak`, 'utf8'));
    dbg('error', `${label} file was corrupt — recovered from ${path.basename(file)}.bak`);
    return val;
  } catch {
    dbg(
      'error',
      `${label} file is corrupt with no usable .bak — starting empty (bad file left at ${file})`,
    );
    return undefined;
  }
}
