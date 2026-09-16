/**
 * Validator review — faithful port of V1's get_batch_validator_prompt() (app.py 5748-5857)
 * Model: OR_VALIDATOR_MODEL (GPT-5.4)
 */

import { orCall, MODELS } from '../llm/openrouter.js';
import type { ContentPart } from '../llm/openrouter.js';
import { extractJsonArray, formatQuestionsForReviewWithImages, gradabilityIssues } from './shared.js';

// ── Validator Prompt (V1 lines 5803-5857, verbatim) ──

export function getBatchValidatorPrompt(contentType: string, domain = 'exam preparation', examFormat?: Record<string, unknown>, guidelines?: Record<string, unknown>, formatsInBatch?: Set<string>): string {
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

  // Build exam format context if available
  let examFormatContext = '';
  if (examFormat && Object.keys(examFormat).length > 0) {
    const parts: string[] = [];
    const stemStyle = examFormat.stem_style as Record<string, unknown> | undefined;
    const optionCount = examFormat.option_count || (stemStyle?.option_count);
    const philosophy = examFormat.testing_philosophy as string;
    const distinctive = (examFormat.distinctive_patterns as string[]) || [];
    const antiPatterns = (examFormat.what_NOT_to_do as string[]) || [];
    const recallRatio = examFormat.recall_vs_reasoning_ratio as Record<string, unknown> | undefined;

    if (philosophy) parts.push(`Testing philosophy: ${philosophy}`);
    if (stemStyle?.typical_format) parts.push(`Expected stem format: ${stemStyle.typical_format}`);
    if (optionCount) parts.push(`Expected option count: ${optionCount}`);
    if (recallRatio?.description) parts.push(`Recall vs reasoning: ${recallRatio.description}`);
    if (distinctive.length > 0) parts.push(`Distinctive patterns:\n${distinctive.slice(0, 4).map(p => `  • ${p}`).join('\n')}`);
    if (antiPatterns.length > 0) parts.push(`What this exam does NOT do:\n${antiPatterns.slice(0, 3).map(p => `  • ${p}`).join('\n')}`);

    if (parts.length > 0) {
      examFormatContext = `\nEXAM FORMAT REQUIREMENTS (use these to judge format compliance):\n${parts.join('\n')}\n`;
    }
  }

  // Build guidelines context if available
  let guidelinesContext = '';
  if (guidelines && Object.keys(guidelines).length > 0) {
    const gParts: string[] = [];
    const stem = guidelines.stem_guidelines as Record<string, unknown> | undefined;
    if (stem) {
      const rules: string[] = [];
      if (stem.style) rules.push(`Style: ${stem.style}`);
      if (stem.vignette_required) rules.push('Vignettes REQUIRED');
      if (stem.min_words || stem.max_words) rules.push(`Stem length: ${stem.min_words || '?'}–${stem.max_words || '?'} words`);
      const scenarioDepth = stem.scenario_depth ?? stem.clinical_scenario_depth;
      if (scenarioDepth) rules.push(`Scenario depth: ${scenarioDepth}`);
      if (rules.length > 0) gParts.push(`Stem: ${rules.join(', ')}`);
    }
    const dist = guidelines.distractor_guidelines as Record<string, unknown> | undefined;
    if (dist) {
      const rules = (dist.quality_rules as string[]) || [];
      if (rules.length > 0) gParts.push(`Distractor rules:\n${rules.slice(0, 5).map(r => `  • ${r}`).join('\n')}`);
    }
    const expl = guidelines.explanation_guidelines as Record<string, unknown> | undefined;
    if (expl) {
      const rules: string[] = [];
      if (expl.must_justify_correct) rules.push('Must justify correct answer');
      if (expl.must_address_distractors) rules.push('Must address why distractors are wrong');
      if (expl.min_sentences) rules.push(`Min ${expl.min_sentences} sentences`);
      if (rules.length > 0) gParts.push(`Explanation: ${rules.join(', ')}`);
    }
    const anti = (guidelines.anti_patterns as string[]) || [];
    if (anti.length > 0) gParts.push(`Anti-patterns to flag:\n${anti.slice(0, 5).map(a => `  • ${a}`).join('\n')}`);
    const coverage = (guidelines.coverage_rules as string[]) || [];
    if (coverage.length > 0) gParts.push(`Coverage rules:\n${coverage.slice(0, 4).map(c => `  • ${c}`).join('\n')}`);

    if (gParts.length > 0) {
      guidelinesContext = `\nGENERATION GUIDELINES (check compliance against these rules):\n${gParts.join('\n')}\n`;
    }
  }

  // Determine which format-specific checks to include based on batch contents
  const hasCaseStudy = !formatsInBatch || formatsInBatch.has('case_study');
  const hasHotSpot = !formatsInBatch || formatsInBatch.has('hot_spot');

  // Build format-specific check sections
  let formatSpecificChecks = '';
  if (hasCaseStudy) {
    formatSpecificChecks += `
8. CASE STUDY COMPLIANCE (for format_type = "case_study"):
   a. Does the case have exactly 6 sub-questions? If fewer, flag and set needs_revision true.
   b. Does the case use at least 3 DIFFERENT format_types across sub-questions? If only 1-2, flag.
   c. Does EACH sub-question have its own "rationale" field? If any rationale is missing or empty, flag.
   d. Does each sub-question have a "reasoning_step" tag (legacy: "cjmm_step")? If missing, flag. Accept any step taxonomy appropriate to this exam's discipline — do NOT require the nursing Clinical-Judgment labels for non-clinical exams.${hasHotSpot ? `
   e. Hot_spot sub-questions must use the stimulus+correct_ids contract (see check 11).` : ''}`;
  }
  if (hasHotSpot) {
    formatSpecificChecks += `
11. HOT_SPOT CONTRACT (for format_type = "hot_spot", including hot_spot sub-questions inside case studies):
   The answer MUST be a set of target IDs — NEVER a text description of where to click.
   a. (HS001) If answer.region, answer.label, or answer.landmark exists → ERROR. Remove free-text answer; enumerate clickable elements as stimulus.targets with ids and set answer.correct_ids.
   b. (HS002) content.stimulus must exist with type "text_targets" or "image_regions". If missing → ERROR.
   c. (HS003) stimulus must have ≥2 targets/regions. If fewer → ERROR.
   d. (HS004) Every target/region must have a valid lowercase-slug id matching ^[a-z0-9][a-z0-9_-]*$. If missing or invalid → ERROR.
   e. (HS005) All ids must be unique within the item. If duplicates → ERROR.
   f. (HS006) answer.correct_ids must exist and be non-empty. If missing → ERROR.
   g. (HS007) correct_ids must not have duplicates.
   h. (HS008) Every id in correct_ids must exist in stimulus targets/regions (referential integrity). If not → ERROR.
   i. (HS010) content.scoring must be "dichotomous" or "plus_minus". If missing or invalid → ERROR.
   j. (HS011) content.rationale should have one entry per target id. If missing → WARNING.
   Report hot_spot contract violations in "hotspot_issues" array. Score ≤ 4 if any HS error found.`;
  }

  // Build format-specific scoring notes
  const scoringLowNotes: string[] = ['wrong answer, dangerous error, broken question'];
  if (hasCaseStudy) scoringLowNotes.push('case study missing sub-question rationales');
  if (hasHotSpot) scoringLowNotes.push('hot_spot contract violations (HS001-HS008)');
  scoringLowNotes.push('OR image explicitly referenced but absent');

  // Build format-specific output fields
  const caseStudyField = hasCaseStudy
    ? `\n    "case_study_issues": [<flag if: fewer than 6 sub-questions, fewer than 3 format types, missing sub-question rationales, missing reasoning_step tags${hasHotSpot ? ', hot_spot answers are prose' : ''} — empty if none or not a case_study>],`
    : '';
  const hotspotField = hasHotSpot
    ? `\n    "hotspot_issues": [<flag if: hot_spot contract violations — HS001-HS011 codes with specific fix instructions — empty if not hot_spot or no violations>],`
    : '';

  // qbank (V1 lines 5803-5857)
  return `You are a senior ${domain} exam item validator.
${examFormatContext}${guidelinesContext}
YOUR ROLE — accuracy, relevance, AND format compliance: Is everything in this question factually correct? Does it match the target exam's format and structure?
You are NOT here to improve, expand, or polish. Only flag what is wrong, irrelevant, or non-compliant.

You will receive multiple questions numbered Q1, Q2, etc.

For EACH question ask:
1. Is the marked correct answer factually correct? If yes, score it high and move on.
2. Are the distractors factually wrong? Minor edge cases that don't change the answer are NOT issues.
3. EXPLANATION QUALITY (CRITICAL — score ≤ 6 if deficient):
   a. Does the explanation justify WHY the correct answer is right?
   b. Does the explanation address EACH distractor/wrong option BY NAME and state WHY it is wrong?
   c. If the explanation only defends the correct answer without discussing distractors → flag as "explanation_issues" and set needs_revision true.
   d. Minimum 3 sentences for standalone questions.
4. Does the stem/scenario contain the minimum data needed to reach the correct answer?
5. Is the content free of factual inaccuracies?
6. FORMAT COMPLIANCE (if exam format requirements are provided above):
   a. Does the stem match the expected format (e.g., scenario/vignette vs. direct recall)?
   b. Does the option count match (e.g., 4 options vs. 5)?
   c. Are the distractors structured as the exam expects (homogeneous length, parallel construction)?
   d. Is the Bloom's level a valid normalized value (2_understand, 3_apply, 4_analyze, 5_evaluate)? Flag non-standard labels like NCJMM_*, raw text labels, etc.
7. DIFFICULTY FIELD:
   a. Does the question have a difficulty field with value "easy", "medium", or "hard"?
   b. If missing or invalid → flag as format_compliance_issues.
   c. Is the assigned difficulty reasonable for the question's complexity?${formatSpecificChecks}
9. ANSWER KEY DIVERSITY — check the correct answer keys across the batch:
   a. Note the correct answer letter (A/B/C/D/E) for each question.
   b. If more than 40% of questions in this batch share the same correct answer key, flag the over-represented ones and request the answer key be changed (with appropriate content adjustment).
10. IMAGE — relevance only:
   a. Image absent but the stem explicitly references it (e.g. "shown below", "image 1", "radiograph shown") → score ≤ 4 and set needs_revision true. The question is UNUSABLE without its image regardless of how good the text is.
   b. Image present but wrong modality or clearly irrelevant → flag and suggest replacement.
   c. Image that is imperfect but appropriate for the question → do NOT flag.

Scoring (10 = nothing to fix, 1 = unacceptable):
• 9–10 → factually correct, explanation addresses all options, format compliant — do not change
• 7–8 → minor imprecision, correct answer not in doubt, explanation mostly complete
• 5–6 → explanation only defends correct answer without discussing distractors, OR format non-compliance, OR missing difficulty/bloom
• 1–4  → ${scoringLowNotes.join(', ')}

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
    "factual_errors": [<confirmed wrong facts only — empty if none>],
    "distractor_issues": [<only if a distractor is genuinely defensible as correct — empty if none>],
    "vignette_issues": [<only if key data is missing to reach the answer — empty if none>],
    "explanation_issues": [<flag if: explanation only defends correct answer without discussing distractors, too short, or contradicts answer — empty if none>],${caseStudyField}
    "difficulty_issues": [<flag if: difficulty field missing, invalid value, or unreasonable for question complexity — empty if none>],${hotspotField}
    "format_compliance_issues": [<stem format, option count, Bloom's level mismatches, non-normalized bloom labels — empty if none>],
    "answer_key_issue": "<if this question's correct answer contributes to a skewed distribution (e.g., too many 'B' answers), suggest changing to a different key with rationale — null if fine>",
    "asset_issues": [<image mismatch — replace image only — empty if none>],
    "missing_images": [<image absent but explicitly required — empty if none>],
    "recommendations": [<empty if none>],
    "changes_required": [<NUMBERED list of concrete changes needed. Empty if score > 7.
      Each entry is a complete, self-contained instruction.
      Examples:
        "1. Replace the attached image with one that matches what the stem describes",
        "2. Fix the correct answer from B to A — state the correct fact/rule for this exam"
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
  domain = 'exam preparation',
  examFormat?: Record<string, unknown>,
  guidelines?: Record<string, unknown>
): Promise<Record<string, unknown>[]> {
  // Detect which format types are in this batch to conditionally include checks
  const formatsInBatch = new Set<string>();
  for (const q of questions) {
    const ft = (q.format_type as string)
      || ((q.tags as Record<string, unknown>)?.format_type as string)
      || 'mcq_single';
    formatsInBatch.add(ft);
    // Also check for hot_spot sub-questions inside case studies
    if (ft === 'case_study') {
      const subs = ((q.content as Record<string, unknown>)?.sub_questions as Array<Record<string, unknown>>) || [];
      for (const s of subs) {
        if (s.format_type === 'hot_spot') formatsInBatch.add('hot_spot');
      }
    }
  }

  const prompt = getBatchValidatorPrompt(contentType, domain, examFormat, guidelines, formatsInBatch);
  const content = await formatQuestionsForReviewWithImages(questions);

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

  // Never throw: a Bedrock/network failure here would otherwise crash the whole
  // review pipeline (losing all questions). Return whatever we can parse; empty
  // results are handled downstream as needs_review.
  let results: Record<string, unknown>[] = [];
  try {
    const response = await orCall(MODELS.VALIDATOR, '', userMessage, {
      maxTokens: 16000,
      temperature: 0.3,
    });
    results = extractJsonArray(response.content, questions.length);
  } catch (e) {
    console.warn(`  [Validator] LLM call failed for batch of ${questions.length}: ${e instanceof Error ? e.message : e}`);
  }

  // Retry if too few results (covers truncation AND a failed first call)
  if (results.length < questions.length) {
    console.log(`  [Validator] Short response (${results.length}/${questions.length}), retrying...`);
    try {
      const response2 = await orCall(MODELS.VALIDATOR, '', userMessage, {
        maxTokens: 16000,
        temperature: 0.1,
      });
      const results2 = extractJsonArray(response2.content, questions.length);
      if (results2.length > results.length) results = results2;
    } catch (e) {
      console.warn(`  [Validator] Retry LLM call failed: ${e instanceof Error ? e.message : e}`);
    }
  }

  // HARD GATE: a case_study/TBS whose sub-questions aren't machine-gradable must
  // never pass, regardless of what the LLM scored. Deterministic override.
  for (let i = 0; i < questions.length; i++) {
    const issues = gradabilityIssues(questions[i]);
    if (issues.length === 0) continue;
    const r = results.find((x) => (x.question_number as number) === i + 1) || results[i];
    if (!r) continue;
    const prior = (r.overall_accuracy_score as number) ?? 5;
    r.overall_accuracy_score = Math.min(prior, 3);
    r.needs_revision = true;
    r.case_study_issues = [ ...((r.case_study_issues as string[]) || []), ...issues.map((s) => `NOT GRADABLE — ${s}`) ];
    r.changes_required = [ ...((r.changes_required as string[]) || []), ...issues.map((s) => `Fix gradability: ${s}`) ];
    r.summary = `Ungradable sub-question(s): ${issues.slice(0, 3).join('; ')}${issues.length > 3 ? '…' : ''}`;
  }

  return results;
}
