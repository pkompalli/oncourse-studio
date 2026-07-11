import { orCall, MODELS } from '../llm/openrouter.js';
import { supabase } from '../../db/supabase.js';

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
  _batch?: string;
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

// ── Build Professor Prompt (V1 lines 1145-1300) ──

function buildProfessorPrompt(subjectTask: SubjectTask, courseName: string): string {
  const { subject, num_questions: numQ, num_image_qs: numImgQ, bloom_counts: bloom, exam_params: ep } = subjectTask;
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

  return `You are a Professor of ${subject} and a ${examinerRole}.
You are now setting your department's contribution to this year's ${courseName}${boardNote} question paper${batchNote}.

EXAMINATION BRIEF
─────────────────
Exam:             ${courseName}
Your allocation:  ${numQ} questions
Format:           ${ep.style.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())}, ${ep.num_options} options per question
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
- Every question MUST match the ${courseName} exam pattern described above — stem format, length, lead-in style, option style
- Follow the question style and distractor archetypes described in the Subject Profile above
- Wrong options must be genuinely plausible to a well-prepared ${subject} candidate
- Exploit the distractor archetypes listed above
- No two questions should test the same clinical fact
- Distribute your questions across the HYT topics listed above
- Each question must be tagged with its exact Bloom's level

ANSWER INTEGRITY — MANDATORY RULES
────────────────────────────────────
1. STEM MUST NOT NAME THE DIAGNOSIS
2. OPTIONS MUST NOT BETRAY THE ANSWER — all options plausible, parallel, similar length
3. No "All of the above" or "None of the above"
4. NO ANSWER CLUES IN STEM WORDING

Return EXACTLY ${numQ} questions as a JSON array. Schema for each question:
{
  "question":       "<stem>",
  "options":        ["A. ...", "B. ...", "C. ...", "D. ..."],
  "correct_answer": "A",
  "explanation":    "<2-3 sentences max>",
  "bloom_level":    "<2_understand|3_apply|4_analyze|5_evaluate>",
  "is_image_question": <true|false>,
  "image_type":         "<modality string if image question, else null>",
  "image_search_terms": ["<3-5 specific search terms if image question, else empty array>"]
}

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
  const diffMap: Record<string, number> = { easy: 1, medium: 1, hard: 2, 'very hard': 3, very_hard: 3 };

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

    // Normalize correct answer
    if (q.correct_answer && !q.correct_option) {
      q.correct_option = q.correct_answer;
      delete q.correct_answer;
    }

    // Normalize bloom field
    if (q.bloom_level && !q.blooms_level) {
      q.blooms_level = q.bloom_level;
      delete q.bloom_level;
    }
    const bl = (q.blooms_level as string) || '';
    q.blooms_level = bl && bl[0] >= '0' && bl[0] <= '9' ? bl[0] : bl;

    // Normalize difficulty to numeric
    const d = q.difficulty;
    if (!d) {
      q.difficulty = 1;
    } else if (typeof d === 'string') {
      q.difficulty = diffMap[d.toLowerCase().trim()] || 1;
    }

    // Normalize options from array to object if needed
    if (Array.isArray(q.options)) {
      const optArr = q.options as string[];
      const optObj: Record<string, string> = {};
      for (const opt of optArr) {
        const match = (opt as string).match(/^([A-E])\.\s*/);
        if (match) {
          optObj[match[1]] = (opt as string).substring(match[0].length);
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

    const batchTask: SubjectTask = {
      ...subjectTask,
      num_questions: batchSize,
      num_image_qs: Math.max(0, batchImgQ),
      bloom_counts: batchBloom,
      _batch: `${b + 1}/${numBatches}`,
    };

    try {
      const prompt = buildProfessorPrompt(batchTask, courseName);
      const response = await orCall(MODELS.GENERATOR, '', prompt, { maxTokens: 8000, temperature: 0.7 });
      let qs = parseQuestions(response.content);

      // Retry if too few questions
      if (qs.length < batchSize) {
        const response2 = await orCall(MODELS.GENERATOR, '', prompt, { maxTokens: 8000, temperature: 0.5 });
        const qs2 = parseQuestions(response2.content);
        if (qs2.length > qs.length) qs = qs2;
      }

      enrichQuestions(qs, subject, courseName, hyt, topicCounter);
      allQuestions.push(...qs);

      // Subtract bloom counts
      for (const level of Object.keys(bloomRemaining)) {
        bloomRemaining[level] = Math.max(0, bloomRemaining[level] - (batchBloom[level] || 0));
      }

      console.log(`  ${subject} batch ${b + 1}/${numBatches}: ${qs.length}/${batchSize} Qs`);
    } catch (e) {
      console.error(`professor batch ${b + 1} failed for ${subject}: ${e}`);
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

// ── Insert questions for a subject into DB ──
async function insertSubjectQuestions(
  questions: Record<string, unknown>[],
  jobId: string,
  courseId: string,
  courseName: string,
  subjectIndex: number
) {
  if (questions.length === 0) return;
  const rows = questions.map((q, idx) => ({
    job_id: jobId,
    course_id: courseId,
    question_number: (subjectIndex * 100) + idx + 1,
    question: q.question as string,
    options: q.options as Record<string, string>,
    correct_option: (q.correct_option as string) || 'A',
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
    status: 'generated',
    audit_trail: [],
    attempt_number: 1,
  }));

  const { error: insertErr } = await supabase.from('qb_questions').insert(rows);
  if (insertErr) console.error(`Insert error for subject ${subjectIndex}: ${insertErr.message}`);
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
      console.error(`✗ Professor ${task.subject} failed:`, e);
      completedSubjects.push(task.subject); // count as done even if failed
      return { subject: task.subject, count: 0, error: e };
    }
  });

  await Promise.all(promises);

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
  await supabase
    .from('qb_jobs')
    .update({
      status: 'reviewing',
      progress: {
        completed: totalSubjects,
        total: totalSubjects,
        completed_subjects: completedSubjects,
        message: `All ${totalSubjects} subjects complete — ${totalQuestionsGenerated} questions generated`,
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
  const jobType = (job.type as string) || '';

  // Step 1: Build subject tasks — topic-wise uses course structure directly, mock exam uses exam format
  console.log(`Building subject tasks for ${courseName} (${jobType})...`);
  const jobConfig = (job.config || {}) as Record<string, unknown>;
  const tasks = jobType === 'topic_wise' || jobType === 'topic_qbank'
    ? await buildTopicWiseTasks(structure, examFormat, courseName, (jobConfig.questions_per_topic as number) || 5)
    : await buildSubjectTasks(examFormat, structure, examFormat, courseName);
  const totalSubjects = tasks.length;

  if (totalSubjects === 0) {
    throw new Error('No subjects found to generate questions for. Check course structure.');
  }

  // Mark as running
  runningJobs.set(jobId, { status: 'generating', completed: 0, total: totalSubjects });

  // Step 2: Fire off all professors in parallel (non-blocking)
  runAllProfessors(jobId, courseId, tasks, courseName).catch((e) => {
    console.error('runAllProfessors failed:', e);
    runningJobs.set(jobId, { status: 'failed', completed: 0, total: totalSubjects });
  });

  return { status: 'generating', completed: 0, total: totalSubjects };
}
