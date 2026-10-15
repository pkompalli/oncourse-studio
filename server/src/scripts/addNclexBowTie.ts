/**
 * Add the Next Generation NCLEX bow-tie format to the NCLEX RN course: its share of the exam format
 * and the generation guidelines, and its format spec (structure, syntax, content and validation rules).
 * 4 of 135 items (about 3%), taken from single-answer MCQ. Snapshots the course row first; a second run
 * changes nothing.
 *
 *   npx tsx src/scripts/addNclexBowTie.ts            # dry run
 *   npx tsx src/scripts/addNclexBowTie.ts --apply
 */
import 'dotenv/config';
import { writeFileSync } from 'node:fs';
import { supabase } from '../db/supabase.js';

const ID = '5e3d672a-5539-4416-8bf5-1a66e8eaf414';
const APPLY = process.argv.includes('--apply');

const SPEC = {
  // Where generation may place bow-tie slots (questionGeneration.ts subjectBoundFormats).
  // At least one in any set of 15 or more questions that includes one of these subjects.
  min_per_set: { count: 1, from_questions: 15 },
  subjects: ['Medical-Surgical Nursing', 'Critical Care & Emergency Nursing', 'Pediatric Nursing', "Maternal-Newborn & Women's Health Nursing", 'Gerontological Nursing', 'Applied Pharmacology by System'],
  when_to_use: "A stand-alone item testing several clinical-judgment steps at once (recognise cues, analyse cues and prioritise hypotheses, take action, evaluate outcomes) for a client with one acute or evolving condition. Best fit: Medical-Surgical, Critical Care & Emergency, Maternal-Newborn & Women's Health, Pediatric, Gerontological and Applied Pharmacology by System. Not for recall, milestones, delegation or legal rules.",
  gradability: 'answer.condition is exactly one key of condition_options; answer.actions is exactly 2 distinct keys of action_options; answer.parameters is exactly 2 distinct keys of parameter_options. Scoring 0/1: one point per correct selection, 5 points.',
  structure_requirements: [
    'stem: a client scenario of 80-200 words with age, setting, history, current findings, vital signs and relevant results, ending with the standard instruction to complete the diagram.',
    'condition_options: exactly 4 conditions; action_options: exactly 5 nursing actions; parameter_options: exactly 5 parameters to monitor; each option {key, text} with keys C1-C4, A1-A5, P1-P5.',
    'answer: { condition, actions[2], parameters[2] }; explanation covering every option.',
  ],
  syntax_rules: [
    "Use the NCSBN instruction: \"Complete the diagram by selecting from the choices below to specify the condition the client is most likely experiencing, 2 actions the nurse should take to address that condition, and 2 parameters the nurse should monitor to assess the client's progress.\"",
    'Options within a group are the same kind of thing, in parallel grammar and similar length; no option is the only one with detail, numbers or a second clause.',
    'The stem never names the condition, nor uses the wording of a condition option.',
  ],
  content_rules: [
    'Exactly one condition is supported by the cues; the other three are conditions the same presentation could plausibly suggest (a near differential), each excluded by a specific cue in the stem.',
    'The 2 keyed actions are the highest-priority nursing actions for the keyed condition under current US practice; distractor actions are correct for a neighbouring condition, lower priority, or harmful here.',
    'The 2 keyed parameters are the ones that show the keyed condition improving or worsening; distractor parameters belong to another condition or do not change with this one.',
    'Vary which keys are correct across items; do not always key C1 or A1/A2.',
    'Every finding the explanation relies on is in the stem.',
    'The stem does not list prescriptions, orders, standing protocols or a care plan that name the correct actions; the candidate infers the actions from the condition.',
    'Each item in a set keys a different condition.',
  ],
  validation_checks: [
    'bow_tie: 4 conditions, 5 actions, 5 parameters; 1 keyed condition, 2 keyed actions, 2 keyed parameters, all keys present in their groups.',
    'bow_tie: the cues support exactly one condition; each other condition is excluded by a stated cue.',
    'bow_tie: the keyed actions and parameters follow from the keyed condition and are the highest priority; every distractor is plausible.',
    'bow_tie: no option cues the key by form; the stem does not name the condition.',
  ],
};

const { data: c, error } = await supabase.from('qb_courses').select('id, name, exam_format, generation_guidelines').eq('id', ID).single();
if (error || !c) throw new Error(error?.message || 'course not found');
const ef = c.exam_format as Record<string, any>;
const g = c.generation_guidelines as Record<string, any>;
if (g.format_specs?.bow_tie) {
  // Already added: refresh the spec's rules only (the share of the exam is left as it is).
  if (JSON.stringify(g.format_specs.bow_tie) === JSON.stringify(SPEC)) { console.log(`${c.name} bow_tie spec is current — nothing to do`); process.exit(0); }
  if (!APPLY) { console.log('bow_tie spec differs — rerun with --apply to refresh it'); process.exit(0); }
  writeFileSync(`backups/qb_courses_nclex_rn_pre_bowtie_spec_${new Date().toISOString().replace(/[:.]/g, '-')}.json`, JSON.stringify(c, null, 2));
  const { error: e2 } = await supabase.from('qb_courses').update({ generation_guidelines: { ...g, format_specs: { ...g.format_specs, bow_tie: SPEC } } }).eq('id', ID);
  if (e2) throw new Error(e2.message);
  console.log(`refreshed the ${c.name} bow_tie spec`);
  process.exit(0);
}

ef.question_types = (ef.question_types as any[]).map((t) => (t.slug === 'mcq_single' ? { ...t, percentage: 45 } : t));
ef.question_types.push({
  name: 'Bow-Tie (Next Generation NCLEX)', slug: 'bow_tie', percentage: 3,
  description: 'A stand-alone NGN item. A client scenario supplies the cues; the candidate completes a bow-tie diagram: the condition the client is most likely experiencing (1 of 4) in the centre, actions to take (2 of 5) on the left, parameters to monitor (2 of 5) on the right. Scored 0/1 per correct selection (5 points).',
  answer_format: 'condition key + 2 action keys + 2 parameter keys',
});
ef.format_question_counts = { ...ef.format_question_counts, mcq_single: 81, bow_tie: 4 };

g.format_distribution = (g.format_distribution as any[]).map((f) => (f.format === 'mcq_single' ? { ...f, count: 81, percentage: 60 } : f));
g.format_distribution.push({
  count: 4, format: 'bow_tie', percentage: 3,
  description: 'Use for a client with an acute or evolving condition the cues point to, where the decision is recognising the condition, the two highest-priority actions and the two parameters that show whether it is improving: medical-surgical, critical care and emergency, maternal-newborn, pediatric, gerontological and pharmacology-by-system scenarios.',
});
g.format_specs = { ...g.format_specs, bow_tie: SPEC };

console.log(`exam format: ${ef.question_types.map((t: any) => `${t.slug} ${t.percentage}%`).join(', ')}`);
console.log(`guidelines: ${g.format_distribution.map((f: any) => `${f.format} ${f.count}`).join(', ')}`);
if (!APPLY) { console.log('dry run — rerun with --apply'); process.exit(0); }
const snap = `backups/qb_courses_nclex_rn_pre_bowtie_${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
writeFileSync(snap, JSON.stringify(c, null, 2));
const { error: upErr } = await supabase.from('qb_courses').update({ exam_format: ef, generation_guidelines: g }).eq('id', ID);
if (upErr) throw new Error(upErr.message);
console.log(`updated ${c.name}; snapshot ${snap}`);
