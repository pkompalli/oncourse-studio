/**
 * Generate generation_guidelines for courses that have none, the way the app's
 * POST /courses/:id/guidelines does (scopeCourseToExam, withMockExamSpecs when the exam has no size on
 * record, generateGuidelines). Without guidelines a course has no format contracts, anti-patterns or
 * distractor rules, so generation and review fall back to defaults.
 *
 *   npx tsx src/scripts/setCourseGuidelines.ts --ids <id,id,…>          # generate, save for review
 *   npx tsx src/scripts/setCourseGuidelines.ts --ids <id,id,…> --apply  # snapshot rows, write saved files
 *
 * A course that already has guidelines is skipped unless --force.
 */
import 'dotenv/config';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { supabase } from '../db/supabase.js';
import { generateGuidelines } from '../services/generation/guidelines.js';
import { withMockExamSpecs } from '../services/generation/examFormat.js';
import { scopeCourseToExam } from '../services/generation/examScope.js';

const arg = (n: string) => { const i = process.argv.indexOf(`--${n}`); return i >= 0 ? process.argv[i + 1] : undefined; };
const ids = (arg('ids') || '').split(',').map((s) => s.trim()).filter(Boolean);
const APPLY = process.argv.includes('--apply');
const FORCE = process.argv.includes('--force');
const OUT = 'backups/course_guidelines';
if (!ids.length) throw new Error('--ids required');
mkdirSync(OUT, { recursive: true });

const { data: courses, error } = await supabase.from('qb_courses').select('*').in('id', ids);
if (error) throw new Error(error.message);
const todo = courses!.filter((c) => FORCE || !Object.keys((c.generation_guidelines || {}) as object).length);
for (const c of courses!) if (!todo.includes(c)) console.log(`  skip ${c.name} (${c.id}): already has guidelines`);

if (APPLY) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  writeFileSync(`backups/qb_courses_pre_guidelines_${stamp}.json`, JSON.stringify(todo, null, 2));
  for (const c of todo) {
    const file = `${OUT}/${c.id}.json`;
    if (!existsSync(file)) { console.log(`  ${c.name}: ${file} missing — run without --apply first`); continue; }
    const saved = JSON.parse(readFileSync(file, 'utf8'));
    const { error: e } = await supabase.from('qb_courses').update({ generation_guidelines: saved.guidelines, ...(saved.exam_format ? { exam_format: saved.exam_format } : {}) }).eq('id', c.id);
    console.log(e ? `  ${c.name}: write failed ${e.message}` : `  wrote ${c.name} (${c.id})`);
  }
  console.log(`snapshot: backups/qb_courses_pre_guidelines_${stamp}.json`);
} else {
  await Promise.all(todo.map(async (c) => {
    const { courseName, structure } = scopeCourseToExam(c);
    let examFormat = (c.exam_format || {}) as Record<string, unknown>;
    const hasSize = Number(examFormat.total_questions) > 0 && Object.keys((examFormat.subject_distribution as object) || {}).length > 0;
    let formatChanged = false;
    if (!hasSize && Object.keys(examFormat).length) {
      console.log(`  [${courseName}] no exam size on record — fetching mock exam specs`);
      examFormat = await withMockExamSpecs(examFormat, courseName, structure);
      formatChanged = true;
    }
    console.log(`  [${courseName}] generating guidelines…`);
    const guidelines = await generateGuidelines(courseName, structure, examFormat);
    writeFileSync(`${OUT}/${c.id}.json`, JSON.stringify({ name: c.name, guidelines, ...(formatChanged ? { exam_format: examFormat } : {}) }, null, 2));
    const specs = Object.keys((guidelines.format_specs as object) || {});
    console.log(`  [${courseName}] done: ${Object.keys(guidelines).length} keys; formats ${specs.join(', ')}; anti-patterns ${((guidelines.anti_patterns as unknown[]) || []).length}`);
  }));
  console.log(`dry run: review ${OUT}/*.json, then rerun with --apply`);
}
process.exit(0);
