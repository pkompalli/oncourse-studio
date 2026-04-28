import { orCall, MODELS } from '../llm/openrouter.js';

/**
 * MODULE 2: Exam Format Analyzer
 * Faithful port of V1 analyze_exam_format() (app.py lines 474-631)
 *
 * Determines question format, Bloom's distribution, difficulty distribution,
 * and image percentages by subject.
 */
export async function analyzeExamFormat(
  courseName: string,
  courseStructure: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const examType = (courseStructure.exam_type as string) || 'general';
  const domainChars = (courseStructure.domain_characteristics as string) || '';

  const subjects = (courseStructure.subjects as Array<{ name: string }>) || [];
  const subjectsList = subjects.map((s) => s.name);
  const subjectsStr = subjectsList.length > 0 ? subjectsList.slice(0, 10).join(', ') : 'various subjects';

  const formatPrompt = `You are an assessment design expert with access to official exam data. Analyze the exam format for: ${courseName}

COURSE TYPE: ${examType}
DOMAIN CHARACTERISTICS: ${domainChars}
SUBJECTS IN COURSE: ${subjectsStr}

🔍 MANDATORY RESEARCH REQUIREMENT: Use OFFICIAL published exam specifications and statistics for ${courseName}:

**For UKMLA AKT (UK Medical Licensing Assessment Applied Knowledge Test):**
- Source: GMC (General Medical Council), UKMLA blueprint
- Number of options: 5 (A, B, C, D, E) - CONFIRMED from official GMC specification
- Image questions: ~30-40% overall (ECGs, radiology, dermatology, ophthalmology images)
- Question style: Single best answer, clinical scenario-based
- Avg stem: 60-80 words per question

**For NEET PG (National Eligibility cum Entrance Test - Postgraduate):**
- Source: NBE (National Board of Examinations), NEET PG information bulletin
- Number of options: 4 (A, B, C, D) - CONFIRMED from official specification
- Image questions: ~40% overall (varies 10-75% by subject)
- Question style: Single best answer, clinically oriented

**For USMLE (United States Medical Licensing Examination):**
- Source: NBME, USMLE content outline
- Number of options: 4-5 (varies by step)
- Image questions: ~20-30% (anatomical, pathological, radiological images)
- Question style: Clinical vignettes, single best answer

Use the OFFICIAL specification for number of options - this is critical and must be accurate.

Determine the optimal question bank format including:

1. **Question Format**:
   - MCQ type (single best answer, multiple correct, true/false, assertion-reason, etc.)
   - Number of options (typically 4-5)
   - Clinical vignette length (for medical exams)
   - Stem complexity
   - **CRITICAL**: image_questions_percentage - the TYPICAL percentage of image-based questions in this exam overall

2. **Bloom's Taxonomy Distribution**:
   - Level 1 (Remember/Recall): X%
   - Level 2 (Understand): X%
   - Level 3 (Apply): X%
   - Level 4 (Analyze): X%
   - Level 5 (Evaluate): X%
   - Level 6 (Create): X%
   - Level 7 (Integrate/Synthesize): X%

   Consider:
   - Medical exams: Higher emphasis on Apply/Analyze (clinical reasoning)
   - Engineering exams: Balance of Understand/Apply/Analyze
   - Certification exams: Focus on Apply/Evaluate

3. **Difficulty Distribution**:
   - Easy: X%
   - Medium: X%
   - Hard: X%

4. **Image-Based Questions by Subject** (CRITICAL FOR MEDICAL EXAMS):
   Research typical image percentages for each subject. Examples:
   - NEET PG: Radiology ~75%, Ophthalmology ~60%, Medicine ~40%, Biochemistry ~10%
   - USMLE Step 1: Pathology ~30%, Anatomy ~50%, Physiology ~15%

   Provide subject-specific percentages as a map.

5. **Domain-Specific Characteristics**:
   - Medical: Case-based scenarios, image-based questions
   - Engineering: Calculation-based, diagram interpretation
   - Business: Case studies, scenario analysis

OUTPUT FORMAT (strict JSON):
{
    "question_format": {
        "type": "single_best_answer",
        "num_options": 4,
        "avg_stem_words": 50,
        "uses_vignettes": true,
        "image_questions_percentage": 40
    },
    "blooms_distribution": {
        "1_remember": 15,
        "2_understand": 15,
        "3_apply": 30,
        "4_analyze": 25,
        "5_evaluate": 10,
        "6_create": 5,
        "7_integrate": 0
    },
    "difficulty_distribution": {
        "easy": 20,
        "medium": 50,
        "hard": 30
    },
    "image_percentage_by_subject": {
        "Radiology": 75,
        "Internal Medicine": 40,
        "Biochemistry": 10,
        "Surgery": 45
    },
    "domain_characteristics": {
        "key_features": ["feature1", "feature2"],
        "memory_aids": "mnemonics|formulas|frameworks|acronyms",
        "visual_elements": "high|medium|low"
    }
}

Generate ONLY the JSON, no other text.`;

  const webFormatPrompt =
    `Using your knowledge of the official question format and exam specifications for '${courseName}', ` +
    `including official exam board guidelines, published blueprints, and candidate handbooks, ` +
    `answer the following:\n\n` +
    formatPrompt;

  const response = await orCall(MODELS.STRUCTURE, '', webFormatPrompt, {
    temperature: 0.2,
    maxTokens: 4000,
  });

  let text = response.content.trim();
  if (text.includes('```json')) {
    text = text.split('```json')[1].split('```')[0].trim();
  } else if (text.includes('```')) {
    text = text.split('```')[1].split('```')[0].trim();
  }

  return JSON.parse(text);
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
