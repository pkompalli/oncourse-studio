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
 *   - requests to "reduce to 5 options", which on a live item deletes an answered option
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

const CONTENT_RULES = [
  'Option count is not a defect: Step items have 4 to 9 options. Never ask to add or remove options from an existing item — an answered option that disappears breaks every recorded response to it.',
  'Never ask for options to be reordered or relettered; answer-key balance is achieved at generation or by shuffling at delivery.',
  'Change which option is correct ONLY when the keyed answer is factually wrong; state the evidence, and expect the change to go to clinician review.',
];

// Read by the validator's scope check (validator.ts, check 14). The live USMLE bank was assembled
// partly from Indian sources, and an item on India's MTP Act cannot be repaired into a USMLE item —
// it is a NEET PG item, so it is tagged and moved rather than rewritten.
const OTHER_EXAM_RULE = 'Items that belong to NEET PG rather than USMLE: Indian law and regulation (e.g. the MTP Act, PCPNDT Act, Indian drug schedules), Indian national health programmes (e.g. NTEP/RNTCP, NVBDCP, Pulse Polio, the Universal Immunization Programme schedule), India-specific epidemiology or practice standards, and items whose answer depends on Indian context. Report these as belonging to "NEET PG". An item that merely carries an Indian exam source tag (AIIMS, NEET PG, INI-CET, FMGE, PGI) but tests standard international medicine is NOT out of scope: give it normal feedback, including removing the tag.';

const ANSWER_KEY_BALANCE = 'Across the full bank, no single letter should key more than 30% of items, and no more than 4 consecutive items should share a key. Balance is achieved when items are generated or by shuffling option order at delivery — never by changing which option is correct, and never by reordering the options of an existing item.';

const uniq = (xs: unknown[]) => [...new Set(xs.filter((x): x is string => typeof x === 'string' && x.trim().length > 0))];

function merge(g: Record<string, unknown>, scope: string): Record<string, unknown> {
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

  const specs = (out.format_specs ??= {}) as Record<string, Record<string, unknown>>;
  const mcq = (specs.mcq_single ??= {});
  // validation_checks is merged first of the per-format families, so the rules that protect an
  // item already in use (option count, order, key) go at its head.
  mcq.validation_checks = uniq([...CONTENT_RULES, OPTION_COUNT_RULE, ...VALIDATION_CHECKS, ...((mcq.validation_checks as unknown[]) || [])]);
  return out;
}

/**
 * The generator writes "exactly five options, A through E" into every rule list the validator
 * reads. Five is the right target for a NEW item, but on an existing one each of those rules is a
 * request to delete or invent an answered option. Rules that only pin the count go; rules that
 * mention it in passing are reworded; one rule states both cases.
 */
const COUNT_ONLY_RE = /^(verify (there are|options (is|contains)( an array of)?) exactly (five|5)\b[^.]*\.?|never use more or fewer than five options\.?|use exactly five options labeled a, b, c, d, and e in that order\.?|options must (contain|be an array of) exactly five[^.]*\.?|the options array must contain exactly five[^.]*\.?)$/i;
const OPTION_COUNT_RULE = 'Write NEW items with five options labeled A–E. An existing item with four to nine options is valid as it stands: never add or remove its options.';

function relaxOptionCount(g: Record<string, unknown>): number {
  let touched = 0;
  const reword = (s: string) => s
    .replace(/\b(separately )?address(es)? (options )?A ?(through|-|–) ?E\b/gi, (_m, sep) => `${sep ?? ''}addresses every option`)
    .replace(/\bexactly (five|5)( uniquely labeled| labeled)? (options|choices|strings|nonempty strings|unique strings)/gi, 'five (four to nine on an existing item) $3')
    .replace(/\bfive-element options array\b/gi, 'options array')
    .replace(/\bone uppercase (option )?letter from A through E\b/gi, 'one uppercase letter naming an existing option')
    .replace(/\bexactly one of "A", "B", "C", "D", or "E"/g, 'exactly one existing option letter')
    .replace(/\ball five (options?|option texts)\b/gi, 'all $1')
    .replace(/\bin all five options\b/gi, 'in every option')
    .replace(/\bfive-option /gi, '');
  const fixList = (xs: unknown): string[] => {
    const out: string[] = [];
    for (const x of (Array.isArray(xs) ? xs : [])) {
      if (typeof x !== 'string') continue;
      if (COUNT_ONLY_RE.test(x.trim())) { touched++; continue; }
      const y = reword(x); if (y !== x) touched++; out.push(y);
    }
    return out;
  };
  const mcq = ((g.format_specs as Record<string, Record<string, unknown>>) || {}).mcq_single;
  if (mcq) {
    for (const k of ['validation_checks', 'structure_requirements', 'syntax_rules', 'content_rules']) mcq[k] = fixList(mcq[k]);
    if (typeof mcq.gradability === 'string') { const y = reword(mcq.gradability); if (y !== mcq.gradability) touched++; mcq.gradability = y; }
  }
  g.anti_patterns = fixList(g.anti_patterns);
  g.coverage_rules = fixList(g.coverage_rules);
  const dg = g.distractor_guidelines as Record<string, unknown> | undefined;
  if (dg) {
    dg.quality_rules = fixList(dg.quality_rules);
    if (typeof dg.homogeneity === 'string') { const y = reword(dg.homogeneity); if (y !== dg.homogeneity) touched++; dg.homogeneity = y; }
  }
  return touched;
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

/** Where the generated schema pins options to exactly num_options, widen it to 4–9 (see CONTENT_RULES). */
function widenOptionCount(g: Record<string, unknown>): string[] {
  const notes: string[] = [];
  const walk = (node: unknown, path: string) => {
    if (!node || typeof node !== 'object') return;
    const n = node as Record<string, unknown>;
    if (/options$/.test(path) && n.type === 'array') {
      if (n.minItems !== undefined || n.maxItems !== undefined) notes.push(`${path}: minItems ${n.minItems} maxItems ${n.maxItems} → 4/9`);
      n.minItems = 4; n.maxItems = 9;
    }
    for (const [k, v] of Object.entries(n)) walk(v, `${path}.${k}`);
  };
  const specs = (g.format_specs || {}) as Record<string, Record<string, unknown>>;
  if (specs.mcq_single?.content_schema) walk(specs.mcq_single.content_schema, 'mcq_single.content_schema');
  const sp = specs.mcq_single?.schema_params as Record<string, unknown> | undefined;
  if (sp && sp.num_options !== undefined) notes.push(`schema_params.num_options ${sp.num_options} kept as the generation target`);
  return notes;
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
    const merged = merge(generated, s.scope);
    console.log(`  [${s.step}] option-count rules relaxed: ${relaxOptionCount(merged)}`);
    console.log(`  [${s.step}] stored-field rules dropped: ${dropStoredFieldRules(merged)}`);
    const notes = widenOptionCount(merged);
    writeFileSync(`${OUT}/${s.step}.json`, JSON.stringify(merged, null, 2));
    console.log(`  [${s.step}] keys: ${Object.keys(merged).join(', ')}`);
    console.log(`  [${s.step}] formats: ${Object.keys((merged.format_specs as object) || {}).join(', ')} | option schema: ${notes.join('; ') || 'no option bounds'}`);
  }));
  console.log(`dry run: review ${OUT}/*.json, then rerun with --apply`);
}
