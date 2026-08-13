import { Router } from 'express';
import { supabase } from '../db/supabase.js';

export const formatsRouter = Router();

// List all formats
formatsRouter.get('/', async (_req, res, next) => {
  try {
    const { data, error } = await supabase
      .from('qb_question_formats')
      .select('*')
      .order('source', { ascending: true })
      .order('name', { ascending: true });

    if (error) throw new Error(error.message);
    res.json({ formats: data });
  } catch (e) {
    next(e);
  }
});

// Get single format
formatsRouter.get('/:id', async (req, res, next) => {
  try {
    const { data, error } = await supabase
      .from('qb_question_formats')
      .select('*')
      .eq('id', req.params.id)
      .single();

    if (error) throw new Error(error.message);
    res.json({ format: data });
  } catch (e) {
    next(e);
  }
});

// Get format by slug
formatsRouter.get('/slug/:slug', async (req, res, next) => {
  try {
    const { data, error } = await supabase
      .from('qb_question_formats')
      .select('*')
      .eq('slug', req.params.slug)
      .single();

    if (error) throw new Error(error.message);
    res.json({ format: data });
  } catch (e) {
    next(e);
  }
});

// Create a new format (user-defined or AI-discovered)
formatsRouter.post('/', async (req, res, next) => {
  try {
    const { name, slug, description, schema, example, display, prompt_guide, source } = req.body;
    if (!name || !slug) {
      res.status(400).json({ error: 'name and slug are required' });
      return;
    }

    const { data, error } = await supabase
      .from('qb_question_formats')
      .insert({
        name,
        slug,
        description: description || '',
        schema: schema || {},
        example: example || {},
        display: display || { layout: 'stem_then_text', answer_display: 'text_reveal', compact_label: slug.toUpperCase() },
        prompt_guide: prompt_guide || '',
        source: source || 'user_defined',
      })
      .select()
      .single();

    if (error) throw new Error(error.message);
    res.json({ format: data });
  } catch (e) {
    next(e);
  }
});

// Update a format
formatsRouter.put('/:id', async (req, res, next) => {
  try {
    const updates: Record<string, unknown> = {};
    const allowed = ['name', 'description', 'schema', 'example', 'display', 'prompt_guide'];
    for (const key of allowed) {
      if (req.body[key] !== undefined) updates[key] = req.body[key];
    }

    const { data, error } = await supabase
      .from('qb_question_formats')
      .update(updates)
      .eq('id', req.params.id)
      .select()
      .single();

    if (error) throw new Error(error.message);
    res.json({ format: data });
  } catch (e) {
    next(e);
  }
});

// Delete a format (only user-defined / ai-discovered)
formatsRouter.delete('/:id', async (req, res, next) => {
  try {
    const { data: format } = await supabase
      .from('qb_question_formats')
      .select('source')
      .eq('id', req.params.id)
      .single();

    if (format?.source === 'builtin') {
      res.status(403).json({ error: 'Cannot delete builtin formats' });
      return;
    }

    const { error } = await supabase
      .from('qb_question_formats')
      .delete()
      .eq('id', req.params.id);

    if (error) throw new Error(error.message);
    res.json({ success: true });
  } catch (e) {
    next(e);
  }
});
