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

async function drive(id: string) {
  const tag = `[${id.slice(0, 8)}]`;
  let job = await jobOf(id);
  if (job.config?.source !== 'import') throw new Error(`${tag} is not an imported job — refusing (this driver assumes existing-bank mode)`);
  if (job.status === 'reviewing') {
    await reviewBatchForJob(id, 'pending');
    job = { ...job, status: await waitWhile(id, 'reviewing', tag) };
  }
  if (job.status === 'auditing') {
    await auditBatchForJob(id);
    job = { ...job, status: await waitWhile(id, 'auditing', tag) };
  }
  const { data: qs } = await supabase.from('qb_questions').select('status').eq('job_id', id).is('replaced_by_id', null);
  const tally = (qs || []).reduce<Record<string, number>>((m, q) => { m[q.status] = (m[q.status] || 0) + 1; return m; }, {});
  console.log(`${tag} finished at status=${job.status} | questions: ${JSON.stringify(tally)}`);
}

const t0 = Date.now();
await Promise.all(jobIds.map((id) => drive(id).catch((e) => console.error(`[${id.slice(0, 8)}] FAILED: ${e instanceof Error ? e.message : e}`))));
console.log(`all done in ${((Date.now() - t0) / 60000).toFixed(1)} min`);
process.exit(0);
