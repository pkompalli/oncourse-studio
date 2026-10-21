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
 *
 * A planned set with fixed counts per topic (within a subject the generator lets the model pick each
 * question's topic, so a subject-sized job can pile onto a few topics):
 *
 *   LLM_ADAPTIVE=1 LLM_STEPS=20,30 npx tsx src/scripts/runGeneratedJob.ts --course <id> \
 *     --plan <plan.json> --manifest <manifest.json> [--pool 4]
 *
 * plan.json is [{ "subject": …, "topic": …, "count": N }]; each entry becomes one job scoped to that
 * topic. The jobs created are written to --manifest, and a rerun with the same manifest resumes them
 * instead of creating new ones. --pool N drives N jobs at once in this process, so one limiter
 * (llm/limiter.ts) caps the calls in flight across all of them. Each finished job's answer letters
 * are balanced (keyBalance.ts).
 *
 * Cleanup of a finished plan — re-audit what the audit never scored, replace what is still flagged
 * (duplicate concepts, mostly), review and audit the replacements, rebalance answer letters:
 *
 *   LLM_ADAPTIVE=1 LLM_STEPS=20,30 npx tsx src/scripts/runGeneratedJob.ts --cleanup --manifest <manifest.json> \
 *     [--focus <focus.json>] [--rounds 3] [--pool 6]
 *
 * focus.json is { "<topic>": ["area", …] }, stored on each job as config.replace_focus so a broad topic's
 * replacements are spread over those areas (replaceBatchForJob). A replacement that is itself a
 * duplicate is flagged by the set check and replaced in the next round.
 */
import 'dotenv/config';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { supabase } from '../db/supabase.js';
import { generateBatchForJob, replaceBatchForJob } from '../services/generation/questionGeneration.js';
import { reviewBatchForJob } from '../services/review/reviewPipeline.js';
import { auditBatchForJob } from '../services/audit/auditPipeline.js';
import { postAuditPasses } from '../services/review/keyAdjudication.js';
import { balanceJobKeys } from '../services/review/keyBalance.js';

const arg = (n: string) => { const i = process.argv.indexOf(`--${n}`); return i >= 0 ? process.argv[i + 1] : undefined; };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function statusOf(id: string): Promise<string> {
  const { data, error } = await supabase.from('qb_jobs').select('status').eq('id', id).single();
  if (error) throw new Error(error.message);
  return data.status as string;
}
// Polls only status and progress: a full-row poll every 15 s per job adds up to real egress.
async function waitWhile(id: string, status: string, tag: string) {
  let last = '';
  for (;;) {
    const { data } = await supabase.from('qb_jobs').select('status, progress').eq('id', id).single();
    if (data?.status !== status) return data?.status as string;
    const p = (data?.progress || {}) as Record<string, unknown>;
    const line = `${tag} ${status}: ${String(p.step ?? p.message ?? '').slice(0, 120)}`;
    if (line !== last) { console.log(line); last = line; }
    await sleep(30000);
  }
}

async function createJob(course: string, topicSelection: Record<string, string[]>, counts: Record<string, number>, extra: Record<string, unknown> = {}) {
  const { data: job, error } = await supabase.from('qb_jobs').insert({
    course_id: course, type: 'topic_wise', status: 'pending', progress: {},
    config: { topic_selection: topicSelection, subject_question_counts: counts, ...(arg('format') ? { format_only: arg('format') } : {}), questions_per_topic: 1, ...extra },
  }).select('id').single();
  if (error) throw new Error(error.message);
  return job.id as string;
}

async function drive(jobId: string, tag = `[${jobId.slice(0, 8)}]`) {
  const { data: j } = await supabase.from('qb_jobs').select('course_id, config').eq('id', jobId).single();
  let status = await statusOf(jobId);
  if (!['reviewing', 'auditing', 'complete'].includes(status)) {
    await generateBatchForJob(jobId, j!.course_id as string);
    // No time cap: a large topic generates its batches one after another (30 for 180 questions), and
    // the questions are saved only when the subject finishes. A 10-minute cap abandoned such jobs.
    while (['pending', 'generating'].includes(status)) {
      status = await waitWhile(jobId, 'generating', tag);
      if (status === 'pending') { await sleep(30000); status = await statusOf(jobId); }
    }
  }
  if (status === 'reviewing') { await reviewBatchForJob(jobId, 'pending'); status = await waitWhile(jobId, 'reviewing', tag); }
  if (status === 'auditing') { await auditBatchForJob(jobId); status = await waitWhile(jobId, 'auditing', tag); }
  if (status === 'complete') { await postAuditPasses(jobId, (s) => console.log(`${tag} ${s}`)); status = await statusOf(jobId); }
  if (status === 'complete' && arg('plan') && !j?.config?.key_balanced_at) {
    const b = await balanceJobKeys(jobId, true);
    await supabase.from('qb_jobs').update({ config: { ...(j?.config || {}), key_balanced_at: new Date().toISOString() } }).eq('id', jobId);
    console.log(`${tag} key balance: moved ${b.moved}/${b.items} | after ${JSON.stringify(b.after)}`);
  }
  const { data: qs } = await supabase.from('qb_questions').select('status').eq('job_id', jobId).is('replaced_by_id', null);
  const tally = (qs || []).reduce<Record<string, number>>((m, q) => { m[q.status] = (m[q.status] || 0) + 1; return m; }, {});
  console.log(`${tag} job ${jobId} finished at ${status} | ${JSON.stringify(tally)}`);
}

async function tally(jobId: string) {
  const { data: qs } = await supabase.from('qb_questions').select('status').eq('job_id', jobId).is('replaced_by_id', null);
  return (qs || []).reduce<Record<string, number>>((m, q) => { m[q.status] = (m[q.status] || 0) + 1; return m; }, {});
}

async function cleanup(jobId: string, tag: string, focus: Record<string, string[]>, rounds: number) {
  const { data: j } = await supabase.from('qb_jobs').select('status, config').eq('id', jobId).single();
  const topic = Object.values((j?.config?.topic_selection || {}) as Record<string, string[]>).flat()[0];
  if (topic && focus[topic]) {
    await supabase.from('qb_jobs').update({ config: { ...(j?.config || {}), replace_focus: { [topic]: focus[topic] } } }).eq('id', jobId);
  }
  // A job a stopped cleanup left mid-review or mid-audit finishes those stages first.
  if (j?.status !== 'complete') await drive(jobId, tag);
  // A question the audit returned no score for (a dropped call) waits at 'needs_review'; back to
  // 'reviewed' it is audited again.
  const { data: nr } = await supabase.from('qb_questions').update({ status: 'reviewed' })
    .eq('job_id', jobId).eq('status', 'needs_review').is('replaced_by_id', null).select('id');
  if (nr?.length) {
    await supabase.from('qb_jobs').update({ status: 'auditing' }).eq('id', jobId);
    console.log(`${tag} re-auditing ${nr.length} unscored question(s)`);
    await drive(jobId, tag);
  }
  for (let round = 1; round <= rounds; round++) {
    let replaced = 0;
    for (;;) {
      const r = await replaceBatchForJob(jobId);
      replaced += r.replaced;
      if (r.status !== 'replacing' || (!r.replaced && !r.failed)) break;
    }
    if (!replaced) break;
    console.log(`${tag} round ${round}: replaced ${replaced} — reviewing and auditing the replacements`);
    await drive(jobId, tag);
  }
  const b = await balanceJobKeys(jobId, true);
  console.log(`${tag} key balance: moved ${b.moved}/${b.items} | after ${JSON.stringify(b.after)}`);
  console.log(`${tag} cleanup done | ${JSON.stringify(await tally(jobId))}`);
}

if (process.argv.includes('--cleanup')) {
  const MANIFEST = arg('manifest');
  if (!MANIFEST) throw new Error('--cleanup needs --manifest');
  const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8')) as { jobs: Array<{ job: string; topic: string }> };
  const focus = arg('focus') ? JSON.parse(readFileSync(arg('focus')!, 'utf8')) as Record<string, string[]> : {};
  const rounds = Number(arg('rounds')) || 3;
  const queue = manifest.jobs.map((m) => m);
  await Promise.all(Array.from({ length: Math.min(Number(arg('pool')) || 6, queue.length) }, async () => {
    for (let m = queue.shift(); m; m = queue.shift()) {
      const tag = `[${m.job.slice(0, 8)} ${m.topic.slice(0, 24)}]`;
      try { await cleanup(m.job, tag, focus, rounds); } catch (e) { console.log(`${tag} FAILED: ${(e as Error).message}`); }
    }
  }));
  console.log('cleanup done');
  process.exit(0);
}

const PLAN = arg('plan');
if (PLAN) {
  const course = arg('course')!;
  const MANIFEST = arg('manifest');
  if (!course || !MANIFEST) throw new Error('--plan needs --course and --manifest');
  const plan = JSON.parse(readFileSync(PLAN, 'utf8')) as Array<{ subject: string; topic: string; count: number }>;
  const { data: c } = await supabase.from('qb_courses').select('structure').eq('id', course).single();
  const subjects = ((c?.structure as Record<string, any>)?.subjects || []) as Array<Record<string, any>>;
  const bad = plan.filter((p) => !subjects.find((s) => s.name === p.subject)?.topics?.some((t: Record<string, any>) => t.name === p.topic));
  if (bad.length) throw new Error(`not in the course structure: ${bad.map((p) => `${p.subject} → ${p.topic}`).join(', ')}`);
  const manifest: { jobs: Array<{ job: string; subject: string; topic: string; count: number }> } = existsSync(MANIFEST) ? JSON.parse(readFileSync(MANIFEST, 'utf8')) : { jobs: [] };
  for (const p of plan) {
    if (manifest.jobs.some((m) => m.subject === p.subject && m.topic === p.topic)) continue;
    const job = await createJob(course, { [p.subject]: [p.topic] }, { [p.subject]: p.count }, { plan_topic: `${p.subject} → ${p.topic}` });
    manifest.jobs.push({ job, ...p });
    writeFileSync(MANIFEST, JSON.stringify(manifest, null, 2));
    console.log(`created job ${job} — ${p.subject} → ${p.topic} (${p.count})`);
  }
  const queue = manifest.jobs.map((m) => m);
  const POOL = Number(arg('pool')) || 4;
  await Promise.all(Array.from({ length: Math.min(POOL, queue.length) }, async () => {
    for (let m = queue.shift(); m; m = queue.shift()) {
      const tag = `[${m.job.slice(0, 8)} ${m.topic.slice(0, 24)}]`;
      try { await drive(m.job, tag); } catch (e) { console.log(`${tag} FAILED: ${(e as Error).message}`); }
    }
  }));
  console.log('all planned jobs done');
  process.exit(0);
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
  jobId = await createJob(course, topicSelection, counts);
  console.log(`created job ${jobId}`);
}
await drive(jobId);
process.exit(0);
