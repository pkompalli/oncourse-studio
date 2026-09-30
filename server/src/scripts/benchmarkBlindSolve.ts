/**
 * Does answering the question first actually catch the defects a tester caught?
 *
 * benchmarkGates.ts measures the deterministic checks, which cost nothing to run and therefore
 * only have to earn a low false-positive rate. The blind pass costs an LLM call per batch, so it
 * has to earn its place against the thing it was built for: 19 items whose key or options were
 * wrong, every one of which had an explanation that agreed with the key and so sailed through a
 * validator, an adversarial reviewer and an auditor that were all shown that agreement.
 *
 * The corpus is the pre-repair snapshot, so each question still carries the WRONG key. A blind
 * attempt that disagrees with the stored key is a catch. One that agrees is a miss — the same
 * miss the pipeline made at the time.
 *
 * Control group: the same number of rows the tester did NOT report, to see how often a blind
 * attempt disagrees with a key that is fine. That number is the cost side, and without it the
 * catch rate means nothing.
 *
 *   npx tsx src/scripts/benchmarkBlindSolve.ts            # the 19 reported defects + 19 controls
 *   npx tsx src/scripts/benchmarkBlindSolve.ts --controls 40
 */
import 'dotenv/config';
import { readFileSync, readdirSync } from 'node:fs';
import { runBlindSolveBatch } from '../services/review/adversarial.js';

const argOf = (name: string, fallback: number): number => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? Number(process.argv[i + 1]) : fallback;
};
const CONTROL_COUNT = argOf('controls', 19);
const BATCH = 10;

const snapFile = readdirSync('backups').filter((f) => f.startsWith('qb_questions_pre_qa3')).sort().pop();
if (!snapFile) { console.log('no round-3 snapshot in backups/'); process.exit(1); }
const rows = JSON.parse(readFileSync(`backups/${snapFile}`, 'utf8')) as Array<Record<string, unknown>>;

const src = readFileSync('src/scripts/repairQaRound3.ts', 'utf8');
const reported = new Set([...src.matchAll(/id: '([0-9a-f]{8})'/g)].map((m) => m[1]));

const isReported = (r: Record<string, unknown>) => reported.has(String(r.id).slice(0, 8));
const defects = rows.filter(isReported);

// Controls drawn evenly across the bank rather than from the front, so they are not all one
// course or one format.
const clean = rows.filter((r) => !isReported(r));
const stride = Math.max(1, Math.floor(clean.length / CONTROL_COUNT));
const controls = Array.from({ length: CONTROL_COUNT }, (_, i) => clean[i * stride]).filter(Boolean);

console.log(`snapshot: ${snapFile}`);
console.log(`${defects.length} reported defects, ${controls.length} controls\n`);

async function measure(label: string, sample: Array<Record<string, unknown>>) {
  let disagreed = 0;
  let blocked = 0;
  let unreadable = 0;
  const lines: string[] = [];

  for (let i = 0; i < sample.length; i += BATCH) {
    const batch = sample.slice(i, i + BATCH);
    const attempts = await runBlindSolveBatch(batch, 'exam preparation');
    attempts.forEach((a, j) => {
      const row = batch[j];
      const id = String(row.id).slice(0, 8);
      if (!a) { unreadable++; lines.push(`   ${id}  (no attempt returned)`); return; }
      if (a.disagreesWithKey) disagreed++;
      if (a.blockers.length) blocked++;
      const flags = [
        a.disagreesWithKey ? `DISAGREES [${a.disagreementDetail}]` : '',
        a.disagreesWithKey && a.confidence.toLowerCase() === 'low' ? '(low confidence — reported, not blocking)' : '',
        ...a.blockers.map((b) => b.split(' ')[0]),
      ].filter(Boolean).join(' ');
      if (flags) lines.push(`   ${id}  answered ${a.answer.slice(0, 24).padEnd(24)} ${flags}`);
    });
  }

  console.log(`${label}: ${sample.length} questions`);
  console.log(`   disagreed with the stored key : ${disagreed}`);
  console.log(`   flagged a blocker             : ${blocked}`);
  if (unreadable) console.log(`   no attempt parsed             : ${unreadable}`);
  for (const l of lines) console.log(l);
  console.log();
  return { disagreed, blocked, total: sample.length };
}

const d = await measure('REPORTED DEFECTS', defects);
const c = await measure('CONTROLS (not reported)', controls);

console.log('='.repeat(84));
console.log(`caught ${d.disagreed}/${d.total} reported defects by key disagreement alone`);
console.log(`false alarms ${c.disagreed}/${c.total} on questions nobody reported`);
console.log(
  '\nA control disagreement is not automatically wrong — the tester did not read every row, and\n' +
  'an item can be defensibly ambiguous without having been reported. Read them before judging.\n'
);
