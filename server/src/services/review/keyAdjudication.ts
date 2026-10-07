/**
 * Answer adjudication: settle every real change of the keyed answer before audit, instead of leaving
 * it for a clinician.
 *
 * Restructure mode lets review change which answer is keyed. Until now the export only labelled such
 * items "needs clinician review" — in the third pilot one of them (placenta previa) had flipped
 * between crossmatch and immediate cesarean across runs, because the stem had been rewritten to fit
 * whichever answer a reviewer preferred. Here a judge decides the correct answer for the stem as it
 * stands, under current US practice, names its basis, and lists the edits that leave exactly one
 * defensible answer; the fixer applies them (with its drift, five-option and length checks); audit
 * then scores the result like any other repair.
 *
 * An item is adjudicated when:
 *   - its keyed answer is a different answer from the imported original (word overlap below the
 *     identity threshold AND sameAnswer() says different — rewordings are not adjudicated), or
 *   - an independent blind solve in adversarial review chose a different answer from the key.
 *
 * Restructure jobs only, run by runImportedJobs between review and audit.
 */
import { supabase } from '../../db/supabase.js';
import { fetchAllRows } from '../../db/pagination.js';
import { orCall, MODELS } from '../llm/openrouter.js';
import { fixQuestion, sameAnswer, optionIdentity, OPTION_IDENTITY_MIN } from './fixer.js';
import { optionTexts, keyLengthCue, cueIssues } from './reviewMode.js';
import { changedFields } from '../audit/fixHistory.js';

type Row = Record<string, any>;

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

interface Verdict { correct_answer: string; verdict: string; rationale: string; basis: string[]; edits: string[] }

const LETTERS = 'ABCDEFGHIJ';

function judgePrompt(q: Row, original: Row | null, blind: string[], courseName: string): string {
  const { texts, key } = optionTexts(q);
  const origKey = original ? keyOf(original) : null;
  return `You are the final medical authority for a ${courseName} question bank. No clinician will review this item after you: decide the correct answer yourself, from current US practice and the major US guidelines (ACOG, ACC/AHA, IDSA, ADA, USPSTF, AAP, ATS, CDC and the like), and make the item support exactly one best answer.

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
1. For the CURRENT stem, which option is the single best answer under current US practice? If none is correct, give the correct answer as a new option text.
2. Does the stem support exactly one best answer? Find every fact or omission that would let a well-prepared candidate defend a different option (a missing finding, an unstated diagnosis, a sentence that invites another step, vital signs that point both ways).
3. If review rewrote the stem to fit a new answer, was that justified? Prefer the version that tests the item's original concept soundly; where the original scenario and key were right, the edits may restore them.
4. List the specific edits (to stem, options or explanation) that leave exactly one defensible answer and an explanation that states the reason, naming the guideline basis. Keep five options; the keyed option must not be the longest. Empty list if the item is already sound.

Return ONLY a JSON object:
{"correct_answer": "<exact option text, or new option text>", "verdict": "current_key_correct" | "change_key", "rationale": "<2-4 sentences: why this is the best answer and why the main alternative is not>", "basis": ["<guideline or source: the specific recommendation>"], "edits": ["<specific edit>"]}`;
}

async function judge(q: Row, original: Row | null, blind: string[], courseName: string): Promise<Verdict | null> {
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const r = await orCall(MODELS.AUDITOR, '', judgePrompt(q, original, blind, courseName), { maxTokens: 4000, temperature: attempt === 1 ? 0.1 : 0 });
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
      };
    } catch (e) {
      console.warn(`  [Adjudicate] judge attempt ${attempt} failed: ${e instanceof Error ? e.message : e}`);
    }
  }
  return null;
}

/** Whether two option texts name the same answer: overlap first, the model only when overlap is low. */
async function same(stem: string, a: string, b: string): Promise<boolean> {
  return optionIdentity(a, b) >= OPTION_IDENTITY_MIN || sameAnswer(stem, a, b);
}

export interface AdjudicationReport { candidates: number; adjudicated: number; keyChanged: number; edited: number; failed: number }

export async function adjudicateJobKeys(jobId: string, courseName: string, log: (s: string) => void = console.log): Promise<AdjudicationReport> {
  const rows = await fetchAllRows<Row>((from, to) => supabase.from('qb_questions').select('*')
    .eq('job_id', jobId).eq('status', 'reviewed').is('replaced_by_id', null).order('question_number').range(from, to));
  const report: AdjudicationReport = { candidates: 0, adjudicated: 0, keyChanged: 0, edited: 0, failed: 0 };

  for (const q of rows) {
    if ((q.tags as Row | null)?.belongs_to_exam) continue;
    const cur = keyOf(q);
    if (!cur) continue;
    const original = originalOf(q);
    const origKey = original ? keyOf(original) : null;
    const blind = blindDisagreements(q);
    const changed = Boolean(origKey) && !(await same(String(q.question ?? ''), origKey!, cur));
    if (!changed && !blind.length) continue;
    report.candidates++;

    const v = await judge(q, original, blind, courseName);
    if (!v) { report.failed++; log(`  [Adjudicate] Q${q.question_number}: no verdict`); continue; }
    report.adjudicated++;
    const keyStays = await same(String(q.question ?? ''), cur, v.correct_answer);

    let after: Row = q;
    let error: string | undefined;
    if (!keyStays || v.edits.length) {
      const ask = `ANSWER KEY ADJUDICATION: The correct answer is "${v.correct_answer}"${keyStays ? ' (the current key)' : ' — make it the keyed option'}. ${v.rationale} Basis: ${v.basis.join('; ')}. Make these edits so it is the only defensible answer, and state the reason and basis in the explanation: ${v.edits.join(' ') || 'none beyond the key.'}`;
      const fix = await fixQuestion(q, [ask], courseName, { existingBank: true, restructure: true });
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
      ...(after !== q ? { question: after.question, options: after.options, correct_option: after.correct_option, explanation: after.explanation, image_url: after.image_url ?? null, is_image_question: Boolean(after.is_image_question) } : {}),
      audit_trail: trail,
    }).eq('id', q.id);
    if (upErr) { report.failed++; log(`  [Adjudicate] Q${q.question_number}: write failed ${upErr.message}`); continue; }

    if (error) report.failed++;
    if (after !== q) report.edited++;
    if (!keyStays && !error) report.keyChanged++;
    log(`  [Adjudicate] Q${q.question_number}: ${error ? 'FAILED' : keyStays ? 'key upheld' : 'key changed'} → "${v.correct_answer.slice(0, 70)}"${v.edits.length ? ` (${v.edits.length} edits)` : ''}${error ? ` — ${error}` : ''}`);
  }
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
    const { error } = await supabase.from('qb_questions').update({ question: fix.question.question, options: fix.question.options, correct_option: fix.question.correct_option, explanation: fix.question.explanation, audit_trail: trail }).eq('id', q.id);
    if (error) { log(`  [CueSweep] Q${q.question_number}: write failed ${error.message}`); continue; }
    out.fixed++;
    log(`  [CueSweep] Q${q.question_number}: key no longer the longest`);
  }
  return out;
}
