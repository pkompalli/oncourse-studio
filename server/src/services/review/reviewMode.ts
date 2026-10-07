/**
 * How a job's items may be changed in review.
 *
 *   generated   — the normal case: items this app wrote, not yet seen by any candidate.
 *   existingBank — imported from a live bank and already answered. Options are locked: each may be
 *                  reworded but stays the same choice, in the same place (changeRouting.ts).
 *   restructure — imported, but content quality outranks continuity with recorded answers. Items
 *                  are brought to the exam's standard — five homogeneous options, no cue to the key,
 *                  a full vignette — and any item whose options change is re-released as a new
 *                  version, traced to its source by id (exportReviewed.ts).
 *
 * Set from qb_jobs.config: source 'import' (or existing_bank) for an imported job, and
 * restructure: true on top of that.
 */
export interface ReviewMode { existingBank: boolean; restructure: boolean }

export function reviewModeOf(config: Record<string, unknown> | null | undefined): ReviewMode {
  const c = config || {};
  const existingBank = c.source === 'import' || c.existing_bank === true;
  return { existingBank, restructure: existingBank && c.restructure === true };
}

/**
 * What a reviewer should ask of an imported item when quality comes first. Shared by the validator
 * and adversarial prompts. The answer letter is deliberately left alone: options are shuffled across
 * the whole bank afterwards (keyBalance.ts), which a reviewer seeing ten items cannot do.
 */
export const RESTRUCTURE_RULES = `RULES FOR BRINGING THESE ITEMS TO EXAM STANDARD — content quality comes first; any item whose options change is re-released as a new version:
• Exactly FIVE options, one best answer. Where an item has fewer or more, ask for options to be added (plausible, same kind) or merged until there are five.
• Options are homogeneous: the same kind of thing (all diagnoses, all next steps, all mechanisms, all drugs), parallel grammar, similar length and specificity. Numeric options are listed in ascending order.
• Nothing may cue the key: a candidate looking only at the five options must not be able to tell which is correct. The keyed option is NEVER the longest (at least one distractor is as long or longer), and all five sit in a similar length range. Ask for a fix when the keyed option is the longest, the most qualified or precise, the only one with a second clause, a parenthesis or a justification ("because…", "given…"), repeats a distinctive stem word no distractor repeats, matches the lead-in grammatically where others do not, or when absolute terms (always, never, only, permanently) appear only in distractors, or an option is "all/none of the above". Shorten the key or lengthen distractors so the choices look alike.
• Every distractor is plausible: one a candidate holding a specific, nameable misconception would choose after reading the case. Replace any option a candidate could rule out without reading the case (an absurd, irrelevant or non-clinical action, or one of a different kind from the others). Keep every distractor that is already plausible: improve, do not churn.
• The vignette follows the exam's pattern (see the stem guidelines above): age and sex, setting, chief complaint with its duration, the relevant history, medications, examination, and the laboratory or imaging results the decision needs. A clinical vignette states vital signs (temperature, pulse, respirations, blood pressure, and oxygen saturation where relevant) even when they are normal — that is the exam's convention. Nothing in the stem may name the answer, and nothing the explanation relies on may be removed from it.
• The lead-in is ONE closed question in the exam's form, "Which of the following is the most likely …?" / "… most appropriate next step in management?", that fits every option and does not repeat the wording of the keyed option.
• Keep what the item tests and its question type: a diagnosis item stays a diagnosis item. Change the keyed answer only when it is wrong under current US practice, and give the evidence; where two answers are defensible, add the fact that makes one best.
• When the stem changes, the explanation must still match it: every finding the explanation cites is in the stem.
• An attached image may show what the stem also describes. Ask for a change only when the image contradicts the stem or options, cannot be read, or the stem names what the image tests — never ask for the item to be made to depend on its image. When it contradicts the stem, say exactly what the image shows ("IMAGE CONFLICT: the CT shows hyperdense blood in the basal cisterns; the stem says it is negative"). The image itself cannot be replaced: the editor will either align the stem with what the image shows or remove the image and make the item self-contained in text.
• Do not consider which letter is keyed: answer positions are balanced across the bank afterwards.`;

// ── Deterministic cue checks ──
//
// The things a model is unreliable at counting. Run on every restructure-mode item by the validator,
// which turns each finding into a change request for the fixer.

const words = (s: string) => (String(s || '').match(/[A-Za-z0-9]+/g) || []).length;
const NOTA = /\b(all|none) of the (above|following)\b/i;

export function optionTexts(q: Record<string, unknown>): { texts: string[]; key: number } {
  const o = q.options as Record<string, string> | undefined;
  if (o && typeof o === 'object' && !Array.isArray(o)) {
    const letters = Object.keys(o).sort();
    return { texts: letters.map((L) => String(o[L] ?? '')), key: letters.indexOf(String(q.correct_option ?? '')) };
  }
  return { texts: [], key: -1 };
}

export interface LengthCue { keyChars: number; maxChars: number; keyWords: number; maxWords: number }

/**
 * Whether the keyed option is the longest choice, in characters or in words: at least one distractor
 * must be as long or longer on both. No margin — a key that is longest by a few characters is still
 * the longest, and in the originals it was so in 25 of 60 items (chance is 12). The earlier rule
 * (uniquely longest by words AND 30% over the median) passed 16 of 60 round-2 items with the key
 * longest by characters.
 */
export function keyLengthCue(q: Record<string, unknown>): LengthCue | null {
  const { texts, key } = optionTexts(q);
  if (key < 0 || texts.length < 3) return null;
  const others = texts.filter((_, i) => i !== key);
  const c = { keyChars: texts[key].trim().length, maxChars: Math.max(...others.map((t) => t.trim().length)), keyWords: words(texts[key]), maxWords: Math.max(...others.map(words)) };
  return c.keyChars > c.maxChars || c.keyWords > c.maxWords ? c : null;
}

/** "the keyed option is 72 characters / 11 words; the longest distractor is 50 / 8" */
export function describeLengthCue(c: LengthCue): string {
  return `the keyed option is ${c.keyChars} characters / ${c.keyWords} words; the longest distractor is ${c.maxChars} characters / ${c.maxWords} words`;
}

// Surface features on which the key can be the odd one out. Measured on the 60 pilot originals and
// round 2, each catches real cues ("Obtain coagulation studies and type-and-crossmatch" against four
// single actions; "only"/"permanently" in every distractor but the key). A distinctive stem word
// echoed by the key alone is NOT checked here: as a regex it was half noise ("relatively",
// "current"); the options-only probe (cueProbe.ts) judges that.
const ABSOLUTE = /\b(always|never|only|all|none|must|permanently|completely|entirely)\b/i;
const ODD_FEATURES: Array<{ name: string; test: (t: string) => boolean }> = [
  { name: 'a parenthesis', test: (t) => t.includes('(') },
  { name: 'a semicolon or colon', test: (t) => /[;:]/.test(t) },
  { name: 'a second clause or a list ("and", "or", commas)', test: (t) => /\b(and|or)\b|,/.test(t) },
  { name: 'a justification ("because", "given", "due to", "resulting in")', test: (t) => /\b(because|given|due to|since|resulting in|leading to|thereby|so that)\b/i.test(t) },
  { name: 'a number', test: (t) => /\d/.test(t) },
];

/** Features only the key has, or only the key lacks. */
export function oddOneOut(q: Record<string, unknown>): string[] {
  const { texts, key } = optionTexts(q);
  if (key < 0 || texts.length < 4) return [];
  const others = texts.filter((_, i) => i !== key);
  const out: string[] = [];
  for (const f of ODD_FEATURES) {
    const k = f.test(texts[key]);
    const d = others.map(f.test);
    if (k && !d.some(Boolean)) out.push(`the keyed option is the only one with ${f.name}`);
    else if (!k && d.every(Boolean)) out.push(`every option except the keyed one has ${f.name}`);
  }
  if (!ABSOLUTE.test(texts[key]) && others.some((t) => ABSOLUTE.test(t))) {
    out.push('absolute terms (only, never, always, permanently…) appear in distractors but not in the keyed option');
  }
  return out;
}

/** Shortest option under 60% of the longest: the set does not look alike. 11 of 60 in round 2. */
function lengthSpread(texts: string[]): { min: number; max: number } | null {
  if (texts.length < 4) return null;
  const L = texts.map((t) => t.trim().length);
  const min = Math.min(...L), max = Math.max(...L);
  return min < 0.6 * max ? { min, max } : null;
}

export function cueIssues(q: Record<string, unknown>): string[] {
  const { texts } = optionTexts(q);
  const out: string[] = [];
  if (texts.length && texts.length !== 5) {
    out.push(`FORMAT: The item has ${texts.length} options; exam items have exactly five. ${texts.length < 5 ? 'Add' : 'Merge or remove'} options so there are five homogeneous, plausible choices.`);
  }
  const len = keyLengthCue(q);
  if (len) {
    out.push(`FORMAT: The keyed option is the longest choice (${describeLengthCue(len)}), which cues the answer. The keyed option must not be the longest: shorten it without changing its meaning, or lengthen distractors with plausible, specific detail, so at least one distractor is as long or longer in both characters and words.`);
  }
  const odd = oddOneOut(q);
  if (odd.length) {
    out.push(`FORMAT: The keyed option stands out from the distractors: ${odd.join('; ')}. Make the five options alike in form so the key cannot be picked out by its shape.`);
  }
  const spread = lengthSpread(texts);
  if (spread && !len) {
    out.push(`FORMAT: The options differ widely in length (${spread.min} to ${spread.max} characters). Bring them into a similar range so no option stands out by length.`);
  }
  const nota = texts.filter((t) => NOTA.test(t));
  if (nota.length) out.push(`FORMAT: "${nota[0].slice(0, 60)}" is an all/none-of-the-above option, which exam items do not use. Replace it with a specific, plausible choice.`);
  return out;
}

// ── Images ──

/** Stem wording that points at a picture. */
export const STEM_REFS_IMAGE = /shown\s+(below|above|here)|in\s+the\s+(image|figure|scan|x-?ray|ct|mri|photograph|tracing)|based\s+on\s+the\s+(image|figure)|\bthe\s+(image|figure|photograph)\b/i;

/**
 * Deterministic image findings for a restructure-mode item. The image cannot be replaced (it is a
 * real asset in the live bank), so each is a request to the fixer to reconcile the text with it, or
 * to remove it and make the item self-contained (fixer.ts). `loads` is whether the image downloaded.
 */
export function imageIssues(q: Record<string, unknown>, loads: boolean | null): string[] {
  const stem = String(q.question ?? '');
  const url = q.image_url as string | null | undefined;
  if (url && loads === false) {
    return ['IMAGE NOT LOADING: The attached image could not be downloaded, so candidates would see a broken picture. Remove the image and make the item self-contained: state in words the findings the decision needs, without naming the answer, and remove every reference to an image.'];
  }
  if (!url && (q.is_image_question || STEM_REFS_IMAGE.test(stem))) {
    return ['IMAGE MISSING: The stem refers to an image but none is attached. Make the item self-contained: state in words the findings the decision needs, without naming the answer, and remove every reference to an image.'];
  }
  return [];
}
