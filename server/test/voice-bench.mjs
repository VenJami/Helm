// Review what the dictation polish actually did to your words.
//
// Prompt quality is empirical — nobody can tell you a prompt is good by reading
// it. So: run the server with HELM_VOICE_BENCH=1, dictate ten real instructions
// into a pane, then run `npm run voice-bench` and read the pairs side by side.
// If the polished column is ever adding requirements you didn't say, the prompt
// is too aggressive and the NEVER block in index.mjs needs tightening.
//
// The log is opt-in and off by default: it holds things you said out loud.
// `npm run voice-bench -- --clear` deletes it when you're done.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const IS_WIN = process.platform === 'win32';
const HELM_DIR =
  process.env.HELM_DATA_DIR ||
  (IS_WIN
    ? path.join(process.env.LOCALAPPDATA || os.homedir(), 'Helm')
    : path.join(os.homedir(), '.helm'));
const FILE = path.join(HELM_DIR, 'voice', 'voice-bench.jsonl');

if (process.argv.includes('--clear')) {
  try {
    fs.unlinkSync(FILE);
    console.log(`Deleted ${FILE}`);
  } catch {
    console.log('Nothing to delete.');
  }
  process.exit(0);
}

let lines;
try {
  lines = fs.readFileSync(FILE, 'utf8').trim().split('\n').filter(Boolean);
} catch {
  console.log(
    `No bench log at ${FILE}\n\n` +
      'To record one: stop the server, start it with HELM_VOICE_BENCH=1, dictate a\n' +
      'few prompts into a pane, then run this again.',
  );
  process.exit(0);
}

const wrap = (text, width, indent) =>
  String(text)
    .split(/\s+/)
    .reduce(
      (out, word) => {
        const line = out[out.length - 1];
        if (line.length + word.length + 1 > width) out.push(word);
        else out[out.length - 1] = line ? `${line} ${word}` : word;
        return out;
      },
      [''],
    )
    .join('\n' + ' '.repeat(indent));

let changed = 0;
let fellBack = 0;
let totalCost = 0;
let totalMs = 0;

for (const [i, line] of lines.entries()) {
  let e;
  try {
    e = JSON.parse(line);
  } catch {
    continue;
  }
  const kept = e.polished && e.polished !== e.raw;
  if (kept) changed++;
  if (!e.polished) fellBack++;
  totalCost += e.cost || 0;
  totalMs += e.ms || 0;

  console.log(`\n${'─'.repeat(78)}\n#${i + 1}  ${e.at}  ${e.ms}ms  $${(e.cost || 0).toFixed(4)}`);
  console.log(`  said:     ${wrap(e.raw, 66, 12)}`);
  if (!e.polished) console.log(`  polished: (fell back to raw — ${e.why})`);
  else if (e.polished === e.raw) console.log('  polished: (unchanged)');
  else console.log(`  polished: ${wrap(e.polished, 66, 12)}`);
}

const n = lines.length;
console.log(
  `\n${'─'.repeat(78)}\n${n} dictation(s): ${changed} improved, ` +
    `${n - changed - fellBack} already clean, ${fellBack} fell back to raw.\n` +
    `Average ${Math.round(totalMs / n)}ms, $${(totalCost / n).toFixed(4)} each ` +
    `($${totalCost.toFixed(3)} total).\n\n` +
    'Read the pairs. The polish should only ever be fixing FORM — if it added a\n' +
    'requirement you never said, that is the failure worth fixing.',
);
