/**
 * Adversarial review — faithful port of V1's get_batch_adversarial_prompt() (app.py 5860-5966)
 * Model: OR_ADVERSARIAL_MODEL (GPT-5.4)
 */

import { orCall, MODELS } from '../llm/openrouter.js';
import type { ContentPart } from '../llm/openrouter.js';
import { extractJsonArray, formatQuestionsForReviewWithImages } from './shared.js';

// ── Adversarial Prompt (V1 lines 5915-5966) ──

export function getBatchAdversarialPrompt(contentType: string, domain = 'exam preparation', examFormat?: Record<string, unknown>): string {
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

  // Build exam format context for adversarial
  let examFormatContext = '';
  if (examFormat && Object.keys(examFormat).length > 0) {
    const parts: string[] = [];
    const philosophy = examFormat.testing_philosophy as string;
    const antiPatterns = (examFormat.what_NOT_to_do as string[]) || [];
    const recallRatio = examFormat.recall_vs_reasoning_ratio as Record<string, unknown> | undefined;

    if (philosophy) parts.push(`Testing philosophy: ${philosophy}`);
    if (recallRatio?.description) parts.push(`Recall vs reasoning: ${recallRatio.description}`);
    if (antiPatterns.length > 0) parts.push(`What this exam does NOT do:\n${antiPatterns.slice(0, 3).map(p => `  • ${p}`).join('\n')}`);

    if (parts.length > 0) {
      examFormatContext = `\nEXAM FORMAT CONTEXT (use to judge educational alignment):\n${parts.join('\n')}\n`;
    }
  }

  // qbank
  return `You are an adversarial ${domain} exam item reviewer.
${examFormatContext}
YOUR ROLE — missing or misleading content, AND batch-level quality: Does this question have anything absent or misleading that would cause confusion, reinforce a wrong mental model, or reduce its educational value? Does the batch as a whole have diversity issues?
You are NOT a fact-checker (the validator handles accuracy). Your lens is: could a student come away from this question more confused or with a worse understanding than before? And does the batch as a whole represent good exam design?

You will receive multiple questions numbered Q1, Q2, etc.

Flag only if one of these is true:
1. Something critical is missing from the stem/scenario or explanation such that a student can't build the correct reasoning — not just "could be more complete"
2. The question is misleading in a way that would teach a wrong mental model (e.g., explanation implies a false rule, distractor wording implies a wrong underlying principle)
3. An alternative answer is so defensible that a well-prepared student would reasonably choose it — not a far-fetched edge case
4. A triviality clue bypasses reasoning entirely, making the question educationally worthless
5. EXPLANATION COMPLETENESS — the explanation MUST:
   a. Justify WHY the correct answer is right
   b. Address EACH wrong option BY NAME and explain WHY it is wrong
   c. If the explanation only defends the correct answer without discussing distractors → flag as "explanation_contradictions" and score ≤ 6
6. IMAGE: actively misleading (wrong pathology/anatomy shown) OR absent when the stem explicitly references it — a question that says "shown below" or "Image 1" with no image present is educationally broken and scores ≤ 4
7. CASE STUDY STRUCTURE — for format_type "case_study":
   a. Must have exactly 6 sub-questions (flag if fewer)
   b. Must use at least 3 different format_types across sub-questions
   c. Each sub-question MUST have its own "rationale" explaining correct answer + why distractors are wrong
   d. Each sub-question MUST have a "reasoning_step" tag (legacy: "cjmm_step") using a step taxonomy appropriate to this exam's discipline — do NOT require the nursing Clinical-Judgment labels for non-clinical exams
   e. Hot-spot answers must be structured objects, not prose strings
   f. ANSWER-KEY CORRECTNESS — verify EACH keyed answer against the exhibit facts + stated rule. In particular:
      • Date/number boundary arithmetic: recompute the keyed value and check off-by-one errors (inclusive vs exclusive boundary). E.g. "earliest date documentation may be DESTROYED" = the day AFTER the retention period ends, not the last retained day. Flag if the key is off by one.
      • Rule grounding: the answer must be gradable against a rule/threshold/fact that ACTUALLY appears in an exhibit or the narrative. Flag any sub-question whose key depends on a rule not stated in any exhibit.
      • Cross-task consistency: two sub-questions in the same case must not apply contradictory rules (e.g. one task teaches "the 60-day documentation rule does not govern other deadlines" while another uses that same 60-day rule to judge a communication deadline). Flag the contradiction and name both sub-questions.
8. CONCEPT DIVERSITY — look across the entire batch:
   a. Flag questions that test the EXACT same concept/fact as another question in the batch (conceptual duplicate even if worded differently)
   b. Flag questions that are too similar in scenario/presentation (e.g., 3 questions built on the same fact pattern → suggest varying it)
9. ANSWER KEY BALANCE — check correct answer distribution across the batch:
   a. If correct answer keys are heavily skewed (e.g., 6 out of 10 are "B"), flag the ones that should change to achieve better balance
   b. A well-designed exam has roughly equal distribution across answer keys

Do NOT flag:
• Omissions that don't affect clinical reasoning for this question
• Style, phrasing, or formatting preferences
• Content a student could reasonably infer
• Wanting the question to cover more ground than it needs to

Scoring (10 = high educational value, no confusion risk; 1 = misleading or educationally harmful):
• 9–10 → clear, sound, good learning value, explanation covers all options — no changes needed
• 7–8 → trivial gap or very minor risk of confusion
• 5–6 → explanation only defends correct answer without addressing distractors, OR case study missing rationales/reasoning_step, OR genuine concern affecting learning
• 1–4  → seriously misleading, reinforces wrong reasoning, case study structurally broken, OR image explicitly referenced in stem but absent

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
    "explanation_contradictions": [<if explanation only defends the correct answer without discussing distractors, or logically fails to justify — empty if none>],
    "case_study_issues": [<if case_study: missing sub-question rationales, too few sub-questions, too few formats, missing reasoning_step, prose hot_spot answers — empty if none or not case_study>],
    "triviality_clues": [<only if answer is obvious without clinical reasoning — empty if none>],
    "concept_overlap": "<if this question tests the same concept as another Q in the batch, state which Q and suggest differentiation — null if unique>",
    "answer_key_issue": "<if this question contributes to skewed answer distribution, suggest changing to a different key — null if fine>",
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
  domain = 'exam preparation',
  examFormat?: Record<string, unknown>
): Promise<Record<string, unknown>[]> {
  const prompt = getBatchAdversarialPrompt(contentType, domain, examFormat);
  const content = await formatQuestionsForReviewWithImages(questions);

  let userMessage: string | ContentPart[];
  if (typeof content === 'string') {
    userMessage = `${prompt}\n\nContent to validate:\n${content}`;
  } else {
    userMessage = [
      { type: 'text', text: `${prompt}\n\nContent to validate:\n` },
      ...content,
    ];
  }

  // Never throw: a Bedrock/network failure here would otherwise crash the whole
  // review pipeline. Return whatever we can parse; empty is handled downstream.
  let results: Record<string, unknown>[] = [];
  try {
    const response = await orCall(MODELS.ADVERSARIAL, '', userMessage, {
      maxTokens: 16000,
      temperature: 0.5,
    });
    results = extractJsonArray(response.content, questions.length);
  } catch (e) {
    console.warn(`  [Adversarial] LLM call failed for batch of ${questions.length}: ${e instanceof Error ? e.message : e}`);
  }

  // Retry if too few results (covers truncation AND a failed first call)
  if (results.length < questions.length) {
    console.log(`  [Adversarial] Short response (${results.length}/${questions.length}), retrying...`);
    try {
      const response2 = await orCall(MODELS.ADVERSARIAL, '', userMessage, {
        maxTokens: 16000,
        temperature: 0.3,
      });
      const results2 = extractJsonArray(response2.content, questions.length);
      if (results2.length > results.length) results = results2;
    } catch (e) {
      console.warn(`  [Adversarial] Retry LLM call failed: ${e instanceof Error ? e.message : e}`);
    }
  }

  return results;
}
