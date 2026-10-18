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
/**
 * checklist: review against the fixed checklist (reviewChecklist.ts) — every job except an imported
 * bank in locked mode, whose options may not change and which keeps its legacy rules.
 */
export interface ReviewMode { existingBank: boolean; restructure: boolean; checklist: boolean }

export function reviewModeOf(config: Record<string, unknown> | null | undefined): ReviewMode {
  const c = config || {};
  const existingBank = c.source === 'import' || c.existing_bank === true;
  const restructure = existingBank && c.restructure === true;
  return { existingBank, restructure, checklist: restructure || !existingBank };
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
• The vignette follows the exam's pattern (see the stem guidelines above): age and sex, setting, chief complaint with its duration, the relevant history, medications, examination, and the laboratory or imaging results the decision needs. State vital signs when the decision depends on the patient's clinical state (diagnosis, severity, management, a drug choice that turns on it), including normal ones that rule something out. Do NOT add vital signs, examination or history that play no part in the decision — calculation, biostatistics, epidemiology, ethics and communication items, and pure mechanism recall carry only what the question needs; padding them is a defect, not the exam's style. Nothing in the stem may name the answer, and nothing the explanation relies on may be removed from it.
• The lead-in is ONE closed question in the exam's form, "Which of the following is the most likely …?" / "… most appropriate next step in management?", that fits every option. It never repeats, paraphrases, defines or narrows toward the keyed option.
• Options use the standard, recognised term for what they name (a defense mechanism is "Displacement", not "Affect displacement"); never invent or alter a label to make options parallel.
• Keep what the item tests and its question type: a diagnosis item stays a diagnosis item, a management decision stays that decision, a localisation stays a localisation. Never turn the item into a question about a different fact — for example a drug-choice item into a mechanism item, or "where is the narrowing" into "what is the diagnosis". Improve how the item asks; never change what it asks.
• An item that belongs to a different USMLE Step is retagged, not rewritten: if a Step 1 item's task is clinical management (next step, workup sequence, disposition, acute treatment with no mechanism asked), or a Step 2 CK / Step 3 item is pure basic-science mechanism recall, set belongs_to_other_exam to the Step it belongs to ("USMLE Step 2 CK", "USMLE Step 1", "USMLE Step 3") and request no changes. A Step 1 item may ask for the appropriate drug when the reasoning is its mechanism or pharmacology; that stays in Step 1. Change the keyed answer only when it is wrong under current US practice, and give the evidence; where two answers are defensible, add the fact that makes one best.
• When the stem changes, the explanation must still match it: every finding the explanation cites is in the stem.
• An attached image may show what the stem also describes. Ask for a change only when the image contradicts the stem or options, cannot be read, or the stem names what the image tests — never ask for the item to be made to depend on its image. When it contradicts the stem, say exactly what the image shows ("IMAGE CONFLICT: the CT shows hyperdense blood in the basal cisterns; the stem says it is negative"). The image itself cannot be replaced: the editor will either align the stem with what the image shows or remove the image and make the item self-contained in text.
• Do not consider which letter is keyed: answer positions are balanced across the bank afterwards.`;

// ── Deterministic cue checks ──
//
// The things a model is unreliable at counting. Run by the validator on every restructure-mode item and
// every generated single-best-answer item, turning each finding into a change request for the fixer.
// Only restructure mode blocks on them at audit; for generated items they are repaired, not gated,
// until a benchmark shows the gate holds back only real cues.

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

/** A single-best-answer item with a letter map of options: the form the cue checks apply to. */
export function isSingleBest(q: Record<string, unknown>): boolean {
  const fmt = String(q.format_type ?? (q.tags as Record<string, unknown> | null)?.format_type ?? 'mcq_single');
  const { texts, key } = optionTexts(q);
  return (fmt === 'mcq_single' || fmt === 'single_best_answer') && texts.length >= 3 && key >= 0;
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

/**
 * `expected`: the exam's option count (five for USMLE; examProfile.optionCount elsewhere), or null to
 * leave the count alone.
 */
export function cueIssues(q: Record<string, unknown>, expected: number | null = 5): string[] {
  const { texts } = optionTexts(q);
  const out: string[] = [];
  if (expected && texts.length && texts.length !== expected) {
    out.push(`FORMAT: The item has ${texts.length} options; exam items have exactly ${expected}. ${texts.length < expected ? 'Add' : 'Merge or remove'} options so there are ${expected} homogeneous, plausible choices.`);
  }
  const len = keyLengthCue(q);
  if (len) {
    out.push(`FORMAT: The keyed option is the longest choice (${describeLengthCue(len)}), which cues the answer. The keyed option must not be the longest: first shorten it without changing its meaning; lengthen a distractor only where the key cannot be shortened, and then only with neutral detail of the same kind as the key's — never a delay, condition, restriction or qualifier that makes the distractor wrong on its face. At least one distractor must end as long or longer in both characters and words.`);
  }
  const odd = oddOneOut(q);
  if (odd.length) {
    out.push(`FORMAT: The keyed option stands out from the distractors: ${odd.join('; ')}. Make the options alike in form so the key cannot be picked out by its shape.`);
  }
  const spread = lengthSpread(texts);
  if (spread && !len) {
    out.push(`FORMAT: The options differ widely in length (${spread.min} to ${spread.max} characters). Bring them into a similar range so no option stands out by length.`);
  }
  const nota = texts.filter((t) => NOTA.test(t));
  if (nota.length) out.push(`FORMAT: "${nota[0].slice(0, 60)}" is an all/none-of-the-above option, which exam items do not use. Replace it with a specific, plausible choice.`);
  return out;
}

// ── Sub-questions of grouped items ──
//
// CFA item sets, LSAT and MCAT passage sets, Bar shared-fact sets and NCLEX case studies are mostly
// single-best-answer questions inside one row (content.sub_questions, options as "A. text" strings and
// a letter in correct_answer). The cue checks above only looked at standalone items, so the key-longest
// and odd-one-out checks never reached them.

/** Each single-best-answer sub-question as a standalone item ({ question, options map, correct_option }). */
export function subItems(q: Record<string, unknown>): Array<{ n: number; item: Record<string, unknown> }> {
  const c = (q.content && typeof q.content === 'object' ? q.content : q) as Record<string, any>;
  const subs = Array.isArray(c.sub_questions) ? (c.sub_questions as Array<Record<string, any>>) : [];
  const out: Array<{ n: number; item: Record<string, unknown> }> = [];
  subs.forEach((s, i) => {
    const fmt = String(s?.format_type ?? 'mcq_single');
    const key = String(s?.correct_answer ?? '').trim().toUpperCase();
    if (!/^(mcq_single|single_best_answer)$/.test(fmt) || !/^[A-J]$/.test(key) || !Array.isArray(s?.options)) return;
    const options: Record<string, string> = {};
    (s.options as unknown[]).forEach((o, j) => {
      const t = typeof o === 'string' ? o : String((o as Record<string, unknown>)?.text ?? '');
      const m = t.match(/^\s*([A-J])[.)]\s+([\s\S]*)$/);
      options[m ? m[1] : 'ABCDEFGHIJ'[j]] = (m ? m[2] : t).trim();
    });
    if (Object.keys(options).length >= 3 && options[key] != null) out.push({ n: i + 1, item: { question: String(s.question ?? s.stem ?? ''), options, correct_option: key } });
  });
  return out;
}

/** cueIssues for every single-best-answer sub-question, each labelled with its number. */
export function subQuestionCueIssues(q: Record<string, unknown>, expected: number | null): string[] {
  return subItems(q).flatMap(({ n, item }) => cueIssues(item, expected).map((x) => x.replace(/^FORMAT: /, `FORMAT: Sub-question ${n}: `)));
}

/** Sub-questions whose keyed option is the longest. */
export function subLengthCues(q: Record<string, unknown>): Array<{ n: number; cue: LengthCue }> {
  return subItems(q).map(({ n, item }) => ({ n, cue: keyLengthCue(item) })).filter((x): x is { n: number; cue: LengthCue } => x.cue !== null);
}

// ── Bow-tie stem ──

const BT_STOP = new Set('administer prescribed promptly intravenous client nurse obtain assess monitor initiate provide place perform notify prepare apply begin continue maintain under according standing protocol infusion bolus urgently'.split(' '));
const btWords = (t: string) => new Set((String(t).toLowerCase().match(/[a-z]{5,}/g) || []).filter((w) => !BT_STOP.has(w)));

/**
 * A bow-tie stem that lists prescriptions, orders or protocols naming the keyed actions hands the
 * candidate the left side of the diagram (22 of 59 in the first NCLEX bow-tie run). Returns the issue,
 * or null. Works on stored content or a fixer's output (content fields at the top level).
 */
export function bowTieStemCue(q: Record<string, unknown>): string | null {
  const c = (q.content && typeof q.content === 'object' ? q.content : q) as Record<string, any>;
  const acts = c.action_options as Array<{ key: string; text: string }> | undefined;
  const keys = (c.answer?.actions as string[]) || [];
  if (!Array.isArray(acts) || keys.length === 0) return null;
  const stem = String(c.stem ?? q.question ?? '');
  const sents = stem.split(/(?<=[.])\s+/).filter((s) => /prescri|ordered|orders|plan includes|protocol/i.test(s) && !/^Complete the diagram/.test(s));
  if (!sents.length) return null;
  const sw = new Set(sents.flatMap((s) => [...btWords(s)]));
  const named = keys.map((k) => acts.find((o) => o.key === k)?.text ?? '').filter((t) => [...btWords(t)].some((w) => sw.has(w)));
  if (!named.length) return null;
  return `FORMAT: The stem lists prescriptions, orders or protocols that name the keyed action${named.length > 1 ? 's' : ''} (${named.map((t) => `"${t.slice(0, 60)}"`).join(', ')}), which hands the candidate the answer. Remove those sentences so the actions are inferred from the condition; keep the cues.`;
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
