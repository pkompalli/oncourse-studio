/**
 * Adversarial review — faithful port of V1's get_batch_adversarial_prompt() (app.py 5860-5966)
 * Model: OR_ADVERSARIAL_MODEL (GPT-5.4)
 */

import { orCall, MODELS } from '../llm/openrouter.js';
import type { ContentPart } from '../llm/openrouter.js';
import { extractJsonArray, formatQuestionsForReviewWithImages } from './shared.js';

// ── Adversarial Prompt (V1 lines 5915-5966) ──

export function getBatchAdversarialPrompt(contentType: string, domain = 'medical education'): string {
  if (contentType === 'lesson') {
    return `You are an adversarial ${domain} content reviewer. Your role is to find real defects that would mislead learners or cause harm — not to invent problems where none exist.

You will receive multiple lesson sections in two formats:
• TOPIC LESSON (~800-1200 words): check for factual errors, dangerous gaps, and misleading statements.
• RAPID REVISION NOTE (~300-500 words cheat-sheet): check ONLY factual accuracy and dangerous omissions. A concise, accurate note scores 0-2. Do NOT penalise for brevity.

For EACH section, report ONLY genuine defects:
• Confirmed factual inaccuracies (wrong drug dose, wrong diagnostic threshold, wrong mechanism)
• Dangerous simplifications that could lead to patient harm or wrong clinical decisions
• Missing critical contraindications or safety warnings
• Internal contradictions within the content
• Images that actively mislead (wrong pathology, wrong anatomy shown)
• Wrong imaging modality for the topic (e.g., CXR shown when the topic is CT diagnosis)
• High-value image clearly absent that would make a key concept significantly clearer

Do NOT flag: brevity, style choices, tangential omissions, or content that is accurate but could theoretically be more detailed.
Do NOT manufacture ambiguity where the content is clear and correct.

Scoring (10 = no defects at all, 1 = seriously misleading or unsafe):
• 9–10 → no real defects for this format
• 7–8 → very minor inaccuracy, no safety risk
• 5–6 → notable inaccuracy or potentially misleading
• 1–4  → significant error, dangerous gap, or unsafe content
If no genuine defects exist, score 9–10 and leave all issue arrays empty.

Each item in any list must be ONE specific sentence. No vague filler.

Return a JSON ARRAY — one object per section:
[
  {
    "section_number": 1,
    "adversarial_score": <0-10>,
    "breakability_rating": "<unbreakable|minor issues|moderate issues|severely flawed>",
    "identified_weaknesses": [<confirmed factual errors or dangerous statements only — empty if none>],
    "ambiguities": [<genuine ambiguities that would confuse a learner — empty if none>],
    "overgeneralizations": [<dangerous oversimplifications only — empty if none>],
    "logical_gaps": [<internal contradictions or missing logic — empty if none>],
    "safety_risks": [<missing contraindications or safety warnings — empty if none>],
    "learning_traps": [<ways content could actively mislead into wrong mental model — empty if none>],
    "asset_issues": [<images with wrong modality or actively misleading content — empty if none>],
    "missing_images": [<high-value absent image with specific 1-sentence description — empty if none>],
    "recommendations": [<specific, actionable — empty if no real issues>],
    "summary": "<1 sentence: what is genuinely wrong, or 'No significant defects found'>"
  },
  ...
]

Output ONLY the JSON array. No preamble, no trailing text.`;
  }

  // qbank
  return `You are an adversarial ${domain} exam item reviewer.

YOUR ROLE — missing or misleading content: Does this question have anything absent or misleading that would cause confusion, reinforce a wrong mental model, or reduce its educational value?
You are NOT a fact-checker (the validator handles accuracy). Your lens is: could a student come away from this question more confused or with a worse understanding than before?

You will receive multiple questions numbered Q1, Q2, etc.

Flag only if one of these is true:
1. Something critical is missing from the vignette or explanation such that a student can't build the right clinical reasoning — not just "could be more complete"
2. The question is misleading in a way that would teach a wrong mental model (e.g., explanation implies a false rule, distractor wording implies wrong pathophysiology)
3. An alternative answer is so defensible that a well-prepared student would reasonably choose it — not a far-fetched edge case
4. A triviality clue bypasses clinical reasoning entirely, making the question educationally worthless
5. IMAGE: actively misleading (wrong pathology/anatomy shown) OR absent when the stem explicitly references it — a question that says "shown below" or "Image 1" with no image present is educationally broken and scores ≤ 4

Do NOT flag:
• Omissions that don't affect clinical reasoning for this question
• Style, phrasing, or formatting preferences
• Content a student could reasonably infer
• Wanting the question to cover more ground than it needs to

Scoring (10 = high educational value, no confusion risk; 1 = misleading or educationally harmful):
• 9–10 → clear, sound, good learning value — no changes needed
• 7–8 → trivial gap or very minor risk of confusion
• 5–6 → genuine concern — something missing or misleading that affects learning
• 1–4  → seriously misleading, reinforces wrong reasoning, educationally counterproductive, OR image explicitly referenced in stem but absent

If nothing meets the bar above, score 9–10, leave all arrays empty, and say "No significant defects found."

Each issue must be ONE specific sentence: what is missing/misleading AND what would fix it.

Return a JSON ARRAY — one object per question:
[
  {
    "question_number": 1,
    "adversarial_score": <1-10>,
    "breakability_rating": "<airtight|minor flaws|moderate flaws|easily broken>",
    "alternative_answers": [<only if genuinely defensible — empty if answer is clear>],
    "ambiguities": [<genuine confusion that would lead most candidates astray — empty if none>],
    "distractor_defenses": [<only if a distractor is actually defensible as correct — empty if none>],
    "explanation_contradictions": [<only if explanation logically fails to justify the answer — empty if none>],
    "triviality_clues": [<only if answer is obvious without clinical reasoning — empty if none>],
    "asset_issues": [<clear mismatch only — empty if image is appropriate even if imperfect>],
    "missing_images": [<image explicitly required but absent — empty if none>],
    "recommendations": [<empty if none>],
    "changes_required": [<NUMBERED list of changes NOT already captured by the validator. Empty if none.>],
    "summary": "<1 sentence: what is genuinely wrong, or 'No significant defects found'>"
  },
  ...
]

Output ONLY the JSON array. No preamble, no trailing text.`;
}

// ── Run adversarial on a batch of questions ──

export async function runAdversarialBatch(
  questions: Record<string, unknown>[],
  contentType = 'qbank',
  domain = 'medical education'
): Promise<Record<string, unknown>[]> {
  const prompt = getBatchAdversarialPrompt(contentType, domain);
  const content = formatQuestionsForReviewWithImages(questions);

  let userMessage: string | ContentPart[];
  if (typeof content === 'string') {
    userMessage = `${prompt}\n\nContent to validate:\n${content}`;
  } else {
    userMessage = [
      { type: 'text', text: `${prompt}\n\nContent to validate:\n` },
      ...content,
    ];
  }

  const response = await orCall(MODELS.ADVERSARIAL, '', userMessage, {
    maxTokens: 8000,
    temperature: 0.5,
  });

  let results = extractJsonArray(response.content, questions.length);

  // Retry if too few results
  if (results.length < questions.length) {
    console.log(`  [Adversarial] Short response (${results.length}/${questions.length}), retrying...`);
    const response2 = await orCall(MODELS.ADVERSARIAL, '', userMessage, {
      maxTokens: 8000,
      temperature: 0.3,
    });
    const results2 = extractJsonArray(response2.content, questions.length);
    if (results2.length > results.length) results = results2;
  }

  return results;
}
