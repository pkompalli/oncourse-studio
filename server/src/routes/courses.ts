import { Router } from 'express';
import { supabase } from '../db/supabase.js';
import { generateCourseStructure, parseStructureFromInput } from '../services/generation/courseStructure.js';
import { refineCourseStructure, refineExamFormat } from '../services/generation/refineStructure.js';
import { analyzeExamFormat, fetchMockExamSpecs } from '../services/generation/examFormat.js';

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
        } catch (e) {
          if (e instanceof Error && e.message === 'NEEDS_AI_PROCESSING') {
            // Not valid JSON — use AI to structure it
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

// Analyze exam format and fetch mock exam specs
coursesRouter.post('/:id/exam-format', async (req, res, next) => {
  try {
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

    // Step 2: Fetch mock exam specs (total questions, per-subject distribution)
    const subjects = ((structure.subjects as Array<{ name: string }>) || []).map((s) => s.name);
    const mockSpecs = await fetchMockExamSpecs(courseName, subjects);

    // Merge into a single exam_format object
    const combinedFormat = {
      ...examFormat,
      ...mockSpecs,
    };

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
