import { Router } from 'express';
import { supabase } from '../db/supabase.js';
import { getSnapshots, getAvailableStages } from '../services/snapshots.js';

export const questionsRouter = Router();

// List questions for a job
questionsRouter.get('/', async (req, res, next) => {
  try {
    const jobId = req.query.job_id as string;
    if (!jobId) {
      res.status(400).json({ error: 'job_id query parameter is required' });
      return;
    }

    const { data, error } = await supabase
      .from('qb_questions')
      .select('*')
      .eq('job_id', jobId)
      .is('replaced_by_id', null) // Only show latest version
      .order('question_number', { ascending: true });

    if (error) throw new Error(error.message);
    res.json({ questions: data });
  } catch (e) {
    next(e);
  }
});

// Get snapshots for a job at a specific stage
questionsRouter.get('/snapshots/:jobId', async (req, res, next) => {
  try {
    const { jobId } = req.params;
    const stage = req.query.stage as string;

    if (stage) {
      const snapshots = await getSnapshots(jobId, stage as 'generated' | 'post_validator' | 'post_adversarial' | 'post_audit' | 'post_replace');
      res.json({ snapshots, stage });
    } else {
      const stages = await getAvailableStages(jobId);
      res.json({ stages });
    }
  } catch (e) {
    next(e);
  }
});

// Get single question
questionsRouter.get('/:id', async (req, res, next) => {
  try {
    const { data, error } = await supabase
      .from('qb_questions')
      .select('*')
      .eq('id', req.params.id)
      .single();

    if (error) throw new Error(error.message);
    res.json({ question: data });
  } catch (e) {
    next(e);
  }
});

// Update question (manual edit)
questionsRouter.put('/:id', async (req, res, next) => {
  try {
    const updates = req.body;
    const { data, error } = await supabase
      .from('qb_questions')
      .update(updates)
      .eq('id', req.params.id)
      .select()
      .single();

    if (error) throw new Error(error.message);
    res.json({ question: data });
  } catch (e) {
    next(e);
  }
});

// Delete a question
questionsRouter.delete('/:id', async (req, res, next) => {
  try {
    const { error } = await supabase
      .from('qb_questions')
      .delete()
      .eq('id', req.params.id);

    if (error) throw new Error(error.message);
    res.json({ success: true });
  } catch (e) {
    next(e);
  }
});

// Manually approve a question
questionsRouter.post('/:id/approve', async (req, res, next) => {
  try {
    const { data: existing, error: fetchError } = await supabase
      .from('qb_questions')
      .select('audit_trail')
      .eq('id', req.params.id)
      .single();

    if (fetchError) throw new Error(fetchError.message);

    const trail = Array.isArray(existing.audit_trail) ? existing.audit_trail : [];
    trail.push({
      phase: 'manual_approve',
      reason: 'Manually approved by editor',
      timestamp: new Date().toISOString(),
    });

    const { data, error } = await supabase
      .from('qb_questions')
      .update({ status: 'approved', audit_trail: trail })
      .eq('id', req.params.id)
      .select()
      .single();

    if (error) throw new Error(error.message);
    res.json({ question: data });
  } catch (e) {
    next(e);
  }
});
