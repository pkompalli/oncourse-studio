import { Router } from 'express';
import { supabase } from '../db/supabase.js';
import { generateCourseStructure, parseStructureFromInput } from '../services/generation/courseStructure.js';
import { refineCourseStructure, refineExamFormat } from '../services/generation/refineStructure.js';
import { analyzeExamFormat, withMockExamSpecs, interpretExamFormatFromText } from '../services/generation/examFormat.js';
import { generateGuidelines, refineGuidelines, reconcileExamSizeSelf } from '../services/generation/guidelines.js';
import { scopeCourseToExam } from '../services/generation/examScope.js';

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
// Select which exam (of a multi-exam course) subsequent steps operate on.
// Non-destructive: stores structure.selected_exam, keeps the full structure.
coursesRouter.post('/:id/select-exam', async (req, res, next) => {
  try {
    const { exam } = req.body || {};

    const { data: course, error: fetchError } = await supabase
      .from('qb_courses')
      .select('*')
      .eq('id', req.params.id)
      .single();
    if (fetchError) throw new Error(fetchError.message);

    const structure = { ...(course.structure as Record<string, unknown>) };
    structure.selected_exam = exam || null;

    // Don't pollute exam_type with the "all exams" sentinel.
    const examType = exam && exam !== '__all__' ? exam : course.exam_type || null;
    const { data, error } = await supabase
      .from('qb_courses')
      .update({ structure, exam_type: examType })
      .eq('id', req.params.id)
      .select()
      .single();
    if (error) throw new Error(error.message);
    res.json({ course: data });
  } catch (e) {
    next(e);
  }
});

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

    // Scope to the selected exam (if the course spans multiple exams).
    const { courseName, structure } = scopeCourseToExam(course);

    // Step 1: Analyze exam format (question type, bloom's, difficulty, image %)
    const examFormat = await analyzeExamFormat(courseName, structure);

    let combinedFormat: Record<string, unknown>;

    if (qbank_mode === 'topic_wise' || qbank_mode === 'topic_qbank') {
      // Topic-wise: only need question style, bloom's, difficulty, image %
      // No mock exam specs (total questions, subject distribution) needed
      combinedFormat = examFormat;
    } else {
      // Mock exam: also fetch total questions, per-subject and per-format counts.
      combinedFormat = await withMockExamSpecs(examFormat, courseName, structure);
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

    // Scope to the selected exam (if the course spans multiple exams).
    const { courseName, structure } = scopeCourseToExam(course);
    let examFormat = (course.exam_format || {}) as Record<string, unknown>;

    // A mock exam needs a real length, and the exam-format step only fetches one when it
    // was itself run in mock-exam mode. A course analysed topic-wise therefore arrives
    // here with no total and no subject distribution, and the guidelines LLM invents both.
    // Backfill lazily — on demand rather than by widening that gate, so a topic-wise
    // analysis still never pays for this call.
    const { qbank_mode } = req.body || {};
    const isMockExam = qbank_mode !== 'topic_wise' && qbank_mode !== 'topic_qbank';
    const hasSize = Number(examFormat.total_questions) > 0
      && Object.keys((examFormat.subject_distribution as Record<string, unknown>) || {}).length > 0;
    if (isMockExam && !hasSize && Object.keys(examFormat).length > 0) {
      console.log(`  [Guidelines] ${courseName}: no exam size on record — fetching mock exam specs`);
      examFormat = await withMockExamSpecs(examFormat, courseName, structure);
      const { error: efErr } = await supabase
        .from('qb_courses')
        .update({ exam_format: examFormat })
        .eq('id', req.params.id);
      if (efErr) throw new Error(efErr.message);
    }

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
    const { message, patch } = req.body;
    if (!message && !patch) {
      res.status(400).json({ error: 'Message or patch is required' });
      return;
    }

    const { data: course, error: fetchError } = await supabase
      .from('qb_courses')
      .select('*')
      .eq('id', req.params.id)
      .single();

    if (fetchError) throw new Error(fetchError.message);

    const currentGuidelines = (course.generation_guidelines || {}) as Record<string, unknown>;

    // A direct field patch — correcting the exam length, say. Deterministic: no LLM call,
    // no cost, and no chance of the refine model rewriting unrelated sections. The size
    // reconciler then rescales the subject and format counts onto the new total.
    if (patch && typeof patch === 'object') {
      // The structure supplies subject -> exam, so editing one exam's total rescales only
      // that exam's subjects rather than redistributing across every exam in the course.
      const { structure: scopedStructure } = scopeCourseToExam(course);
      const next = reconcileExamSizeSelf(
        { ...currentGuidelines, ...(patch as Record<string, unknown>) },
        scopedStructure
      );
      const { data, error } = await supabase
        .from('qb_courses')
        .update({ generation_guidelines: next })
        .eq('id', req.params.id)
        .select()
        .single();
      if (error) throw new Error(error.message);
      const total = Number(next.total_questions) || 0;
      res.json({ course: data, chat_response: total ? `Exam size set to ${total} questions.` : 'Guidelines updated.' });
      return;
    }
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
