import { Router } from 'express';
import { supabase } from '../db/supabase.js';

export const exportRouter = Router();

// Create export
exportRouter.post('/', async (req, res, next) => {
  try {
    const { job_id, format } = req.body;
    if (!job_id || !format) {
      res.status(400).json({ error: 'job_id and format are required' });
      return;
    }

    // Fetch approved questions for the job
    const { data: questions, error: qError } = await supabase
      .from('qb_questions')
      .select('*')
      .eq('job_id', job_id)
      .is('replaced_by_id', null)
      .in('status', ['approved', 'reviewed'])
      .order('question_number', { ascending: true });

    if (qError) throw new Error(qError.message);

    // TODO: Generate proper export files and upload to Supabase Storage
    // For now, return the data inline

    const exportData = {
      format,
      question_count: questions?.length || 0,
      questions: questions || [],
      exported_at: new Date().toISOString(),
    };

    // Save export record
    const { data: exportRecord, error: expError } = await supabase
      .from('qb_exports')
      .insert({
        job_id,
        format,
        metadata: {
          question_count: questions?.length || 0,
        },
      })
      .select()
      .single();

    if (expError) throw new Error(expError.message);

    res.json({ export: { ...exportRecord, data: exportData } });
  } catch (e) {
    next(e);
  }
});
