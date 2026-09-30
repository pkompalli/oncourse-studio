/**
 * Report how far each bank has drifted from the blueprint it was generated from.
 *
 * Runs distributionForJob over the latest job of every course and prints what it finds, grouped
 * by exam. Read-only.
 *
 * Use it two ways: to calibrate the tolerances in distribution.ts against real banks before
 * trusting them, and afterwards to see what a finished job actually owes its blueprint.
 *
 *   npx tsx src/scripts/reportDistribution.ts             # latest job per course
 *   npx tsx src/scripts/reportDistribution.ts --job b777cd54
 */
import 'dotenv/config';
import { supabase } from '../db/supabase.js';
import { distributionForJob, type DistributionFinding } from '../services/generation/distribution.js';

const jobArg = (() => {
  const i = process.argv.indexOf('--job');
  return i >= 0 ? process.argv[i + 1] : null;
})();

const { data: jobs } = await supabase.from('qb_jobs')
  .select('id,course_id,created_at').order('created_at', { ascending: false }).limit(40);
const { data: courses } = await supabase.from('qb_courses').select('id,name');
const nameOf = new Map((courses || []).map((c: { id: string; name: string }) => [c.id, c.name]));

// Latest job per course, unless one was named.
const targets: Array<{ id: string; course: string }> = [];
const seen = new Set<string>();
for (const j of (jobs || []) as Array<{ id: string; course_id: string }>) {
  const course = nameOf.get(j.course_id) || 'unknown';
  if (jobArg) {
    if (j.id.startsWith(jobArg)) targets.push({ id: j.id, course });
    continue;
  }
  if (seen.has(course)) continue;
  seen.add(course);
  targets.push({ id: j.id, course });
}

const ORDER: Array<DistributionFinding['dimension']> = ['format', 'subject', 'bloom', 'difficulty', 'answer_key'];

for (const t of targets) {
  const findings = await distributionForJob(t.id);
  console.log(`\n${'='.repeat(94)}`);
  console.log(`${t.course}  —  job ${t.id.slice(0, 8)}  —  ${findings.length} finding(s)`);
  if (!findings.length) { console.log('  matches its blueprint within tolerance on every dimension'); continue; }

  const byExam = new Map<string, DistributionFinding[]>();
  for (const f of findings) {
    if (!byExam.has(f.exam)) byExam.set(f.exam, []);
    byExam.get(f.exam)!.push(f);
  }
  for (const [exam, group] of [...byExam].sort()) {
    console.log(`\n  ${exam || '(unassigned)'}`);
    for (const dim of ORDER) {
      const rows = group.filter((f) => f.dimension === dim);
      if (!rows.length) continue;
      console.log(`    ${dim}`);
      for (const f of rows) console.log(`      ${f.detail}`);
    }
  }
}
console.log();
