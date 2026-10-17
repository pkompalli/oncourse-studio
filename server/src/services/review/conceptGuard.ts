/**
 * Two judgements about a revision against the item it came from.
 *
 *   sameConcept — does the revised item still test what the original tested? The answer-identity guard
 *     (fixer.ts sameAnswer) checks only the keyed option. In the pre-2025 USMLE sample the pipeline
 *     kept the key and changed the question: "select empiric PPI therapy" became "omeprazole's
 *     mechanism", "where is croup's narrowing" became "what is the diagnosis". A blind judge preferred
 *     the original in 6 such cases. Used by the fixer (refuse the fix) and by audit (block approval).
 *
 *   preferOriginal — a blind pairwise comparison, both orders. Used to keep an original that was
 *     already sound when the revision is not better: 12 of the 14 originals the judge preferred had
 *     passed every required check, and the pipeline still rewrote them.
 *
 * Both fail safe: an unreadable or failed call means "same concept" and "keep the revision", so an
 * outage never reverts work or blocks it.
 */
import { orCall, MODELS } from '../llm/openrouter.js';
import { optionTexts } from './reviewMode.js';

type Row = Record<string, unknown>;
const LETTERS = 'ABCDEFGHIJ';

function render(q: Row): string {
  const c = (q.content && typeof q.content === 'object' ? q.content : {}) as Row;
  const stem = String(q.question ?? c.stem ?? '');
  const { texts, key } = optionTexts(q);
  if (texts.length) return `${stem}\n${texts.map((t, i) => `${LETTERS[i]}. ${t}${i === key ? '   (keyed)' : ''}`).join('\n')}`;
  // Non-letter formats (bow-tie and the like): stem and the stored answer.
  return `${stem}\nAnswer: ${JSON.stringify(c.answer ?? q.correct_option ?? '')}`;
}

export interface ConceptVerdict { same: boolean; original: string; revised: string }

/**
 * `mode: 'update'` — the keyed answer was ruled wrong or outdated under current guidelines (answer
 * adjudication), so the answer is meant to change: only the clinical problem and the kind of task must stay.
 *
 * The first version refused 82% of the repairs on the 1,073 items the pre-2025 run left flagged. In a
 * sample of 300 refusals about 40% kept the same task and the same answer — reworded more narrowly or
 * broadly, or made the candidate infer a diagnosis the original simply stated ("recall the marker of
 * explicitly diagnosed choriocarcinoma" → "recognise choriocarcinoma from histology and give its marker"),
 * which is the repair a giveaway stem needs. Those are now the same concept; a different decision or a
 * different kind of answer is still not.
 */
export async function sameConcept(original: Row, revised: Row, mode: 'strict' | 'update' = 'strict'): Promise<ConceptVerdict> {
  const rules = mode === 'update'
    ? `The keyed answer of this item was ruled wrong or outdated under current guidelines, so the answer is EXPECTED to change. The revised version tests the SAME thing if it poses the same clinical problem (same condition or situation) and the same kind of task (still a treatment choice, still a diagnosis, still a next step…), with the answer brought up to current practice. It is DIFFERENT only if it now poses a different clinical problem or a different kind of task.`
    : `The revised version tests the SAME thing if the candidate performs the same kind of task and needs the same core knowledge, and the keyed answer is the same answer. All of these keep it the SAME:
  - added or removed clinical detail, reworded or replaced distractors, a clarified or corrected stem or explanation;
  - asking the same thing more narrowly, more broadly or more precisely;
  - making the candidate infer something the original stated outright (a named diagnosis or finding becomes a presentation to recognise) while still asking for the same answer — that removes a giveaway.
It is DIFFERENT only if the decision or fact tested changed, or the answer became a different kind of thing: a drug choice became a drug mechanism, a diagnosis became a mechanism, a localisation became a diagnosis, prophylaxis became acute treatment, a different patient problem.`;
  const prompt = `Compare what two versions of an exam item TEST — the task the candidate must perform and the knowledge it requires — not how well they are written.

ORIGINAL:
${render(original)}

REVISED:
${render(revised)}

${rules}

Reply with JSON only: {"original_tests": "<one short phrase>", "revised_tests": "<one short phrase>", "same": true|false}`;
  try {
    const r = await orCall(MODELS.AUDITOR, '', prompt, { maxTokens: 400, temperature: 0 });
    const m = r.content.match(/\{[\s\S]*\}/);
    const v = m ? JSON.parse(m[0]) : null;
    if (!v || typeof v.same !== 'boolean') return { same: true, original: '', revised: '' };
    return { same: v.same, original: String(v.original_tests ?? ''), revised: String(v.revised_tests ?? '') };
  } catch {
    return { same: true, original: '', revised: '' };
  }
}

/** Only worth asking when the question part moved: the lead-in changed or the keyed text did. */
export function conceptMayHaveMoved(before: Row, after: Row): boolean {
  const lead = (q: Row) => {
    const s = String(q.question ?? (q.content as Row | undefined)?.stem ?? '').trim();
    return (s.match(/[^.?!]*\?\s*$/)?.[0] ?? s.slice(-160)).toLowerCase().replace(/\s+/g, ' ').trim();
  };
  if (lead(before) !== lead(after)) return true;
  const a = optionTexts(before), b = optionTexts(after);
  return a.key >= 0 && b.key >= 0 && String(a.texts[a.key]).trim().toLowerCase() !== String(b.texts[b.key]).trim().toLowerCase();
}

const PAIR_PROMPT = (x: string, y: string) => `Two versions of the same USMLE-style item. Judge which is the better exam item: medical accuracy, a single defensible answer, testing the intended concept, an exam-style stem with what the decision needs and no padding, a closed lead-in, homogeneous plausible options with no cue to the key, and a complete explanation.

VERSION X:
${x}

VERSION Y:
${y}

Reply with JSON only: {"better": "X" | "Y" | "tie", "reason": "<one sentence>"}`;

/** True only when both orderings prefer the original. */
export async function preferOriginal(original: Row, revised: Row): Promise<{ original: boolean; reason: string }> {
  const o = render(original) + `\nExplanation: ${String(original.explanation ?? '').slice(0, 1500)}`;
  const r = render(revised) + `\nExplanation: ${String(revised.explanation ?? '').slice(0, 1500)}`;
  try {
    const [a, b] = await Promise.all([
      orCall(MODELS.AUDITOR, '', PAIR_PROMPT(o, r), { maxTokens: 300, temperature: 0 }),
      orCall(MODELS.AUDITOR, '', PAIR_PROMPT(r, o), { maxTokens: 300, temperature: 0 }),
    ]);
    const pick = (t: string) => { try { return JSON.parse(t.match(/\{[\s\S]*\}/)?.[0] ?? '{}'); } catch { return {}; } };
    const va = pick(a.content), vb = pick(b.content);
    return { original: va.better === 'X' && vb.better === 'Y', reason: String(va.reason ?? '') };
  } catch {
    return { original: false, reason: '' };
  }
}
