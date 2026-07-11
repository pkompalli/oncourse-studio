import { Router } from 'express';
import { supabase } from '../db/supabase.js';
import { generateBatchForJob } from '../services/generation/questionGeneration.js';
import { reviewBatchForJob } from '../services/review/reviewPipeline.js';
import { auditBatchForJob } from '../services/audit/auditPipeline.js';
import { processAllImageQuestions } from '../services/images/imageGeneration.js';
import { reprocessFlaggedForJob } from '../services/review/reprocessFlagged.js';

export const jobsRouter = Router();

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
    res.json({ job: data });
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
