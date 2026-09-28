/**
 * Put the Bar course's answer model on NextGen rather than the retired MBE/MEE/MPT one.
 *
 * Job af81661d came out structurally right — 120 MCQ, 6 integrated sets, 3 performance tasks,
 * 540 minutes — but every one of its 120 MCQs was four options with a single correct answer.
 * NextGen has TWO standalone multiple-choice forms:
 *
 *   select one of four   A-D, one correct                 (the familiar shape)
 *   select two of six    A-F, ends "Select two", TWO      (new; partial credit — one of the
 *                        correct answers, partial credit   two points for finding one of them)
 *
 * And its integrated question sets come in two shapes rather than one uniform six:
 *
 *   counselling  six "components" mixing multiple-choice and SHORT ANSWER (~a sentence each)
 *   drafting     a single medium-length written component
 *
 * NCBE publishes neither the select-one/select-two ratio nor the counselling/drafting split,
 * so 90/30 and 4/2 are recorded here as deliberate assumptions, not sourced facts.
 *
 * Dry run by default — prints the change and writes nothing. Pass --apply.
 */
import 'dotenv/config';
import { supabase } from '../db/supabase.js';

const APPLY = process.argv.includes('--apply');
const COURSE = (process.argv.find((a) => a.startsWith('--course=')) || '').split('=')[1]
  || '238d1337-4d70-4543-b298-108573ed2571'; // Bar Exam

/** 3 sessions x (40 MCQ + 2 integrated sets + 1 performance task) = the whole paper. */
const COUNTS = { mcq_single: 90, mcq_multi: 30, case_study: 6, performance_task: 3 };
const TOTAL = Object.values(COUNTS).reduce((a, b) => a + b, 0);

async function main() {
  const { data: course, error } = await supabase
    .from('qb_courses').select('name,exam_format').eq('id', COURSE).single();
  if (error || !course) throw new Error(error?.message || 'course not found');

  const ef = { ...(course.exam_format as Record<string, unknown>) };
  const existing = (ef.question_types as Array<Record<string, unknown>>) || [];
  const find = (slug: string) => existing.find((t) => t.slug === slug) || {};

  const questionTypes: Array<Record<string, unknown>> = [
    {
      ...find('mcq_single'),
      slug: 'mcq_single',
      name: 'Standalone Multiple-Choice — select one of four',
      percentage: 30,
      num_options: 4,
      items_per_unit: 1,
      answer_format: 'one correct answer from four options (A-D)',
      description: 'A discrete fact pattern with four answer options, exactly one of which is correct.',
    },
    {
      ...find('mcq_multi'),
      slug: 'mcq_multi',
      name: 'Standalone Multiple-Choice — select two of six',
      percentage: 10,
      num_options: 6,
      items_per_unit: 1,
      answer_format: 'exactly two correct answers from six options (A-F), partial credit',
      description: 'A discrete fact pattern with six answer options (A-F) of which EXACTLY TWO are correct. The stem ends "Select two." Partial credit applies: identifying one of the two correct answers earns one of the two available points. Often asks which issues are most important to research.',
    },
    {
      ...find('case_study'),
      slug: 'case_study',
      name: 'Integrated Question Set',
      percentage: 30,
      // A counselling set has six components; a drafting set has one. The old 5..6 bound
      // could not express a drafting set at all.
      items_per_unit: 6,
      items_per_unit_min: 1,
      items_per_unit_max: 6,
      answer_format: 'components answered in order — multiple-choice and short answer',
      description: 'A shared client matter or fact scenario, sometimes with legal resources or supplemental documents. COUNSELLING sets carry six components answered in order, mixing select-one-of-four, select-two-of-six and SHORT ANSWER (about one sentence per answer field). DRAFTING sets carry a single medium-length written component. There are no stand-alone essays on this exam.',
    },
    {
      ...find('performance_task'),
      slug: 'performance_task',
      name: 'Performance Task',
      percentage: 30,
      items_per_unit: 1,
      description: 'A supplied client file and legal resources, and an extended realistic lawyering assignment scored against a rubric.',
    },
  ];

  ef.question_types = questionTypes;
  ef.format_question_counts = COUNTS;
  ef.total_questions = TOTAL;
  ef.time_minutes = 540; // three 3-hour sessions over a day and a half

  console.log(`${course.name}`);
  console.log(`  total_questions: ${(course.exam_format as Record<string, unknown>).total_questions} -> ${TOTAL}`);
  console.log(`  format counts  : ${JSON.stringify(COUNTS)}`);
  for (const t of questionTypes) {
    const ipu = t.items_per_unit_min ? `${t.items_per_unit_min}..${t.items_per_unit_max}` : '1';
    console.log(`     ${String(t.slug).padEnd(18)}${String(COUNTS[t.slug as keyof typeof COUNTS]).padStart(4)}  opts=${t.num_options ?? '-'}  components=${ipu}`);
  }

  if (!APPLY) {
    console.log('\nDry run — nothing written. Re-run with --apply.');
    return;
  }
  const { error: upErr } = await supabase.from('qb_courses').update({ exam_format: ef }).eq('id', COURSE);
  if (upErr) throw new Error(upErr.message);
  console.log('\nApplied. Next: regenerate the guidelines, then top up the job.');
}

main().catch((e) => { console.error(e); process.exit(1); });
