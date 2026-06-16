import { orCall, MODELS } from '../llm/openrouter.js';

/**
 * MODULE 2: Exam Format Analyzer
 *
 * Two-phase approach:
 * Phase 1: Generate a detailed exam pattern profile (testing philosophy, stem style, etc.)
 * Phase 2: Extract structured numbers (bloom's, difficulty, image % by subject)
 *
 * The pattern profile is stored alongside the numbers and threaded into generation prompts.
 */
export async function analyzeExamFormat(
  courseName: string,
  courseStructure: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const subjects = (courseStructure.subjects as Array<{ name: string }>) || [];
  const subjectsList = subjects.map((s) => s.name);
  const subjectsStr = subjectsList.length > 0 ? subjectsList.slice(0, 15).join(', ') : 'various subjects';

  // ── Phase 1: Deep exam pattern profile ──
  const patternPrompt = `You are a psychometrician and exam analysis expert. Produce a DETAILED question-pattern profile for: ${courseName}

SUBJECTS: ${subjectsStr}

You must research and describe the SPECIFIC, DISTINCTIVE patterns of ${courseName} — not generic MCQ advice.
Different exams test very differently even within medicine. For example:
- NEET PG: Direct recall-heavy, one-liner stems, tests factual knowledge (drugs, doses, classifications, eponymous signs), minimal clinical reasoning, rapid-fire format
- INICET: Conceptual and analytical, longer stems, tests understanding of mechanisms and "why", pattern-recognition over memorisation
- USMLE Step 1: Basic science mechanisms applied to clinical vignettes, 2-3 step reasoning, integrates across disciplines
- USMLE Step 2 CK: Long clinical vignettes (100+ words), next-best-step management, requires synthesising history/exam/labs
- UKMLA AKT: Scenario-based primary care focus, 5 options, tests clinical decision-making in GP/community settings
- PLAB: UK-focused clinical scenarios, patient safety emphasis, NHS-specific guidelines

Return ONLY a JSON object:
{
  "exam_board": "<official examining body — e.g. NBE, NBME, GMC>",
  "examiner_role": "<how to roleplay the question-setter — e.g. 'senior NBE examiner', 'NBME item-writer', 'GMC assessment panel member'>",
  "testing_philosophy": "<3-4 sentences: What does this exam fundamentally test? Recall vs reasoning vs clinical decision-making? Speed vs depth? What separates a pass from a fail?>",
  "stem_style": {
    "typical_format": "<e.g. 'one-liner direct question', 'short clinical scenario (2-3 lines)', 'long clinical vignette (5-8 lines)', 'two-step reasoning stem'>",
    "avg_stem_words": <integer>,
    "lead_in_patterns": ["<typical question endings — e.g. 'What is the most likely diagnosis?', 'Which of the following is the next best step?', 'What is the mechanism of action?'>"],
    "what_the_stem_tests": "<1-2 sentences: Does the stem present a novel scenario requiring reasoning, or test direct factual recall? Does it require integrating multiple data points?>",
    "common_stem_structures": ["<e.g. 'Patient demographics → presentation → single finding → ask diagnosis', 'Drug name → ask side effect', 'Lab values → ask interpretation'>"]
  },
  "option_style": {
    "num_options": <integer — MUST match official spec>,
    "option_characteristics": "<how options are constructed — e.g. 'short single-word/phrase options', 'options are diagnoses', 'options are management steps', 'mix of short and medium-length'>",
    "distractor_philosophy": "<how wrong options are designed — e.g. 'close differentials that share 2-3 features', 'drugs from same class', 'factually true but not the BEST answer'>",
    "typical_option_length": "<e.g. '2-5 words per option', '1-2 sentences per option'>"
  },
  "recall_vs_reasoning_ratio": {
    "direct_recall_pct": <integer — % of questions that are pure factual recall>,
    "applied_reasoning_pct": <integer — % requiring clinical reasoning or application>,
    "description": "<1-2 sentences explaining the balance>"
  },
  "distinctive_patterns": [
    "<pattern 1: something UNIQUE to this exam — e.g. 'NEET PG frequently tests exact drug doses and classification ranks', 'USMLE Step 1 loves mechanism-of-action vignettes where you identify the drug from its effect'>",
    "<pattern 2>",
    "<pattern 3>",
    "<pattern 4>",
    "<pattern 5>"
  ],
  "what_NOT_to_do": [
    "<anti-pattern 1: something that would make questions NOT match this exam — e.g. 'Do not write long clinical vignettes for NEET PG — they use short direct stems', 'Do not test management algorithms for USMLE Step 1 — it is basic science focused'>",
    "<anti-pattern 2>",
    "<anti-pattern 3>"
  ],
  "example_stem_templates": [
    "<a realistic example stem pattern (without actual content) showing the structure — e.g. 'A [age]-year-old [gender] presents with [symptom] for [duration]. On examination, [finding]. What is the most likely diagnosis?'>",
    "<template 2>",
    "<template 3>"
  ]
}

Be HIGHLY specific to ${courseName}. If you are unsure about a detail, research it from the official exam body guidelines. Do NOT give generic advice.`;

  const patternResponse = await orCall(MODELS.STRUCTURE, '', patternPrompt, {
    temperature: 0.2,
    maxTokens: 4000,
  });

  let patternText = patternResponse.content.trim();
  if (patternText.includes('```json')) patternText = patternText.split('```json')[1].split('```')[0].trim();
  else if (patternText.includes('```')) patternText = patternText.split('```')[1].split('```')[0].trim();

  let examPattern: Record<string, unknown>;
  try {
    examPattern = JSON.parse(patternText);
  } catch {
    examPattern = {};
  }

  // ── Phase 2: Structured numbers (bloom's, difficulty, image %) ──
  const numOptions = (examPattern.option_style as Record<string, unknown>)?.num_options || 4;

  const formatPrompt = `You are an assessment design expert. Based on the OFFICIAL exam specifications for ${courseName}, provide the structured numerical distributions.

EXAM: ${courseName}
SUBJECTS: ${subjectsStr}
CONFIRMED number of options: ${numOptions}

Return ONLY this JSON:
{
    "question_format": {
        "type": "single_best_answer",
        "num_options": ${numOptions},
        "avg_stem_words": <integer based on this specific exam>,
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
- A recall-heavy exam (e.g. NEET PG) should have high 1_remember + 2_understand.
- A reasoning-heavy exam (e.g. USMLE Step 2 CK) should have high 3_apply + 4_analyze.
- Image percentages vary dramatically by exam and subject. Use your knowledge of ${courseName}.

Generate ONLY the JSON, no other text.`;

  const formatResponse = await orCall(MODELS.STRUCTURE, '', formatPrompt, {
    temperature: 0.2,
    maxTokens: 3000,
  });

  let formatText = formatResponse.content.trim();
  if (formatText.includes('```json')) formatText = formatText.split('```json')[1].split('```')[0].trim();
  else if (formatText.includes('```')) formatText = formatText.split('```')[1].split('```')[0].trim();

  const formatData = JSON.parse(formatText);

  // Merge pattern profile with structured numbers
  return {
    ...formatData,
    exam_pattern: examPattern,
  };
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

  const prompt = `You are an expert on official medical exam blueprints and question patterns.

EXAM: ${courseName}
SUBJECTS (given — do NOT change, add, remove, or rename any):
${subjectsJson}

Return EXACTLY this JSON, filling in all <...> placeholders:

{
    "total_questions": <integer — exact total MCQs in one sitting>,
    "time_minutes": <integer — total exam duration in minutes>,
    "num_options": <integer — options per question, e.g. 4 or 5>,
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
  pattern. Subjects like Radiology, Ophthalmology, Dermatology, Pathology have high image %
  (40-80%). Subjects like Pharmacology, PSM, Psychiatry have low image % (5-15%).
  Use your knowledge of ${courseName} specifically.
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
