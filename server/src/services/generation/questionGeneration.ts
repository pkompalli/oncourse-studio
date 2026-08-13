import { orCall, MODELS } from '../llm/openrouter.js';
import { supabase } from '../../db/supabase.js';
import { startTracking, getStepTokens } from '../llm/tokenTracker.js';

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
- If the exam uses long vignettes, your question_style should describe clinical scenario construction
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
      image_types: [`${subjectName} clinical photograph`, `${subjectName} diagnostic image`, 'histology slide', 'radiograph', 'diagram'],
      image_question_focus: `Identifying key diagnostic findings in ${subjectName}`,
      distractor_archetypes: ['related condition with similar presentation', 'correct diagnosis wrong management', 'partial knowledge trap', 'common misconception'],
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

function buildFormatSchema(allocations: QuestionTypeAllocation[]): string {
  if (allocations.length === 1 && allocations[0].slug === 'mcq_single') {
    // Pure MCQ — use the original compact schema
    const numOpts = allocations[0].num_options || 4;
    const optLetters = 'ABCDEFGH'.slice(0, numOpts).split('').map((l) => `"${l}. ..."`).join(', ');
    return `{
  "format_type":    "mcq_single",
  "question":       "<stem>",
  "options":        [${optLetters}],
  "correct_answer": "A",
  "explanation":    "<MUST: (1) justify why the correct answer is right, (2) explain why EACH distractor is wrong — 3-5 sentences>",
  "difficulty":     "<easy|medium|hard>",
  "bloom_level":    "<2_understand|3_apply|4_analyze|5_evaluate>",
  "is_image_question": <true|false>,
  "image_type":         "<modality string if image question, else null>",
  "image_search_terms": ["<3-5 specific search terms if image question, else empty array>"]
}`;
  }

  // Multi-format — build schema descriptions for each type
  const schemas: string[] = [];

  for (const alloc of allocations) {
    let schema: string;
    switch (alloc.slug) {
      case 'mcq_single': {
        const numOpts = alloc.num_options || 4;
        const optLetters = 'ABCDEFGH'.slice(0, numOpts).split('').map((l) => `"${l}. ..."`).join(', ');
        schema = `FORMAT: mcq_single (${alloc.name}) — ${alloc.count} question(s)
{
  "format_type": "mcq_single",
  "question": "<stem>",
  "options": [${optLetters}],
  "correct_answer": "<letter>",
  "explanation": "<MUST: (1) justify why the correct answer is right, (2) explain why EACH distractor is wrong — 3-5 sentences>",
  "difficulty": "<easy|medium|hard>",
  "bloom_level": "<2_understand|3_apply|4_analyze|5_evaluate>",
  "is_image_question": <true|false>,
  "image_type": "<if image, else null>",
  "image_search_terms": [<if image, else []>]
}`;
        break;
      }
      case 'sata':
      case 'mcq_multi':
        schema = `FORMAT: ${alloc.slug} (${alloc.name}) — ${alloc.count} question(s)
{
  "format_type": "${alloc.slug}",
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
- Use "text_targets" type (default) when the candidate clicks a discrete text element (an order line, a charting entry, a lab value, a medication record row).
- Use "image_regions" type ONLY for genuine photos/figures with no discrete text elements (wound, ECG strip, anatomy diagram).
- FORBIDDEN: answer.region, answer.label, answer.landmark — these are rejected by the contract.

Schema for text_targets (default, covers majority of hot-spots):
{
  "format_type": "hot_spot",
  "question": "<stem asking the candidate to click/select the correct item>",
  "stimulus_type": "text_targets",
  "stimulus_title": "<title of the displayed record/table — e.g. 'Medication Administration Record'>",
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
  "theme": "<the theme/category — e.g. 'Diagnosis', 'Drug mechanism'>",
  "option_list": ["A. <option 1>", "B. <option 2>", "C. <option 3>", "D. <option 4>", "E. <option 5>"],
  "scenarios": [
    {"stem": "<clinical scenario 1>", "correct_answer": "C"},
    {"stem": "<clinical scenario 2>", "correct_answer": "A"}
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
  • Each sub-question MUST have a "cjmm_step" tag indicating which Clinical Judgment step it tests
  • The overall "explanation" covers the clinical reasoning thread across the full case
{
  "format_type": "case_study",
  "case_narrative": "<detailed patient/scenario unfolding across time — include vitals, labs, history, and evolving clinical data>",
  "sub_questions": [
    {
      "question": "<sub-question 1 — e.g. 'Which assessment finding requires immediate follow-up?'>",
      "format_type": "mcq_single",
      "options": ["A. ...", "B. ...", "C. ...", "D. ..."],
      "correct_answer": "B",
      "rationale": "<Why B is correct AND why A, C, D are wrong — 2-4 sentences>",
      "cjmm_step": "<Recognize Cues | Analyze Cues | Prioritize Hypotheses | Generate Solutions | Take Action | Evaluate Outcomes>",
      "difficulty": "<easy|medium|hard>"
    },
    {
      "question": "<sub-question 2>",
      "format_type": "sata",
      "options": ["A. ...", "B. ...", "C. ...", "D. ...", "E. ..."],
      "correct_answers": ["A", "C"],
      "rationale": "<Why A and C are correct AND why B, D, E are wrong>",
      "cjmm_step": "<step>",
      "difficulty": "<easy|medium|hard>"
    },
    {
      "question": "<sub-question 3>",
      "format_type": "ordered_response",
      "items": ["<step 1>", "<step 2>", "<step 3>", "<step 4>"],
      "correct_order": [3, 1, 4, 2],
      "rationale": "<Why this order is correct>",
      "cjmm_step": "<step>",
      "difficulty": "<easy|medium|hard>"
    },
    {
      "question": "<sub-question 4 — e.g. 'Click the medication order the nurse should question'>",
      "format_type": "hot_spot",
      "stimulus": {
        "type": "text_targets",
        "title": "<record/table title>",
        "targets": [
          { "id": "item-1", "text": "<clickable text 1>" },
          { "id": "item-2", "text": "<clickable text 2>" },
          { "id": "item-3", "text": "<clickable text 3>" }
        ]
      },
      "answer": { "correct_ids": ["item-2"] },
      "scoring": "dichotomous",
      "rationale": "<Why item-2 is correct AND why others are wrong>",
      "cjmm_step": "<step>",
      "difficulty": "<easy|medium|hard>"
    }
  ],
  "explanation": "<overall clinical reasoning thread tying the case together — 3-5 sentences>",
  "bloom_level": "<4_analyze|5_evaluate>",
  "difficulty": "<medium|hard>",
  "is_image_question": <true|false>,
  "image_type": "<if image, else null>",
  "image_search_terms": [<if image, else []>]
}`;
        break;
      default:
        schema = `FORMAT: ${alloc.slug} (${alloc.name}) — ${alloc.count} question(s)
${alloc.description ? `Description: ${alloc.description}` : ''}
${alloc.answer_format ? `Answer format: ${alloc.answer_format}` : ''}
{
  "format_type": "${alloc.slug}",
  "question": "<stem>",
  "answer": "<answer in the format described above>",
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
    if (stem.clinical_scenario_depth) stemRules.push(`Clinical depth: ${stem.clinical_scenario_depth}`);
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
You MUST NOT create questions that test the same clinical fact, scenario, or concept.
Each of your questions must cover a DIFFERENT clinical fact.

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

  const formatSchemas = buildFormatSchema(allocations);

  return `You are a Professor of ${subject} and a ${examinerRole}.
You are now setting your department's contribution to this year's ${courseName}${boardNote} question paper${batchNote}.

EXAMINATION BRIEF
─────────────────
Exam:             ${courseName}
Your allocation:  ${numQ} questions
Format:           ${formatBrief}
Marking scheme:   ${ep.marking || 'Standard positive marking'}
Image-based Qs:   ${numImgQ} of your ${numQ} questions must be marked is_image_question: true
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
${buildGuidelinesSection(subjectTask.guidelines)}
EXPLANATION / RATIONALE — MANDATORY RULES
──────────────────────────────────────────
Every explanation MUST:
1. Justify WHY the correct answer is right (clinical reasoning, mechanism, evidence)
2. Explain WHY EACH distractor/wrong option is wrong (name each option and state the specific reason)
3. Be 3-5 sentences minimum for standalone questions
4. For case_study: each sub_question MUST have its own "rationale" field — the overall "explanation" is for the clinical thread only

ANSWER INTEGRITY — MANDATORY RULES
────────────────────────────────────
1. STEM MUST NOT NAME THE DIAGNOSIS (for choice-based formats)
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
  const match = text.match(/\[[\s\S]*\]/);
  if (match) text = match[0];
  const qs = JSON.parse(text.trim());
  if (!Array.isArray(qs)) throw new Error('non-list');
  return qs;
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
      const response = await orCall(MODELS.GENERATOR, '', prompt, { maxTokens: 8000, temperature: 0.7 });
      console.log(`  [Gen] ${subject} batch ${b + 1}: got response (${response.content.length} chars)`);
      let qs: Record<string, unknown>[];
      try {
        qs = parseQuestions(response.content);
      } catch (parseErr) {
        console.error(`  [Gen] ${subject} batch ${b + 1}: PARSE FAILED — ${parseErr}`);
        console.error(`  [Gen] Response preview: ${response.content.slice(0, 300)}...`);
        // Retry with lower temperature
        const response2 = await orCall(MODELS.GENERATOR, '', prompt, { maxTokens: 8000, temperature: 0.5 });
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
        const response2 = await orCall(MODELS.GENERATOR, '', prompt, { maxTokens: 8000, temperature: 0.5 });
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
      // Ensure sub_questions preserve rationale and cjmm_step fields
      const subs = (q.sub_questions as Array<Record<string, unknown>>) || [];
      const enrichedSubs = subs.map((sq) => {
        const base: Record<string, unknown> = {
          question: sq.question || sq.stem || '',
          format_type: sq.format_type || 'mcq_single',
          options: sq.options,
          correct_answer: sq.correct_answer,
          correct_answers: sq.correct_answers,
          items: sq.items,
          correct_order: sq.correct_order,
          blanks: sq.blanks,
          rationale: sq.rationale || sq.explanation || '',
          cjmm_step: sq.cjmm_step || null,
          difficulty: sq.difficulty || null,
        };
        // Preserve hot_spot stimulus contract fields
        if (sq.format_type === 'hot_spot') {
          base.stimulus = sq.stimulus || null;
          base.answer = sq.answer || null;
          base.scoring = sq.scoring || 'dichotomous';
          if (typeof sq.rationale === 'object' && sq.rationale !== null && !Array.isArray(sq.rationale)) {
            base.rationale = sq.rationale; // keyed by target id
          }
        }
        return base;
      });
      return {
        case_narrative: (q.case_narrative as string) || (q.question as string) || '',
        sub_questions: enrichedSubs,
        explanation: (q.explanation as string) || '',
      };
    }
    default:
      // Generic fallback — store the entire LLM output as content
      return {
        stem: q.question as string,
        answer: q.answer || q.correct_answer || q.correct_option || '',
        explanation: (q.explanation as string) || '',
        raw: q,
      };
  }
}

// ── Insert questions for a subject into DB ──
async function insertSubjectQuestions(
  questions: Record<string, unknown>[],
  jobId: string,
  courseId: string,
  courseName: string,
  subjectIndex: number
) {
  if (questions.length === 0) return;

  // Pre-resolve all unique format_ids needed
  const slugs = [...new Set(questions.map((q) => (q.format_type as string) || 'mcq_single'))];
  const formatIds: Record<string, string | null> = {};
  for (const slug of slugs) {
    formatIds[slug] = await getFormatId(slug);
  }

  const rows = questions.map((q, idx) => {
    const formatType = (q.format_type as string) || 'mcq_single';
    const isMcq = formatType === 'mcq_single' || formatType === 'mcq_multi' || formatType === 'sata';

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
      is_image_question: (q.is_image_question as boolean) || false,
      image_url: (q.image_url as string) || null,
      image_type: (q.image_type as string) || null,
      image_description: (q.image_description as string) || null,
      image_search_terms: (q.image_search_terms as string[]) || [],
      // Flexible format columns
      format_id: formatIds[formatType] || formatIds['mcq_single'],
      content: buildContentFromQuestion(q),
      tags: {
        subject: q.subject as string,
        topic: (q.topic as string) || '',
        blooms: (q.blooms_level as string) || '',
        difficulty: (q.difficulty as number) || 1,
        format_type: formatType,
      },
      media: (q.is_image_question && q.image_type) ? [{
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
  // Grouped by subject+topic for precise deduplication
  const { data: existingQs } = await supabase
    .from('qb_questions')
    .select('subject, topic, question')
    .eq('course_id', courseId)
    .neq('job_id', jobId);

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
      await insertSubjectQuestions(questions, jobId, courseId, courseName, idx);

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

  // Image pipeline: generate images for image questions (with timeout)
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
            message: `Generating images for image-based questions...`,
          },
        })
        .eq('id', jobId);

      // 5-minute timeout for image pipeline to prevent job getting stuck
      const IMAGE_TIMEOUT_MS = 5 * 60 * 1000;
      const imgPromise = processAllImageQuestions(jobId);
      const timeoutPromise = new Promise<{ totalProcessed: number; totalSuccess: number; totalFailed: number }>((resolve) =>
        setTimeout(() => resolve({ totalProcessed: 0, totalSuccess: 0, totalFailed: -1 }), IMAGE_TIMEOUT_MS)
      );
      const imgResult = await Promise.race([imgPromise, timeoutPromise]);
      if (imgResult.totalFailed === -1) {
        console.warn('Image pipeline timed out after 5 minutes — proceeding to review');
      } else {
        console.log(`🎨 Image pipeline: ${imgResult.totalSuccess}/${imgResult.totalProcessed} images generated`);
      }
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

export async function generateBatchForJob(
  jobId: string,
  courseId: string
): Promise<{ status: string; completed: number; total: number; message?: string; completed_subjects?: string[]; phase?: string }> {
  // If already running or complete, return current status
  const cached = runningJobs.get(jobId);
  if (cached) {
    return cached;
  }

  // Check DB status
  const { data: job, error: jobErr } = await supabase
    .from('qb_jobs')
    .select('*')
    .eq('id', jobId)
    .single();
  if (jobErr) throw new Error(jobErr.message);

  if (job.status === 'reviewing' || job.status === 'complete') {
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
  const structure = course.structure as Record<string, unknown>;
  const examFormat = (course.exam_format || {}) as Record<string, unknown>;
  const guidelines = (course.generation_guidelines || {}) as Record<string, unknown>;
  const jobType = (job.type as string) || '';

  // Step 1: Build subject tasks — topic-wise uses course structure directly, mock exam uses exam format
  console.log(`Building subject tasks for ${courseName} (${jobType})...`);
  const jobConfig = (job.config || {}) as Record<string, unknown>;
  const tasks = jobType === 'topic_wise' || jobType === 'topic_qbank'
    ? await buildTopicWiseTasks(structure, examFormat, courseName, (jobConfig.questions_per_topic as number) || 5)
    : await buildSubjectTasks(examFormat, structure, examFormat, courseName);

  // Attach guidelines to each task
  if (Object.keys(guidelines).length > 0) {
    for (const task of tasks) {
      task.guidelines = guidelines;
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
