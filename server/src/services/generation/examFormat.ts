import { orCall, MODELS } from '../llm/openrouter.js';
import { supabase } from '../../db/supabase.js';
import { resolveFormat, resolveQuestionType, canonicalizeFormatSlug } from './formatContracts.js';
import { rescaleToTotal } from './examSize.js';

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
  /** Typical scored questions one unit yields — the FLOOR when no max is given. */
  items_per_unit?: number;
  /** Set length as a RANGE where the exam varies (a CFA vignette runs 4 OR 6). */
  items_per_unit_min?: number;
  items_per_unit_max?: number;
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

IMPORTANT: Many exams use MULTIPLE question types, not just standard MCQs. Examples across disciplines (do NOT assume ${courseName} matches any of these — research the real exam):
- CPA (accounting): Multiple-Choice Questions + Task-Based Simulations (document review, journal entries, form completion)
- CFA (finance): Single Best Answer MCQ; constructed-response essays (Level III)
- LSAT / bar (law): Logical Reasoning sets, Reading Comprehension, Logic Games; essay/MPT
- NCLEX-RN (nursing): MCQ, Select All That Apply (SATA), Ordered Response, Fill-in-the-Blank, Hot Spot, Matrix/Grid, Cloze, case studies
- USMLE / UKMLA (medical): Single Best Answer MCQ, Extended Matching Questions (EMQ), Sequential Item Sets, Very Short Answer
- Engineering (FE/PE): MCQ, numeric-entry, multiple-correct

Research ${courseName} specifically. What question types does it ACTUALLY use?

SUBJECTS: ${subjectsStr}

Return ONLY a JSON array. Each element:
{
  "slug": "<machine_name — e.g. mcq_single, sata, ordered_response, fill_blank, hot_spot, emq, assertion_reason, match, short_answer, case_study, task_based_simulation, passage_set, performance_task, constructed_response, drag_drop, matrix_grid, audio, cloze_dropdown>",
  "name": "<human-readable name — e.g. 'Select All That Apply (SATA)'>",
  "percentage": <integer — this type's share of the exam's SCORED WEIGHT / testing emphasis, NOT its raw item count. If a handful of long tasks consume roughly a third of scored time, that is ~33 even though they may be only 2 of 128 printed items. All percentages must sum to 100.>,
  "items_per_unit": <integer — how many SEPARATELY SCORED questions ONE item of this type yields: 1 for a standalone question or a single extended task; the typical number of sub-questions for an integrated set / case study / passage set (e.g. 6)>,
  "items_per_unit_min": <integer or null — if set length VARIES on this exam, the smallest a set can be>,
  "items_per_unit_max": <integer or null — if set length VARIES, the largest. Give the real RANGE rather than one number whenever the exam varies (a CFA Level II vignette carries 4 OR 6 items, so min 4 max 6). Set both equal ONLY where the exam fixes the length exactly. Leave BOTH null when you only know the typical size — a wrong maximum REJECTS valid longer sets>,
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
    // Canonicalize slugs to the fixed registry and MERGE any that collapse to the
    // same canonical type (e.g. mcq_single_lr + mcq_shared_stimulus → mcq_single /
    // passage_set) so every declared question type is a real, schema-backed format.
    const merged = new Map<string, QuestionTypeInfo>();
    for (const t of types as QuestionTypeInfo[]) {
      // Resolve by STRUCTURE (name + description + answer_format), not just the slug,
      // so shared-stimulus sets and constructed work products map correctly even when
      // the LLM invents a slug (e.g. integrated_question_set, performance_task).
      const slug = resolveFormat({ slug: t.slug, name: t.name, description: t.description, answer_format: t.answer_format });
      const existing = merged.get(slug);
      if (existing) {
        existing.percentage = (existing.percentage || 0) + (t.percentage || 0);
      } else {
        const num = (v: unknown) => (Number(v) > 0 ? Number(v) : undefined);
        const mn = num(t.items_per_unit_min);
        const mx = num(t.items_per_unit_max);
        merged.set(slug, {
          ...t, slug,
          items_per_unit: num(t.items_per_unit) ?? mn,
          items_per_unit_min: mn,
          // A max below the min is a modelling slip, not a cap — drop it rather than
          // materialise a schema that rejects every set.
          items_per_unit_max: mx && (!mn || mx >= mn) ? mx : undefined,
        });
      }
    }
    const canon = [...merged.values()];
    // Normalize percentages to sum to 100
    const total = canon.reduce((s: number, t: QuestionTypeInfo) => s + (t.percentage || 0), 0);
    if (total > 0 && total !== 100) {
      for (const t of canon) t.percentage = Math.round((t.percentage / total) * 100);
    }
    return canon;
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
  "structure_overview": "<2-4 sentences describing HOW the exam's questions are ORGANIZED: which are standalone vs GROUPED under a shared stimulus (a reading passage, a case scenario, a set of exhibits/documents, a data set, an image), and the typical size of each group. Be concrete about grouping — this is the exam's structure in words.>",
  "question_groups": [
    {
      "stimulus_type": "<reading_passage | case_scenario | exhibit_set | data_set | image>",
      "members_per_group": [<min int>, <max int>],
      "member_formats": ["<format slugs used inside the group, e.g. mcq_single, sata>"],
      "shared_stimulus_words": [<min int>, <max int>],
      "applies_to_subjects": ["<EXACT subject name(s) from the course structure whose questions are delivered as THIS kind of group — e.g. the reading-comprehension subjects. Copy names verbatim from the structure. Empty only if grouping spans no identifiable subject.>"],
      "description": "<1-2 sentences: what the shared stimulus is and how its questions relate to it>"
    }
  ],
  "primary_format": {
    "slug": "${primaryType.slug}",
    "stem_style": {
      "typical_format": "<e.g. 'scenario/vignette', 'direct question', 'exhibit/document-based'>",
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

"question_groups" MUST be an EMPTY array [] if this exam has NO shared-stimulus grouping (every question standalone). Only include a group entry for a stimulus genuinely shared by MULTIPLE sibling questions (e.g. LSAT/GRE/GMAT reading passages, an accounting case, a set of exhibits). Do NOT list standalone formats here.

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
        "image_questions_percentage": <integer — % needing a GENUINE VISUAL (x-ray, ECG, histology, photo, anatomy, a chart/diagram that must be drawn)>,
        "exhibit_questions_percentage": <integer — % needing a DOCUMENT/DATA exhibit rendered as markdown/tables (financial statements, workpapers, schedules, lab reports, records, contracts) — NOT a picture>
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
${subjectsList.map((s) => `        "${s}": <integer % of GENUINE-IMAGE questions for this subject>`).join(',\n')}
    },
    "exhibit_percentage_by_subject": {
${subjectsList.map((s) => `        "${s}": <integer % of DOCUMENT/DATA-exhibit (markdown) questions for this subject>`).join(',\n')}
    }
}

CRITICAL: These numbers must reflect ${courseName} SPECIFICALLY.
- A recall-heavy exam should have high 1_remember + 2_understand.
- A reasoning-heavy exam should have high 3_apply + 4_analyze.

STIMULUS PERCENTAGE GUIDANCE — DISTINGUISH THREE MEDIA, SPECIFIC TO ${courseName} and its ACTUAL conventions:
1) image_questions_percentage = % needing a GENUINE picture/visual (radiograph, ECG, histology, clinical photo, anatomy, a chart/diagram that must be drawn). Medical/engineering exams are high here; accounting/law are usually near ZERO.
2) exhibit_questions_percentage = % where the exam presents a SEPARATE document/table the candidate must open and read — rendered as MARKDOWN tables (financial statements, workpapers, schedules, K-1s, contracts, medication administration records, serial/trended lab tables).
3) Everything else is PURE TEXT (implicitly 100 − image% − exhibit%).

CRITICAL — do NOT over-count exhibits. Data that the exam conventionally weaves INLINE into the vignette prose is TEXT, not an exhibit:
- USMLE/NCLEX/medical: a single set of vitals or a lab panel written in the stem ("Hgb 9.1, WBC 14,200, Cr 2.1…") is INLINE TEXT. Count as an exhibit ONLY when the exam shows a genuinely SEPARATE tab/table (e.g. serial labs across time points). Step 2 CK true separate exhibits are only ~5-8%.
- CPA/CFA/accounting: the exhibits ARE genuinely separate documents (statements, workpapers, schedules) → exhibit% is legitimately HIGH.
- Base each number on how THIS exam actually presents information — not on the presence of numbers/data alone.
- Per-subject: image_percentage_by_subject counts genuine visuals; exhibit_percentage_by_subject counts genuinely-separate document/table stimuli. The two are independent.

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

      // `source` is the real column ('builtin' | 'user_defined' | 'ai_discovered'), and
      // `example` is NOT NULL DEFAULT '{}' — 003_flexible_question_formats.sql:24,27. This
      // insert named `is_builtin` and passed example: null, so it had ALWAYS failed: not one
      // discovered format was ever registered, and getFormatId then fell back to mcq_single's
      // id for every task-based simulation in the CPA bank. The error was never surfaced
      // because the result was not checked.
      const { error: insErr } = await supabase.from('qb_question_formats').insert({
        slug: qt.slug,
        name: qt.name,
        description: qt.description,
        schema,
        example: {},
        display,
        prompt_guide: promptGuide,
        source: 'ai_discovered',
      });
      if (insErr) {
        console.warn(`[examFormat] could not register format "${qt.slug}" — ${insErr.message}`);
        continue;
      }
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
    case 'passage_set':
      return { ...base, passage: { type: 'string', required: true }, sub_questions: { type: 'array', items: { type: 'string', stem: 'string', answer: 'object' }, required: true } };
    case 'performance_task':
      return { ...base, prompt: { type: 'string', required: true }, exhibits: { type: 'array', items: { label: 'string', content: 'string' } }, scoring_rubric: { type: 'string' } };
    case 'constructed_response':
      return { ...base, prompt: { type: 'string', required: true }, scoring_rubric: { type: 'string' } };
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
    task_based_simulation: 'case_with_sub_questions',
    passage_set: 'case_with_sub_questions',
    performance_task: 'exhibits_then_response',
    constructed_response: 'stem_then_text',
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

  // Merge everything. Lift the grouping description to the top level so the
  // guidelines step (and generation) can read it without digging into exam_pattern.
  return {
    ...formatData,
    question_types: questionTypes,
    exam_pattern: examPattern,
    question_groups: (examPattern as Record<string, unknown>).question_groups || [],
    structure_overview: (examPattern as Record<string, unknown>).structure_overview || '',
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

  // Resolve slugs to the canonical registry BEFORE anything is persisted. This path
  // wrote whatever the LLM invented straight into qb_courses.exam_format and then
  // auto-created a qb_question_formats row from it, so a mislabelled slug became
  // permanent — the same way CPA ended up with 'case_study' named "Task-Based
  // Simulation (TBS)". Merge any types that collapse together, as the analysis does.
  if (parsed.question_types && Array.isArray(parsed.question_types)) {
    const merged = new Map<string, QuestionTypeInfo>();
    for (const t of parsed.question_types as QuestionTypeInfo[]) {
      const slug = resolveQuestionType(t as unknown as Record<string, unknown>);
      const existing = merged.get(slug);
      if (existing) existing.percentage = (existing.percentage || 0) + (t.percentage || 0);
      else merged.set(slug, { ...t, slug });
    }
    parsed.question_types = [...merged.values()];
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
  subjects: string[],
  formats: Array<{ slug?: string; name?: string }> = []
): Promise<Record<string, unknown>> {
  const subjectsJson = JSON.stringify(subjects.slice(0, 30));

  // Build templates with exact subject names — LLM fills in numbers only
  const qTemplateLines = subjects.map((s) => `        "${s}": <integer>`);
  const qTemplate = qTemplateLines.join(',\n');
  const imgTemplateLines = subjects.map((s) => `        "${s}": <integer>`);
  const imgTemplate = imgTemplateLines.join(',\n');

  // Per-format ITEM counts. A real exam is specified in items, and percentages cannot
  // express it: CPA AUD is 78 MCQs + 7 simulations, where MCQs are 91.8% of the items
  // but 50% of the score. Ask for the counts directly, keyed by the slugs the analysis
  // already resolved, so nothing downstream has to infer them from a share.
  const fmtSlugs = formats.map((f) => resolveQuestionType(f as Record<string, unknown>)).filter(Boolean);
  const uniqueFmts = [...new Set(fmtSlugs)];
  const fmtTemplate = uniqueFmts.map((s) => `        "${s}": <integer>`).join(',\n');
  const fmtBlock = uniqueFmts.length > 0
    ? `    "format_question_counts": {\n${fmtTemplate}\n    },\n`
    : '';
  const fmtRule = uniqueFmts.length > 0
    ? `\n- format_question_counts: the number of ITEMS of each format in one sitting — the real\n` +
      `  count, NOT a percentage and NOT a share of the score. Use the EXACT format keys shown\n` +
      `  above. The values MUST sum to total_questions. For a grouped format (a case study,\n` +
      `  passage set or task-based simulation) count each GROUPED ITEM once, not its\n` +
      `  sub-questions — e.g. a CPA section with 7 simulations is 7 here.`
    : '';

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
${fmtBlock}    "subject_image_pct": {
${imgTemplate}
    },
    "exam_notes": "<one or two sentences on format/pattern>"
}

RULES:
- subject_question_counts: distribute total_questions across the given subjects based on the
  official exam blueprint. Use the EXACT subject keys shown above — do NOT rename them.
  Every subject MUST have at least 1 question. The values MUST sum to total_questions.${fmtRule}
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
  // Write the resolved total BACK. The default was only ever a local, used to distribute the
  // per-subject counts, so an exam whose length the model declines to name as one integer — a
  // variable-length adaptive exam like NCLEX-RN, correctly — was stored with total_questions
  // null beside a subject_distribution summing to 200. The guidelines step then found no size on
  // record and invented its own (201), so the bank declared a total its own distribution
  // contradicted, in a number belonging to neither.
  specs.total_questions = totalQ;

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
  Object.assign(subjectCounts, rescaleToTotal(subjectCounts, totalQ));

  // Same treatment for the per-format item counts, so the two distributions agree with
  // each other and with the total. Keys are canonicalized because the model answers in
  // whatever vocabulary the prompt's slugs suggested.
  const llmFmtCounts = (specs.format_question_counts as Record<string, number>) || {};
  if (Object.keys(llmFmtCounts).length > 0) {
    const byCanon: Record<string, number> = {};
    for (const [slug, v] of Object.entries(llmFmtCounts)) {
      const canon = canonicalizeFormatSlug(String(slug));
      const n = Math.max(0, Math.round(Number(v) || 0));
      if (!canon || n <= 0) continue;
      byCanon[canon] = (byCanon[canon] || 0) + n;
    }
    specs.format_question_counts = Object.keys(byCanon).length > 0
      ? rescaleToTotal(byCanon, totalQ)
      : undefined;
    if (specs.format_question_counts) {
      const parts = Object.entries(specs.format_question_counts as Record<string, number>)
        .map(([s, n]) => `${s}=${n}`).join(', ');
      console.log(`  [ExamSpecs] ${courseName}: ${totalQ} questions (${parts})`);
    }
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

/**
 * Research EVERY exam of a multi-exam course in one call, sizing each against its own
 * blueprint.
 *
 * "All exams" previously produced a single blended paper — CPA came back as 100 questions
 * drawn from all six sections at once, which is a sittable exam in none of them. A real
 * CPA sitting is one section: AUD is 78 MCQ + 7 TBS, ISC is 82 + 6.
 *
 * Returns the same shape fetchMockExamSpecs does — a flat subject_distribution plus a
 * total — with exam_sizes alongside. Flat works because subject names are unique across a
 * course's exams, so every existing consumer of subject_distribution is unaffected.
 */
async function fetchMockExamSpecsPerExam(
  courseName: string,
  examSubjects: Array<{ exam: string; subjects: string[] }>,
  formats: Array<{ slug?: string; name?: string }>
): Promise<Record<string, unknown>> {
  const fmtSlugs = [...new Set(formats.map((f) => resolveQuestionType(f as Record<string, unknown>)).filter(Boolean))];
  const fmtShape = fmtSlugs.length > 0
    ? `,\n      "format_question_counts": { ${fmtSlugs.map((s) => `"${s}": <integer>`).join(', ')} }`
    : '';

  const examBlocks = examSubjects.map(({ exam, subjects }) =>
    `  "${exam}": {\n      "total_questions": <integer>,\n      "time_minutes": <integer>,\n` +
    `      "subject_question_counts": { ${subjects.map((s) => `"${s}": <integer>`).join(', ')} },\n` +
    `      "subject_image_pct": { ${subjects.map((s) => `"${s}": <integer>`).join(', ')} }${fmtShape}\n    }`
  ).join(',\n');

  const prompt = `You are an expert on official exam blueprints and question patterns.

COURSE: ${courseName}

This course covers ${examSubjects.length} SEPARATE exams. A candidate sits ONE of them at a
time, so each has its OWN paper: its own question count, duration and format mix. Size each
one independently from its official blueprint — do NOT split a single total between them.

Return EXACTLY this JSON, filling in all <...> placeholders:

{
${examBlocks}
}

RULES:
- total_questions: the real number of items in ONE sitting of THAT exam.
- subject_question_counts: distribute that exam's total across ONLY that exam's subjects.
  Use the EXACT subject keys shown. Every subject at least 1. MUST sum to that exam's total.
- subject_image_pct: percentage of image-based questions per subject for that exam.${fmtSlugs.length > 0 ? `
- format_question_counts: the number of ITEMS of each format in that exam — the real count,
  NOT a percentage and NOT a share of the score. Count a grouped item (case study, passage
  set, task-based simulation) ONCE, not its sub-questions. MUST sum to that exam's total.` : ''}
- Output ONLY the JSON block.`;

  const response = await orCall(MODELS.STRUCTURE, '',
    `Using your detailed knowledge of the official ${courseName} exam blueprints — the question count, ` +
    `duration, subject weighting and format mix of EACH of its exams — answer this:\n\n${prompt}`,
    { temperature: 0.2, maxTokens: 6000 });

  let text = response.content.trim();
  if (text.includes('```json')) text = text.split('```json')[1].split('```')[0].trim();
  else if (text.includes('```')) text = text.split('```')[1].split('```')[0].trim();
  const parsed = JSON.parse(text) as Record<string, Record<string, unknown>>;

  const matchKey = (canonical: string, dict: Record<string, unknown>): unknown => {
    if (canonical in dict) return dict[canonical];
    const cl = canonical.toLowerCase().trim();
    for (const [k, v] of Object.entries(dict)) if (k.toLowerCase().trim() === cl) return v;
    return null;
  };

  const examSizes: Record<string, { total_questions: number; time_minutes?: number; format_question_counts?: Record<string, number> }> = {};
  const subjectDist: Record<string, { questions: number; percentage: number; image_pct: number }> = {};
  let grandTotal = 0;

  for (const { exam, subjects } of examSubjects) {
    const block = (matchKey(exam, parsed) as Record<string, unknown>) || {};
    const total = Math.max(subjects.length, Math.round(Number(block.total_questions) || 0) || subjects.length * 5);

    // Subjects: this exam's own total, never a share of the course-wide one.
    const llmCounts = (block.subject_question_counts as Record<string, unknown>) || {};
    const raw: Record<string, number> = {};
    for (const s of subjects) {
      const v = matchKey(s, llmCounts);
      raw[s] = v !== null ? Math.max(1, Math.round(Number(v) || 0)) : 1;
    }
    const counts = rescaleToTotal(raw, total);

    const llmImg = (block.subject_image_pct as Record<string, unknown>) || {};
    for (const s of subjects) {
      const v = matchKey(s, llmImg);
      subjectDist[s] = {
        questions: counts[s],
        percentage: Math.round((counts[s] / total) * 1000) / 10,
        image_pct: v !== null ? Math.round(Number(v) || 0) : 20,
      };
    }

    // Formats: likewise scoped to this exam — ISC's 82/6 must not be averaged with AUD's 78/7.
    const llmFmt = (block.format_question_counts as Record<string, unknown>) || {};
    const byCanon: Record<string, number> = {};
    for (const [slug, v] of Object.entries(llmFmt)) {
      const canon = canonicalizeFormatSlug(String(slug));
      const n = Math.max(0, Math.round(Number(v) || 0));
      if (canon && n > 0) byCanon[canon] = (byCanon[canon] || 0) + n;
    }
    const fmtCounts = Object.keys(byCanon).length > 0 ? rescaleToTotal(byCanon, total) : undefined;

    examSizes[exam] = {
      total_questions: total,
      time_minutes: Math.round(Number(block.time_minutes) || 0) || undefined,
      format_question_counts: fmtCounts,
    };
    grandTotal += total;
    console.log(`  [ExamSpecs] ${exam}: ${total} questions` +
      (fmtCounts ? ` (${Object.entries(fmtCounts).map(([s, n]) => `${s}=${n}`).join(', ')})` : ''));
  }

  let totalImgQ = 0;
  for (const d of Object.values(subjectDist)) totalImgQ += Math.round((d.questions * d.image_pct) / 100);

  return {
    exam_sizes: examSizes,
    total_questions: grandTotal,
    subject_distribution: subjectDist,
    image_questions_total: totalImgQ,
  };
}

/**
 * Merge mock-exam specs (total questions, per-subject and per-format counts) into an
 * analysed exam_format, mapping the per-subject image and exhibit percentages across.
 *
 * Extracted from the exam-format route so the guidelines route can reuse it verbatim to
 * backfill a course analysed in topic-wise mode. That gate meant exam size was decided
 * by the mode chosen at ANALYSIS time and never revisited: CFA, Bar Exam, LSAT, CPA and
 * MCAT all reached mock-exam generation with no total at all, leaving the guidelines LLM
 * to invent one.
 */
export async function withMockExamSpecs(
  examFormat: Record<string, unknown>,
  courseName: string,
  structure: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const allSubjects = (structure.subjects as Array<{ name: string; exam?: string }>) || [];
  const subjects = allSubjects.map((s) => s.name);
  const formats = (examFormat.question_types as Array<{ slug?: string; name?: string }>) || [];

  // A course spanning several exams and scoped to none of them ("All exams") must size
  // each exam against its own blueprint. Scoping to one exam narrows `structure.subjects`
  // upstream in scopeCourseToExam, so this naturally falls back to the single-exam path.
  const byExam = new Map<string, string[]>();
  for (const s of allSubjects) {
    const exam = String(s.exam || '').trim();
    if (!exam || !s.name) continue;
    const list = byExam.get(exam);
    if (list) list.push(s.name); else byExam.set(exam, [s.name]);
  }

  const mockSpecs = byExam.size > 1
    ? await fetchMockExamSpecsPerExam(courseName, [...byExam].map(([exam, subs]) => ({ exam, subjects: subs })), formats)
    : await fetchMockExamSpecs(courseName, subjects, formats);
  const combinedFormat: Record<string, unknown> = { ...examFormat, ...mockSpecs, exam_pattern: examFormat.exam_pattern };

  // A length already on record wins over a freshly fetched one.
  //
  // The guidelines step calls this whenever hasSize is false, and hasSize needs BOTH a total and
  // a subject distribution. A course analysed from a supplied specification arrives with an
  // accurate total and no distribution, so it comes here for the distribution — and the spread
  // above then replaced its total with this call's answer. NCLEX-RN had 150 taken from the real
  // NGN specification overwritten by 200, the default used when a model declines to name one
  // number for a variable-length exam. The caller wanted the missing distribution, not a second
  // opinion on a figure it already had.
  const knownTotal = Number(examFormat.total_questions);
  if (Number.isFinite(knownTotal) && knownTotal > 0 && Number(combinedFormat.total_questions) !== knownTotal) {
    console.log(`  [examFormat] keeping the total already on record (${knownTotal}) over the fetched ${combinedFormat.total_questions}`);
    combinedFormat.total_questions = knownTotal;
  }

  // Override subject_distribution image percentages with Phase 2 data (more accurate)
  const phase2ImgPct = (examFormat.image_percentage_by_subject as Record<string, number>) || {};
  const subjectDist = (combinedFormat.subject_distribution as Record<string, { questions: number; percentage: number; image_pct: number }>) || {};
  let totalImgQ = 0;
  const matchPct = (subjName: string, table: Record<string, number>): number | null => {
    if (subjName in table) return table[subjName];
    const key = subjName.toLowerCase().trim();
    for (const [k, v] of Object.entries(table)) {
      if (k.toLowerCase().trim() === key || k.toLowerCase().includes(key) || key.includes(k.toLowerCase())) return v;
    }
    return null;
  };
  for (const [subjName, dist] of Object.entries(subjectDist)) {
    const imgPct = matchPct(subjName, phase2ImgPct);
    if (imgPct !== null) dist.image_pct = imgPct;
    totalImgQ += Math.round((dist.questions * dist.image_pct) / 100);
  }

  // Map per-subject exhibit (markdown) percentages the same way.
  const phase2ExhPct = (examFormat.exhibit_percentage_by_subject as Record<string, number>) || {};
  for (const [subjName, dist] of Object.entries(subjectDist as Record<string, { exhibit_pct?: number }>)) {
    const exhPct = matchPct(subjName, phase2ExhPct);
    if (exhPct !== null) dist.exhibit_pct = exhPct;
  }

  // Enforce overall image target — scale up per-subject image_pct if weighted average is too low
  const qf = (combinedFormat.question_format as Record<string, number>) || {};
  const targetImgPct = qf.image_questions_percentage || 35;
  const totalQ = Object.values(subjectDist).reduce((sum, d) => sum + d.questions, 0);
  const targetImgQ = Math.round((totalQ * targetImgPct) / 100);
  if (totalImgQ < targetImgQ && totalImgQ > 0) {
    const scaleFactor = targetImgQ / totalImgQ;
    totalImgQ = 0;
    for (const dist of Object.values(subjectDist)) {
      dist.image_pct = Math.min(90, Math.round(dist.image_pct * scaleFactor));
      totalImgQ += Math.round((dist.questions * dist.image_pct) / 100);
    }
  }

  combinedFormat.subject_distribution = subjectDist;
  combinedFormat.image_questions_total = totalImgQ;
  return combinedFormat;
}
