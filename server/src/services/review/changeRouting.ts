/**
 * Where a reviewer's change request goes: to the text fixer, to image regeneration, or onto the
 * record only.
 *
 * Every request used to go to the fixer unless one regex called it an image change, and that regex
 * missed "Replace the ECG image…" and "Replace the chest image…". The fixer cannot change a
 * picture, so it met those requests by writing the finding into the stem — "ECG shows an
 * irregularly irregular rhythm with absent P waves" — and handed the candidate the answer.
 *
 * Measured on 150 reviews of exported USMLE bank items (backups/usmle_export/review_sample*):
 * every request routed below matched a hand reading of it.
 *
 *   image — a request that names the picture and says it is wrong or must be replaced
 *   label — a difficulty or Bloom's relabel, or a request to fill in a stored metadata field. The fixer's output for those fields is never
 *           persisted, so audit then reports a repair that was "never applied" on a question
 *           whose content is fine.
 *   batch — a request about how the item sits among the others reviewed with it (concept overlap,
 *           letter balance). Meaningful for a freshly generated batch; for items from an existing
 *           bank, reviewed ten at a time in arbitrary order, it is noise — and acting on it had
 *           the fixer replace a whole HIPAA question with a different one and reorder answered
 *           options. Only `existingBank` jobs keep these off the fixer.
 *   fix   — everything else.
 */

const IMAGE_WORD_RE = /\b(image|images|picture|photo|photograph|figure|tracing|micrograph)\b/i;
// Test names ("HIDA scan", "CT", "MRI") appear in options and explanations; they count as the
// picture only with an explicit request to replace it.
const IMAGE_NOUN_RE = /\b(image|images|ecg|ekg|x-?ray|radiograph|ct\b|mri|scan|photo|photograph|figure|picture|illustration|tracing|micrograph|smear|histolog)/i;
const IMAGE_WRONG_RE = /\b(replace|regenerate|swap|redo|provide|correct the|does not|doesn't|do not|fails? to|inconsistent|contradict|mismatch|inconsistent_data|not (clearly )?(show|depict|demonstrat|match))\b/i;
const IMAGE_REPLACE_RE = /\b(replace|regenerate|swap|redo)\b/i;

// A request about the item's own stem or wording — converting a recall stem to a vignette is how
// a question comes to read like the real exam — goes to the fixer even when the reviewer
// justifies it by the rest of the batch or by a Bloom's level.
const OWN_TEXT_RE = /\b(vignette|lead-in|stem)\b/i;
const OWN_FORMAT_RE = /^(FORMAT|EXPLANATION):/i;

// Sonnet writes "Bloom's level"; GPT 6.1 Sol writes the field name, "Change bloom_level to 3_apply".
const LABEL_RE = /^DIFFICULTY:|\b(difficulty|bloom'?s?)\s+(label|level|rating)\b|\bblooms?_level\b|\breconsider difficulty\b|\bdifficulty\b.*\b(easy|medium|hard)\b|\bbloom'?s?\b.*\b\d_[a-z]+/i;
// Requests to fill in stored fields the platform maintains, not the text a candidate reads. Sol asks
// for these ("Supply format_type as mcq_single and is_image_question as false"); no text repair can
// make them, so sent to the fixer they came back "not applied" and audit flagged 43 of 60 sound items.
const RELABEL_ACTION_RE = /\b(change|set|relabel|re-label|reclassify|lower|raise|label it|label the item)\b[^.;]{0,30}\b(bloom'?s?|blooms?_level|difficulty)\b|\b(bloom'?s?|blooms?_level|difficulty)\b[^.;]{0,25}\b(from\s+\S+\s+)?to\s+['"]?(\d_[a-z]+|easy|medium|hard)\b/i;
const METADATA_RE = /\b(format_type|is_image_question|image_type|image_search_terms|question_type|correct_answer field|course[- ]hierarchy)\b|\b(supply|add|set|include|provide)\b[^.]{0,40}\bmetadata\b|\bsubject, topic(,| and) chapter\b/i;

// Every reviewer sees only its batch, so a request that refers to the batch at all is about the
// batch, not the item.
const BATCH_RE = /^CONCEPT OVERLAP:|\bbatch\b|\boverrepresent|\bover-represent|\bduplicat|\bnear-identical\b|\bconcept diversity\b|\b(answer|key)s?\b.*\b(distribution|balance|diversify|varying|vary)\b|\bone of (two|three|four|\d+) '?[A-E]'? answers\b|\bQ\d+\b.*\b(same|overlap)|\bskew|\blettering\b/i;

export type ChangeRoute = 'fix' | 'image' | 'label' | 'batch';

/**
 * What a reviewer may ask of an item candidates have already answered — shared by the validator
 * and the adversarial prompts so the two cannot drift. Each rule is a pilot finding with GPT 6.1
 * Sol as reviewer, where Sonnet 5.5 had already behaved this way unprompted:
 *   - Sol asked for weak distractors to be swapped for "a plausible competing" choice; the fixer
 *     guard refused every one (7 of 60 items), since a recorded answer would name a choice its
 *     candidate never saw.
 *   - Where two answers were defensible Sol re-keyed (study design, placenta previa) and audit
 *     rejected both; Sonnet added the deciding fact to the stem and kept the key.
 *   - Sol asked for findings the image also shows to be cut from the stem, a rewrite that left the
 *     item resting on image fidelity and failed audit.
 */
export const EXISTING_ITEM_RULES = `RULES FOR ITEMS ALREADY IN USE — candidates have answered these, and every recorded answer must keep meaning what it meant:
• Options: correct an option's wording only if it is wrong, and keep it the SAME choice. Never ask for a distractor to be replaced by a different one, however weak it is; report a weak distractor in your findings without a change request.
• Two defensible answers: make the keyed answer uniquely correct by adding the one fact the vignette is missing (hemodynamic status, timing, a decisive lab value, a stated preference). Ask for the key to change only when it is wrong under current US practice whatever reasonable detail is added, and give the evidence.
• Images: a stem that also describes what the image shows is acceptable. Ask for a stem change only when its wording names the answer itself (the diagnosis, rhythm, organism or structure being tested) or contradicts the image.
• Ask for the smallest change that removes the defect. Do not rewrite a sound vignette for style or length.`;

export function isImageChange(c: string): boolean {
  return (IMAGE_WORD_RE.test(c) && IMAGE_WRONG_RE.test(c)) || (IMAGE_NOUN_RE.test(c) && IMAGE_REPLACE_RE.test(c));
}

/** Route one request. `existingBank` keeps batch-relative requests off the fixer. */
export function routeChange(c: string, existingBank: boolean): ChangeRoute {
  if (/^CONCEPT OVERLAP:/i.test(c)) return existingBank ? 'batch' : 'fix';
  // Restructure-mode image repairs are text repairs: align the stem with the image, or remove it.
  if (/^IMAGE (CONFLICT|NOT LOADING|MISSING):/.test(c)) return 'fix';
  if (isImageChange(c)) return 'image';
  if (METADATA_RE.test(c)) return 'label';
  // "…the lead-in applies anatomy, so change bloom_level from 5_evaluate to 3_apply" is a relabel
  // that merely cites the stem; "convert the stem into a vignette consistent with Bloom's 3_apply"
  // is a text change. What the request asks to change decides, not what it mentions.
  if (RELABEL_ACTION_RE.test(c)) return 'label';
  if (OWN_TEXT_RE.test(c)) return 'fix';
  if (LABEL_RE.test(c)) return 'label';
  if (OWN_FORMAT_RE.test(c)) return 'fix';
  if (BATCH_RE.test(c)) return existingBank ? 'batch' : 'fix';
  return 'fix';
}

export interface RoutedChanges {
  fix: string[];
  image: string[];
  label: string[];
  batch: string[];
  /** Text repairs not attempted because the item's image contradicts it. */
  heldForImage: string[];
}

/**
 * Split a reviewer's requests. When anything says the image is wrong, the text repairs are held:
 * the item is unusable until its picture is replaced, and a text repair made before then is
 * written around the wrong image — a blind solve that disagreed only because the ECG was wrong
 * got "fixed" by describing the right ECG in the stem.
 */
export function routeChanges(changes: string[], extraImageFeedback: string[], existingBank: boolean, hasImage: boolean, restructure = false): RoutedChanges {
  const out: RoutedChanges = { fix: [], image: [...extraImageFeedback], label: [], batch: [], heldForImage: [] };
  for (const c of changes) out[routeChange(c, existingBank)].push(c);
  // Restructure mode cannot replace a live-bank image either, but holding the text left every
  // contradicted item untouched and flagged (3 of 8 flags in the second restructure pilot: an SAH CT
  // that shows blood under a stem calling it negative, a flow plot, a POLST form). Instead the fixer,
  // shown the image, aligns the text with it or removes the image (fixer.ts, IMAGE RECONCILE).
  //
  // Only a request that names the PICTURE is labelled a conflict. isImageChange also catches text
  // requests that mention a modality ("Replace the CT angiography distractor…"), and labelling those
  // IMAGE CONFLICT had the fixer remove a sound image from a glaucoma item in the third pilot.
  if (restructure && hasImage && out.image.length) {
    // It must also say the picture is WRONG: "provide the biopsy class without relying on a single
    // glomerular image" names an image but asks for text, and labelled a conflict it cost a lupus
    // nephritis item its biopsy image in the fourth pilot.
    const PICTURE_WRONG = /\b(contradict\w*|conflict\w*|inconsisten\w*|mismatch\w*|opposite|unreadable|illegible|wrong|incorrect|replace|regenerate|swap)\b|\b(does not|doesn't|do not|fails? to|cannot be) (show|match|depict|agree|be read|be seen)/i;
    const aboutPicture = (c: string) => IMAGE_WORD_RE.test(c) && PICTURE_WRONG.test(c) && !/^(DISTRACTOR|CUE|FORMAT|EXPLANATION|DIFFICULTY):/.test(c);
    out.fix = [...out.image.map((c) => (/^IMAGE (CONFLICT|NOT LOADING|MISSING)/.test(c) || !aboutPicture(c) ? c : `IMAGE CONFLICT: ${c}`)), ...out.fix];
    out.image = [];
    return out;
  }
  // Only an item that HAS a picture can be contradicted by it; "this would benefit from an image"
  // on a text item must not block its text repairs.
  if (hasImage && out.image.length && out.fix.length) { out.heldForImage = out.fix; out.fix = []; }
  return out;
}
