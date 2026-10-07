/**
 * Audit Pipeline — V2 Step 4
 *
 * Single-pass scoring (MODELS.AUDITOR) of reviewed questions.
 * Score >= 7 → approved, < 7 → flagged.
 * The three stage scores are kept separately: each describes the version of the question
 * that stage actually saw, and averaging them mixes pre- and post-repair states.
 */

import { supabase } from '../../db/supabase.js';
import { fetchAllRows } from '../../db/pagination.js';
import { bankMixForJob } from '../generation/bankMix.js';
import { fixHistoryBlock, unappliedChanges } from './fixHistory.js';
import { coherenceIssues, partitionIssues } from '../generation/coherence.js';
import { orCall, MODELS } from '../llm/openrouter.js';
import type { ContentPart } from '../llm/openrouter.js';
import { formatQuestionsForReviewWithImages, extractJsonArray, gradabilityIssues } from '../review/shared.js';
import { saveJobSnapshots } from '../snapshots.js';
import { startTracking, getStepTokens } from '../llm/tokenTracker.js';

const AUDIT_BATCH_SIZE = 10;
const MAX_CONCURRENT_BATCHES = 8;

// ── In-memory state ──

interface SubjectStatus {
  subject: string;
  count: number;
  audited: number;
  approved: number;
  flagged: number;
  status: 'pending' | 'auditing' | 'done';
}

interface AuditState {
  status: 'running' | 'complete' | 'failed';
  step: string;
  audited: number;
  approved: number;
  flagged: number;
  total: number;
  batchesTotal: number;
  batchesDone: number;
  events: string[];
  subjects: SubjectStatus[];
}

const runningAudits = new Map<string, AuditState>();

function setStep(jobId: string, step: string) {
  const s = runningAudits.get(jobId);
  if (s) {
    s.step = step;
    s.events.push(step);
    if (s.events.length > 30) s.events = s.events.slice(-30);
  }
}

function setState(jobId: string, updates: Partial<AuditState>) {
  const s = runningAudits.get(jobId);
  if (s) Object.assign(s, updates);
}

// ── Helpers ──

function chunk<T>(arr: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < arr.length; i += size) chunks.push(arr.slice(i, i + size));
  return chunks;
}

async function runWithConcurrency<T>(tasks: (() => Promise<T>)[], max: number): Promise<T[]> {
  const results: T[] = new Array(tasks.length);
  let active = 0;
  let idx = 0;
  let completed = 0;
  return new Promise((resolve, reject) => {
    function next() {
      if (completed === tasks.length) { resolve(results); return; }
      while (active < max && idx < tasks.length) {
        const i = idx++;
        active++;
        tasks[i]()
          .then((r) => { results[i] = r; completed++; })
          .catch(reject)
          .finally(() => { active--; next(); });
      }
    }
    if (tasks.length === 0) resolve([]);
    else next();
  });
}

function buildSubjectMap(questions: Record<string, unknown>[]): SubjectStatus[] {
  const map = new Map<string, number>();
  for (const q of questions) {
    const subj = (q.subject as string) || 'Unknown';
    map.set(subj, (map.get(subj) || 0) + 1);
  }
  return Array.from(map.entries()).map(([subject, count]) => ({
    subject, count, audited: 0, approved: 0, flagged: 0, status: 'pending' as const,
  }));
}

async function pushProgress(jobId: string) {
  const s = runningAudits.get(jobId);
  if (!s) return;
  await supabase.from('qb_jobs').update({
    status: 'auditing',
    progress: {
      step: s.step,
      audited: s.audited,
      approved: s.approved,
      flagged: s.flagged,
      total: s.total,
      batches_total: s.batchesTotal,
      batches_done: s.batchesDone,
      events: s.events.slice(-10),
      subjects: s.subjects,
    },
  }).eq('id', jobId);
}

// ── Audit prompt ──

function getAuditPrompt(hasRepairs: boolean, existingBank = false): string {
  // Items imported from a live bank are judged on what a candidate reads. GPT 6.1 Sol docked them
  // for difficulty/Bloom labels and for stored fields (format_type, is_image_question) that are not
  // part of the item, scoring 6 and flagging sound questions the Sonnet auditor approved.
  const scope = existingBank ? `

These questions are already in use in a live question bank. Score what a candidate reads: the stem,
options, keyed answer, explanation and image. Difficulty and Bloom labels and stored fields such as
format_type, is_image_question, subject, topic or tags are outside this score: do not lower it or
list issues for them.` : '';
  // The verification section only appears when something in the batch was actually repaired.
  // Asking "was each change applied?" of ten questions that were never touched trains the
  // model to answer the question with an empty array, which is how a real finding gets lost.
  const verification = hasRepairs ? `

PART ONE — VERIFY THE REPAIRS (do this FIRST, for every question that has a REPAIR HISTORY):

Earlier stages asked for specific changes, and a fixer attempted them. You are shown what was
asked and which fields moved. For EACH requested change, decide:

  • "applied"             the change was made AND the result is correct
  • "applied_incorrectly" the change was made but the result is wrong, incomplete, or broke something else
  • "not_applied"         the question still has the defect the change describes
  • "not_needed"          the change rested on a misreading; the question was already right

Read the change, then read the question as it now stands, and say which. Three rules:

  1. "fields that moved: NONE" means the fixer returned the question unchanged. Every change it
     was asked to make is "not_applied" unless the question plainly never had the defect.
  2. "fields that moved: NOT RECORDED" means nothing was captured either way. Decide from the
     question in front of you — do NOT infer that the repair was skipped.
  3. A repair marked THE REPAIR FAILED was never attempted successfully. Those changes are
     "not_applied" — do not mark them applied because the question reads well now.

Where the recorded movement says a field changed but the defect is still present, that is
"applied_incorrectly", not "applied". Judge the question, not the record.

PART TWO — SCORE THE QUESTION` : '';

  return `You are a final quality gate auditor for exam questions.

You will receive questions that have already passed validator and adversarial review.
Questions may be in ANY format: MCQ, Select All That Apply (SATA), ordered response, fill-in-the-blank, hot spot, matrix grid, extended matching, case study, etc.
${hasRepairs
  ? 'Your job has two parts: confirm that the repairs asked of earlier stages were actually made and made correctly, and then score the question.'
  : 'Your job is a FINAL holistic quality check — one score per question.'}${scope}${verification}

Score each question 1-10 based on:
1. Factual accuracy of the correct answer and explanation
2. For choice-based formats: quality and plausibility of distractors/options
3. For non-choice formats: appropriateness and accuracy of the expected answer
4. Educational relevance and value
5. Clarity and unambiguity of the question stem
6. Image completeness AND fidelity — if marked as IMAGE: MISSING, the question is UNUSABLE and must score ≤ 4. If an image is shown with an IMAGE WAS SPECIFIED AS block, read the image against that specification and score ≤ 4 where it fails to show a value, trend, relationship, label or position the correct answer is read from. Being the right kind of picture is not enough: a growth chart whose points do not sit at the percentiles labelling them, or a rhythm strip that does not show the activity the specification sets out, cannot be answered. Do not penalise style or polish where everything the answer needs is legible
7. Overall exam-readiness

Scoring guide:
• 9-10: Exam-ready, no changes needed
• 8: Minor polish possible but acceptable
• 7: Borderline — could pass but has notable weakness
• 5-6: Needs improvement before use
• 1-4: Unacceptable — factual errors, ambiguity, or poor construction

For each question, provide:
- quality_score (1-10)
- status: "approved" if score >= 7, "flagged" if score < 7
- reason: 1 sentence explaining the score
- issues: array of specific problems (empty if approved)${hasRepairs ? `
- repair_verification: one entry per requested change, for questions with a REPAIR HISTORY

A question with any "not_applied" or "applied_incorrectly" change CANNOT be approved, whatever
its other merits. It still carries a defect an earlier stage identified.` : ''}

Return a JSON ARRAY — one object per question:
[
  {
    "question_number": 1,
    "quality_score": 9,
    "status": "approved",
    "reason": "Well-constructed question with accurate answer and good distractors",
    "issues": []${hasRepairs ? `,
    "repair_verification": [
      {
        "change": "<the requested change, quoted or summarised so it is identifiable>",
        "verdict": "<applied|applied_incorrectly|not_applied|not_needed>",
        "note": "<1 sentence: what you checked in the question, and what you found>"
      }
    ]` : ''}
  },
  ...
]

Output ONLY the JSON array. No preamble, no trailing text.`;
}

// ── Run audit on a batch ──

export async function runAuditBatch(questions: Record<string, unknown>[], opts: { existingBank?: boolean } = {}): Promise<Record<string, unknown>[]> {
  // What earlier stages asked for, and what the fixer did about it. This was always on the row
  // — reviewPipeline writes it for every repair — and audit never read it, so it re-scored each
  // question from scratch and a change that was requested and silently not applied left a
  // question that reads well, scores nine, and still has the defect.
  const histories = questions
    .map((q, i) => fixHistoryBlock(q, `Q${i + 1}`))
    .filter((h): h is string => Boolean(h));
  const historyBlock = histories.length
    ? `\nREPAIR HISTORY — what earlier stages asked for and what the fixer did:\n${histories.join('\n')}\n`
    : '';

  const prompt = getAuditPrompt(histories.length > 0, Boolean(opts.existingBank));
  const content = await formatQuestionsForReviewWithImages(questions);

  let userMessage: string | ContentPart[];
  if (typeof content === 'string') {
    userMessage = `${prompt}\n${historyBlock}\nQuestions to audit:\n${content}`;
  } else {
    userMessage = [
      { type: 'text', text: `${prompt}\n${historyBlock}\nQuestions to audit:\n` },
      ...content,
    ];
  }

  // Never throw: a Bedrock/network failure here would otherwise crash the whole
  // audit pipeline. Return whatever we can parse; empty is handled downstream as
  // needs_review (not a fabricated score-5 flag).
  let results: Record<string, unknown>[] = [];
  try {
    const response = await orCall(MODELS.AUDITOR, '', userMessage, {
      maxTokens: 12000,
      temperature: 0.2,
    });
    results = extractJsonArray(response.content, questions.length);
  } catch (e) {
    console.warn(`  [Audit] LLM call failed for batch of ${questions.length}: ${e instanceof Error ? e.message : e}`);
  }

  if (results.length < questions.length) {
    console.log(`  [Audit] Short response (${results.length}/${questions.length}), retrying...`);
    try {
      const response2 = await orCall(MODELS.AUDITOR, '', userMessage, {
        maxTokens: 12000,
        temperature: 0.1,
      });
      const results2 = extractJsonArray(response2.content, questions.length);
      if (results2.length > results.length) results = results2;
    } catch (e) {
      console.warn(`  [Audit] Retry LLM call failed: ${e instanceof Error ? e.message : e}`);
    }
  }

  return results;
}

// ── Main pipeline ──

async function runAuditPipeline(jobId: string): Promise<void> {
  try {
    startTracking(jobId, 'audit');
    setStep(jobId, 'Fetching reviewed questions...');
    // Imported items are audited on candidate-facing content only (getAuditPrompt).
    const { data: jobRow } = await supabase.from('qb_jobs').select('config').eq('id', jobId).single();
    const jobConfig = ((jobRow?.config as Record<string, unknown>) || {});
    const existingBank = jobConfig.source === 'import' || jobConfig.existing_bank === true;

    // Paginate — audit must see every reviewed question, not just the first 1000.
    const questions = await fetchAllRows<Record<string, unknown>>((from, to) =>
      supabase
        .from('qb_questions').select('*')
        .eq('job_id', jobId).eq('status', 'reviewed')
        .is('replaced_by_id', null)
        .order('question_number', { ascending: true })
        .range(from, to)
    );

    if (!questions || questions.length === 0) {
      setStep(jobId, 'No reviewed questions found — skipping to complete');
      await supabase.from('qb_jobs').update({
        status: 'complete', progress: { step: 'No questions to audit', total: 0 },
      }).eq('id', jobId);
      setState(jobId, { status: 'complete' });
      return;
    }

    const total = questions.length;
    const subjects = buildSubjectMap(questions as Record<string, unknown>[]);
    setState(jobId, { total, subjects });
    setStep(jobId, `Found ${total} questions across ${subjects.length} subjects — starting audit`);
    await pushProgress(jobId);

    const batches = chunk(questions as Record<string, unknown>[], AUDIT_BATCH_SIZE);
    const batchesTotal = batches.length;
    let totalAudited = 0;
    let totalApproved = 0;
    let totalFlagged = 0;
    let totalNeedsReview = 0;
    let batchesDone = 0;

    setState(jobId, { batchesTotal, batchesDone: 0 });
    setStep(jobId, `Audit: sending ${batchesTotal} batches (${total} Qs) to ${MODELS.AUDITOR}`);
    await pushProgress(jobId);

    const batchTasks = batches.map((batch, batchIdx) => async () => {
      const batchNum = batchIdx + 1;
      const qStart = batchIdx * AUDIT_BATCH_SIZE + 1;
      const qEnd = qStart + batch.length - 1;

      setStep(jobId, `[Audit] Batch ${batchNum}/${batchesTotal}: scoring Q${qStart}–Q${qEnd} via ${MODELS.AUDITOR}...`);

      const results = await runAuditBatch(batch, { existingBank });

      setStep(jobId, `[Audit] Batch ${batchNum}/${batchesTotal}: processing scores for Q${qStart}–Q${qEnd}`);

      for (let i = 0; i < batch.length; i++) {
        const q = batch[i];
        const result = results[i];
        const rawScore = result?.quality_score;

        // Review returned no usable score for this question — almost always a
        // truncated/empty LLM response, not a genuine quality problem. Do NOT
        // fabricate a score-5 flag (that produced permanent false-flags that no
        // amount of reprocessing could clear). Keep the prior status, mark it
        // 'needs_review' so it's excluded from the flagged count but picked up
        // for a real re-review on the next reprocess pass.
        if (rawScore == null) {
          const nrTrail = Array.isArray(q.audit_trail) ? [...(q.audit_trail as unknown[])] : [];
          nrTrail.push({
            phase: 'audit_failed',
            reason: 'No score returned (empty or truncated review response)',
            timestamp: new Date().toISOString(),
          });
          const { error: nrErr } = await supabase.from('qb_questions').update({
            status: 'needs_review',
            audit_trail: nrTrail,
          }).eq('id', q.id);
          if (nrErr) console.error(`    [audit] Failed to update Q${qStart + i}: ${nrErr.message}`);

          totalAudited++;
          totalNeedsReview++;
          const subjNR = runningAudits.get(jobId)?.subjects.find((x) => x.subject === ((q.subject as string) || 'Unknown'));
          if (subjNR) { subjNR.audited++; subjNR.status = 'auditing'; }
          continue;
        }

        let auditScore = rawScore as number;

        // FINAL SAFETY GATE: never approve a case_study/TBS whose sub-questions
        // aren't machine-gradable, regardless of the LLM's score. (Validator is
        // the primary structural check; this is the last line before approval.)
        const gradeIssues = gradabilityIssues(q);
        if (gradeIssues.length > 0 && auditScore >= 7) {
          auditScore = 3;
          if (result) {
            result.reason = `Not gradable: ${gradeIssues.slice(0, 3).join('; ')}${gradeIssues.length > 3 ? '…' : ''}`;
            result.issues = [ ...((result.issues as string[]) || []), ...gradeIssues.map((s) => `NOT GRADABLE — ${s}`) ];
          }
        }

        // REPAIR VERIFICATION GATE — the job this stage exists to do.
        //
        // Two sources, and the deterministic one comes first. `unappliedChanges` reads the
        // fixer's OWN record that it could not make a change: a *_fix_failed entry with no later
        // successful repair of the same stage. That is not an opinion about quality and needs no
        // model to confirm it — the change was requested, the attempt failed, and nothing since
        // has addressed it. Such a question was previously free to score 9 and ship.
        //
        // The auditor's per-change verdicts are the second source, covering the case the record
        // cannot see: a change that WAS applied and applied wrongly.
        const unapplied = unappliedChanges(q);
        const verdicts = (result?.repair_verification as Array<Record<string, unknown>>) || [];
        const badVerdicts = verdicts.filter((v) =>
          ['not_applied', 'applied_incorrectly'].includes(String(v?.verdict || '').toLowerCase()));

        if (unapplied.length || badVerdicts.length) {
          const notes = [
            ...unapplied.map((c) => `REPAIR NEVER APPLIED — the fixer failed and nothing since has addressed: ${String(c).slice(0, 220)}`),
            ...badVerdicts.map((v) => `REPAIR ${String(v.verdict).toUpperCase()} — ${String(v.change ?? '').slice(0, 160)}: ${String(v.note ?? '').slice(0, 200)}`),
          ];
          if (auditScore >= 7) auditScore = 4;
          if (result) {
            result.issues = [...((result.issues as string[]) || []), ...notes];
            result.reason = `Requested repair not carried through: ${notes[0].slice(0, 160)}`;
          }
          console.log(`    [audit] Q${qStart + i} repair verification failed: ${notes[0].slice(0, 110)}`);
        }

        // There is deliberately no combined score.
        //
        // Averaging validator, adversarial and audit averaged three scores of three DIFFERENT
        // versions of the question. validator_score is written once, before the fixer runs, and
        // never re-scored; adversarial_score is taken after the validator's repair but before
        // its own; only the audit score describes the question as it now stands. So a question
        // that was found wanting, repaired correctly and is now sound carried a mean dragged
        // down by a defect that no longer existed — repaired questions averaged 7.32 at the
        // validator and 8.82 at audit, within 0.13 of questions that never needed a repair.
        //
        // Nothing gated on it: status has always been decided by the audit score below. The
        // three scores are kept separately, each meaning what it says about the version it saw.

        // A deterministic finding must not be overridable by a holistic opinion.
        //
        // The validator already caps the score at 3 and marks a self-contradictory question NOT
        // COMPLIANT, but status is decided HERE from the auditor's own score, so six questions
        // capped at 3 were approved at 8 and 9 anyway and reached the bank. If the fixer could
        // not resolve the finding, the auditor liking the question is not a reason to ship it.
        //
        // Only blocking findings count: a document review where no passage is correct as written
        // is reported but does not stop approval, because a candidate still has to choose the
        // right correction on every passage. See partitionIssues for where that line sits.
        const { blocking: cohBlocking } = partitionIssues(coherenceIssues(q));
        if (cohBlocking.length) {
          result.issues = [
            ...((result.issues as string[]) || []),
            ...cohBlocking.map((s) => `NOT COMPLIANT — coherence: ${s}`),
          ];
        }
        // The validator judged this item to belong to another exam (tags.belongs_to_exam, e.g.
        // "NEET PG" for a USMLE item on India's MTP Act). It was deliberately left unrepaired, so
        // however well it reads it is not approved for this course.
        const otherExam = String((q.tags as Record<string, unknown> | null)?.belongs_to_exam ?? '');
        if (otherExam) {
          result.issues = [...((result.issues as string[]) || []), `BELONGS TO ${otherExam.toUpperCase()} — ${String((q.tags as Record<string, unknown>).out_of_scope_reason ?? '')}`];
          result.reason = `Belongs to ${otherExam}, not this exam: ${String((q.tags as Record<string, unknown>).out_of_scope_reason ?? '').slice(0, 160)}`;
        }
        const status = auditScore >= 7 && cohBlocking.length === 0 && !otherExam ? 'approved' : 'flagged';
        if (auditScore >= 7 && cohBlocking.length) {
          console.log(`    [audit] Q${qStart + i} scored ${auditScore} but flagged: ${cohBlocking[0].slice(0, 90)}`);
        }

        const trail = Array.isArray(q.audit_trail) ? [...(q.audit_trail as unknown[])] : [];
        trail.push({
          phase: 'audit',
          score: auditScore,
          reason: (result.reason as string) || '',
          issues: (result.issues as string[]) || [],
          timestamp: new Date().toISOString(),
        });

        const { error: updateErr } = await supabase.from('qb_questions').update({
          quality_score: auditScore,
          status,
          audit_trail: trail,
        }).eq('id', q.id);

        if (updateErr) {
          console.error(`    [audit] Failed to update Q${qStart + i}: ${updateErr.message}`);
        }

        totalAudited++;
        if (status === 'approved') totalApproved++;
        else totalFlagged++;

        // Update per-subject
        const subj = (q.subject as string) || 'Unknown';
        const subjEntry = runningAudits.get(jobId)?.subjects.find((x) => x.subject === subj);
        if (subjEntry) {
          subjEntry.audited++;
          subjEntry.status = 'auditing';
          if (status === 'approved') subjEntry.approved++;
          else subjEntry.flagged++;
        }
      }

      const scoresSummary = results.map((r, i) => {
        const sc = r?.quality_score == null ? 'NR' : (r.quality_score as number);
        return `Q${qStart + i}:${sc}`;
      }).join(' ');
      setStep(jobId, `[Audit] Batch ${batchNum}: scores — ${scoresSummary}`);

      batchesDone++;
      setState(jobId, { audited: totalAudited, approved: totalApproved, flagged: totalFlagged, batchesDone });
      setStep(jobId, `Audit progress: ${batchesDone}/${batchesTotal} batches, ${totalApproved} approved, ${totalFlagged} flagged`);
      await pushProgress(jobId);

      return { audited: batch.length };
    });

    await runWithConcurrency(batchTasks, MAX_CONCURRENT_BATCHES);

    // Mark subjects done
    const s = runningAudits.get(jobId);
    if (s) s.subjects.forEach((subj) => { subj.status = 'done'; });

    // Save post-audit snapshot
    setStep(jobId, 'Saving post-audit snapshots...');
    await saveJobSnapshots(jobId, 'post_audit').catch((e) => console.error('Snapshot error:', e));

    // Determine next status
    const nextStatus = 'complete';
    const nrSuffix = totalNeedsReview ? `, ${totalNeedsReview} need re-review (review call failed)` : '';
    const finalMsg = `Audit complete — ${totalApproved} approved, ${totalFlagged} flagged${nrSuffix} out of ${total}.`;
    setStep(jobId, finalMsg);

    // Bank-level review, which only makes sense here.
    //
    // Every other check in the pipeline looks at one question. Some faults exist only between
    // questions: three of one section's 57 items tested whether a cash flow hedge of a forecast
    // purchase adjusts the asset's basis, each individually fine, and because all three were
    // keyed the same wrong way one authoring error cost a candidate three questions. Generation
    // runs a subject at a time and cannot see that; audit is the first point that holds the
    // whole job.
    //
    // Advisory only — it is recorded on the job and never blocks or flags a question, because
    // how many questions a concept deserves is a blueprint decision, not something a script
    // should settle.
    const mixFindings = await bankMixForJob(jobId);
    if (mixFindings.length) {
      console.log(`[Mix] job ${jobId.slice(0, 8)} — ${mixFindings.length} concentration(s) worth a look:`);
      for (const f of mixFindings.slice(0, 10)) console.log(`  [Mix] ${f.exam}: ${f.detail}`);
    }

    // Merge token usage from all steps
    const auditTokens = getStepTokens(jobId, 'audit');
    const { data: currentJob } = await supabase.from('qb_jobs').select('progress').eq('id', jobId).single();
    const existingTokens = (currentJob?.progress as Record<string, unknown>)?.token_usage as Record<string, unknown> || {};

    await supabase.from('qb_jobs').update({
      status: nextStatus,
      progress: {
        step: finalMsg,
        audited: totalAudited, approved: totalApproved, flagged: totalFlagged, needs_review: totalNeedsReview, total,
        events: runningAudits.get(jobId)?.events.slice(-10) || [],
        subjects: runningAudits.get(jobId)?.subjects || [],
        token_usage: { ...existingTokens, audit: auditTokens },
        ...(mixFindings.length ? { mix_findings: mixFindings.slice(0, 20) } : {}),
      },
    }).eq('id', jobId);

    setState(jobId, { status: 'complete', audited: totalAudited, approved: totalApproved, flagged: totalFlagged });
    console.log(`\n✅ Audit complete: ${totalApproved} approved, ${totalFlagged} flagged\n`);
  } catch (e) {
    console.error(`Audit pipeline failed for job ${jobId}:`, e);
    const errMsg = e instanceof Error ? e.message : 'Audit failed';
    setStep(jobId, `ERROR: ${errMsg}`);
    setState(jobId, { status: 'failed' });

    await supabase.from('qb_jobs').update({
      status: 'failed', error: errMsg,
      progress: { step: errMsg },
    }).eq('id', jobId);
  }
}

// ── Entry point: start or poll ──

export async function auditBatchForJob(jobId: string): Promise<{
  status: string; step: string;
  audited: number; approved: number; flagged: number; total: number;
  batches_total: number; batches_done: number;
  events: string[];
  subjects: SubjectStatus[];
}> {
  // A FINISHED audit in this cache must not answer for a job that has work again.
  //
  // The same fault as reviewBatchForJob had: a terminal entry was deleted and then returned
  // anyway, so the next call reported "complete" without auditing anything. The job then ended
  // orchestration still in 'auditing' with its questions sitting at 'reviewed', because the
  // orchestrator was waiting for a status change nothing was going to make. It showed up twice on
  // one job here — a question re-scored after its image was corrected passed review and then
  // never reached audit.
  //
  // A live run still reports progress from this cache, which is what the UI polls. Only a
  // terminal entry is dropped, and the DB check below still answers "complete" for a poll that
  // arrives after a genuine finish.
  const cached = runningAudits.get(jobId);
  if (cached && cached.status !== 'complete' && cached.status !== 'failed') {
    return {
      status: cached.status, step: cached.step,
      audited: cached.audited, approved: cached.approved, flagged: cached.flagged, total: cached.total,
      batches_total: cached.batchesTotal, batches_done: cached.batchesDone,
      events: cached.events.slice(-15),
      subjects: cached.subjects,
    };
  }
  if (cached) runningAudits.delete(jobId);

  // Check DB
  const { data: job, error: jobErr } = await supabase
    .from('qb_jobs').select('status, progress').eq('id', jobId).single();
  if (jobErr) throw new Error(jobErr.message);

  if (job.status === 'complete') {
    const p = (job.progress || {}) as Record<string, unknown>;
    return {
      status: 'complete', step: (p.step as string) || 'Audit complete',
      audited: (p.audited as number) || (p.total as number) || 0,
      approved: (p.approved as number) || 0,
      flagged: (p.flagged as number) || 0,
      total: (p.total as number) || 0,
      batches_total: 0, batches_done: 0,
      events: (p.events as string[]) || [],
      subjects: (p.subjects as SubjectStatus[]) || [],
    };
  }

  // First call — kick off
  const { count } = await supabase
    .from('qb_questions').select('*', { count: 'exact', head: true })
    .eq('job_id', jobId).eq('status', 'reviewed').is('replaced_by_id', null);

  const total = count || 0;

  runningAudits.set(jobId, {
    status: 'running', step: `Initializing audit for ${total} questions...`,
    audited: 0, approved: 0, flagged: 0, total,
    batchesTotal: 0, batchesDone: 0,
    events: [`Initializing audit for ${total} questions...`],
    subjects: [],
  });

  runAuditPipeline(jobId).catch((e) => {
    console.error('runAuditPipeline failed:', e);
    const s = runningAudits.get(jobId);
    if (s) { s.status = 'failed'; s.step = e instanceof Error ? e.message : 'Audit failed'; }
  });

  return {
    status: 'running', step: `Initializing audit for ${total} questions...`,
    audited: 0, approved: 0, flagged: 0, total,
    batches_total: 0, batches_done: 0, events: [],
    subjects: [],
  };
}
