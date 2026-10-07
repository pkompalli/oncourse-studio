/**
 * Give the three USMLE Step courses generation_guidelines, which they never had — so validation
 * checked Step items against the exam pattern alone, with no course rules at all.
 *
 * Each Step's guidelines are generated the way the app does it (generateGuidelines from the
 * course's own structure and exam_format), then the rules learned from reviewing 180 exported
 * bank questions are merged in. Those rules are USMLE data, so they live here in the course
 * row and not in the shared validator prompt. What the review kept finding:
 *   - recall one-liners and image-only fragments ("ECG shows:") instead of vignettes
 *   - explanations that defend the key but never say why each distractor is wrong
 *   - explanations citing the wrong option letter (letters do not survive a shuffle)
 *   - stems missing the one fact that decides between two options (stability, timing, INR)
 *   - stems that state what the image is supposed to show, giving the answer away
 *   - provenance tags from other exams in the stem ("(AIIMS May 2018)")
 *   - topics outside the Step's content outline
 *   - keyed options that stand out by length (uniquely longest in 28% of the bank, 20% by chance)
 *
 * Since 2026-10-07 content quality outranks continuity with recorded answers: five options are
 * required and options may change (reviewMode.ts restructure), so the rules no longer protect an
 * item's existing options. Each Step also carries its own NBME vignette shape (VIGNETTE).
 *
 *   npx tsx src/scripts/setUsmleGuidelines.ts            # generate + merge, save for review
 *   npx tsx src/scripts/setUsmleGuidelines.ts --apply    # snapshot rows, write the saved files
 */
import 'dotenv/config';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { supabase } from '../db/supabase.js';
import { generateGuidelines } from '../services/generation/guidelines.js';
import { scopeCourseToExam } from '../services/generation/examScope.js';

const APPLY = process.argv.includes('--apply');
const OUT = 'backups/usmle_guidelines';

const STEPS = [
  {
    id: 'f9d20070-4b7d-4248-b545-f6e774cd006f', step: 'step1',
    scope: 'Step 1 tests the basic-science mechanism behind a clinical presentation: pathophysiology, pharmacology (mechanism, adverse effects, interactions), microbiology, biochemistry, anatomy, physiology, immunology and behavioral science, each framed in a patient or experimental vignette. Management decisions are Step 2 CK material, not Step 1.',
  },
  {
    id: '2b2ab63c-5aa7-4c99-b2d5-e55642f9faac', step: 'step2',
    scope: 'Step 2 CK tests clinical decision-making for a supervised physician: most likely diagnosis, best next step in diagnosis, best next step in management, and prevention, across inpatient, outpatient and emergency settings. Rare curiosities with no bearing on diagnosis or management (e.g. heteropaternal superfecundation) are out of scope.',
  },
  {
    id: '90b430d9-d9c8-4758-b0d1-1f04ec0b06e7', step: 'step3',
    scope: 'Step 3 tests independent practice: management and its sequencing, prognosis, monitoring, patient safety and quality, ethics and law in practice, and applying biostatistics and evidence to a patient decision, mostly in ambulatory and inpatient settings.',
  },
] as const;

// ── Rules learned from the review, merged into every Step ──

const ANTI_PATTERNS = [
  'Recall or definition one-liners ("Which amino acid must be supplemented in…", "Which of the following is the combined first-trimester screen…") — every item is a clinical or experimental vignette ending in one focused lead-in.',
  'Image-only fragments ("A 68-year-old man presents with alcohol withdrawal. ECG shows:") with no clinical context around the image.',
  'A stem that names what the attached image is there to test ("ECG shows atrial fibrillation", or the full pattern "irregularly irregular rhythm with absent P waves" when the rhythm is the answer) — that gives the answer away. Ordinary clinical description alongside an image is fine.',
  'Provenance tags from other exams or sources in the stem or options ("(AIIMS May 2018)", "NEET PG 2019", "[Dr. X image-based questions]") — USMLE items carry no source.',
  'Explanations that refer to options by letter ("option C is wrong because…") — letters change whenever options are shuffled; refer to each option by its text.',
  'Converting an existing vignette into a recall question to shorten it, or stripping clinical detail that a Step item would carry.',
  'A keyed option that is longer, more qualified or more precisely worded than the distractors — in the live bank the key was the uniquely longest option in 28% of items, against 20% by chance.',
  'Options of different kinds in one item (a diagnosis beside a test beside a drug), or "all/none of the above".',
];

const DISTRACTOR_RULES = [
  'All options are the same kind of thing (all diagnoses, all next steps, all mechanisms, all drugs) and of similar length and specificity, so none is cued by form.',
  'Every distractor is a plausible choice for an examinee with a specific, nameable misconception, and is clearly wrong for a reason stated in the vignette.',
];

const VALIDATION_CHECKS = [
  'Stem is a vignette: age and sex, setting, presenting complaint with time course, relevant history, examination, and laboratory or imaging results where they bear on the answer; it ends with one focused lead-in such as "Which of the following is the most likely diagnosis?" or "Which of the following is the most appropriate next step in management?".',
  'The vignette contains every fact needed to choose ONE best answer and to rule out the strongest distractor (e.g. hemodynamic stability, timing from onset, pregnancy status, INR, prior treatment). Name the missing decisive fact when there is one.',
  'If an image is attached, the stem and image agree, and the stem does not name the answer the image is there to test.',
  'If no image is attached, the stem does not refer to one; if an image is attached, answering actually depends on it.',
  'The explanation justifies the keyed answer and gives a specific reason each other option is wrong, naming each option by its text, never by letter.',
  'The keyed answer reflects current US practice (e.g. ACC/AHA, USPSTF, IDSA, ACOG, AAP, ATLS); flag management that is outdated or non-US.',
  'The tested topic belongs to this Step\'s content outline (see coverage rules).',
];

// Content quality outranks continuity with recorded answers (2026-10-07): every item is brought to
// the exam's form, and an item whose options change is re-released as a new version.
const CONTENT_RULES = [
  'Exactly five options, labelled A–E, with one best answer. An item with fewer or more is brought to five.',
  'Nothing cues the key: it is not the longest or most qualified option, it does not alone repeat a distinctive word from the stem, it matches the lead-in grammatically exactly as every other option does, absolute terms (always, never, only) do not appear only in distractors, and no option is "all of the above" or "none of the above".',
  'Answer positions are balanced across the bank after review (each letter about 20%, never twice running), so explanations name options by text and never by letter.',
  'Change which option is correct ONLY when the keyed answer is factually wrong; state the evidence, and expect the change to go to clinician review.',
];

// The NBME vignette shape for each Step, read by the validator (validation_checks lead the list)
// and by generation (stem_guidelines.style).
const VIGNETTE: Record<string, string> = {
  step1: 'Step 1 vignette: a patient (or, less often, an experimental) scenario of about 80–180 words — age and sex, presentation with its time course, the focused history and examination, and the laboratory, histology or imaging findings the mechanism turns on — ending in one closed lead-in about the underlying mechanism, pathophysiology, structure, organism, gene, enzyme or drug action (e.g. "Which of the following is the most likely mechanism of this patient\'s condition?").',
  step2: 'Step 2 CK vignette: a patient encounter of about 100–250 words in NBME order — age and sex, setting (emergency department, clinic, hospital), chief complaint with duration, history of present illness, relevant past history, medications, social and family history where they matter, vital signs (temperature, pulse, respirations, blood pressure, and oxygen saturation where relevant), examination, then laboratory or imaging results — ending in one closed lead-in: most likely diagnosis, most appropriate next step in diagnosis or management, best initial or most accurate test, most appropriate pharmacotherapy, or most likely cause or complication.',
  step3: 'Step 3 vignette: a patient encounter of about 100–250 words in NBME order with the care setting stated (office, emergency department, inpatient unit, follow-up visit) — age and sex, chief complaint with duration, history, medications, vital signs, examination, and the results the decision needs — ending in one closed lead-in on independent management: next step, long-term management, screening or prevention, prognosis, patient safety, communication and ethics, or applying a study result to this patient.',
};

// Read by the validator's scope check (validator.ts, check 14). The live USMLE bank was assembled
// partly from Indian sources, and an item on India's MTP Act cannot be repaired into a USMLE item —
// it is a NEET PG item, so it is tagged and moved rather than rewritten.
const OTHER_EXAM_RULE = 'Items that belong to NEET PG rather than USMLE: Indian law and regulation (e.g. the MTP Act, PCPNDT Act, Indian drug schedules), Indian national health programmes (e.g. NTEP/RNTCP, NVBDCP, Pulse Polio, the Universal Immunization Programme schedule), India-specific epidemiology or practice standards, and items whose answer depends on Indian context. Report these as belonging to "NEET PG". An item that merely carries an Indian exam source tag (AIIMS, NEET PG, INI-CET, FMGE, PGI) but tests standard international medicine is NOT out of scope: give it normal feedback, including removing the tag.';

const ANSWER_KEY_BALANCE = 'Across the full bank each letter keys about 20% of items and never more than 30%, and no more than 4 consecutive items share a key. Balance is set after review by reordering each item\'s options (keyBalance.ts) — never by changing which option is correct.';

const uniq = (xs: unknown[]) => [...new Set(xs.filter((x): x is string => typeof x === 'string' && x.trim().length > 0))];

function merge(g: Record<string, unknown>, scope: string, step: string): Record<string, unknown> {
  const out = structuredClone(g);
  // Learned rules go FIRST in every list: the validator keeps only the first 20 of each guideline
  // list and the first 60 per-format rules, and appended rules were being cut.
  out.anti_patterns = uniq([...ANTI_PATTERNS, ...((out.anti_patterns as unknown[]) || [])]);
  out.coverage_rules = uniq([OTHER_EXAM_RULE, scope, ...((out.coverage_rules as unknown[]) || [])]);
  out.answer_key_balance = ANSWER_KEY_BALANCE;

  const dg = (out.distractor_guidelines ??= {}) as Record<string, unknown>;
  dg.quality_rules = uniq([...DISTRACTOR_RULES, ...((dg.quality_rules as unknown[]) || [])]);
  const eg = (out.explanation_guidelines ??= {}) as Record<string, unknown>;
  eg.required = true; eg.must_justify_correct = true; eg.must_address_distractors = true;
  const sg = (out.stem_guidelines ??= {}) as Record<string, unknown>;
  sg.vignette_required = true;
  sg.style = VIGNETTE[step];

  const specs = (out.format_specs ??= {}) as Record<string, Record<string, unknown>>;
  const mcq = (specs.mcq_single ??= {});
  // validation_checks is merged first of the per-format families, so the exam-form rules (vignette
  // shape, five options, no cue) go at its head, inside the validator's 60-rule cap.
  mcq.validation_checks = uniq([VIGNETTE[step], ...CONTENT_RULES, ...VALIDATION_CHECKS, ...((mcq.validation_checks as unknown[]) || [])]);
  return out;
}

/**
 * The generator writes output-format rules into the lists the validator reads: "Verify format_type
 * equals 'mcq_single'", "is_image_question must be a Boolean", "subject, topic and chapter must form
 * a valid hierarchy". They describe the generator's JSON, which content_schema already enforces, not
 * the item a candidate reads. Sonnet passed over them; GPT 6.1 Sol applied them to every stored item
 * and asked for the fields 177 times in one 60-item pilot. Rules that check only stored fields go.
 */
const STORED_FIELD_RULE_RE = /\b(format_type|is_image_question|image_type|image_search_terms|correct_answer field|required (top-level )?fields|top-level fields)\b|\bsubject, topic,? and chapter\b|\btopic and chapter must\b|\bsubject must (exactly )?match\b|\bcourse structure\b/i;
function dropStoredFieldRules(g: Record<string, unknown>): number {
  const mcq = ((g.format_specs as Record<string, Record<string, unknown>>) || {}).mcq_single;
  if (!mcq) return 0;
  let dropped = 0;
  for (const k of ['validation_checks', 'structure_requirements', 'syntax_rules', 'content_rules']) {
    const list = Array.isArray(mcq[k]) ? (mcq[k] as string[]) : [];
    const kept = list.filter((r) => !STORED_FIELD_RULE_RE.test(r));
    dropped += list.length - kept.length;
    mcq[k] = kept;
  }
  return dropped;
}


mkdirSync(OUT, { recursive: true });
const { data: courses, error } = await supabase.from('qb_courses').select('*').in('id', STEPS.map((s) => s.id));
if (error) throw new Error(error.message);

if (APPLY) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  writeFileSync(`backups/qb_courses_usmle_pre_guidelines_${stamp}.json`, JSON.stringify(courses, null, 1));
  for (const s of STEPS) {
    const file = `${OUT}/${s.step}.json`;
    if (!existsSync(file)) throw new Error(`${file} missing — run without --apply first and review it`);
    const g = JSON.parse(readFileSync(file, 'utf8'));
    const { error: upErr } = await supabase.from('qb_courses').update({ generation_guidelines: g }).eq('id', s.id);
    if (upErr) throw new Error(upErr.message);
    console.log(`  wrote ${s.step} guidelines to ${s.id}`);
  }
  console.log(`snapshot: backups/qb_courses_usmle_pre_guidelines_${stamp}.json`);
} else {
  await Promise.all(STEPS.map(async (s) => {
    const course = courses!.find((c) => c.id === s.id)!;
    const { courseName, structure } = scopeCourseToExam(course);
    // Generation is the only costly part; merging is re-run from the saved output unless asked.
    const genFile = `${OUT}/${s.step}.generated.json`;
    let generated: Record<string, unknown>;
    if (existsSync(genFile) && !process.argv.includes('--regenerate')) {
      generated = JSON.parse(readFileSync(genFile, 'utf8'));
    } else {
      console.log(`  [${s.step}] generating guidelines for ${courseName}…`);
      generated = await generateGuidelines(courseName, structure, (course.exam_format || {}) as Record<string, unknown>);
      writeFileSync(genFile, JSON.stringify(generated, null, 2));
    }
    const merged = merge(generated, s.scope, s.step);
    console.log(`  [${s.step}] stored-field rules dropped: ${dropStoredFieldRules(merged)}`);
    const opt = ((((merged.format_specs as any)?.mcq_single?.content_schema?.properties?.options) || {}) as Record<string, unknown>);
    writeFileSync(`${OUT}/${s.step}.json`, JSON.stringify(merged, null, 2));
    console.log(`  [${s.step}] keys: ${Object.keys(merged).join(', ')}`);
    console.log(`  [${s.step}] option schema: minItems ${opt.minItems} maxItems ${opt.maxItems}`);
  }));
  console.log(`dry run: review ${OUT}/*.json, then rerun with --apply`);
}
