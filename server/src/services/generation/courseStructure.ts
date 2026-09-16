import { orCall, MODELS } from '../llm/openrouter.js';

/**
 * Direct port of generate_course_structure() from V1 app.py (lines 190-471).
 * Prompt is verbatim from V1.
 */

function buildStructurePrompt(courseName: string, referenceDoc?: string): string {
  const refDocContext = referenceDoc
    ? `\n\nREFERENCE DOCUMENTS PROVIDED:\n${referenceDoc}\n\nUse these documents to inform the structure.`
    : '';

  return `You are an expert educational curriculum designer with access to official exam syllabi and curriculum guidelines.

📚 FIRST: Research and reference the OFFICIAL curriculum for: ${courseName}

For each exam/course, base your structure on the authoritative sources:
- UKMLA AKT: GMC (General Medical Council) curriculum, UKMLA syllabus, UK Foundation Programme curriculum
- USMLE: NBME content outline, USMLE Step specifications
- NEET PG: NMC (National Medical Commission) syllabus, MCI guidelines
- Engineering exams (FE, PE): NCEES exam specifications
- Other certifications: Official exam board syllabi

🎯 Use the EXACT subject names, topic divisions, and terminology from the official curriculum.
🎯 Ensure weightage and coverage matches what's actually tested in the exam.
🎯 Reference the most current version of the curriculum/syllabus.

🚨 COVERAGE RULE: Match the ACTUAL breadth of the official curriculum for THIS exam. 🚨
   - Generate as many subjects as the real exam's blueprint has — do NOT collapse a broad exam into 2-3 subjects, and do NOT pad or invent subjects to hit an arbitrary number.
   - Comprehensive professional exams typically have ~6-12 subjects; use fewer only if the exam is genuinely narrow, more if the blueprint is genuinely broader.
   - Comprehensive coverage of what is actually tested is MANDATORY.

Analyze the official curriculum and create a full hierarchical structure with:

1. **Course identification** (type: medical/engineering/business/legal/certification/academic/other)

2. **Subjects** (the major divisions of THIS exam's blueprint)
   HIERARCHY (all domains): Subject → Topic → Chapter

   Use the official exam's own top-level divisions and terminology. Illustrative shapes across domains (adapt to the actual exam — do NOT copy these):
   - Medical (USMLE/UKMLA/NEET PG): SUBJECT "Internal Medicine" → TOPIC "Cardiology" → CHAPTER "Heart Failure"
   - Engineering (FE/PE): SUBJECT "Thermodynamics" → TOPIC "Cycles" → CHAPTER "Rankine Cycle"
   - Accounting (CPA): SUBJECT "Auditing & Attestation" → TOPIC "Risk Assessment" → CHAPTER "Assessing RMM"
   - Finance (CFA): SUBJECT "Ethics & Professional Standards" → TOPIC "Standards of Conduct" → CHAPTER "Conflicts of Interest"
   - Law (LSAT/bar): SUBJECT "Logical Reasoning" → TOPIC "Assumption Questions" → CHAPTER "Necessary vs Sufficient"

   ⚠️ If the official curriculum uses different terminology or groupings, PREFER the official structure.

3. **Topics** (under each subject):
   - Enough topics to cover the subject comprehensively (commonly ~6-12), following the official blueprint.
   - Each topic is an area-based division within the subject.
   - Tag each topic with "high_yield": true/false based on how heavily it is tested in THIS specific exam.
     High-yield = consistently heavily tested, high question density in real exams (typically 40-60% of topics per subject).

4. **Chapters** (under each topic):
   - Leave chapters as EMPTY ARRAYS initially: "chapters": []
   - Chapters are generated later when lessons are requested for a topic (specific concepts, procedures, rules, or subtopics).

${refDocContext}

🔴 MANDATORY REQUIREMENTS:
✓ Cover the FULL breadth of the exam's official blueprint — don't summarize or abbreviate.
✓ Use the standard, recognized terminology for the exam's discipline.
✓ Every subject has multiple topics; the depth should reflect the real exam, not a fixed quota.
✓ Do not force a medical (or any single-discipline) framing onto a non-matching exam.

OUTPUT FORMAT (strict JSON):
{
    "course": "${courseName}",
    "exam_type": "medical|engineering|business|legal|certification|academic|other",
    "domain_characteristics": "detailed description of learning patterns and exam focus for THIS exam",
    "subjects": [
        {
            "name": "Subject Name",
            "description": "Brief 1-line description of what this subject covers",
            "topics": [
                {
                    "name": "Topic Name",
                    "high_yield": true,
                    "chapters": []
                }
            ]
        }
    ]
}

⭐ HIGH-YIELD TAGGING (MANDATORY):
   - Set "high_yield": true for topics that are HEAVILY and CONSISTENTLY tested in real ${courseName} exams.
   - Use your knowledge of past exam patterns, question banks, and official blueprints for THIS exam's discipline.
   - Aim for 40-60% of topics per subject to be high-yield — not all, not too few.
   - The high-yield topics must be the ones that matter for ${courseName} specifically (e.g. an accounting exam's revenue-recognition, a law exam's logical-reasoning core, a medical exam's cardiology) — do not default to medical topics.

Generate ONLY the JSON, no other text.`;
}

/**
 * Repair truncated/malformed JSON from LLM output.
 * Direct port of JSON repair logic from V1 app.py lines 389-433.
 */
function repairAndParseJSON(responseText: string): Record<string, unknown> {
  let text = responseText.trim();

  // Extract JSON if wrapped in markdown
  if (text.includes('```json')) {
    text = text.split('```json')[1].split('```')[0].trim();
  } else if (text.includes('```')) {
    text = text.split('```')[1].split('```')[0].trim();
  }

  // Try parsing as-is
  try {
    return JSON.parse(text);
  } catch (jsonErr) {
    console.error(`[JSON Repair] Parse error, attempting repair. Response length: ${text.length} chars`);

    let repaired = text.trimEnd();
    // Remove any trailing comma
    repaired = repaired.replace(/,\s*$/, '');

    // Count open vs close brackets
    const openBraces = (repaired.match(/{/g) || []).length - (repaired.match(/}/g) || []).length;
    const openBrackets = (repaired.match(/\[/g) || []).length - (repaired.match(/]/g) || []).length;

    // Find last complete object/array element
    const lastBrace = repaired.lastIndexOf('}');
    const lastBracket = repaired.lastIndexOf(']');
    const lastComplete = Math.max(lastBrace, lastBracket);

    if (lastComplete > 0 && (openBraces > 0 || openBrackets > 0)) {
      // Truncate to last complete element
      repaired = repaired.slice(0, lastComplete + 1);
      // Remove trailing comma if present
      repaired = repaired.trimEnd().replace(/,\s*$/, '');
      // Re-count and close remaining open brackets
      const remainingBraces = (repaired.match(/{/g) || []).length - (repaired.match(/}/g) || []).length;
      const remainingBrackets = (repaired.match(/\[/g) || []).length - (repaired.match(/]/g) || []).length;
      repaired += ']'.repeat(Math.max(0, remainingBrackets)) + '}'.repeat(Math.max(0, remainingBraces));
    }

    try {
      const result = JSON.parse(repaired);
      console.log(`[JSON Repair] Successfully parsed repaired JSON (${repaired.length} chars)`);
      return result;
    } catch {
      console.error('[JSON Repair] Repair failed');
      throw jsonErr;
    }
  }
}

export async function generateCourseStructure(
  courseName: string,
  referenceDoc?: string
): Promise<Record<string, unknown>> {
  console.log(`Generating course structure for: ${courseName}`);

  const prompt = buildStructurePrompt(courseName, referenceDoc);

  // V1 uses _call_with_web_search which is _or_call with web model
  const userPrompt = `Using your knowledge of the official syllabus and curriculum for '${courseName}', `
    + `including official exam body guidelines, accreditation documents, and published blueprints, `
    + `produce the complete structure.\n\n`
    + prompt;

  const response = await orCall(
    MODELS.STRUCTURE,
    '', // no system prompt — V1 puts everything in user prompt
    userPrompt,
    { temperature: 0.2, maxTokens: 16000 }
  );

  const structure = repairAndParseJSON(response.content);

  // Validate structure completeness
  const subjects = (structure.subjects as Array<{ name: string; topics: unknown[] }>) || [];
  const numSubjects = subjects.length;

  if (numSubjects < 6) {
    console.warn(`⚠️ Generated structure has only ${numSubjects} subjects - retrying with stronger prompt`);

    const retryPrompt = `CRITICAL: The previous attempt generated only ${numSubjects} subjects, which is too few to comprehensively cover this exam.

For ${courseName}, generate a COMPLETE structure that matches the FULL breadth of the exam's official blueprint — include every major subject/division the real exam actually tests. Do not pad with invented subjects, but do not omit real ones.

${prompt}

REMEMBER: Cover the exam's actual blueprint in full — a broad professional exam usually has well more than ${numSubjects} subjects.`;

    const retryResponse = await orCall(
      MODELS.STRUCTURE,
      '',
      retryPrompt,
      { temperature: 0.5, maxTokens: 16000 }
    );

    const retryStructure = repairAndParseJSON(retryResponse.content);
    const retrySubjects = (retryStructure.subjects as unknown[]) || [];
    console.log(`✓ Retry generated structure with ${retrySubjects.length} subjects`);
    return retryStructure;
  }

  // Log summary
  const totalTopics = subjects.reduce((sum, s) => sum + (s.topics?.length || 0), 0);
  console.log(`✓ Generated structure with ${numSubjects} subjects, ${totalTopics} topics`);

  return structure;
}

/**
 * Generic, intelligent parser that extracts a subject→topic hierarchy from
 * arbitrary JSON.  Works by recursively inspecting the shape of the data
 * rather than hard-coding key names.
 */
export function parseStructureFromInput(content: string, courseName?: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new Error('NEEDS_AI_PROCESSING');
  }

  // First, try to detect an Exam tier (Course > Exam > Subject > Topic > Chapter).
  // Returns a flat subjects[] (each tagged with its `exam`) plus exams[] metadata.
  const examResult = discoverExams(parsed, courseName);
  if (examResult) {
    console.log(`[parseStructure] Detected ${(examResult.exams as unknown[]).length} exam(s), ${(examResult.subjects as unknown[]).length} subjects`);
    return examResult;
  }

  // If it has an explicit subjects array, normalize it into our canonical
  // shape. We can't return it verbatim: uploads may key names as
  // "subject"/"topic"/"chapter" (not "name"), which the UI reads as blank.
  if (isObj(parsed) && Array.isArray((parsed as Record<string, unknown>).subjects)) {
    const obj = parsed as Record<string, unknown>;
    const normalized = discoverFromArray(obj.subjects as unknown[]);
    if (normalized.length > 0) {
      const merged = deduplicateSubjects(normalized);
      console.log(`[parseStructure] Normalized ${merged.length} subjects from uploaded JSON`);
      return {
        course: courseName || (pick(obj, 'course', 'courseName', 'exam', 'title', 'name') as string) || 'Imported Course',
        subjects: merged,
      };
    }
  }

  // Try to discover subjects from whatever shape we got
  const subjects = discoverSubjects(parsed);
  if (subjects.length > 0) {
    const merged = deduplicateSubjects(subjects);
    console.log(`[parseStructure] Extracted ${merged.length} subjects from uploaded JSON`);
    return { course: courseName || 'Imported Course', subjects: merged };
  }

  throw new Error('NEEDS_AI_PROCESSING');
}

/* ── helpers ──────────────────────────────────────────────────────── */

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Get the first truthy value for any of the given keys (case-insensitive). */
function pick(obj: Record<string, unknown>, ...candidates: string[]): unknown {
  for (const key of Object.keys(obj)) {
    const lower = key.toLowerCase().replace(/[_\- ]/g, '');
    for (const c of candidates) {
      if (lower === c.toLowerCase().replace(/[_\- ]/g, '')) return obj[key];
    }
  }
  return undefined;
}

/** Does this key look like a subject-name field? */
function isNameKey(k: string): boolean {
  const l = k.toLowerCase().replace(/[_\- ]/g, '');
  return ['name', 'subject', 'subjectname', 'title', 'area', 'discipline', 'module'].includes(l);
}

/** Does this key look like a topics-list field? */
function isTopicsKey(k: string): boolean {
  const l = k.toLowerCase().replace(/[_\- ]/g, '');
  return ['topics', 'subtopics', 'units', 'modules', 'sections', 'areas', 'chapters', 'children', 'items'].includes(l);
}

/** Does this key look like a grouping/container (step, year, phase, etc.)? */
function isGroupingKey(k: string): boolean {
  return /^(step|phase|part|section|block|year|semester|module|unit|level|category|group|domain|area)\b/i.test(k.trim());
}

/** Normalize a key for case/separator-insensitive comparison. */
function norm(k: string): string {
  return k.toLowerCase().replace(/[_\- ]/g, '');
}

/** Does this key hold a list of exams/sections/papers? */
function isExamKey(k: string): boolean {
  return ['exams', 'exam', 'sections', 'section', 'papers', 'paper', 'parts'].includes(norm(k));
}

/** Fields inside a topic that indicate a subject-level grouping. */
const SUBJECT_GROUP_KEYS = ['area', 'group', 'subject', 'discipline', 'module', 'domain'];

function topicGroupField(topic: Record<string, unknown>): string | undefined {
  return Object.keys(topic).find((k) => SUBJECT_GROUP_KEYS.includes(norm(k)));
}

/** Keys that hold a nested subject-tier list directly under an exam. */
const SUBJECT_LIST_KEYS = ['subjects', 'areas', 'disciplines', 'modules'];

/**
 * Does this object look like an exam/section (as opposed to a plain subject)?
 * Signals (any one): an explicit node_type of exam/section/paper; a nested
 * subjects/areas list; a code + type pair; or nested topics that carry a
 * subject-grouping field (area/group/subject).
 */
function looksLikeExam(obj: Record<string, unknown>): boolean {
  const keys = Object.keys(obj);
  const hasNestedSubjects = keys.some((k) => SUBJECT_LIST_KEYS.includes(norm(k)) && Array.isArray(obj[k]));
  const topicsField = keys.find(isTopicsKey);
  const hasTopics = !!topicsField && Array.isArray(obj[topicsField as string]);
  if (!hasNestedSubjects && !hasTopics) return false;

  // Explicit tier marker (e.g. "node_type": "exam").
  const nodeType = pick(obj, 'node_type', 'nodeType', 'level', 'tier');
  if (typeof nodeType === 'string' && ['exam', 'section', 'paper'].includes(norm(nodeType))) return true;

  // An object that directly parents a subjects list is an exam.
  if (hasNestedSubjects) return true;

  const hasCode = keys.some((k) => norm(k) === 'code');
  const hasType = keys.some((k) => ['type', 'category', 'kind'].includes(norm(k)));
  if (hasCode && hasType) return true;

  const firstTopic = topicsField ? ((obj[topicsField] as unknown[]).find(isObj) as Record<string, unknown> | undefined) : undefined;
  if (firstTopic && topicGroupField(firstTopic)) return true;

  return false;
}

/** Extract the subject tier for a single exam, tolerating missing levels. */
function extractSubjectsForExam(exam: Record<string, unknown>, examName: string): Array<Record<string, unknown>> {
  const keys = Object.keys(exam);

  // 1. Explicit nested subjects array (objects that each hold a topics list).
  const subjKey = keys.find((k) => SUBJECT_LIST_KEYS.includes(norm(k)) && Array.isArray(exam[k]));
  if (subjKey) {
    const arr = (exam[subjKey] as unknown[]).filter(isObj) as Array<Record<string, unknown>>;
    if (arr.length > 0 && arr.some((a) => Object.keys(a).some(isTopicsKey))) {
      return arr.map(normalizeSubject);
    }
  }

  // 2. A flat topics list — group by area/group/subject if present, else one implicit subject.
  const topicsField = keys.find(isTopicsKey);
  if (topicsField && Array.isArray(exam[topicsField])) {
    const topics = (exam[topicsField] as unknown[]).filter(isObj) as Array<Record<string, unknown>>;
    if (topics.length === 0) return [];
    const groupField = topicGroupField(topics[0]);
    if (groupField) {
      const groups = new Map<string, Array<Record<string, unknown>>>();
      const order: string[] = [];
      for (const t of topics) {
        const g = ((t[groupField] as string) || examName).trim() || examName;
        if (!groups.has(g)) { groups.set(g, []); order.push(g); }
        groups.get(g)!.push(t);
      }
      return order.map((g) => ({ name: g, topics: groups.get(g)!.map(normalizeTopicObj) }));
    }
    // No grouping field — one implicit subject named after the exam.
    return [{ name: examName, topics: topics.map(normalizeTopicItem) }];
  }

  return [];
}

/**
 * Detect a Course > Exam > Subject > Topic > Chapter hierarchy.
 * Returns a canonical structure with a flat `subjects[]` (each tagged with its
 * `exam`) plus `exams[]` metadata for the UI/picker — or null if no exam tier
 * is present (caller falls back to plain subject parsing).
 */
function discoverExams(parsed: unknown, courseName?: string): Record<string, unknown> | null {
  if (!isObj(parsed)) return null;
  const obj = parsed as Record<string, unknown>;

  // Find the array holding exam-like items: an explicit exams/sections key,
  // or any array of objects where items look like exams.
  let examKey = Object.keys(obj).find((k) => isExamKey(k) && Array.isArray(obj[k]));
  if (!examKey) {
    examKey = Object.keys(obj).find(
      (k) => Array.isArray(obj[k]) && (obj[k] as unknown[]).some((it) => isObj(it) && looksLikeExam(it as Record<string, unknown>))
    );
  }
  if (!examKey) return null;

  const items = (obj[examKey] as unknown[]).filter(isObj) as Array<Record<string, unknown>>;
  if (items.length === 0 || !items.some(looksLikeExam)) return null;

  const exams: Array<Record<string, unknown>> = [];
  const flatSubjects: Array<Record<string, unknown>> = [];

  for (const it of items) {
    const examName = String(pick(it, 'name', 'exam', 'section', 'paper', 'title', 'code', 'subject') || 'Exam').trim() || 'Exam';
    const code = pick(it, 'code', 'abbrev', 'abbreviation') as string | undefined;
    const type = pick(it, 'type', 'category', 'kind') as string | undefined;

    const subjects = extractSubjectsForExam(it, examName);
    for (const s of subjects) {
      s.exam = examName;
      flatSubjects.push(s);
    }

    exams.push({
      name: examName,
      ...(code ? { code: String(code) } : {}),
      ...(type ? { type: String(type) } : {}),
      subject_count: subjects.length,
      topic_count: subjects.reduce((sum, s) => sum + ((s.topics as unknown[])?.length || 0), 0),
    });
  }

  if (flatSubjects.length === 0) return null;

  return {
    course: courseName || (pick(obj, 'course', 'exam', 'title', 'name') as string) || 'Imported Course',
    exam_type: pick(obj, 'exam_type', 'examType') as string | undefined,
    exams,
    subjects: flatSubjects,
  };
}

/**
 * Recursively discover subject→topic pairs from any JSON shape.
 *
 * Strategies (tried in order):
 * 1. Array of objects that each look like a subject (have a name-ish field + array field)
 * 2. Object whose values are arrays of strings/objects → keys = subjects, values = topics
 * 3. Object whose values are sub-objects or arrays → recurse into each value (handles grouping/steps)
 */
function discoverSubjects(data: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(data)) {
    return discoverFromArray(data);
  }
  if (isObj(data)) {
    return discoverFromObject(data as Record<string, unknown>);
  }
  return [];
}

function discoverFromArray(arr: unknown[]): Array<Record<string, unknown>> {
  if (arr.length === 0) return [];

  // Check if array items look like subject objects
  const firstObj = arr.find(isObj) as Record<string, unknown> | undefined;
  if (firstObj) {
    const nameField = Object.keys(firstObj).find(isNameKey);
    const topicsField = Object.keys(firstObj).find(isTopicsKey);
    // Also check for objects where the array field looks like topics
    const arrayField = Object.keys(firstObj).find(k => Array.isArray(firstObj[k]));

    if (nameField && (topicsField || arrayField)) {
      return arr.filter(isObj).map(item => normalizeSubject(item as Record<string, unknown>));
    }
  }

  // Maybe it's an array of groupings — recurse
  const results: Array<Record<string, unknown>> = [];
  for (const item of arr) {
    results.push(...discoverSubjects(item));
  }
  return results;
}

function discoverFromObject(obj: Record<string, unknown>): Array<Record<string, unknown>> {
  const keys = Object.keys(obj);

  // Skip metadata keys
  const skip = new Set(['course', 'coursename', 'examtype', 'exam_type', 'domain', 'description',
    'domaincharacteristics', 'domain_characteristics', 'metadata', 'info', 'version', 'type']);

  // If it has a "subjects" (or similar) key that's an array, use that
  const subjectsKey = keys.find(isTopicsKey);
  if (subjectsKey && Array.isArray(obj[subjectsKey])) {
    const found = discoverFromArray(obj[subjectsKey] as unknown[]);
    if (found.length > 0) return found;
  }

  // Check if this object itself looks like a subject
  const nameField = keys.find(isNameKey);
  const topicsField = keys.find(isTopicsKey);
  if (nameField && topicsField && Array.isArray(obj[topicsField])) {
    return [normalizeSubject(obj)];
  }

  // Check if values are arrays (flat map: key=subject, value=topics)
  const arrayEntries = keys.filter(k => !skip.has(k.toLowerCase().replace(/[_\- ]/g, '')) && Array.isArray(obj[k]));
  if (arrayEntries.length >= 2) {
    // Check if array items are strings or simple topic objects (not deep nesting)
    const firstArr = obj[arrayEntries[0]] as unknown[];
    if (firstArr.length > 0 && (typeof firstArr[0] === 'string' || (isObj(firstArr[0]) && looksLikeTopic(firstArr[0] as Record<string, unknown>)))) {
      return arrayEntries.map(key => ({
        name: key,
        topics: (obj[key] as unknown[]).map(normalizeTopicItem),
      }));
    }
  }

  // Recurse into sub-objects/arrays (handles groupings like "Step 1", "Year 2", etc.)
  const results: Array<Record<string, unknown>> = [];
  for (const key of keys) {
    if (skip.has(key.toLowerCase().replace(/[_\- ]/g, ''))) continue;
    const val = obj[key];
    if (isObj(val) || Array.isArray(val)) {
      results.push(...discoverSubjects(val));
    }
  }
  return results;
}

function looksLikeTopic(obj: Record<string, unknown>): boolean {
  return Object.keys(obj).some(k => isNameKey(k) || isTopicsKey(k));
}

function normalizeTopicItem(t: unknown): Record<string, unknown> {
  if (typeof t === 'string') return { name: t, high_yield: false, chapters: [] };
  if (isObj(t)) return normalizeTopicObj(t as Record<string, unknown>);
  return { name: String(t), high_yield: false, chapters: [] };
}

function normalizeSubject(s: Record<string, unknown>): Record<string, unknown> {
  const name = (pick(s, 'name', 'subject', 'subjectName', 'title', 'area', 'discipline', 'module') || 'Unknown') as string;
  const description = (pick(s, 'description', 'desc', 'summary') || '') as string;

  // Find the array field that holds topics
  let rawTopics: unknown[] = [];
  const topicsField = Object.keys(s).find(isTopicsKey);
  if (topicsField && Array.isArray(s[topicsField])) {
    rawTopics = s[topicsField] as unknown[];
  } else {
    // Fall back to first array field
    const firstArrayKey = Object.keys(s).find(k => Array.isArray(s[k]) && !isNameKey(k));
    if (firstArrayKey) rawTopics = s[firstArrayKey] as unknown[];
  }

  return {
    name,
    description,
    topics: rawTopics.map(normalizeTopicItem),
  };
}

function normalizeTopicObj(t: Record<string, unknown>): Record<string, unknown> {
  const name = (pick(t, 'name', 'topic', 'topicName', 'title', 'unit', 'section') || 'Unknown') as string;
  const highYield = (pick(t, 'high_yield', 'highYield', 'is_high_yield', 'isHighYield', 'hyt') || false) as boolean;

  let chapters: unknown[] = [];
  const chaptersField = Object.keys(t).find(k => {
    const l = k.toLowerCase().replace(/[_\- ]/g, '');
    return ['chapters', 'subtopics', 'items', 'children', 'sections'].includes(l);
  });
  if (chaptersField && Array.isArray(t[chaptersField])) {
    chapters = (t[chaptersField] as unknown[]).map(ch =>
      typeof ch === 'string'
        ? { name: ch }
        : { name: (pick(ch as Record<string, unknown>, 'name', 'chapter', 'chapterName', 'title') || '') as string }
    );
  }

  return { name, high_yield: highYield, chapters };
}

function deduplicateSubjects(subjects: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  const merged = new Map<string, Record<string, unknown>>();
  for (const s of subjects) {
    const name = (s.name as string).trim();
    if (merged.has(name)) {
      const existing = merged.get(name)!;
      const existingTopics = (existing.topics as unknown[]) || [];
      const newTopics = (s.topics as unknown[]) || [];
      // Deduplicate topics by name too
      const seenTopics = new Set(existingTopics.map(t => isObj(t) ? (t as Record<string, unknown>).name : t));
      for (const t of newTopics) {
        const tName = isObj(t) ? (t as Record<string, unknown>).name : t;
        if (!seenTopics.has(tName)) {
          existingTopics.push(t);
          seenTopics.add(tName);
        }
      }
      existing.topics = existingTopics;
    } else {
      merged.set(name, s);
    }
  }
  return Array.from(merged.values());
}
