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

🚨 CRITICAL WARNING: You MUST generate AT LEAST 10 subjects! 🚨
   - Generating only 2-3 subjects is COMPLETELY UNACCEPTABLE
   - Medical/Professional exams require 10-12 subjects based on official curriculum
   - This is a professional educational platform - comprehensive coverage is MANDATORY

Analyze the official curriculum and create a full hierarchical structure with:

1. **Course identification** (type: medical/engineering/business/certification/other)

2. **Subjects** (major divisions):
   🔴 CRITICAL: Generate AT LEAST 10 subjects - THIS IS MANDATORY!

   - Medical exams (UKMLA, USMLE, NEET PG): EXACTLY 10-12 subjects required

     🔴 HIERARCHY FOR MEDICAL COURSES:
     Subject → Topic → Chapter

     Example for "Internal Medicine - Adult":
     - SUBJECT: Internal Medicine - Adult
       - TOPIC: Cardiology
         - CHAPTER: Hypertension
         - CHAPTER: Heart Failure
         - CHAPTER: Arrhythmias
       - TOPIC: Respiratory Medicine
         - CHAPTER: Asthma
         - CHAPTER: COPD
         - CHAPTER: Pneumonia

     FOR UKMLA AKT - Base structure on GMC/UKMLA official curriculum:
     Reference: GMC "Outcomes for graduates" and UKMLA syllabus domains

     SUGGESTED SUBJECTS (use official terminology where possible):
     1. Internal Medicine - Adult (system-based topics: Cardiology, Respiratory, Gastroenterology, Nephrology, Endocrinology, Rheumatology, Neurology)
     2. Surgery (subspecialties: General Surgery, Trauma & Orthopedics, Urology, ENT, Ophthalmology)
     3. Pediatrics & Child Health (including neonatology, growth & development)
     4. Obstetrics & Gynecology (including maternal medicine, reproductive health)
     5. Psychiatry & Mental Health (including liaison psychiatry, substance misuse)
     6. General Practice & Primary Care (including chronic disease management, preventive care)
     7. Emergency Medicine & Acute Care (including resuscitation, trauma)
     8. Ethics, Law & Communication (including consent, capacity, professionalism)
     9. Public Health & Epidemiology (including screening, health promotion)
     10. Clinical Pharmacology & Therapeutics (including prescribing, adverse effects)
     11. Pathology & Laboratory Medicine (including interpretation of results)
     12. Microbiology & Infectious Diseases (including antimicrobial stewardship)

     ⚠️ If official curriculum uses different terminology or groupings, PREFER the official structure.

   - Engineering exams (FE, PE): EXACTLY 10-12 subjects required
     Examples: Mathematics, Physics, Chemistry, Statics, Dynamics, Mechanics of Materials,
     Thermodynamics, Fluid Mechanics, Electrical Circuits, Materials Science, etc.

   - Business exams (CPA, CFA): EXACTLY 8-10 subjects required
     Examples: Financial Accounting, Auditing, Tax, Business Law, Ethics, Financial Management, etc.

3. **Topics** (under each subject):
   - 8-12 topics per subject (comprehensive coverage)
   - Each topic represents a system-based or area-based division
   - Medical Example: Under "Internal Medicine - Adult" → Cardiology, Respiratory, Gastroenterology, Nephrology, etc.
   - Engineering Example: Under "Mechanical Engineering" → Thermodynamics, Fluid Mechanics, Heat Transfer, etc.
   - Tag each topic with "high_yield": true/false based on exam frequency and importance for THIS specific exam.
     High-yield = consistently heavily tested, high question density in real exams (typically 40-60% of topics per subject).

4. **Chapters** (under each topic):
   - Leave chapters as EMPTY ARRAYS initially: "chapters": []
   - Chapters will be generated dynamically when lessons are requested for specific topics
   - This keeps structure generation fast and efficient
   - When needed, chapters will be: specific conditions, concepts, procedures, or subtopics (8-12 per topic)

${refDocContext}

🔴 MANDATORY REQUIREMENTS:
✓ Generate AT LEAST 10 subjects for medical/professional exams, 8 for technical exams
✓ NEVER generate less than 6 subjects - that's insufficient for any comprehensive course
✓ Each subject must have at least 6 topics
✓ Each topic must have at least 4 chapters
✓ Use standard, recognized terminology for the domain
✓ Cover the FULL breadth of the exam/course - don't summarize or abbreviate

DOMAIN-SPECIFIC GUIDELINES:

**Medical Courses (UKMLA, USMLE, NEET PG, MRCP)**:
HIERARCHY: Subject → Topic → Chapter

SUBJECTS (Major Specialties - 10-12 total):
- Core Clinical: Internal Medicine - Adult, Surgery, Pediatrics, OB/GYN, Psychiatry
- Foundation: Pathology, Pharmacology, Microbiology
- Professional: Ethics/Law/Communication, Public Health, General Practice

TOPICS (System-based divisions under each subject - 8-12 per subject):
- Under "Internal Medicine - Adult": Cardiology, Respiratory, Gastroenterology, Nephrology, Endocrinology, Rheumatology, Neurology
- Under "Surgery": General Surgery, Trauma & Orthopedics, Urology, ENT, Ophthalmology
- Under "Pediatrics": Neonatology, Growth & Development, Pediatric Cardiology, etc.

CHAPTERS (Specific conditions - 8-15 per topic):
- Under "Cardiology": Hypertension, Heart Failure, Arrhythmias, Ischemic Heart Disease, Valvular Disease, etc.
- Under "Respiratory": Asthma, COPD, Pneumonia, Tuberculosis, Lung Cancer, etc.

**Engineering Courses (FE, PE)**:
- Include: Core sciences (Math, Physics, Chemistry)
- Include: Engineering fundamentals (Statics, Dynamics, Thermodynamics)
- Include: Discipline-specific topics (Electrical, Mechanical, Civil, etc.)

**Business/Finance Courses (CPA, CFA, MBA)**:
- Include: Functional areas (Accounting, Finance, Marketing, Operations)
- Include: Specializations (Auditing, Tax, Investment, Strategy)

OUTPUT FORMAT (strict JSON):
{
    "course": "${courseName}",
    "exam_type": "medical|engineering|business|certification|academic",
    "domain_characteristics": "detailed description of learning patterns and exam focus",
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
   - Use your knowledge of past exam patterns, question banks, and official blueprints.
   - Aim for 40-60% of topics per subject to be high-yield — not all, not too few.
   - Examples for NEET PG: Cardiology (HY), General Surgery (HY), Pharmacology of Antibiotics (HY), Embryology (not HY)
   - Examples for USMLE Step 1: Cell Biology (HY), Cardiac Physiology (HY), Rare Genetic Disorders (not HY)

🔴 IMPORTANT: Generate a COMPLETE structure - minimum 10 subjects for professional exams!

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

    const retryPrompt = `CRITICAL: The previous attempt generated only ${numSubjects} subjects, which is INSUFFICIENT.

For ${courseName}, generate a COMPLETE course structure with AT LEAST 10 subjects.

This is a professional educational platform - we need COMPREHENSIVE coverage.

${prompt}

REMEMBER: Minimum 10 subjects for medical/professional exams, 8 for technical exams!`;

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

  // If it already has our canonical shape, return it
  if (isObj(parsed) && (parsed as Record<string, unknown>).subjects) {
    return parsed as Record<string, unknown>;
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
  const highYield = (pick(t, 'high_yield', 'highYield', 'is_high_yield', 'isHighYield') || false) as boolean;

  let chapters: unknown[] = [];
  const chaptersField = Object.keys(t).find(k => {
    const l = k.toLowerCase().replace(/[_\- ]/g, '');
    return ['chapters', 'subtopics', 'items', 'children', 'sections'].includes(l);
  });
  if (chaptersField && Array.isArray(t[chaptersField])) {
    chapters = (t[chaptersField] as unknown[]).map(ch =>
      typeof ch === 'string' ? { name: ch } : ch
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
