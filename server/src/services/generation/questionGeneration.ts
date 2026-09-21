import { orCall, MODELS } from '../llm/openrouter.js';
import { supabase } from '../../db/supabase.js';
import { fetchAllRows } from '../../db/pagination.js';
import { startTracking, getStepTokens } from '../llm/tokenTracker.js';
import { classifyQuestionType } from '../questionType.js';
import { schemaErrorsFor } from './schemaValidate.js';
import { canonicalizeFormatSlug } from './formatContracts.js';
import { processAllImageQuestions, isImageGenerationAvailable } from '../images/imageGeneration.js';

/**
 * Faithful port of V1's generation pipeline:
 * - build_subject_tasks() (app.py 843-928)
 * - generate_subject_profile() (app.py 787-840)
 * - _build_professor_prompt() (app.py 1145-1300)
 * - professor_generate_questions() (app.py 1305-1446)
 * - generate_subject_paper() (app.py 1449-1466)
 */

const PROFESSOR_BATCH_SIZE = 6;

// ── Subject Profile Generation (V1 lines 787-840) ──

async function generateSubjectProfile(
  subjectName: string,
  courseName: string,
  hytTopics: string[],
  examPattern?: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const topicsStr = hytTopics.length > 0 ? hytTopics.slice(0, 20).join(', ') : subjectName;

  // Build exam-specific context from the pattern profile
  let examContext = '';
  if (examPattern && Object.keys(examPattern).length > 0) {
    const philosophy = (examPattern.testing_philosophy as string) || '';
    const stemStyle = examPattern.stem_style as Record<string, unknown> | undefined;
    const distinctive = (examPattern.distinctive_patterns as string[]) || [];
    const antiPatterns = (examPattern.what_NOT_to_do as string[]) || [];
    const recallRatio = examPattern.recall_vs_reasoning_ratio as Record<string, unknown> | undefined;

    examContext = `\nEXAM-SPECIFIC CONTEXT FOR ${courseName}:
Testing philosophy: ${philosophy}
Stem format: ${stemStyle?.typical_format || 'standard MCQ'}
What stems test: ${stemStyle?.what_the_stem_tests || ''}
Recall vs reasoning: ${recallRatio?.description || ''}
Distinctive patterns:
${distinctive.slice(0, 5).map((p) => `  • ${p}`).join('\n')}
What NOT to do for this exam:
${antiPatterns.slice(0, 3).map((p) => `  • ${p}`).join('\n')}

Your subject profile MUST align with these exam-specific patterns. For example:
- If the exam is recall-heavy, your question_style should emphasise direct factual testing
- If the exam uses long vignettes, your question_style should describe scenario/stimulus construction appropriate to the exam
- Distractor archetypes must match how THIS exam designs wrong options\n`;
  }

  const prompt = `You are an expert curriculum designer for ${courseName} examinations.
${examContext}
Generate a subject-specific examiner profile for: ${subjectName}
This profile must reflect how ${subjectName} is ACTUALLY tested in ${courseName} — not generic MCQ advice.

High-yield topics: ${topicsStr}

Return ONLY a JSON object with these exact keys:

{
  "question_style": "<2-3 sentences: how ${subjectName} questions work SPECIFICALLY in ${courseName} — what format, what depth, what the stem looks like, what makes distractors hard>",
  "image_types": [
    "<modality 1 specific to ${subjectName} in ${courseName} — e.g. 'PA chest X-ray' not just 'X-ray'>",
    "<modality 2>",
    "<modality 3>",
    "<modality 4>",
    "<modality 5>"
  ],
  "image_question_focus": "<what students must identify from images in ${subjectName} in ${courseName}>",
  "distractor_archetypes": [
    "<archetype 1: a category of plausible wrong answer typical in ${courseName} for ${subjectName}>",
    "<archetype 2>",
    "<archetype 3>",
    "<archetype 4>"
  ],
  "bloom_guidance": "<1-2 sentences: which Bloom's levels dominate for ${subjectName} in ${courseName} and why>",
  "special_instructions": "<2-3 subject-specific rules aligned with ${courseName} patterns — e.g. what facts/classifications/systems are commonly tested>"
}`;

  try {
    const response = await orCall(MODELS.GENERATOR, '', prompt, { maxTokens: 1500, temperature: 0.2 });
    let raw = response.content;
    if (raw.includes('```json')) raw = raw.split('```json')[1].split('```')[0];
    else if (raw.includes('```')) raw = raw.split('```')[1].split('```')[0];
    const profile = JSON.parse(raw.trim());
    if (typeof profile !== 'object' || Array.isArray(profile)) throw new Error('non-dict');
    return profile;
  } catch {
    return {
      question_style: `Questions specific to ${subjectName} as tested in ${courseName}.`,
      image_types: [`${subjectName} diagram`, `${subjectName} figure`, 'chart', 'table', 'illustration'],
      image_question_focus: `Interpreting the key information shown for ${subjectName}`,
      distractor_archetypes: ['closely related concept', 'correct concept applied incorrectly', 'partial knowledge trap', 'common misconception'],
      bloom_guidance: 'Distribution follows the typical pattern for this exam.',
      special_instructions: `Use current standard guidelines relevant to ${courseName}. Test high-yield concepts in ${subjectName}.`,
    };
  }
}

// ── Build Subject Tasks (V1 lines 843-928) ──

interface QuestionTypeAllocation {
  slug: string;
  name: string;
  count: number;
  percentage: number;
  description?: string;
  answer_format?: string;
  num_options?: number;
}

interface SubjectTask {
  subject: string;
  num_questions: number;
  num_image_qs: number;
  bloom_counts: Record<string, number>;
  hyt_topics: string[];
  exam_params: { style: string; num_options: number; marking: string };
  exam_pattern?: Record<string, unknown>;
  subject_profile?: Record<string, unknown>;
  existing_stems_by_topic?: Map<string, string[]>;
  question_type_allocations?: QuestionTypeAllocation[];
  guidelines?: Record<string, unknown>;
  _batch?: string;
}

// ── Distribute question types across a subject ──

function allocateQuestionTypes(
  numQ: number,
  examFormat: Record<string, unknown>
): QuestionTypeAllocation[] {
  const questionTypes = (examFormat.question_types as Array<{ slug: string; name: string; percentage: number; description?: string; answer_format?: string; num_options?: number }>) || [];

  // If no question_types or only one, default to primary format
  if (questionTypes.length <= 1) {
    const qf = (examFormat.question_format as Record<string, unknown>) || {};
    const slug = (qf.type as string) || 'mcq_single';
    const name = (qf.primary_format_name as string) || 'Single Best Answer MCQ';
    return [{ slug, name, count: numQ, percentage: 100, num_options: (qf.num_options as number) || 4 }];
  }

  // Distribute proportionally, ensuring at least 1 for each type with >= 5% allocation
  const allocations: QuestionTypeAllocation[] = [];
  let remaining = numQ;

  // Sort by percentage descending — primary type gets remainder
  const sorted = [...questionTypes].sort((a, b) => b.percentage - a.percentage);

  for (let i = 0; i < sorted.length; i++) {
    const qt = sorted[i];
    if (i === sorted.length - 1) {
      // Last type gets remainder
      if (remaining > 0) {
        allocations.push({ slug: qt.slug, name: qt.name, count: remaining, percentage: qt.percentage, description: qt.description, answer_format: qt.answer_format, num_options: qt.num_options });
      }
    } else {
      const count = Math.max(qt.percentage >= 5 ? 1 : 0, Math.round(numQ * qt.percentage / 100));
      if (count > 0) {
        allocations.push({ slug: qt.slug, name: qt.name, count: Math.min(count, remaining), percentage: qt.percentage, description: qt.description, answer_format: qt.answer_format, num_options: qt.num_options });
        remaining -= Math.min(count, remaining);
      }
    }
  }

  return allocations.filter((a) => a.count > 0);
}

// Grouped/shared-stimulus formats and the analysis stimulus_type → format mapping.
const GROUPED_FORMATS = new Set(['passage_set', 'case_study', 'task_based_simulation', 'tbs']);
const STIMULUS_TO_FORMAT: Record<string, string> = {
  reading_passage: 'passage_set',
  case_scenario: 'case_study',
  exhibit_set: 'task_based_simulation',
  data_set: 'task_based_simulation',
};
const RC_SUBJECT_RX = /passage|reading|comprehension|\bmain point\b|author'?s?|inference|paragraph|\brc\b/i;
const normName = (s: unknown) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

// SUBJECT ROUTING: a grouped format (passage_set, case_study, TBS) belongs only to
// the SUBJECTS whose questions are actually delivered as that kind of group — not
// to every subject. If this subject is one of them (per the analysis's
// applies_to_subjects, with a name-based fallback for reading passages), allocate
// the grouped format for it as SETS (each set yields ~avg member questions), so a
// reading subject produces passage sets and a logical-reasoning subject does not.
function subjectAwareGroupedAllocation(subject: string, numQ: number, guidelines: Record<string, unknown>, examFormat: Record<string, unknown>): QuestionTypeAllocation[] | null {
  const groups = Array.isArray(examFormat?.question_groups) ? (examFormat.question_groups as Array<Record<string, unknown>>) : [];
  if (groups.length === 0) return null;
  const specs = guidelines?.format_specs as Record<string, Record<string, unknown>> | undefined;
  // Only honour a group whose mapped format this exam ACTUALLY declares — otherwise
  // e.g. an "exhibit_set" group would hijack subjects with task_based_simulation
  // even when the exam's real format is a performance_task.
  const declared = new Set(((guidelines?.format_distribution as Array<Record<string, unknown>>) || [])
    .map((f) => String(f.format || f.slug || '')));
  const ns = normName(subject);
  for (const g of groups) {
    const fmt = STIMULUS_TO_FORMAT[String(g.stimulus_type)];
    if (!fmt) continue;
    if (declared.size > 0 && !declared.has(fmt)) continue;
    const applies = Array.isArray(g.applies_to_subjects) ? (g.applies_to_subjects as unknown[]).map(normName) : [];
    const matches = applies.includes(ns) || (applies.length === 0 && g.stimulus_type === 'reading_passage' && RC_SUBJECT_RX.test(subject));
    if (!matches) continue;
    const mm = Array.isArray(g.members_per_group) ? (g.members_per_group as number[]) : [5, 8];
    const avg = Math.max(1, Math.round(((Number(mm[0]) || 5) + (Number(mm[1]) || 8)) / 2));
    const count = Math.max(1, Math.round(numQ / avg)); // each set yields ~avg gradable questions
    return [{ slug: fmt, name: (specs?.[fmt]?.label as string) || fmt, count, percentage: 100 }];
  }
  return null;
}

// Guidelines are authoritative on the format MIX (per the describe→derive→generate
// design): when generation_guidelines carry a format_distribution, derive the
// per-subject allocations from it. With excludeGrouped, grouped formats are dropped
// (they are routed per-subject by subjectAwareGroupedAllocation instead, so they
// never leak into non-grouped subjects). Falls back to null when no distribution.
function allocationsFromGuidelines(numQ: number, guidelines: Record<string, unknown>, opts?: { excludeFormats?: Set<string> }): QuestionTypeAllocation[] | null {
  const fd = guidelines?.format_distribution as Array<{ format?: string; slug?: string; percentage?: number; description?: string }> | undefined;
  if (!Array.isArray(fd) || fd.length === 0) return null;
  const specs = guidelines?.format_specs as Record<string, Record<string, unknown>> | undefined;
  const raw = fd
    .map((f) => ({ slug: String(f.format || f.slug || '').trim(), percentage: typeof f.percentage === 'number' ? f.percentage : 0, description: f.description }))
    .filter((f) => f.slug && !opts?.excludeFormats?.has(f.slug));
  if (raw.length === 0) return null;
  let total = raw.reduce((s, f) => s + f.percentage, 0);
  if (total <= 0) { raw.forEach((f) => (f.percentage = 100 / raw.length)); total = 100; }
  const sorted = [...raw].sort((a, b) => b.percentage - a.percentage);
  // percentage is a SCORED-WEIGHT share, so split the QUESTION budget by weight and
  // then convert each share into UNIT counts: one grouped unit (case study, passage
  // set) expands into several scored questions, so N% weight is N% of questions —
  // NOT N% of units. Without this a 33% set share would emit 33 sets (~200 questions).
  const itemsPerUnit = (slug: string): number => {
    const sp = specs?.[slug]?.schema_params as Record<string, unknown> | undefined;
    const mn = Number(sp?.sub_question_min) || 0;
    const mx = Number(sp?.sub_question_max) || 0;
    if (mn > 0 && mx > 0) return Math.max(1, Math.round((mn + mx) / 2));
    if (mn > 0) return Math.max(1, mn);
    return 1;
  };
  const out: QuestionTypeAllocation[] = [];
  let remainingQuestions = numQ;
  for (let i = 0; i < sorted.length; i++) {
    const f = sorted[i];
    const sp = specs?.[f.slug]?.schema_params as Record<string, unknown> | undefined;
    const name = (specs?.[f.slug]?.label as string) || f.slug;
    const ipu = itemsPerUnit(f.slug);
    const wantQuestions = i === sorted.length - 1
      ? remainingQuestions
      : Math.min(remainingQuestions, Math.round(numQ * f.percentage / total));
    const count = Math.max(f.percentage >= 5 ? 1 : 0, Math.round(wantQuestions / ipu));
    if (count > 0) {
      out.push({ slug: f.slug, name, count, percentage: Math.round(f.percentage), description: f.description, num_options: sp?.num_options as number | undefined });
      remainingQuestions -= Math.min(remainingQuestions, count * ipu);
    }
  }
  return out.filter((a) => a.count > 0);
}

export async function buildSubjectTasks(
  mockSpecs: Record<string, unknown>,
  courseStructure: Record<string, unknown>,
  examFormat: Record<string, unknown>,
  courseName: string
): Promise<SubjectTask[]> {
  // Extract exam pattern profile for threading into generation
  const examPattern = (examFormat.exam_pattern as Record<string, unknown>) || {};

  // Bloom's distribution: filter L2–L5, renormalize
  const bloomsRaw = (examFormat.blooms_distribution as Record<string, number>) || {};
  const l2to5: Record<string, number> = {};
  for (const [k, v] of Object.entries(bloomsRaw)) {
    if (['2', '3', '4', '5'].some((n) => k.startsWith(n))) {
      l2to5[k] = v;
    }
  }
  if (Object.keys(l2to5).length === 0) {
    Object.assign(l2to5, { '2_understand': 1, '3_apply': 1, '4_analyze': 1, '5_evaluate': 1 });
  }
  const totalBloom = Object.values(l2to5).reduce((a, b) => a + b, 0) || 1;
  const bloomRatios: Record<string, number> = {};
  for (const [k, v] of Object.entries(l2to5)) bloomRatios[k] = v / totalBloom;

  // HYT topic map
  const hytMap: Record<string, { name: string; topics: string[] }> = {};
  for (const subj of (courseStructure.subjects as Array<Record<string, unknown>>) || []) {
    const name = ((subj.name as string) || '').trim();
    const topics = (subj.topics as Array<Record<string, unknown>>) || [];
    let hyt = topics.filter((t) => t.high_yield || t.is_high_yield).map((t) => (t.name as string) || '');
    if (hyt.length === 0) hyt = topics.map((t) => (t.name as string) || '').filter(Boolean).slice(0, 15);
    hytMap[name.toLowerCase()] = { name, topics: hyt };
  }

  function findHyt(subjectName: string): string[] {
    const key = subjectName.trim().toLowerCase();
    if (hytMap[key]) return hytMap[key].topics;
    for (const [k, v] of Object.entries(hytMap)) {
      if (k.includes(key) || key.includes(k)) return v.topics;
    }
    return [];
  }

  const qf = (examFormat.question_format as Record<string, unknown>) || {};
  const examParams = {
    style: (qf.type as string) || 'single_best_answer',
    num_options: (qf.num_options as number) || (mockSpecs.num_options as number) || 4,
    marking: (examFormat.negative_marking as string) || (mockSpecs.negative_marking as string) || '',
  };

  const subjectDist = (mockSpecs.subject_distribution as Record<string, Record<string, number>>) || {};
  const tasks: SubjectTask[] = [];

  for (const [subjName, dist] of Object.entries(subjectDist)) {
    const numQ = Math.round(dist.questions || 0);
    if (numQ <= 0) continue;
    const imgPct = Math.round(dist.image_pct || 0);
    const numImageQ = Math.round(numQ * imgPct / 100);

    // Bloom counts: proportional from ratios
    const bloomCounts: Record<string, number> = {};
    let remainder = numQ;
    const sortedLevels = Object.entries(bloomRatios).sort((a, b) => b[1] - a[1]);
    for (let i = 0; i < sortedLevels.length; i++) {
      const [level, ratio] = sortedLevels[i];
      if (i === sortedLevels.length - 1) {
        bloomCounts[level] = Math.max(0, remainder);
      } else {
        const c = Math.round(numQ * ratio);
        bloomCounts[level] = c;
        remainder -= c;
      }
    }

    tasks.push({
      subject: subjName,
      num_questions: numQ,
      num_image_qs: numImageQ,
      bloom_counts: bloomCounts,
      hyt_topics: findHyt(subjName),
      exam_params: examParams,
      exam_pattern: examPattern,
      question_type_allocations: allocateQuestionTypes(numQ, examFormat),
    });
  }

  // Generate subject profiles in parallel (with exam pattern context)
  const profilePromises = tasks.map(async (task) => {
    const profile = await generateSubjectProfile(task.subject, courseName, task.hyt_topics, examPattern);
    task.subject_profile = profile;
  });
  await Promise.all(profilePromises);

  return tasks;
}

// ── Build format-specific JSON schema for the prompt ──

// Render a format's generation instructions FROM the guidelines' derived spec
// (the fully-generic path): the concrete output template + this exam's rules. This
// makes generation guidelines-driven, so a format defined only in the guidelines
// needs no hardcoded branch below.
const SUB_ANSWER_KEY_RULES = `PER-SUB-QUESTION ANSWER KEY (MANDATORY — a sub-answer that exists ONLY in the rationale/prose is INVALID and will be rejected):
  - mcq_single: options[] + correct_answer:"<letter>"
  - sata: options[] + correct_answers:["<letters>"]
  - matrix_grid: rows[] + columns[] + correct_answer:{ "<each row text>": "<chosen column text>" }
  - cloze_dropdown: [Blank N] markers + choices:{ "Blank N":[options] } + correct_answer:{ "Blank N":"<one of its choices>" }
  - fill_blank: correct_answer:"<exact value>"  ← NEVER omit this field
  - ordered_response: items[] + correct_order (1-based indices in the correct sequence)
  - constructed_response: prompt only (human-scored; no answer key)
Every sub-question MUST include the COMPLETE scaffolding its format needs (options/rows/columns/choices/items) AND its structured answer key.`;

function renderGuidelinesFormatBlock(alloc: QuestionTypeAllocation, spec: Record<string, unknown>): string {
  const list = (v: unknown) => (Array.isArray(v) ? (v as unknown[]).map(String) : v ? [String(v)] : []);
  const rules = [
    ...list(spec.syntax_rules).map((s) => `  • ${s}`),
    ...list(spec.structure_requirements).map((s) => `  • ${s}`),
    ...list(spec.content_rules).map((s) => `  • ${s}`),
  ];
  const grad = spec.gradability ? `GRADABILITY (mandatory): ${spec.gradability}` : '';
  const template = JSON.stringify(spec.generation_template, null, 2);
  // A guidelines-authored template may omit per-sub answer keys; the canonical
  // sub-answer contract is appended so grouped formats stay machine-gradable.
  const tmplHasSubs = /"sub_questions"/.test(template) || GROUPED_FORMATS.has(alloc.slug);
  const subRules = tmplHasSubs ? `\n${SUB_ANSWER_KEY_RULES}` : '';
  return `FORMAT: ${alloc.slug} (${alloc.name}) — ${alloc.count} question(s)
${rules.length ? 'RULES:\n' + rules.join('\n') + '\n' : ''}${grad ? grad + '\n' : ''}Output EACH question as a JSON object with EXACTLY this shape (fill with real content; keep all fields):
${template}${subRules}`;
}

function buildFormatSchema(allocations: QuestionTypeAllocation[], guidelines?: Record<string, unknown>): string {
  const specFor = (slug: string): Record<string, unknown> | undefined => {
    const specs = guidelines?.format_specs as Record<string, Record<string, unknown>> | undefined;
    const s = specs?.[slug];
    return s && s.generation_template ? s : undefined;
  };

  if (allocations.length === 1 && allocations[0].slug === 'mcq_single' && !specFor('mcq_single')) {
    // Pure MCQ — use the original compact schema
    const numOpts = allocations[0].num_options || 4;
    const optLetters = 'ABCDEFGH'.slice(0, numOpts).split('').map((l) => `"${l}. ..."`).join(', ');
    return `{
  "format_type":    "mcq_single",
  "passage":        "<REQUIRED whenever the stem refers to 'the passage', an excerpt, or any reading text the candidate must read — put the FULL passage text here; omit only for self-contained questions>",
  "question":       "<stem>",
  "options":        [${optLetters}],
  "correct_answer": "A",
  "explanation":    "<MUST: (1) justify why the correct answer is right, (2) explain why EACH distractor is wrong — 3-5 sentences>",
  "difficulty":     "<easy|medium|hard>",
  "bloom_level":    "<2_understand|3_apply|4_analyze|5_evaluate>",
  "is_image_question": <true|false>,
  "image_type":         "<modality string if image question, else null>",
  "image_search_terms": ["<3-5 specific search terms if image question, else empty array>"]
}
RULE: A question is only answerable if everything it references is present. If the stem mentions "the passage"/"the excerpt"/a reading text, the "passage" field is MANDATORY and must contain the full text the answer depends on — never reference a passage you don't include. Same for "shown above" figures: set is_image_question:true or describe the data inline.`;
  }

  // Multi-format — build schema descriptions for each type
  const schemas: string[] = [];

  for (const alloc of allocations) {
    // Guidelines-driven (generic) path: render from the derived spec when present.
    const gspec = specFor(alloc.slug);
    if (gspec) { schemas.push(renderGuidelinesFormatBlock(alloc, gspec)); continue; }

    // Fallback: hardcoded per-format template for formats the guidelines don't cover.
    let schema: string;
    switch (alloc.slug) {
      case 'mcq_single': {
        const numOpts = alloc.num_options || 4;
        const optLetters = 'ABCDEFGH'.slice(0, numOpts).split('').map((l) => `"${l}. ..."`).join(', ');
        schema = `FORMAT: mcq_single (${alloc.name}) — ${alloc.count} question(s)
{
  "format_type": "mcq_single",
  "passage": "<REQUIRED if the stem refers to 'the passage'/an excerpt/reading text — full text here; omit for self-contained questions>",
  "question": "<stem>",
  "options": [${optLetters}],
  "correct_answer": "<letter>",
  "explanation": "<MUST: (1) justify why the correct answer is right, (2) explain why EACH distractor is wrong — 3-5 sentences>",
  "difficulty": "<easy|medium|hard>",
  "bloom_level": "<2_understand|3_apply|4_analyze|5_evaluate>",
  "is_image_question": <true|false>,
  "image_type": "<if image, else null>",
  "image_search_terms": [<if image, else []>]
}
RULE: never reference a passage/excerpt/figure you don't include — a passage-based stem without its "passage" text is ungradable.`;
        break;
      }
      case 'sata':
      case 'mcq_multi':
        schema = `FORMAT: ${alloc.slug} (${alloc.name}) — ${alloc.count} question(s)
{
  "format_type": "${alloc.slug}",
  "passage": "<REQUIRED if the stem refers to 'the passage'/an excerpt/reading text — full text here; omit for self-contained questions>",
  "question": "<stem — must clearly state 'Select all that apply'>",
  "options": ["A. ...", "B. ...", "C. ...", "D. ...", "E. ...", "F. ..."],
  "correct_answers": ["A", "C", "E"],
  "explanation": "<MUST: (1) explain why each CORRECT option is right, (2) explain why each WRONG option is wrong — 3-5 sentences>",
  "difficulty": "<easy|medium|hard>",
  "bloom_level": "<2_understand|3_apply|4_analyze|5_evaluate>",
  "is_image_question": <true|false>,
  "image_type": "<if image, else null>",
  "image_search_terms": [<if image, else []>]
}`;
        break;
      case 'ordered_response':
      case 'drag_drop':
        schema = `FORMAT: ${alloc.slug} (${alloc.name}) — ${alloc.count} question(s)
{
  "format_type": "${alloc.slug}",
  "question": "<stem — describe scenario, ask to arrange in correct order>",
  "items": ["<step/item 1>", "<step/item 2>", "<step/item 3>", "<step/item 4>", "<step/item 5>"],
  "correct_order": [3, 1, 4, 2, 5],
  "explanation": "<rationale for the correct sequence AND why alternative orderings are wrong — 2-4 sentences>",
  "difficulty": "<easy|medium|hard>",
  "bloom_level": "<2_understand|3_apply|4_analyze|5_evaluate>",
  "is_image_question": false,
  "image_type": null,
  "image_search_terms": []
}`;
        break;
      case 'fill_blank':
        schema = `FORMAT: fill_blank (${alloc.name}) — ${alloc.count} question(s)
{
  "format_type": "fill_blank",
  "question": "<stem with a calculation or factual recall requiring a specific answer — e.g. dosage calculation>",
  "correct_answer_value": "<the numeric or text answer>",
  "correct_answer_unit": "<unit if applicable — e.g. 'mL', 'mg', 'drops/min'>",
  "acceptable_range": "<if numeric, acceptable range — e.g. '2.4-2.6'>",
  "explanation": "<show the calculation steps or reasoning AND common errors that lead to wrong answers — 2-4 sentences>",
  "difficulty": "<easy|medium|hard>",
  "bloom_level": "<2_understand|3_apply|4_analyze|5_evaluate>",
  "is_image_question": false,
  "image_type": null,
  "image_search_terms": []
}`;
        break;
      case 'hot_spot':
        schema = `FORMAT: hot_spot (${alloc.name}) — ${alloc.count} question(s)

CRITICAL HOT_SPOT RULES:
- The answer is the SET OF TARGET IDS that are correct — NEVER a text description.
- Enumerate all clickable elements as targets with stable lowercase-slug ids.
- Use "text_targets" type (default) when the candidate clicks a discrete text element (a line in a document, a table row, a figure/statement, a value in a record — e.g. an audit exhibit line, a contract clause, a lab value).
- Use "image_regions" type ONLY for genuine photos/figures with no discrete text elements (a chart region, a diagram area, a photograph).
- FORBIDDEN: answer.region, answer.label, answer.landmark — these are rejected by the contract.

Schema for text_targets (default, covers majority of hot-spots):
{
  "format_type": "hot_spot",
  "question": "<stem asking the candidate to click/select the correct item>",
  "stimulus_type": "text_targets",
  "stimulus_title": "<title of the displayed record/table — e.g. 'Nonaudit Services Schedule' or 'Medication Administration Record'>",
  "targets": [
    { "id": "<lowercase-slug, e.g. mar-1>", "text": "<full text of clickable element 1>" },
    { "id": "<lowercase-slug, e.g. mar-2>", "text": "<full text of clickable element 2>" },
    { "id": "<lowercase-slug, e.g. mar-3>", "text": "<full text of clickable element 3>" },
    { "id": "<lowercase-slug, e.g. mar-4>", "text": "<full text of clickable element 4>" }
  ],
  "correct_ids": ["<id of the correct target(s)>"],
  "scoring": "<dichotomous (single correct) | plus_minus (multiple correct, partial credit)>",
  "rationale": {
    "<target-id-1>": "<why this target is correct/incorrect — 1 sentence>",
    "<target-id-2>": "<why this target is correct/incorrect — 1 sentence>",
    "<target-id-3>": "<why this target is correct/incorrect — 1 sentence>",
    "<target-id-4>": "<why this target is correct/incorrect — 1 sentence>"
  },
  "explanation": "<overall explanation — 2-3 sentences>",
  "difficulty": "<easy|medium|hard>",
  "bloom_level": "<2_understand|3_apply|4_analyze|5_evaluate>",
  "is_image_question": false,
  "image_type": null,
  "image_search_terms": []
}

Schema for image_regions (ONLY for true images with no discrete text):
{
  "format_type": "hot_spot",
  "question": "<stem asking to click the area on the image>",
  "stimulus_type": "image_regions",
  "image_description": "<detailed description of the image>",
  "regions": [
    { "id": "<lowercase-slug>", "shape": "rect", "bbox": [0.05, 0.30, 0.30, 0.75] },
    { "id": "<lowercase-slug>", "shape": "rect", "bbox": [0.38, 0.30, 0.62, 0.75] }
  ],
  "correct_ids": ["<id of the correct region(s)>"],
  "scoring": "<dichotomous | plus_minus>",
  "rationale": {
    "<region-id-1>": "<why this region is correct/incorrect>",
    "<region-id-2>": "<why this region is correct/incorrect>"
  },
  "explanation": "<overall explanation — 2-3 sentences>",
  "difficulty": "<easy|medium|hard>",
  "bloom_level": "<2_understand|3_apply|4_analyze|5_evaluate>",
  "is_image_question": true,
  "image_type": "<type of image>",
  "image_search_terms": ["<search terms>"]
}

Self-check before returning: correct_ids non-empty, every id in correct_ids exists in targets/regions, NO answer.region/label/landmark, ≥2 targets, rationale has entry per target id.`;
        break;
      case 'matrix_grid':
        schema = `FORMAT: matrix_grid (${alloc.name}) — ${alloc.count} question(s)
{
  "format_type": "matrix_grid",
  "question": "<stem describing the scenario>",
  "row_headers": ["<item 1>", "<item 2>", "<item 3>"],
  "column_headers": ["<category A>", "<category B>", "<category C>"],
  "correct_cells": [{"row": 0, "col": 1}, {"row": 1, "col": 0}, {"row": 2, "col": 2}],
  "explanation": "<rationale for each correct cell AND why other cells are wrong — 3-5 sentences>",
  "difficulty": "<easy|medium|hard>",
  "bloom_level": "<2_understand|3_apply|4_analyze|5_evaluate>",
  "is_image_question": false,
  "image_type": null,
  "image_search_terms": []
}`;
        break;
      case 'cloze_dropdown':
        schema = `FORMAT: cloze_dropdown (${alloc.name}) — ${alloc.count} question(s)
{
  "format_type": "cloze_dropdown",
  "question": "<narrative text with [[BLANK1]] and [[BLANK2]] placeholders>",
  "blanks": [
    {"id": "BLANK1", "options": ["option A", "option B", "option C"], "correct": "option B"},
    {"id": "BLANK2", "options": ["option X", "option Y", "option Z"], "correct": "option X"}
  ],
  "explanation": "<rationale for each blank's correct answer AND why other dropdown options are wrong — 3-5 sentences>",
  "difficulty": "<easy|medium|hard>",
  "bloom_level": "<2_understand|3_apply|4_analyze|5_evaluate>",
  "is_image_question": false,
  "image_type": null,
  "image_search_terms": []
}`;
        break;
      case 'emq':
        schema = `FORMAT: emq (${alloc.name}) — ${alloc.count} question(s)
{
  "format_type": "emq",
  "theme": "<the theme/category the shared options belong to — e.g. 'Applicable accounting standard', 'Most likely diagnosis', 'Governing legal rule'>",
  "option_list": ["A. <option 1>", "B. <option 2>", "C. <option 3>", "D. <option 4>", "E. <option 5>"],
  "scenarios": [
    {"stem": "<scenario 1>", "correct_answer": "C"},
    {"stem": "<scenario 2>", "correct_answer": "A"}
  ],
  "explanation": "<rationale for EACH scenario's answer AND why other options are wrong for that scenario — 3-5 sentences>",
  "difficulty": "<easy|medium|hard>",
  "bloom_level": "<2_understand|3_apply|4_analyze|5_evaluate>",
  "is_image_question": false,
  "image_type": null,
  "image_search_terms": []
}`;
        break;
      case 'case_study':
        schema = `FORMAT: case_study (${alloc.name}) — ${alloc.count} question(s)
CASE STUDY RULES (MANDATORY):
  • Each case MUST have EXACTLY 6 sub-questions
  • Sub-questions MUST use at LEAST 3 DIFFERENT format_types (e.g., mcq_single, sata, ordered_response, hot_spot, fill_blank, cloze_dropdown)
  • Each sub-question MUST have its own "rationale" field explaining why the answer is correct AND why each distractor is wrong
  • Each sub-question MUST have a "reasoning_step" tag naming the step in THIS exam's analytical/decision workflow it tests. Use the step taxonomy natural to the exam's discipline — do NOT use clinical-judgment labels for non-clinical exams. Examples:
      – Nursing / clinical-judgment (NCLEX): Recognize Cues, Analyze Cues, Prioritize Hypotheses, Generate Solutions, Take Action, Evaluate Outcomes
      – Audit / accounting (CPA): Identify Risk, Gather Evidence, Evaluate Evidence, Determine Response, Form Conclusion, Report
      – Law / other: use that field's own reasoning progression (issue → rule → analysis → conclusion, etc.)
  • The overall "explanation" covers the reasoning thread across the full case
  • GRADABILITY IS MANDATORY — every sub-question MUST be machine-gradable. Include the COMPLETE answer scaffolding for its format (see per-format shapes below). A sub-question whose answer exists only in the rationale prose is INVALID. Never omit options/choices/rows/columns or the answer key.
  • Number sub-questions sequentially ("number": 1..N).
  • EXHIBIT REFERENCES: refer to exhibits ONLY by their visible label (e.g. "Using Exhibit 1"). NEVER use an internal id/slug (e.g. "cds-inputs-exhibit") in any candidate-visible text.
  • CONTENT INTEGRITY (candidate-visible correctness):
      – Each distractor's VALUE must actually equal the wrong result its rationale describes (recompute; if the rationale says "applies the recovery rate", the option value must be that number).
      – For numeric multiple-choice, order the options ASCENDING by value.
      – response_instructions must describe ONLY the response types that actually appear in the sub-questions (don't mention basis-point entry if there is no bps fill-in; state the exact accepted format for each numeric/date entry).
      – Keep the case internally consistent: every sub-question must use the SAME mechanics/rules stated in the narrative/exhibits (e.g. if the case says physical settlement, all sub-questions must reflect physical settlement, not cash settlement).
{
  "format_type": "case_study",
  "case_narrative": "<detailed scenario unfolding across time — include the specific data, documents, figures, or evidence a candidate must analyze (clinical: vitals/labs/history; accounting: financials/exhibits/schedules; law: facts/filings; etc.)>",
  "topics": ["<each distinct subtopic/area this case actually spans — e.g. Independence, Engagement Acceptance, Documentation, Communications>"],
  "response_instructions": "<how the candidate enters answers — date format (MM/DD/YYYY), numeric format ($ whole dollars), selection rules>",
  "sub_questions": [
    {
      "number": 1, "format_type": "mcq_single",
      "question": "<a decision from the scenario>",
      "options": ["A. ...", "B. ...", "C. ...", "D. ..."],
      "correct_answer": "B",
      "rationale": "<Why B is correct AND why A, C, D are wrong>", "reasoning_step": "<step>", "difficulty": "<easy|medium|hard>"
    },
    {
      "number": 2, "format_type": "sata",
      "question": "<select all that apply>",
      "options": ["A. ...", "B. ...", "C. ...", "D. ...", "E. ..."],
      "correct_answers": ["A", "C"],
      "rationale": "<...>", "reasoning_step": "<step>", "difficulty": "<easy|medium|hard>"
    },
    {
      "number": 3, "format_type": "matrix_grid",
      "question": "<classify each row>",
      "rows": ["<statement 1>", "<statement 2>", "<statement 3>"],
      "columns": ["<option A>", "<option B>"],
      "correct_answer": { "<statement 1>": "<option A>", "<statement 2>": "<option B>", "<statement 3>": "<option A>" },
      "rationale": "<...>", "reasoning_step": "<step>", "difficulty": "<easy|medium|hard>"
    },
    {
      "number": 4, "format_type": "cloze_dropdown",
      "question": "<sentence with [Blank 1] and [Blank 2] markers>",
      "choices": { "Blank 1": ["opt1", "opt2", "opt3"], "Blank 2": ["optA", "optB", "optC"] },
      "correct_answer": { "Blank 1": "opt2", "Blank 2": "optA" },
      "rationale": "<...>", "reasoning_step": "<step>", "difficulty": "<easy|medium|hard>"
    },
    {
      "number": 5, "format_type": "fill_blank",
      "question": "<enter a date/number>",
      "correct_answer": "04/16/2026",
      "rationale": "<...>", "reasoning_step": "<step>", "difficulty": "<easy|medium|hard>"
    },
    {
      "number": 6, "format_type": "ordered_response",
      "question": "<put the steps in order>",
      "items": ["<step A>", "<step B>", "<step C>", "<step D>"],
      "correct_order": [2, 4, 1, 3],
      "rationale": "<...>", "reasoning_step": "<step>", "difficulty": "<easy|medium|hard>"
    }
  ],
  "explanation": "<overall reasoning thread tying the case together — 3-5 sentences>",
  "bloom_level": "<4_analyze|5_evaluate>",
  "difficulty": "<medium|hard>",
  "is_image_question": false,
  "image_type": null,
  "image_search_terms": []
}
PER-FORMAT ANSWER KEY (all machine-gradable; use these EXACT shapes):
  - mcq_single: options[] + correct_answer:"<letter>"
  - sata: options[] + correct_answers:["<letters>"]
  - matrix_grid: rows[] + columns[] + correct_answer:{ "<each row text>": "<chosen column text>" }
  - cloze_dropdown: question has [Blank N] markers + choices:{ "Blank N": [options] } + correct_answer:{ "Blank N": "<one of its choices>" }
  - fill_blank: correct_answer:"<exact value>" (NOT only in the rationale)
  - ordered_response: items[] + correct_order — an array of 1-based item indices in the CORRECT SEQUENCE (e.g. [2,4,1,3] means item 2 is first). Do NOT use item→position mapping.
PARTIAL CREDIT: sub-questions of type matrix_grid, sata, and ordered_response SHOULD include "scoring": "all_or_nothing" | "partial" (matrix/sata default to "partial" per-cell/per-option; ordered_response defaults to "all_or_nothing"). Single-answer formats (mcq_single, fill_blank, cloze_dropdown) omit scoring.`;
        break;
      case 'task_based_simulation':
      case 'tbs':
        schema = `FORMAT: task_based_simulation (${alloc.name}) — ${alloc.count} simulation(s)
TASK-BASED SIMULATION RULES (MANDATORY):
  • This is NOT an image question. Set is_image_question=false. Provide ALL exhibit data as MARKDOWN text/tables — NEVER as an image.
  • Provide 2-5 "exhibits": the documents/data the candidate must analyze (contracts, financial statements, schedules, filings, correspondence, trial balances, etc.). Each exhibit's "content" is MARKDOWN (use markdown tables for tabular/numeric data).
  • Provide 4-8 "sub_questions" (tasks) that reference the exhibits BY LABEL (e.g. "Using Exhibit 1…"). EVERY fact a task needs (dates, amounts, terms, names) MUST actually appear in an exhibit's markdown — do not reference data that isn't shown.
  • Use realistic TBS task types across the sub-questions: fill_blank (numeric/date entry), cloze_dropdown (with "choices"), matrix_grid (with "rows"/"columns" — classify Correct/Incorrect), mcq_single (with "options"), emq (with "items"/"response_options" — matching), ordered_response (with "items").
  • Each sub-question MUST have its own "rationale" (why correct + why alternatives wrong) and a "reasoning_step" appropriate to the exam's discipline.
{
  "format_type": "task_based_simulation",
  "question": "<the scenario / directions the candidate reads first — the memo/task context>",
  "exhibits": [
    { "label": "Exhibit 1", "title": "<short title>", "type": "document|table|financials|correspondence|schedule", "content": "<exhibit content as MARKDOWN; use md tables for tabular data>" }
  ],
  "sub_questions": [
    { "number": 1, "prompt": "<task referencing an exhibit by label>", "format_type": "fill_blank", "keyed_answer": "<answer>", "rationale": "<why correct + why alternatives wrong>", "bloom_level": "3_apply", "reasoning_step": "<step>" },
    { "number": 2, "prompt": "<...>", "format_type": "cloze_dropdown", "choices": { "<blank_id>": ["opt1","opt2","opt3"] }, "keyed_answer": { "<blank_id>": "opt1" }, "rationale": "<...>", "bloom_level": "4_analyze", "reasoning_step": "<step>" },
    { "number": 3, "prompt": "<...>", "format_type": "matrix_grid", "rows": ["<statement 1>","<statement 2>"], "columns": ["Correct","Incorrect"], "keyed_answer": { "<statement 1>": "Correct" }, "rationale": "<...>", "bloom_level": "4_analyze", "reasoning_step": "<step>" },
    { "number": 4, "prompt": "<...>", "format_type": "mcq_single", "options": ["A. …","B. …","C. …","D. …"], "keyed_answer": "C", "rationale": "<...>", "bloom_level": "4_analyze", "reasoning_step": "<step>" }
  ],
  "response_instructions": "<how to enter answers — date format, dollar format, selection rules>",
  "explanation": "<overall reasoning thread across the simulation — 3-5 sentences>",
  "difficulty": "<medium|hard>",
  "bloom_level": "<4_analyze|5_evaluate>",
  "is_image_question": false,
  "image_type": null,
  "image_search_terms": []
}`;
        break;
      case 'performance_task':
        schema = `FORMAT: performance_task (${alloc.name}) — ${alloc.count} task(s)
PERFORMANCE TASK RULES (MANDATORY):
  • This is a human-scored EXTENDED CONSTRUCTED WORK PRODUCT — there is NO machine answer key. is_image_question:false.
  • Provide the source materials the examinee must use as "exhibits" (markdown): the client/case file AND the supplied authorities/data. Reference them from the task.
  • "prompt" states the assigned task and deliverable (e.g. draft a memo/letter, analyze the matter, advise the client).
  • "scoring_rubric" is MANDATORY — it is this format's answer key. Describe concretely what a strong response must demonstrate (issues to spot, authorities to apply, structure expected). A task without a rubric cannot be scored and will be REJECTED.
  • "exhibits" is MANDATORY (at least one) — a task with no supplied materials is not closed-universe and will be REJECTED. Also give a brief "sample_response" outline.
{
  "format_type": "performance_task",
  "prompt": "<the assigned task and the exact work product to produce>",
  "exhibits": [ { "label": "Exhibit 1", "title": "<e.g. Client File>", "type": "document|authority|correspondence|data", "content": "<MARKDOWN; the actual source material>" } ],
  "scoring_rubric": "<what a strong response demonstrates — issues to spot, authorities to apply, structure expected>",
  "sample_response": "<a brief outline/skeleton of a model response>",
  "explanation": "<how the task assesses the target lawyering/professional skills — 2-3 sentences>",
  "difficulty": "<medium|hard>",
  "bloom_level": "<4_analyze|5_evaluate|6_create>",
  "is_image_question": false,
  "image_type": null,
  "image_search_terms": []
}`;
        break;
      case 'constructed_response':
      case 'essay':
        schema = `FORMAT: ${alloc.slug} (${alloc.name}) — ${alloc.count} question(s)
This is a human-scored free-text response — NO machine answer key.
If this exam's responses are ITEM SETS (a shared vignette followed by labelled parts, as at CFA Level III), you MUST emit "vignette" plus "parts": each part gets its own label, prompt, POINT VALUE and its own scoring_rubric, because parts are scored separately. total_points must equal the sum of the part points. Never merge the parts into a single prompt. For a plain single-prompt essay, omit vignette/parts.
{
  "format_type": "constructed_response",
  "prompt": "<the task framing — what the examinee must produce>",
  "vignette": "<ITEM SET ONLY: the shared scenario every part refers to (client, portfolio, mandate, constraints, data). Omit for a single-prompt essay.>",
  "parts": [
    { "label": "A", "prompt": "<what part A asks; state whether justification/calculation is required>", "points": <int>, "scoring_rubric": "<exactly what earns each point for THIS part>", "sample_response": "<brief model answer outline>" },
    { "label": "B", "prompt": "<...>", "points": <int>, "scoring_rubric": "<...>" }
  ],
  "total_points": <int — MUST equal the sum of the part points>,
  "source_material": "<any extra material the writer must engage with, else empty>",
  "scoring_rubric": "<MANDATORY — this format's answer key. State exactly what earns credit, the point allocation across any labeled parts, and what earns none (unsupported or irrelevant writing). A response item without a rubric cannot be scored and will be REJECTED.>",
  "sample_response": "<a brief model-response outline>",
  "explanation": "<what skill this assesses — 1-2 sentences>",
  "difficulty": "<easy|medium|hard>",
  "bloom_level": "<4_analyze|5_evaluate|6_create>",
  "is_image_question": false,
  "image_type": null,
  "image_search_terms": []
}`;
        break;
      case 'passage_set':
        schema = `FORMAT: passage_set (${alloc.name}) — ${alloc.count} passage set(s)
READING PASSAGE SET RULES (MANDATORY):
  • Each set is ONE shared reading passage plus a group of questions about it. Output ONE object per set.
  • "passage": the FULL reading text (~400–500 words). For a comparative set, include BOTH texts labeled "Passage A" and "Passage B" within this field.
  • Provide 5–8 "sub_questions", each answerable ONLY from the passage. Do NOT reference facts not in the passage.
  • Each sub-question is a complete, gradable question (usually mcq_single): its own stem, options, correct answer, and "rationale" (why the key is right AND why each distractor is wrong).
  • Use standard exam lead-ins ("Which one of the following most accurately states the main point of the passage?", "The author's attitude can best be described as…").
  • Number sub-questions sequentially ("number": 1..N). Every sub-question MUST include the COMPLETE answer scaffolding for its format (never an answer only in prose).
{
  "format_type": "passage_set",
  "passage": "<full ~400–500 word passage; comparative → 'Passage A' … 'Passage B' …>",
  "topics": ["<subtopic(s) this passage's questions cover>"],
  "sub_questions": [
    {
      "number": 1, "format_type": "mcq_single",
      "question": "<question answerable only from the passage>",
      "options": ["A. …","B. …","C. …","D. …","E. …"],
      "correct_answer": "B",
      "rationale": "<why B is right AND why A, C, D, E are wrong>", "difficulty": "<easy|medium|hard>"
    }
    // … 5–8 sub-questions total
  ],
  "explanation": "<1-2 sentences on the passage's overall structure/argument>",
  "difficulty": "<easy|medium|hard>",
  "bloom_level": "<3_apply|4_analyze|5_evaluate>",
  "is_image_question": false,
  "image_type": null,
  "image_search_terms": []
}
PER-SUB ANSWER KEY (machine-gradable; use EXACT shapes): mcq_single → options[] + correct_answer:"<letter>"; sata → options[] + correct_answers:["<letters>"]. Every sub-question is answerable solely from the passage above.`;
        break;
      default:
        schema = `FORMAT: ${alloc.slug} (${alloc.name}) — ${alloc.count} question(s)
${alloc.description ? `Description: ${alloc.description}` : ''}
${alloc.answer_format ? `Answer format: ${alloc.answer_format}` : ''}
GRADABILITY IS MANDATORY: include the COMPLETE machine-readable answer scaffolding this format needs — every option/choice/row/column/item the candidate sees, AND the correct answer as a structured value (never only in the explanation). A reader must be able to auto-grade a response from these fields alone.
{
  "format_type": "${alloc.slug}",
  "question": "<stem>",
  "answer": "<structured, machine-readable correct answer — not prose>",
  "explanation": "<MUST: justify answer AND explain why alternatives are wrong — 3-5 sentences>",
  "difficulty": "<easy|medium|hard>",
  "bloom_level": "<2_understand|3_apply|4_analyze|5_evaluate>",
  "is_image_question": <true|false>,
  "image_type": "<if image, else null>",
  "image_search_terms": [<if image, else []>]
}`;
    }
    schemas.push(schema);
  }

  return schemas.join('\n\n');
}

// ── Build Professor Prompt (V1 lines 1145-1300) ──

function buildGuidelinesSection(guidelines?: Record<string, unknown>): string {
  if (!guidelines || Object.keys(guidelines).length === 0) return '';

  const parts: string[] = [];

  // Stem guidelines
  const stem = guidelines.stem_guidelines as Record<string, unknown> | undefined;
  if (stem) {
    const stemRules: string[] = [];
    if (stem.style) stemRules.push(`Style: ${stem.style}`);
    if (stem.vignette_required) stemRules.push('Vignettes are REQUIRED for each question');
    const stemScenarioDepth = stem.scenario_depth ?? stem.clinical_scenario_depth;
    if (stemScenarioDepth) stemRules.push(`Scenario depth: ${stemScenarioDepth}`);
    if (stem.min_words || stem.max_words) {
      stemRules.push(`Stem length: ${stem.min_words || ''}–${stem.max_words || ''} words`);
    }
    if (stemRules.length > 0) parts.push(`Stem: ${stemRules.join('. ')}`);
  }

  // Distractor guidelines
  const dist = guidelines.distractor_guidelines as Record<string, unknown> | undefined;
  if (dist) {
    const rules = (dist.quality_rules as string[]) || [];
    if (rules.length > 0) parts.push(`Distractor rules:\n${rules.map(r => `  - ${r}`).join('\n')}`);
    if (dist.homogeneity) parts.push(`Distractor homogeneity: ${dist.homogeneity}`);
  }

  // Explanation guidelines
  const expl = guidelines.explanation_guidelines as Record<string, unknown> | undefined;
  if (expl) {
    const explRules: string[] = [];
    if (expl.required) explRules.push('Explanation is REQUIRED for every question');
    if (expl.min_sentences) explRules.push(`Min ${expl.min_sentences} sentences`);
    if (expl.must_justify_correct) explRules.push('MUST justify why the correct answer is right');
    if (expl.must_address_distractors) explRules.push('MUST explain why EACH distractor/wrong option is wrong — name each option and state the specific reason. Do NOT just defend the correct answer');
    if (explRules.length > 0) parts.push(`Explanation rules (ENFORCED):\n${explRules.map(r => `  - ${r}`).join('\n')}`);
  }

  // Difficulty distribution
  const diffDist = guidelines.difficulty_distribution as Record<string, number> | undefined;
  if (diffDist && Object.keys(diffDist).length > 0) {
    const diffStr = Object.entries(diffDist).map(([k, v]) => `${k}: ${v}%`).join(', ');
    parts.push(`Difficulty distribution: ${diffStr}. Every question MUST have a "difficulty" field.`);
  }

  // Answer key balance
  if (guidelines.answer_key_balance) {
    parts.push(`Answer key: ${guidelines.answer_key_balance}`);
  }

  // Anti-patterns
  const anti = (guidelines.anti_patterns as string[]) || [];
  if (anti.length > 0) {
    parts.push(`AVOID:\n${anti.map(a => `  - ${a}`).join('\n')}`);
  }

  // Per-format specs — the authoritative per-format syntax/structure/gradability
  // the generator must satisfy for THIS exam (interpreted from the format contracts).
  const specs = guidelines.format_specs as Record<string, Record<string, unknown>> | undefined;
  if (specs && Object.keys(specs).length > 0) {
    const blocks: string[] = [];
    for (const [fmt, spec] of Object.entries(specs)) {
      if (!spec || typeof spec !== 'object') continue;
      const lines: string[] = [`  [${fmt}]`];
      if (spec.when_to_use) lines.push(`    When: ${spec.when_to_use}`);
      const list = (v: unknown) => (Array.isArray(v) ? (v as unknown[]).map(String) : v ? [String(v)] : []);
      for (const item of list(spec.syntax_rules)) lines.push(`    Syntax: ${item}`);
      for (const item of list(spec.structure_requirements)) lines.push(`    Structure: ${item}`);
      for (const item of list(spec.content_rules)) lines.push(`    Content: ${item}`);
      if (spec.gradability) lines.push(`    Gradability: ${spec.gradability}`);
      if (spec.difficulty_target) lines.push(`    Difficulty: ${spec.difficulty_target}`);
      blocks.push(lines.join('\n'));
    }
    if (blocks.length > 0) parts.push(`PER-FORMAT REQUIREMENTS (MANDATORY — match exactly):\n${blocks.join('\n')}`);
  }

  // Image guidelines
  const img = guidelines.image_guidelines as Record<string, unknown> | undefined;
  if (img && (img.percentage || img.when_required)) {
    const bits = [img.percentage != null ? `~${img.percentage}% of questions` : '', img.when_required ? `when: ${img.when_required}` : ''].filter(Boolean);
    if (bits.length) parts.push(`Images: ${bits.join('; ')}`);
  }

  // Coverage rules
  const coverage = (guidelines.coverage_rules as string[]) || [];
  if (coverage.length > 0) {
    parts.push(`Coverage rules:\n${coverage.map(c => `  - ${c}`).join('\n')}`);
  }

  // Custom rules
  const custom = (guidelines.custom_rules as string[]) || [];
  if (custom.length > 0) {
    parts.push(`Exam-specific rules:\n${custom.map(c => `  - ${c}`).join('\n')}`);
  }

  if (parts.length === 0) return '';

  return `
GENERATION GUIDELINES (MANDATORY)
──────────────────────────────────
${parts.join('\n\n')}

`;
}

function buildProfessorPrompt(subjectTask: SubjectTask, courseName: string): string {
  const { subject, num_questions: numQ, num_image_qs: numImgQ, bloom_counts: bloom, exam_params: ep } = subjectTask;
  const allocations = subjectTask.question_type_allocations || [{ slug: 'mcq_single', name: 'Single Best Answer MCQ', count: numQ, percentage: 100, num_options: ep.num_options }];
  const hyt = subjectTask.hyt_topics || [];
  const profile = subjectTask.subject_profile || {};
  const examPattern = subjectTask.exam_pattern || {};

  const hytStr = hyt.length > 0 ? hyt.slice(0, 25).map((t) => `  • ${t}`).join('\n') : '  (Full subject syllabus)';
  const bloomStr = Object.entries(bloom).sort().map(([k, v]) => `  ${k}: ${v} question${v !== 1 ? 's' : ''}`).join('\n');

  // Dynamic examiner role from exam pattern (fallback to generic)
  const examinerRole = (examPattern.examiner_role as string) || `senior examiner for the ${courseName} examination`;
  const examBoard = (examPattern.exam_board as string) || '';

  // Exam pattern section — testing philosophy, stem style, distinctive patterns
  let examPatternSection = '';
  if (Object.keys(examPattern).length > 0) {
    const philosophy = (examPattern.testing_philosophy as string) || '';
    const stemStyle = examPattern.stem_style as Record<string, unknown> | undefined;
    const optionStyle = examPattern.option_style as Record<string, unknown> | undefined;
    const recallRatio = examPattern.recall_vs_reasoning_ratio as Record<string, unknown> | undefined;
    const distinctive = (examPattern.distinctive_patterns as string[]) || [];
    const antiPatterns = (examPattern.what_NOT_to_do as string[]) || [];
    const exampleTemplates = (examPattern.example_stem_templates as string[]) || [];

    examPatternSection = `\nEXAM PATTERN — ${courseName.toUpperCase()}\n${'═'.repeat(50)}`;
    if (philosophy) examPatternSection += `\nTesting philosophy: ${philosophy}`;
    if (recallRatio?.description) examPatternSection += `\nRecall vs reasoning: ${recallRatio.description}`;
    if (stemStyle) {
      examPatternSection += `\n\nSTEM STYLE:`;
      if (stemStyle.typical_format) examPatternSection += `\n  Format: ${stemStyle.typical_format}`;
      if (stemStyle.avg_stem_words) examPatternSection += `\n  Target stem length: ~${stemStyle.avg_stem_words} words`;
      if (stemStyle.what_the_stem_tests) examPatternSection += `\n  What stems test: ${stemStyle.what_the_stem_tests}`;
      const leadIns = (stemStyle.lead_in_patterns as string[]) || [];
      if (leadIns.length > 0) examPatternSection += `\n  Typical lead-in endings:\n${leadIns.slice(0, 5).map((l) => `    • "${l}"`).join('\n')}`;
      const structures = (stemStyle.common_stem_structures as string[]) || [];
      if (structures.length > 0) examPatternSection += `\n  Common stem structures:\n${structures.slice(0, 4).map((s) => `    • ${s}`).join('\n')}`;
    }
    if (optionStyle) {
      examPatternSection += `\n\nOPTION STYLE:`;
      if (optionStyle.option_characteristics) examPatternSection += `\n  Characteristics: ${optionStyle.option_characteristics}`;
      if (optionStyle.distractor_philosophy) examPatternSection += `\n  Distractor philosophy: ${optionStyle.distractor_philosophy}`;
      if (optionStyle.typical_option_length) examPatternSection += `\n  Option length: ${optionStyle.typical_option_length}`;
    }
    if (distinctive.length > 0) {
      examPatternSection += `\n\nDISTINCTIVE PATTERNS OF ${courseName}:`;
      examPatternSection += `\n${distinctive.slice(0, 5).map((p) => `  ★ ${p}`).join('\n')}`;
    }
    if (antiPatterns.length > 0) {
      examPatternSection += `\n\nCRITICAL — DO NOT DO THESE (they make questions NOT match ${courseName}):`;
      examPatternSection += `\n${antiPatterns.slice(0, 4).map((p) => `  ✗ ${p}`).join('\n')}`;
    }
    if (exampleTemplates.length > 0) {
      examPatternSection += `\n\nEXAMPLE STEM TEMPLATES (follow these structures):`;
      examPatternSection += `\n${exampleTemplates.slice(0, 3).map((t, i) => `  ${i + 1}. ${t}`).join('\n')}`;
    }
    examPatternSection += '\n';
  }

  // Profile section
  let profileSection = '';
  if (Object.keys(profile).length > 0) {
    const qStyle = (profile.question_style as string) || '';
    const distractorArchetypes = (profile.distractor_archetypes as string[]) || [];
    const bloomGuidance = (profile.bloom_guidance as string) || '';
    const specialInstructions = (profile.special_instructions as string) || '';
    const imgQFocus = (profile.image_question_focus as string) || '';

    const distractorStr = distractorArchetypes.length > 0 ? distractorArchetypes.map((d) => `  • ${d}`).join('\n') : '';

    profileSection = `\nSUBJECT PROFILE — ${subject.toUpperCase()}\n${'─'.repeat(40)}`;
    if (qStyle) profileSection += `\nQuestion style: ${qStyle}`;
    if (bloomGuidance) profileSection += `\nBloom's guidance: ${bloomGuidance}`;
    if (distractorStr) profileSection += `\nDistractor archetypes to exploit:\n${distractorStr}`;
    if (imgQFocus && numImgQ > 0) profileSection += `\nImage question focus: ${imgQFocus}`;
    if (specialInstructions) profileSection += `\nSpecial instructions: ${specialInstructions}`;
    profileSection += '\n';
  }

  // Existing questions exclusion list (grouped by topic)
  const existingByTopic = subjectTask.existing_stems_by_topic;
  let exclusionSection = '';
  if (existingByTopic && existingByTopic.size > 0) {
    let totalExisting = 0;
    const topicBlocks: string[] = [];
    for (const [topic, stems] of existingByTopic) {
      const label = topic === '_general' ? '(General / untagged)' : topic;
      const capped = stems.slice(0, 50);
      totalExisting += capped.length;
      const stemList = capped.map((s, i) => `    ${i + 1}. ${s.slice(0, 80)}`).join('\n');
      topicBlocks.push(`  ${label}:\n${stemList}`);
    }
    exclusionSection = `
EXISTING QUESTIONS — DO NOT DUPLICATE
──────────────────────────────────────
${totalExisting} questions already exist in the question bank for ${subject}, grouped by topic.
You MUST NOT create questions that test the same fact, scenario, or concept.
Each of your questions must cover a DIFFERENT fact or concept.

${topicBlocks.join('\n\n')}
`;
  }

  const batchLabel = subjectTask._batch || '';
  const batchNote = batchLabel ? ` (batch ${batchLabel})` : '';
  const boardNote = examBoard ? ` (${examBoard})` : '';

  const isMultiFormat = allocations.length > 1;
  const formatBrief = isMultiFormat
    ? `Multiple formats:\n${allocations.map((a) => `              - ${a.name}: ${a.count} question(s) (${a.percentage}%)`).join('\n')}`
    : `${allocations[0].name}, ${allocations[0].num_options || ep.num_options} options per question`;

  const formatSchemas = buildFormatSchema(allocations, subjectTask.guidelines);

  return `You are a Professor of ${subject} and a ${examinerRole}.
You are now setting your department's contribution to this year's ${courseName}${boardNote} question paper${batchNote}.

EXAMINATION BRIEF
─────────────────
Exam:             ${courseName}
Your allocation:  ${numQ} questions
Format:           ${formatBrief}
Marking scheme:   ${ep.marking || 'Standard positive marking'}
Image-based Qs:   ${numImgQ} of your ${numQ} questions must be marked is_image_question: true

STIMULUS MEDIUM — choose correctly per question, respecting how ${courseName} ACTUALLY presents information:
- GENUINE VISUAL (x-ray, ECG/rhythm strip, histology/pathology slide, photograph, anatomy, gel/blot, a diagram/chart/graph that must be drawn): set is_image_question: true with an image_type. These count toward the image allocation above.
  You MUST also write "image_description": a COMPLETE, SELF-CONTAINED figure specification — everything the illustrator needs and NOTHING else, because they never see your vignette. State the figure title, each axis with its units and range, every series by name, and EVERY DATA POINT AS AN EXPLICIT NUMBER exactly as it appears in your scenario (e.g. "Portfolio Q: volatility 12.0%, return 8.0%; Portfolio R: volatility 14.0%, return 8.0%"). If a sub-question is answered by reading a value off the figure, that value MUST be plotted and labeled. Do NOT write a vague summary ("a scatter plot of portfolios") — a figure drawn from a description that omits the numbers will contradict your own answer key.
- SEPARATE DOCUMENT / DATA EXHIBIT (financial statement, workpaper, schedule, Schedule K-1, trial balance, ledger, contract, medication administration record, serial/trended lab table): set is_image_question: false and include an "exhibits" array — each exhibit { "label": "Exhibit 1", "title": "...", "type": "document|table|financials|schedule|correspondence", "content": "<MARKDOWN; use markdown tables for tabular/numeric data>" } — and reference exhibits by label. Every datum a task needs MUST appear in an exhibit. Use this ONLY when the exam genuinely shows a SEPARATE document/table.
- PURE TEXT (default): if the exam conventionally weaves the data INTO the vignette prose — e.g. a single set of vitals or a lab panel written in the stem ("Hgb 9.1 g/dL, WBC 14,200, Cr 2.1 mg/dL") — keep it INLINE as text. Do NOT manufacture an exhibit for data that belongs in the vignette. Most USMLE/NCLEX questions are pure text this way.
${examPatternSection}
BLOOM'S TAXONOMY — YOU MUST HIT THESE COUNTS EXACTLY
──────────────────────────────────────────────────────
${bloomStr}

HIGH-YIELD TOPICS FROM THIS YEAR'S SYLLABUS
────────────────────────────────────────────
${hytStr}
${profileSection}${exclusionSection}
YOUR RESPONSIBILITIES AS EXAMINER
──────────────────────────────────
- Every question MUST match the ${courseName} exam pattern described above
- Follow the question style and distractor archetypes described in the Subject Profile above
${isMultiFormat ? `- You MUST generate the EXACT number of questions for EACH format type as specified above
- Each question MUST include the "format_type" field matching its format` : '- Every question must follow the exam format'}
- No two questions should test the same fact
- Distribute your questions across the HYT topics listed above
- Each question must be tagged with its exact Bloom's level

AUTHENTIC EXAM CONTENT — TEST THE SKILL, NEVER ASK ABOUT IT
────────────────────────────────────────────────────────────
- Produce AUTHENTIC ${courseName} items — the exact kind of question a candidate faces on the REAL exam. Test each skill by making the candidate PERFORM it on real material (a real argument, passage, data set, rule, calculation, or scenario), not by asking ABOUT the skill.
- A topic name denotes the TASK your question must require the candidate to do — it is NOT a subject to describe or define. E.g. a "Necessary Assumption" topic → present an argument and ask which assumption it depends on; a "Main point" topic → give a passage/argument and ask for its main point; a "Dosage calculation" topic → give a real order and ask for the computed dose.
- NEVER write meta / definitional / test-strategy / study-skill questions. FORBIDDEN examples: "What is a good reading technique?", "Which is the best way to approach this question type?", "What is the definition of a necessary assumption?", "Which study method improves speed?", "What should a test-taker do first when reading a passage?". These never appear on the real exam.
- Every question MUST embed the actual stimulus it operates on, so the candidate reasons from real content — never from generic knowledge about test-taking or about the concept's name.
${buildGuidelinesSection(subjectTask.guidelines)}
EXPLANATION / RATIONALE — MANDATORY RULES
──────────────────────────────────────────
Every explanation MUST:
1. Justify WHY the correct answer is right (reasoning, mechanism, or evidence appropriate to the discipline)
2. Explain WHY EACH distractor/wrong option is wrong (name each option and state the specific reason)
3. Be 3-5 sentences minimum for standalone questions
4. For case_study: each sub_question MUST have its own "rationale" field — the overall "explanation" is for the reasoning thread only

ANSWER INTEGRITY — MANDATORY RULES
────────────────────────────────────
1. STEM MUST NOT NAME OR GIVE AWAY THE ANSWER (e.g. the diagnosis, the governing rule/standard, the final figure) — for choice-based formats
2. For MCQ/SATA: OPTIONS MUST NOT BETRAY THE ANSWER — all options plausible, parallel, similar length
3. No "All of the above" or "None of the above"
4. NO ANSWER CLUES IN STEM WORDING

DIFFICULTY — MANDATORY
──────────────────────
Every question MUST include "difficulty": "easy", "medium", or "hard".
Distribute across all three levels — do NOT make all questions the same difficulty.
Rough target: ~20% easy, ~50% medium, ~30% hard (adjust per exam pattern).

Return EXACTLY ${numQ} questions as a JSON array.
${isMultiFormat ? `You MUST produce the exact format mix: ${allocations.map((a) => `${a.count}x ${a.slug}`).join(', ')}` : ''}

QUESTION SCHEMAS — use the correct schema for each format_type:
${formatSchemas}

Return ONLY the JSON array. No preamble, no commentary, no markdown.`;
}

// ── Enrich questions with metadata (V1 lines 1326-1374) ──

function enrichQuestions(
  questions: Record<string, unknown>[],
  subject: string,
  courseName: string,
  hytTopics: string[],
  topicCounter: { value: number }
): Record<string, unknown>[] {
  const diffMap: Record<string, number> = { easy: 1, medium: 2, hard: 3, 'very hard': 3, very_hard: 3, low: 1, moderate: 2, high: 3 };

  for (const q of questions) {
    q.subject = subject;
    // Round-robin topic assignment from HYT list
    delete q.topic;
    if (hytTopics.length > 0) {
      q.topic = hytTopics[topicCounter.value % hytTopics.length];
      topicCounter.value++;
    } else {
      q.topic = '';
    }
    q.course = courseName;

    // Ensure format_type is set (default to mcq_single if missing)
    if (!q.format_type) q.format_type = 'mcq_single';

    // Normalize correct answer (MCQ-style)
    if (q.correct_answer && !q.correct_option) {
      q.correct_option = q.correct_answer;
      delete q.correct_answer;
    }

    // Normalize bloom field — handle NCJMM_*, full labels, and numeric prefixes
    if (q.bloom_level && !q.blooms_level) {
      q.blooms_level = q.bloom_level;
      delete q.bloom_level;
    }
    let bl = ((q.blooms_level as string) || '').trim();
    // Strip NCJMM_ or NCLEX_ prefixes → normalize to standard bloom labels
    if (bl.startsWith('NCJMM_') || bl.startsWith('NCLEX_') || bl.startsWith('ncjmm_') || bl.startsWith('nclex_')) {
      bl = bl.replace(/^(NCJMM_|NCLEX_|ncjmm_|nclex_)/i, '');
    }
    // Map common non-standard labels to standard bloom levels
    const bloomNormMap: Record<string, string> = {
      'remember': '1', 'recall': '1', 'knowledge': '1',
      'understand': '2', 'comprehension': '2', 'comprehend': '2',
      'apply': '3', 'application': '3',
      'analyze': '4', 'analyse': '4', 'analysis': '4',
      'evaluate': '5', 'evaluation': '5', 'synthesis': '5',
      'create': '6',
      'recognize_cues': '3', 'analyze_cues': '4', 'prioritize_hypotheses': '4',
      'generate_solutions': '5', 'take_action': '3', 'evaluate_outcomes': '5',
    };
    const blLower = bl.toLowerCase().replace(/\s+/g, '_');
    if (bloomNormMap[blLower]) {
      bl = bloomNormMap[blLower];
    } else if (bl && bl[0] >= '1' && bl[0] <= '6') {
      bl = bl[0]; // "2_understand" → "2"
    }
    q.blooms_level = bl || '3';

    // Normalize difficulty to numeric (1-3 scale)
    const d = q.difficulty;
    if (!d || d === 0) {
      // Infer from bloom level: higher bloom → higher difficulty
      const bloomNum = parseInt(bl) || 3;
      q.difficulty = bloomNum <= 2 ? 1 : bloomNum <= 4 ? 2 : 3;
    } else if (typeof d === 'string') {
      q.difficulty = diffMap[d.toLowerCase().trim()] || 2;
    }

    // Normalize options from array to object if needed (for MCQ/SATA types)
    if (Array.isArray(q.options)) {
      const optArr = q.options as unknown[];
      const optObj: Record<string, string> = {};
      for (const opt of optArr) {
        if (typeof opt === 'string') {
          const match = opt.match(/^([A-H])\.\s*/);
          if (match) {
            optObj[match[1]] = opt.substring(match[0].length);
          }
        } else if (typeof opt === 'object' && opt !== null) {
          // Handle {key: "A", text: "..."} format
          const o = opt as Record<string, string>;
          if (o.key && o.text) {
            optObj[o.key] = o.text;
          }
        }
      }
      if (Object.keys(optObj).length > 0) q.options = optObj;
    }
  }
  return questions;
}

// ── Parse LLM JSON response ──

function parseQuestions(raw: string): Record<string, unknown>[] {
  let text = raw;
  if (text.includes('```json')) text = text.split('```json')[1].split('```')[0];
  else if (text.includes('```')) text = text.split('```')[1].split('```')[0];

  // Fast path: a complete array parses cleanly.
  const match = text.match(/\[[\s\S]*\]/);
  if (match) {
    try {
      const qs = JSON.parse(match[0].trim());
      if (Array.isArray(qs)) return qs;
    } catch { /* fall through to salvage */ }
  }

  // Salvage path: the batch was truncated mid-object (large case studies overflow
  // the token cap). Recover every COMPLETE top-level {...} object and drop only
  // the truncated tail — so we keep the questions that did finish instead of 0.
  const salvaged = salvageQuestionObjects(text);
  if (salvaged.length > 0) {
    console.warn(`  [Gen] Salvaged ${salvaged.length} complete question(s) from a truncated/malformed batch`);
    return salvaged;
  }
  throw new Error('no parseable questions');
}

/** Extract complete top-level JSON objects from a (possibly truncated) array. */
function salvageQuestionObjects(text: string): Record<string, unknown>[] {
  const start = text.indexOf('[');
  const body = start >= 0 ? text.slice(start + 1) : text;
  const out: Record<string, unknown>[] = [];
  let depth = 0, objStart = -1, inStr = false, esc = false;
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') { inStr = true; continue; }
    if (ch === '{') { if (depth === 0) objStart = i; depth++; }
    else if (ch === '}') {
      depth--;
      if (depth === 0 && objStart >= 0) {
        try { out.push(JSON.parse(body.slice(objStart, i + 1))); } catch { /* skip bad object */ }
        objStart = -1;
      }
    }
  }
  return out;
}

// ── Generate questions for one subject (V1 lines 1305-1446) ──

async function professorGenerateQuestions(
  subjectTask: SubjectTask,
  courseName: string
): Promise<Record<string, unknown>[]> {
  const { subject, num_questions: numQ } = subjectTask;
  const hyt = subjectTask.hyt_topics || [];
  const topicCounter = { value: 0 };
  const allQuestions: Record<string, unknown>[] = [];
  const numBatches = Math.ceil(numQ / PROFESSOR_BATCH_SIZE);
  const bloomRemaining = { ...subjectTask.bloom_counts };

  for (let b = 0; b < numBatches; b++) {
    const batchSize = Math.min(PROFESSOR_BATCH_SIZE, numQ - allQuestions.length);
    if (batchSize <= 0) break;

    // Bloom counts for this batch
    const batchBloom: Record<string, number> = {};
    const remainingBatches = numBatches - b;
    for (const [level, totalCount] of Object.entries(bloomRemaining)) {
      if (remainingBatches === 1) {
        batchBloom[level] = totalCount;
      } else {
        batchBloom[level] = Math.round(totalCount / remainingBatches);
      }
    }

    // Image questions for this batch (proportional)
    const imgPerBatch = Math.ceil(subjectTask.num_image_qs / numBatches);
    const batchImgQ = Math.min(imgPerBatch, subjectTask.num_image_qs - allQuestions.filter((q) => q.is_image_question).length);

    // Scale question_type_allocations for this batch
    let batchAllocations: QuestionTypeAllocation[] | undefined;
    if (subjectTask.question_type_allocations && subjectTask.question_type_allocations.length > 1) {
      const allocs = subjectTask.question_type_allocations;
      batchAllocations = [];
      let batchRemaining = batchSize;
      for (let i = 0; i < allocs.length; i++) {
        const alloc = allocs[i];
        if (i === allocs.length - 1) {
          if (batchRemaining > 0) batchAllocations.push({ ...alloc, count: batchRemaining });
        } else {
          const cnt = Math.max(alloc.percentage >= 10 ? 1 : 0, Math.round(batchSize * alloc.percentage / 100));
          const actual = Math.min(cnt, batchRemaining);
          if (actual > 0) {
            batchAllocations.push({ ...alloc, count: actual });
            batchRemaining -= actual;
          }
        }
      }
    }

    const batchTask: SubjectTask = {
      ...subjectTask,
      num_questions: batchSize,
      num_image_qs: Math.max(0, batchImgQ),
      bloom_counts: batchBloom,
      question_type_allocations: batchAllocations || subjectTask.question_type_allocations,
      _batch: `${b + 1}/${numBatches}`,
    };

    try {
      const prompt = buildProfessorPrompt(batchTask, courseName);
      console.log(`  [Gen] ${subject} batch ${b + 1}/${numBatches}: sending prompt (${prompt.length} chars)...`);
      const response = await orCall(MODELS.GENERATOR, '', prompt, { maxTokens: 20000, temperature: 0.7 });
      console.log(`  [Gen] ${subject} batch ${b + 1}: got response (${response.content.length} chars)`);
      let qs: Record<string, unknown>[];
      try {
        qs = parseQuestions(response.content);
      } catch (parseErr) {
        console.error(`  [Gen] ${subject} batch ${b + 1}: PARSE FAILED — ${parseErr}`);
        console.error(`  [Gen] Response preview: ${response.content.slice(0, 300)}...`);
        // Retry with lower temperature
        const response2 = await orCall(MODELS.GENERATOR, '', prompt, { maxTokens: 20000, temperature: 0.5 });
        try {
          qs = parseQuestions(response2.content);
          console.log(`  [Gen] ${subject} batch ${b + 1}: retry succeeded — ${qs.length} Qs parsed`);
        } catch (parseErr2) {
          console.error(`  [Gen] ${subject} batch ${b + 1}: RETRY PARSE ALSO FAILED — ${parseErr2}`);
          console.error(`  [Gen] Retry response preview: ${response2.content.slice(0, 300)}...`);
          continue;
        }
      }

      // Retry if too few questions
      if (qs.length < batchSize) {
        console.log(`  [Gen] ${subject} batch ${b + 1}: only ${qs.length}/${batchSize}, retrying...`);
        const response2 = await orCall(MODELS.GENERATOR, '', prompt, { maxTokens: 20000, temperature: 0.5 });
        try {
          const qs2 = parseQuestions(response2.content);
          if (qs2.length > qs.length) qs = qs2;
        } catch {
          // keep original qs
        }
      }

      enrichQuestions(qs, subject, courseName, hyt, topicCounter);
      allQuestions.push(...qs);

      // Subtract bloom counts
      for (const level of Object.keys(bloomRemaining)) {
        bloomRemaining[level] = Math.max(0, bloomRemaining[level] - (batchBloom[level] || 0));
      }

      console.log(`  ${subject} batch ${b + 1}/${numBatches}: ${qs.length}/${batchSize} Qs`);
    } catch (e) {
      const errMsg = e instanceof Error ? e.message : String(e);
      console.error(`  [Gen] professor batch ${b + 1} FAILED for ${subject}: ${errMsg}`);
      // If it's a billing/credits error, throw immediately — no point retrying other batches
      if (errMsg.includes('402') || errMsg.includes('Insufficient credits') || errMsg.includes('billing')) {
        throw new Error(`LLM API billing error: ${errMsg}`);
      }
    }
  }

  console.log(`Professor ${subject}: ${allQuestions.length}/${numQ} questions generated`);
  return allQuestions;
}

// ── Generate one subject's paper (V1 lines 1449-1466) ──
// Note: Image pipeline (Phase A/B) skipped for now — generates text-only questions

async function generateSubjectPaper(
  subjectTask: SubjectTask,
  courseName: string
): Promise<Record<string, unknown>[]> {
  console.log(`▶ Professor of ${subjectTask.subject}: ${subjectTask.num_questions} Qs, ${subjectTask.num_image_qs} image Qs`);
  // Phase C only — image pipeline to be added later
  return professorGenerateQuestions(subjectTask, courseName);
}

// ── In-memory tracking for running jobs ──
const runningJobs = new Map<string, { status: string; completed: number; total: number }>();

// ── Resolve format_id by slug (cached) ──
const _formatIdCache = new Map<string, string>();
async function getFormatId(slug: string): Promise<string | null> {
  if (_formatIdCache.has(slug)) return _formatIdCache.get(slug)!;
  const { data } = await supabase
    .from('qb_question_formats')
    .select('id')
    .eq('slug', slug)
    .maybeSingle();
  if (data?.id) {
    _formatIdCache.set(slug, data.id);
    return data.id;
  }
  return null;
}

// ── Build content JSONB from LLM output (format-aware) ──
// Preserve the COMPLETE, machine-gradable structure of a case_study / TBS
// sub-question — never drop the fields a grader/renderer needs per format
// (matrix rows+columns, cloze choices, the answer key, item order, etc.).
// Normalize any leaked exhibit slug ("helix-exhibit-1", "cds-inputs-exhibit")
// to the candidate-visible label ("Exhibit 1"). Belt-and-suspenders: the prompt
// forbids slugs and the reviewer flags them, but this guarantees clean data.
function deslugExhibits(s: unknown): unknown {
  if (typeof s !== 'string') return s;
  return s
    .replace(/\b(?:[a-z0-9]+[-_])*exhibit[-_](\d+)\b/gi, 'Exhibit $1')
    .replace(/\b(?:[a-z0-9]+[-_])+exhibit\b/gi, 'Exhibit 1');
}

export function enrichSubQuestion(sq: Record<string, unknown>, idx: number): Record<string, unknown> {
  const base: Record<string, unknown> = {
    number: sq.number ?? idx + 1,
    question: deslugExhibits(sq.question || sq.prompt || sq.stem || ''),
    format_type: sq.format_type || 'mcq_single',
    // choice/answer scaffolding across all formats
    options: sq.options,                 // mcq_single / sata
    choices: sq.choices,                 // cloze_dropdown: { blankId: [opts] }
    response_options: sq.response_options, // emq
    items: sq.items,                     // ordered_response / emq; applied_research items[]
    rows: sq.rows,                       // matrix_grid
    columns: sq.columns,                 // matrix_grid
    blanks: sq.blanks,                   // cloze (alt shape)
    // work-product scaffolding — without these the task cannot be rendered or graded
    // grid_kind belongs to data_entry_grid alone; carried on any other format it is
    // an invented label that fragments every later grouping by format.
    grid_kind: (sq.format_type === 'data_entry_grid' ? sq.grid_kind : undefined),
    constraints: sq.constraints,         // data_entry_grid (e.g. debits == credits)
    document: sq.document,               // document_review
    spans: sq.spans,                     // document_review
    source: sq.source,                   // applied_research
    excerpt: sq.excerpt,                 // applied_research (the supplied standards text)
    exhibit_label: sq.exhibit_label,     // applied_research (excerpt lives in this exhibit)
    correct_order: sq.correct_order,
    stimulus: sq.stimulus,               // hot_spot
    rationale: deslugExhibits(sq.rationale || sq.explanation || ''),
    reasoning_step: sq.reasoning_step || sq.cjmm_step || null,
    bloom_level: sq.bloom_level || null,
    difficulty: sq.difficulty || null,
  };
  const ft = (sq.format_type as string) || 'mcq_single';
  const unwrap = (v: unknown): unknown =>
    (v && typeof v === 'object' && !Array.isArray(v) && (v as Record<string, unknown>).correct_order !== undefined)
      ? (v as Record<string, unknown>).correct_order : v;

  // Answer key — EXACTLY ONE field per format (never emit twin keys):
  if (ft === 'sata' || ft === 'mcq_multi') {
    base.correct_answers = sq.correct_answers ?? sq.correct_answer ?? sq.keyed_answer ?? sq.answer;
  } else if (ft === 'ordered_response' || ft === 'drag_drop') {
    // The answer IS correct_order; unwrap if the model nested it under correct_answer/answer.
    if (base.correct_order === undefined) base.correct_order = unwrap(sq.correct_answer ?? sq.answer);
    // do NOT also emit correct_answer
  } else if (ft === 'constructed_response' || ft === 'essay' || ft === 'short_answer') {
    // Human-scored sub-item — NO machine answer key; carry the prompt + optional rubric.
    base.prompt = sq.prompt ?? sq.question ?? sq.stem;
    if (sq.scoring_rubric) base.scoring_rubric = sq.scoring_rubric;
    if (sq.sample_response) base.sample_response = sq.sample_response;
  } else {
    base.correct_answer = sq.correct_answer ?? sq.keyed_answer ?? sq.answer ?? sq.correct_answers;
  }
  // Scoring only where partial credit is meaningful; never emit a null.
  if (['matrix_grid', 'sata', 'mcq_multi', 'ordered_response'].includes(ft) && sq.scoring) {
    base.scoring = sq.scoring;
  }
  // Drop keys that are genuinely absent so records stay clean.
  for (const k of Object.keys(base)) if (base[k] === undefined) delete base[k];
  return base;
}

function buildContentFromQuestion(q: Record<string, unknown>): Record<string, unknown> {
  const formatType = (q.format_type as string) || 'mcq_single';

  switch (formatType) {
    case 'mcq_single': {
      const rawOptions = q.options as Record<string, string> | undefined;
      let optionsArray: Array<{ key: string; text: string }> = [];
      if (rawOptions && typeof rawOptions === 'object') {
        optionsArray = Object.entries(rawOptions)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([key, text]) => ({ key, text: text.replace(/^[A-Z]\.\s*/, '') }));
      }
      return {
        stem: q.question as string,
        ...(q.passage ? { passage: q.passage as string } : {}),
        options: optionsArray,
        answer: { key: (q.correct_option as string) || 'A' },
        explanation: (q.explanation as string) || '',
      };
    }
    case 'sata':
    case 'mcq_multi': {
      const rawOptions = q.options as Record<string, string> | undefined;
      let optionsArray: Array<{ key: string; text: string }> = [];
      if (rawOptions && typeof rawOptions === 'object') {
        optionsArray = Object.entries(rawOptions)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([key, text]) => ({ key, text: text.replace(/^[A-Z]\.\s*/, '') }));
      }
      return {
        stem: q.question as string,
        ...(q.passage ? { passage: q.passage as string } : {}),
        options: optionsArray,
        answer: { keys: (q.correct_answers as string[]) || [q.correct_option as string || 'A'] },
        explanation: (q.explanation as string) || '',
      };
    }
    case 'ordered_response':
    case 'drag_drop':
      return {
        stem: q.question as string,
        items: (q.items as string[]) || [],
        correct_order: (q.correct_order as number[]) || [],
        explanation: (q.explanation as string) || '',
      };
    case 'fill_blank':
      return {
        stem: q.question as string,
        answer: {
          value: (q.correct_answer_value as string) || '',
          unit: (q.correct_answer_unit as string) || '',
          acceptable_range: (q.acceptable_range as string) || '',
        },
        explanation: (q.explanation as string) || '',
      };
    case 'hot_spot': {
      // New contract: stimulus + correct_ids
      const stimulusType = (q.stimulus_type as string) || 'text_targets';
      const stimulus: Record<string, unknown> = { type: stimulusType };

      if (stimulusType === 'text_targets') {
        stimulus.title = (q.stimulus_title as string) || '';
        stimulus.targets = (q.targets as unknown[]) || [];
      } else {
        // image_regions
        stimulus.image = (q.image_url as string) || '';
        stimulus.regions = (q.regions as unknown[]) || [];
      }

      const content: Record<string, unknown> = {
        stem: q.question as string,
        stimulus,
        answer: { correct_ids: (q.correct_ids as string[]) || [] },
        scoring: (q.scoring as string) || 'dichotomous',
        rationale: (q.rationale as Record<string, string>) || {},
        explanation: (q.explanation as string) || '',
      };

      if (q.image_description) content.image_description = q.image_description;

      // Legacy fallback: if correct_region exists but no correct_ids, convert
      if ((!q.correct_ids || (q.correct_ids as string[]).length === 0) && q.correct_region) {
        const region = q.correct_region;
        const regionData = (typeof region === 'object' && region !== null) ? region : { label: (region as string) || '' };
        content.answer = { region: regionData };
        delete content.stimulus;
        delete content.scoring;
        delete content.rationale;
      }

      return content;
    }
    case 'matrix_grid':
      return {
        stem: q.question as string,
        row_headers: (q.row_headers as string[]) || [],
        column_headers: (q.column_headers as string[]) || [],
        correct_cells: (q.correct_cells as Array<{ row: number; col: number }>) || [],
        explanation: (q.explanation as string) || '',
      };
    case 'cloze_dropdown':
      return {
        stem: q.question as string,
        blanks: (q.blanks as unknown[]) || [],
        explanation: (q.explanation as string) || '',
      };
    case 'emq':
      return {
        theme: (q.theme as string) || '',
        option_list: (q.option_list as string[]) || [],
        scenarios: (q.scenarios as unknown[]) || [],
        explanation: (q.explanation as string) || '',
      };
    case 'case_study': {
      const subs = (q.sub_questions as Array<Record<string, unknown>>) || [];
      return {
        case_narrative: (q.case_narrative as string) || (q.question as string) || '',
        ...(Array.isArray(q.topics) ? { topics: q.topics } : {}),
        sub_questions: subs.map(enrichSubQuestion),
        response_instructions: (q.response_instructions as string) || '',
        explanation: (q.explanation as string) || '',
      };
    }
    case 'passage_set': {
      const subs = (q.sub_questions as Array<Record<string, unknown>>) || [];
      return {
        passage: (q.passage as string) || (q.reading_passage as string) || (q.case_narrative as string) || '',
        ...(Array.isArray(q.topics) ? { topics: q.topics } : {}),
        sub_questions: subs.map(enrichSubQuestion),
        explanation: (q.explanation as string) || '',
      };
    }
    case 'constructed_response':
    case 'essay': {
      // An item set carries a shared vignette plus separately-scored labelled parts.
      const rawParts = (q.parts as Array<Record<string, unknown>>) || (q.sub_questions as Array<Record<string, unknown>>) || [];
      const parts = rawParts.map((pt, i) => ({
        label: (pt.label as string) || String.fromCharCode(65 + i),
        prompt: (pt.prompt as string) || (pt.question as string) || '',
        points: Number(pt.points ?? pt.point_value ?? 0) || 0,
        scoring_rubric: (pt.scoring_rubric as string) || (pt.rubric as string) || '',
        ...(pt.sample_response ? { sample_response: pt.sample_response as string } : {}),
      }));
      const summed = parts.reduce((n, pt) => n + pt.points, 0);
      return {
        prompt: (q.prompt as string) || (q.question as string) || '',
        ...(q.vignette || q.case_narrative ? { vignette: (q.vignette as string) || (q.case_narrative as string) } : {}),
        ...(q.source_material ? { source_material: q.source_material as string } : {}),
        ...(parts.length ? { parts, total_points: Number(q.total_points) || summed } : {}),
        ...(q.sample_response ? { sample_response: q.sample_response as string } : {}),
        ...(q.scoring_rubric ? { scoring_rubric: q.scoring_rubric as string } : {}),
        explanation: (q.explanation as string) || '',
      };
    }
    case 'performance_task': {
      const rawExhibits = (q.exhibits as Array<Record<string, unknown>>) || [];
      return {
        prompt: (q.prompt as string) || (q.question as string) || '',
        exhibits: rawExhibits.map((ex, i) => ({
          label: (ex.label as string) || `Exhibit ${i + 1}`,
          title: (ex.title as string) || '',
          type: (ex.type as string) || 'document',
          content: (ex.content as string) || (ex.markdown as string) || (ex.text as string) || '',
        })),
        ...(q.scoring_rubric ? { scoring_rubric: q.scoring_rubric as string } : {}),
        ...(q.sample_response ? { sample_response: q.sample_response as string } : {}),
        explanation: (q.explanation as string) || '',
      };
    }
    case 'task_based_simulation':
    case 'tbs': {
      // Some models nest sub_questions/response_instructions under `answer`.
      const ans = (q.answer as Record<string, unknown>) || {};
      const subs = (q.sub_questions as Array<Record<string, unknown>>)
        || (ans.sub_questions as Array<Record<string, unknown>>)
        || [];
      const enrichedSubs = subs.map(enrichSubQuestion);
      const rawExhibits = (q.exhibits as Array<Record<string, unknown>>) || (ans.exhibits as Array<Record<string, unknown>>) || [];
      const exhibits = rawExhibits.map((ex, i) => ({
        label: (ex.label as string) || `Exhibit ${i + 1}`,
        title: (ex.title as string) || '',
        type: (ex.type as string) || 'document',
        content: (ex.content as string) || (ex.markdown as string) || (ex.text as string) || '',
      }));
      return {
        format_type: 'task_based_simulation',
        scenario: (q.question as string) || (q.scenario as string) || (q.case_narrative as string) || '',
        ...(Array.isArray(q.topics) ? { topics: q.topics } : {}),
        exhibits,
        sub_questions: enrichedSubs,
        response_instructions: (q.response_instructions as string) || (ans.response_instructions as string) || '',
        explanation: (q.explanation as string) || '',
      };
    }
    default: {
      // Generic GROUPED fallback: any format the model returned with sub_questions
      // is a shared-stimulus set — normalize it like a case (shared stimulus passed
      // through + enriched subs) so a guidelines-only new grouped format works with
      // no dedicated code.
      const ans = (q.answer as Record<string, unknown>) || {};
      const subs = (q.sub_questions as Array<Record<string, unknown>>)
        || (ans.sub_questions as Array<Record<string, unknown>>);
      if (Array.isArray(subs) && subs.length > 0) {
        const rawExhibits = (q.exhibits as Array<Record<string, unknown>>) || (ans.exhibits as Array<Record<string, unknown>>) || [];
        return {
          ...(q.passage ? { passage: q.passage as string } : {}),
          ...(q.case_narrative ? { case_narrative: q.case_narrative as string } : {}),
          ...(q.scenario ? { scenario: q.scenario as string } : {}),
          ...(rawExhibits.length ? { exhibits: rawExhibits.map((ex, i) => ({
            label: (ex.label as string) || `Exhibit ${i + 1}`,
            title: (ex.title as string) || '',
            type: (ex.type as string) || 'document',
            content: (ex.content as string) || (ex.markdown as string) || (ex.text as string) || '',
          })) } : {}),
          ...(Array.isArray(q.topics) ? { topics: q.topics } : {}),
          sub_questions: subs.map(enrichSubQuestion),
          response_instructions: (q.response_instructions as string) || (ans.response_instructions as string) || '',
          explanation: (q.explanation as string) || '',
        };
      }
      // Non-grouped unknown format — store the entire LLM output as content.
      return {
        stem: q.question as string,
        answer: q.answer || q.correct_answer || q.correct_option || '',
        explanation: (q.explanation as string) || '',
        raw: q,
      };
    }
  }
}

// ── Insert questions for a subject into DB ──

/**
 * The allocation slug is what we ASKED for; the model sometimes returns a
 * differently-shaped question (a case study or performance task emitted inside an
 * mcq_single allocation). Trusting the slug then mis-tags the row, mangles it
 * through the wrong content builder, and validates it against the wrong schema.
 * Derive the real format from the SHAPE of what came back.
 */
function deriveFormatType(declared: string, raw: Record<string, unknown>): string {
  const canon = canonicalizeFormatSlug(declared || 'mcq_single');
  const subs = raw.sub_questions;
  const hasSubs = Array.isArray(subs) && subs.length > 0;
  const hasExhibits = Array.isArray(raw.exhibits) && (raw.exhibits as unknown[]).length > 0;
  // Shared stimulus + sub-questions => a grouped format, whatever the slug said.
  if (hasSubs && !GROUPED_FORMATS.has(canon)) {
    return raw.passage ? 'passage_set' : 'case_study';
  }
  // An assigned task over supplied source documents => a performance task.
  if (!hasSubs && raw.prompt && hasExhibits && canon !== 'performance_task' && canon !== 'constructed_response') {
    return 'performance_task';
  }
  return canon;
}

async function insertSubjectQuestions(
  questions: Record<string, unknown>[],
  jobId: string,
  courseId: string,
  courseName: string,
  subjectIndex: number,
  guidelines?: Record<string, unknown>
) {
  if (questions.length === 0) return;

  // Pre-resolve all unique format_ids needed
  const slugs = [...new Set(questions.map((q) => (q.format_type as string) || 'mcq_single'))];
  const formatIds: Record<string, string | null> = {};
  for (const slug of slugs) {
    formatIds[slug] = await getFormatId(slug);
  }

  const rows = questions.map((q, idx) => {
    const declaredFormat = (q.format_type as string) || 'mcq_single';
    const formatType = deriveFormatType(declaredFormat, q);
    if (formatType !== canonicalizeFormatSlug(declaredFormat)) {
      console.warn(`  [Format] q${idx + 1}: model returned ${formatType}-shaped content under a "${declaredFormat}" allocation — retagging`);
    }
    const isMcq = formatType === 'mcq_single' || formatType === 'mcq_multi' || formatType === 'sata';

    // Build content using the DERIVED format so a grouped question is not mangled
    // through the mcq content builder (which would drop its sub_questions).
    const content = buildContentFromQuestion({ ...q, format_type: formatType }) as Record<string, unknown>;
    if (!Array.isArray(content.exhibits) && Array.isArray(q.exhibits)) {
      content.exhibits = (q.exhibits as Array<Record<string, unknown>>).map((ex, i) => ({
        label: (ex.label as string) || `Exhibit ${i + 1}`,
        title: (ex.title as string) || '',
        type: (ex.type as string) || 'document',
        content: (ex.content as string) || (ex.markdown as string) || (ex.text as string) || '',
      }));
    }
    // Classify presentation medium; auto-correct a document mis-tagged as image.
    const questionType = classifyQuestionType({ ...q, content });
    content.question_type = questionType;
    const isImage = questionType === 'image';

    // Deterministic schema check against the guidelines' materialized content_schema
    // for this format. Record violations so the review pre-pass can enforce them —
    // generation is expected to stick to the schema; a mismatch is surfaced, not hidden.
    const schemaErrors = schemaErrorsFor(guidelines, formatType, content);
    if (schemaErrors.length > 0) {
      console.warn(`  [Schema] subject ${subjectIndex} q${idx + 1} (${formatType}): ${schemaErrors.slice(0, 3).join('; ')}`);
    }

    return {
      job_id: jobId,
      course_id: courseId,
      question_number: (subjectIndex * 100) + idx + 1,
      // Legacy columns (kept for backward compat — populated for MCQ types, best-effort for others)
      question: (q.question as string) || (q.case_narrative as string) || '',
      options: isMcq ? ((q.options as Record<string, string>) || {}) : {},
      correct_option: isMcq ? ((q.correct_option as string) || (q.correct_answers as string[])?.[0] || 'A') : '',
      explanation: (q.explanation as string) || '',
      subject: q.subject as string,
      topic: (q.topic as string) || '',
      course: courseName,
      blooms_level: (q.blooms_level as string) || '',
      difficulty: (q.difficulty as number) || 1,
      is_image_question: isImage,
      image_url: (q.image_url as string) || null,
      image_type: isImage ? ((q.image_type as string) || null) : null,
      image_description: isImage ? ((q.image_description as string) || null) : null,
      image_search_terms: isImage ? ((q.image_search_terms as string[]) || []) : [],
      // Flexible format columns
      format_id: formatIds[formatType] || formatIds['mcq_single'],
      content,
      tags: {
        subject: q.subject as string,
        // For multi-topic cases, route by the case's actual topic (its first
        // covered topic), not the generic subject-task topic (which mis-routes).
        topic: (Array.isArray(content.topics) && (content.topics as string[])[0]) || (q.topic as string) || '',
        ...(Array.isArray(content.topics) ? { topics: content.topics } : {}),
        blooms: (q.blooms_level as string) || '',
        difficulty: (q.difficulty as number) || 1,
        format_type: formatType,
        question_type: questionType,
        schema_valid: schemaErrors.length === 0,
        ...(schemaErrors.length > 0 ? { schema_errors: schemaErrors } : {}),
      },
      media: (isImage && q.image_type) ? [{
        type: (q.image_type as string) || 'image',
        url: (q.image_url as string) || null,
        description: (q.image_description as string) || null,
        source: 'pending',
        search_terms: (q.image_search_terms as string[]) || [],
      }] : [],
      status: 'generated',
      audit_trail: [],
      attempt_number: 1,
    };
  });

  console.log(`  [Insert] Inserting ${rows.length} questions for subject ${subjectIndex} (formats: ${[...new Set(rows.map(r => (r.tags as Record<string, unknown>)?.format_type || 'unknown'))].join(', ')})`);
  const { error: insertErr } = await supabase.from('qb_questions').insert(rows);
  if (insertErr) {
    console.error(`  [Insert] ERROR for subject ${subjectIndex}: ${insertErr.message}`);
    console.error(`  [Insert] Details: ${insertErr.details || 'none'} | Hint: ${insertErr.hint || 'none'}`);
    // Try inserting one by one to find the offending row
    if (rows.length > 1) {
      let successCount = 0;
      for (let i = 0; i < rows.length; i++) {
        const { error: singleErr } = await supabase.from('qb_questions').insert([rows[i]]);
        if (singleErr) {
          console.error(`  [Insert] Row ${i} failed: ${singleErr.message} — format=${(rows[i].tags as Record<string, unknown>)?.format_type}`);
        } else {
          successCount++;
        }
      }
      console.log(`  [Insert] Individual insert: ${successCount}/${rows.length} succeeded`);
    }
  } else {
    console.log(`  [Insert] OK — ${rows.length} questions inserted for subject ${subjectIndex}`);
  }
}

// ── Run all professors in parallel (V1 pattern) ──

async function runAllProfessors(
  jobId: string,
  courseId: string,
  tasks: SubjectTask[],
  courseName: string
) {
  const totalSubjects = tasks.length;
  const completedSubjects: string[] = [];
  let totalQuestionsGenerated = 0;

  // Fetch existing questions for this course (from previous jobs) to avoid duplicates
  // Grouped by subject+topic for precise deduplication. Paginate — a course can
  // easily have >1000 prior questions, and missing some weakens dedup.
  const existingQs = await fetchAllRows<Record<string, any>>((from, to) =>
    supabase
      .from('qb_questions')
      .select('subject, topic, question')
      .eq('course_id', courseId)
      .neq('job_id', jobId)
      .order('id', { ascending: true })
      .range(from, to)
  );

  const stemsBySubjectTopic = new Map<string, string[]>();
  if (existingQs && existingQs.length > 0) {
    for (const q of existingQs) {
      const key = `${(q.subject || '').toLowerCase().trim()}::${(q.topic || '').toLowerCase().trim()}`;
      if (!stemsBySubjectTopic.has(key)) stemsBySubjectTopic.set(key, []);
      stemsBySubjectTopic.get(key)!.push(q.question);
    }
    // Attach per-topic stems to each task
    for (const task of tasks) {
      const subjKey = task.subject.toLowerCase().trim();
      const topicMap = new Map<string, string[]>();
      for (const topic of task.hyt_topics) {
        const key = `${subjKey}::${topic.toLowerCase().trim()}`;
        const stems = stemsBySubjectTopic.get(key);
        if (stems && stems.length > 0) topicMap.set(topic, stems);
      }
      // Also check for stems with empty topic (older data)
      const noTopicKey = `${subjKey}::`;
      const noTopicStems = stemsBySubjectTopic.get(noTopicKey);
      if (noTopicStems && noTopicStems.length > 0) topicMap.set('_general', noTopicStems);

      if (topicMap.size > 0) task.existing_stems_by_topic = topicMap;
    }
    console.log(`📋 Found ${existingQs.length} existing questions across previous jobs for deduplication`);
  }

  console.log(`\n🚀 Launching ${totalSubjects} professor agents in parallel for ${courseName}\n`);

  startTracking(jobId, 'generation');

  await supabase
    .from('qb_jobs')
    .update({
      status: 'generating',
      progress: {
        completed: 0,
        total: totalSubjects,
        completed_subjects: [],
        message: `Launching ${totalSubjects} professor agents...`,
      },
    })
    .eq('id', jobId);

  // Run ALL subjects in parallel — just like V1's ThreadPoolExecutor(max_workers=len(tasks))
  const promises = tasks.map(async (task, idx) => {
    try {
      const questions = await generateSubjectPaper(task, courseName);
      await insertSubjectQuestions(questions, jobId, courseId, courseName, idx, task.guidelines);

      // Update progress as each professor finishes
      completedSubjects.push(task.subject);
      totalQuestionsGenerated += questions.length;

      await supabase
        .from('qb_jobs')
        .update({
          status: 'generating',
          progress: {
            completed: completedSubjects.length,
            total: totalSubjects,
            current_subject: task.subject,
            completed_subjects: [...completedSubjects],
            message: `${task.subject}: ${questions.length} Qs done — ${completedSubjects.length}/${totalSubjects} subjects`,
          },
        })
        .eq('id', jobId);

      console.log(`✓ Professor ${task.subject}: ${questions.length} questions — ${completedSubjects.length}/${totalSubjects}`);
      return { subject: task.subject, count: questions.length };
    } catch (e) {
      const errMsg = e instanceof Error ? e.message : String(e);
      console.error(`✗ Professor ${task.subject} failed: ${errMsg}`);
      completedSubjects.push(task.subject); // count as done even if failed
      // Propagate billing errors so the entire job fails fast
      if (errMsg.includes('billing') || errMsg.includes('402') || errMsg.includes('Insufficient credits')) {
        throw e;
      }
      return { subject: task.subject, count: 0, error: e };
    }
  });

  await Promise.all(promises);

  // Post-generation deduplication — remove near-duplicate stems within this job
  try {
    const { data: jobQs } = await supabase
      .from('qb_questions')
      .select('id, question, subject')
      .eq('job_id', jobId)
      .is('replaced_by_id', null);

    if (jobQs && jobQs.length > 1) {
      const normalize = (s: string) => (s || '').toLowerCase().replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ').trim();
      const seen = new Map<string, string>(); // normalized stem → first question id
      const dupeIds: string[] = [];

      for (const q of jobQs) {
        const norm = normalize(q.question);
        if (!norm) continue;
        // Check for exact or near-exact matches (first 120 chars of normalized stem)
        const key = norm.slice(0, 120);
        if (seen.has(key)) {
          dupeIds.push(q.id);
          console.log(`  [Dedup] Removing duplicate: "${q.question?.slice(0, 60)}..." (matches existing in ${q.subject})`);
        } else {
          seen.set(key, q.id);
        }
      }

      if (dupeIds.length > 0) {
        await supabase.from('qb_questions').delete().in('id', dupeIds);
        totalQuestionsGenerated -= dupeIds.length;
        console.log(`🔍 Dedup: removed ${dupeIds.length} duplicate questions, ${totalQuestionsGenerated} remaining`);
      } else {
        console.log('🔍 Dedup: no duplicates found');
      }
    }
  } catch (e) {
    console.error('Dedup check failed (non-fatal):', e);
  }

  // Save 'generated' snapshots before image pipeline
  try {
    const { saveJobSnapshots } = await import('../snapshots.js');
    await saveJobSnapshots(jobId, 'generated');
    console.log(`📸 Saved 'generated' snapshots for ${totalQuestionsGenerated} questions`);
  } catch (e) {
    console.error('Failed to save generated snapshots:', e);
  }

  // Image pipeline: generate images for image questions.
  // This runs to COMPLETION as part of the orchestrated generation phase — no
  // 5-minute race cutoff. The old race abandoned most images (100+ images at
  // concurrency 3 can't finish in 5 min), which is why images "failed" during
  // generation and only appeared after a manual retry. Each image call is now
  // individually timeout-bounded and errors are non-fatal, so the pipeline can't
  // hang; it just proceeds past any image that fails.
  try {
    const { processAllImageQuestions, isImageGenerationAvailable } = await import('../images/imageGeneration.js');
    if (isImageGenerationAvailable()) {
      await supabase
        .from('qb_jobs')
        .update({
          progress: {
            completed: totalSubjects,
            total: totalSubjects,
            completed_subjects: completedSubjects,
            phase: 'images',
            message: `Generating images for image-based questions...`,
          },
        })
        .eq('id', jobId);

      const imgResult = await processAllImageQuestions(jobId);
      console.log(`🎨 Image pipeline: ${imgResult.totalSuccess}/${imgResult.totalProcessed} images generated (${imgResult.totalFailed} failed)`);
    }
  } catch (e) {
    console.error('Image pipeline error (non-fatal):', e);
  }

  // All done — always transition to reviewing
  const genTokens = getStepTokens(jobId, 'generation');
  await supabase
    .from('qb_jobs')
    .update({
      status: 'reviewing',
      progress: {
        completed: totalSubjects,
        total: totalSubjects,
        completed_subjects: completedSubjects,
        message: `All ${totalSubjects} subjects complete — ${totalQuestionsGenerated} questions generated`,
        token_usage: { generation: genTokens },
      },
    })
    .eq('id', jobId);

  runningJobs.set(jobId, { status: 'complete', completed: totalSubjects, total: totalSubjects });
  console.log(`\n🏁 Generation complete: ${totalQuestionsGenerated} questions across ${totalSubjects} subjects\n`);
}

// ── Build tasks for topic-wise mode ──
// Uses exam format for style/bloom's/image% but derives question counts from course structure

async function buildTopicWiseTasks(
  courseStructure: Record<string, unknown>,
  examFormat: Record<string, unknown>,
  courseName: string,
  questionsPerTopic: number = 5
): Promise<SubjectTask[]> {
  const subjects = (courseStructure.subjects as Array<Record<string, unknown>>) || [];
  if (subjects.length === 0) throw new Error('Course has no subjects');

  // Extract exam pattern profile for threading into generation
  const examPattern = (examFormat.exam_pattern as Record<string, unknown>) || {};

  // Bloom's distribution from exam format (same logic as buildSubjectTasks)
  const bloomsRaw = (examFormat.blooms_distribution as Record<string, number>) || {};
  const l2to5: Record<string, number> = {};
  for (const [k, v] of Object.entries(bloomsRaw)) {
    if (['2', '3', '4', '5'].some((n) => k.startsWith(n))) {
      l2to5[k] = v;
    }
  }
  if (Object.keys(l2to5).length === 0) {
    Object.assign(l2to5, { '2_understand': 1, '3_apply': 1, '4_analyze': 1, '5_evaluate': 1 });
  }
  const totalBloom = Object.values(l2to5).reduce((a, b) => a + b, 0) || 1;
  const bloomRatios: Record<string, number> = {};
  for (const [k, v] of Object.entries(l2to5)) bloomRatios[k] = v / totalBloom;

  // Exam params from exam format
  const qf = (examFormat.question_format as Record<string, unknown>) || {};
  const examParams = {
    style: (qf.type as string) || 'single_best_answer',
    num_options: (qf.num_options as number) || 4,
    marking: (examFormat.negative_marking as string) || 'Standard positive marking',
  };

  // Image percentages by subject from exam format
  const imgBySubject = (examFormat.image_percentage_by_subject as Record<string, number>) || {};
  const defaultImgPct = (qf.image_questions_percentage as number) || 20;

  function findImgPct(subjectName: string): number {
    const key = subjectName.trim().toLowerCase();
    if (subjectName in imgBySubject) return imgBySubject[subjectName];
    for (const [k, v] of Object.entries(imgBySubject)) {
      if (k.toLowerCase().trim() === key || k.toLowerCase().includes(key) || key.includes(k.toLowerCase())) return v;
    }
    return defaultImgPct;
  }

  const tasks: SubjectTask[] = [];

  for (const subj of subjects) {
    const name = ((subj.name as string) || '').trim();
    if (!name) continue;

    const topics = (subj.topics as Array<Record<string, unknown>>) || [];
    const topicNames = topics.map((t) => (t.name as string) || '').filter(Boolean);
    const numQ = Math.max(questionsPerTopic, topicNames.length * questionsPerTopic);
    const imgPct = findImgPct(name);
    const numImageQ = Math.round(numQ * imgPct / 100);

    // Bloom counts proportional from ratios
    const bloomCounts: Record<string, number> = {};
    let remainder = numQ;
    const sortedLevels = Object.entries(bloomRatios).sort((a, b) => b[1] - a[1]);
    for (let i = 0; i < sortedLevels.length; i++) {
      const [level, ratio] = sortedLevels[i];
      if (i === sortedLevels.length - 1) {
        bloomCounts[level] = Math.max(0, remainder);
      } else {
        const c = Math.round(numQ * ratio);
        bloomCounts[level] = c;
        remainder -= c;
      }
    }

    tasks.push({
      subject: name,
      num_questions: numQ,
      num_image_qs: numImageQ,
      bloom_counts: bloomCounts,
      hyt_topics: topicNames,
      exam_params: examParams,
      exam_pattern: examPattern,
      question_type_allocations: allocateQuestionTypes(numQ, examFormat),
    });
  }

  // Generate subject profiles in parallel (with exam pattern context)
  const profilePromises = tasks.map(async (task) => {
    const profile = await generateSubjectProfile(task.subject, courseName, task.hyt_topics, examPattern);
    task.subject_profile = profile;
  });
  await Promise.all(profilePromises);

  return tasks;
}

// ── Main entry: start or check generation for a job ──

// ─────────────────────────────────────────────────────────────────────────────
// Replacement — generate a fresh question to stand in for one that review could
// not rescue.
//
// The UI has offered this since the beginning (Step5Replace calls next-batch with
// phase 'replace', the schema carries a replaced_by_id self-FK, and QuestionStatus
// lists 'replaced' and 'manual_review') but nothing on the server implemented it:
// the phase fell through next-batch's default branch and returned the job status
// unchanged. Repair was the only tool, so a question that was malformed from the
// start — a CFA case study whose narrative and rationales disagreed about their own
// numbers — could only be fixed toward a shape it never had, burning a full
// review/audit cycle each pass.
//
// A replacement is generated to the SAME shape as the question it retires (subject,
// topic, format, bloom level, difficulty, image requirement) so the exam's
// distribution is preserved, enters as 'generated' so it is reviewed from scratch,
// and the old row is kept and marked 'replaced' with replaced_by_id pointing at its
// successor — every read path already filters on `replaced_by_id is null`, so the
// history stays auditable without polluting counts or exports.
// ─────────────────────────────────────────────────────────────────────────────

/** Questions replaced per next-batch call, so the phase stays incremental. */
const REPLACE_BATCH_SIZE = Number(process.env.REPLACE_BATCH_SIZE) || 10;
/** After this many failed attempts a question is parked for a human. */
const MAX_REPLACE_ATTEMPTS = 2;

const replacingJobs = new Set<string>();

function countReplaceFailures(q: Record<string, unknown>): number {
  const trail = Array.isArray(q.audit_trail) ? (q.audit_trail as Array<Record<string, unknown>>) : [];
  return trail.filter((t) => t.phase === 'replace_failed').length;
}

/** Every question id currently in the job — used to identify the rows we just inserted. */
async function questionIdsForJob(jobId: string): Promise<Set<string>> {
  const rows = await fetchAllRows<{ id: string }>((from, to) =>
    supabase.from('qb_questions').select('id').eq('job_id', jobId).order('id', { ascending: true }).range(from, to)
  );
  return new Set((rows || []).map((r) => r.id));
}

export async function replaceBatchForJob(
  jobId: string
): Promise<{ status: string; replaced: number; failed: number; manual_review: number; remaining: number; message?: string }> {
  if (replacingJobs.has(jobId)) {
    return { status: 'replacing', replaced: 0, failed: 0, manual_review: 0, remaining: 0, message: 'already running' };
  }
  replacingJobs.add(jobId);
  try {
    const { data: job, error: jobErr } = await supabase.from('qb_jobs').select('*').eq('id', jobId).single();
    if (jobErr || !job) throw new Error(jobErr?.message || 'job not found');

    const { data: course } = await supabase
      .from('qb_courses').select('name,exam_format,generation_guidelines').eq('id', job.course_id).single();
    const courseName = (course?.name as string) || 'exam preparation';
    const guidelines = (course?.generation_guidelines || {}) as Record<string, unknown>;
    const examFormat = (course?.exam_format || {}) as Record<string, unknown>;

    // Candidates: still flagged after review could not rescue them, not already
    // replaced, and not yet parked for a human.
    const candidates = await fetchAllRows<Record<string, any>>((from, to) =>
      supabase.from('qb_questions').select('*')
        .eq('job_id', jobId).eq('status', 'flagged').is('replaced_by_id', null)
        .order('question_number', { ascending: true }).range(from, to)
    );
    const pending = (candidates || []).filter((q) => countReplaceFailures(q) < MAX_REPLACE_ATTEMPTS);
    if (pending.length === 0) {
      return { status: 'complete', replaced: 0, failed: 0, manual_review: 0, remaining: 0, message: 'nothing to replace' };
    }

    const batch = pending.slice(0, REPLACE_BATCH_SIZE);
    console.log(`\n♻️  Replacing ${batch.length} of ${pending.length} irreparable question(s) for "${courseName}"`);

    // Keep the numbering clear of everything already in the job.
    const { data: maxRow } = await supabase.from('qb_questions')
      .select('question_number').eq('job_id', jobId)
      .order('question_number', { ascending: false }).limit(1).single();
    let subjectIndex = Math.floor((((maxRow?.question_number as number) || 0) + 100) / 100);

    // One professor run per subject, so a replacement is written by the same
    // subject-specialist prompt that wrote the original.
    const bySubject = new Map<string, Record<string, any>[]>();
    for (const q of batch) {
      const s = (q.subject as string) || 'General';
      if (!bySubject.has(s)) bySubject.set(s, []);
      bySubject.get(s)!.push(q);
    }

    let replaced = 0, failed = 0, manualReview = 0;

    for (const [subject, olds] of bySubject) {
      const before = await questionIdsForJob(jobId);

      // Mirror what we are retiring: same formats, same bloom mix, same image count.
      const formatCounts = new Map<string, number>();
      for (const q of olds) {
        const slug = canonicalizeFormatSlug(((q.tags as Record<string, unknown>)?.format_type as string) || 'mcq_single');
        formatCounts.set(slug, (formatCounts.get(slug) || 0) + 1);
      }
      const allocations: QuestionTypeAllocation[] = [...formatCounts].map(([slug, count]) => ({
        slug, name: slug, count, percentage: Math.round((count / olds.length) * 100),
      }));

      const bloomCounts: Record<string, number> = {};
      for (const q of olds) {
        const b = (q.blooms_level as string) || 'apply';
        bloomCounts[b] = (bloomCounts[b] || 0) + 1;
      }

      const qf = (examFormat.question_format || {}) as Record<string, unknown>;
      const task: SubjectTask = {
        subject,
        num_questions: olds.length,
        num_image_qs: olds.filter((q) => q.is_image_question).length,
        bloom_counts: bloomCounts,
        hyt_topics: [...new Set(olds.map((q) => (q.topic as string) || '').filter(Boolean))],
        exam_params: {
          style: (qf.style as string) || 'standard',
          num_options: (qf.num_options as number) || 4,
          marking: (examFormat.negative_marking as string) || 'Standard positive marking',
        },
        exam_pattern: examFormat.exam_pattern as Record<string, unknown>,
        question_type_allocations: allocations,
        guidelines,
      };

      let fresh: Record<string, unknown>[] = [];
      try {
        fresh = await professorGenerateQuestions(task, courseName);
      } catch (e) {
        console.error(`  [Replace] ${subject}: generation failed — ${e instanceof Error ? e.message : e}`);
      }

      if (fresh.length > 0) {
        await insertSubjectQuestions(fresh, jobId, job.course_id, courseName, subjectIndex++, guidelines);
      }

      // Identify exactly what landed, then retire one original per replacement.
      const after = await questionIdsForJob(jobId);
      const newIds = [...after].filter((id) => !before.has(id));
      const pairs = Math.min(newIds.length, olds.length);
      if (newIds.length !== olds.length) {
        console.warn(`  [Replace] ${subject}: asked for ${olds.length}, got ${newIds.length}`);
      }

      for (let i = 0; i < olds.length; i++) {
        const old = olds[i];
        if (i < pairs) {
          const trail = [...(Array.isArray(old.audit_trail) ? old.audit_trail : []), {
            phase: 'replaced',
            replaced_by: newIds[i],
            reason: 'Review could not rescue this question; a fresh one was generated to the same shape.',
            timestamp: new Date().toISOString(),
          }];
          const { error } = await supabase.from('qb_questions')
            .update({ status: 'replaced', replaced_by_id: newIds[i], audit_trail: trail })
            .eq('id', old.id);
          if (error) { console.error(`  [Replace] link failed for ${String(old.id).slice(0, 8)}: ${error.message}`); failed++; }
          else replaced++;
        } else {
          const attempts = countReplaceFailures(old) + 1;
          const parked = attempts >= MAX_REPLACE_ATTEMPTS;
          const trail = [...(Array.isArray(old.audit_trail) ? old.audit_trail : []), {
            phase: 'replace_failed',
            attempt: attempts,
            reason: 'The generator returned no replacement for this question.',
            timestamp: new Date().toISOString(),
          }];
          await supabase.from('qb_questions')
            .update({ status: parked ? 'manual_review' : 'flagged', audit_trail: trail })
            .eq('id', old.id);
          if (parked) manualReview++;
          failed++;
        }
      }
    }

    // Replacements that need a figure have none yet; this only touches rows with
    // is_image_question and a null image_url, so it cannot disturb existing images.
    if (replaced > 0 && isImageGenerationAvailable()) {
      const img = await processAllImageQuestions(jobId);
      if (img.totalProcessed > 0) {
        console.log(`  [Replace] images: ${img.totalSuccess}/${img.totalProcessed} generated`);
      }
    }

    // A replacement enters as 'generated' and must still be reviewed and audited —
    // but both phases short-circuit on a job whose status is 'complete', returning a
    // synthesised "Review complete" from stored progress without running a batch. So
    // replacing on a finished job would strand its own output: three replacements sat
    // at status 'generated' with no scores while review reported success. Reopening
    // the job to 'reviewing' is what lets them through.
    if (replaced > 0) {
      const { data: j } = await supabase.from('qb_jobs').select('status').eq('id', jobId).single();
      if (j && (j.status === 'complete' || j.status === 'auditing')) {
        await supabase.from('qb_jobs').update({ status: 'reviewing' }).eq('id', jobId);
        console.log(`  [Replace] job reopened to 'reviewing' so the ${replaced} replacement(s) get scored`);
      }
    }

    const remaining = Math.max(0, pending.length - batch.length);
    console.log(`♻️  Replaced ${replaced}, failed ${failed} (${manualReview} parked for manual review), ${remaining} remaining\n`);
    return {
      status: remaining > 0 ? 'replacing' : 'complete',
      replaced, failed, manual_review: manualReview, remaining,
      message: `Replaced ${replaced} question(s)${remaining > 0 ? `, ${remaining} remaining` : ''}`,
    };
  } finally {
    replacingJobs.delete(jobId);
  }
}

export async function generateBatchForJob(
  jobId: string,
  courseId: string
): Promise<{ status: string; completed: number; total: number; message?: string; completed_subjects?: string[]; phase?: string }> {
  // If already running or complete, return current status
  const cached = runningJobs.get(jobId);
  if (cached) {
    return cached;
  }

  // Atomically claim this job BEFORE any await. Both the browser (pollNextBatch)
  // and the server orchestrator call this; without a synchronous claim they both
  // pass the empty-cache guard above, both build tasks, and both fire professors —
  // generating ~2× the intended questions. Setting the flag here (no await between
  // the get() above and this set()) guarantees the second caller returns early.
  runningJobs.set(jobId, { status: 'generating', completed: 0, total: 0 });

  // Check DB status
  const { data: job, error: jobErr } = await supabase
    .from('qb_jobs')
    .select('*')
    .eq('id', jobId)
    .single();
  if (jobErr) {
    runningJobs.delete(jobId); // release claim so a later retry can proceed
    throw new Error(jobErr.message);
  }

  if (job.status === 'reviewing' || job.status === 'complete') {
    runningJobs.delete(jobId); // not actually generating — release the claim
    const progress = (job.progress || {}) as Record<string, unknown>;
    return {
      status: 'complete',
      completed: (progress.total as number) || 0,
      total: (progress.total as number) || 0,
    };
  }

  // Already generating (e.g. server restarted mid-run) — report current progress, don't re-trigger
  if (job.status === 'generating') {
    const progress = (job.progress || {}) as Record<string, unknown>;
    // Sync our in-memory claim to the DB snapshot so cached returns aren't stuck at 0.
    runningJobs.set(jobId, {
      status: 'generating',
      completed: (progress.completed as number) || 0,
      total: (progress.total as number) || 0,
    });
    return {
      status: 'generating',
      completed: (progress.completed as number) || 0,
      total: (progress.total as number) || 0,
      message: (progress.message as string) || '',
      completed_subjects: (progress.completed_subjects as string[]) || [],
      phase: (progress.phase as string) || '',
    };
  }

  // First call — kick off parallel generation
  const { data: course, error: courseErr } = await supabase
    .from('qb_courses')
    .select('*')
    .eq('id', courseId)
    .single();
  if (courseErr) throw new Error(courseErr.message);

  const courseName = course.name as string;
  let structure = course.structure as Record<string, unknown>;
  const examFormat = (course.exam_format || {}) as Record<string, unknown>;
  const guidelines = (course.generation_guidelines || {}) as Record<string, unknown>;
  const jobType = (job.type as string) || '';
  const jobConfig = (job.config || {}) as Record<string, unknown>;

  // Scope generation to a single exam when the job is labeled with one, or when
  // the course has a selected exam (chosen on the structure page).
  // Subjects are tagged with `exam` at parse time, so we just filter the flat list.
  const selectedExam = (jobConfig.exam as string) || (structure.selected_exam as string) || '';
  if (selectedExam && selectedExam !== '__all__') {
    const allSubjects = (structure.subjects as Array<Record<string, unknown>>) || [];
    const scoped = allSubjects.filter((s) => (s.exam as string) === selectedExam);
    if (scoped.length === 0) {
      throw new Error(`No subjects found for exam "${selectedExam}" in course structure.`);
    }
    structure = { ...structure, subjects: scoped };
    console.log(`[generation] Scoped to exam "${selectedExam}": ${scoped.length} subjects`);
  }

  // Topic-wise: scope to the subjects/topics the user picked (config.topic_selection
  // is a map of subject name -> selected topic names). Empty/absent means "all".
  const topicSelection = jobConfig.topic_selection as Record<string, string[]> | undefined;
  if (topicSelection && Object.keys(topicSelection).length > 0) {
    const allSubjects = (structure.subjects as Array<Record<string, unknown>>) || [];
    const filtered = allSubjects
      .filter((s) => topicSelection[s.name as string]?.length)
      .map((s) => {
        const picked = topicSelection[s.name as string];
        const topics = ((s.topics as Array<Record<string, unknown>>) || []).filter((t) => picked.includes(t.name as string));
        return { ...s, topics };
      })
      .filter((s) => (s.topics as unknown[]).length > 0);
    if (filtered.length === 0) {
      throw new Error('No matching subjects/topics found for the selected scope.');
    }
    structure = { ...structure, subjects: filtered };
    const topicCount = filtered.reduce((n, s) => n + (s.topics as unknown[]).length, 0);
    console.log(`[generation] Scoped to selection: ${filtered.length} subjects, ${topicCount} topics`);
  }

  // Step 1: Build subject tasks — topic-wise uses course structure directly, mock exam uses exam format
  console.log(`Building subject tasks for ${courseName} (${jobType})...`);
  const tasks = jobType === 'topic_wise' || jobType === 'topic_qbank'
    ? await buildTopicWiseTasks(structure, examFormat, courseName, (jobConfig.questions_per_topic as number) || 5)
    : await buildSubjectTasks(examFormat, structure, examFormat, courseName);

  // Attach guidelines to each task, and let the guidelines drive the format mix
  // (guidelines are authoritative on formats). Grouped formats (passage_set, …) are
  // routed ONLY to the subjects that actually use them; all other subjects get the
  // standalone mix with grouped formats excluded — so passage_set concentrates in
  // the reading subjects instead of diluting across every subject.
  if (Object.keys(guidelines).length > 0) {
    // Which grouped formats are actually CLAIMED by a subject (via the analysis's
    // question_groups.applies_to_subjects)? Only those are removed from the general
    // per-subject mix. A grouped format the guidelines declared but no subject
    // claimed (e.g. an exam-wide "integrated set" with no subject mapping) must
    // still be generated across subjects rather than silently dropped.
    // Subject-routing gives a matched subject 100% of the grouped format. That is
    // right only when the format is CONFINED to a subset of subjects (LSAT reading
    // subjects ARE entirely passage sets). A group spanning (nearly) every subject
    // — e.g. Bar integrated sets, which touch all doctrinal subjects but are only
    // 30% of the exam — must instead follow the weighted mix, or every subject
    // would become 100% case_study.
    const matchCount = new Map<string, number>();
    for (const task of tasks) {
      const g = subjectAwareGroupedAllocation(task.subject, task.num_questions, guidelines, examFormat);
      if (g && g.length > 0) matchCount.set(g[0].slug, (matchCount.get(g[0].slug) || 0) + 1);
    }
    const exclusivityCap = Math.max(1, Math.floor(tasks.length * 0.6));
    const routedGrouped = new Set<string>();
    for (const [slug, n] of matchCount) if (n <= exclusivityCap) routedGrouped.add(slug);
    for (const [slug, n] of matchCount) {
      if (!routedGrouped.has(slug)) console.log(`  [Alloc] ${slug} spans ${n}/${tasks.length} subjects — exam-wide, using weighted mix instead of subject routing`);
    }
    for (const task of tasks) {
      task.guidelines = guidelines;
      const grouped = subjectAwareGroupedAllocation(task.subject, task.num_questions, guidelines, examFormat);
      if (grouped && grouped.length > 0 && routedGrouped.has(grouped[0].slug)) { task.question_type_allocations = grouped; continue; }
      const gAlloc = allocationsFromGuidelines(task.num_questions, guidelines, { excludeFormats: routedGrouped });
      if (gAlloc && gAlloc.length > 0) task.question_type_allocations = gAlloc;
    }
  }

  const totalSubjects = tasks.length;

  if (totalSubjects === 0) {
    throw new Error('No subjects found to generate questions for. Check course structure.');
  }

  // Mark as running
  runningJobs.set(jobId, { status: 'generating', completed: 0, total: totalSubjects });

  // Step 2: Fire off all professors in parallel (non-blocking)
  runAllProfessors(jobId, courseId, tasks, courseName).catch(async (e) => {
    const errMsg = e instanceof Error ? e.message : 'Generation failed';
    console.error('runAllProfessors failed:', errMsg);
    runningJobs.set(jobId, { status: 'failed', completed: 0, total: totalSubjects });
    await supabase.from('qb_jobs').update({
      status: 'failed',
      error: errMsg,
      progress: { step: errMsg, message: errMsg },
    }).eq('id', jobId);
  });

  return { status: 'generating', completed: 0, total: totalSubjects };
}
