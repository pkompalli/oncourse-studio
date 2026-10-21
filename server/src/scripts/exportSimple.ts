/**
 * A plain export of reviewed imported questions: one JSON file, one object per question, with the
 * question as a candidate sees it and the labels the live bank keeps. Images are embedded as base64
 * data URIs so the file stands alone.
 *
 *   npx tsx src/scripts/exportSimple.ts <jobId> [<jobId> …] --out ~/Downloads/usmle_150.json [--all]
 *
 * Approved questions only, unless --all. Read-only on the database.
 */
import 'dotenv/config';
import { readFileSync, writeFileSync } from 'node:fs';
import { supabase } from '../db/supabase.js';
import { fetchAllRows } from '../db/pagination.js';
import { fetchImageAsDataUrl } from '../services/review/shared.js';

type Row = Record<string, any>;
const jobIds = process.argv.slice(2).filter((a) => /^[0-9a-f-]{36}$/.test(a));
const oi = process.argv.indexOf('--out');
const OUT = oi >= 0 ? process.argv[oi + 1] : 'backups/usmle_export/simple_export.json';
const ALL = process.argv.includes('--all');
// --only <ids.json>: just these qb_questions ids (reworkFlagged.ts output).
const ONLY = process.argv.indexOf('--only') >= 0 ? new Set<string>(JSON.parse(readFileSync(process.argv[process.argv.indexOf('--only') + 1], 'utf8'))) : null;
// --exclude <ids.json>: leave these out (a question held back after a quality check).
const EXCLUDE = process.argv.indexOf('--exclude') >= 0 ? new Set<string>(JSON.parse(readFileSync(process.argv[process.argv.indexOf('--exclude') + 1], 'utf8'))) : null;
// --step step3: the live-bank Step tag for generated items, which carry no source Step of their own.
const STEP_ARG = process.argv.indexOf('--step') >= 0 ? process.argv[process.argv.indexOf('--step') + 1] : undefined;
if (!jobIds.length) { console.log('usage: exportSimple.ts <jobId> [<jobId> …] --out <file.json> [--all]'); process.exit(1); }

const STEP_TAG: Record<string, string> = { step1: 'USMLE - Step 1', step2: 'USMLE - Step 2 CK', step3: 'USMLE - Step 3' };
const STEP_OF_EXAM: Record<string, string> = { 'USMLE Step 1': 'step1', 'USMLE Step 2 CK': 'step2', 'USMLE Step 3': 'step3' };

const rows: Row[] = [];
for (const jobId of jobIds) {
  rows.push(...await fetchAllRows<Row>((from, to) => supabase.from('qb_questions').select('*')
    .eq('job_id', jobId).is('replaced_by_id', null).order('question_number').range(from, to)));
}
const chosen = rows.filter((q) => (ALL || q.status === 'approved') && (!ONLY || ONLY.has(q.id)) && !EXCLUDE?.has(q.id));

// Course names for tags on items that are not imported USMLE items.
const courseIds = [...new Set(rows.map((q) => q.course_id).filter(Boolean))];
const { data: courseRows } = courseIds.length ? await supabase.from('qb_courses').select('id, name').in('id', courseIds) : { data: [] };
const courseName = new Map((courseRows || []).map((c: Row) => [c.id, String(c.name)]));

const out: Row[] = [];
let missingImages = 0;
for (const q of chosen) {
  const tags = (q.tags || {}) as Row;
  const step = STEP_OF_EXAM[String(tags.belongs_to_exam ?? '')] ?? tags.step ?? STEP_ARG;
  const image = q.image_url ? await fetchImageAsDataUrl(q.image_url) : null;
  if (q.image_url && !image) missingImages++;
  // A bow-tie item keeps its three option groups and its key in content; exported with the same
  // field names, as groups ({condition, actions, parameters}) in place of a letter map.
  const c = (q.content || {}) as Row;
  const bowTie = Array.isArray(c.condition_options);
  const opts = (v: unknown) => Object.fromEntries(((v as Row[]) || []).map((o) => [o.key, o.text]));
  out.push({
    question: q.question || c.stem,
    ...(bowTie ? { format: 'bow_tie' } : {}),
    options: bowTie ? { condition: opts(c.condition_options), actions: opts(c.action_options), parameters: opts(c.parameter_options) } : q.options,
    correct_option: bowTie ? { condition: c.answer?.condition, actions: c.answer?.actions, parameters: c.answer?.parameters } : q.correct_option,
    ...(bowTie ? { scoring: c.scoring || '0/1' } : {}),
    type: q.image_url ? 'image' : 'text',
    image_base64: image,
    explanation: q.explanation || c.explanation,
    subject: q.subject,
    topic: q.topic,
    original_question_id: tags.source_question_id ?? null,
    difficulty: q.difficulty ?? tags.difficulty ?? null,
    blooms_level: q.blooms_level ?? tags.blooms ?? null,
    tags: step ? ['USMLE', STEP_TAG[step] ?? 'USMLE'] : [courseName.get(q.course_id) ?? 'Unknown', ...(bowTie ? ['Bow-Tie'] : [])],
  });
}

writeFileSync(OUT, JSON.stringify(out, null, 2));
console.log(JSON.stringify({ exported: out.length, of: rows.length, images: out.filter((x) => x.type === 'image').length, images_not_downloaded: missingImages }));
console.log(`→ ${OUT}`);
