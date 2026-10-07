/**
 * The options-only test: can the key be picked without the case?
 *
 * A test-wise candidate who skips the vignette and reads only the lead-in and the five options
 * should do no better than chance. This probe plays that candidate. It sees no stem, no
 * explanation and no key, and reports which option it would guess and the surface features that
 * drew it there (length, precision, a second clause, a word echoed from the lead-in, the only one of
 * its kind), plus any option it could rule out on sight, which is the measure of an implausible
 * distractor.
 *
 * The deterministic checks in reviewMode.ts catch what can be counted. This catches what cannot:
 * a key that is more qualified or more precise than the rest, a distractor of a different kind, an
 * option no clinician would consider. Restructure mode only.
 */
import { orCall, MODELS } from '../llm/openrouter.js';
import { extractJsonArray } from './shared.js';
import { optionTexts } from './reviewMode.js';

export interface ProbeResult {
  guess: string;
  confidence: 'low' | 'medium' | 'high';
  cues: string[];
  eliminable: Array<{ letter: string; reason: string }>;
}

const LETTERS = 'ABCDEFGHIJ';

/** The closing question of the stem, without the vignette: the last sentence ending in "?". */
export function leadIn(stem: string): string {
  const s = String(stem || '').trim();
  const qs = s.match(/[^.?!]*\?\s*$/);
  return (qs ? qs[0] : s.slice(-200)).trim();
}

// The first version asked for "surface features" in free text. Sol picked the key in 44 of 60
// round-2 items, but mostly from medical knowledge ("the only option linking prevalence to PPV"),
// and listed distractors as eliminable for being factually wrong — which every distractor is. Both
// judgements are now confined to named FORM features, and knowledge is explicitly excluded.
export const FORM_CUES = ['longest', 'most_detailed', 'only_multi_part', 'echoes_question', 'grammar_fit', 'only_of_its_kind', 'others_absolute', 'only_with_numbers'] as const;
const ELIM_REASONS = ['different_kind', 'not_an_answer_to_question', 'absurd', 'non_clinical'] as const;

const PROMPT = `You are auditing USMLE-style items for TEST-WISENESS cues. For each item you see ONLY the closing question and the options — not the clinical case. The question is whether the FORM of the options gives the answer away. Content knowledge is irrelevant here: every distractor is meant to be wrong, and knowing which option is medically correct is NOT a cue.

For each item:
1. "guess": the option a test-wise candidate who knows no medicine would choose, using form alone.
2. "confidence": "high" only if one option clearly stands out by FORM; "medium" if it somewhat stands out; otherwise "low".
3. "cues": the FORM features that make your guess stand out, chosen ONLY from this list (empty when nothing stands out):
   - "longest": visibly longer than every other option
   - "most_detailed": noticeably more precise, qualified or specific than the others (thresholds, timings, doses, named mechanisms where others are generic)
   - "only_multi_part": the only option combining two or more actions/findings/clauses
   - "echoes_question": repeats a distinctive word or phrase from the question that the others do not
   - "grammar_fit": the only one that fits the question's grammar
   - "only_of_its_kind": the others share a category or pattern and it does not (or vice versa)
   - "others_absolute": the others contain absolute words (only, never, always, permanently) and it does not
   - "only_with_numbers": the only option with numbers
4. "eliminable": options a test-wise candidate could rule out by FORM, without any medical knowledge, with a reason from ONLY this list:
   - "different_kind": not the same kind of thing as the other options (e.g. a diagnosis among management steps)
   - "not_an_answer_to_question": does not answer the question asked (e.g. a treatment when the question asks for a test)
   - "absurd": no clinician would ever consider it
   - "non_clinical": an administrative or legal action where a clinical decision is asked for (e.g. reporting to a licensing board)
   NEVER list an option because it is medically incorrect, outdated or less appropriate — that is what a distractor is.
   In ethics, law and communication items (consent, capacity, surrogates, advance directives, confidentiality, disclosure), ethics consultation, court orders and legal or administrative steps ARE the same kind as the other options: never list them as "non_clinical" or "different_kind" there.
   Likewise, when the options are alternative courses of action (give now / delay / withhold / refer), the one that differs in direction is not "only_of_its_kind": that difference is the content being tested.

Return a JSON array, one object per item in order:
[{"item": 1, "guess": "C", "confidence": "low", "cues": [], "eliminable": [{"letter": "E", "reason": "non_clinical"}]}]
Return ONLY the JSON array.`;

function formatItem(q: Record<string, unknown>, i: number): string {
  const { texts } = optionTexts(q);
  return `ITEM ${i + 1}\nQuestion: ${leadIn(String(q.question ?? ''))}\n${texts.map((t, j) => `${LETTERS[j]}. ${t}`).join('\n')}`;
}

/** One call per batch; a failed call returns nulls, never throws. */
export async function probeCues(questions: Record<string, unknown>[]): Promise<Array<ProbeResult | null>> {
  const items = questions.filter((q) => optionTexts(q).texts.length >= 3);
  if (!items.length) return questions.map(() => null);
  const body = items.map(formatItem).join('\n\n');
  let parsed: Record<string, unknown>[] = [];
  for (let attempt = 1; attempt <= 2 && parsed.length < items.length; attempt++) {
    try {
      const r = await orCall(MODELS.ADVERSARIAL, '', `${PROMPT}\n\n${body}`, { maxTokens: 6000, temperature: attempt === 1 ? 0.2 : 0 });
      const got = extractJsonArray(r.content, items.length);
      if (got.length > parsed.length) parsed = got;
    } catch (e) {
      console.warn(`  [CueProbe] call failed: ${e instanceof Error ? e.message : e}`);
    }
  }
  const byItem = new Map<Record<string, unknown>, ProbeResult>();
  items.forEach((q, i) => {
    const p = parsed.find((x) => Number(x.item) === i + 1) ?? parsed[i];
    if (!p) return;
    const conf = String(p.confidence ?? 'low').toLowerCase();
    byItem.set(q, {
      guess: String(p.guess ?? '').trim().toUpperCase().slice(0, 1),
      confidence: conf === 'high' || conf === 'medium' ? conf : 'low',
      // Anything outside the named lists is the model reasoning from knowledge again: dropped.
      cues: Array.isArray(p.cues) ? (p.cues as unknown[]).map(String).filter((c) => (FORM_CUES as readonly string[]).includes(c)) : [],
      eliminable: Array.isArray(p.eliminable)
        ? (p.eliminable as Array<Record<string, unknown>>)
          .map((e) => ({ letter: String(e?.letter ?? '').trim().toUpperCase().slice(0, 1), reason: String(e?.reason ?? '') }))
          .filter((e) => e.letter && (ELIM_REASONS as readonly string[]).includes(e.reason))
        : [],
    });
  });
  return questions.map((q) => byItem.get(q) ?? null);
}

/** Whether the probe picked the key with confidence, for a reason it could point to. */
export function keySpotted(q: Record<string, unknown>, r: ProbeResult | null): boolean {
  if (!r) return false;
  const { key } = optionTexts(q);
  return key >= 0 && r.guess === LETTERS[key] && r.confidence === 'high' && r.cues.length > 0;
}

/** Distractors the probe could rule out on sight (the key is never reported as one). */
export function implausibleDistractors(q: Record<string, unknown>, r: ProbeResult | null): Array<{ text: string; reason: string }> {
  if (!r) return [];
  const { texts, key } = optionTexts(q);
  return r.eliminable
    .map((e) => ({ i: LETTERS.indexOf(e.letter), reason: e.reason }))
    .filter((e) => e.i >= 0 && e.i < texts.length && e.i !== key)
    .map((e) => ({ text: texts[e.i], reason: e.reason }));
}

const CUE_WORDS: Record<string, string> = {
  longest: 'it is the longest',
  most_detailed: 'it is more precise or qualified than the others',
  only_multi_part: 'it is the only option combining two or more parts',
  echoes_question: 'it repeats a word from the question the others do not',
  grammar_fit: 'it is the only one that fits the question\'s grammar',
  only_of_its_kind: 'it is the only one of its kind',
  others_absolute: 'the others use absolute words and it does not',
  only_with_numbers: 'it is the only one with numbers',
};
const ELIM_WORDS: Record<string, string> = {
  different_kind: 'it is a different kind of answer from the others',
  not_an_answer_to_question: 'it does not answer the question asked',
  absurd: 'no clinician would consider it',
  non_clinical: 'it is an administrative or legal action, not a clinical decision',
};

/** The probe's findings as change requests for the fixer. */
export function probeIssues(q: Record<string, unknown>, r: ProbeResult | null): string[] {
  const out: string[] = [];
  if (keySpotted(q, r)) {
    out.push(`CUE: A test-wise reader shown only the question and the options picked the keyed option by its form (${r!.cues.map((c) => CUE_WORDS[c] ?? c).join('; ')}). Rework the options so the key cannot be picked out without the case: give the distractors the same precision, structure and length as the key, and remove what makes the key stand out.`);
  }
  for (const d of implausibleDistractors(q, r)) {
    out.push(`DISTRACTOR: "${d.text.slice(0, 120)}" can be ruled out without reading the case (${ELIM_WORDS[d.reason] ?? d.reason}). Replace it with a plausible option of the same kind as the others that a candidate with a specific misconception would choose.`);
  }
  return out;
}
