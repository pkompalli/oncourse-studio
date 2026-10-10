/**
 * A second round on the questions a full run left flagged (other-exam items excluded: retagging is
 * their outcome). Per job:
 *   1. options stored as a [{ key, text }] list are restored to a letter map (fixer.ts normaliseOptions);
 *   2. items whose final audit failed KEY_CORRECT or ONE_BEST_ANSWER go through answer adjudication;
 *   3. one repair aimed at every check still failing, with a still-inconsistent image removed;
 *   4. a final audit with the same checklist and gates.
 * Ids reworked are written to <out>, for exportSimple / exportReviewed --only.
 *
 *   LLM_ADAPTIVE=1 LLM_STEPS=20,30 npx tsx src/scripts/reworkFlagged.ts --manifest <file> --out <ids.json> [--pool 10]
 */
import 'dotenv/config';
import { readFileSync, writeFileSync } from 'node:fs';
import { supabase } from '../db/supabase.js';
import { auditBatchForJob } from '../services/audit/auditPipeline.js';
import { adjudicateJobKeys, repairAfterAudit } from '../services/review/keyAdjudication.js';
import { normaliseOptions } from '../services/review/fixer.js';

type Row = Record<string, any>;
const arg = (n: string) => { const i = process.argv.indexOf(`--${n}`); return i >= 0 ? process.argv[i + 1] : undefined; };
const jobs: string[] = JSON.parse(readFileSync(arg('manifest')!, 'utf8')).jobs.map((j: Row) => j.job);
const OUT = arg('out')!;
const POOL = Number(arg('pool')) || 10;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const reworked: string[] = [];
const tally = { flagged: 0, options_restored: 0, adjudicated: 0, repaired: 0, approved_after: 0, still_flagged: 0 };

async function rework(job: string) {
  const tag = `[${job.slice(0, 8)}]`;
  // Ids first, then the heavy audit trails five at a time: one query for all of a job's flagged rows
  // timed out with twelve jobs starting at once.
  const { data: idRows, error: idErr } = await supabase.from('qb_questions').select('id, tags').eq('job_id', job).eq('status', 'flagged').is('replaced_by_id', null);
  if (idErr) throw new Error(idErr.message);
  const wanted = (idRows || []).filter((q) => !q.tags?.belongs_to_exam).map((q) => q.id as string);
  const mine: Row[] = [];
  for (let i = 0; i < wanted.length; i += 5) {
    const { data, error } = await supabase.from('qb_questions').select('id, options, tags, audit_trail').in('id', wanted.slice(i, i + 5));
    if (error) throw new Error(error.message);
    mine.push(...(data || []));
  }
  if (!mine.length) return;
  tally.flagged += mine.length;
  const ids = new Set(mine.map((q) => q.id as string));

  for (const q of mine) {
    if (!Array.isArray(q.options)) continue;
    const { error } = await supabase.from('qb_questions').update({ options: normaliseOptions(q.options) }).eq('id', q.id);
    if (!error) tally.options_restored++;
  }

  const { data: j } = await supabase.from('qb_jobs').select('course_id').eq('id', job).single();
  const { data: c } = await supabase.from('qb_courses').select('name').eq('id', j?.course_id).single();
  const course = String(c?.name ?? 'USMLE');
  const log = (s: string) => console.log(`${tag}${s}`);

  const keyDoubt = new Set(mine.filter((q) => {
    const audit = [...(q.audit_trail || [])].reverse().find((e: Row) => e.phase === 'audit');
    return (audit?.checks || []).some((x: Row) => x.result === 'fail' && (x.id === 'KEY_CORRECT' || x.id === 'ONE_BEST_ANSWER'));
  }).map((q) => q.id as string));
  if (keyDoubt.size) {
    const a = await adjudicateJobKeys(job, course, log, keyDoubt);
    tally.adjudicated += a.adjudicated;
  }

  const r = await repairAfterAudit(job, course, log, ids);
  tally.repaired += r.repaired;
  log(` repair: ${JSON.stringify(r)}`);

  const { count } = await supabase.from('qb_questions').select('*', { count: 'exact', head: true }).eq('job_id', job).eq('status', 'reviewed').is('replaced_by_id', null);
  if (count) {
    await supabase.from('qb_jobs').update({ status: 'auditing' }).eq('id', job);
    await auditBatchForJob(job);
    for (;;) {
      const { data: s } = await supabase.from('qb_jobs').select('status').eq('id', job).single();
      if (s?.status !== 'auditing') break;
      await sleep(15000);
    }
  }
  const { data: after } = await supabase.from('qb_questions').select('id, status').in('id', [...ids]);
  for (const q of after || []) { if (q.status === 'approved') tally.approved_after++; else tally.still_flagged++; }
  reworked.push(...ids);
  log(` done: ${(after || []).filter((q) => q.status === 'approved').length}/${ids.size} approved`);
}

const t0 = Date.now();
const queue = [...jobs];
await Promise.all(Array.from({ length: POOL }, async () => {
  for (let job = queue.shift(); job; job = queue.shift()) {
    for (let attempt = 1; attempt <= 3; attempt++) {
      try { await rework(job); break; }
      catch (e) { console.error(`[${job.slice(0, 8)}] FAILED (attempt ${attempt}): ${e instanceof Error ? e.message : e}`); await sleep(attempt * 60000); }
    }
  }
}));
writeFileSync(OUT, JSON.stringify(reworked));
console.log(`rework done in ${((Date.now() - t0) / 60000).toFixed(1)} min: ${JSON.stringify(tally)}`);
process.exit(0);
