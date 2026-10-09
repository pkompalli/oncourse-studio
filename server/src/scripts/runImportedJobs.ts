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
 *
 * A full run: --manifest <file> (from importUsmleExport --manifest) supplies the jobs, --pool N runs N
 * of them at once (a new one starting as each finishes), and --parts <dir> writes each block of about
 * 1,000 questions to <dir>/part_NN.json (approved, simple format) and part_NN_detail.json (every
 * question, with outcome and checks) as soon as all of its jobs are done. With LLM_ADAPTIVE=1 one
 * process-wide limiter (llm/limiter.ts) caps the calls in flight. --quiet drops the per-job progress lines.
 */
import 'dotenv/config';
import { readFileSync, existsSync, mkdirSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { supabase } from '../db/supabase.js';
import { reviewBatchForJob } from '../services/review/reviewPipeline.js';
import { auditBatchForJob } from '../services/audit/auditPipeline.js';
import { reviewModeOf } from '../services/review/reviewMode.js';
import { balanceJobKeys } from '../services/review/keyBalance.js';
import { adjudicateJobKeys, sweepLengthCues, repairAfterAudit, revertRegressions } from '../services/review/keyAdjudication.js';

const arg = (name: string) => { const i = process.argv.indexOf(`--${name}`); return i >= 0 ? process.argv[i + 1] : undefined; };
const MANIFEST = arg('manifest');
const manifestJobs: Array<{ job: string; step: string; count: number }> = MANIFEST ? JSON.parse(readFileSync(MANIFEST, 'utf8')).jobs : [];
const jobIds = MANIFEST ? manifestJobs.map((j) => j.job) : process.argv.slice(2).filter((a) => /^[0-9a-f-]{36}$/.test(a));
if (!jobIds.length) { console.log('usage: runImportedJobs.ts <jobId> [<jobId> …] | --manifest <file> [--pool N] [--parts <dir>]'); process.exit(1); }
const POOL = Number(arg('pool')) || 0;
const PARTS = arg('parts');
const QUIET = process.argv.includes('--quiet');

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
    if (line !== last && !QUIET) { console.log(line); last = line; }
    await sleep(POLL_MS);
  }
}

/** Whether the job's answer positions have been balanced: its last post-audit step. */
async function balanced(id: string): Promise<boolean> {
  // Recorded on the job when balancing finishes. Jobs balanced before that marker existed are found
  // from their audit trails, read 20 rows at a time: reading all of a job's trails at once timed out
  // under load, and audit_trail is json, so a containment filter is not available.
  const { data: job, error } = await supabase.from('qb_jobs').select('config').eq('id', id).single();
  if (error) throw new Error(error.message);
  if ((job?.config as Record<string, unknown> | null)?.key_balanced_at) return true;
  for (let from = 0; ; from += 20) {
    const { data, error: e } = await supabase.from('qb_questions').select('audit_trail').eq('job_id', id).is('replaced_by_id', null).order('id').range(from, from + 19);
    if (e) throw new Error(e.message || `audit trail read failed (${from})`);
    if ((data || []).some((q) => ((q.audit_trail || []) as Array<{ phase?: string }>).some((x) => x?.phase === 'key_balance'))) return true;
    if (!data || data.length < 20) return false;
  }
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
  // A review batch whose model call failed leaves its questions at 'generated' (reviewPipeline.ts).
  // Two more passes before audit; anything still unreviewed after that is reported, not audited.
  for (let pass = 1; pass <= 2 && job.status === 'auditing'; pass++) {
    const { count } = await supabase.from('qb_questions').select('*', { count: 'exact', head: true }).eq('job_id', id).eq('status', 'generated').is('replaced_by_id', null);
    if (!count) break;
    console.log(`${tag} ${count} question(s) without a review result — review pass ${pass + 1}`);
    const { error } = await supabase.from('qb_jobs').update({ status: 'reviewing' }).eq('id', id);
    if (error) throw new Error(error.message);
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
    await supabase.from('qb_jobs').update({ config: { ...(job.config || {}), key_balanced_at: new Date().toISOString() } }).eq('id', id);
    console.log(`${tag} key balance: moved ${b.moved}/${b.items} | before ${JSON.stringify(b.before)} → after ${JSON.stringify(b.after)} | longest run ${b.maxRunAfter} | numeric kept ${b.numericKept}, not five ${b.skippedNotFive}, letter refs in explanation ${b.letterRefs.length}`);
  }
  const { data: qs } = await supabase.from('qb_questions').select('status').eq('job_id', id).is('replaced_by_id', null);
  const tally = (qs || []).reduce<Record<string, number>>((m, q) => { m[q.status] = (m[q.status] || 0) + 1; return m; }, {});
  console.log(`${tag} finished at status=${job.status} | questions: ${JSON.stringify(tally)}`);
}

// ── Parts: consecutive manifest jobs grouped into blocks of about 1,000 questions ──
const parts: string[][] = [];
{
  let cur: string[] = [], n = 0;
  for (const j of manifestJobs) {
    cur.push(j.job); n += j.count;
    if (n >= 1000) { parts.push(cur); cur = []; n = 0; }
  }
  if (cur.length) parts.push(cur);
}
const finished = new Set<string>();
const written = new Set<number>();
const run = promisify(execFile);
async function writeReadyParts() {
  if (!PARTS || !parts.length) return;
  mkdirSync(PARTS, { recursive: true });
  for (const [i, jobs] of parts.entries()) {
    const name = `part_${String(i + 1).padStart(2, '0')}`;
    if (written.has(i) || !jobs.every((j) => finished.has(j)) || existsSync(`${PARTS}/${name}.json`)) continue;
    written.add(i);
    try {
      const tsx = ['tsx'];
      const a = await run('npx', [...tsx, 'src/scripts/exportSimple.ts', ...jobs, '--out', `${PARTS}/${name}.json`], { maxBuffer: 1 << 26 });
      await run('npx', [...tsx, 'src/scripts/exportReviewed.ts', ...jobs, '--out', `${PARTS}/${name}_detail`], { maxBuffer: 1 << 26 });
      console.log(`[parts] ${name} written (${jobs.length} jobs): ${a.stdout.split('\n').find((l) => l.startsWith('{')) ?? ''}`);
    } catch (e) {
      written.delete(i);
      console.error(`[parts] ${name} export FAILED: ${e instanceof Error ? e.message.slice(0, 200) : e}`);
    }
  }
}

const t0 = Date.now();
// --sequential drives one job at a time: three in parallel overran Sol's per-minute output quota.
const fail = (id: string) => (e: unknown) => console.error(`[${id.slice(0, 8)}] FAILED: ${e instanceof Error ? e.message : e}`);
// A job that throws (a database statement timeout when fifteen jobs start at once) is retried after a
// pause; it resumes from its saved status. Only a job that completes counts toward a part file.
const driveOne = async (id: string) => {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try { await drive(id); finished.add(id); break; }
    catch (e) {
      fail(id)(e);
      if (attempt === 3) { console.error(`[${id.slice(0, 8)}] GIVING UP after 3 attempts — rerun the manifest to resume it`); return; }
      console.log(`[${id.slice(0, 8)}] retrying in ${attempt} min (attempt ${attempt + 1}/3)`);
      await sleep(attempt * 60000);
    }
  }
  console.log(`[progress] ${finished.size}/${jobIds.length} jobs done, ${((Date.now() - t0) / 60000).toFixed(1)} min`);
  await writeReadyParts();
};
if (process.argv.includes('--sequential')) { for (const id of jobIds) await driveOne(id); }
else if (POOL > 0) {
  const queue = [...jobIds];
  await Promise.all(Array.from({ length: Math.min(POOL, queue.length) }, async () => { for (let id = queue.shift(); id; id = queue.shift()) await driveOne(id); }));
}
else await Promise.all(jobIds.map((id) => driveOne(id)));
console.log(`all done in ${((Date.now() - t0) / 60000).toFixed(1)} min`);
process.exit(0);
