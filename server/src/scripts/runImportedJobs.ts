/**
 * Drive imported jobs through the app's own review and audit, the way the orchestrator does —
 * start the stage, then poll qb_jobs.status until it moves on — without the orchestrator's
 * 90-minute phase timeout, which a 2,000-question Step job outlives.
 *
 * The stages keep their progress in this process's memory, so the process must stay up until
 * every job reaches 'complete' or 'failed'. Re-running it on a job resumes from the job's status:
 * review picks up only questions still at 'generated', audit only those at 'reviewed'.
 *
 *   npx tsx src/scripts/runImportedJobs.ts <jobId> [<jobId> …]
 */
import 'dotenv/config';
import { supabase } from '../db/supabase.js';
import { reviewBatchForJob } from '../services/review/reviewPipeline.js';
import { auditBatchForJob } from '../services/audit/auditPipeline.js';
import { reviewModeOf } from '../services/review/reviewMode.js';
import { balanceJobKeys } from '../services/review/keyBalance.js';
import { adjudicateJobKeys, sweepLengthCues, repairAfterAudit, revertRegressions } from '../services/review/keyAdjudication.js';

const jobIds = process.argv.slice(2).filter((a) => /^[0-9a-f-]{36}$/.test(a));
if (!jobIds.length) { console.log('usage: runImportedJobs.ts <jobId> [<jobId> …]'); process.exit(1); }

const POLL_MS = 15_000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function jobOf(id: string) {
  const { data, error } = await supabase.from('qb_jobs').select('status, progress, config').eq('id', id).single();
  if (error) throw new Error(error.message);
  return data as { status: string; progress: Record<string, unknown> | null; config: Record<string, unknown> | null };
}

async function waitWhile(id: string, status: string, tag: string) {
  let last = '';
  for (;;) {
    const job = await jobOf(id);
    if (job.status !== status) return job.status;
    const p = job.progress || {};
    const line = `${tag} ${status}: ${p.reviewed ?? p.audited ?? '?'}/${p.total ?? '?'} — ${String(p.step ?? '').slice(0, 110)}`;
    if (line !== last) { console.log(line); last = line; }
    await sleep(POLL_MS);
  }
}

/** Whether the job's answer positions have been balanced: its last post-audit step. */
async function balanced(id: string): Promise<boolean> {
  const { data } = await supabase.from('qb_questions').select('audit_trail').eq('job_id', id).is('replaced_by_id', null);
  return (data || []).some((q) => ((q.audit_trail || []) as Array<{ phase?: string }>).some((e) => e?.phase === 'key_balance'));
}

async function drive(id: string) {
  const tag = `[${id.slice(0, 8)}]`;
  let job = await jobOf(id);
  if (job.config?.source !== 'import') throw new Error(`${tag} is not an imported job — refusing (this driver assumes existing-bank mode)`);
  // Imported jobs wait at 'parked' so a server restart does not start them (importUsmleExport.ts).
  if (job.status === 'parked') {
    const { error } = await supabase.from('qb_jobs').update({ status: 'reviewing' }).eq('id', id);
    if (error) throw new Error(error.message);
    job = { ...job, status: 'reviewing' };
  }
  if (job.status === 'reviewing') {
    await reviewBatchForJob(id, 'pending');
    job = { ...job, status: await waitWhile(id, 'reviewing', tag) };
  }
  if (job.status === 'auditing') {
    // Restructure jobs settle every real change of the keyed answer before audit scores it
    // (keyAdjudication.ts), rather than leaving it for a clinician.
    if (reviewModeOf(job.config).restructure) {
      const { data: j } = await supabase.from('qb_jobs').select('course_id').eq('id', id).single();
      const { data: c } = await supabase.from('qb_courses').select('name').eq('id', j?.course_id).single();
      const r = await adjudicateJobKeys(id, String(c?.name ?? 'USMLE'), (s) => console.log(`${tag}${s}`));
      console.log(`${tag} adjudication: ${JSON.stringify(r)}`);
      const sw = await sweepLengthCues(id, String(c?.name ?? 'USMLE'), (s) => console.log(`${tag}${s}`));
      console.log(`${tag} length sweep: ${JSON.stringify(sw)}`);
    }
    await auditBatchForJob(id);
    job = { ...job, status: await waitWhile(id, 'auditing', tag) };
  }
  // Restructure jobs, once audited: one fix pass on what audit found, a final audit of the repaired
  // items, then answer positions balanced across the job. Keyed on whether the job has been balanced,
  // so a run stopped part-way through the fix pass resumes it: the items already repaired sit at
  // 'reviewed' and go straight to the final audit, and the fix pass picks up the rest.
  if (job.status === 'complete' && reviewModeOf(job.config).restructure && !(await balanced(id))) {
    const { data: j } = await supabase.from('qb_jobs').select('course_id').eq('id', id).single();
    const { data: c } = await supabase.from('qb_courses').select('name').eq('id', j?.course_id).single();
    const r = await repairAfterAudit(id, String(c?.name ?? 'USMLE'), (s) => console.log(`${tag}${s}`));
    console.log(`${tag} post-audit repair: ${JSON.stringify(r)}`);
    const { count } = await supabase.from('qb_questions').select('*', { count: 'exact', head: true }).eq('job_id', id).eq('status', 'reviewed').is('replaced_by_id', null);
    if (count) {
      const { error } = await supabase.from('qb_jobs').update({ status: 'auditing' }).eq('id', id);
      if (error) throw new Error(error.message);
      await auditBatchForJob(id);
      job = { ...job, status: await waitWhile(id, 'auditing', tag) };
      const reverted = await revertRegressions(id, (s) => console.log(`${tag}${s}`));
      console.log(`${tag} style repairs reverted: ${reverted}`);
    }
    const b = await balanceJobKeys(id, true);
    console.log(`${tag} key balance: moved ${b.moved}/${b.items} | before ${JSON.stringify(b.before)} → after ${JSON.stringify(b.after)} | longest run ${b.maxRunAfter} | numeric kept ${b.numericKept}, not five ${b.skippedNotFive}, letter refs in explanation ${b.letterRefs.length}`);
  }
  const { data: qs } = await supabase.from('qb_questions').select('status').eq('job_id', id).is('replaced_by_id', null);
  const tally = (qs || []).reduce<Record<string, number>>((m, q) => { m[q.status] = (m[q.status] || 0) + 1; return m; }, {});
  console.log(`${tag} finished at status=${job.status} | questions: ${JSON.stringify(tally)}`);
}

const t0 = Date.now();
// --sequential drives one job at a time: three in parallel overran Sol's per-minute output quota.
const fail = (id: string) => (e: unknown) => console.error(`[${id.slice(0, 8)}] FAILED: ${e instanceof Error ? e.message : e}`);
if (process.argv.includes('--sequential')) { for (const id of jobIds) await drive(id).catch(fail(id)); }
else await Promise.all(jobIds.map((id) => drive(id).catch(fail(id))));
console.log(`all done in ${((Date.now() - t0) / 60000).toFixed(1)} min`);
process.exit(0);
