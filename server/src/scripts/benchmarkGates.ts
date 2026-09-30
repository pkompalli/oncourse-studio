/**
 * Measure the deterministic gates against the defects a tester actually found.
 *
 * Three QA rounds produced three pre-repair snapshots in server/backups/. Each is a bank as it
 * stood BEFORE its defects were corrected, which makes it the only honest corpus available: the
 * faults are real, they were found by someone reading the questions, and the rows that were not
 * reported are — as far as anyone looked — sound.
 *
 * That gives two numbers a gate has to earn:
 *
 *   RECALL     of the rows a tester reported, how many does the gate flag?
 *   FLAG RATE  of all rows, how many does it flag at all? A gate that fires on 20% of a good
 *              bank is not a gate, whatever its recall — every false positive caps a sound
 *              question's score and spends a fixer run on it.
 *
 * Only round 3 keys its repairs by question id, so recall is computed there. Rounds 1 and 2
 * address their rows by course labels, so they contribute flag rate only, which is still the
 * number that decides whether a check is safe to make blocking.
 *
 * Read-only: snapshots on disk, no database, no LLM. Run it before wiring any new check into
 * validator.ts, and again afterwards.
 *
 *   npx tsx src/scripts/benchmarkGates.ts            # both gates
 *   npx tsx src/scripts/benchmarkGates.ts --detail   # list every finding
 */
import { readFileSync, readdirSync } from 'node:fs';
import { coherenceIssues, isBlocking } from '../services/generation/coherence.js';
import { consistencyIssues, isBlockingConsistency } from '../services/generation/consistency.js';

const DETAIL = process.argv.includes('--detail');
const BACKUPS = 'backups';

interface Gate {
  name: string;
  run: (row: Record<string, unknown>) => string[];
  blocking: (issue: string) => boolean;
}

const GATES: Gate[] = [
  { name: 'coherence', run: coherenceIssues, blocking: isBlocking },
  { name: 'consistency', run: consistencyIssues, blocking: isBlockingConsistency },
];

/** Question ids a tester reported in round 3, read from the repair script itself. */
function knownRound3(): Set<string> {
  const src = readFileSync('src/scripts/repairQaRound3.ts', 'utf8');
  return new Set([...src.matchAll(/id: '([0-9a-f]{8})'/g)].map((m) => m[1]));
}

function snapshots(): Array<{ label: string; file: string }> {
  return readdirSync(BACKUPS)
    .filter((f) => f.startsWith('qb_questions_pre_') && f.endsWith('.json'))
    .sort()
    .map((f) => ({ label: f.replace('qb_questions_pre_', '').split('_')[0], file: `${BACKUPS}/${f}` }));
}

const known = knownRound3();
let exit = 0;

for (const snap of snapshots()) {
  const rows = JSON.parse(readFileSync(snap.file, 'utf8')) as Array<Record<string, unknown>>;
  const hasKnown = rows.some((r) => known.has(String(r.id).slice(0, 8)));

  console.log(`\n${'='.repeat(92)}`);
  console.log(`${snap.label}  —  ${rows.length} rows${hasKnown ? `  (${known.size} tester-reported defects present)` : ''}`);

  for (const gate of GATES) {
    const flagged: Array<{ id: string; issues: string[]; blocking: string[] }> = [];
    for (const row of rows) {
      let issues: string[] = [];
      try {
        issues = gate.run(row);
      } catch (e) {
        console.log(`  [${gate.name}] threw on ${String(row.id).slice(0, 8)}: ${e instanceof Error ? e.message : e}`);
        exit = 1;
        continue;
      }
      if (!issues.length) continue;
      flagged.push({ id: String(row.id).slice(0, 8), issues, blocking: issues.filter(gate.blocking) });
    }

    const blockingRows = flagged.filter((f) => f.blocking.length);
    const rate = ((blockingRows.length / rows.length) * 100).toFixed(2);
    let recall = '';
    if (hasKnown) {
      const caught = [...known].filter((k) => blockingRows.some((f) => f.id === k));
      recall = `   recall ${caught.length}/${known.size} of reported defects`;
    }
    console.log(
      `  ${gate.name.padEnd(12)} blocks ${String(blockingRows.length).padStart(4)} rows (${rate.padStart(5)}%)` +
      `   advisory-only ${flagged.length - blockingRows.length}${recall}`
    );

    if (DETAIL) {
      for (const f of blockingRows) {
        const mark = known.has(f.id) ? ' ◀ reported' : '';
        console.log(`      ${f.id}${mark}`);
        for (const i of f.blocking.slice(0, 2)) console.log(`         ${i.slice(0, 150)}`);
      }
    }
  }
}

console.log(
  '\nA check is safe to make blocking when its flag rate is a fraction of a percent and the rows\n' +
  'it flags read as genuinely wrong. Recall is the payoff; flag rate is the price.\n'
);
process.exit(exit);
