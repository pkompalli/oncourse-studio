import { Router } from 'express';
import { supabase } from '../db/supabase.js';
import { generateCourseStructure, parseStructureFromInput } from '../services/generation/courseStructure.js';
import { refineCourseStructure, refineExamFormat } from '../services/generation/refineStructure.js';
import { analyzeExamFormat, fetchMockExamSpecs, interpretExamFormatFromText } from '../services/generation/examFormat.js';
import { generateGuidelines, refineGuidelines } from '../services/generation/guidelines.js';

export const coursesRouter = Router();

// Create a new course
coursesRouter.post('/', async (req, res, next) => {
  try {
    const { name, reference_doc, input_method } = req.body;
    if (!name) {
      res.status(400).json({ error: 'Course name is required' });
      return;
    }

    let structure: Record<string, unknown>;

    if (input_method === 'paste' || input_method === 'upload') {
      if (reference_doc) {
        try {
          // Try to parse as JSON directly
          structure = parseStructureFromInput(reference_doc, name);
          console.log(`[courses] Parsed uploaded JSON directly — ${(structure.subjects as unknown[])?.length || 0} subjects`);
        } catch (e) {
          if (e instanceof Error && e.message === 'NEEDS_AI_PROCESSING') {
            // Not valid JSON or unrecognized structure — use AI to structure it
            console.log(`[courses] Uploaded content needs AI processing — calling LLM...`);
            structure = await generateCourseStructure(name, reference_doc);
          } else {
            throw e;
          }
        }
      } else {
        // No content provided — fall back to AI generation
        structure = await generateCourseStructure(name);
      }
    } else {
      // Default: AI generation from exam name
      structure = await generateCourseStructure(name, reference_doc);
    }

    const { data, error } = await supabase
      .from('qb_courses')
      .insert({
        name,
        exam_type: (structure.exam_type as string) || null,
        structure,
      })
      .select()
      .single();

    if (error) throw new Error(error.message);
    res.json({ course: data });
  } catch (e) {
    next(e);
  }
});

// List courses
coursesRouter.get('/', async (_req, res, next) => {
  try {
    const { data, error } = await supabase
      .from('qb_courses')
      .select('*')
      .order('created_at', { ascending: false });

    if (error) throw new Error(error.message);
    res.json({ courses: data });
  } catch (e) {
    next(e);
  }
});

// Get single course
coursesRouter.get('/:id', async (req, res, next) => {
  try {
    const { data, error } = await supabase
      .from('qb_courses')
      .select('*')
      .eq('id', req.params.id)
      .single();

    if (error) throw new Error(error.message);
    res.json({ course: data });
  } catch (e) {
    next(e);
  }
});

// Delete a course
coursesRouter.delete('/:id', async (req, res, next) => {
  try {
    const { error } = await supabase
      .from('qb_courses')
      .delete()
      .eq('id', req.params.id);

    if (error) throw new Error(error.message);
    res.json({ success: true });
  } catch (e) {
    next(e);
  }
});

// Analyze exam format (and optionally fetch mock exam specs)
coursesRouter.post('/:id/exam-format', async (req, res, next) => {
  try {
    const { qbank_mode } = req.body || {};

    // Fetch current course
    const { data: course, error: fetchError } = await supabase
      .from('qb_courses')
      .select('*')
      .eq('id', req.params.id)
      .single();

    if (fetchError) throw new Error(fetchError.message);

    const structure = course.structure as Record<string, unknown>;
    const courseName = course.name as string;

    // Step 1: Analyze exam format (question type, bloom's, difficulty, image %)
    const examFormat = await analyzeExamFormat(courseName, structure);

    let combinedFormat: Record<string, unknown>;

    if (qbank_mode === 'topic_wise' || qbank_mode === 'topic_qbank') {
      // Topic-wise: only need question style, bloom's, difficulty, image %
      // No mock exam specs (total questions, subject distribution) needed
      combinedFormat = examFormat;
    } else {
      // Mock exam: also fetch total questions, per-subject distribution
      const subjects = ((structure.subjects as Array<{ name: string }>) || []).map((s) => s.name);
      const mockSpecs = await fetchMockExamSpecs(courseName, subjects);
      combinedFormat = { ...examFormat, ...mockSpecs, exam_pattern: examFormat.exam_pattern };

      // Override subject_distribution image percentages with Phase 2 data (more accurate)
      const phase2ImgPct = (examFormat.image_percentage_by_subject as Record<string, number>) || {};
      const subjectDist = (combinedFormat.subject_distribution as Record<string, { questions: number; percentage: number; image_pct: number }>) || {};
      let totalImgQ = 0;
      for (const [subjName, dist] of Object.entries(subjectDist)) {
        // Find matching Phase 2 image percentage
        const key = subjName.toLowerCase().trim();
        let imgPct: number | null = null;
        if (subjName in phase2ImgPct) imgPct = phase2ImgPct[subjName];
        else {
          for (const [k, v] of Object.entries(phase2ImgPct)) {
            if (k.toLowerCase().trim() === key || k.toLowerCase().includes(key) || key.includes(k.toLowerCase())) {
              imgPct = v;
              break;
            }
          }
        }
        if (imgPct !== null) {
          dist.image_pct = imgPct;
        }
        totalImgQ += Math.round((dist.questions * dist.image_pct) / 100);
      }
      // Enforce overall image target — scale up per-subject image_pct if weighted average is too low
      const qf = (combinedFormat.question_format as Record<string, number>) || {};
      const targetImgPct = qf.image_questions_percentage || 35;
      const totalQ = Object.values(subjectDist).reduce((sum, d) => sum + d.questions, 0);
      const targetImgQ = Math.round((totalQ * targetImgPct) / 100);

      if (totalImgQ < targetImgQ && totalImgQ > 0) {
        const scaleFactor = targetImgQ / totalImgQ;
        totalImgQ = 0;
        for (const dist of Object.values(subjectDist)) {
          dist.image_pct = Math.min(90, Math.round(dist.image_pct * scaleFactor));
          totalImgQ += Math.round((dist.questions * dist.image_pct) / 100);
        }
      }

      combinedFormat.subject_distribution = subjectDist;
      combinedFormat.image_questions_total = totalImgQ;
    }

    // Save to DB
    const { data, error } = await supabase
      .from('qb_courses')
      .update({ exam_format: combinedFormat })
      .eq('id', req.params.id)
      .select()
      .single();

    if (error) throw new Error(error.message);
    res.json({ course: data });
  } catch (e) {
    next(e);
  }
});

// Interpret raw text as exam format (accepts any format: plain text, markdown, guidelines, etc.)
coursesRouter.post('/:id/exam-format-from-text', async (req, res, next) => {
  try {
    const { raw_text } = req.body;
    if (!raw_text || !raw_text.trim()) {
      res.status(400).json({ error: 'Text content is required' });
      return;
    }

    const { data: course, error: fetchError } = await supabase
      .from('qb_courses')
      .select('*')
      .eq('id', req.params.id)
      .single();

    if (fetchError) throw new Error(fetchError.message);

    const structure = course.structure as Record<string, unknown>;
    const courseName = course.name as string;

    // Use AI to interpret the raw text into structured exam format
    const examFormat = await interpretExamFormatFromText(raw_text, courseName, structure);

    // Save to DB
    const { data, error } = await supabase
      .from('qb_courses')
      .update({ exam_format: examFormat })
      .eq('id', req.params.id)
      .select()
      .single();

    if (error) throw new Error(error.message);
    res.json({ course: data });
  } catch (e) {
    next(e);
  }
});

// Refine course structure via chat
coursesRouter.put('/:id', async (req, res, next) => {
  try {
    const { message, refine_type } = req.body;
    if (!message) {
      res.status(400).json({ error: 'Message is required' });
      return;
    }

    // Fetch current course
    const { data: course, error: fetchError } = await supabase
      .from('qb_courses')
      .select('*')
      .eq('id', req.params.id)
      .single();

    if (fetchError) throw new Error(fetchError.message);

    if (refine_type === 'exam_format') {
      // Refine exam format
      const result = await refineExamFormat(course.exam_format || {}, message);
      if (result.updated_specs) {
        const { data, error } = await supabase
          .from('qb_courses')
          .update({ exam_format: result.updated_specs })
          .eq('id', req.params.id)
          .select()
          .single();
        if (error) throw new Error(error.message);
        res.json({ course: data, chat_response: result.response });
      } else {
        res.json({ course, chat_response: result.response });
      }
    } else {
      // Refine course structure
      const result = await refineCourseStructure(course.name, course.structure, message);
      if (result.modified && result.updated_structure) {
        const { data, error } = await supabase
          .from('qb_courses')
          .update({ structure: result.updated_structure })
          .eq('id', req.params.id)
          .select()
          .single();
        if (error) throw new Error(error.message);
        res.json({ course: data, chat_response: result.response });
      } else {
        res.json({ course, chat_response: result.response });
      }
    }
  } catch (e) {
    next(e);
  }
});

// Generate guidelines from exam format + structure
coursesRouter.post('/:id/guidelines', async (req, res, next) => {
  try {
    const { data: course, error: fetchError } = await supabase
      .from('qb_courses')
      .select('*')
      .eq('id', req.params.id)
      .single();

    if (fetchError) throw new Error(fetchError.message);

    const structure = course.structure as Record<string, unknown>;
    const examFormat = (course.exam_format || {}) as Record<string, unknown>;
    const courseName = course.name as string;

    const guidelines = await generateGuidelines(courseName, structure, examFormat);

    const { data, error } = await supabase
      .from('qb_courses')
      .update({ generation_guidelines: guidelines })
      .eq('id', req.params.id)
      .select()
      .single();

    if (error) throw new Error(error.message);
    res.json({ course: data });
  } catch (e) {
    next(e);
  }
});

// Refine guidelines via chat
coursesRouter.put('/:id/guidelines', async (req, res, next) => {
  try {
    const { message } = req.body;
    if (!message) {
      res.status(400).json({ error: 'Message is required' });
      return;
    }

    const { data: course, error: fetchError } = await supabase
      .from('qb_courses')
      .select('*')
      .eq('id', req.params.id)
      .single();

    if (fetchError) throw new Error(fetchError.message);

    const currentGuidelines = (course.generation_guidelines || {}) as Record<string, unknown>;
    const result = await refineGuidelines(currentGuidelines, message, course.name as string);

    if (result.updated_guidelines) {
      const { data, error } = await supabase
        .from('qb_courses')
        .update({ generation_guidelines: result.updated_guidelines })
        .eq('id', req.params.id)
        .select()
        .single();
      if (error) throw new Error(error.message);
      res.json({ course: data, chat_response: result.response });
    } else {
      res.json({ course, chat_response: result.response });
    }
  } catch (e) {
    next(e);
  }
});
