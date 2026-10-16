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

export async function sameConcept(original: Row, revised: Row): Promise<ConceptVerdict> {
  const prompt = `Compare what two versions of an exam item TEST — the task the candidate must perform and the knowledge it requires — not how well they are written.

ORIGINAL:
${render(original)}

REVISED:
${render(revised)}

The revised version tests the SAME thing if a candidate needs the same knowledge to answer it and performs the same task (e.g. both ask for the next step in managing this condition; both ask for the site of narrowing). Added clinical detail, reworded options, a clarified stem or a corrected fact keep it the same. It tests something DIFFERENT if the task or the knowledge changed — a drug choice became a drug mechanism, a localisation became a diagnosis, a management decision became recognition of the condition, a calculation became an interpretation.

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
