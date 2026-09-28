import { Router } from 'express';
import { supabase } from '../db/supabase.js';
import { fetchAllRows } from '../db/pagination.js';
import { classifyQuestionType, needsMarkdownRegeneration } from '../services/questionType.js';
import { gradabilityIssues } from '../services/review/shared.js';
import { subjectExamMap } from '../services/generation/examSize.js';

export const exportRouter = Router();

// Build full export JSON with embedded base64 images
exportRouter.get('/json/:jobId', async (req, res, next) => {
  try {
    const { jobId } = req.params;
    /** ?exam=<name> exports ONE exam of a multi-exam course on its own. */
    const wantExam = String(req.query.exam || '').trim();

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

    // A course can span several exams (CPA's six sections, CFA's levels), and a bank that
    // mixes them is not a sittable paper. Resolve each question's exam so the export can be
    // read — or taken — one exam at a time.
    //
    // tags.exam is stamped at generation, but questions made before that carry none, so fall
    // back to the course structure's subject -> exam map. Subject names are unique across a
    // course's exams, which is what makes that lookup safe.
    const { data: job } = await supabase.from('qb_jobs').select('course_id').eq('id', jobId).single();
    const { data: course } = job?.course_id
      ? await supabase.from('qb_courses').select('name,structure').eq('id', job.course_id).single()
      : { data: null };
    const structure = (course?.structure || {}) as Record<string, unknown>;
    const examOfSubject = subjectExamMap(structure);
    const examMeta = new Map<string, string>(
      ((structure.exams as Array<Record<string, unknown>>) || [])
        .map((e) => [String(e.name || ''), String(e.code || '')])
    );
    const examOf = (q: Record<string, any>): string =>
      String(q.tags?.exam || examOfSubject[q.subject] || '');

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
        // Self-diagnosing: flag any question that isn't machine-gradable/answerable
        // (missing answer key, or a referenced passage/figure that isn't present).
        const gradIssues = gradabilityIssues(q);

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
            ...(examOf(q) ? { exam: examOf(q), exam_code: examMeta.get(examOf(q)) || undefined } : {}),
            subject: q.subject,
            topic: q.topic,
            ...(topics ? { topics } : {}),       // multi-topic cases carry the full set
            blooms: q.blooms_level || '',
            difficulty,                          // 'easy' | 'medium' | 'hard'
          },
          quality_status: q.status,
          quality_score: q.quality_score,
          ...(gradIssues.length ? { gradability_issues: gradIssues } : {}),
          ...(q.tags?.schema_valid === false && Array.isArray(q.tags?.schema_errors) ? { schema_errors: q.tags.schema_errors } : {}),
          ...(q.tags?.content_review_status ? { content_review_status: q.tags.content_review_status } : {}),
        };
      })
    );

    // Narrow to one exam when asked, so a single section can be handed off as its own paper.
    const selected = wantExam
      ? items.filter((it) => String(it.tags?.exam || '').toLowerCase() === wantExam.toLowerCase())
      : items;

    // Summarise the exams present, with each one's own format mix. A single-exam course
    // produces a one-entry list, so consumers have one shape to read either way.
    const byExam = new Map<string, typeof selected>();
    for (const it of selected) {
      const e = String(it.tags?.exam || '');
      const list = byExam.get(e);
      if (list) list.push(it); else byExam.set(e, [it]);
    }
    const exams = [...byExam.entries()]
      .filter(([name]) => name)
      .map(([name, list]) => ({
        name,
        code: examMeta.get(name) || undefined,
        question_count: list.length,
        formats: list.reduce<Record<string, number>>((acc, it) => {
          const f = String(it.format || 'mcq_single');
          acc[f] = (acc[f] || 0) + 1;
          return acc;
        }, {}),
      }))
      .sort((a, b) => a.name.localeCompare(b.name));

    // Questions generated before the exam tag existed, or whose subject was renamed by a
    // later restructure, resolve to no exam. Say so rather than letting the summary imply a
    // clean split: CFA's bank attributes 196 of 1774, and a block listing only the three
    // Level III variants would read as though that were the whole exam.
    const unassigned = (byExam.get('') || []).length;

    res.json({
      course: course?.name,
      question_count: selected.length,
      // Present only when the questions actually resolve to exams, so a course with no
      // exam dimension exports exactly as it did before.
      ...(exams.length > 0 ? { exams } : {}),
      ...(exams.length > 0 && unassigned > 0 ? { unassigned_question_count: unassigned } : {}),
      ...(wantExam ? { exam: wantExam } : {}),
      questions: selected,
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
