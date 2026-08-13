import { Router } from 'express';
import { supabase } from '../db/supabase.js';

export const exportRouter = Router();

// Build full export JSON with embedded base64 images
exportRouter.get('/json/:jobId', async (req, res, next) => {
  try {
    const { jobId } = req.params;

    const { data: questions, error } = await supabase
      .from('qb_questions')
      .select('*')
      .eq('job_id', jobId)
      .is('replaced_by_id', null)
      .in('status', ['approved', 'reviewed', 'generated'])
      .order('question_number', { ascending: true });

    if (error) throw new Error(error.message);
    if (!questions || questions.length === 0) {
      res.json({ questions: [], exported_at: new Date().toISOString() });
      return;
    }

    // Fetch images in parallel and embed as base64
    const items = await Promise.all(
      questions.map(async (q) => {
        let image_base64: string | null = null;
        let image_media_type: string | null = null;

        if (q.is_image_question && q.image_url) {
          try {
            const imgRes = await fetch(q.image_url);
            if (imgRes.ok) {
              const buffer = Buffer.from(await imgRes.arrayBuffer());
              image_base64 = buffer.toString('base64');
              image_media_type = imgRes.headers.get('content-type') || 'image/png';
            }
          } catch {
            // non-fatal — image just won't be embedded
          }
        }

        const media = q.is_image_question && q.image_url ? [{
          type: q.image_type || 'image',
          url: q.image_url,
          ...(image_base64 ? { base64: image_base64, media_type: image_media_type } : {}),
        }] : [];

        return {
          format: q.tags?.format_type || 'mcq_single',
          content: q.content || {
            stem: q.question,
            options: Object.entries(q.options || {})
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([key, text]) => ({ key, text })),
            answer: { key: q.correct_option },
            explanation: q.explanation || '',
          },
          tags: {
            subject: q.subject,
            topic: q.topic,
            blooms: q.blooms_level || '',
            difficulty: q.difficulty ?? 1,
          },
          media,
          question: q.question,
          options: q.options,
          correct_option: q.correct_option,
          explanation: q.explanation || '',
          subject: q.subject,
          topic: q.topic,
          blooms_level: q.blooms_level || '',
          difficulty: q.difficulty ?? 1,
          quality_status: q.status,
          quality_score: q.quality_score,
        };
      })
    );

    res.json({
      question_count: items.length,
      questions: items,
      exported_at: new Date().toISOString(),
    });
  } catch (e) {
    next(e);
  }
});

// Legacy create export
exportRouter.post('/', async (req, res, next) => {
  try {
    const { job_id, format } = req.body;
    if (!job_id || !format) {
      res.status(400).json({ error: 'job_id and format are required' });
      return;
    }

    const { data: questions, error: qError } = await supabase
      .from('qb_questions')
      .select('*')
      .eq('job_id', job_id)
      .is('replaced_by_id', null)
      .in('status', ['approved', 'reviewed'])
      .order('question_number', { ascending: true });

    if (qError) throw new Error(qError.message);

    const exportData = {
      format,
      question_count: questions?.length || 0,
      questions: questions || [],
      exported_at: new Date().toISOString(),
    };

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
