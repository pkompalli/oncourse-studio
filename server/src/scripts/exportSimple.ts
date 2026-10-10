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
if (!jobIds.length) { console.log('usage: exportSimple.ts <jobId> [<jobId> …] --out <file.json> [--all]'); process.exit(1); }

const STEP_TAG: Record<string, string> = { step1: 'USMLE - Step 1', step2: 'USMLE - Step 2 CK', step3: 'USMLE - Step 3' };
const STEP_OF_EXAM: Record<string, string> = { 'USMLE Step 1': 'step1', 'USMLE Step 2 CK': 'step2', 'USMLE Step 3': 'step3' };

const rows: Row[] = [];
for (const jobId of jobIds) {
  rows.push(...await fetchAllRows<Row>((from, to) => supabase.from('qb_questions').select('*')
    .eq('job_id', jobId).is('replaced_by_id', null).order('question_number').range(from, to)));
}
const chosen = rows.filter((q) => (ALL || q.status === 'approved') && (!ONLY || ONLY.has(q.id)));

const out: Row[] = [];
let missingImages = 0;
for (const q of chosen) {
  const tags = (q.tags || {}) as Row;
  const step = STEP_OF_EXAM[String(tags.belongs_to_exam ?? '')] ?? tags.step;
  const image = q.image_url ? await fetchImageAsDataUrl(q.image_url) : null;
  if (q.image_url && !image) missingImages++;
  out.push({
    question: q.question,
    options: q.options,
    correct_option: q.correct_option,
    type: q.image_url ? 'image' : 'text',
    image_base64: image,
    explanation: q.explanation,
    subject: q.subject,
    topic: q.topic,
    original_question_id: tags.source_question_id ?? null,
    difficulty: q.difficulty ?? tags.difficulty ?? null,
    blooms_level: q.blooms_level ?? tags.blooms ?? null,
    tags: ['USMLE', STEP_TAG[step] ?? 'USMLE'],
  });
}

writeFileSync(OUT, JSON.stringify(out, null, 2));
console.log(JSON.stringify({ exported: out.length, of: rows.length, images: out.filter((x) => x.type === 'image').length, images_not_downloaded: missingImages }));
console.log(`→ ${OUT}`);
