/**
 * Validator review — faithful port of V1's get_batch_validator_prompt() (app.py 5748-5857)
 * Model: OR_VALIDATOR_MODEL (MODELS.VALIDATOR)
 */

import { orCall, MODELS } from '../llm/openrouter.js';
import type { ContentPart } from '../llm/openrouter.js';
import { extractJsonArray, formatQuestionsForReviewWithImages, gradabilityIssues } from './shared.js';
import { schemaErrorsFor } from '../generation/schemaValidate.js';
import { coherenceIssues } from '../generation/coherence.js';
import { consistencyIssues, isBlockingConsistency } from '../generation/consistency.js';
import { EXISTING_ITEM_RULES } from './changeRouting.js';
import { RESTRUCTURE_RULES, cueIssues } from './reviewMode.js';

/**
 * Per-format rules to include. High enough that no course's real spec is truncated — the
 * largest in the six live courses is 40 — and present only so a malformed guidelines document
 * cannot push an unbounded list into the prompt.
 */
const FORMAT_RULE_CAP = 60;

/** The same guard for the course-wide rule lists, which were capped at three to five. */
const GUIDELINE_RULE_CAP = 20;

// ── Validator Prompt (V1 lines 5803-5857, verbatim) ──

/** existingBank: the items are already in use (imported from a live bank) — see changeRouting.ts. */
export interface ReviewOptions { existingBank?: boolean; restructure?: boolean; guidelines?: Record<string, unknown> }

export function getBatchValidatorPrompt(contentType: string, domain = 'exam preparation', examFormat?: Record<string, unknown>, guidelines?: Record<string, unknown>, formatsInBatch?: Set<string>, opts?: ReviewOptions): string {
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
    if (distinctive.length > 0) parts.push(`Distinctive patterns:\n${distinctive.slice(0, GUIDELINE_RULE_CAP).map(p => `  • ${p}`).join('\n')}`);
    if (antiPatterns.length > 0) parts.push(`What this exam does NOT do:\n${antiPatterns.slice(0, GUIDELINE_RULE_CAP).map(p => `  • ${p}`).join('\n')}`);

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
      if (rules.length > 0) gParts.push(`Distractor rules:\n${rules.slice(0, GUIDELINE_RULE_CAP).map(r => `  • ${r}`).join('\n')}`);
    }
    const expl = guidelines.explanation_guidelines as Record<string, unknown> | undefined;
    if (expl) {
      const rules: string[] = [];
      if (expl.must_justify_correct) rules.push('Must justify correct answer');
      if (expl.must_address_distractors) rules.push('Must address why distractors are wrong');
      if (expl.min_sentences) rules.push(`Min ${expl.min_sentences} sentences`);
      if (rules.length > 0) gParts.push(`Explanation: ${rules.join(', ')}`);
    }
    // The declared targets for the whole set. A batch of ten cannot audit a distribution — that
    // is done deterministically over the finished bank (generation/distribution.ts) — but the
    // reviewer still needs them to judge whether an individual question's assigned Bloom level
    // or difficulty is plausible, and to apply the course's OWN key-balance rule rather than a
    // hardcoded one. CPA and NCLEX both cap a single key at 30%; check 9 below assumed 40%.
    const pctLine = (label: string, v: unknown): string | null => {
      if (!v || typeof v !== 'object') return null;
      const entries = Object.entries(v as Record<string, unknown>)
        .filter(([, n]) => Number(n) > 0)
        .map(([k, n]) => `${k} ${n}%`);
      return entries.length ? `${label}: ${entries.join(', ')}` : null;
    };
    const bloomTarget = pctLine("Bloom's levels across the whole set", guidelines.blooms_distribution);
    const diffTarget = pctLine('Difficulty across the whole set', guidelines.difficulty_distribution);
    if (bloomTarget) gParts.push(bloomTarget);
    if (diffTarget) gParts.push(diffTarget);
    const keyBalance = String(guidelines.answer_key_balance ?? '').trim();
    if (keyBalance) gParts.push(`Answer-key balance (THIS course's rule — apply it, not a generic one):\n  ${keyBalance}`);

    const anti = (guidelines.anti_patterns as string[]) || [];
    if (anti.length > 0) gParts.push(`Anti-patterns to flag:\n${anti.slice(0, GUIDELINE_RULE_CAP).map(a => `  • ${a}`).join('\n')}`);
    const coverage = (guidelines.coverage_rules as string[]) || [];
    if (coverage.length > 0) gParts.push(`Coverage rules:\n${coverage.slice(0, GUIDELINE_RULE_CAP).map(c => `  • ${c}`).join('\n')}`);

    // The contract each format must satisfy, taken whole from the course's own guidelines.
    //
    // This block used to keep the first eight rules and drop the rest, and read only
    // validation_checks and structure_requirements. CPA's mcq_single spec alone carries 14
    // validation_checks, 8 structure_requirements, 9 content_rules and 8 syntax_rules — so
    // two thirds of the contract never reached the reviewer, including "verify every
    // numerical value needed to solve the item appears in the question" and "verify the
    // explanation supports the keyed answer and separately explains why each of the other
    // three options is wrong". Both describe faults a tester later found by hand.
    //
    // Only the formats present in this batch contribute, so the size stays bounded by what is
    // actually being reviewed. content_rules and syntax_rules are where a course states its
    // own subject-matter conventions, which is precisely the material that must NOT be
    // hardcoded into this prompt: they differ per course and they are already written down.
    const specs = guidelines.format_specs as Record<string, Record<string, unknown>> | undefined;
    if (specs && Object.keys(specs).length > 0) {
      const list = (v: unknown) => (Array.isArray(v) ? (v as unknown[]).map(String) : v ? [String(v)] : []);
      const blocks: string[] = [];
      for (const [fmt, spec] of Object.entries(specs)) {
        if (formatsInBatch && !formatsInBatch.has(fmt)) continue;
        if (!spec || typeof spec !== 'object') continue;
        const checks = [
          ...list(spec.validation_checks),
          ...list(spec.structure_requirements),
          ...list(spec.content_rules),
          ...list(spec.syntax_rules),
          ...list(spec.gradability),
        ];
        // Identical wording appears in more than one family; say each rule once.
        const unique = [...new Set(checks.map((c) => c.trim()).filter(Boolean))];
        if (unique.length > 0) {
          blocks.push(`  [${fmt}] must satisfy:\n${unique.slice(0, FORMAT_RULE_CAP).map(c => `    • ${c}`).join('\n')}`);
        }
      }
      if (blocks.length > 0) gParts.push(`PER-FORMAT COMPLIANCE (verify each question against its format's requirements; flag violations):\n${blocks.join('\n')}`);
    }

    if (gParts.length > 0) {
      guidelinesContext = `\nGENERATION GUIDELINES (check compliance against these rules):\n${gParts.join('\n')}\n`;
    }
  }

  // Determine which format-specific checks to include based on batch contents
  const hasCaseStudy = !formatsInBatch || formatsInBatch.has('case_study');
  const hasHotSpot = !formatsInBatch || formatsInBatch.has('hot_spot');
  const inBatch = (f: string) => !formatsInBatch || formatsInBatch.has(f);

  // Build format-specific check sections
  let formatSpecificChecks = '';

  // Adaptive per-format structural checks — for whatever structured formats are
  // present in this batch (standalone questions OR case-study sub-questions).
  const structuralChecks: string[] = [];
  if (inBatch('matrix_grid')) structuralChecks.push('matrix_grid: needs row_headers[] + column_headers[] + a correct classification for EVERY row; columns must be mutually exclusive & collectively exhaustive.');
  if (inBatch('cloze_dropdown')) structuralChecks.push('cloze_dropdown: EVERY blank needs a plausible options list that INCLUDES the correct value, and a stated correct value; the stem must mark each blank.');
  if (inBatch('emq')) structuralChecks.push('emq: needs an option_list and, for each scenario, exactly one correct option drawn from that list.');
  if (inBatch('ordered_response') || inBatch('drag_drop')) structuralChecks.push('ordered_response: needs items[] + correct_order (1-based indices in the correct sequence); flag if the order is arbitrary or unjustified.');
  if (inBatch('fill_blank')) structuralChecks.push('fill_blank: needs an explicit correct answer value (with acceptable alternatives if relevant) — NOT only in the explanation.');
  if (inBatch('sata') || inBatch('mcq_multi')) structuralChecks.push('sata: needs options[] + a set of correct keys (≥1); distractors must be genuinely incorrect.');
  // Self-consistency, as a prompt check alongside the deterministic one in the hard gate below.
  // These are the faults a QA pass actually found, each of which passed gradability and schema:
  // an item can be perfectly well-formed and still be impossible, or trivial, to answer.
  if (inBatch('document_review') || inBatch('task_based_simulation') || inBatch('tbs')) {
    structuralChecks.push('document_review: a passage keyed "No change is required" must NOT also offer an option repeating that passage word for word — both are the same claim, so a candidate who agrees with the key is marked wrong.');
    structuralChecks.push('document_review: flag a task whose passages are ALL keyed "No change is required" (it scores full marks without being read) or where NO passage is correct as written (that option is then never the answer).');
    structuralChecks.push('simulation: response_instructions must name ONLY controls the task actually has. Flag instructions demanding a minus sign, a matrix, a dropdown, a journal entry or a document-review field that is absent from sub_questions.');
    structuralChecks.push('simulation: a journal-entry grid scores per row, so the task must state the line order its key expects; otherwise a correct entry in another order loses the moved lines.');
  }
  if (structuralChecks.length > 0) {
    formatSpecificChecks += `
12. FORMAT STRUCTURE & GRADABILITY (for the formats in this batch): each question MUST carry the complete machine-readable answer scaffolding for its format. Flag (score ≤ 4, needs_revision) any question whose answer is not auto-gradable:
${structuralChecks.map((s) => `   • ${s}`).join('\n')}`;
  }
  if (hasCaseStudy) {
    formatSpecificChecks += `
8. CASE STUDY COMPLIANCE (for format_type = "case_study"):
   a. Does the case carry the number of sub-questions THIS exam's format_specs require? Judge against the PER-FORMAT COMPLIANCE rules above, which may permit more than one shape — a NextGen Bar drafting set is ONE constructed_response component and is correct that way. Flag a count only when it contradicts those rules; never assume six.
   b. Where those rules require a MIX of formats, does the case use at least 3 different format_types? A set the rules define as single-component is exempt — do NOT flag it for lacking multiple-choice components.
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
    ? `\n    "case_study_issues": [<flag if: the sub-question count or format mix contradicts THIS exam's format_specs (never assume six), missing sub-question rationales, missing reasoning_step tags${hasHotSpot ? ', hot_spot answers are prose' : ''} — empty if none or not a case_study>],`
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
   a. If the key depends on a quantity the stem never states, name the missing figure. A question that establishes a quantity EXISTS without saying what it is, and then keys a specific amount, is unanswerable as written.
   b. Does the stem contradict itself? Flag an item that describes an amount one way and then treats it as something else.
   c. Do all quoted factors, rates, tables and assumptions come from ONE consistent set? Where two supplied figures imply different underlying parameters, no answer is reachable — recompute and say which two disagree.
   d. Does a named method or principle match the procedure actually applied to it? Flag an item that names one approach and performs a different one.
13. INTERNAL CONSISTENCY — does everything this item asserts agree with everything else it asserts? Work through it in this order and flag any step that fails:
   a. Recompute every calculation the explanation states. The arithmetic it shows must produce the value it claims. An explanation that derives one number and then announces a different one is wrong wherever the disagreement lies.
   b. The value the explanation arrives at must be the value the keyed option carries. If the working leads to one option and the key names another, say which.
   c. Every figure the explanation relies on must appear in the stem, an exhibit, the passage, or be derived from them. An explanation that introduces a number from nowhere is not reproducible by a candidate.
   d. No two options may be the same answer in different words, or the same quantity written differently.
   e. Within a grouped item, sub-questions must not apply contradictory rules, mechanics or assumptions to the same facts. Name both sub-questions when they do.
   f. The explanation's verdict must match the stored key: an explanation defending one option while the key names another means the learner is shown a justification for an answer marked wrong.
5. Is the content free of factual inaccuracies?
   a. NAMED FRAMEWORK OR AUTHORITY — where a question names the regime it is asked under (a standard, a jurisdiction, a guideline, a protocol, an edition), verify the answer is right under THAT one, not under a neighbouring regime that treats the same facts differently. An answer that is correct only under the framework the question did NOT name is wrong.
   b. SUPERSEDED GUIDANCE — flag an answer that depends on a rule, threshold or classification that has since been amended or withdrawn.
   c. MORE THAN ONE DEFENSIBLE ANSWER — if the governing rule permits several responses, check that only ONE of them appears among the options. Where two or more options are jointly permitted, flag it (needs_revision) and name them.
   d. CONTESTED AUTHORITY — where authorities genuinely split, the stem must say which view it applies, or more than one option is right.
6. FORMAT COMPLIANCE (if exam format requirements are provided above):
   a. Does the stem match the expected format (e.g., scenario/vignette vs. direct recall)?
   ${opts?.existingBank
    ? 'Stored fields (format_type, is_image_question, image_type, image_search_terms, subject, topic, chapter, tags) are kept by the platform, not written in the item: do NOT request that any be supplied or changed, and do NOT lower the score for their absence. Review what a candidate reads — stem, options, key, explanation, image.\n   ' + (opts?.restructure
      ? 'b. Exactly five options are required. Flag any other count and ask for options to be added or merged to five.'
      : 'b. Do NOT flag the option count. These items are already in use and every option carries recorded answers: never request that an option be added, removed, merged or reordered — edit an option\'s wording in place if it is wrong.')
    : 'b. Does the option count match (e.g., 4 options vs. 5)?'}
   c. Are the distractors structured as the exam expects (homogeneous length, parallel construction)?
   d. Is the Bloom's level a valid normalized value (2_understand, 3_apply, 4_analyze, 5_evaluate)? Flag non-standard labels like NCJMM_*, raw text labels, etc.
7. DIFFICULTY AND BLOOM — is each question labelled with a level it actually sits at?
   a. Does the question carry a difficulty of "easy", "medium" or "hard", and a normalized Bloom level? If either is missing or invalid → flag as format_compliance_issues.
   b. Is the assigned difficulty right for what the question demands? A one-step recall keyed "hard", or a multi-step derivation keyed "easy", is mislabelled — say which it should be.
   c. Is the assigned Bloom level right for the cognitive work required? Recalling a threshold is not applying one, and applying a rule is not analysing a case. Where the whole-set targets are given above, a question labelled at a level it does not reach makes that target meaningless — so judge the label against the question, not against the target.${opts?.existingBank ? `
   d. For these existing items a wrong label is recorded, not repaired: report it in difficulty_issues only, never in changes_required, and do not lower the score for it.` : ''}${formatSpecificChecks}
${opts?.existingBank ? `9. ANSWER KEY — these questions come from an existing bank and are reviewed in arbitrary batches, so the letters in this batch say nothing about the bank's balance:
   a. Do NOT flag answer-key distribution or runs, and do NOT compare questions with each other.
   b. Ask for the keyed answer to change ONLY when it is factually wrong for the vignette as written; give the evidence in answer_key_issue. Never ask for it to move for balance.
${opts?.restructure ? RESTRUCTURE_RULES : EXISTING_ITEM_RULES}` : `9. ANSWER KEY DIVERSITY — check the correct answer keys across the batch:
   a. Note the correct answer letter (A/B/C/D/E) for each question.
   b. Apply the course's own answer-key rule where one is given above. Where none is, flag if more than 40% of questions in this batch share the same key. Flag the over-represented ones and request the key be changed, with the content adjustment that makes the new key correct — never relabel an option without moving the content.
   c. Flag any run of consecutive questions in this batch sharing one key that exceeds the course's stated run limit.
   d. A batch is a tenth of the bank, so do NOT infer a whole-set imbalance from it. Report what this batch shows and nothing more.`}
10. IMAGE — relevance, and whether it shows what the question needs:
   a. Image absent but the stem explicitly references it (e.g. "shown below", "image 1", "radiograph shown") → score ≤ 4 and set needs_revision true. The question is UNUSABLE without its image regardless of how good the text is.
   b. Image present but wrong modality or clearly irrelevant → flag and suggest replacement.
   c. Image present and the right kind of picture, but it does NOT show what the answer is read from → flag (score ≤ 4, needs_revision true) and say which feature is missing or wrong. Where an IMAGE WAS SPECIFIED AS block is given, check the image against it. A figure can be on topic and still be unusable: a growth chart whose plotted points do not sit at the percentiles they are labelled with, a rhythm strip drawn as a regular narrow-QRS trace where the specification sets out atrial and ventricular activity at different rates, a graph whose axis values contradict the stem. If a candidate cannot read the value, trend or relationship the correct answer depends on, the question cannot be answered.
   d. Image that is imperfect in style or polish but shows everything the question is read from → do NOT flag. Judge it on what the answer needs, not on how it looks.
14. SCOPE — does the item belong to THIS exam at all? If it obviously tests material for a different exam (another country's law, national programmes or practice, or an item written for another exam — the course's coverage rules name the usual cases and which exam they belong to), set belongs_to_other_exam to that exam's name and the reason, score ≤ 3, and request NO changes: such an item is moved, not repaired. Use this only when it is obvious; an item that is merely hard, niche or imperfect belongs here and gets normal feedback.

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
    "explanation_issues": [<flag if: explanation only defends correct answer without discussing distractors, too short, or contradicts answer — empty if none>],
    "consistency_issues": [<check 13 — a calculation that does not produce the value it states, working that leads to a different option than the key, a figure the explanation uses that appears nowhere in the stimulus, two options that are the same answer, sub-questions applying contradictory rules. State the two things that disagree. Empty if none>],${caseStudyField}
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
    "belongs_to_other_exam": <check 14 — null unless the item obviously belongs to another exam; then {"exam": "<that exam's name, as the course rules give it>", "reason": "<one sentence>"}>,
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
  guidelines?: Record<string, unknown>,
  opts?: ReviewOptions
): Promise<Record<string, unknown>[]> {
  // Detect which format types are in this batch to conditionally include checks
  const formatsInBatch = new Set<string>();
  for (const q of questions) {
    const ft = (q.format_type as string)
      || ((q.tags as Record<string, unknown>)?.format_type as string)
      || 'mcq_single';
    formatsInBatch.add(ft);
    // Any grouped question (case study, TBS, passage set, …) — detected by shape —
    // surfaces its sub-question formats so their format-specific checks are included.
    const subs = ((q.content as Record<string, unknown>)?.sub_questions as Array<Record<string, unknown>>) || [];
    for (const s of subs) {
      if (s.format_type) formatsInBatch.add(s.format_type as string);
    }
  }

  const prompt = getBatchValidatorPrompt(contentType, domain, examFormat, guidelines, formatsInBatch, opts);
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

  // HARD GATE (deterministic override, regardless of the LLM score):
  //  1) gradability — an ungradable question can never pass.
  //  2) schema — a question that violates its format's materialized content_schema
  //     (the contract the guidelines step fixed) can never pass.
  //  3) coherence — a question that contradicts ITSELF can never pass. This is a distinct
  //     property from the first two: a QA pass found 52 faults that were all gradable and all
  //     schema-valid, which is precisely why they reached a tester. Instructions naming fields
  //     the task lacks, an option repeating the passage it is meant to correct, a document
  //     review keyed so that it scores full marks without being read.
  //  4) consistency — what the question ASSERTS must agree with what else it asserts. Where
  //     coherence reads structure, this reads content: a stated calculation that does not
  //     produce its stated result, two options carrying one value, an explanation defending an
  //     option the key does not name. Measured before being wired in (benchmarkGates.ts): one
  //     blocking finding across the 2,804 rows of the three pre-repair snapshots, and that one
  //     a defect a tester had independently reported. Advisory findings are left to the LLM
  //     score rather than blocking, because an option order is a convention, not an error.
  for (let i = 0; i < questions.length; i++) {
    const q = questions[i];
    const fmt = (q.format_type as string) || ((q.tags as Record<string, unknown>)?.format_type as string) || 'mcq_single';
    const gradeIssues = gradabilityIssues(q);
    const schemaIssues = schemaErrorsFor(guidelines, fmt, q.content).map((s) => `schema: ${s}`);
    const cohIssues = coherenceIssues(q).map((s) => `coherence: ${s}`);
    const conIssues = consistencyIssues(q).filter(isBlockingConsistency).map((s) => `consistency: ${s}`);
    const issues = [...gradeIssues, ...schemaIssues, ...cohIssues, ...conIssues];
    if (issues.length === 0) continue;
    const r = results.find((x) => (x.question_number as number) === i + 1) || results[i];
    if (!r) continue;
    const prior = (r.overall_accuracy_score as number) ?? 5;
    r.overall_accuracy_score = Math.min(prior, 3);
    r.needs_revision = true;
    r.case_study_issues = [ ...((r.case_study_issues as string[]) || []), ...issues.map((s) => `NOT COMPLIANT — ${s}`) ];
    r.changes_required = [ ...((r.changes_required as string[]) || []), ...issues.map((s) => `Fix: ${s}`) ];
    r.summary = `Structural/gradability issue(s): ${issues.slice(0, 3).join('; ')}${issues.length > 3 ? '…' : ''}`;
  }

  // Cues to the key a model is unreliable at counting: option count, the keyed option standing out by
  // length, all/none-of-the-above. Restructure mode only, where options may change. Each becomes a
  // change request and holds the score at 6 so the fixer runs; none of them blocks on its own.
  if (opts?.restructure) {
    for (let i = 0; i < questions.length; i++) {
      const cues = cueIssues(questions[i]);
      if (!cues.length) continue;
      const r = results.find((x) => (x.question_number as number) === i + 1) || results[i];
      if (!r) continue;
      r.overall_accuracy_score = Math.min((r.overall_accuracy_score as number) ?? 6, 6);
      r.needs_revision = true;
      const have = new Set((r.changes_required as string[]) || []);
      r.changes_required = [...have, ...cues.filter((c) => !have.has(c))];
    }
  }

  return results;
}
