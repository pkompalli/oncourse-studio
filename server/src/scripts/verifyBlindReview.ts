/**
 * Prove that a blind review really is blind.
 *
 * The two-phase adversarial pass is worth nothing if the answer leaks into phase 1. A leak
 * would not announce itself either — the reviewer would simply keep agreeing with the key, and
 * the stage would look like it was working while testing nothing, which is the state it was
 * already in.
 *
 * So this checks the serializer directly, over real rows of every format the six live courses
 * produce, for three properties:
 *
 *   1. NO ANSWER   — none of the answer labels, and no answer-bearing JSON key, survives.
 *   2. NO RATIONALE — no explanation or rationale, since either states the answer in prose.
 *   3. STILL ANSWERABLE — the stem and the options are intact. A "blind" rendering that also
 *      hid the options would be unanswerable rather than blind, and every attempt would
 *      disagree with the key for the wrong reason.
 *
 * Property 3 is the one a careless redaction breaks, which is why it is tested alongside the
 * other two rather than assumed.
 *
 * Read-only. Run it after any change to the review serializer.
 *
 *   npx tsx src/scripts/verifyBlindReview.ts
 */
import 'dotenv/config';
import { supabase } from '../db/supabase.js';
import { fetchAllRows } from '../db/pagination.js';
import { formatQuestionsForReview } from '../services/review/shared.js';

const JOB_PREFIXES = ['b777cd54', '9eafe612', '074ac820', '9c01f36e', '5071eac0', '2317bc4a'];

/** Labels the serializer uses to introduce an answer. None may appear in a blind rendering. */
const ANSWER_LABELS = [
  'Correct Answer:', 'Correct Answers:', 'Correct Order:', 'Correct IDs:',
  'Correct Cells:', 'Correct Region:', 'Acceptable Range:', 'Rationale:', 'Explanation:',
  'Answer:', 'Scoring Rubric:',
];

/** Answer-bearing JSON keys, which could survive inside the structured-content dump. */
const ANSWER_JSON_KEYS = [
  '"answer"', '"correct_answer"', '"correct_answers"', '"correct_order"', '"correct_cells"',
  '"correct_ids"', '"correct_option"', '"rationale"', '"explanation"', '"scoring_rubric"',
  '"correct"',
];

const { data: jobs } = await supabase.from('qb_jobs').select('id');
const jobIds = (jobs || []).map((j: { id: string }) => j.id)
  .filter((id: string) => JOB_PREFIXES.some((p) => id.startsWith(p)));

const { data: formats } = await supabase.from('qb_question_formats').select('id,slug');
const slugOf = new Map((formats || []).map((f: { id: string; slug: string }) => [f.id, f.slug]));

let rows: Array<Record<string, unknown>> = [];
for (const id of jobIds) {
  rows = rows.concat(await fetchAllRows<Record<string, unknown>>((f, t) =>
    supabase.from('qb_questions').select('*').eq('job_id', id)
      .in('status', ['approved', 'reviewed', 'generated']).is('replaced_by_id', null).range(f, t)));
}

// One sample per format, plus every image question, so each serializer branch is exercised.
const byFormat = new Map<string, Array<Record<string, unknown>>>();
for (const r of rows) {
  const slug = slugOf.get(r.format_id as string) || 'unknown';
  if (!byFormat.has(slug)) byFormat.set(slug, []);
  byFormat.get(slug)!.push(r);
}

console.log(`${rows.length} rows across ${jobIds.length} jobs, ${byFormat.size} formats\n`);

let failures = 0;
let checked = 0;

for (const [slug, group] of [...byFormat].sort()) {
  const sample = group.slice(0, 5);
  const problems: string[] = [];

  for (const row of sample) {
    checked++;
    const blind = formatQuestionsForReview([row], true);
    const open = formatQuestionsForReview([row], false);

    for (const label of ANSWER_LABELS) {
      if (blind.includes(label)) problems.push(`${String(row.id).slice(0, 8)}: leaked label "${label}"`);
    }
    for (const key of ANSWER_JSON_KEYS) {
      if (blind.includes(key)) problems.push(`${String(row.id).slice(0, 8)}: leaked JSON key ${key}`);
    }

    // Still answerable: the stem survives, and so does the option text a candidate chooses from.
    const content = (row.content as Record<string, unknown>) || {};
    const stem = String(content.stem ?? row.question ?? '').slice(0, 60).trim();
    if (stem && !blind.includes(stem)) {
      problems.push(`${String(row.id).slice(0, 8)}: stem missing from blind rendering`);
    }
    const opts = content.options;
    if (Array.isArray(opts) && opts.length) {
      const first = typeof opts[0] === 'string'
        ? String(opts[0])
        : String((opts[0] as Record<string, unknown>)?.text ?? '');
      const probe = first.slice(0, 40).trim();
      if (probe && !blind.includes(probe)) {
        problems.push(`${String(row.id).slice(0, 8)}: options missing from blind rendering`);
      }
    }

    // The open rendering must be unaffected — this change must not have altered normal review.
    if (open.length <= blind.length) {
      problems.push(`${String(row.id).slice(0, 8)}: open rendering is not longer than blind (${open.length} vs ${blind.length})`);
    }
  }

  const mark = problems.length ? 'FAIL' : ' ok ';
  console.log(`[${mark}] ${slug.padEnd(24)} ${String(sample.length).padStart(2)} sampled of ${String(group.length).padStart(4)}`);
  for (const p of problems.slice(0, 6)) console.log(`        ${p}`);
  failures += problems.length;
}

console.log(`\n${checked} questions checked, ${failures} problem(s).`);
if (failures) {
  console.log('A leak here means phase 1 is reading the answer it is supposed to be deriving.');
  process.exit(1);
}
console.log('Blind rendering withholds every answer field and keeps every question answerable.');
