/**
 * Pin an exam's blueprint — its length and its format mix — deterministically.
 *
 * Three of six courses generated in this round came out with the wrong shape, all for the same
 * reason: the blueprint is asked of a model, and the model answers in ITEMS where the pipeline
 * counts ROWS.
 *
 *   NCLEX  produced 138 standalone MCQs and nothing else. The format analysis had concluded the
 *          exam has one item type, so no select-all, matrix, drop-down or unfolding case study
 *          was ever requested — while the guidelines it wrote described "the six machine-scored
 *          members of an unfolding electronic-health-record case". It knew and asked for none.
 *          Re-analysed from the real NGN spec it then returned case_study: 24, which counts
 *          grouped items once and so means 24 unfolding cases, 144 items of case study alone.
 *   MCAT   declared passage_set: 185 and produced 83 items against 230. 185 is the number of
 *          passage-based QUESTIONS on the real exam; as rows it means 185 passages, about 925
 *          items. Generation then under-delivered by 147 items anyway.
 *   LSAT   wanted four reading passages and produced two, then overshot on MCQs.
 *
 * format_question_counts and total_questions count a grouped item ONCE — a case study is 1, not
 * its 6 sub-items. ITEMS_PER_GROUP below records what a row is worth so the two can be stated
 * separately and both checked.
 *
 * Nothing here is asked of a model. The counts come from the published structure of each exam,
 * and the script refuses to write unless every total, distribution and format count agrees.
 *
 * Usage:  npx tsx src/scripts/setExamBlueprint.ts --course=nclex [--apply]
 *         npx tsx src/scripts/setExamBlueprint.ts --course=mcat  [--apply]
 */
import 'dotenv/config';
import { supabase } from '../db/supabase.js';
import { rescaleToTotal } from '../services/generation/examSize.js';

const APPLY = process.argv.includes('--apply');
const WHICH = (process.argv.find((a) => a.startsWith('--course=')) || '').split('=')[1] || '';

interface Blueprint {
  id: string;
  label: string;
  /** Rows per format. A grouped format counts once. */
  rows: Record<string, number>;
  /** Items a single row of that format is worth, where it is more than one. */
  itemsPerGroup: Record<string, number>;
  /** Where the numbers come from, so a reviewer can check them. */
  source: string;
}

const BLUEPRINTS: Record<string, Blueprint> = {
  nclex: {
    id: '5e3d672a-5539-4416-8bf5-1a66e8eaf414',
    label: 'NCLEX-RN (Next Generation)',
    rows: {
      mcq_single: 85,        // the dominant traditional type
      sata: 20,              // multiple response, including extended; partial credit
      matrix_grid: 10,       // each row classified into one exclusive column
      cloze_dropdown: 8,     // clinical note with embedded closed-list blanks
      ordered_response: 5,   // steps in sequence
      fill_blank: 4,         // dosage and intake-output calculation
      case_study: 3,         // unfolding EHR cases, six items each, one per CJMM step
    },
    itemsPerGroup: { case_study: 6 },
    source: 'Maximum-length NGN form delivers 150 items. Three unfolding case studies at six '
      + 'items each (one per Clinical Judgment Measurement Model step) plus 132 standalone.',
  },
  mcat: {
    id: '42c85248-7209-4bfe-9f94-ea128e3ab598',
    label: 'MCAT',
    rows: {
      // 37 passages already existed carrying 150 questions, because the generator answered a
      // "4–6 sub-questions" range at its floor 35 times out of 37. raisePassageFloor.ts raised
      // that floor in the PROSE the generator reads while leaving schema_params.sub_question_min
      // at 4 — see its header for why both could not move — and the 7 further passages needed to
      // reach 185 questions each came back with 5. 150 + 35 = 185.
      passage_set: 44,
      mcq_single: 45,        // discrete items: 15 in each science section, none in CARS
    },
    // The real exam runs about 39 passages of variable length — CARS passages are longer than the
    // science ones — averaging 4.7 questions each to make 185. This bank gets there with 44
    // because its first 37 are thin. Being right about the question count and a few passages over
    // beats being right about passages and 36 questions short: a candidate notices a paper that
    // is the wrong length, not one with a few extra passages.
    itemsPerGroup: { passage_set: 5 },
    source: 'Four sections totalling 230 questions — Chem/Phys 59, CARS 53, Bio/Biochem 59, '
      + 'Psych/Soc 59. About 185 are passage-based over 39 passages; the other 45 are discrete. '
      + 'CARS is entirely passage-based.',
  },
};

const BP = BLUEPRINTS[WHICH.toLowerCase()];
if (!BP) {
  console.log(`--course must be one of: ${Object.keys(BLUEPRINTS).join(', ')}`);
  process.exit(1);
}
const COURSE = BP.id;
const FORMAT_ROWS = BP.rows;
const ITEMS_PER_GROUP = BP.itemsPerGroup;

const TOTAL_ROWS = Object.values(FORMAT_ROWS).reduce((a, b) => a + b, 0);
const TOTAL_ITEMS = Object.entries(FORMAT_ROWS)
  .reduce((n, [f, rows]) => n + rows * (ITEMS_PER_GROUP[f] || 1), 0);

type Dist = Record<string, { questions?: number; percentage?: number; image_pct?: number }>;

/**
 * Compare two values ignoring object key order. Postgres returns JSONB with its own key
 * ordering, so a plain JSON.stringify comparison reports a difference on every re-run and the
 * script looks non-idempotent while writing the same bytes back.
 */
function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v && typeof v === 'object') {
    return `{${Object.entries(v as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, val]) => `${JSON.stringify(k)}:${canonical(val)}`)
      .join(',')}}`;
  }
  return JSON.stringify(v ?? null);
}

function rescaleDistribution(dist: Dist, total: number): { dist: Dist; before: number; after: number } {
  const counts: Record<string, number> = {};
  for (const [k, v] of Object.entries(dist)) counts[k] = Number(v?.questions) || 0;
  const before = Object.values(counts).reduce((a, b) => a + b, 0);
  const scaled = rescaleToTotal(counts, total);
  const out: Dist = {};
  for (const [k, v] of Object.entries(dist)) {
    const q = scaled[k] ?? 0;
    out[k] = { ...v, questions: q, percentage: Math.round((q / total) * 1000) / 10 };
  }
  return { dist: out, before, after: Object.values(out).reduce((a, b) => a + (Number(b.questions) || 0), 0) };
}

const { data, error } = await supabase
  .from('qb_courses').select('name,exam_format,generation_guidelines').eq('id', COURSE).single();
if (error) throw new Error(error.message);

const ef = { ...((data as any).exam_format || {}) } as Record<string, any>;
const gl = { ...((data as any).generation_guidelines || {}) } as Record<string, any>;
const changes: string[] = [];

console.log(`course: ${(data as any).name} — ${BP.label}`);
console.log(`source: ${BP.source}`);
// TOTAL_ITEMS is what the paper holds IF every grouped row carries itemsPerGroup. It is a target,
// not a measurement: MCAT's first 37 passages carry 4 questions each because the generator
// answered a 4-6 range at its floor, so its real count is 230 against the 265 this arithmetic
// implies. Only the ROW total is enforced below — that is what topUpJobFormats acts on — so the
// item figure is labelled as the intent it is.
console.log(`blueprint: ${TOTAL_ROWS} rows, ${TOTAL_ITEMS} scored items if every grouped row is full`);
console.log(`  ${Object.entries(FORMAT_ROWS).map(([f, n]) => `${f}:${n}`).join('  ')}`);
console.log(`\nbefore — exam_format.total=${ef.total_questions} guidelines.total=${gl.total_questions}`);
console.log(`         guidelines.format_distribution=${JSON.stringify((gl.format_distribution || []).map((f: any) => `${f.format}:${f.count}`))}`);

// Every format the blueprint names must have a spec the generator can read, or it silently
// produces nothing of that type — which is how 138 MCQs happened.
const specs = Object.keys(gl.format_specs || {});
const missing = Object.keys(FORMAT_ROWS).filter((f) => !specs.includes(f));
if (missing.length) {
  console.log(`\nABORT — no generation spec for: ${missing.join(', ')}`);
  console.log('Run POST /api/courses/:id/guidelines first so every declared format has a spec.');
  process.exit(1);
}

// ── exam_format ───────────────────────────────────────────────────────────────
if (ef.total_questions !== TOTAL_ROWS) {
  changes.push(`exam_format.total_questions ${ef.total_questions} -> ${TOTAL_ROWS}`);
  ef.total_questions = TOTAL_ROWS;
}
const efCounts = (ef.format_question_counts || {}) as Record<string, number>;
if (canonical(efCounts) !== canonical(FORMAT_ROWS)) {
  changes.push(`exam_format.format_question_counts ${JSON.stringify(efCounts)} -> pinned`);
  ef.format_question_counts = { ...FORMAT_ROWS };
}
if (ef.subject_distribution && Object.keys(ef.subject_distribution).length) {
  const r = rescaleDistribution(ef.subject_distribution as Dist, TOTAL_ROWS);
  if (r.before !== r.after) {
    changes.push(`exam_format.subject_distribution ${r.before} -> ${r.after}`);
    ef.subject_distribution = r.dist;
  }
}

// ── generation_guidelines ─────────────────────────────────────────────────────
if (gl.total_questions !== TOTAL_ROWS) {
  changes.push(`generation_guidelines.total_questions ${gl.total_questions} -> ${TOTAL_ROWS}`);
  gl.total_questions = TOTAL_ROWS;
}
if (gl.subject_distribution && Object.keys(gl.subject_distribution).length) {
  const r = rescaleDistribution(gl.subject_distribution as Dist, TOTAL_ROWS);
  if (r.before !== r.after) {
    changes.push(`generation_guidelines.subject_distribution ${r.before} -> ${r.after}`);
    gl.subject_distribution = r.dist;
  }
}
// Rebuild format_distribution from the blueprint, keeping each entry's own description.
if (Array.isArray(gl.format_distribution)) {
  const described = new Map<string, string>(
    (gl.format_distribution as any[]).map((f) => [String(f.format), String(f.description || '')])
  );
  const rebuilt = Object.entries(FORMAT_ROWS).map(([format, count]) => ({
    format,
    count,
    percentage: Math.round((count / TOTAL_ROWS) * 1000) / 10,
    ...(described.get(format) ? { description: described.get(format) } : {}),
    ...(ITEMS_PER_GROUP[format] ? { items_per_group: ITEMS_PER_GROUP[format] } : {}),
  }));
  if (canonical(gl.format_distribution) !== canonical(rebuilt)) {
    changes.push(`generation_guidelines.format_distribution rebuilt to ${TOTAL_ROWS} rows across ${rebuilt.length} formats`);
    gl.format_distribution = rebuilt;
  }
}

console.log(`\n${APPLY ? 'APPLYING' : 'DRY RUN'} — ${changes.length} change(s)`);
for (const c of changes) console.log(`  - ${c}`);

const efSum = Object.values((ef.subject_distribution || {}) as Dist).reduce((n, v) => n + (Number(v.questions) || 0), 0);
const glSum = Object.values((gl.subject_distribution || {}) as Dist).reduce((n, v) => n + (Number(v.questions) || 0), 0);
const fdSum = (gl.format_distribution as any[] || []).reduce((n, f) => n + (Number(f.count) || 0), 0);
const fcSum = Object.values((ef.format_question_counts || {}) as Record<string, number>).reduce((a, b) => a + b, 0);
console.log(`\nafter  — total=${ef.total_questions}/${gl.total_questions}  subjectDist=${efSum}/${glSum}  formatCounts=${fcSum}  formatDist=${fdSum}`);
const ok = [ef.total_questions, gl.total_questions, efSum, glSum, fcSum, fdSum].every((n) => n === TOTAL_ROWS);
console.log(ok
  ? `consistent: every total, distribution and format count agrees on ${TOTAL_ROWS} rows`
  : 'INCONSISTENT — not writing');
if (!ok) process.exit(1);

if (!APPLY) { console.log('\nRe-run with --apply to write.'); process.exit(0); }
const { error: upErr } = await supabase.from('qb_courses')
  .update({ exam_format: ef, generation_guidelines: gl }).eq('id', COURSE);
console.log(upErr ? `FAILED: ${upErr.message}` : 'written');
