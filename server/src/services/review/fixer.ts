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

  const prompt = `You are a medical education question editor. Apply EXACTLY the required changes below to this question — nothing more, nothing less.

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

  try {
    const response = await orCall(MODELS.FIXER, '', prompt, {
      maxTokens: 4000,
      temperature: 0.2,
    });

    let raw = response.content.trim();

    // Strip markdown fences (V1 pattern)
    if (raw.includes('```json')) {
      raw = raw.split('```json')[1].split('```')[0].trim();
    } else if (raw.includes('```')) {
      raw = raw.split('```')[1].split('```')[0].trim();
    }

    const wrapper = JSON.parse(raw);
    if (typeof wrapper === 'object' && wrapper.question) {
      return {
        fixed: true,
        question: wrapper.question,
        changesApplied: wrapper.changes_applied || [],
      };
    }

    // Fallback: model returned question directly
    return { fixed: true, question: wrapper, changesApplied: [] };
  } catch (e) {
    console.error(`  [Fixer] Error fixing question: ${e}`);
    return { fixed: false, error: e instanceof Error ? e.message : 'Fix failed' };
  }
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
