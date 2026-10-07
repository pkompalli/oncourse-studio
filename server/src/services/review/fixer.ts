/**
 * Fixer — faithful port of V1's fix_content() qbank branch (app.py 6410-6582)
 * Model: OR_MAIN_MODEL (Claude) — conservative fix, ONLY changes what's listed
 */

import { orCall, MODELS, type ContentPart } from '../llm/openrouter.js';
import { fetchImageAsDataUrl } from './shared.js';
import { keyLengthCue, describeLengthCue, STEM_REFS_IMAGE } from './reviewMode.js';

export interface FixResult {
  fixed: boolean;
  question?: Record<string, unknown>;
  changesApplied?: string[];
  error?: string;
  /** Restructure mode: the image was removed and the item made self-contained in text. */
  imageRemoved?: boolean;
}

/**
 * Apply specific changes to a question — V1 fix prompt (app.py 6442-6473)
 * CRITICAL RULES from V1:
 * - ONLY change what is specifically listed in changes_required
 * - Do NOT rewrite, rephrase, or "improve" any text that isn't flagged
 * - Keep original wording, structure, and style for all non-flagged parts
 */
/**
 * Undo structure the fixer flattened on its way past.
 *
 * The fixer rewrites a whole question to change one thing, and while reconstructing
 * the JSON it sometimes serialises a nested object into a string it was never asked
 * to touch. A rubric came back as "{\"criteria\": [...]}" after a fix for an
 * unrelated blank-stem complaint — schema-valid, and useless: a candidate sees raw
 * JSON and the per-criterion points stop being readable as data.
 *
 * This is distinct from the schema bug that first caused it (scoring_rubric was
 * declared a bare string, so structured rubrics were rejected and the fixer was
 * explicitly told to stringify them). That is fixed; this guards the incidental
 * case, which can hit any structured field during any repair.
 */
function unflatten(node: unknown): void {
  if (!node || typeof node !== 'object') return;
  const obj = node as Record<string, unknown>;
  for (const [k, v] of Object.entries(obj)) {
    if (typeof v === 'string') {
      const t = v.trim();
      if (t.startsWith('{') || t.startsWith('[')) {
        try {
          const parsed = JSON.parse(t);
          // Only rescue real structure; a stem that merely begins with a brace stays.
          if (parsed && typeof parsed === 'object') obj[k] = parsed;
        } catch { /* genuine prose — leave it */ }
      }
    } else if (Array.isArray(v)) {
      v.forEach((x) => unflatten(x));
    } else if (v && typeof v === 'object') {
      unflatten(v);
    }
  }
}

/**
 * Did the fixer change the question's SHAPE rather than its content?
 *
 * The prompt says "only change what is listed" but nothing enforced it, and the result was
 * accepted whatever came back. Asked to fill in a null bloom_level, the fixer rewrote a
 * one-component NextGen drafting set into six components in invented formats (true_false,
 * multiple_select, fill_in_blank) — a different item type wearing the same id, passing
 * validation, with no trace in changes_applied.
 *
 * Structure is only allowed to move when a change ASKED for it. Returns the reason it
 * refused, or null when the fix is structurally faithful.
 */
/** Option texts in display order: the legacy {A:…} column, else content.options [{key,text}]. */
function optionTexts(q: Record<string, unknown>): string[] | null {
  const o = q.options;
  if (o && typeof o === 'object' && !Array.isArray(o)) {
    return Object.keys(o as Record<string, unknown>).sort().map((k) => String((o as Record<string, unknown>)[k] ?? ''));
  }
  const co = (q.content as Record<string, unknown> | undefined)?.options;
  if (Array.isArray(co)) return co.map((x) => String((x as Record<string, unknown>)?.text ?? x ?? ''));
  return null;
}

function keyText(q: Record<string, unknown>): string | null {
  const opts = q.options as Record<string, unknown> | undefined;
  const k = String(q.correct_option ?? q.correct_answer ?? (q.content as Record<string, unknown> | undefined)?.answer ?? '');
  if (opts && typeof opts === 'object' && !Array.isArray(opts) && /^[A-J]$/.test(k)) return String(opts[k] ?? '');
  return null;
}

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim();

/**
 * Whether a revised option is still the same choice: the share of one side's content words found
 * on the other, taken in whichever direction is larger, so shortening ("Respect the patient's
 * refusal and provide comfort care…" → "Respect the patient's refusal of surgery") and expanding
 * ("Sacral promontory" → "…sacrohysteropexy to the sacral promontory") both keep identity.
 * Measured on 23 option edits from two USMLE pilots: the 8 real replacements scored ≤ 0.25 and
 * every rewording ≥ 0.50.
 */
export const OPTION_IDENTITY_MIN = 0.5;
const STOPWORDS = new Set('a an the of to in on for with and or by at as is are be from that this its their his her'.split(' '));
export function optionIdentity(before: string, after: string): number {
  const words = (s: string) => new Set((s.toLowerCase().match(/[a-z0-9]+/g) || []).filter((w) => !STOPWORDS.has(w)));
  const A = words(before), B = words(after);
  if (!A.size || !B.size) return norm(before) === norm(after) ? 1 : 0;
  const shared = [...A].filter((w) => B.has(w)).length;
  return Math.max(shared / A.size, shared / B.size);
}

/**
 * The fixer's JSON, wherever it sits in the reply. Sonnet 5.5 often writes a sentence first
 * ("The required changes…", "I expanded…"), which JSON.parse rejects outright: 10 of the re-run
 * pilot's first attempts, and 3 repairs that failed twice. Fenced blocks are tried first, then the
 * whole reply, then each balanced top-level {…} in turn, preferring one with a "question" field.
 */
export function extractFixerJson(raw: string): Record<string, unknown> {
  const text = raw.trim();
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidates: string[] = [];
  if (fenced) candidates.push(fenced[1].trim());
  candidates.push(text);
  // Balanced top-level objects, skipping braces inside strings.
  for (let start = text.indexOf('{'); start >= 0; start = text.indexOf('{', start + 1)) {
    let depth = 0, inStr = false, esc = false;
    for (let i = start; i < text.length; i++) {
      const c = text[i];
      if (inStr) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') inStr = false; continue; }
      if (c === '"') inStr = true;
      else if (c === '{') depth++;
      else if (c === '}' && --depth === 0) { candidates.push(text.slice(start, i + 1)); break; }
    }
  }
  let firstObject: Record<string, unknown> | null = null;
  for (const c of candidates) {
    try {
      const v = JSON.parse(c);
      if (v && typeof v === 'object' && !Array.isArray(v)) {
        if ('question' in v) return v as Record<string, unknown>;
        firstObject ??= v as Record<string, unknown>;
      }
    } catch { /* not this one */ }
  }
  if (firstObject) return firstObject;
  throw new Error(`no JSON object in the fixer's reply: ${text.slice(0, 60)}`);
}

/**
 * `locked`: the item is already in use (an imported bank), so its option count and order are fixed
 * whatever a change asks — a reviewer told "reduce to the standard five options" would otherwise
 * delete an option candidates have chosen. Wording and the key can still change.
 */
export function optionDrift(before: Record<string, unknown>, after: Record<string, unknown>, asked: string, locked = false, restructure = false, allowKeyReword = false): string | null {
  const a = optionTexts(before);
  const b = optionTexts(after);
  if (!a || !b || !a.length) return null;
  // Restructure mode (reviewMode.ts): options may be added, replaced, reworded or reordered to reach
  // the exam's standard, so the checks below that protect recorded answers do not apply. What must
  // hold is the standard itself — five options — and that the correct answer is still the same
  // choice unless a reviewer said the key was wrong.
  if (restructure) {
    if (b.length !== 5) return `option count ${b.length}; five are required`;
    // A length repair rewords the key on purpose; whether it is the same answer is settled by
    // sameAnswer() in fixQuestion, not by word overlap.
    if (allowKeyReword) return null;
    const ka = keyText(before), kb = keyText(after);
    if (ka !== null && kb !== null && optionIdentity(ka, kb) < OPTION_IDENTITY_MIN
        && !/\b(answer key|correct answer|keyed answer|key\b|correct option|image conflict)/.test(asked)) {
      return `correct answer became a different choice ("${ka.slice(0, 50)}" -> "${kb.slice(0, 50)}") without a request to change the key`;
    }
    return null;
  }
  if (a.length !== b.length && (locked ||!/\b(add|remove|delete|drop|reduce|replace|fewer|more|option count|number of options)\b[^.]{0,40}\boptions?\b|\boption count\b/.test(asked))) {
    return `option count ${a.length} -> ${b.length}${locked ? ' on an item already in use' : ''}`;
  }
  // Same options, new order: nothing a candidate needs, and every recorded answer moves.
  const sameSet = a.length === b.length && [...a].map(norm).sort().join('\u0001') === [...b].map(norm).sort().join('\u0001');
  if (sameSet && a.map(norm).join('\u0001') !== b.map(norm).join('\u0001') && (locked || !/\b(reorder|re-order|shuffle|reletter|re-letter|order of (the )?options|option order)\b/.test(asked))) {
    return 'options reordered';
  }
  // Same count and order, different choices. Asked to turn "which bony landmark…" into a vignette,
  // the fixer kept five options in place and replaced every one ("Ischial spine" became "Vaginal
  // hysterectomy with uterosacral suspension"), so each recorded answer would now name a choice
  // its candidate never saw. On an item in use, each option may be reworded, not replaced.
  if (locked && a.length === b.length) {
    for (let i = 0; i < a.length; i++) {
      if (norm(a[i]) !== norm(b[i]) && optionIdentity(a[i], b[i]) < OPTION_IDENTITY_MIN) {
        return `option ${String.fromCharCode(65 + i)} replaced, not reworded ("${a[i].slice(0, 50)}" -> "${b[i].slice(0, 50)}")`;
      }
    }
  }
  // Which option is keyed, not what it says: editing the keyed option's wording (stripping a stray
  // "C. " prefix, say) is a text fix, and comparing text refused it as a key move. With the
  // options in place the letter identifies the option; only a re-shaped set falls back to text.
  const la = String(before.correct_option ?? ''), lb = String(after.correct_option ?? after.correct_answer ?? '');
  const moved = a.length === b.length && /^[A-J]$/.test(la) && /^[A-J]$/.test(lb)
    ? la !== lb
    : (() => { const ka = keyText(before), kb = keyText(after); return ka !== null && kb !== null && norm(ka) !== norm(kb); })();
  if (moved && !/\b(answer key|correct answer|keyed answer|key\b|correct option)/.test(asked)) {
    return 'correct answer changed without a request to change it';
  }
  return null;
}

export function structuralDrift(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
  changesRequired: string[],
  locked = false,
  restructure = false,
  allowKeyReword = false
): string | null {
  const asked = changesRequired.join(' ').toLowerCase();

  // A single-best-answer item's options are its structure too. Asked to "reduce overrepresentation
  // of B", the fixer reshuffled an item's options to move its key to C; asked to fix an
  // explanation, it dropped a sixth option. On an item already in use, either one reattaches every
  // recorded answer to different text.
  const mcqDrift = optionDrift(before, after, asked, locked, restructure, allowKeyReword);
  if (mcqDrift) return mcqDrift;

  const subsOf = (q: Record<string, unknown>) => {
    const c = (q.content as Record<string, unknown>) || q;
    return Array.isArray(c?.sub_questions) ? (c.sub_questions as Array<Record<string, unknown>>) : null;
  };
  const a = subsOf(before);
  const b = subsOf(after);
  if (!a || !b) return null;

  // A sub-question count change is structural. Allow it only when something asked.
  if (a.length !== b.length && !/sub[_ ]?question|component|add |remove |six|count/.test(asked)) {
    return `sub_question count ${a.length} -> ${b.length}`;
  }

  // Each component that SURVIVES must keep its response model, unless the change named
  // formats. Compare only the overlap: when a count change was legitimately requested, the
  // added components are new and have no prior format to preserve.
  if (!/format_type|response model|convert|change .*format/.test(asked)) {
    const n = Math.min(a.length, b.length);
    const fa = a.slice(0, n).map((s) => String(s?.format_type || '')).join(',');
    const fb = b.slice(0, n).map((s) => String(s?.format_type || '')).join(',');
    if (fa !== fb) return `sub-question formats ${fa || '(none)'} -> ${fb || '(none)'}`;
  }
  return null;
}

/**
 * Apply a reviewer's changes. In restructure mode a repair that leaves the keyed option the longest
 * choice goes back for up to two narrow rounds with the measurements in hand: asked in general terms
 * ("similar length"), the fixer left the key longest by characters in 16 of 60 round-2 items.
 */
export async function fixQuestion(
  question: Record<string, unknown>,
  changesRequired: string[],
  courseName: string,
  opts?: { existingBank?: boolean; restructure?: boolean }
): Promise<FixResult> {
  const first = await fixOnce(question, changesRequired, courseName, opts);
  if (!opts?.restructure || !first.fixed || !first.question) return first;
  let best = first;
  for (let round = 1; round <= 2; round++) {
    const cue = keyLengthCue(best.question!);
    if (!cue) break;
    const ask = `FORMAT: The keyed option is still the longest choice (${describeLengthCue(cue)}). Shorten the keyed option without changing its meaning, or lengthen one or more distractors with plausible, specific detail of the same kind, so that at least one distractor is at least as long as the keyed option in BOTH characters and words and all five look alike. Change nothing else, except explanation wording that quotes a reworded option.`;
    const again = await fixOnce(best.question!, [ask], courseName, { ...opts, allowKeyReword: true });
    if (!again.fixed || !again.question) break;
    // Judged against the ORIGINAL as well: rounds of shortening must not drift the key into a different
    // choice. Word overlap cannot tell "Perform right lower quadrant ultrasound" from "Obtain
    // graded-compression RLQ ultrasound" (refused in the third pilot), so a key that overlaps little
    // is put to sameAnswer() instead.
    const drift = structuralDrift(question, again.question, [...changesRequired, ask], false, true, true);
    if (drift) { console.warn(`  [Fixer] cue round ${round} refused (${drift})`); break; }
    const ka = keyText(question), kb = keyText(again.question);
    if (ka !== null && kb !== null && optionIdentity(ka, kb) < OPTION_IDENTITY_MIN && !(await sameAnswer(String(question.question ?? ''), ka, kb))) {
      console.warn(`  [Fixer] cue round ${round} refused (the keyed option became a different answer: "${ka.slice(0, 50)}" -> "${kb.slice(0, 50)}")`);
      break;
    }
    best = { ...again, changesApplied: [...(best.changesApplied || []), ...(again.changesApplied || [])], imageRemoved: best.imageRemoved || again.imageRemoved };
  }
  return best;
}

const IMAGE_ASK = /^IMAGE (CONFLICT|NOT LOADING|MISSING)/;
const IMAGE_GONE = /^IMAGE (NOT LOADING|MISSING)/;

/**
 * Whether two wordings of the keyed option name the same answer to this question. Asked of the
 * reviewer model with both wordings and the stem; anything but a clear "same" counts as different,
 * so a failed call keeps the earlier version.
 */
export async function sameAnswer(stem: string, before: string, after: string): Promise<boolean> {
  const prompt = `A question's correct option was reworded to change its length. Decide whether the new wording names the SAME answer — the same action, diagnosis, mechanism or choice, with the same meaning for this question — or a DIFFERENT one. Added or removed detail that a candidate would read as the same choice counts as same; a different action, drug, diagnosis, structure or sequence counts as different.

QUESTION:
${stem.slice(-1500)}

BEFORE: ${before}
AFTER: ${after}

Reply with exactly one word: SAME or DIFFERENT.`;
  try {
    const r = await orCall(MODELS.AUDITOR, '', prompt, { maxTokens: 400, temperature: 0 });
    return /^\s*SAME\b/i.test(r.content);
  } catch {
    return false;
  }
}

async function fixOnce(
  question: Record<string, unknown>,
  changesRequired: string[],
  courseName: string,
  opts?: { existingBank?: boolean; restructure?: boolean; allowKeyReword?: boolean }
): Promise<FixResult> {
  if (!changesRequired || changesRequired.length === 0) {
    return { fixed: false };
  }

  // Restructure mode reconciles an item with its image rather than holding it (changeRouting.ts).
  // The fixer is SHOWN the image: asked to repair a contradiction it could not see, it could only
  // guess what the picture held.
  const imageUrl = opts?.restructure ? ((question.image_url as string | null | undefined) || null) : null;
  const imageAsked = Boolean(opts?.restructure) && changesRequired.some((c) => IMAGE_ASK.test(c));
  const imageGone = Boolean(opts?.restructure) && changesRequired.some((c) => IMAGE_GONE.test(c));
  const dataUrl = imageUrl && !imageGone ? await fetchImageAsDataUrl(imageUrl) : null;
  const imageRules = !opts?.restructure || !(imageAsked || dataUrl) ? '' : imageGone
    ? `
IMAGE — REMOVE: the item's image is missing or broken and cannot be replaced. Make the item self-contained in text: state in words the findings the decision needs (as a radiology or pathology report would — "Noncontrast CT of the head shows no hemorrhage"), without naming the diagnosis or answer the item tests, and remove every reference to an image ("shown", "the image", "the figure"). Set "image_decision" to "remove".`
    : `
IMAGE — the item's attached image is shown after this prompt. It cannot be replaced or edited.${imageAsked ? ` A reviewer found that it conflicts with the text. Look at it yourself and choose ONE:
  • "align" — the image is clear and the item tests reading it: rewrite the stem (and options, key and explanation if they must follow) so every statement agrees with what the image actually shows. Keep what the item tests wherever the image allows; change the keyed answer only if what the image shows makes a different answer correct, and say so in changes_applied.
  • "remove" — the image is unreadable, wrong for this item, merely decorative, or aligning would mean testing something different: drop it and make the item self-contained in text, stating in words the findings the decision needs (as a report would), without naming the answer, and removing every reference to an image.
  Prefer whichever keeps the item testing the same concept. Set "image_decision" to "align" or "remove".` : ` Keep every statement in the stem and explanation consistent with it, and set "image_decision" to "keep".`}
  Never describe in the stem what the image ought to show but does not.`;

  const contentJson = JSON.stringify(question, null, 2);
  const changesText = changesRequired.map((c) => `  ${c}`).join('\n');

  const prompt = `You are an expert ${courseName || 'exam'} question editor. Apply EXACTLY the required changes below to this question — nothing more, nothing less.

CRITICAL RULES:
• ONLY change what is specifically listed in REQUIRED CHANGES. Do NOT rewrite, rephrase, or "improve" any text that isn't flagged.
• Keep the original wording, structure, and style for all non-flagged parts.
• If a change asks to fix a factual error, change ONLY the incorrect fact — do not rewrite the surrounding sentence.
• Do NOT add new content, options, or explanations beyond what the changes require.
• Preserve ALL fields from the original JSON — the question may be any format (MCQ, SATA, ordered response, fill-in-blank, etc.).
• NEVER change the question's STRUCTURE unless a required change explicitly asks for it. Keep the same number of sub_questions, in the same order, each with the SAME format_type. A set with one sub-question keeps exactly one; do not "complete" it by adding more. Fixing a missing field means filling that field in place, not rebuilding the question around it.
${opts?.restructure
  ? `• The question must end with EXACTLY FIVE options, keyed A–E in the "options" object, with "correct_option" naming the keyed letter. Add, replace, reword or reorder options as the changes require; every option must be the same kind of thing, in parallel grammar, of similar length and specificity, and the keyed option must not stand out (not the longest, not the most qualified, no stem word only it repeats). Keep the correct answer the same choice unless a change says the key is wrong.
• Explanations name each option by its text, never by letter: options are reordered afterwards.`
  : '• Keep every OPTION, in the same order, under the same letter, unless a change explicitly asks to add, remove, replace or reorder options. A wrong or weak option is fixed by editing its wording in place. Change which option is correct only when a change says the key is wrong.'}
${opts?.restructure
  ? '• You cannot change an image, but you may align the text with it or remove it as the IMAGE section below sets out.'
  : '• You cannot change an image. If a change can only be met by a different image, mark it "❌" — never describe in the stem or explanation what the image should show; that hands the candidate the answer.'}
• Never shorten a clinical vignette into a recall question or strip clinical detail from it, and never write a "fix" that refers to other questions in a batch (overlap, answer-letter balance) — mark such a change "❌".
${opts?.restructure
  ? '• A vignette follows the exam pattern: age and sex, setting, chief complaint with duration, relevant history and medications, vital signs (stated even when normal), examination, then the laboratory or imaging results the decision needs, ending in ONE closed lead-in such as "Which of the following is the most likely diagnosis?" that fits every option and does not echo the keyed option\'s wording. Keep the concept and question type the item tests; nothing in the stem may name the answer. Keep every finding the explanation relies on, and keep plausible distractors rather than replacing them.'
  : '• Turning a short stem into a clinical vignette keeps the SAME question being asked and the SAME options: a "most likely diagnosis" item stays a diagnosis item with the same diagnoses to choose from. If a change can only be met by asking something different, mark it "❌".'}
• Write only what a candidate should read. Never put notes about the item itself into the stem, options or explanation ("the image adds no information", "this was revised to…").
• Reply with the JSON object only — no sentence before or after it.
${imageRules}
COURSE: ${courseName}

─── ORIGINAL QUESTION (JSON) ───
${contentJson}

─── REQUIRED CHANGES (apply every one, in order) ───
${changesText}

Return a JSON object with these fields:
1. "question" — the complete fixed question JSON (same structure as original)
2. "changes_applied" — array of strings, one per required change above, each prefixed with
   "✅ " if applied, "⚠️ " if partially applied (explain why), or "❌ " if not applicable / could not apply (explain why)${imageRules ? `
3. "image_decision" — "keep", "align" or "remove", as the IMAGE section sets out` : ''}

Example output format:
{
  "question": { ...fixed question fields... },
  "changes_applied": [
    "✅ 1. Changed 'CT scan' to 'MRI' in question stem",
    "✅ 2. Updated explanation to state adenosine is first-line for SVT"
  ]
}

Return ONLY valid JSON. No preamble, no markdown fences.`;

  // The fixer must restate the ENTIRE question, so a grouped question (case study
  // with 6 sub-questions, ~14k chars) needs far more than the old 4000-token cap —
  // it truncated mid-JSON, JSON.parse threw, and the repair was silently abandoned,
  // leaving the question flagged with no explanation. Generous cap + one retry.
  const MAX_TOKENS = 16000;
  let lastErr = '';
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const text = attempt === 1
        ? prompt
        : `${prompt}\n\nIMPORTANT: Return the COMPLETE JSON object — every field of the question, including every sub_question. Do NOT truncate or elide anything.`;
      const message: string | ContentPart[] = dataUrl
        ? [{ type: 'text', text }, { type: 'image_url', image_url: { url: dataUrl } }]
        : text;
      const response = await orCall(MODELS.FIXER, '', message, { maxTokens: MAX_TOKENS, temperature: attempt === 1 ? 0.2 : 0.1 });

      const wrapper = extractFixerJson(response.content);
      const fixed = (wrapper.question && typeof wrapper.question === 'object' ? wrapper.question : wrapper) as Record<string, unknown>;
      unflatten(fixed);

      // A fix that reshapes the question is worse than no fix: the flagged defect is
      // usually cosmetic, while the rewrite replaces a valid item with a different one.
      // Retry once with the rule spelled out, then keep the ORIGINAL rather than accept it.
      const drift = structuralDrift(question, fixed, changesRequired, Boolean(opts?.existingBank) && !opts?.restructure, Boolean(opts?.restructure), Boolean(opts?.allowKeyReword));
      if (drift) {
        console.warn(`  [Fixer] attempt ${attempt}/2 changed structure it was not asked to (${drift})`);
        lastErr = `structural drift: ${drift}`;
        if (attempt === 1) continue;
        console.error(`  [Fixer] REFUSED the fix — keeping the original question (${drift})`);
        return { fixed: false, error: lastErr };
      }

      // The image fields are decided here, not copied from the model's JSON: only a "remove" (or an
      // image that is already gone) clears them, and anything else keeps the original picture.
      let imageRemoved = false;
      if (opts?.restructure && (imageUrl || imageGone)) {
        const decision = String(wrapper.image_decision ?? '').toLowerCase();
        imageRemoved = imageGone || (imageAsked && decision === 'remove');
        if (imageRemoved) { fixed.image_url = null; fixed.is_image_question = false; }
        else fixed.image_url = imageUrl;
        if (imageRemoved && STEM_REFS_IMAGE.test(String(fixed.question ?? ''))) {
          lastErr = 'image removed but the stem still refers to it';
          console.warn(`  [Fixer] attempt ${attempt}/2: ${lastErr}`);
          if (attempt === 1) continue;
          return { fixed: false, error: lastErr };
        }
      }

      return {
        fixed: true,
        question: fixed,
        changesApplied: Array.isArray(wrapper.changes_applied) ? (wrapper.changes_applied as string[]) : [],
        ...(imageRemoved ? { imageRemoved } : {}),
      };
    } catch (e) {
      lastErr = e instanceof Error ? e.message : 'Fix failed';
      console.warn(`  [Fixer] attempt ${attempt}/2 failed to parse fixed question: ${lastErr}`);
    }
  }
  console.error(`  [Fixer] GAVE UP after 2 attempts — question left unrepaired: ${lastErr}`);
  return { fixed: false, error: lastErr };
}

/**
 * Fix multiple questions in parallel
 */
export async function fixQuestionsParallel(
  items: Array<{
    question: Record<string, unknown>;
    changesRequired: string[];
    dbId: string;
  }>,
  courseName: string
): Promise<Map<string, FixResult>> {
  const results = new Map<string, FixResult>();

  const promises = items.map(async (item) => {
    const result = await fixQuestion(item.question, item.changesRequired, courseName);
    results.set(item.dbId, result);
  });

  await Promise.all(promises);
  return results;
}
