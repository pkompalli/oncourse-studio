import { Router } from 'express';
import { supabase } from '../db/supabase.js';
import { fetchAllRows } from '../db/pagination.js';
import { classifyQuestionType, needsMarkdownRegeneration } from '../services/questionType.js';

export const exportRouter = Router();

// Build full export JSON with embedded base64 images
exportRouter.get('/json/:jobId', async (req, res, next) => {
  try {
    const { jobId } = req.params;

    const questions = await fetchAllRows<Record<string, any>>((from, to) =>
      supabase
        .from('qb_questions')
        .select('*')
        .eq('job_id', jobId)
        .is('replaced_by_id', null)
        .in('status', ['approved', 'reviewed', 'generated'])
        .order('question_number', { ascending: true })
        .range(from, to)
    );

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

        // Canonical, de-duplicated export item. Everything lives in ONE place:
        // structured data in `content`, images in `media`, metadata in `tags`.
        // (No flattened legacy duplicates, no separate markdown block — exhibits
        // already live in content; no mcq scaffolding leaking into non-mcq records.)
        const questionType = classifyQuestionType(q);
        const needsRegen = needsMarkdownRegeneration(q);

        // Canonical content — synthesize from legacy columns only if absent.
        const content = q.content || {
          stem: q.question,
          options: Object.entries(q.options || {})
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([key, text]) => ({ key, text })),
          answer: { key: q.correct_option },
          explanation: q.explanation || '',
        };

        // Uniform difficulty label (DB stores an int; sub-questions use strings).
        const diffMap: Record<number, string> = { 1: 'easy', 2: 'medium', 3: 'hard' };
        const difficulty = typeof q.difficulty === 'number'
          ? (diffMap[q.difficulty] || 'medium')
          : (q.difficulty || 'medium');
        const topics = Array.isArray(q.content?.topics) ? q.content.topics : undefined;

        return {
          format: q.tags?.format_type || 'mcq_single',
          question_type: questionType,           // 'text' | 'image' | 'markdown'
          needs_regeneration: needsRegen,        // intended markdown but stored as image
          content,                               // stem/exhibits/sub_questions/options/answer/explanation
          media,                                 // images (base64 + url), [] if none
          tags: {
            subject: q.subject,
            topic: q.topic,
            ...(topics ? { topics } : {}),       // multi-topic cases carry the full set
            blooms: q.blooms_level || '',
            difficulty,                          // 'easy' | 'medium' | 'hard'
          },
          quality_status: q.status,
          quality_score: q.quality_score,
          ...(q.tags?.content_review_status ? { content_review_status: q.tags.content_review_status } : {}),
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

    const questions = await fetchAllRows<Record<string, any>>((from, to) =>
      supabase
        .from('qb_questions')
        .select('*')
        .eq('job_id', job_id)
        .is('replaced_by_id', null)
        .in('status', ['approved', 'reviewed'])
        .order('question_number', { ascending: true })
        .range(from, to)
    );

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
