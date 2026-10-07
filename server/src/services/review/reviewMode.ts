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
• Nothing may cue the key. Ask for a fix when the keyed option is the longest or most qualified, repeats a distinctive stem word no distractor repeats, matches the lead-in grammatically where others do not, or when absolute terms (always, never, only) appear only in distractors, or an option is "all/none of the above". Shorten the key or lengthen distractors so the choices look alike.
• Replace an implausible distractor with one a candidate holding a specific, nameable misconception would choose.
• The vignette follows the exam's pattern (see the stem guidelines above): age and sex, setting, chief complaint with its duration, the relevant history, medications, vital signs, examination, and the laboratory or imaging results the decision needs — then ONE closed lead-in ending in "?". Nothing in the stem may name the answer. Add the missing pieces; do not pad with data that plays no part in the decision.
• Keep what the item tests. Change the keyed answer only when it is wrong under current US practice, and give the evidence; where two answers are defensible, add the fact that makes one best.
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

/**
 * Whether the keyed option stands out by length: the uniquely longest choice, and at least 30%
 * longer than the median distractor. Measured on the 60 pilot items, the keyed option was the
 * uniquely longest in 17 originals; the 30% margin keeps near-ties (8 words against 7) out.
 */
export function keyLengthCue(q: Record<string, unknown>): { key: number; median: number } | null {
  const { texts, key } = optionTexts(q);
  if (key < 0 || texts.length < 3) return null;
  const lens = texts.map(words);
  const others = lens.filter((_, i) => i !== key).sort((a, b) => a - b);
  const median = others[Math.floor(others.length / 2)];
  const unique = lens[key] > Math.max(...others);
  return unique && lens[key] >= Math.max(median * 1.3, median + 2) ? { key: lens[key], median } : null;
}

export function cueIssues(q: Record<string, unknown>): string[] {
  const { texts } = optionTexts(q);
  const out: string[] = [];
  if (texts.length && texts.length !== 5) {
    out.push(`FORMAT: The item has ${texts.length} options; exam items have exactly five. ${texts.length < 5 ? 'Add' : 'Merge or remove'} options so there are five homogeneous, plausible choices.`);
  }
  const len = keyLengthCue(q);
  if (len) {
    out.push(`FORMAT: The keyed option is the longest choice (${len.key} words against a median of ${len.median} for the others), which cues the answer. Shorten the keyed option or lengthen the distractors so all five are similar in length and specificity.`);
  }
  const nota = texts.filter((t) => NOTA.test(t));
  if (nota.length) out.push(`FORMAT: "${nota[0].slice(0, 60)}" is an all/none-of-the-above option, which exam items do not use. Replace it with a specific, plausible choice.`);
  return out;
}
