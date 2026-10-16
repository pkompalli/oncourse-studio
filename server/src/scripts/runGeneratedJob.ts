/**
 * Create a generation job and drive it through the app's own stages — generate, review, audit —
 * without the orchestrator, polling qb_jobs.status between stages. For a targeted set such as the
 * NCLEX bow-tie items:
 *
 *   npx tsx src/scripts/runGeneratedJob.ts --course <id> --format bow_tie \
 *     --counts '{"Medical-Surgical Nursing":15,"Pediatric Nursing":9}' [--job <existing id>]
 *
 * --counts sets each subject's size (job config subject_question_counts) and scopes the job to those
 * subjects; --format generates that format only (config.format_only). --job resumes an existing job.
 */
import 'dotenv/config';
import { supabase } from '../db/supabase.js';
import { generateBatchForJob } from '../services/generation/questionGeneration.js';
import { reviewBatchForJob } from '../services/review/reviewPipeline.js';
import { auditBatchForJob } from '../services/audit/auditPipeline.js';
import { postAuditPasses } from '../services/review/keyAdjudication.js';

const arg = (n: string) => { const i = process.argv.indexOf(`--${n}`); return i >= 0 ? process.argv[i + 1] : undefined; };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function statusOf(id: string): Promise<string> {
  const { data, error } = await supabase.from('qb_jobs').select('status, progress').eq('id', id).single();
  if (error) throw new Error(error.message);
  return data.status as string;
}
async function waitWhile(id: string, status: string) {
  let last = '';
  for (;;) {
    const { data } = await supabase.from('qb_jobs').select('status, progress').eq('id', id).single();
    if (data?.status !== status) return data?.status as string;
    const p = (data?.progress || {}) as Record<string, unknown>;
    const line = `  ${status}: ${String(p.step ?? p.message ?? '').slice(0, 120)}`;
    if (line !== last) { console.log(line); last = line; }
    await sleep(15000);
  }
}

let jobId = arg('job');
if (!jobId) {
  const course = arg('course')!;
  const counts = JSON.parse(arg('counts') || '{}') as Record<string, number>;
  const { data: c } = await supabase.from('qb_courses').select('structure').eq('id', course).single();
  const subjects = ((c?.structure as Record<string, any>)?.subjects || []) as Array<Record<string, any>>;
  const topicSelection = Object.fromEntries(subjects.filter((s) => counts[s.name]).map((s) => [s.name, (s.topics || []).map((t: Record<string, any>) => t.name)]));
  const missing = Object.keys(counts).filter((n) => !topicSelection[n]);
  if (missing.length) throw new Error(`not in the course structure: ${missing.join(', ')}`);
  const { data: job, error } = await supabase.from('qb_jobs').insert({
    course_id: course, type: 'topic_wise', status: 'pending', progress: {},
    config: { topic_selection: topicSelection, subject_question_counts: counts, ...(arg('format') ? { format_only: arg('format') } : {}), questions_per_topic: 1 },
  }).select('id').single();
  if (error) throw new Error(error.message);
  jobId = job.id as string;
  console.log(`created job ${jobId}`);
}

const { data: j } = await supabase.from('qb_jobs').select('course_id').eq('id', jobId).single();
let status = await statusOf(jobId!);
if (!['reviewing', 'auditing', 'complete'].includes(status)) {
  await generateBatchForJob(jobId!, j!.course_id as string);
  status = await waitWhile(jobId!, 'generating');
  for (let i = 0; i < 40 && !['reviewing', 'auditing', 'complete', 'failed'].includes(status); i++) { await sleep(15000); status = await statusOf(jobId!); }
}
if (status === 'reviewing') { await reviewBatchForJob(jobId!, 'pending'); status = await waitWhile(jobId!, 'reviewing'); }
if (status === 'auditing') { await auditBatchForJob(jobId!); status = await waitWhile(jobId!, 'auditing'); }
if (status === 'complete') { await postAuditPasses(jobId!); status = await statusOf(jobId!); }
const { data: qs } = await supabase.from('qb_questions').select('status').eq('job_id', jobId).is('replaced_by_id', null);
const tally = (qs || []).reduce<Record<string, number>>((m, q) => { m[q.status] = (m[q.status] || 0) + 1; return m; }, {});
console.log(`job ${jobId} finished at ${status} | ${JSON.stringify(tally)}`);
process.exit(0);
