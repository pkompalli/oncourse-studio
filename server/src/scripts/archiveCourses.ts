/**
 * Flag old and duplicate courses as archived (qb_courses.archived_at / archived_reason, migration 006),
 * keeping one clean course per exam: a full structure, an exam profile with its size, and generation
 * guidelines with format contracts.
 *
 *   npx tsx src/scripts/archiveCourses.ts            # list what would be flagged, and why
 *   npx tsx src/scripts/archiveCourses.ts --apply    # write the flags
 *   npx tsx src/scripts/archiveCourses.ts --undo <id> # clear one flag
 */
import 'dotenv/config';
import { supabase } from '../db/supabase.js';

const ARCHIVE: Record<string, string> = {
  'aefa6333-6d9e-4ff4-97aa-8c794c8577d6': 'superseded by the three USMLE Step courses (f9d20070, 2b2ab63c, 90b430d9); no generation guidelines',
  '6f0a7efa-aa3d-4a97-97a3-28c136c0cbda': 'duplicate of USMLE STEP1 f9d20070; no generation guidelines',
  'b82f6d13-59fe-4d38-8e3b-7d3bf9fa2bdc': 'duplicate of USMLE STEP2 2b2ab63c; no generation guidelines',
  '5e9a1a7f-6dd5-4b72-ac16-6be92586cee4': 'duplicate of USMLE STEP2 2b2ab63c; partial structure (2 subjects), no exam size, no generation guidelines',
  '6a7bab4d-1b5f-4f47-9f77-d8d129af2d62': 'duplicate of USMLE STEP3 90b430d9; no generation guidelines',
  '3c003948-d700-48ca-a7e3-77584b95074e': 'duplicate of NCLEX RN 5e3d672a; no exam size, no format contracts',
  'a5641565-0135-4eed-85cc-9c384ee8aa34': 'older duplicate of NCLEX RN 5e3d672a, which carries the bow-tie format and the generated sets',
  '84657c0d-d2e5-4cbe-a6b0-9510addb5166': 'duplicate of NEET PG c1a20d64; 17 subjects (no Psychiatry; Anatomy merged with Radiology) against the exam\'s 19',
};

const undo = process.argv.indexOf('--undo');
if (undo >= 0) {
  const id = process.argv[undo + 1];
  const { error } = await supabase.from('qb_courses').update({ archived_at: null, archived_reason: null }).eq('id', id);
  console.log(error ? `failed: ${error.message}` : `unarchived ${id}`);
  process.exit(0);
}

const apply = process.argv.includes('--apply');
const { data, error } = await supabase.from('qb_courses').select('id, name, structure, exam_format, generation_guidelines').order('name');
if (error) throw new Error(error.message);
for (const c of data!) {
  const reason = ARCHIVE[c.id];
  const ef = (c.exam_format || {}) as Record<string, any>, g = (c.generation_guidelines || {}) as Record<string, any>;
  const clean = ((c.structure as any)?.subjects || []).length > 0 && ef.exam_pattern && Number(ef.total_questions) > 0 && g.format_specs;
  console.log(`${reason ? 'ARCHIVE' : clean ? 'keep   ' : 'keep (!)'} ${c.name.padEnd(12)} ${c.id}${reason ? ` — ${reason}` : clean ? '' : ' — kept but missing structure, exam size or guidelines'}`);
  if (!apply || !reason) continue;
  const { error: e } = await supabase.from('qb_courses').update({ archived_at: new Date().toISOString(), archived_reason: reason }).eq('id', c.id);
  if (e) { console.error(`  write failed: ${e.message}${/archived_at/.test(e.message) ? ' (run supabase/migrations/006_course_archive.sql first)' : ''}`); process.exit(1); }
}
process.exit(0);
