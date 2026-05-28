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
  hytTopics: string[]
): Promise<Record<string, unknown>> {
  const topicsStr = hytTopics.length > 0 ? hytTopics.slice(0, 20).join(', ') : subjectName;

  const prompt = `You are an expert curriculum designer for ${courseName} postgraduate medical entrance examinations.

Generate a subject-specific examiner profile for: ${subjectName}

High-yield topics: ${topicsStr}

Return ONLY a JSON object with these exact keys:

{
  "question_style": "<2-3 sentences: how questions in THIS subject typically work — e.g. clinical vignette vs. direct recall vs. image interpretation vs. data interpretation; what makes distractors hard in this subject>",
  "image_types": [
    "<modality 1 specific to ${subjectName} — e.g. 'PA chest X-ray' not just 'X-ray'>",
    "<modality 2>",
    "<modality 3>",
    "<modality 4>",
    "<modality 5>"
  ],
  "image_question_focus": "<what students must identify from images in ${subjectName} exams — e.g. 'ECG rhythm diagnosis', 'histological pattern recognition', 'radiological finding localisation'>",
  "distractor_archetypes": [
    "<archetype 1: a category of plausible wrong answer used repeatedly in this subject — e.g. 'related drug from the same class but wrong indication'>",
    "<archetype 2>",
    "<archetype 3>",
    "<archetype 4>"
  ],
  "bloom_guidance": "<1-2 sentences: which Bloom's levels dominate in ${subjectName} and why — e.g. 'Apply and Analyse dominate because questions present novel clinical scenarios requiring diagnosis'>",
  "special_instructions": "<2-3 subject-specific rules for this examiner — e.g. drug dose ranges, classification systems to use, eponymous findings to test, common confusables to exploit>"
}

Be specific to ${subjectName} as a distinct medical discipline. Do not give generic medical exam advice.`;

  try {
    const response = await orCall(MODELS.GENERATOR, '', prompt, { maxTokens: 1200, temperature: 0.2 });
    let raw = response.content;
    if (raw.includes('```json')) raw = raw.split('```json')[1].split('```')[0];
    else if (raw.includes('```')) raw = raw.split('```')[1].split('```')[0];
    const profile = JSON.parse(raw.trim());
    if (typeof profile !== 'object' || Array.isArray(profile)) throw new Error('non-dict');
    return profile;
  } catch {
    return {
      question_style: `Clinical vignette-based questions requiring application and analysis specific to ${subjectName}.`,
      image_types: [`${subjectName} clinical photograph`, `${subjectName} diagnostic image`, 'histology slide', 'radiograph', 'diagram'],
      image_question_focus: `Identifying key diagnostic findings in ${subjectName}`,
      distractor_archetypes: ['related condition with similar presentation', 'correct diagnosis wrong management', 'partial knowledge trap', 'common misconception'],
      bloom_guidance: 'Apply and Analyse levels dominate; recall-only questions are rare.',
      special_instructions: `Use current standard guidelines. Test high-yield differentials and management decision points in ${subjectName}.`,
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
  subject_profile?: Record<string, unknown>;
  _batch?: string;
}

export async function buildSubjectTasks(
  mockSpecs: Record<string, unknown>,
  courseStructure: Record<string, unknown>,
  examFormat: Record<string, unknown>,
  courseName: string
): Promise<SubjectTask[]> {
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
    });
  }

  // Generate subject profiles in parallel
  const profilePromises = tasks.map(async (task) => {
    const profile = await generateSubjectProfile(task.subject, courseName, task.hyt_topics);
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

  const hytStr = hyt.length > 0 ? hyt.slice(0, 25).map((t) => `  • ${t}`).join('\n') : '  (Full subject syllabus)';
  const bloomStr = Object.entries(bloom).sort().map(([k, v]) => `  ${k}: ${v} question${v !== 1 ? 's' : ''}`).join('\n');

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

  const batchLabel = subjectTask._batch || '';
  const batchNote = batchLabel ? ` (batch ${batchLabel})` : '';

  return `You are a Professor of ${subject} and a senior NBE examiner for the ${courseName} examination.
You are now setting your department's contribution to this year's question paper${batchNote}.

EXAMINATION BRIEF
─────────────────
Exam:             ${courseName}
Your allocation:  ${numQ} questions
Format:           ${ep.style.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())}, ${ep.num_options} options per question
Marking scheme:   ${ep.marking || 'Standard positive marking'}
Image-based Qs:   ${numImgQ} of your ${numQ} questions must be marked is_image_question: true

BLOOM'S TAXONOMY — YOU MUST HIT THESE COUNTS EXACTLY
──────────────────────────────────────────────────────
${bloomStr}

HIGH-YIELD TOPICS FROM THIS YEAR'S SYLLABUS
────────────────────────────────────────────
${hytStr}
${profileSection}
YOUR RESPONSIBILITIES AS EXAMINER
──────────────────────────────────
- Every question must reflect authentic ${courseName} standard and clinical depth for ${subject}
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

  // Image pipeline: generate images for image questions
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

      const imgResult = await processAllImageQuestions(jobId);
      console.log(`🎨 Image pipeline: ${imgResult.totalSuccess}/${imgResult.totalProcessed} images generated`);
    }
  } catch (e) {
    console.error('Image pipeline error (non-fatal):', e);
  }

  // All done
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

// ── Main entry: start or check generation for a job ──

export async function generateBatchForJob(
  jobId: string,
  courseId: string
): Promise<{ status: string; completed: number; total: number }> {
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

  // Step 1: Build subject tasks with profiles (parallel LLM calls)
  console.log(`Building subject tasks for ${courseName}...`);
  const tasks = await buildSubjectTasks(examFormat, structure, examFormat, courseName);
  const totalSubjects = tasks.length;

  // Mark as running
  runningJobs.set(jobId, { status: 'generating', completed: 0, total: totalSubjects });

  // Step 2: Fire off all professors in parallel (non-blocking)
  runAllProfessors(jobId, courseId, tasks, courseName).catch((e) => {
    console.error('runAllProfessors failed:', e);
    runningJobs.set(jobId, { status: 'failed', completed: 0, total: totalSubjects });
  });

  return { status: 'generating', completed: 0, total: totalSubjects };
}
