/**
 * What the repair trail actually contains, and what audit was missing by not reading it.
 *
 * reviewPipeline records every repair: the changes requested, a before/after, and — when the
 * fixer could not do it — a *_fix_failed entry saying so outright. Audit selected that column
 * and never looked at it, scoring each question from scratch instead. A change that was
 * requested and never applied therefore left a question that reads well, scores nine, and still
 * has the defect an earlier stage found.
 *
 * This reports, across the live banks:
 *   • how many questions carry each kind of trail entry
 *   • how many carry a failed repair with nothing since that addressed it — the population the
 *     new deterministic gate in auditPipeline now flags
 *   • how many of those are currently APPROVED, which is the number that matters
 *
 * and renders a few history blocks exactly as the auditor will now see them, so the rendering
 * can be read rather than assumed.
 *
 * Read-only.
 *
 *   npx tsx src/scripts/verifyFixHistory.ts
 *   npx tsx src/scripts/verifyFixHistory.ts --samples 5
 */
import 'dotenv/config';
import { supabase } from '../db/supabase.js';
import { fetchAllRows } from '../db/pagination.js';
import { fixHistoryBlock, unappliedChanges } from '../services/audit/fixHistory.js';

const SAMPLES = (() => {
  const i = process.argv.indexOf('--samples');
  return i >= 0 && process.argv[i + 1] ? Number(process.argv[i + 1]) : 2;
})();

const JOB_PREFIXES = ['b777cd54', '9eafe612', '074ac820', '9c01f36e', '5071eac0', '2317bc4a'];

const { data: jobs } = await supabase.from('qb_jobs').select('id');
const jobIds = (jobs || []).map((j: { id: string }) => j.id)
  .filter((id: string) => JOB_PREFIXES.some((p) => id.startsWith(p)));

let rows: Array<Record<string, any>> = [];
for (const id of jobIds) {
  rows = rows.concat(await fetchAllRows<Record<string, any>>((f, t) =>
    supabase.from('qb_questions').select('id,status,quality_score,audit_trail')
      .eq('job_id', id).is('replaced_by_id', null).range(f, t)));
}

const phases = new Map<string, number>();
let withTrail = 0;
const stranded: Array<Record<string, any>> = [];

for (const r of rows) {
  const trail = Array.isArray(r.audit_trail) ? r.audit_trail : [];
  if (trail.length) withTrail++;
  for (const e of trail) {
    const p = String((e as Record<string, unknown>)?.phase || 'unknown');
    phases.set(p, (phases.get(p) || 0) + 1);
  }
  if (unappliedChanges(r).length) stranded.push(r);
}

console.log(`${rows.length} rows across ${jobIds.length} jobs; ${withTrail} carry a trail\n`);
console.log('trail entries by phase:');
for (const [p, n] of [...phases].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${p.padEnd(26)} ${n}`);
}

console.log(`\nquestions with a repair that failed and was never re-attempted: ${stranded.length}`);
if (stranded.length) {
  const byStatus = new Map<string, number>();
  for (const r of stranded) byStatus.set(String(r.status), (byStatus.get(String(r.status)) || 0) + 1);
  for (const [s, n] of [...byStatus].sort((a, b) => b[1] - a[1])) {
    const flag = s === 'approved' ? '  ← shipped with an unapplied repair' : '';
    console.log(`  ${s.padEnd(14)} ${n}${flag}`);
  }
  const approvedScores = stranded.filter((r) => r.status === 'approved').map((r) => Number(r.quality_score)).filter(Number.isFinite);
  if (approvedScores.length) {
    const avg = approvedScores.reduce((a, b) => a + b, 0) / approvedScores.length;
    console.log(`  their average quality_score: ${avg.toFixed(1)} (max ${Math.max(...approvedScores)})`);
  }
}

// Render what the auditor will now be shown. Sample rows that were actually REPAIRED — every
// row carries a trail of scoring entries, and those render nothing, so sampling on "has a
// trail" shows empty blocks and proves nothing.
const REPAIR_PHASES = ['validator_fix', 'adversarial_fix', 'validator_image_fix', 'adversarial_image_fix',
  'validator_fix_failed', 'adversarial_fix_failed'];
const repaired = rows.filter((r) =>
  Array.isArray(r.audit_trail)
  && r.audit_trail.some((e: Record<string, unknown>) => REPAIR_PHASES.includes(String(e?.phase || ''))));
console.log(`\n${repaired.length} of ${rows.length} questions were repaired at least once — ` +
  `that is the share of each audit batch that will now carry a verification section.`);

const samples = (stranded.length ? stranded : repaired).slice(0, SAMPLES);
for (const r of samples) {
  const block = fixHistoryBlock(r, `Q(${String(r.id).slice(0, 8)})`);
  console.log(`\n${'─'.repeat(92)}\nstatus=${r.status} score=${r.quality_score}`);
  console.log(block ?? '  (no renderable history)');
}
console.log();
