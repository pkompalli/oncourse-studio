/**
 * Blind-check the images of existing questions (images/imageCheck.ts), and optionally redraw the ones
 * that fail. Read-only unless --apply.
 *
 *   npx tsx src/scripts/checkImages.ts --job <id> [--job <id> …] [--apply] [--regen]
 *   npx tsx src/scripts/checkImages.ts --sample 30 [--status approved]      # clinical images bank-wide
 *
 * --apply stores each verdict on the row (tags.image_check), which gradabilityIssues reads; --regen
 * redraws a failed image through regenerateQuestionImage (itself blind-checked) and implies --apply.
 */
import 'dotenv/config';
import { supabase } from '../db/supabase.js';
import { fetchAllRows } from '../db/pagination.js';
import { checkImage, imageCheckFix } from '../services/images/imageCheck.js';
import { isClinicalStudy, regenerateQuestionImage } from '../services/images/imageGeneration.js';

const args = process.argv.slice(2);
const all = (n: string) => args.flatMap((a, i) => (a === `--${n}` ? [args[i + 1]] : []));
const REGEN = args.includes('--regen');
const APPLY = REGEN || args.includes('--apply');
const SAMPLE = Number(all('sample')[0]) || 0;
const STATUS = all('status')[0];

type Row = Record<string, any>;
let rows: Row[] = [];
const cols = 'id, job_id, course_id, question_number, question, options, correct_option, image_type, image_description, image_url, is_image_question, status, tags';
for (const job of all('job')) {
  rows.push(...await fetchAllRows<Row>((f, t) => supabase.from('qb_questions').select(cols).eq('job_id', job)
    .eq('is_image_question', true).not('image_url', 'is', null).is('replaced_by_id', null).range(f, t)));
}
if (SAMPLE) {
  let q = supabase.from('qb_questions').select(cols).eq('is_image_question', true).not('image_url', 'is', null).is('replaced_by_id', null);
  if (STATUS) q = q.eq('status', STATUS);
  const { data } = await q.order('created_at', { ascending: false }).limit(SAMPLE * 6);
  const clinical = (data || []).filter((r) => isClinicalStudy(String(r.image_type || ''), String(r.image_description || '')));
  rows.push(...clinical.sort(() => Math.random() - 0.5).slice(0, SAMPLE));
}
rows = rows.filter((r) => isClinicalStudy(String(r.image_type || ''), String(r.image_description || '')));
const { data: courses } = await supabase.from('qb_courses').select('id, name');
const courseName = new Map((courses || []).map((c: Row) => [c.id, c.name]));
console.log(`checking ${rows.length} clinical image(s)`);

let pass = 0, fail = 0, err = 0, redrawn = 0;
for (const q of rows) {
  const tag = `${String(q.id).slice(0, 8)} ${courseName.get(q.course_id) ?? ''} [${q.image_type}]`;
  try {
    const res = await fetch(q.image_url);
    if (!res.ok) { console.log(`${tag}: image did not load (${res.status})`); err++; continue; }
    const c = await checkImage(q, Buffer.from(await res.arrayBuffer()), res.headers.get('content-type') || 'image/png');
    c.pass ? pass++ : fail++;
    console.log(`${tag}: ${c.pass ? 'PASS' : `FAIL — ${c.missing.join('; ').slice(0, 220)}`}\n    read: ${c.read.replace(/\s+/g, ' ').slice(0, 260)}`);
    if (APPLY) await supabase.from('qb_questions').update({ tags: { ...(q.tags || {}), image_check: { ...c, url: q.image_url } } }).eq('id', q.id);
    if (REGEN && !c.pass) {
      const ok = await regenerateQuestionImage(q.id, q.job_id, [imageCheckFix(c)]);
      if (ok) redrawn++;
      const { data: after } = await supabase.from('qb_questions').select('tags').eq('id', q.id).single();
      console.log(`    redraw: ${ok ? (after?.tags?.image_check?.pass ? 'passes now' : 'still fails') : 'not redrawn'}`);
    }
  } catch (e) {
    err++; console.log(`${tag}: error — ${e instanceof Error ? e.message.slice(0, 160) : e}`);
  }
}
console.log(JSON.stringify({ checked: rows.length, pass, fail, error: err, ...(REGEN ? { redrawn } : {}) }));
process.exit(0);
