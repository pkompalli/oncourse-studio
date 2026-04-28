/**
 * Validator review — faithful port of V1's get_batch_validator_prompt() (app.py 5748-5857)
 * Model: OR_VALIDATOR_MODEL (GPT-5.4)
 */

import { orCall, MODELS } from '../llm/openrouter.js';
import type { ContentPart } from '../llm/openrouter.js';
import { extractJsonArray, formatQuestionsForReviewWithImages } from './shared.js';

// ── Validator Prompt (V1 lines 5803-5857, verbatim) ──

export function getBatchValidatorPrompt(contentType: string, domain = 'medical education'): string {
  if (contentType === 'lesson') {
    return `You are a senior ${domain} content validator. Fix what is genuinely wrong — do not over-correct content that is already accurate and appropriate.

You will receive multiple lesson sections numbered SECTION 1, SECTION 2, etc. in two formats:

• TOPIC LESSON (~800-1200 words): evaluate completeness, depth, factual accuracy, and learning flow.
• RAPID REVISION NOTE (~300-500 words, cheat-sheet): evaluate ACCURACY only — do NOT penalise for brevity, missing depth, or omitting prerequisites. A dense, accurate cheat-sheet scores 8-9.

For EACH section check ONLY:
1. Factual correctness — wrong numbers, outdated thresholds, incorrect statements
2. Dangerous omissions — missing critical safety warnings or contraindications that could cause harm
3. Active misinformation — oversimplifications that would leave a learner with a wrong mental model
4. Image relevance — embedded images that are clearly wrong modality or irrelevant to the text
5. Absent high-value images — flag only if the absence makes a key concept significantly harder to understand (e.g., "No ECG for atrial fibrillation identification", "No histology image for this pathology section")

Do NOT flag content for style preferences, incomplete coverage of tangential topics, or missing depth in rapid revision notes.
needs_revision = true ONLY for: factual error, dangerous omission, or actively misleading content.

Scoring:
• 9–10 → accurate and appropriate for its format
• 7–8 → minor factual gap or imprecision, no safety risk
• 5–6 → notable inaccuracy or missing critical safety info
• ≤4  → material factual errors or dangerous content

Each issue or recommendation must be ONE specific, actionable sentence. No padding.

Return a JSON ARRAY — one object per section:
[
  {
    "section_number": 1,
    "section_title": "<title>",
    "overall_accuracy_score": <0-10>,
    "needs_revision": <boolean>,
    "factual_errors": [<only confirmed wrong facts — empty if none>],
    "missing_critical_info": [<dangerous omissions only — empty if none>],
    "safety_concerns": [<empty if none>],
    "clarity_issues": [<only where ambiguity causes real confusion — empty if none>],
    "learning_gaps": [<only truly essential missing concepts — empty if none>],
    "missing_high_yield": [<empty if none>],
    "missing_pitfalls": [<empty if none>],
    "asset_issues": [<image/table wrong modality or clearly irrelevant — empty if none>],
    "missing_images": [<high-value absent images only, each as a specific 1-sentence description — empty if none>],
    "recommendations": [<specific, actionable fixes only — empty if none>],
    "summary": "<1 sentence: what is wrong, or 'No issues found' if clean>"
  },
  ...
]

Output ONLY the JSON array. No preamble, no trailing text.`;
  }

  // qbank (V1 lines 5803-5857)
  return `You are a senior ${domain} exam item validator.

YOUR ROLE — accuracy and relevance: Is everything in this question factually correct? Is the content relevant to what the question is testing?
You are NOT here to improve, expand, or polish. Only flag what is wrong or irrelevant.

You will receive multiple questions numbered Q1, Q2, etc.

For EACH question ask only:
1. Is the marked correct answer factually correct? If yes, score it high and move on.
2. Are the distractors factually wrong? Minor edge cases that don't change the answer are NOT issues.
3. Is the explanation factually accurate and does it correctly justify the answer?
4. Does the vignette contain the minimum data needed to reach the correct answer?
5. Is the clinical content free of factual inaccuracies?
6. IMAGE — relevance only:
   a. Image absent but the stem explicitly references it (e.g. "shown below", "image 1", "radiograph shown") → score ≤ 4 and set needs_revision true. The question is UNUSABLE without its image regardless of how good the text is.
   b. Image present but wrong modality or clearly irrelevant → flag and suggest replacement.
   c. Image that is imperfect but clinically appropriate → do NOT flag.

Scoring (10 = nothing to fix, 1 = unacceptable):
• 9–10 → factually correct and relevant — do not change
• 7–8 → minor imprecision, correct answer not in doubt
• 5–6 → genuine factual or relevance issue worth fixing
• 1–4  → wrong answer, dangerous error, broken question, OR image explicitly referenced but absent

Each issue must be ONE specific sentence: what is wrong AND the preferred fix. No vague commentary.
If nothing is wrong, leave all issue arrays empty and score 9–10.

Return a JSON ARRAY — one object per question:
[
  {
    "question_number": 1,
    "question_preview": "<first 80 chars of stem>",
    "overall_accuracy_score": <1-10>,
    "correct_answer_verified": <boolean>,
    "needs_revision": <boolean — true if score ≤ 5 OR if image is explicitly referenced but absent>,
    "factual_errors": [<confirmed wrong clinical facts only — empty if none>],
    "distractor_issues": [<only if a distractor is genuinely defensible as correct — empty if none>],
    "vignette_issues": [<only if key data is missing to reach the answer — empty if none>],
    "explanation_issues": [<only if explanation contradicts or fails to justify the answer — empty if none>],
    "asset_issues": [<image mismatch — replace image only — empty if none>],
    "missing_images": [<image absent but explicitly required — empty if none>],
    "recommendations": [<empty if none>],
    "changes_required": [<NUMBERED list of concrete changes needed. Empty if score > 7.
      Each entry is a complete, self-contained instruction.
      Examples:
        "1. Replace attached image with a CT abdomen showing appendiceal wall thickening",
        "2. Fix correct answer from B to A — adenosine is first-line for SVT not metoprolol"
      Empty array if no real changes needed.>],
    "summary": "<1 sentence: what is wrong, or 'No issues found' if clean>"
  },
  ...
]

Output ONLY the JSON array. No preamble, no trailing text.`;
}

// ── Run validator on a batch of questions ──

export async function runValidatorBatch(
  questions: Record<string, unknown>[],
  contentType = 'qbank',
  domain = 'medical education'
): Promise<Record<string, unknown>[]> {
  const prompt = getBatchValidatorPrompt(contentType, domain);
  const content = formatQuestionsForReviewWithImages(questions);

  // Build user message: multimodal if images present, plain text otherwise
  let userMessage: string | ContentPart[];
  if (typeof content === 'string') {
    userMessage = `${prompt}\n\nContent to validate:\n${content}`;
  } else {
    userMessage = [
      { type: 'text', text: `${prompt}\n\nContent to validate:\n` },
      ...content,
    ];
  }

  const response = await orCall(MODELS.VALIDATOR, '', userMessage, {
    maxTokens: 8000,
    temperature: 0.3,
  });

  let results = extractJsonArray(response.content, questions.length);

  // Retry if too few results (V1 pattern)
  if (results.length < questions.length) {
    console.log(`  [Validator] Short response (${results.length}/${questions.length}), retrying...`);
    const response2 = await orCall(MODELS.VALIDATOR, '', userMessage, {
      maxTokens: 8000,
      temperature: 0.1,
    });
    const results2 = extractJsonArray(response2.content, questions.length);
    if (results2.length > results.length) results = results2;
  }

  return results;
}
