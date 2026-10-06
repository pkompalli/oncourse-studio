/**
 * Adversarial review — faithful port of V1's get_batch_adversarial_prompt() (app.py 5860-5966)
 * Model: OR_ADVERSARIAL_MODEL (GPT-5.4)
 *
 * Runs in two phases, and the order is the point.
 *
 * PHASE 1 (blind) sits the question. Stem, options, passage, exhibits, image — no key, no
 * explanation, no rationale, nothing derived from them. The reviewer commits to an answer and
 * says where the item fought back: a figure that is not supplied, two facts that cannot both
 * hold, no option that fits, more than one that does.
 *
 * PHASE 2 (informed) reveals the key and the explanation alongside phase 1's own attempt, and
 * asks the usual adversarial questions about the gap between them.
 *
 * The reason for the split is a measured one. A QA pass returned 19 items whose key or options
 * were wrong, and in every one the explanation AGREED with the key — "B is correct because…"
 * where B was what the row stored. A reviewer shown the key and a fluent justification for it
 * confirms; it does not check. The tester who found all 19 did the one thing this stage was
 * never able to do, which was to answer the question first. Phase 1 restores that, and the
 * disagreement between phase 1's answer and the stored key is then a deterministic signal
 * needing no judgment at all.
 */

import { orCall, MODELS } from '../llm/openrouter.js';
import type { ContentPart } from '../llm/openrouter.js';
import { extractJsonArray, formatQuestionsForReviewWithImages } from './shared.js';
import type { ReviewOptions } from './validator.js';

// ── Adversarial Prompt (V1 lines 5915-5966) ──

export function getBatchAdversarialPrompt(contentType: string, domain = 'exam preparation', examFormat?: Record<string, unknown>, opts?: ReviewOptions): string {
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

  // The course sets its own key-balance rule (generation_guidelines.answer_key_balance), as the
  // validator already reads it; this stage used to apply a generic "roughly equal" instead.
  const keyRule = typeof opts?.guidelines?.answer_key_balance === 'string' ? (opts.guidelines.answer_key_balance as string).trim() : '';

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
   a. Must carry the number of sub-questions THIS exam's guidelines require — do NOT assume six. Some exams define more than one valid shape: a NextGen Bar drafting set is ONE constructed_response component and is correct that way, while a counselling set has six. Flag a count only when it contradicts the exam's own rules.
   b. Where the exam's rules require a MIX of formats, must use at least 3 different format_types. A shape the rules define as single-component is exempt — do NOT flag it for lacking multiple-choice components.
   c. Each sub-question MUST have its own "rationale" explaining correct answer + why distractors are wrong
   d. Each sub-question MUST have a "reasoning_step" tag (legacy: "cjmm_step") using a step taxonomy appropriate to this exam's discipline — do NOT require the nursing Clinical-Judgment labels for non-clinical exams
   e. Hot-spot answers must be structured objects, not prose strings
   f. ANSWER-KEY CORRECTNESS — verify EACH keyed answer against the exhibit facts + stated rule. In particular:
      • Date/number boundary arithmetic: recompute the keyed value and check off-by-one errors (inclusive vs exclusive boundary). E.g. "earliest date documentation may be DESTROYED" = the day AFTER the retention period ends, not the last retained day. Flag if the key is off by one.
      • Rule grounding: the answer must be gradable against a rule/threshold/fact that ACTUALLY appears in an exhibit or the narrative. Flag any sub-question whose key depends on a rule not stated in any exhibit.
      • Cross-task consistency: two sub-questions in the same case must not apply contradictory rules (e.g. one task teaches "the 60-day documentation rule does not govern other deadlines" while another uses that same 60-day rule to judge a communication deadline). Flag the contradiction and name both sub-questions. This includes MECHANICS (e.g. physical vs cash settlement) — every sub-question must reflect the mechanics stated in the narrative.
      • Distractor ↔ rationale match: RECOMPUTE each distractor. Its displayed value MUST equal the wrong result its rationale attributes to it. Flag if the rationale says "applies the recovery rate" but the number is actually LGD-doubled, etc.
      • Leaked slugs: candidate-visible text must reference exhibits by their LABEL ("Exhibit 1"), never an internal id/slug (e.g. "cds-inputs-exhibit"). Flag any leaked slug.
      • response_instructions accuracy: must describe ONLY the response types actually present (no "enter basis points" if there is no bps entry) and specify the accepted numeric/date format. Flag mismatches.
      • Numeric options must be ordered ascending by value. Flag out-of-order option sets.
${opts?.existingBank ? `8. These questions come from an existing bank, already answered by candidates, and are reviewed in arbitrary batches. Do NOT compare them with each other: leave concept_overlap empty.
9. ANSWER KEY — leave answer_key_issue empty unless the keyed answer is wrong for the vignette as written. Never ask for a key to move, or for options to be reordered, added or removed, for balance.` : `8. CONCEPT DIVERSITY — look across the entire batch:
   a. Flag questions that test the EXACT same concept/fact as another question in the batch (conceptual duplicate even if worded differently)
   b. Flag questions that are too similar in scenario/presentation (e.g., 3 questions built on the same fact pattern → suggest varying it)
9. ANSWER KEY BALANCE — check correct answer distribution across the batch:
${keyRule
  ? `   a. Apply THIS course's rule, not a generic one: ${keyRule}
   b. A batch is a tenth of the bank: flag only what this batch shows against that rule.`
  : `   a. If correct answer keys are heavily skewed (e.g., 6 out of 10 are "B"), flag the ones that should change to achieve better balance
   b. A well-designed exam has roughly equal distribution across answer keys`}`}

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
    "case_study_issues": [<if case_study: missing sub-question rationales, a sub-question count or format mix that contradicts THIS exam's own rules (never assume six), missing reasoning_step, prose hot_spot answers — empty if none or not case_study>],
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

// ── Phase 1: sit the question ──

/** What stopped a candidate, named so the fixer is told which fault to repair. */
const BLOCKERS = [
  'insufficient_data — a value, fact or assumption the answer needs is not supplied anywhere',
  'inconsistent_data — two supplied facts cannot both hold, or imply different underlying parameters',
  'no_option_fits — the answer you reached is not among the options offered',
  'multiple_defensible — two or more options are correct under the facts as given',
  'ambiguous_stem — the question asks one thing while the options answer another, or the lead-in admits two readings',
] as const;

export function getBlindSolvePrompt(domain = 'exam preparation'): string {
  return `You are an expert ${domain} candidate sitting these questions under exam conditions.

You are given each question WITHOUT its answer key and WITHOUT its explanation. That is deliberate. Do not ask for them and do not guess at what they might say — answer from the stem, the options, and whatever passage, exhibit or image is supplied, exactly as a candidate would.

For EACH question:
1. Work it out. Do the arithmetic, apply the rule, read the figure.
2. Commit to an answer. Give the option letter(s). If the format is not multiple choice, give the value, ordering or selection the question asks for.
3. Say where the question fought back, using ONLY these labels where they genuinely apply:
${BLOCKERS.map((b) => `   • ${b}`).join('\n')}
4. State your confidence: high if one option is clearly right, medium if you had to choose between two, low if you are guessing.

Rules:
• Answer even when you flag a blocker — say what you would put down, then say what is wrong.
• Do NOT flag a blocker because a question is hard. Hard is not broken. Flag only what makes the question unanswerable, ambiguous, or answerable in more than one way.
• Do NOT comment on style, wording quality, difficulty, or educational value. That is not this pass.
• For a grouped item (case study, simulation, passage set), answer EVERY sub-question in order.

Return a JSON ARRAY — one object per question:
[
  {
    "question_number": 1,
    "answer": "<option letter(s): \\"B\\", or \\"B,D\\" for select-all. For a grouped item give one entry per sub-question in order: \\"1:B, 2:C, 3:A\\". For a non-choice format give the value or ordering.>",
    "confidence": "<high|medium|low>",
    "blockers": [<zero or more labels from the list above — empty if the question is sound>],
    "working": "<one or two sentences: how you reached it, or what stopped you>"
  },
  ...
]

Output ONLY the JSON array. No preamble, no trailing text.`;
}

/** The answers the row stores, one entry per sub-question (or one entry for a standalone). */
function storedAnswersOf(q: Record<string, unknown>): string[] | null {
  const content = (q.content as Record<string, unknown>) || {};
  const subs = content.sub_questions as Array<Record<string, unknown>> | undefined;
  if (Array.isArray(subs) && subs.length) {
    const keys = subs.map((s) => String(s.correct_answer ?? '').trim().toUpperCase().replace(/\s+/g, ''));
    // Only comparable when every sub-question is letter-keyed; a grid or ordering inside the
    // set makes the comparison meaningless.
    return keys.every((k) => /^[A-J](,[A-J])*$/.test(k)) ? keys : null;
  }
  const answer = (content.answer as Record<string, unknown>) || {};
  const keys = answer.keys ?? q.correct_answers;
  if (Array.isArray(keys) && keys.length) {
    return [keys.map((k) => String(k).trim().toUpperCase()).sort().join(',')];
  }
  const key = answer.key ?? q.correct_option;
  const s = String(key ?? '').trim().toUpperCase();
  return /^[A-J]$/.test(s) ? [s] : null;
}

/** The blind attempt, parsed the same way. Returns null when it cannot be read as letters. */
function parseBlindAnswers(raw: unknown, grouped: boolean): string[] | null {
  const s = String(raw ?? '').trim().toUpperCase();
  if (!s) return null;
  if (grouped) {
    // "1:B, 2:C, 3:A" — or a bare "B, C, A" in the same order.
    const parts = s.split(/[,;]/).map((p) => p.trim()).filter(Boolean);
    const letters = parts.map((p) => {
      const m = p.match(/^(?:\d+\s*[:.)]\s*)?([A-J](?:\s*,\s*[A-J])*)$/);
      return m ? m[1].replace(/\s+/g, '') : null;
    });
    return letters.every(Boolean) ? (letters as string[]) : null;
  }
  const multi = s.match(/^[A-J](\s*,\s*[A-J])+$/);
  if (multi) return [s.split(',').map((x) => x.trim()).sort().join(',')];
  return /^[A-J]$/.test(s) ? [s] : null;
}

/**
 * Where the blind attempt and the stored key part company.
 *
 * Reported per sub-question rather than per item, because a case study is one row but six
 * independent questions. Measured against the round-3 corpus, a whole-item flag sent a sound
 * four-part CFA set to the fixer over two sub-questions the blind attempt simply got wrong —
 * naming the parts at least keeps the repair pointed at what is actually disputed, and leaves
 * the rest of the set alone.
 */
function disagreementOf(q: Record<string, unknown>, raw: unknown): { any: boolean; detail: string } {
  const content = (q.content as Record<string, unknown>) || {};
  const grouped = Array.isArray(content.sub_questions) && (content.sub_questions as unknown[]).length > 0;
  const stored = storedAnswersOf(q);
  const got = parseBlindAnswers(raw, grouped);
  if (!stored || !got || stored.length !== got.length) return { any: false, detail: '' };

  const parts: string[] = [];
  stored.forEach((k, i) => {
    if (k === got[i]) return;
    parts.push(grouped ? `sub-question ${i + 1} (key ${k}, attempt ${got[i]})` : `key ${k}, attempt ${got[i]}`);
  });
  return { any: parts.length > 0, detail: parts.join('; ') };
}

export interface BlindAttempt {
  answer: string;
  confidence: string;
  blockers: string[];
  working: string;
  /** Set only where both the attempt and the stored key are comparable letter answers. */
  disagreesWithKey: boolean;
  /** Which sub-questions disagree, and what each side says. Empty when they agree. */
  disagreementDetail: string;
}

export async function runBlindSolveBatch(
  questions: Record<string, unknown>[],
  domain = 'exam preparation'
): Promise<Array<BlindAttempt | null>> {
  const prompt = getBlindSolvePrompt(domain);
  const content = await formatQuestionsForReviewWithImages(questions, /* blind */ true);

  const userMessage: string | ContentPart[] = typeof content === 'string'
    ? `${prompt}\n\nQuestions to answer:\n${content}`
    : [{ type: 'text', text: `${prompt}\n\nQuestions to answer:\n` }, ...content];

  let raw: Record<string, unknown>[] = [];
  try {
    // Low temperature: this is an attempt at the right answer, not an exploration.
    const response = await orCall(MODELS.ADVERSARIAL, '', userMessage, { maxTokens: 16000, temperature: 0.1 });
    raw = extractJsonArray(response.content, questions.length);
  } catch (e) {
    console.warn(`  [Blind] LLM call failed for batch of ${questions.length}: ${e instanceof Error ? e.message : e}`);
    return questions.map(() => null);
  }

  return questions.map((q, i) => {
    const r = raw.find((x) => (x.question_number as number) === i + 1) || raw[i];
    if (!r) return null;
    const clash = disagreementOf(q, r.answer);
    return {
      answer: String(r.answer ?? ''),
      confidence: String(r.confidence ?? ''),
      blockers: Array.isArray(r.blockers) ? (r.blockers as unknown[]).map(String) : [],
      working: String(r.working ?? ''),
      disagreesWithKey: clash.any,
      disagreementDetail: clash.detail,
    };
  });
}

// ── Run adversarial on a batch of questions ──

export async function runAdversarialBatch(
  questions: Record<string, unknown>[],
  contentType = 'qbank',
  domain = 'exam preparation',
  examFormat?: Record<string, unknown>,
  opts?: ReviewOptions
): Promise<Record<string, unknown>[]> {
  // Phase 1 — sit the questions before seeing any of the answers.
  const attempts = contentType === 'qbank'
    ? await runBlindSolveBatch(questions, domain)
    : questions.map(() => null);

  const attemptBlock = attempts.some(Boolean)
    ? `\nBLIND ATTEMPT (you answered these questions yourself, before seeing any key or explanation):\n${
        attempts.map((a, i) => {
          if (!a) return `  Q${i + 1}: (no attempt recorded)`;
          const flags = a.blockers.length ? `  blockers: ${a.blockers.join(', ')}` : '';
          const clash = a.disagreesWithKey ? `  ⚠ DISAGREES WITH THE STORED KEY — ${a.disagreementDetail}` : '';
          return `  Q${i + 1}: answered ${a.answer} (confidence ${a.confidence})${clash}\n      working: ${a.working}${flags ? `\n    ${flags}` : ''}`;
        }).join('\n')
      }
→ Where your blind answer differs from the key below, ONE of them is wrong. Decide which, and say so plainly: either the key is wrong (give the answer that is right and why) or your attempt was (say what in the stem you misread). Do not split the difference.
→ Where you flagged a blocker, check it against the key and explanation now. If the explanation supplies a fact the stem withheld, the STEM is at fault — a candidate never sees the explanation.
→ Where your blind answer matches the key, that agreement is evidence the item works; do not manufacture a problem with it.\n`
    : '';

  const prompt = getBatchAdversarialPrompt(contentType, domain, examFormat, opts);
  const content = await formatQuestionsForReviewWithImages(questions);

  let userMessage: string | ContentPart[];
  if (typeof content === 'string') {
    userMessage = `${prompt}\n${attemptBlock}\nContent to validate:\n${content}`;
  } else {
    userMessage = [
      { type: 'text', text: `${prompt}\n${attemptBlock}\nContent to validate:\n` },
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

  // HARD GATE (deterministic, regardless of the phase-2 score):
  //
  // An independent attempt that reached a different answer than the key is not an opinion about
  // quality — it is two answers to a question that has one. Either the key is wrong or the item
  // is ambiguous enough to lead a prepared candidate elsewhere, and both need a human-legible
  // change. Phase 2 has already been asked to say which; this makes sure the question is routed
  // to the fixer even when phase 2 talked itself back into agreeing with the key, which is the
  // failure this whole two-phase arrangement exists to prevent.
  //
  // Only letter-comparable answers reach here (see storedAnswerOf), so a free-entry or ordering
  // format never trips it on a formatting difference.
  for (let i = 0; i < questions.length; i++) {
    const attempt = attempts[i];
    if (!attempt) continue;
    const r = results.find((x) => (x.question_number as number) === i + 1) || results[i];
    if (!r) continue;

    r.blind_answer = attempt.answer;
    r.blind_confidence = attempt.confidence;
    r.blind_blockers = attempt.blockers;
    r.key_disagreement = attempt.disagreesWithKey;

    if (!attempt.disagreesWithKey && !attempt.blockers.length) continue;

    const notes: string[] = [];
    if (attempt.disagreesWithKey) {
      notes.push(
        `ANSWER KEY — ${attempt.disagreementDetail}. An independent attempt at this question, made ` +
        `without sight of the key or explanation, reached a different answer (${attempt.working.slice(0, 200)}). ` +
        `Determine which is right and correct whichever is wrong — the key, or the stem/options that ` +
        `led elsewhere. Change ONLY the parts named above; the rest of the item is not in dispute.`
      );
    }
    for (const b of attempt.blockers) {
      notes.push(`BLIND BLOCKER (${b}): ${attempt.working.slice(0, 200)}`);
    }

    // A low-confidence attempt that disagrees is reported but does not cap the score. It is the
    // reading a guess produces, and a hard question is not a broken one — the note still reaches
    // phase 2 and the fixer, which can act on it if the item really is ambiguous.
    const decisive = attempt.disagreesWithKey && attempt.confidence.toLowerCase() !== 'low';
    const prior = (r.adversarial_score as number) ?? 5;
    if (decisive) r.adversarial_score = Math.min(prior, 4);
    r.changes_required = [...((r.changes_required as string[]) || []), ...notes];
    if (decisive) {
      r.summary = `Blind attempt disagrees with the key (${attempt.disagreementDetail}) — ${String(r.summary ?? '')}`.slice(0, 400);
    }
  }

  return results;
}
