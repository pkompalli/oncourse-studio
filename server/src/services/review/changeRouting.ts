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
 *   label — a difficulty or Bloom's relabel. The fixer's output for those fields is never
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

const LABEL_RE = /^DIFFICULTY:|\b(difficulty|bloom'?s?)\s+(label|level|rating)\b|\breconsider difficulty\b|\bdifficulty\b.*\b(easy|medium|hard)\b|\bbloom'?s?\b.*\b\d_[a-z]+/i;

// Every reviewer sees only its batch, so a request that refers to the batch at all is about the
// batch, not the item.
const BATCH_RE = /^CONCEPT OVERLAP:|\bbatch\b|\boverrepresent|\bover-represent|\bduplicat|\bnear-identical\b|\bconcept diversity\b|\b(answer|key)s?\b.*\b(distribution|balance|diversify|varying|vary)\b|\bone of (two|three|four|\d+) '?[A-E]'? answers\b|\bQ\d+\b.*\b(same|overlap)|\bskew|\blettering\b/i;

export type ChangeRoute = 'fix' | 'image' | 'label' | 'batch';

export function isImageChange(c: string): boolean {
  return (IMAGE_WORD_RE.test(c) && IMAGE_WRONG_RE.test(c)) || (IMAGE_NOUN_RE.test(c) && IMAGE_REPLACE_RE.test(c));
}

/** Route one request. `existingBank` keeps batch-relative requests off the fixer. */
export function routeChange(c: string, existingBank: boolean): ChangeRoute {
  if (/^CONCEPT OVERLAP:/i.test(c)) return existingBank ? 'batch' : 'fix';
  if (isImageChange(c)) return 'image';
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
export function routeChanges(changes: string[], extraImageFeedback: string[], existingBank: boolean, hasImage: boolean): RoutedChanges {
  const out: RoutedChanges = { fix: [], image: [...extraImageFeedback], label: [], batch: [], heldForImage: [] };
  for (const c of changes) out[routeChange(c, existingBank)].push(c);
  // Only an item that HAS a picture can be contradicted by it; "this would benefit from an image"
  // on a text item must not block its text repairs.
  if (hasImage && out.image.length && out.fix.length) { out.heldForImage = out.fix; out.fix = []; }
  return out;
}
