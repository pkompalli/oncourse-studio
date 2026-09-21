/**
 * Fixer — faithful port of V1's fix_content() qbank branch (app.py 6410-6582)
 * Model: OR_MAIN_MODEL (Claude) — conservative fix, ONLY changes what's listed
 */

import { orCall, MODELS } from '../llm/openrouter.js';

export interface FixResult {
  fixed: boolean;
  question?: Record<string, unknown>;
  changesApplied?: string[];
  error?: string;
}

/**
 * Apply specific changes to a question — V1 fix prompt (app.py 6442-6473)
 * CRITICAL RULES from V1:
 * - ONLY change what is specifically listed in changes_required
 * - Do NOT rewrite, rephrase, or "improve" any text that isn't flagged
 * - Keep original wording, structure, and style for all non-flagged parts
 */
/**
 * Undo structure the fixer flattened on its way past.
 *
 * The fixer rewrites a whole question to change one thing, and while reconstructing
 * the JSON it sometimes serialises a nested object into a string it was never asked
 * to touch. A rubric came back as "{\"criteria\": [...]}" after a fix for an
 * unrelated blank-stem complaint — schema-valid, and useless: a candidate sees raw
 * JSON and the per-criterion points stop being readable as data.
 *
 * This is distinct from the schema bug that first caused it (scoring_rubric was
 * declared a bare string, so structured rubrics were rejected and the fixer was
 * explicitly told to stringify them). That is fixed; this guards the incidental
 * case, which can hit any structured field during any repair.
 */
function unflatten(node: unknown): void {
  if (!node || typeof node !== 'object') return;
  const obj = node as Record<string, unknown>;
  for (const [k, v] of Object.entries(obj)) {
    if (typeof v === 'string') {
      const t = v.trim();
      if (t.startsWith('{') || t.startsWith('[')) {
        try {
          const parsed = JSON.parse(t);
          // Only rescue real structure; a stem that merely begins with a brace stays.
          if (parsed && typeof parsed === 'object') obj[k] = parsed;
        } catch { /* genuine prose — leave it */ }
      }
    } else if (Array.isArray(v)) {
      v.forEach((x) => unflatten(x));
    } else if (v && typeof v === 'object') {
      unflatten(v);
    }
  }
}

export async function fixQuestion(
  question: Record<string, unknown>,
  changesRequired: string[],
  courseName: string
): Promise<FixResult> {
  if (!changesRequired || changesRequired.length === 0) {
    return { fixed: false };
  }

  const contentJson = JSON.stringify(question, null, 2);
  const changesText = changesRequired.map((c) => `  ${c}`).join('\n');

  const prompt = `You are an expert ${courseName || 'exam'} question editor. Apply EXACTLY the required changes below to this question — nothing more, nothing less.

CRITICAL RULES:
• ONLY change what is specifically listed in REQUIRED CHANGES. Do NOT rewrite, rephrase, or "improve" any text that isn't flagged.
• Keep the original wording, structure, and style for all non-flagged parts.
• If a change asks to fix a factual error, change ONLY the incorrect fact — do not rewrite the surrounding sentence.
• Do NOT add new content, options, or explanations beyond what the changes require.
• Preserve ALL fields from the original JSON — the question may be any format (MCQ, SATA, ordered response, fill-in-blank, etc.).

COURSE: ${courseName}

─── ORIGINAL QUESTION (JSON) ───
${contentJson}

─── REQUIRED CHANGES (apply every one, in order) ───
${changesText}

Return a JSON object with TWO fields:
1. "question" — the complete fixed question JSON (same structure as original)
2. "changes_applied" — array of strings, one per required change above, each prefixed with
   "✅ " if applied, "⚠️ " if partially applied (explain why), or "❌ " if not applicable / could not apply (explain why)

Example output format:
{
  "question": { ...fixed question fields... },
  "changes_applied": [
    "✅ 1. Changed 'CT scan' to 'MRI' in question stem",
    "✅ 2. Updated explanation to state adenosine is first-line for SVT"
  ]
}

Return ONLY valid JSON. No preamble, no markdown fences.`;

  // The fixer must restate the ENTIRE question, so a grouped question (case study
  // with 6 sub-questions, ~14k chars) needs far more than the old 4000-token cap —
  // it truncated mid-JSON, JSON.parse threw, and the repair was silently abandoned,
  // leaving the question flagged with no explanation. Generous cap + one retry.
  const MAX_TOKENS = 16000;
  let lastErr = '';
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const response = await orCall(
        MODELS.FIXER,
        '',
        attempt === 1
          ? prompt
          : `${prompt}\n\nIMPORTANT: Return the COMPLETE JSON object — every field of the question, including every sub_question. Do NOT truncate or elide anything.`,
        { maxTokens: MAX_TOKENS, temperature: attempt === 1 ? 0.2 : 0.1 }
      );

      let raw = response.content.trim();
      if (raw.includes('```json')) raw = raw.split('```json')[1].split('```')[0].trim();
      else if (raw.includes('```')) raw = raw.split('```')[1].split('```')[0].trim();

      const wrapper = JSON.parse(raw);
      if (typeof wrapper === 'object' && wrapper.question) {
        unflatten(wrapper.question);
        return { fixed: true, question: wrapper.question, changesApplied: wrapper.changes_applied || [] };
      }
      unflatten(wrapper);
      return { fixed: true, question: wrapper, changesApplied: [] };
    } catch (e) {
      lastErr = e instanceof Error ? e.message : 'Fix failed';
      console.warn(`  [Fixer] attempt ${attempt}/2 failed to parse fixed question: ${lastErr}`);
    }
  }
  console.error(`  [Fixer] GAVE UP after 2 attempts — question left unrepaired: ${lastErr}`);
  return { fixed: false, error: lastErr };
}

/**
 * Fix multiple questions in parallel
 */
export async function fixQuestionsParallel(
  items: Array<{
    question: Record<string, unknown>;
    changesRequired: string[];
    dbId: string;
  }>,
  courseName: string
): Promise<Map<string, FixResult>> {
  const results = new Map<string, FixResult>();

  const promises = items.map(async (item) => {
    const result = await fixQuestion(item.question, item.changesRequired, courseName);
    results.set(item.dbId, result);
  });

  await Promise.all(promises);
  return results;
}
