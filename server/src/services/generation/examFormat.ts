import { orCall, MODELS } from '../llm/openrouter.js';
import { supabase } from '../../db/supabase.js';

/**
 * MODULE 2: Exam Format Analyzer
 *
 * Three-phase approach:
 * Phase 1: Discover ALL question types/formats used by the exam (not just MCQs)
 * Phase 2: Generate a detailed exam pattern profile (testing philosophy, per-format patterns)
 * Phase 3: Extract structured numbers (bloom's, difficulty, image % by subject)
 *
 * The full format profile is stored alongside the numbers and threaded into generation prompts.
 */

// ── Phase 1: Discover Question Types ──

interface QuestionTypeInfo {
  slug: string;
  name: string;
  percentage: number;
  description: string;
  example_stem?: string;
  answer_format: string;
  num_options?: number;
}

async function discoverQuestionTypes(
  courseName: string,
  subjectsStr: string
): Promise<QuestionTypeInfo[]> {
  const prompt = `You are an expert psychometrician. Analyze the OFFICIAL exam format for: ${courseName}

IMPORTANT: Many exams use MULTIPLE question types, not just standard MCQs.
For example:
- NCLEX-RN uses: Multiple Choice, Select All That Apply (SATA), Ordered Response (drag-and-drop), Fill-in-the-Blank (dosage calculation), Hot Spot (click on image), Matrix/Grid, Graphic/Exhibit, Audio, Cloze (dropdown)
- USMLE uses: Single Best Answer MCQ, Extended Matching Questions (EMQ), Sequential Item Sets
- NEET PG uses: Single Best Answer MCQ (predominantly)
- PLAB uses: Single Best Answer MCQ, Extended Matching Questions
- UKMLA AKT uses: Single Best Answer, Very Short Answer (free text)
- AMC CAT uses: MCQ, Clinical Reasoning problems
- Many nursing/allied health exams use: MCQ, SATA, prioritization/ordering, fill-in-blank, hot-spot, case studies

Research ${courseName} specifically. What question types does it ACTUALLY use?

SUBJECTS: ${subjectsStr}

Return ONLY a JSON array. Each element:
{
  "slug": "<machine_name — e.g. mcq_single, sata, ordered_response, fill_blank, hot_spot, emq, assertion_reason, match, short_answer, case_study, drag_drop, matrix_grid, audio, cloze_dropdown>",
  "name": "<human-readable name — e.g. 'Select All That Apply (SATA)'>",
  "percentage": <integer — approximate % of total exam questions using this type>,
  "description": "<1-2 sentences: how this question type works in ${courseName} specifically>",
  "example_stem": "<a brief example stem pattern (without real content) showing the structure>",
  "answer_format": "<how the answer is structured — e.g. 'single letter A-D', 'multiple correct from list', 'ordered sequence', 'numeric value', 'click coordinates on image', 'free text'>",
  "num_options": <integer or null — number of options if applicable, null if not a choice-based format>
}

RULES:
- Include ALL question types used by ${courseName}, even rare ones
- Percentages must sum to 100
- If ${courseName} uses only standard MCQs, return a single-element array
- Be SPECIFIC to ${courseName} — do not guess or generalize from other exams
- slug should match common format registry names where possible`;

  const response = await orCall(MODELS.STRUCTURE, '', prompt, {
    temperature: 0.2,
    maxTokens: 4000,
  });

  let text = response.content.trim();
  if (text.includes('```json')) text = text.split('```json')[1].split('```')[0].trim();
  else if (text.includes('```')) text = text.split('```')[1].split('```')[0].trim();

  try {
    const types = JSON.parse(text);
    if (!Array.isArray(types) || types.length === 0) {
      return [{ slug: 'mcq_single', name: 'Single Best Answer MCQ', percentage: 100, description: 'Standard multiple choice question with one correct answer.', answer_format: 'single letter', num_options: 4 }];
    }
    // Normalize percentages to sum to 100
    const total = types.reduce((s: number, t: QuestionTypeInfo) => s + (t.percentage || 0), 0);
    if (total > 0 && total !== 100) {
      for (const t of types) t.percentage = Math.round((t.percentage / total) * 100);
    }
    return types;
  } catch {
    return [{ slug: 'mcq_single', name: 'Single Best Answer MCQ', percentage: 100, description: 'Standard multiple choice question.', answer_format: 'single letter', num_options: 4 }];
  }
}

// ── Phase 2: Deep exam pattern profile ──

async function analyzeExamPattern(
  courseName: string,
  subjectsStr: string,
  questionTypes: QuestionTypeInfo[]
): Promise<Record<string, unknown>> {
  const typesDescription = questionTypes
    .map((t) => `- ${t.name} (${t.percentage}%): ${t.description}`)
    .join('\n');

  const primaryType = questionTypes.reduce((a, b) => (a.percentage > b.percentage ? a : b));
  const hasMultipleTypes = questionTypes.length > 1;

  const prompt = `You are a psychometrician and exam analysis expert. Produce a DETAILED question-pattern profile for: ${courseName}

SUBJECTS: ${subjectsStr}

QUESTION TYPES USED BY THIS EXAM:
${typesDescription}

${hasMultipleTypes ? `This exam uses MULTIPLE question formats. Your profile must address patterns for ALL types, not just MCQs.` : ''}

You must research and describe the SPECIFIC, DISTINCTIVE patterns of ${courseName} — not generic advice.

Return ONLY a JSON object:
{
  "exam_board": "<official examining body>",
  "examiner_role": "<how to roleplay the question-setter>",
  "testing_philosophy": "<3-4 sentences: What does this exam fundamentally test? How do the different question types serve this philosophy?>",
  "question_types_summary": "<1-2 sentences summarizing the mix of question types and why the exam uses this combination>",
  "primary_format": {
    "slug": "${primaryType.slug}",
    "stem_style": {
      "typical_format": "<e.g. 'clinical vignette', 'direct question', 'scenario-based'>",
      "avg_stem_words": <integer>,
      "lead_in_patterns": ["<typical question endings>"],
      "what_the_stem_tests": "<1-2 sentences>",
      "common_stem_structures": ["<structure patterns>"]
    },
    "option_style": {
      "num_options": ${primaryType.num_options || 4},
      "option_characteristics": "<how options are constructed>",
      "distractor_philosophy": "<how wrong options are designed>",
      "typical_option_length": "<e.g. '2-5 words per option'>"
    }
  },
${questionTypes.length > 1 ? `  "additional_formats": [
${questionTypes.filter((t) => t.slug !== primaryType.slug).map((t) => `    {
      "slug": "${t.slug}",
      "name": "${t.name}",
      "percentage": ${t.percentage},
      "pattern_notes": "<2-3 sentences: how this specific format works in ${courseName}, what it tests differently from the primary format, any unique constraints>",
      "answer_format": "${t.answer_format}"
    }`).join(',\n')}
  ],` : ''}
  "recall_vs_reasoning_ratio": {
    "direct_recall_pct": <integer>,
    "applied_reasoning_pct": <integer>,
    "description": "<1-2 sentences>"
  },
  "distinctive_patterns": [
    "<pattern 1: something UNIQUE to this exam>",
    "<pattern 2>",
    "<pattern 3>",
    "<pattern 4>",
    "<pattern 5>"
  ],
  "what_NOT_to_do": [
    "<anti-pattern 1>",
    "<anti-pattern 2>",
    "<anti-pattern 3>"
  ],
  "example_stem_templates": [
    "<example stem pattern for the primary format>",
    "<example stem pattern for another format if applicable>",
    "<template 3>"
  ]
}

Be HIGHLY specific to ${courseName}. Do NOT give generic advice.`;

  const response = await orCall(MODELS.STRUCTURE, '', prompt, {
    temperature: 0.2,
    maxTokens: 5000,
  });

  let text = response.content.trim();
  if (text.includes('```json')) text = text.split('```json')[1].split('```')[0].trim();
  else if (text.includes('```')) text = text.split('```')[1].split('```')[0].trim();

  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}

// ── Phase 3: Structured numbers ──

async function extractStructuredNumbers(
  courseName: string,
  subjectsStr: string,
  subjectsList: string[],
  examPattern: Record<string, unknown>,
  questionTypes: QuestionTypeInfo[]
): Promise<Record<string, unknown>> {
  const primaryType = questionTypes.reduce((a, b) => (a.percentage > b.percentage ? a : b));
  const numOptions = primaryType.num_options || (examPattern.primary_format as Record<string, unknown>)?.slug === 'mcq_single' ? 4 : null;

  const recallRatio = examPattern.recall_vs_reasoning_ratio as Record<string, unknown> | undefined;
  const recallPct = (recallRatio?.direct_recall_pct as number) || 0;
  const stemStyle = (examPattern.primary_format as Record<string, unknown>)?.stem_style as Record<string, unknown> | undefined;
  const avgStemWords = (stemStyle?.avg_stem_words as number) || 0;

  const formatPrompt = `You are an assessment design expert. Based on the OFFICIAL exam specifications for ${courseName}, provide the structured numerical distributions.

EXAM: ${courseName}
SUBJECTS: ${subjectsStr}
${numOptions ? `CONFIRMED primary format options: ${numOptions}` : ''}
${recallPct > 0 ? `CONFIRMED recall vs reasoning ratio: ${recallPct}% recall / ${100 - recallPct}% reasoning` : ''}
${avgStemWords > 0 ? `CONFIRMED avg stem words: ~${avgStemWords} words` : ''}

Return ONLY this JSON:
{
    "question_format": {
        "type": "${primaryType.slug}",
        "primary_format_name": "${primaryType.name}",
        ${numOptions ? `"num_options": ${numOptions},` : ''}
        "avg_stem_words": ${avgStemWords > 0 ? avgStemWords : '<integer based on this specific exam>'},
        "uses_vignettes": <true/false>,
        "image_questions_percentage": <integer — overall % of image-based questions in this exam>
    },
    "blooms_distribution": {
        "1_remember": <integer %>,
        "2_understand": <integer %>,
        "3_apply": <integer %>,
        "4_analyze": <integer %>,
        "5_evaluate": <integer %>,
        "6_create": <integer %>,
        "7_integrate": <integer %>
    },
    "difficulty_distribution": {
        "easy": <integer %>,
        "medium": <integer %>,
        "hard": <integer %>
    },
    "image_percentage_by_subject": {
${subjectsList.map((s) => `        "${s}": <integer % of image questions for this subject in ${courseName}>`).join(',\n')}
    }
}

CRITICAL: These numbers must reflect ${courseName} SPECIFICALLY.
- A recall-heavy exam should have high 1_remember + 2_understand.
- A reasoning-heavy exam should have high 3_apply + 4_analyze.

IMAGE PERCENTAGE GUIDANCE — BE ACCURATE:
- image_questions_percentage is the OVERALL % of the entire paper that contains image/visual-based questions.
- Recent trends show INCREASING image percentages.
- Known benchmarks (adjust for ${courseName}):
  * Medical exams: 15-40% overall
  * Nursing exams: 10-25% overall
- Per-subject benchmarks for medical/health exams (adjust for this specific exam):
  * Radiology/Imaging: 70-85%
  * Dermatology: 55-75%
  * Ophthalmology: 45-65%
  * Pathology: 40-55%
  * Anatomy: 35-50%
  * Clinical subjects: 20-35%
  * Basic science subjects: 5-20%
- The weighted average across all subjects MUST approximately equal the overall image_questions_percentage.

Generate ONLY the JSON, no other text.`;

  const response = await orCall(MODELS.STRUCTURE, '', formatPrompt, {
    temperature: 0.2,
    maxTokens: 3000,
  });

  let text = response.content.trim();
  if (text.includes('```json')) text = text.split('```json')[1].split('```')[0].trim();
  else if (text.includes('```')) text = text.split('```')[1].split('```')[0].trim();

  return JSON.parse(text);
}

// ── Ensure format registry has entries for discovered types ──

async function ensureFormatsExist(questionTypes: QuestionTypeInfo[]): Promise<void> {
  for (const qt of questionTypes) {
    const { data: existing } = await supabase
      .from('qb_question_formats')
      .select('id')
      .eq('slug', qt.slug)
      .maybeSingle();

    if (!existing) {
      // Auto-create a format entry from the discovered type
      const schema = buildSchemaForType(qt);
      const display = buildDisplayForType(qt);
      const promptGuide = buildPromptGuideForType(qt);

      await supabase.from('qb_question_formats').insert({
        slug: qt.slug,
        name: qt.name,
        description: qt.description,
        schema,
        example: null,
        display,
        prompt_guide: promptGuide,
        is_builtin: false,
      });
      console.log(`[examFormat] Auto-created format registry entry: ${qt.slug} (${qt.name})`);
    }
  }
}

function buildSchemaForType(qt: QuestionTypeInfo): Record<string, unknown> {
  // Build a reasonable schema based on the question type
  const base: Record<string, unknown> = {
    stem: { type: 'string', required: true },
    explanation: { type: 'string', required: false },
  };

  switch (qt.slug) {
    case 'mcq_single':
      return { ...base, options: { type: 'array', items: { key: 'string', text: 'string' }, required: true }, answer: { type: 'object', properties: { key: 'string' }, required: true } };
    case 'mcq_multi':
    case 'sata':
      return { ...base, options: { type: 'array', items: { key: 'string', text: 'string' }, required: true }, answer: { type: 'object', properties: { keys: 'string[]' }, required: true } };
    case 'ordered_response':
    case 'drag_drop':
      return { ...base, items: { type: 'array', items: 'string', required: true }, correct_order: { type: 'array', items: 'string', required: true } };
    case 'fill_blank':
      return { ...base, answer: { type: 'object', properties: { value: 'string', unit: 'string' }, required: true } };
    case 'hot_spot':
      return { ...base, image_url: { type: 'string', required: true }, answer: { type: 'object', properties: { region: 'string', description: 'string' }, required: true } };
    case 'matrix_grid':
      return { ...base, rows: { type: 'array', items: 'string', required: true }, columns: { type: 'array', items: 'string', required: true }, correct_cells: { type: 'array', items: { row: 'number', col: 'number' }, required: true } };
    case 'emq':
      return { ...base, theme_list: { type: 'array', items: { key: 'string', text: 'string' }, required: true }, scenarios: { type: 'array', items: { text: 'string', answer_key: 'string' }, required: true } };
    case 'cloze_dropdown':
      return { ...base, text_with_blanks: { type: 'string', required: true }, blanks: { type: 'array', items: { id: 'string', options: 'string[]', correct: 'string' }, required: true } };
    case 'short_answer':
      return { ...base, answer: { type: 'object', properties: { text: 'string', keywords: 'string[]' }, required: true } };
    case 'case_study':
      return { ...base, case_narrative: { type: 'string', required: true }, sub_questions: { type: 'array', items: { type: 'string', stem: 'string', answer: 'object' }, required: true } };
    default:
      return { ...base, answer_format: { type: 'string', value: qt.answer_format }, answer: { type: 'object', required: true } };
  }
}

function buildDisplayForType(qt: QuestionTypeInfo): Record<string, unknown> {
  const layoutMap: Record<string, string> = {
    mcq_single: 'stem_then_choices',
    mcq_multi: 'stem_then_choices',
    sata: 'stem_then_choices',
    true_false: 'stem_then_boolean',
    match: 'two_column_match',
    assertion_reason: 'assertion_block',
    emq: 'grouped_items',
    fill_blank: 'stem_then_input',
    short_answer: 'stem_then_text',
    ordered_response: 'stem_then_sortable',
    drag_drop: 'stem_then_sortable',
    hot_spot: 'stem_then_image_click',
    matrix_grid: 'stem_then_grid',
    cloze_dropdown: 'inline_dropdowns',
    case_study: 'case_with_sub_questions',
    audio: 'media_then_choices',
  };

  return {
    layout: layoutMap[qt.slug] || 'stem_then_text',
    answer_label: qt.answer_format,
  };
}

function buildPromptGuideForType(qt: QuestionTypeInfo): string {
  return `Generate a ${qt.name} question.
${qt.description}
Answer format: ${qt.answer_format}
${qt.example_stem ? `Example stem pattern: ${qt.example_stem}` : ''}

Return a JSON object with the content following the schema for this format type (slug: ${qt.slug}).`;
}

// ── Main entry point ──

export async function analyzeExamFormat(
  courseName: string,
  courseStructure: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const subjects = (courseStructure.subjects as Array<{ name: string }>) || [];
  const subjectsList = subjects.map((s) => s.name);
  const subjectsStr = subjectsList.length > 0 ? subjectsList.slice(0, 15).join(', ') : 'various subjects';

  // Phase 1: Discover all question types
  console.log(`[examFormat] Phase 1: Discovering question types for ${courseName}...`);
  const questionTypes = await discoverQuestionTypes(courseName, subjectsStr);
  console.log(`[examFormat] Found ${questionTypes.length} question type(s): ${questionTypes.map((t) => `${t.name} (${t.percentage}%)`).join(', ')}`);

  // Ensure format registry has entries for all discovered types
  await ensureFormatsExist(questionTypes);

  // Phase 2: Deep exam pattern profile
  console.log(`[examFormat] Phase 2: Analyzing exam patterns...`);
  const examPattern = await analyzeExamPattern(courseName, subjectsStr, questionTypes);

  // Phase 3: Structured numbers
  console.log(`[examFormat] Phase 3: Extracting structured numbers...`);
  const formatData = await extractStructuredNumbers(courseName, subjectsStr, subjectsList, examPattern, questionTypes);

  // Merge everything
  return {
    ...formatData,
    question_types: questionTypes,
    exam_pattern: examPattern,
  };
}

/**
 * Interpret raw text (any format) as exam format specification.
 * Accepts: plain text descriptions, markdown, exam guidelines, syllabus docs, etc.
 * Uses AI to extract structured exam format from unstructured input.
 */
export async function interpretExamFormatFromText(
  rawText: string,
  courseName: string,
  courseStructure: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const subjects = (courseStructure.subjects as Array<{ name: string }>) || [];
  const subjectsList = subjects.map((s) => s.name);
  const subjectsStr = subjectsList.length > 0 ? subjectsList.slice(0, 15).join(', ') : 'various subjects';

  const prompt = `You are an expert psychometrician. The user has provided a description/specification of the exam format for "${courseName}".

USER-PROVIDED INPUT:
───────────────────
${rawText.slice(0, 8000)}
───────────────────

SUBJECTS IN THE COURSE: ${subjectsStr}

Your task: Extract ALL information from this input and produce a comprehensive exam format specification.

CRITICAL: Pay attention to ALL question types mentioned. Many exams use multiple formats (MCQ, SATA, fill-in-blank, ordering, hot-spot, etc.). Capture every format mentioned.

Return ONLY a JSON object with this structure:
{
  "question_types": [
    {
      "slug": "<machine_name — mcq_single, sata, ordered_response, fill_blank, hot_spot, emq, etc.>",
      "name": "<human-readable name>",
      "percentage": <integer — % of exam using this type>,
      "description": "<how this format works>",
      "answer_format": "<how answers are structured>",
      "num_options": <integer or null>
    }
  ],
  "question_format": {
    "type": "<slug of the primary/dominant question type>",
    "primary_format_name": "<name of primary type>",
    "num_options": <integer if applicable>,
    "avg_stem_words": <integer>,
    "uses_vignettes": <true/false>,
    "image_questions_percentage": <integer>
  },
  "blooms_distribution": {
    "1_remember": <integer %>,
    "2_understand": <integer %>,
    "3_apply": <integer %>,
    "4_analyze": <integer %>,
    "5_evaluate": <integer %>,
    "6_create": <integer %>,
    "7_integrate": <integer %>
  },
  "difficulty_distribution": {
    "easy": <integer %>,
    "medium": <integer %>,
    "hard": <integer %>
  },
  "total_questions": <integer if mentioned, null otherwise>,
  "time_minutes": <integer if mentioned, null otherwise>,
  "negative_marking": "<marking scheme if mentioned, null otherwise>",
  "exam_pattern": {
    "exam_board": "<if mentioned>",
    "testing_philosophy": "<infer from the provided information>",
    "question_types_summary": "<summary of all formats used>",
    "distinctive_patterns": ["<patterns extracted from input>"],
    "what_NOT_to_do": ["<anti-patterns if mentioned>"]
  },
  "image_percentage_by_subject": {
${subjectsList.map((s) => `    "${s}": <integer — estimate based on subject nature and any info provided>`).join(',\n')}
  }
}

RULES:
- Extract as much as possible from the user's input
- For anything not mentioned, make reasonable estimates based on the exam name and context
- question_types percentages must sum to 100
- blooms_distribution must sum to 100
- difficulty_distribution must sum to 100
- If the input mentions specific question counts or distributions, use those exact numbers
- Do NOT ignore non-MCQ formats — they are critical`;

  const response = await orCall(MODELS.STRUCTURE, '', prompt, {
    temperature: 0.2,
    maxTokens: 5000,
  });

  let text = response.content.trim();
  if (text.includes('```json')) text = text.split('```json')[1].split('```')[0].trim();
  else if (text.includes('```')) text = text.split('```')[1].split('```')[0].trim();

  const parsed = JSON.parse(text);

  // Ensure format registry has entries for discovered types
  if (parsed.question_types && Array.isArray(parsed.question_types)) {
    await ensureFormatsExist(parsed.question_types);
  }

  return parsed;
}

/**
 * MODULE 3: Mock Exam Specs Fetcher
 * Faithful port of V1 fetch_mock_exam_specs() (app.py lines 634-762)
 *
 * Determines total questions, time, scoring, per-subject question counts
 * and image percentages. Post-processes to ensure counts sum correctly.
 */
export async function fetchMockExamSpecs(
  courseName: string,
  subjects: string[]
): Promise<Record<string, unknown>> {
  const subjectsJson = JSON.stringify(subjects.slice(0, 30));

  // Build templates with exact subject names — LLM fills in numbers only
  const qTemplateLines = subjects.map((s) => `        "${s}": <integer>`);
  const qTemplate = qTemplateLines.join(',\n');
  const imgTemplateLines = subjects.map((s) => `        "${s}": <integer>`);
  const imgTemplate = imgTemplateLines.join(',\n');

  const prompt = `You are an expert on official exam blueprints and question patterns.

EXAM: ${courseName}
SUBJECTS (given — do NOT change, add, remove, or rename any):
${subjectsJson}

Return EXACTLY this JSON, filling in all <...> placeholders:

{
    "total_questions": <integer — exact total questions in one sitting>,
    "time_minutes": <integer — total exam duration in minutes>,
    "num_options": <integer — options per question for the primary format, e.g. 4 or 5>,
    "negative_marking": "<string — e.g. '-1 for wrong, +4 correct' or 'None'>",
    "scoring_note": "<one-line summary of marking scheme>",
    "subject_question_counts": {
${qTemplate}
    },
    "subject_image_pct": {
${imgTemplate}
    },
    "exam_notes": "<one or two sentences on format/pattern>"
}

RULES:
- subject_question_counts: distribute total_questions across the given subjects based on the
  official exam blueprint. Use the EXACT subject keys shown above — do NOT rename them.
  Every subject MUST have at least 1 question. The values MUST sum to total_questions.
- subject_image_pct: percentage of image-based questions for EACH subject based on this exam's
  pattern.
- Output ONLY the JSON block.`;

  const searchPrompt =
    `Using your detailed knowledge of the official ${courseName} exam pattern — total questions, ` +
    `subject-wise distribution, duration, scoring scheme, and the proportion of image-based questions — ` +
    `answer this:\n\n${prompt}`;

  const response = await orCall(MODELS.STRUCTURE, '', searchPrompt, {
    temperature: 0.2,
    maxTokens: 3000,
  });

  let text = response.content.trim();
  if (text.includes('```json')) {
    text = text.split('```json')[1].split('```')[0].trim();
  } else if (text.includes('```')) {
    text = text.split('```')[1].split('```')[0].trim();
  }

  const specs = JSON.parse(text) as Record<string, unknown>;
  const totalQ = (specs.total_questions as number) || 200;

  // ── Extract LLM's per-subject question counts and image percentages ──
  const llmCounts = (specs.subject_question_counts as Record<string, number>) || {};
  const llmImgPct = (specs.subject_image_pct as Record<string, number>) || {};

  function matchLlmKey(canonical: string, llmDict: Record<string, number>): number | null {
    if (canonical in llmDict) return llmDict[canonical];
    const cl = canonical.toLowerCase().trim();
    for (const [k, v] of Object.entries(llmDict)) {
      if (k.toLowerCase().trim() === cl) return v;
    }
    return null;
  }

  // Build question counts — every subject must have at least 1
  const subjectCounts: Record<string, number> = {};
  for (const s of subjects) {
    const val = matchLlmKey(s, llmCounts);
    subjectCounts[s] = val !== null ? Math.max(1, Math.round(val)) : 1;
  }

  // Adjust counts to sum to totalQ
  const currentSum = Object.values(subjectCounts).reduce((a, b) => a + b, 0);
  if (currentSum !== totalQ && currentSum > 0) {
    const factor = totalQ / currentSum;
    const scaled: Record<string, number> = {};
    for (const [s, c] of Object.entries(subjectCounts)) {
      scaled[s] = Math.max(1, Math.round(c * factor));
    }
    let diff = totalQ - Object.values(scaled).reduce((a, b) => a + b, 0);
    const sortedSubjs = Object.keys(scaled).sort((a, b) => scaled[b] - scaled[a]);
    for (const s of sortedSubjs) {
      if (diff === 0) break;
      if (diff > 0) {
        scaled[s] += 1;
        diff -= 1;
      } else if (scaled[s] > 1) {
        scaled[s] -= 1;
        diff += 1;
      }
    }
    Object.assign(subjectCounts, scaled);
  }

  // Build image percentages per subject
  const imgBySubj: Record<string, number> = {};
  for (const s of subjects) {
    const val = matchLlmKey(s, llmImgPct);
    imgBySubj[s] = val !== null ? Math.round(val) : 20; // default 20%
  }

  // Build subject_distribution
  const subjectDist: Record<string, { questions: number; percentage: number; image_pct: number }> = {};
  let totalImgQ = 0;
  for (const s of subjects) {
    const qCount = subjectCounts[s];
    const pct = Math.round((qCount / totalQ) * 1000) / 10;
    const subjImgPct = imgBySubj[s];
    subjectDist[s] = {
      questions: qCount,
      percentage: pct,
      image_pct: subjImgPct,
    };
    totalImgQ += Math.round((qCount * subjImgPct) / 100);
  }

  specs.subject_distribution = subjectDist;
  specs.image_questions_total = totalImgQ;

  return specs;
}
