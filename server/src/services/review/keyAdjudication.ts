/**
 * Answer adjudication: settle every real change of the keyed answer before audit, instead of leaving
 * it for a clinician.
 *
 * Restructure mode lets review change which answer is keyed. Until now the export only labelled such
 * items "needs clinician review" — in the third pilot one of them (placenta previa) had flipped
 * between crossmatch and immediate cesarean across runs, because the stem had been rewritten to fit
 * whichever answer a reviewer preferred. Here a judge decides the correct answer for the stem as it
 * stands, under the authority the course names for deciding answers (examProfile.ts — current US practice
 * for USMLE, NICE for UKMLA, the Codification for CPA, …), names its basis, and lists the edits that leave exactly one
 * defensible answer; the fixer applies them (with its drift, five-option and length checks); audit
 * then scores the result like any other repair.
 *
 * An item is adjudicated when:
 *   - its keyed answer is a different answer from the imported original (word overlap below the
 *     identity threshold AND sameAnswer() says different — rewordings are not adjudicated), or
 *   - an independent blind solve in adversarial review chose a different answer from the key.
 *
 * Run by runImportedJobs between review and audit, and by reworkFlagged for any checklist job.
 */
import { supabase } from '../../db/supabase.js';
import { fetchAllRows } from '../../db/pagination.js';
import { orCall, MODELS, type ContentPart } from '../llm/openrouter.js';
import { fixQuestion, sameAnswer, optionIdentity, OPTION_IDENTITY_MIN } from './fixer.js';
import { optionTexts, keyLengthCue, cueIssues, reviewModeOf, bowTieStemCue, isSingleBest, subQuestionCueIssues, subLengthCues } from './reviewMode.js';
import { preferOriginal } from './conceptGuard.js';
import { routeChanges } from './changeRouting.js';
import { regenerateQuestionImage } from '../images/imageGeneration.js';
import { profileForJob, type ExamProfile } from './examProfile.js';
import { auditBatchForJob } from '../audit/auditPipeline.js';
import { changedFields } from '../audit/fixHistory.js';
import { formatQuestionsForReview, fetchImageAsDataUrl } from './shared.js';
import { parseChecks, checkChanges } from './reviewChecklist.js';
import { probeCues, probeIssues } from './cueProbe.js';

type Row = Record<string, any>;

/**
 * The columns a repaired item is saved with. `content` must go with them: reviews and audit read the
 * stem, options, key and explanation from content first (shared.ts formatOneQuestion), so saving only
 * the legacy columns left audit judging the unrepaired text. In the sixth pilot all ten items whose
 * post-audit fix "did not take" were this — the fixer had made the change in both places.
 */
export function savedFields(x: Row): Row {
  return {
    question: x.question, options: x.options, correct_option: x.correct_option, explanation: x.explanation,
    ...(x.content && typeof x.content === 'object' ? { content: x.content } : {}),
  };
}

const keyOf = (q: Row): string | null => {
  const o = q?.options;
  const k = String(q?.correct_option ?? '');
  return o && typeof o === 'object' && !Array.isArray(o) && o[k] != null ? String(o[k]) : null;
};

/** The item as imported: the "before" of its first repair (nothing earlier changes it). */
function originalOf(q: Row): Row | null {
  const first = ((q.audit_trail || []) as Row[]).find((e) => /_fix$/.test(String(e?.phase)) && e.before);
  return first ? first.before : null;
}

/** "ANSWER KEY — key B, attempt D. …" findings from adversarial review's blind solve. */
function blindDisagreements(q: Row): string[] {
  return ((q.audit_trail || []) as Row[])
    .filter((e) => e?.phase === 'adversarial')
    .flatMap((e) => (Array.isArray(e.changes) ? e.changes : []) as string[])
    .filter((c) => /^ANSWER KEY — key [A-J], attempt [A-J]|^BLIND BLOCKER/.test(String(c)));
}

interface Verdict { correct_answer: string; verdict: string; rationale: string; basis: string[]; edits: string[]; image_decides?: boolean }

/** A request is about the image disagreeing with the text. */
export const isImageConflict = (c: string) => /^IMAGE CONFLICT:|^\[IMAGE_CONSISTENT\]/.test(c);

/**
 * The fallback when no replacement image fits the question: the SMALLEST change to the question that
 * makes it agree with the image it has. The image stays part of the question — its finding is not
 * written into the text. Returns whether the item was changed.
 */
export async function alignWithImage(jobId: string, id: string, conflicts: string[], courseName: string, log: (s: string) => void = console.log): Promise<boolean> {
  const { data: q } = await supabase.from('qb_questions').select('*').eq('id', id).single();
  if (!q?.image_url || !conflicts.length) return false;
  const ask = `IMAGE ALIGN: No replacement image that fits this question could be produced, so the question must be made to fit the attached image instead. Look at the image and make the SMALLEST change to the stem, options, key and explanation that makes every statement agree with what it actually shows. Keep testing the same concept wherever the image allows; change the keyed answer only if what the image shows makes another answer correct. Do NOT write into the stem the finding the image is there to show — the candidate must still read the image. The reviewer found: ${conflicts.map((c) => c.replace(/^IMAGE CONFLICT:\s*/, '')).join(' ')}`;
  const fix = await fixQuestion(q as Row, [ask], courseName, { updateAnswer: true });
  const trail = Array.isArray(q.audit_trail) ? [...q.audit_trail] : [];
  const snap = (x: Row) => ({ question: x.question, options: x.options, correct_option: x.correct_option, explanation: x.explanation });
  if (!fix.fixed || !fix.question) {
    trail.push({ phase: 'image_align_failed', changes_requested: [ask], error: fix.error || 'no usable question', timestamp: new Date().toISOString() });
    await supabase.from('qb_questions').update({ audit_trail: trail }).eq('id', id);
    log(`  [ImageAlign] Q${q.question_number}: could not fit the question to its image (${fix.error ?? 'no question'})`);
    return false;
  }
  trail.push({ phase: 'image_align', changes_requested: [ask], changes_applied: fix.changesApplied || [], before: snap(q as Row), after: snap(fix.question), changed_fields: changedFields(snap(q as Row), snap(fix.question)), timestamp: new Date().toISOString() });
  await supabase.from('qb_questions').update({ ...savedFields(fix.question), audit_trail: trail }).eq('id', id);
  log(`  [ImageAlign] Q${q.question_number}: no replacement image fitted — question changed minimally to fit its image`);
  return true;
}

const LETTERS = 'ABCDEFGHIJ';

function judgePrompt(q: Row, original: Row | null, blind: string[], courseName: string, profile: ExamProfile | null, restructure: boolean): string {
  const { texts, key } = optionTexts(q);
  const origKey = original ? keyOf(original) : null;
  const authority = profile?.authority ?? 'the current, authoritative standards this exam is written to';
  const n = restructure ? 5 : profile?.optionCount ?? texts.length;
  return `You are the final authority on ${profile?.domain ?? 'the subject'} for a ${courseName} question bank. No expert will review this item after you: decide the correct answer yourself, from ${authority}, and make the item support exactly one best answer.

CURRENT ITEM
Stem: ${String(q.question ?? '')}
${texts.map((t, i) => `${LETTERS[i]}. ${t}${i === key ? '   ← currently keyed' : ''}`).join('\n')}
Explanation: ${String(q.explanation ?? '').slice(0, 3000)}
${original && origKey && original.question !== q.question ? `
AS ORIGINALLY WRITTEN (before review rewrote it)
Stem: ${String(original.question ?? '')}
Keyed answer: ${origKey}
` : original && origKey ? `
ORIGINALLY KEYED ANSWER: ${origKey}
` : ''}${blind.length ? `
AN INDEPENDENT BLIND SOLVE DISAGREED WITH THE KEY:
${blind.map((b) => `- ${b.slice(0, 500)}`).join('\n')}
` : ''}
Decide:
1. For the CURRENT stem, which option is the single best answer under that authority? If none is correct, give the correct answer as a new option text.
2. Does the stem support exactly one best answer? Find every fact or omission that would let a well-prepared candidate defend a different option (a missing finding or figure, an unstated condition or assumption, a sentence that invites another answer, data that point both ways).
3. If review rewrote the stem to fit a new answer, was that justified? Prefer the version that tests the item's original concept soundly; where the original scenario and key were right, the edits may restore them.
4. List the specific edits (to stem, options or explanation) that leave exactly one defensible answer and an explanation that states the reason, naming its basis (the guideline, standard, rule or source). Keep ${n} options; the keyed option must not be the longest. Empty list if the item is already sound.

Return ONLY a JSON object:
{"correct_answer": "<exact option text, or new option text>", "verdict": "current_key_correct" | "change_key", "image_decides": <true only if the item has an image and your verdict differs from the current key because of what that image shows>, "rationale": "<2-4 sentences: why this is the best answer and why the main alternative is not>", "basis": ["<guideline, standard, rule or source: the specific provision>"], "edits": ["<specific edit>"]}`;
}

/**
 * The judge's prompt with the item's image attached. Without it, asked to settle the key of an image item,
 * the judge answered "cannot be determined without the radiograph" and the item stayed flagged.
 */
async function withImage(q: Row, text: string): Promise<string | ContentPart[]> {
  const url = q.image_url as string | null | undefined;
  const data = url ? await fetchImageAsDataUrl(url) : null;
  return data ? [{ type: 'text', text: `${text}\n\nThe item's image is attached: read it yourself, and judge the answer by what it actually shows.` }, { type: 'image_url', image_url: { url: data } }] : text;
}

async function judge(q: Row, original: Row | null, blind: string[], courseName: string, restructure: boolean): Promise<Verdict | null> {
  const profile = q.job_id ? await profileForJob(String(q.job_id)) : null;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const r = await orCall(MODELS.AUDITOR, '', await withImage(q, judgePrompt(q, original, blind, courseName, profile, restructure)), { maxTokens: 4000, temperature: attempt === 1 ? 0.1 : 0 });
      const m = r.content.match(/\{[\s\S]*\}/);
      if (!m) continue;
      const v = JSON.parse(m[0]);
      if (!v.correct_answer) continue;
      return {
        correct_answer: String(v.correct_answer),
        verdict: String(v.verdict ?? ''),
        rationale: String(v.rationale ?? ''),
        basis: Array.isArray(v.basis) ? v.basis.map(String) : [],
        edits: Array.isArray(v.edits) ? v.edits.map(String) : [],
        image_decides: v.image_decides === true,
      };
    } catch (e) {
      console.warn(`  [Adjudicate] judge attempt ${attempt} failed: ${e instanceof Error ? e.message : e}`);
    }
  }
  return null;
}

function judgeAnyPrompt(q: Row, courseName: string, profile: ExamProfile | null): string {
  const authority = profile?.authority ?? 'the current, authoritative standards this exam is written to';
  return `You are the final authority on ${profile?.domain ?? 'the subject'} for a ${courseName} question bank. No expert will review this item after you: decide the correct answer yourself, from ${authority}, and make the item support exactly one correct answer.

ITEM (as stored, with its keyed answer and explanation):
${formatQuestionsForReview([q])}

Decide:
1. Is the stored answer correct under that authority? For a set, judge each sub-question; for an ordering, the sequence; for a select-all, the exact set; for a grid, each row.
2. Does the item support exactly that answer? Find every fact or omission that would let a well-prepared candidate defend a different one.
3. List the specific edits (to the stem, passage, options, rows or rationales) that leave exactly one defensible answer and an explanation that states the reason and its basis. Keep the item's format and size. Empty list if it is already sound.

Return ONLY a JSON object:
{"verdict": "current_key_correct" | "change_key", "correct_answer": "<the full correct answer in the item's own format: letters for a select-all, the order for an ordering, one entry per sub-question for a set (e.g. 1:B, 2:C), row → column for a grid>", "rationale": "<2-4 sentences>", "basis": ["<guideline, standard, rule or source: the specific provision>"], "edits": ["<specific edit>"]}`;
}

async function adjudicateOtherFormat(q: Row, courseName: string, mode: ReturnType<typeof reviewModeOf>, report: AdjudicationReport, log: (s: string) => void): Promise<void> {
  report.candidates++;
  const profile = q.job_id ? await profileForJob(String(q.job_id)) : null;
  let v: Verdict | null = null;
  for (let attempt = 1; attempt <= 2 && !v; attempt++) {
    try {
      const r = await orCall(MODELS.AUDITOR, '', await withImage(q, judgeAnyPrompt(q, courseName, profile)), { maxTokens: 4000, temperature: attempt === 1 ? 0.1 : 0 });
      const j = JSON.parse(r.content.match(/\{[\s\S]*\}/)?.[0] ?? 'null');
      if (j?.correct_answer) v = { correct_answer: String(j.correct_answer), verdict: String(j.verdict ?? ''), rationale: String(j.rationale ?? ''), basis: Array.isArray(j.basis) ? j.basis.map(String) : [], edits: Array.isArray(j.edits) ? j.edits.map(String) : [] };
    } catch (e) { console.warn(`  [Adjudicate] judge attempt ${attempt} failed: ${e instanceof Error ? e.message : e}`); }
  }
  if (!v) { report.failed++; log(`  [Adjudicate] Q${q.question_number}: no verdict`); return; }
  report.adjudicated++;
  const change = v.verdict === 'change_key';
  let after: Row = q;
  let error: string | undefined;
  if (change || v.edits.length) {
    const ask = `ANSWER KEY ADJUDICATION: The correct answer is ${v.correct_answer}${change ? ' — make the stored answer key say exactly this' : ' (the current key)'}. ${v.rationale} Basis: ${v.basis.join('; ')}. Make these edits so it is the only defensible answer, and state the reason and basis in the explanation or rationales: ${v.edits.join(' ') || 'none beyond the key.'}`;
    const fix = await fixQuestion(q, [ask], courseName, { existingBank: mode.existingBank, restructure: mode.restructure, updateAnswer: change });
    if (fix.fixed && fix.question) after = { ...q, ...fix.question };
    else error = fix.error || 'no usable repair';
  }
  const snapshot = (x: Row) => ({ question: x.question, content: x.content, explanation: x.explanation });
  const trail = Array.isArray(q.audit_trail) ? [...q.audit_trail] : [];
  trail.push({
    phase: error ? 'key_adjudication_failed' : 'key_adjudication', trigger: ['audit failed the key or one-best-answer check'],
    verdict: v.verdict, correct_answer: v.correct_answer, rationale: v.rationale, basis: v.basis, edits: v.edits,
    ...(after !== q ? { changes_requested: [`ANSWER KEY ADJUDICATION: ${v.correct_answer}`], before: snapshot(q), after: snapshot(after), changed_fields: changedFields(snapshot(q), snapshot(after)) } : {}),
    ...(error ? { error } : {}), timestamp: new Date().toISOString(),
  });
  const { error: upErr } = await supabase.from('qb_questions').update({ ...(after !== q ? savedFields(after) : {}), audit_trail: trail }).eq('id', q.id);
  if (upErr) { report.failed++; log(`  [Adjudicate] Q${q.question_number}: write failed ${upErr.message}`); return; }
  if (error) report.failed++;
  if (after !== q) report.edited++;
  if (change && !error) report.keyChanged++;
  log(`  [Adjudicate] Q${q.question_number} (${String(q.format_type ?? q.tags?.format_type ?? '')}): ${error ? 'FAILED' : change ? 'key changed' : 'key upheld'} → ${v.correct_answer.slice(0, 70)}${v.edits.length ? ` (${v.edits.length} edits)` : ''}${error ? ` — ${error}` : ''}`);
}

/** Whether two option texts name the same answer: overlap first, the model only when overlap is low. */
async function same(stem: string, a: string, b: string): Promise<boolean> {
  return optionIdentity(a, b) >= OPTION_IDENTITY_MIN || sameAnswer(stem, a, b);
}

export interface AdjudicationReport { candidates: number; adjudicated: number; keyChanged: number; edited: number; failed: number }

/**
 * `only`: adjudicate exactly these question ids, at whatever status, whether or not their key changed —
 * for flagged items whose final audit failed KEY_CORRECT or ONE_BEST_ANSWER (reworkFlagged.ts).
 */
export async function adjudicateJobKeys(jobId: string, courseName: string, log: (s: string) => void = console.log, only?: Set<string>): Promise<AdjudicationReport> {
  const rows = (await fetchAllRows<Row>((from, to) => {
    let qb = supabase.from('qb_questions').select('*').eq('job_id', jobId).is('replaced_by_id', null);
    if (!only) qb = qb.eq('status', 'reviewed');
    return qb.order('question_number').range(from, to);
  })).filter((q) => !only || only.has(q.id));
  const report: AdjudicationReport = { candidates: 0, adjudicated: 0, keyChanged: 0, edited: 0, failed: 0 };
  const { data: jobRow } = await supabase.from('qb_jobs').select('config').eq('id', jobId).single();
  const mode = reviewModeOf(jobRow?.config as Row);

  // In parallel under LLM_CONCURRENCY, as repairAfterAudit is: one at a time, each item's judge, fix and
  // answer checks kept one call in flight, and a NEET PG pilot adjudicated 6 items an hour with lanes idle.
  const work = async (q: Row): Promise<void> => {
    if ((q.tags as Row | null)?.belongs_to_exam) return;
    const cur = keyOf(q);
    // Any other answer format — select-all, ordered response, grid, cloze, or a set of sub-questions —
    // is adjudicated the same way when asked for by id (a failed key or one-best-answer check after audit).
    if (!cur) { if (only) await adjudicateOtherFormat(q, courseName, mode, report, log); return; }
    const original = originalOf(q);
    const origKey = original ? keyOf(original) : null;
    const blind = blindDisagreements(q);
    const changed = Boolean(origKey) && !(await same(String(q.question ?? ''), origKey!, cur));
    if (!only && !changed && !blind.length) return;
    report.candidates++;

    const v = await judge(q, original, blind, courseName, mode.restructure);
    if (!v) { report.failed++; log(`  [Adjudicate] Q${q.question_number}: no verdict`); return; }
    report.adjudicated++;
    const keyStays = await same(String(q.question ?? ''), cur, v.correct_answer);

    // The image disagrees with the key: replace the image first, with one that shows what the current key
    // needs. Only when no replacement passes its blind check does the answer change to fit the image.
    if (!keyStays && v.image_decides && q.image_url) {
      const redrawn = await regenerateQuestionImage(String(q.id), jobId, [`The image must clearly show the findings that make "${cur}" the correct answer, as the question asks. Read without the question, the current image was taken to support "${v.correct_answer}" instead: ${v.rationale}`]).catch(() => false);
      if (redrawn) {
        const { data: fresh } = await supabase.from('qb_questions').select('audit_trail').eq('id', q.id).single();
        const t = Array.isArray(fresh?.audit_trail) ? [...fresh.audit_trail] : [];
        t.push({ phase: 'key_adjudication', verdict: 'image_replaced', kept_key: cur, judged_from_old_image: v.correct_answer, rationale: v.rationale, timestamp: new Date().toISOString() });
        await supabase.from('qb_questions').update({ audit_trail: t }).eq('id', q.id);
        report.adjudicated++; report.edited++;
        log(`  [Adjudicate] Q${q.question_number}: image replaced to fit the key "${cur.slice(0, 60)}" (the old image pointed to "${v.correct_answer.slice(0, 40)}")`);
        return;
      }
    }

    let after: Row = q;
    let error: string | undefined;
    if (!keyStays || v.edits.length) {
      const ask = `ANSWER KEY ADJUDICATION: The correct answer is "${v.correct_answer}"${keyStays ? ' (the current key)' : ' — make it the keyed option'}. ${v.rationale} Basis: ${v.basis.join('; ')}. Make these edits so it is the only defensible answer, and state the reason and basis in the explanation: ${v.edits.join(' ') || 'none beyond the key.'}`;
      const askFull = !keyStays && v.image_decides ? `${ask} No replacement image fitted the current key, so make the SMALLEST change that fits the image, and do NOT write into the stem the finding the image shows — the candidate must still read the image.` : ask;
      // A key ruled wrong or outdated changes the answer by design: the concept guard then holds only the
      // clinical problem and the kind of task (conceptGuard.ts 'update').
      const fix = await fixQuestion(q, [askFull], courseName, { existingBank: mode.existingBank, restructure: mode.restructure, updateAnswer: !keyStays });
      if (fix.fixed && fix.question && keyOf(fix.question) && (await same(String(fix.question.question ?? ''), keyOf(fix.question)!, v.correct_answer))) {
        after = { ...q, ...fix.question, image_url: fix.imageRemoved ? null : q.image_url, is_image_question: fix.imageRemoved ? false : q.is_image_question };
      } else {
        error = fix.error || 'the repaired item does not key the adjudicated answer';
      }
    }

    const snapshot = (x: Row) => ({ question: x.question, options: x.options, correct_option: x.correct_option, explanation: x.explanation });
    const trail = Array.isArray(q.audit_trail) ? [...q.audit_trail] : [];
    trail.push({
      phase: error ? 'key_adjudication_failed' : 'key_adjudication',
      trigger: [changed ? `keyed answer changed from "${origKey}"` : null, blind.length ? 'blind solve disagreed' : null].filter(Boolean),
      verdict: v.verdict, correct_answer: v.correct_answer, rationale: v.rationale, basis: v.basis, edits: v.edits,
      ...(after !== q ? { changes_requested: [`ANSWER KEY ADJUDICATION: ${v.correct_answer}`], before: snapshot(q), after: snapshot(after), changed_fields: changedFields(snapshot(q), snapshot(after)) } : {}),
      ...(error ? { error } : {}),
      timestamp: new Date().toISOString(),
    });
    const { error: upErr } = await supabase.from('qb_questions').update({
      ...(after !== q ? { ...savedFields(after), image_url: after.image_url ?? null, is_image_question: Boolean(after.is_image_question) } : {}),
      audit_trail: trail,
    }).eq('id', q.id);
    if (upErr) { report.failed++; log(`  [Adjudicate] Q${q.question_number}: write failed ${upErr.message}`); return; }

    if (error) report.failed++;
    if (after !== q) report.edited++;
    if (!keyStays && !error) report.keyChanged++;
    log(`  [Adjudicate] Q${q.question_number}: ${error ? 'FAILED' : keyStays ? 'key upheld' : 'key changed'} → "${v.correct_answer.slice(0, 70)}"${v.edits.length ? ` (${v.edits.length} edits)` : ''}${error ? ` — ${error}` : ''}`);
  };
  const queue = [...rows];
  const lanes = Math.max(1, Number(process.env.LLM_CONCURRENCY) || 8);
  await Promise.all(Array.from({ length: lanes }, async () => { for (let q = queue.shift(); q; q = queue.shift()) await work(q); }));
  return report;
}

/**
 * Last length check before audit. A later stage (the adversarial fixer, an adjudication) can leave the
 * keyed option the longest again after the validator's repair settled it; in the fourth pilot one key
 * was 96 characters against 93 at audit and the item was flagged. Each such item gets one more
 * measured repair (fixQuestion's length rounds), recorded on the trail as a cue_fix that audit verifies.
 */
export async function sweepLengthCues(jobId: string, courseName: string, log: (s: string) => void = console.log): Promise<{ found: number; fixed: number }> {
  const rows = await fetchAllRows<Row>((from, to) => supabase.from('qb_questions').select('*')
    .eq('job_id', jobId).eq('status', 'reviewed').is('replaced_by_id', null).order('question_number').range(from, to));
  const out = { found: 0, fixed: 0 };
  for (const q of rows) {
    if ((q.tags as Row | null)?.belongs_to_exam || !keyLengthCue(q)) continue;
    out.found++;
    const asks = cueIssues(q).filter((c) => /^FORMAT: The keyed option/.test(c));
    const fix = await fixQuestion(q, asks, courseName, { existingBank: true, restructure: true });
    if (!fix.fixed || !fix.question || keyLengthCue(fix.question)) { log(`  [CueSweep] Q${q.question_number}: still the longest (${fix.error ?? 'not resolved'})`); continue; }
    const snap = (x: Row) => ({ question: x.question, options: x.options, correct_option: x.correct_option, explanation: x.explanation });
    const trail = Array.isArray(q.audit_trail) ? [...q.audit_trail] : [];
    trail.push({ phase: 'cue_fix', changes_requested: asks, before: snap(q), after: snap(fix.question), changed_fields: changedFields(snap(q), snap(fix.question)), timestamp: new Date().toISOString() });
    const { error } = await supabase.from('qb_questions').update({ ...savedFields(fix.question), audit_trail: trail }).eq('id', q.id);
    if (error) { log(`  [CueSweep] Q${q.question_number}: write failed ${error.message}`); continue; }
    out.fixed++;
    log(`  [CueSweep] Q${q.question_number}: key no longer the longest`);
  }
  return out;
}

/**
 * One fix pass after audit, aimed at exactly what audit found: each flagged item's failed checks
 * (reviewChecklist.ts), its remaining length or option-form cues, and any distractor or key the
 * options-only probe still catches. The repaired items go back to 'reviewed' for a second audit,
 * whose verdict is final. Audit used to be the last word, so whatever it found was never repaired;
 * in the fifth pilot that was five of seven flags. Items tagged for another exam are not repaired.
 */
//
// Approved items with a STANDARD gap get the same pass, so the style checks raise quality rather than
// only being listed: the seventh pilot approved 58 of 60 but lost the blind quality comparison with the
// fourth 14-34, on parallel options and explanations. If the final audit then fails such an item on a
// MUST check, revertRegressions() restores its approved version, so a style repair cannot cost an approval.
// `only` restricts the pass to those question ids (a second round on items still flagged; reworkFlagged.ts),
// where an image that is still inconsistent after one repair is removed rather than re-aligned.
export async function repairAfterAudit(jobId: string, courseName: string, log: (s: string) => void = console.log, only?: Set<string>): Promise<{ flagged: number; polished: number; repaired: number; failed: number }> {
  const rows = (await fetchAllRows<Row>((from, to) => supabase.from('qb_questions').select('*')
    .eq('job_id', jobId).in('status', ['flagged', 'approved']).is('replaced_by_id', null).order('question_number').range(from, to)))
    .filter((q) => !only || only.has(q.id));
  const out = { flagged: 0, polished: 0, repaired: 0, failed: 0 };
  // Generated jobs get the same pass; their single-best-answer items get the cue and probe asks at the
  // exam's own option count, with the probe worded for the exam.
  const { data: jobRow } = await supabase.from('qb_jobs').select('config').eq('id', jobId).single();
  const mode = reviewModeOf(jobRow?.config as Row);
  const profile = mode.restructure ? null : await profileForJob(jobId);
  // In parallel, under the same LLM_CONCURRENCY as review and audit: one at a time, the fix pass
  // took about 35 minutes for 19 of 50 Step 1 items in the 150-question batch.
  const work = async (q: Row): Promise<void> => {
    if ((q.tags as Row | null)?.belongs_to_exam) return;
    const trail = Array.isArray(q.audit_trail) ? [...q.audit_trail] : [];
    const audit = [...trail].reverse().find((e: Row) => e?.phase === 'audit');
    const checks = parseChecks(audit);
    const wasApproved = q.status === 'approved';
    // An approved generated item is also polished when a deterministic cue is still present (the key the
    // longest option, standalone or in a sub-question): the checklist judge often passes a key that is
    // longest by a few characters, and it went out that way.
    const cueLeft = !mode.restructure && (keyLengthCue(q) !== null || subLengthCues(q).length > 0);
    if (wasApproved && !(checks || []).some((c) => c.result === 'fail') && !cueLeft) return;
    if (wasApproved) out.polished++; else out.flagged++;
    const single = mode.restructure || isSingleBest(q);
    const [probe] = single ? await probeCues([q], mode.restructure ? undefined : courseName) : [null];
    // An answer adjudication after this audit has settled KEY_CORRECT and ONE_BEST_ANSWER.
    const auditAt = trail.lastIndexOf(audit as Row);
    const adjudicated = trail.slice(auditAt + 1).some((e: Row) => e?.phase === 'key_adjudication');
    let asks = [
      ...(checks ? checkChanges(checks.filter((c) => !(adjudicated && (c.id === 'KEY_CORRECT' || c.id === 'ONE_BEST_ANSWER'))), Boolean(q.image_url)) : ((audit?.issues || []) as string[])),
      ...(single ? [...cueIssues(q, mode.restructure ? 5 : profile?.optionCount ?? null), ...probeIssues(q, probe)] : []),
      ...(!mode.restructure ? subQuestionCueIssues(q, profile?.optionCount ?? null) : []),
      // Audit's own gates that the checklist does not carry: a changed concept, a bow-tie stem naming the keyed actions.
      ...((audit?.issues || []) as string[]).filter((x) => /^NOT COMPLIANT — SAME_CONCEPT/.test(x)).map((x) => `[SAME_CONCEPT] ${x.replace(/^NOT COMPLIANT — SAME_CONCEPT: /, '')}`),
      ...(bowTieStemCue(q) ? [bowTieStemCue(q)!] : []),
    ];
    if (only) asks = asks.map((a) => a.replace(/^IMAGE CONFLICT: /, 'IMAGE REMOVE: '));
    // A request about the picture itself goes to image generation, as in review (reviewPipeline.ts): the
    // text fixer cannot redraw an image. The new image is kept only if its blind read supports the key
    // (imageGeneration.ts); either way the item goes back to audit with the image it now has.
    const routed = routeChanges(asks, [], false, Boolean(q.image_url));
    if (routed.image.length && !only) {
      const redrawn = await regenerateQuestionImage(String(q.id), jobId, routed.image).catch(() => false);
      log(`  [AuditFix] Q${q.question_number}: image ${redrawn ? 'replaced' : 'kept (no replacement passed its blind check)'}`);
      if (redrawn) {
        const { data: fresh } = await supabase.from('qb_questions').select('*').eq('id', q.id).single();
        if (fresh) Object.assign(q, fresh);
        trail.splice(0, trail.length, ...((q.audit_trail as Row[]) || []));
        trail.push({ phase: 'audit_image_fix', feedback: routed.image, after_image: q.image_url, timestamp: new Date().toISOString() });
      }
      asks = [...routed.fix, ...routed.heldForImage];
      // No replacement fitted: fall back to the smallest change that fits the image the item has.
      const conflicts = routed.image.filter(isImageConflict);
      if (!redrawn && conflicts.length && await alignWithImage(jobId, String(q.id), conflicts, courseName, log)) {
        const { data: fresh } = await supabase.from('qb_questions').select('*').eq('id', q.id).single();
        if (fresh) Object.assign(q, fresh);
        trail.splice(0, trail.length, ...((q.audit_trail as Row[]) || []));
        if (!asks.length) { await supabase.from('qb_questions').update({ status: 'reviewed' }).eq('id', q.id); out.repaired++; return; }
      }
      if (!asks.length) {
        if (redrawn) { await supabase.from('qb_questions').update({ status: 'reviewed', audit_trail: trail }).eq('id', q.id); out.repaired++; }
        else out.failed++;
        return;
      }
    }
    if (!asks.length) {
      // Adjudication after this audit settled everything that failed: the item goes back to audit as
      // it now stands rather than staying flagged on a verdict about its earlier text.
      if (adjudicated && !wasApproved) {
        await supabase.from('qb_questions').update({ status: 'reviewed' }).eq('id', q.id);
        out.repaired++;
        log(`  [AuditFix] Q${q.question_number}: adjudicated, back to audit`);
      }
      return;
    }
    const fix = await fixQuestion(q, asks, courseName, { existingBank: mode.existingBank, restructure: mode.restructure });
    const snap = (x: Row) => ({ question: x.question, options: x.options, correct_option: x.correct_option, explanation: x.explanation });
    if (!fix.fixed || !fix.question) {
      out.failed++;
      if (wasApproved) return;
      trail.push({ phase: 'audit_fix_failed', changes_requested: asks, error: fix.error || 'no usable question', timestamp: new Date().toISOString() });
      await supabase.from('qb_questions').update({ audit_trail: trail }).eq('id', q.id);
      log(`  [AuditFix] Q${q.question_number}: fix failed (${fix.error ?? 'no question'})`);
      return;
    }
    trail.push({
      phase: 'audit_fix', changes_requested: asks, changes_applied: fix.changesApplied || [],
      before: snap(q), after: snap(fix.question), changed_fields: changedFields(snap(q), snap(fix.question)),
      ...(wasApproved ? { was_approved: true, restore: { ...savedFields(q), image_url: q.image_url ?? null, is_image_question: Boolean(q.is_image_question), quality_score: q.quality_score } } : {}),
      ...(fix.imageRemoved ? { image_removed: q.image_url ?? true } : {}),
      timestamp: new Date().toISOString(),
    });
    const { error } = await supabase.from('qb_questions').update({
      ...savedFields(fix.question),
      ...(fix.imageRemoved ? { image_url: null, is_image_question: false } : {}),
      status: 'reviewed', audit_trail: trail,
    }).eq('id', q.id);
    if (error) { out.failed++; log(`  [AuditFix] Q${q.question_number}: write failed ${error.message}`); return; }
    out.repaired++;
    log(`  [AuditFix] Q${q.question_number}: ${asks.length} finding(s) ${wasApproved ? 'polished' : 'repaired'}, back to audit`);
  
  };
  const queue = [...rows];
  const lanes = Math.max(1, Number(process.env.LLM_CONCURRENCY) || 8);
  await Promise.all(Array.from({ length: lanes }, async () => { for (let q = queue.shift(); q; q = queue.shift()) await work(q); }));
  return out;
}

/** After the final audit: an item that was approved before its style repair and is now flagged gets its approved version back. */
export async function revertRegressions(jobId: string, log: (s: string) => void = console.log): Promise<number> {
  const rows = await fetchAllRows<Row>((from, to) => supabase.from('qb_questions').select('id, question_number, audit_trail')
    .eq('job_id', jobId).eq('status', 'flagged').is('replaced_by_id', null).range(from, to));
  let n = 0;
  for (const q of rows) {
    const trail = Array.isArray(q.audit_trail) ? [...q.audit_trail] : [];
    const fix = [...trail].reverse().find((e: Row) => e?.phase === 'audit_fix');
    if (!fix?.was_approved || !fix.restore) continue;
    trail.push({ phase: 'audit_fix_reverted', reason: 'the style repair failed a required check at final audit; the approved version is restored', timestamp: new Date().toISOString() });
    const { error } = await supabase.from('qb_questions').update({ ...fix.restore, status: 'approved', audit_trail: trail }).eq('id', q.id);
    if (error) { log(`  [AuditFix] Q${q.question_number}: revert failed ${error.message}`); continue; }
    n++;
    log(`  [AuditFix] Q${q.question_number}: style repair reverted, approved version kept`);
  }
  return n;
}

/**
 * Do no harm. For each approved item of a restructure job whose imported original was already sound —
 * the first review failed none of its MUST checks — a blind pairwise comparison runs in both orders, and
 * if both prefer the original it is restored (with its image). 12 of the 14 originals the judge preferred
 * in the pre-2025 sample had passed every required check before the pipeline rewrote them. The original
 * is kept only if it still meets the hard format rules (five options, key not the longest).
 */
export async function keepBetterOriginals(jobId: string, log: (s: string) => void = console.log): Promise<number> {
  const MUST = new Set(['KEY_CORRECT', 'ONE_BEST_ANSWER', 'FACTS_ACCURATE', 'IMAGE_CONSISTENT', 'DISTRACTORS_PLAUSIBLE', 'NO_ANSWER_CUE']);
  const rows = await fetchAllRows<Row>((from, to) => supabase.from('qb_questions').select('*')
    .eq('job_id', jobId).eq('status', 'approved').is('replaced_by_id', null).range(from, to));
  let kept = 0;
  const queue = [...rows];
  const lanes = Math.max(1, Number(process.env.LLM_CONCURRENCY) || 8);
  await Promise.all(Array.from({ length: lanes }, async () => {
    for (let q = queue.shift(); q; q = queue.shift()) {
      const trail = Array.isArray(q.audit_trail) ? [...q.audit_trail] : [];
      const firstReview = trail.find((e: Row) => e?.phase === 'validator');
      const sound = Array.isArray(firstReview?.checks) && !firstReview.checks.some((c: Row) => c.result === 'fail' && MUST.has(String(c.id)));
      const original = originalOf(q);
      if (!sound || !original) continue;
      const orig: Row = { ...original, content: original.content ?? q.content };
      if (optionTexts(orig).texts.length !== 5 || keyLengthCue(orig)) continue;
      const v = await preferOriginal(orig, q);
      if (!v.original) continue;
      const removed = trail.find((e: Row) => typeof e?.image_removed === 'string')?.image_removed as string | undefined;
      trail.push({ phase: 'kept_original', reason: `the original was sound and a blind comparison preferred it in both orders: ${v.reason}`.slice(0, 400), replaced_revision: savedFields(q), timestamp: new Date().toISOString() });
      const { error } = await supabase.from('qb_questions').update({
        question: orig.question, options: orig.options, correct_option: orig.correct_option, explanation: orig.explanation,
        ...(original.content ? { content: original.content } : {}),
        ...(removed ? { image_url: removed, is_image_question: true } : {}),
        audit_trail: trail,
      }).eq('id', q.id);
      if (error) { log(`  [KeepOriginal] Q${q.question_number}: write failed ${error.message}`); continue; }
      kept++;
      log(`  [KeepOriginal] Q${q.question_number}: original restored — ${v.reason.slice(0, 120)}`);
    }
  }));
  return kept;
}

/** Flagged items whose last audit failed the key or one-best-answer check, or was blocked for a changed concept. */
export async function keyDoubtIds(jobId: string): Promise<Set<string>> {
  const rows = await fetchAllRows<Row>((from, to) => supabase.from('qb_questions').select('id, tags, audit_trail')
    .eq('job_id', jobId).eq('status', 'flagged').is('replaced_by_id', null).range(from, to));
  return new Set(rows.filter((q) => {
    if ((q.tags as Row | null)?.belongs_to_exam) return false;
    const audit = [...((q.audit_trail || []) as Row[])].reverse().find((e) => e?.phase === 'audit');
    return ((audit?.checks || []) as Row[]).some((x) => x.result === 'fail' && (x.id === 'KEY_CORRECT' || x.id === 'ONE_BEST_ANSWER'))
      || ((audit?.issues || []) as string[]).some((x) => /SAME_CONCEPT/.test(x));
  }).map((q) => q.id as string));
}

async function waitAudit(jobId: string) {
  for (;;) {
    const { data } = await supabase.from('qb_jobs').select('status').eq('id', jobId).single();
    if (data?.status !== 'auditing') return data?.status as string;
    await new Promise((r) => setTimeout(r, 15000));
  }
}

/**
 * Everything after the first audit, for any checklist job (reviewMode.checklist): one fix pass on what
 * audit found, a final audit of the repaired items, reverting style repairs that broke a MUST check,
 * and for restructure jobs keeping a sound original the revision did not improve. Used by
 * runImportedJobs, runGeneratedJob and the app's orchestrator, so all three finish a job the same way.
 */
export async function postAuditPasses(jobId: string, log: (s: string) => void = console.log): Promise<void> {
  const { data: job } = await supabase.from('qb_jobs').select('course_id, config, status').eq('id', jobId).single();
  const mode = reviewModeOf(job?.config as Row);
  if (!mode.checklist || job?.status !== 'complete') return;
  const { data: c } = await supabase.from('qb_courses').select('name').eq('id', job!.course_id).single();
  const course = String(c?.name ?? 'Course');
  // Answer adjudication for every checklist job, not only imported ones: an item the first audit failed
  // on KEY_CORRECT or ONE_BEST_ANSWER, or blocked for a changed concept, goes to the judge, which
  // decides the answer under the course's own authority (examProfile.ts) and may update an outdated
  // key. A generated NCLEX or CPA item with a disputed key used to get only a free-form fix request.
  // repairAfterAudit then repairs the remaining checks and leaves the adjudicated ones alone.
  const doubt = await keyDoubtIds(jobId);
  if (doubt.size) {
    const a = await adjudicateJobKeys(jobId, course, log, doubt);
    log(`  answer adjudication after audit: ${JSON.stringify(a)}`);
  }
  const r = await repairAfterAudit(jobId, course, log);
  log(`  post-audit repair: ${JSON.stringify(r)}`);
  const { count } = await supabase.from('qb_questions').select('*', { count: 'exact', head: true }).eq('job_id', jobId).eq('status', 'reviewed').is('replaced_by_id', null);
  if (count) {
    await supabase.from('qb_jobs').update({ status: 'auditing' }).eq('id', jobId);
    await auditBatchForJob(jobId);
    await waitAudit(jobId);
    const reverted = await revertRegressions(jobId, log);
    log(`  style repairs reverted: ${reverted}`);
  }
  if (mode.restructure) {
    const kept = await keepBetterOriginals(jobId, log);
    log(`  originals kept over their revision: ${kept}`);
  }
}
