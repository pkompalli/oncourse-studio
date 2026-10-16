/**
 * The review checklist: one fixed set of named checks that every stage of a restructure-mode review
 * reports against — validator, adversarial, fixer and audit.
 *
 * Before this, each reviewer returned free-form findings in its own words. The fifth pilot showed
 * what that costs: about one item in eight was flagged, and a different eight each run, because each
 * run's reviewers asked for different improvements ("cover all four capacity abilities", "classify
 * the DKA as moderate") and audit then verified each open-ended request literally. With a fixed
 * checklist, every run asks the same questions of every item, a fix is aimed at a named check, and
 * audit re-judges the same checks on the item as it now stands.
 *
 * MUST checks decide approval. STANDARD checks are the exam's style; a STANDARD check still failing
 * after the post-audit fix pass is listed in the export but does not hold the item back.
 *
 * There is no human review step after this pipeline: no check may be deferred to a clinician or
 * expert. Doubt about the keyed answer is settled by answer adjudication (keyAdjudication.ts).
 */

export interface CheckDef { id: string; must: boolean; what: string }

export const CHECKS: CheckDef[] = [
  { id: 'KEY_CORRECT', must: true, what: 'The keyed option is the correct answer for the stem as written, under the authority the exam profile names for deciding answers ("Correct answers are decided by"), as it stands today.' },
  { id: 'ONE_BEST_ANSWER', must: true, what: 'Exactly one option is defensible: the stem states every fact needed to exclude each of the others, and no option is a second correct answer.' },
  { id: 'FACTS_ACCURATE', must: true, what: 'Nothing in the stem, options or explanation is factually wrong or outdated.' },
  { id: 'IMAGE_CONSISTENT', must: true, what: 'An attached image agrees with every statement in the text, and the stem does not name what the image is there to test. With no image, the stem does not refer to one.' },
  { id: 'DISTRACTORS_PLAUSIBLE', must: true, what: 'Every distractor is the same kind of thing as the key and would be chosen by a candidate with a specific misconception; none can be ruled out without reading the stem.' },
  { id: 'NO_ANSWER_CUE', must: true, what: 'The key cannot be picked from the options or the stem alone: it is not the longest, most detailed or most qualified, not the only multi-part option, does not differ from the others in wording style, verb, abbreviation, qualifier or punctuation, does not alone echo a stem word or fit the lead-in grammar, absolute words do not appear only in distractors, the lead-in does not paraphrase or narrow toward it, and the stem does not list orders or prescriptions that name it.' },
  { id: 'VIGNETTE_PATTERN', must: false, what: 'The stem follows this exam\'s stem pattern as the exam profile describes it (for a clinical vignette: age and sex, setting, chief complaint with duration, relevant history and medications, vital signs where the decision depends on clinical state, examination, and the results the decision needs). It carries everything the decision needs and nothing that plays no part in it — no padding. Every finding is internally consistent and sits where it belongs; nothing reads as a sentence added to patch the item.' },
  { id: 'OPTIONS_PARALLEL', must: false, what: 'All options share one grammatical form, similar length and specificity, the same style of abbreviation and no trailing punctuation; each distractor is as specific as the key; each option uses the standard, recognised term for what it names.' },
  { id: 'LEAD_IN', must: false, what: 'One closed lead-in in this exam\'s form, as its example stems ask it (for USMLE: "Which of the following is the most likely …?" / "most appropriate next step …?"), that fits every option.' },
  { id: 'EXAM_FIDELITY', must: false, what: 'The item reads like a real item from this exam as the exam profile describes it: it tests the way the exam tests (its testing philosophy, its balance of recall and reasoning, its distinctive patterns), takes the shape and register of the exam\'s example stems, builds its distractors on the errors the profile names, and does nothing the profile says the exam does not do. The evidence names the specific way it falls short of a real item; the fix brings it there without changing what it tests.' },
  { id: 'EXPLANATION_COMPLETE', must: false, what: 'The explanation opens with the keyed answer, gives the reasoning from the information in the stem, then addresses each distractor, named by its exact current text, saying why it is wrong here. It matches the current stem and options exactly, cites only what is in the stem, names options by text not letter, and has no repeated, truncated or run-on sentences.' },
];

const BY_ID = new Map(CHECKS.map((c) => [c.id, c]));
export const isMust = (id: string) => Boolean(BY_ID.get(id)?.must);

/** The checklist as reviewers see it, with the reply format. */
export const CHECKLIST_PROMPT = `REVIEW CHECKLIST — report on EVERY check below for every item, and on nothing else:
${CHECKS.map((c) => `• ${c.id} (${c.must ? 'MUST' : 'STANDARD'}): ${c.what}`).join('\n')}

For each item, add a "checks" array with one entry per check, in this order:
  {"id": "<check id>", "result": "pass" | "fail" | "n/a", "evidence": "<one sentence: what in the item shows this>", "fix": "<when it fails: ONE specific edit that makes it pass without breaking another check; empty when it passes>"}
Use "n/a" only where a check cannot apply to the item's format (e.g. option checks on a fill-in-the-blank). MUST checks: mark "fail" only for a real defect a candidate would meet. STANDARD checks: mark "fail" whenever the item falls short of the exam's standard described above; the fix brings it to that standard. A fix states exactly what to change and to what. It may rewrite a whole option set, a section of the stem or the whole explanation when that is what reaches the standard; additions are placed where they belong in the case presentation, never appended as a patch. A fix never asks for a different image, for anything outside the item, or for any kind of human, clinician or expert review — there is no review step after this one. If the keyed answer is wrong, say which option is right and the guideline basis in the fix.
"changes_required" must then hold exactly one entry per failed check, written "[CHECK_ID] <fix>", and nothing else.`;

/** The checklist as the fixer sees it: the standard each change must meet. */
export const CHECKLIST_FOR_FIXER = `Each required change names the checklist item it repairs ("[CHECK_ID] …"). Make the edit so that check passes, and leave every other check passing:
${CHECKS.map((c) => `• ${c.id}: ${c.what}`).join('\n')}`;

export interface CheckResult { id: string; result: 'pass' | 'fail'; evidence: string; fix: string }

/** The model's checks, normalised: known ids only, one each. Null when it gave none. */
export function parseChecks(r: Record<string, unknown> | null | undefined): CheckResult[] | null {
  const raw = r?.checks;
  if (!Array.isArray(raw) || !raw.length) return null;
  const seen = new Map<string, CheckResult>();
  for (const x of raw as Array<Record<string, unknown>>) {
    const id = String(x?.id ?? '').trim().toUpperCase();
    if (!BY_ID.has(id) || seen.has(id)) continue;
    seen.set(id, {
      id,
      result: String(x?.result ?? '').toLowerCase() === 'fail' ? 'fail' : 'pass',
      evidence: String(x?.evidence ?? '').trim(),
      fix: String(x?.fix ?? '').trim(),
    });
  }
  return seen.size ? [...seen.values()] : null;
}

/**
 * The change requests for an item's failed checks, "[CHECK_ID] fix". An image check that fails on an
 * item with an image is labelled an IMAGE CONFLICT, so the fixer is shown the image and may align
 * the text with it or remove it (fixer.ts).
 */
export function checkChanges(checks: CheckResult[], hasImage: boolean): string[] {
  return checks.filter((c) => c.result === 'fail').map((c) => {
    const text = `[${c.id}] ${c.fix || c.evidence}`;
    return c.id === 'IMAGE_CONSISTENT' && hasImage ? `IMAGE CONFLICT: ${text}` : text;
  });
}

export const failedMust = (checks: CheckResult[]) => checks.filter((c) => c.result === 'fail' && isMust(c.id));
export const failedStandard = (checks: CheckResult[]) => checks.filter((c) => c.result === 'fail' && !isMust(c.id));
