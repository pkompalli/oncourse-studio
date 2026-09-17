import { Router } from 'express';
import { supabase } from '../db/supabase.js';
import { generateBatchForJob } from '../services/generation/questionGeneration.js';
import { reviewBatchForJob } from '../services/review/reviewPipeline.js';
import { auditBatchForJob } from '../services/audit/auditPipeline.js';
import { processAllImageQuestions } from '../services/images/imageGeneration.js';
import { reprocessFlaggedForJob, peekReprocess } from '../services/review/reprocessFlagged.js';
import { orchestrateJob } from '../services/pipeline/orchestrator.js';
import { fetchAllRows } from '../db/pagination.js';
import { classifyQuestionType, needsMarkdownRegeneration } from '../services/questionType.js';
import { revalidateContentForJob, getRevalidateStatus } from '../services/review/contentRevalidate.js';

export const jobsRouter = Router();

// Re-validate the CONTENT of every question in a job (not just flagged) — a
// second-pass audit that fixes content defects the initial review missed on
// already-approved questions. Runs in the background; poll the GET below.
jobsRouter.post('/:id/revalidate-content', async (req, res, next) => {
  try {
    const existing = getRevalidateStatus(req.params.id);
    if (existing?.running) { res.json({ started: false, alreadyRunning: true, status: existing }); return; }
    // fire-and-forget; progress tracked in-memory
    revalidateContentForJob(req.params.id).catch((e) => console.error('[revalidate] failed:', e));
    res.json({ started: true });
  } catch (e) { next(e); }
});

jobsRouter.get('/:id/revalidate-content', (req, res) => {
  res.json({ status: getRevalidateStatus(req.params.id) });
});

// Flag questions whose intended medium is Markdown but that are stored as an
// image (or have no exhibits) — so they can be regenerated with the markdown
// pipeline. Marks tags.needs_regeneration + tags.question_type and returns a
// report. Pass ?job_id= to scope to one job, otherwise scans all jobs.
jobsRouter.post('/flag-markdown-regen', async (req, res, next) => {
  try {
    const jobId = (req.query.job_id as string) || (req.body?.job_id as string) || null;
    const rows = await fetchAllRows<Record<string, any>>((from, to) => {
      let q = supabase.from('qb_questions').select('*').is('replaced_by_id', null).order('id', { ascending: true }).range(from, to);
      if (jobId) q = q.eq('job_id', jobId);
      return q;
    });

    const flagged: Array<{ id: string; job_id: string; question_number: number; format_type: string; image_type: string }> = [];
    for (const q of rows || []) {
      if (!needsMarkdownRegeneration(q)) continue;
      const tags = { ...(q.tags || {}), needs_regeneration: true, question_type: 'markdown' };
      await supabase.from('qb_questions').update({ tags }).eq('id', q.id);
      flagged.push({
        id: q.id,
        job_id: q.job_id,
        question_number: q.question_number,
        format_type: (q.tags?.format_type as string) || q.format_type || 'mcq_single',
        image_type: q.image_type || '',
      });
    }

    // Group the report by job for readability.
    const byJob: Record<string, number[]> = {};
    for (const f of flagged) (byJob[f.job_id] ||= []).push(f.question_number);

    res.json({
      scanned: rows?.length || 0,
      flagged_count: flagged.length,
      by_job: byJob,
      flagged,
    });
  } catch (e) {
    next(e);
  }
});

// A question counts as approved/validated using the same logic as the UI's displayStatus().
function isApproved(q: Record<string, any>): boolean {
  if (q.quality_score != null) return q.quality_score >= 7;
  if (q.validator_score != null && q.adversarial_score != null) return q.validator_score >= 7 && q.adversarial_score >= 7;
  if (q.validator_score != null) return q.validator_score >= 7;
  return false;
}

// Create a new job
jobsRouter.post('/', async (req, res, next) => {
  try {
    const { course_id, type, config } = req.body;
    if (!course_id || !type) {
      res.status(400).json({ error: 'course_id and type are required' });
      return;
    }

    const { data, error } = await supabase
      .from('qb_jobs')
      .insert({
        course_id,
        type,
        config: config || {},
        status: 'pending',
        progress: {},
      })
      .select()
      .single();

    if (error) throw new Error(error.message);

    // Drive the whole pipeline server-side (generation → review → audit) so a
    // disconnected client can never strand the job. Fire-and-forget.
    orchestrateJob(data.id as string);

    res.json({ job: data });
  } catch (e) {
    next(e);
  }
});

// Manually (re)start server-side orchestration for a job — unsticks a job that
// was stranded before this was deployed, or that needs a kick. Optionally pass
// { status } to reset the job to a specific phase first (e.g. 'reviewing' to
// re-run review on a job that previously failed there).
jobsRouter.post('/:id/resume', async (req, res, next) => {
  try {
    const { status } = (req.body || {}) as { status?: string };
    const allowed = ['pending', 'generating', 'reviewing', 'auditing'];
    if (status) {
      if (!allowed.includes(status)) {
        res.status(400).json({ error: `status must be one of ${allowed.join(', ')}` });
        return;
      }
      await supabase.from('qb_jobs').update({ status, error: null }).eq('id', req.params.id);
    }
    orchestrateJob(req.params.id);
    res.json({ ok: true, message: `Orchestration (re)started${status ? ` from status=${status}` : ''}` });
  } catch (e) {
    next(e);
  }
});

// Top up a job's APPROVED question count to match its exam-format subject
// distribution by moving already-approved questions in from another job of the
// same course (avoids regenerating). Dry-run by default; pass { apply: true } to
// perform the move.
jobsRouter.post('/:id/topup-from-job', async (req, res, next) => {
  try {
    const targetJobId = req.params.id;
    const { source_job_id, apply } = (req.body || {}) as { source_job_id?: string; apply?: boolean };
    if (!source_job_id) {
      res.status(400).json({ error: 'source_job_id is required' });
      return;
    }

    // Target job → course → per-subject targets
    const { data: targetJob, error: tjErr } = await supabase
      .from('qb_jobs').select('course_id').eq('id', targetJobId).single();
    if (tjErr || !targetJob) { res.status(404).json({ error: 'target job not found' }); return; }
    const { data: course } = await supabase
      .from('qb_courses').select('exam_format').eq('id', targetJob.course_id).single();
    const sd = ((course?.exam_format as Record<string, any>)?.subject_distribution || {}) as Record<string, any>;
    const targets: Record<string, number> = {};
    for (const [k, v] of Object.entries(sd)) targets[k] = Math.round((typeof v === 'object' ? v.questions : v) || 0);

    // Target's current approved-per-subject + max question_number
    const targetQs = await fetchAllRows<Record<string, any>>((from, to) =>
      supabase.from('qb_questions')
        .select('subject, question_number, quality_score, validator_score, adversarial_score')
        .eq('job_id', targetJobId).is('replaced_by_id', null)
        .order('question_number', { ascending: true }).range(from, to)
    );
    const apprBySubj: Record<string, number> = {};
    let maxQnum = 0;
    for (const q of targetQs) {
      if (isApproved(q)) apprBySubj[q.subject] = (apprBySubj[q.subject] || 0) + 1;
      maxQnum = Math.max(maxQnum, q.question_number || 0);
    }

    // Per subject: move the shortfall of approved questions from the source job
    const plan: Record<string, { shortfall: number; available: number; moved: number }> = {};
    let nextQnum = maxQnum + 1;
    for (const [subj, target] of Object.entries(targets)) {
      const shortfall = Math.max(0, target - (apprBySubj[subj] || 0));
      const srcQs = await fetchAllRows<Record<string, any>>((from, to) =>
        supabase.from('qb_questions')
          .select('*')
          .eq('job_id', source_job_id).eq('subject', subj).is('replaced_by_id', null)
          .order('question_number', { ascending: true }).range(from, to)
      );
      const donors = srcQs.filter(isApproved).slice(0, shortfall);
      plan[subj] = { shortfall, available: srcQs.filter(isApproved).length, moved: 0 };
      if (apply && donors.length > 0) {
        for (const q of donors) {
          const { error: upErr } = await supabase.from('qb_questions')
            .update({ job_id: targetJobId, question_number: nextQnum++ })
            .eq('id', q.id);
          if (!upErr) plan[subj].moved++;
        }
      }
    }

    const totalShortfall = Object.values(plan).reduce((a, p) => a + p.shortfall, 0);
    const totalMoved = Object.values(plan).reduce((a, p) => a + p.moved, 0);
    res.json({
      ok: true,
      applied: !!apply,
      current_approved: Object.values(apprBySubj).reduce((a, b) => a + b, 0),
      total_shortfall: totalShortfall,
      total_moved: totalMoved,
      plan,
    });
  } catch (e) {
    next(e);
  }
});

// List jobs for a course
jobsRouter.get('/', async (req, res, next) => {
  try {
    const courseId = req.query.course_id as string | undefined;

    let query = supabase
      .from('qb_jobs')
      .select('*, qb_courses(name)')
      .order('created_at', { ascending: false });

    if (courseId) {
      query = query.eq('course_id', courseId);
    }

    const { data, error } = await query;

    if (error) throw new Error(error.message);
    res.json({ jobs: data || [] });
  } catch (e) {
    next(e);
  }
});

// Get job status
jobsRouter.get('/:id', async (req, res, next) => {
  try {
    const { data, error } = await supabase
      .from('qb_jobs')
      .select('*')
      .eq('id', req.params.id)
      .single();

    if (error) throw new Error(error.message);
    res.json({ job: data });
  } catch (e) {
    next(e);
  }
});

// Delete a job and its questions
jobsRouter.delete('/:id', async (req, res, next) => {
  try {
    const jobId = req.params.id;

    // Delete questions first (foreign key)
    await supabase.from('qb_questions').delete().eq('job_id', jobId);

    // Delete the job
    const { error } = await supabase.from('qb_jobs').delete().eq('id', jobId);
    if (error) throw new Error(error.message);

    res.json({ success: true });
  } catch (e) {
    next(e);
  }
});

// Retry failed image generation for a job
jobsRouter.post('/:id/retry-images', async (req, res, next) => {
  try {
    const result = await processAllImageQuestions(req.params.id);
    res.json(result);
  } catch (e) {
    next(e);
  }
});

// Reprocess flagged questions (fix + re-review + re-audit)
jobsRouter.post('/:id/reprocess-flagged', async (req, res, next) => {
  try {
    const result = await reprocessFlaggedForJob(req.params.id);
    res.json(result);
  } catch (e) {
    next(e);
  }
});

// Read-only reprocess status — returns the in-flight run's progress WITHOUT
// starting a new one. The UI polls this on mount to re-attach its progress
// stream after a refresh/disconnect. { running: false } means nothing is active.
jobsRouter.get('/:id/reprocess-status', (req, res, next) => {
  try {
    const state = peekReprocess(req.params.id);
    if (!state) { res.json({ running: false }); return; }
    res.json({ running: state.status === 'running', ...state });
  } catch (e) {
    next(e);
  }
});

// Process next batch (client-orchestrated pipeline)
jobsRouter.post('/:id/next-batch', async (req, res, next) => {
  try {
    const { phase } = req.body;
    const jobId = req.params.id;

    // Fetch current job state
    const { data: job, error } = await supabase
      .from('qb_jobs')
      .select('*')
      .eq('id', jobId)
      .single();

    if (error) throw new Error(error.message);
    if (!job) {
      res.status(404).json({ error: 'Job not found' });
      return;
    }

    // Detect stuck jobs: if generating with all subjects done for > 7 minutes, force-transition
    if (job.status === 'generating') {
      const progress = (job.progress || {}) as Record<string, unknown>;
      const completed = (progress.completed as number) || 0;
      const total = (progress.total as number) || 0;
      if (completed > 0 && completed >= total) {
        const updatedAt = new Date(job.updated_at || job.modified_at || job.created_at).getTime();
        const stuckMinutes = (Date.now() - updatedAt) / 60000;
        if (stuckMinutes > 7) {
          console.warn(`Job ${jobId} stuck at generating (${completed}/${total}) for ${Math.round(stuckMinutes)}min — forcing to reviewing`);
          await supabase
            .from('qb_jobs')
            .update({
              status: 'reviewing',
              progress: { ...progress, message: `Generation complete — ${total} subjects (images may be partial)` },
            })
            .eq('id', jobId);
          res.json({ status: 'reviewing', batch_result: { completed: total, total } });
          return;
        }
      }
    }

    // Determine which phase to execute
    const currentPhase = phase || job.status;

    switch (currentPhase) {
      case 'pending':
      case 'generate':
      case 'generating': {
        try {
          const result = await generateBatchForJob(jobId, job.course_id);
          res.json({ status: result.status, batch_result: result });
        } catch (genErr) {
          const errMsg = genErr instanceof Error ? genErr.message : 'Generation failed';
          await supabase
            .from('qb_jobs')
            .update({ status: 'failed', error: errMsg, progress: { message: errMsg } })
            .eq('id', jobId);
          res.json({ status: 'failed', batch_result: { error: errMsg } });
        }
        break;
      }

      case 'review':
      case 'reviewing': {
        try {
          const result = await reviewBatchForJob(jobId);
          res.json({ status: result.status, batch_result: result });
        } catch (revErr) {
          const errMsg = revErr instanceof Error ? revErr.message : 'Review failed';
          await supabase
            .from('qb_jobs')
            .update({ status: 'failed', error: errMsg, progress: { message: errMsg } })
            .eq('id', jobId);
          res.json({ status: 'failed', batch_result: { error: errMsg } });
        }
        break;
      }

      case 'audit':
      case 'auditing': {
        try {
          const result = await auditBatchForJob(jobId);
          res.json({ status: result.status, batch_result: result });
        } catch (audErr) {
          const errMsg = audErr instanceof Error ? audErr.message : 'Audit failed';
          await supabase
            .from('qb_jobs')
            .update({ status: 'failed', error: errMsg, progress: { message: errMsg } })
            .eq('id', jobId);
          res.json({ status: 'failed', batch_result: { error: errMsg } });
        }
        break;
      }

      default:
        res.json({ status: job.status });
    }
  } catch (e) {
    next(e);
  }
});
