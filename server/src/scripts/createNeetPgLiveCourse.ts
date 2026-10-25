/**
 * Create a studio NEET PG course whose structure IS the live bank's: the subjects and topics of course
 * 'Indian PG' (967d23a4…, project ylbwdadhbcjolwylidja) verbatim, so questions exported from it
 * (exportLiveNeetPg.ts) carry topics that exist in the structure without any mapping.
 *
 * Guidelines: the qualitative material of the earlier NEET PG course (c1a20d64…: exam pattern, format
 * specs, anti-patterns, distractor/explanation/image rules) is reused, with its subject name OBGYN
 * renamed to the live bank's. Its blueprint numbers were a model's estimate (40/45/15, 59 images per
 * 200) and are replaced by the measured mix of the 2019–2025 NEET PG papers in the live bank
 * (1,557 questions; see neetPgSample.sql), wherever they appear — the numeric fields and the prose
 * rules that restate them.
 *
 *   npx tsx src/scripts/createNeetPgLiveCourse.ts           # dry run: prints the structure and every change
 *   npx tsx src/scripts/createNeetPgLiveCourse.ts --apply
 *
 * Reads the live bank only (READ ONLY transaction); writes one row to qb_courses.
 */
import 'dotenv/config';
import pg from 'pg';
import { supabase } from '../db/supabase.js';

const APPLY = process.argv.includes('--apply');
const LIVE_COURSE = '967d23a4-3bc7-4653-a5c3-82e91420c615';
const TEMPLATE_COURSE = 'c1a20d64-ebc8-4774-8070-72ac0602de4e';
const NAME = 'NEET PG (live bank structure)';

// Per 10,000 from the 2019–2025 papers: subject share, and the image questions that share implies
// (neetPgSample.sql, si.q and si.qi_target). Image = has an attached image.
const REF: Record<string, [number, number]> = {
  'Internal Medicine': [1387, 308], 'Obstetrics and Gynecology': [796, 122], Pathology: [758, 238], Microbiology: [752, 180],
  'Community Medicine': [726, 77], Surgery: [726, 270], Pharmacology: [668, 19], Biochemistry: [610, 19], Anatomy: [527, 270],
  Physiology: [450, 39], Pediatrics: [366, 77], Radiology: [353, 257], 'Forensic Medicine': [334, 64], Dermatology: [321, 199],
  Ophthalmology: [321, 122], ENT: [263, 122], Orthopaedics: [244, 135], Psychiatry: [199, 0], Anesthesiology: [199, 83],
};
const DIFFICULTY = { easy: 30, medium: 50, hard: 20 };
const TOTAL = 200;

// ── live structure ────────────────────────────────────────────────────────────────────────────────
const client = new pg.Client({ connectionString: process.env.LIVE_DATABASE_URL, ssl: { rejectUnauthorized: false } });
await client.connect();
await client.query('set session characteristics as transaction read only');
const { rows } = await client.query(`
  select s.name as subject, t.name as topic, coalesce(t.is_high_yield, false) as hy
  from subjects s join topics t on t.subject_id = s.id
  where s.course_id = $1 order by s.name, t.sort_order nulls last, t.name`, [LIVE_COURSE]);
await client.end();

const bySubject = new Map<string, Array<{ name: string; chapters: never[]; high_yield: boolean }>>();
for (const r of rows) (bySubject.get(r.subject) ?? bySubject.set(r.subject, []).get(r.subject)!).push({ name: r.topic, chapters: [], high_yield: r.hy });
const left = [...bySubject.keys()].filter((s) => !REF[s]);
for (const s of left) bySubject.delete(s);
const missing = Object.keys(REF).filter((s) => !bySubject.has(s));
if (missing.length) throw new Error(`live bank has no subject ${missing.join(', ')}`);
const subjects = Object.keys(REF).map((name) => ({ name, topics: bySubject.get(name)! }));
const structure = { course: 'NEET PG', exam_type: 'medical', subjects };
console.log(`structure: ${subjects.length} subjects, ${subjects.reduce((a, s) => a + s.topics.length, 0)} topics (live subjects left out, not in the exam: ${left.join(', ') || 'none'})`);
for (const s of subjects) console.log(`  ${s.name} (${s.topics.length}): ${s.topics.map((t) => t.name).join('; ')}`);

// ── blueprint per 200 ─────────────────────────────────────────────────────────────────────────────
const apportion = (w: Record<string, number>, total: number) => {
  const sum = Object.values(w).reduce((a, b) => a + b, 0);
  const ex = Object.entries(w).map(([k, v]) => ({ k, x: (total * v) / sum }));
  const out = Object.fromEntries(ex.map(({ k, x }) => [k, Math.floor(x)]));
  let rest = total - Object.values(out).reduce((a, b) => a + b, 0);
  for (const { k } of [...ex].sort((a, b) => (b.x - Math.floor(b.x)) - (a.x - Math.floor(a.x)) || a.k.localeCompare(b.k))) if (rest-- > 0) out[k]++;
  return out as Record<string, number>;
};
const counts = apportion(Object.fromEntries(Object.entries(REF).map(([k, [n]]) => [k, n])), TOTAL);
const imgPct = Object.fromEntries(Object.entries(REF).map(([k, [n, i]]) => [k, Math.round((100 * i) / n)]));
const imgTotal = Math.round((TOTAL * Object.values(REF).reduce((a, [, i]) => a + i, 0)) / 10000);
const diffCounts = apportion(DIFFICULTY, TOTAL);
const pct = (n: number) => Math.round((1000 * n) / TOTAL) / 10;
const overallImgPct = Math.round((100 * imgTotal) / TOTAL);

// ── guidelines from the template, renamed and re-numbered ─────────────────────────────────────────
const { data: tpl, error } = await supabase.from('qb_courses').select('exam_format, generation_guidelines').eq('id', TEMPLATE_COURSE).single();
if (error || !tpl) throw new Error(`template course: ${error?.message}`);
const renamed = JSON.parse(JSON.stringify(tpl).replaceAll('OBGYN', 'Obstetrics and Gynecology'));
const ef = renamed.exam_format, gg = renamed.generation_guidelines;
const changes: string[] = [];
const set = (obj: any, key: string, value: unknown, label: string) => {
  changes.push(`${label}\n      was: ${JSON.stringify(obj[key])?.slice(0, 400)}\n      now: ${JSON.stringify(value).slice(0, 400)}`);
  obj[key] = value;
};
const PROVENANCE = 'measured on the 2019–2025 NEET PG papers in the live bank';

set(ef, 'subject_question_counts', counts, 'exam_format.subject_question_counts');
set(ef, 'subject_image_pct', imgPct, 'exam_format.subject_image_pct');
set(ef, 'image_percentage_by_subject', imgPct, 'exam_format.image_percentage_by_subject');
set(ef, 'subject_distribution', Object.fromEntries(Object.keys(REF).map((k) => [k, { image_pct: imgPct[k], questions: counts[k], percentage: pct(counts[k]) }])), 'exam_format.subject_distribution');
set(ef, 'image_questions_total', imgTotal, 'exam_format.image_questions_total');
set(ef, 'difficulty_distribution', DIFFICULTY, 'exam_format.difficulty_distribution');
set(ef.question_format, 'image_questions_percentage', overallImgPct, 'exam_format.question_format.image_questions_percentage');
set(ef, 'exam_notes', String(ef.exam_notes).replace(/Approximately 15-20% of questions are image-based/, `About ${overallImgPct}% of questions are image-based (${PROVENANCE})`), 'exam_format.exam_notes');
set(gg, 'subject_distribution', Object.fromEntries(Object.keys(REF).map((k) => [k, { questions: counts[k], percentage: pct(counts[k]) }])), 'generation_guidelines.subject_distribution');
set(gg, 'difficulty_distribution', DIFFICULTY, 'generation_guidelines.difficulty_distribution');

const rules: string[] = gg.custom_rules;
const i59 = rules.findIndex((r) => r.includes('explicit image total of 59'));
const iDiff = rules.findIndex((r) => /exactly 80 easy, 90 medium, and 30 hard/.test(r));
if (i59 < 0 || iDiff < 0) throw new Error('template custom_rules changed; re-check the numeric rules by hand');
set(rules, String(i59), rules[i59].replace('explicit image total of 59', `explicit image total of ${imgTotal}`), `generation_guidelines.custom_rules[${i59}]`);
set(rules, String(iDiff), `The difficulty counts for a complete paper are exactly ${diffCounts.easy} easy, ${diffCounts.medium} medium, and ${diffCounts.hard} hard (${PROVENANCE}).`, `generation_guidelines.custom_rules[${iDiff}]`);
const mcq = gg.format_specs.mcq_single;
set(mcq, 'difficulty_target', String(mcq.difficulty_target).replace(/40% easy, 45% medium, and 15% hard/, `${DIFFICULTY.easy}% easy, ${DIFFICULTY.medium}% medium, and ${DIFFICULTY.hard}% hard`), 'format_specs.mcq_single.difficulty_target');

// The image rule restates the old per-subject image quotas, and a coverage rule describes a
// subject_question_counts that disagreed with subject_distribution; both now carry the same counts.
const imgQuota = apportion(Object.fromEntries(Object.entries(REF).map(([k, [, i]]) => [k, i])), imgTotal);
const ig = gg.image_guidelines;
const iQuota = String(ig.when_required).indexOf('Use exactly 59 image-dependent items.');
if (iQuota < 0) throw new Error('template image_guidelines.when_required changed; re-check it by hand');
set(ig, 'when_required', `${String(ig.when_required).slice(0, iQuota)}Use exactly ${imgTotal} image-dependent items (${overallImgPct}% of ${TOTAL}, ${PROVENANCE}). Subject image quotas, which sum exactly to ${imgTotal}: ${Object.entries(imgQuota).map(([k, v]) => `${k} ${v}`).join('; ')}. The duplicate image_percentage_by_subject values carry the same mix and are not a second allocation.`, 'generation_guidelines.image_guidelines.when_required');
const cov: string[] = gg.coverage_rules;
const iCov = cov.findIndex((r) => r.includes('whose values sum to 220'));
if (iCov < 0) throw new Error('template coverage_rules changed; re-check it by hand');
set(cov, String(iCov), `Use the supplied subject_distribution.questions values as the authoritative subject allocation. They sum to ${TOTAL}; subject_question_counts carries the same values.`, `generation_guidelines.coverage_rules[${iCov}]`);

// Anything else in the prose that still states a count, percentage or image figure is printed for review.
const stale: string[] = [];
const scan = (v: any, path: string) => {
  if (typeof v === 'string') { if (/\b(59|220|80 easy|40% easy|15-20%|\d+ (?:items|questions) (?:of|from|in) [A-Z])/.test(v)) stale.push(`${path}: ${v.slice(0, 220)}`); }
  else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) if (!/distribution|counts|_pct|percentage_by/.test(k)) scan(x, `${path}.${k}`);
};
scan(renamed, '');

console.log(`\nblueprint per ${TOTAL}: ${JSON.stringify(counts)}\nimages ${imgTotal} (${overallImgPct}%), difficulty ${JSON.stringify(diffCounts)}`);
console.log(`\n${changes.length} changes to the template guidelines (after renaming OBGYN):\n  ${changes.join('\n  ')}`);
console.log(stale.length ? `\nprose that may still state an old number:\n  ${stale.join('\n  ')}` : '\nno other prose states an old number');

if (!APPLY) { console.log('\ndry run; --apply to create the course'); process.exit(0); }
const { data: existing } = await supabase.from('qb_courses').select('id').eq('name', NAME).is('archived_at', null);
if (existing?.length) throw new Error(`a course named '${NAME}' already exists: ${existing.map((c) => c.id).join(', ')}`);
const { data: created, error: insErr } = await supabase.from('qb_courses')
  .insert({ name: NAME, exam_type: 'medical', structure, exam_format: ef, generation_guidelines: gg }).select('id').single();
if (insErr) throw new Error(insErr.message);
console.log(`\ncreated course ${created!.id} '${NAME}'`);
process.exit(0);
