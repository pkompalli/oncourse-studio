/**
 * Server-side pipeline orchestrator.
 *
 * Previously the browser drove the whole pipeline by repeatedly calling
 * POST /jobs/:id/next-batch. If the user's connection dropped, the driver died
 * and the job was stranded (e.g. generation finished but review never started).
 *
 * This module runs the entire lifecycle inside the server process instead:
 *   generation → review → audit
 * so a disconnected client can never strand a job. The client only needs to
 * subscribe for progress display.
 *
 * Resume granularity is PHASE-level: a job that died mid-review re-runs the whole
 * review phase (reviewPipeline wipes + restarts by design — it is not resumable
 * mid-batch). This orchestrator's job is to guarantee the job always moves forward
 * to a terminal state, not to resume inside a phase.
 */
import { supabase } from '../../db/supabase.js';
import { generateBatchForJob } from '../generation/questionGeneration.js';
import { reviewBatchForJob } from '../review/reviewPipeline.js';
import { auditBatchForJob } from '../audit/auditPipeline.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Jobs currently being orchestrated in THIS process — prevents a second driver
// (e.g. a client next-batch call, or a double startup sweep) from racing.
const orchestrating = new Set<string>();

// How long to wait for generation to self-transition to 'reviewing' before
// forcing the transition (covers a job whose in-memory generation task died on a
// server restart but whose questions are already persisted). Generous, because
// generation now also runs the full image pipeline to completion before it flips
// to 'reviewing' — this is only a backstop for a genuinely stuck job.
const GENERATION_TIMEOUT_MS = 45 * 60 * 1000;
// Review/audit of a large job (1000+ questions) can run a long time; give each
// phase a generous ceiling before the orchestrator stops babysitting it.
const PHASE_TIMEOUT_MS = 90 * 60 * 1000;
const POLL_INTERVAL_MS = 5000;

interface JobRow {
  status: string;
  course_id: string;
  progress: Record<string, unknown> | null;
}

async function getJob(jobId: string): Promise<JobRow | null> {
  const { data } = await supabase
    .from('qb_jobs')
    .select('status, course_id, progress')
    .eq('id', jobId)
    .single();
  return (data as JobRow) || null;
}

/**
 * Kick off (or resume) full server-side orchestration for a job. Fire-and-forget:
 * returns immediately; the pipeline runs in the background. Safe to call multiple
 * times — duplicate calls for the same job are ignored while one is in flight.
 */
export function orchestrateJob(jobId: string): void {
  if (orchestrating.has(jobId)) return;
  orchestrating.add(jobId);
  runPipeline(jobId)
    .catch(async (e) => {
      console.error(`[orchestrator] Job ${jobId} failed:`, e);
      await supabase
        .from('qb_jobs')
        .update({
          status: 'failed',
          error: e instanceof Error ? e.message : 'Pipeline failed',
          progress: { step: e instanceof Error ? e.message : 'Pipeline failed', phase: 'error' },
        })
        .eq('id', jobId)
        .then(() => undefined, () => undefined);
    })
    .finally(() => orchestrating.delete(jobId));
}

async function runPipeline(jobId: string): Promise<void> {
  let job = await getJob(jobId);
  if (!job) {
    console.warn(`[orchestrator] Job ${jobId} not found — nothing to orchestrate`);
    return;
  }
  console.log(`[orchestrator] Driving job ${jobId} from status=${job.status}`);

  // ── Phase 1: Generation ──
  if (job.status === 'pending' || job.status === 'generating') {
    if (job.status === 'pending') {
      // Launches the background generation tasks and returns immediately.
      await generateBatchForJob(jobId, job.course_id);
    }
    await waitForGeneration(jobId);
    job = await getJob(jobId);
    if (!job || job.status === 'failed') return;
  }

  // ── Phase 2: Review ──
  // reviewBatchForJob is fire-and-forget: it kicks the pipeline and returns
  // immediately. The background run sets DB status 'auditing' on success or
  // 'failed' on error, so we poll until the job leaves 'reviewing'.
  if (job.status === 'reviewing') {
    console.log(`[orchestrator] Job ${jobId} → running review`);
    await reviewBatchForJob(jobId);
    await waitWhileStatus(jobId, 'reviewing', PHASE_TIMEOUT_MS);
    job = await getJob(jobId);
    if (!job || job.status === 'failed') return;
  }

  // ── Phase 3: Audit ──
  // Also fire-and-forget: background run sets DB status 'complete' or 'failed'.
  if (job.status === 'auditing') {
    console.log(`[orchestrator] Job ${jobId} → running audit`);
    await auditBatchForJob(jobId);
    await waitWhileStatus(jobId, 'auditing', PHASE_TIMEOUT_MS);
    job = await getJob(jobId);
  }

  console.log(`[orchestrator] Job ${jobId} finished orchestration at status=${job?.status}`);
}

// Generation runs as fire-and-forget background tasks that self-transition the job
// to 'reviewing' when all subjects finish. Poll until that happens (or the job
// fails / generation stalls).
async function waitForGeneration(jobId: string): Promise<void> {
  const deadline = Date.now() + GENERATION_TIMEOUT_MS;
  while (true) {
    await sleep(POLL_INTERVAL_MS);
    const job = await getJob(jobId);
    if (!job) return;
    if (job.status === 'failed') return;
    // Generation self-transitioned (reviewing/auditing/complete) — done waiting.
    if (job.status !== 'generating' && job.status !== 'pending') return;

    // Fast path: all subjects reported done but status never flipped (e.g. the
    // in-memory generation task died on a restart) — flip it ourselves.
    const p = job.progress || {};
    const completed = (p.completed as number) ?? 0;
    const total = (p.total as number) ?? 0;
    if (total > 0 && completed >= total) {
      console.warn(`[orchestrator] Job ${jobId} generation complete (${completed}/${total}) but not transitioned — forcing 'reviewing'`);
      await supabase.from('qb_jobs').update({ status: 'reviewing' }).eq('id', jobId);
      return;
    }

    if (Date.now() > deadline) {
      console.warn(`[orchestrator] Job ${jobId} generation stalled past timeout — forcing 'reviewing' with whatever was generated`);
      await supabase.from('qb_jobs').update({ status: 'reviewing' }).eq('id', jobId);
      return;
    }
  }
}

// Poll until the job's status is no longer `phase` (it moved on, failed, or
// disappeared) or the timeout elapses. Used to await fire-and-forget phases whose
// completion is signalled only via the DB job status.
async function waitWhileStatus(jobId: string, phase: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    await sleep(POLL_INTERVAL_MS);
    const job = await getJob(jobId);
    if (!job) return;
    if (job.status !== phase) return;
    if (Date.now() > deadline) {
      console.warn(`[orchestrator] Job ${jobId} stuck in '${phase}' past timeout — stopping driver`);
      return;
    }
  }
}

/**
 * On server startup, find any job left in a non-terminal state (a disconnect or a
 * previous server crash stranded it) and resume orchestration so it runs to
 * completion instead of sitting forever.
 */
export async function resumeStrandedJobs(): Promise<void> {
  try {
    const { data: jobs, error } = await supabase
      .from('qb_jobs')
      .select('id, status')
      .in('status', ['pending', 'generating', 'reviewing', 'auditing']);
    if (error) {
      console.error('[orchestrator] Failed to query stranded jobs:', error.message);
      return;
    }
    if (!jobs || jobs.length === 0) {
      console.log('[orchestrator] No stranded jobs to resume');
      return;
    }
    console.log(`[orchestrator] Resuming ${jobs.length} stranded job(s): ${jobs.map((j) => `${(j.id as string).slice(0, 8)}(${j.status})`).join(', ')}`);
    for (const j of jobs) orchestrateJob(j.id as string);
  } catch (e) {
    console.error('[orchestrator] resumeStrandedJobs error:', e);
  }
}
