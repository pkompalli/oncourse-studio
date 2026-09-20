/**
 * Reprocess Flagged Questions Pipeline
 *
 * Targeted fix-and-re-audit pass for flagged questions only:
 *   1. Retry images for image questions missing images
 *   2. Fix flagged questions using their audit feedback
 *   3. Re-run validator on fixed questions
 *   4. Re-run adversarial on fixed questions
 *   5. Re-audit just these questions
 */

import { supabase } from '../../db/supabase.js';
import { fetchAllRows } from '../../db/pagination.js';
import { fixQuestion } from './fixer.js';
import { runValidatorBatch } from './validator.js';
import { runAdversarialBatch } from './adversarial.js';
import { processAllImageQuestions, regenerateQuestionImage, isImageGenerationAvailable, imageContradictionIssues } from '../images/imageGeneration.js';
import { orCall, MODELS } from '../llm/openrouter.js';
import type { ContentPart } from '../llm/openrouter.js';
import { formatQuestionsForReviewWithImages, extractJsonArray } from './shared.js';

const BATCH_SIZE = 10;
const MAX_CONCURRENT = 4;

// ── In-memory state ──

interface ReprocessState {
  status: 'running' | 'complete' | 'failed';
  phase: 'init' | 'retrying_images' | 'fixing' | 'validator' | 'adversarial' | 'auditing' | 'done' | 'error';
  step: string;
  total: number;
  processed: number;
  fixed: number;
  imageRetried: number;
  reApproved: number;
  stillFlagged: number;
  needsReview?: number;
  events: string[];
}

const runningReprocesses = new Map<string, ReprocessState>();

function setStep(jobId: string, step: string) {
  const s = runningReprocesses.get(jobId);
  if (s) {
    s.step = step;
    s.events.push(step);
    if (s.events.length > 40) s.events = s.events.slice(-40);
  }
}

function setState(jobId: string, updates: Partial<ReprocessState>) {
  const s = runningReprocesses.get(jobId);
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
  return new Promise((resolve) => {
    function next() {
      if (completed === tasks.length) { resolve(results); return; }
      while (active < max && idx < tasks.length) {
        const i = idx++;
        active++;
        tasks[i]()
          .then((r) => { results[i] = r; })
          .catch((e) => { console.error(`  [reprocess] Batch ${i} error:`, e instanceof Error ? e.message : e); })
          .finally(() => { completed++; active--; next(); });
      }
    }
    if (tasks.length === 0) resolve([]);
    else next();
  });
}

async function pushProgress(jobId: string) {
  const s = runningReprocesses.get(jobId);
  if (!s) return;
  await supabase.from('qb_jobs').update({
    progress: {
      reprocess: true,
      phase: s.phase,
      step: s.step,
      total: s.total,
      processed: s.processed,
      fixed: s.fixed,
      image_retried: s.imageRetried,
      re_approved: s.reApproved,
      still_flagged: s.stillFlagged,
      events: s.events.slice(-10),
    },
  }).eq('id', jobId);
}

async function getCourseInfo(jobId: string): Promise<{ name: string; examFormat: Record<string, unknown>; guidelines: Record<string, unknown> }> {
  const { data: job } = await supabase.from('qb_jobs').select('course_id').eq('id', jobId).single();
  if (!job) return { name: 'Unknown', examFormat: {}, guidelines: {} };

  // Try with generation_guidelines first; fall back if column doesn't exist yet
  let course: Record<string, unknown> | null = null;
  const { data: d1, error: e1 } = await supabase.from('qb_courses').select('name, exam_format, generation_guidelines').eq('id', job.course_id).single();
  if (e1 && e1.message?.includes('generation_guidelines')) {
    const { data: d2 } = await supabase.from('qb_courses').select('name, exam_format').eq('id', job.course_id).single();
    course = d2 as Record<string, unknown> | null;
  } else {
    course = d1 as Record<string, unknown> | null;
  }

  return {
    name: (course?.name as string) || 'Unknown',
    examFormat: (course?.exam_format as Record<string, unknown>) || {},
    guidelines: (course?.generation_guidelines as Record<string, unknown>) || {},
  };
}

// ── Extract audit issues from a question's audit_trail ──

function getAuditIssues(question: Record<string, unknown>): string[] {
  const trail = (question.audit_trail as Array<Record<string, unknown>>) || [];
  const issues: string[] = [];

  for (const entry of trail) {
    // Gather issues from all phases
    const phase = entry.phase as string;

    // Audit phase issues
    if (entry.issues && Array.isArray(entry.issues)) {
      for (const issue of entry.issues as string[]) {
        if (issue) issues.push(`[${phase}] ${issue}`);
      }
    }
    if (entry.reason && typeof entry.reason === 'string' && (entry.score as number) <= 7) {
      issues.push(`[${phase}] ${entry.reason}`);
    }

    // Validator/adversarial changes_required
    if (entry.changes && Array.isArray(entry.changes)) {
      for (const change of entry.changes as string[]) {
        if (change) issues.push(`[${phase}] ${change}`);
      }
    }

    // Summary from low-scoring phases
    if (entry.summary && typeof entry.summary === 'string' && (entry.score as number) <= 7) {
      const summary = entry.summary as string;
      if (summary !== 'No issues found' && summary !== 'No significant defects found') {
        issues.push(`[${phase}] ${summary}`);
      }
    }
  }

  // Deduplicate
  return [...new Set(issues)];
}

// ── Audit prompt (same as audit pipeline but for re-audit) ──

function getAuditPrompt(): string {
  return `You are a final quality gate auditor for exam questions.

You will receive questions that have been fixed based on prior review feedback.
Questions may be in ANY format: MCQ, Select All That Apply (SATA), ordered response, fill-in-the-blank, hot spot, matrix grid, extended matching, case study, etc.
Your job is a FINAL holistic quality check — one combined score per question.

Score each question 1-10 based on:
1. Factual accuracy of the correct answer and explanation
2. For choice-based formats: quality and plausibility of distractors/options
3. For non-choice formats: appropriateness and accuracy of the expected answer
4. Educational relevance and value
5. Clarity and unambiguity of the question stem
6. Image completeness — if marked as IMAGE: MISSING, the question is UNUSABLE and must score <= 4
7. Overall exam-readiness

Scoring guide:
- 9-10: Exam-ready, no changes needed
- 8: Minor polish possible but acceptable
- 7: Borderline — could pass but has notable weakness
- 5-6: Needs improvement before use
- 1-4: Unacceptable — factual errors, ambiguity, or poor construction

For each question, provide:
- quality_score (1-10)
- status: "approved" if score >= 7, "flagged" if score < 7
- reason: 1 sentence explaining the score
- issues: array of specific problems (empty if approved)

Return a JSON ARRAY — one object per question:
[
  {
    "question_number": 1,
    "quality_score": 9,
    "status": "approved",
    "reason": "Well-constructed question with accurate answer and good distractors",
    "issues": []
  },
  ...
]

Output ONLY the JSON array. No preamble, no trailing text.`;
}

async function runAuditBatch(questions: Record<string, unknown>[]): Promise<Record<string, unknown>[]> {
  const prompt = getAuditPrompt();
  const content = await formatQuestionsForReviewWithImages(questions);

  let userMessage: string | ContentPart[];
  if (typeof content === 'string') {
    userMessage = `${prompt}\n\nQuestions to audit:\n${content}`;
  } else {
    userMessage = [
      { type: 'text', text: `${prompt}\n\nQuestions to audit:\n` },
      ...content,
    ];
  }

  // 12000 (matching the main audit pipeline). 4000 truncated the response for
  // large case-study batches, yielding no parseable score → questions stuck in
  // needs_review/flagged limbo forever ("reprocess_audit_failed").
  const response = await orCall(MODELS.AUDITOR, '', userMessage, {
    maxTokens: 12000,
    temperature: 0.2,
  });

  let results = extractJsonArray(response.content, questions.length);
  if (results.length < questions.length) {
    const response2 = await orCall(MODELS.AUDITOR, '', userMessage, {
      maxTokens: 12000,
      temperature: 0.1,
    });
    const results2 = extractJsonArray(response2.content, questions.length);
    if (results2.length > results.length) results = results2;
  }

  return results;
}

// ── Main reprocess pipeline ──

/**
 * Statuses a reprocess candidate can be in, and the test for whether it actually
 * needs re-running. ONE definition, used by BOTH the entry gate and the pipeline.
 *
 * They were separate copies and they drifted: the pipeline was taught about
 * 'needs_review' (a question whose review call came back empty) but the gate was
 * not — it neither selected that status nor matched it. So a CFA job with 28
 * questions parked in needs_review showed 28 to reprocess in the UI and answered
 * "No flagged questions to reprocess" the moment you pressed the button, because
 * the gate counted zero and returned before the pipeline ever ran.
 */
export const REPROCESS_CANDIDATE_STATUSES = ['flagged', 'reviewed', 'approved', 'needs_review'];

export function isEffectivelyFlagged(q: Record<string, any>): boolean {
  if (q.status === 'flagged') return true;
  // Review call previously failed (empty/truncated response) — retry it.
  if (q.status === 'needs_review') return true;
  // quality_score (from audit) is the primary indicator.
  if (q.quality_score != null) return (q.quality_score as number) < 7;
  if (q.validator_score != null && q.adversarial_score != null) {
    return (q.validator_score as number) < 7 || (q.adversarial_score as number) < 7;
  }
  // Validator only (e.g. post-migration, pre-adversarial).
  if (q.validator_score != null) return (q.validator_score as number) < 7;
  // 'reviewed' with no scores at all — needs processing.
  if (q.status === 'reviewed') return true;
  return false;
}


/**
 * Persist a fixer result. ONE definition for all three fix sites.
 *
 * They had drifted: the phase-1 site saved `content`, the validator and adversarial
 * sites saved only question/options/correct_option/explanation. For every grouped
 * format ALL the substance lives in content — sub_questions, case_narrative, parts,
 * image_description — so those two sites recorded "changes_applied" in the trail and
 * then threw the fix away. A CFA case study was re-flagged for the same image/text
 * mismatch run after run while its adversarial fix reported success each time.
 *
 * Returns whether the image should now be redrawn: when the issues say the figure
 * contradicts the text, the fixer has just corrected the TEXT (and image_description),
 * and the figure must be regenerated from it — the fixer cannot draw.
 */
async function persistFix(
  q: Record<string, unknown>,
  fixedQ: Record<string, unknown>,
  trail: unknown[],
  issues: string[],
  jobId: string
): Promise<void> {
  const update: Record<string, unknown> = { audit_trail: trail };
  if (fixedQ.question != null) update.question = fixedQ.question;
  if (fixedQ.options != null) update.options = fixedQ.options;
  if (fixedQ.correct_option != null || fixedQ.correct_answer != null) {
    update.correct_option = fixedQ.correct_option || fixedQ.correct_answer;
  }
  if (fixedQ.explanation != null) update.explanation = fixedQ.explanation;
  if (fixedQ.content != null) update.content = fixedQ.content;
  // image_description is a top-level column AND lives inside content; buildImagePrompt
  // prefers the column, so leaving it stale would let the old spec win over the fix.
  const desc = (fixedQ.image_description as string)
    || ((fixedQ.content as Record<string, unknown> | undefined)?.image_description as string);
  if (desc) update.image_description = desc;

  await supabase.from('qb_questions').update(update).eq('id', q.id as string);

  const contradictions = imageContradictionIssues(issues);
  if (contradictions.length > 0 && q.image_url && isImageGenerationAvailable()) {
    console.log(`    🖼  Image contradicts the text for Q${q.question_number} — redrawing from the corrected text`);
    await regenerateQuestionImage(q.id as string, jobId, contradictions);
  }
}

async function runReprocessPipeline(jobId: string): Promise<void> {
  try {
    setStep(jobId, 'Loading flagged questions...');
    const { name: courseName, examFormat, guidelines } = await getCourseInfo(jobId);

    // Fetch questions that are effectively flagged:
    // 1. status = 'flagged' (explicitly flagged)
    // 2. status = 'reviewed'/'approved' but scores indicate flagged
    //    (matches displayStatus() logic in the UI)
    // Paginate — a job can have >1000 candidate questions.
    const candidateQuestions = await fetchAllRows<Record<string, any>>((from, to) =>
      supabase
        .from('qb_questions')
        .select('*')
        .eq('job_id', jobId)
        .in('status', REPROCESS_CANDIDATE_STATUSES)
        .is('replaced_by_id', null)
        .order('question_number', { ascending: true })
        .range(from, to)
    );

    const flaggedQuestions = (candidateQuestions || []).filter(isEffectivelyFlagged);

    if (flaggedQuestions.length === 0) {
      setStep(jobId, 'No flagged questions to reprocess');
      setState(jobId, { status: 'complete', phase: 'done' });
      return;
    }

    const total = flaggedQuestions.length;
    // Capture IDs for all downstream re-fetches (status may change during processing)
    const flaggedIds = flaggedQuestions.map(q => q.id as string);
    setState(jobId, { total });
    setStep(jobId, `Found ${total} flagged questions to reprocess for "${courseName}"`);
    await pushProgress(jobId);

    // ── Phase 1: Retry images — missing OR flagged for replacement ──
    const IMAGE_REPLACE_RE = /\b(replace|regenerate|swap|redo|wrong|incorrect|mismatch|inconsistent|not\s+match|does\s+not\s+(show|depict|display))\b.*\b(image|photo|illustration|picture|figure|x-?ray|ct|mri|scan|radiograph|visual)\b|\b(image|photo|illustration|picture|figure|x-?ray|ct|mri|scan|radiograph|visual)\b.*\b(replace|regenerate|swap|redo|wrong|incorrect|mismatch|inconsistent)\b/i;

    const imageQsToRetry = flaggedQuestions.filter((q) => {
      if (!q.is_image_question) return false;
      // Missing image — always retry
      if (!q.image_url) return true;
      // Image exists but audit feedback says to replace it
      const issues = getAuditIssues(q as Record<string, unknown>);
      return issues.some(issue => IMAGE_REPLACE_RE.test(issue));
    });
    let imageRetried = 0;

    if (imageQsToRetry.length > 0 && isImageGenerationAvailable()) {
      setState(jobId, { phase: 'retrying_images' });
      const missingCount = imageQsToRetry.filter(q => !q.image_url).length;
      const replaceCount = imageQsToRetry.length - missingCount;
      setStep(jobId, `Retrying image generation: ${missingCount} missing, ${replaceCount} flagged for replacement...`);
      await pushProgress(jobId);

      for (const q of imageQsToRetry) {
        const feedback = getAuditIssues(q as Record<string, unknown>);
        const success = await regenerateQuestionImage(q.id, jobId, feedback.length > 0 ? feedback : ['Generate an appropriate image for this question']);
        if (success) imageRetried++;
        setStep(jobId, `Image retry: ${imageRetried}/${imageQsToRetry.length} succeeded`);
      }

      setState(jobId, { imageRetried });
      setStep(jobId, `Image retry complete: ${imageRetried}/${imageQsToRetry.length} images generated`);
      await pushProgress(jobId);
    }

    // ── Phase 2: Fix questions using audit feedback ──
    setState(jobId, { phase: 'fixing' });
    setStep(jobId, `Fixing ${total} flagged questions using audit feedback...`);
    await pushProgress(jobId);

    let totalFixed = 0;

    // Re-fetch questions to get latest data (images may have been updated)
    const { data: freshQuestions } = await supabase
      .from('qb_questions')
      .select('*')
      .in('id', flaggedIds)
      .order('question_number', { ascending: true });

    const questionsToFix = freshQuestions || flaggedQuestions;

    const batches = chunk(questionsToFix as Record<string, unknown>[], BATCH_SIZE);
    for (let bi = 0; bi < batches.length; bi++) {
      const batch = batches[bi];
      setStep(jobId, `Fixing batch ${bi + 1}/${batches.length}...`);

      const fixPromises = batch.map(async (q) => {
        const issues = getAuditIssues(q);
        if (issues.length === 0) return; // nothing to fix

        const fixResult = await fixQuestion(q, issues, courseName);
        if (fixResult.fixed && fixResult.question) {
          const fixedQ = fixResult.question;

          // Record fix in audit trail
          const trail = Array.isArray(q.audit_trail) ? [...(q.audit_trail as unknown[])] : [];
          trail.push({
            phase: 'reprocess_fix',
            changes_requested: issues,
            changes_applied: fixResult.changesApplied || [],
            timestamp: new Date().toISOString(),
          });

          await persistFix(q, fixedQ, trail, issues, jobId);
          totalFixed++;
        }
      });

      await Promise.all(fixPromises);
      setState(jobId, { fixed: totalFixed, processed: (bi + 1) * BATCH_SIZE });
      setStep(jobId, `Fixed ${totalFixed}/${questionsToFix.length} questions (batch ${bi + 1}/${batches.length})`);
      await pushProgress(jobId);
    }

    // ── Phase 3: Re-run validator on fixed questions ──
    setState(jobId, { phase: 'validator' });
    setStep(jobId, `Re-validating ${questionsToFix.length} fixed questions...`);
    await pushProgress(jobId);

    // Re-fetch to get fixed versions
    const { data: fixedQuestions } = await supabase
      .from('qb_questions')
      .select('*')
      .in('id', flaggedIds)
      .order('question_number', { ascending: true });

    const validQuestions = (fixedQuestions || questionsToFix) as Record<string, unknown>[];

    // Filter out structural failures (missing images still)
    const forReview = validQuestions.filter(q => {
      if (q.is_image_question && !q.image_url) return false;
      return true;
    });

    const vBatches = chunk(forReview, BATCH_SIZE);
    let vDone = 0;

    const vTasks = vBatches.map((batch, bi) => async () => {
      setStep(jobId, `[Validator] Batch ${bi + 1}/${vBatches.length}: scoring ${batch.length} questions...`);

      const results = await runValidatorBatch(batch, 'qbank', courseName || 'exam preparation', examFormat, guidelines);

      for (let i = 0; i < batch.length; i++) {
        const q = batch[i];
        const result = results[i];
        const rawScore = result?.overall_accuracy_score;

        // Empty/truncated validator response — don't fabricate a score-5. Record
        // the failure and leave the prior validator_score untouched; the audit
        // phase makes the final needs_review/flag decision.
        if (rawScore == null) {
          const failTrail = Array.isArray(q.audit_trail) ? [...(q.audit_trail as unknown[])] : [];
          failTrail.push({
            phase: 'reprocess_validator_failed',
            reason: 'No score returned (empty or truncated review response)',
            timestamp: new Date().toISOString(),
          });
          await supabase.from('qb_questions').update({ audit_trail: failTrail }).eq('id', q.id);
          continue;
        }

        const score = rawScore as number;
        const changes = (result.changes_required as string[]) || [];

        const trail = Array.isArray(q.audit_trail) ? [...(q.audit_trail as unknown[])] : [];
        trail.push({
          phase: 'reprocess_validator',
          score,
          changes: changes.length > 0 ? changes : null,
          summary: (result.summary as string) || '',
          timestamp: new Date().toISOString(),
        });

        await supabase.from('qb_questions').update({
          validator_score: score,
          audit_trail: trail,
        }).eq('id', q.id);

        // Apply fixes if needed
        if (score <= 7 && changes.length > 0) {
          const fixResult = await fixQuestion(q, changes, courseName);
          if (fixResult.fixed && fixResult.question) {
            const fixedQ = fixResult.question;
            const trail2 = [...trail, {
              phase: 'reprocess_validator_fix',
              changes_requested: changes,
              changes_applied: fixResult.changesApplied || [],
              timestamp: new Date().toISOString(),
            }];
            await persistFix(q, fixedQ, trail2, changes, jobId);
          }
        }
      }

      vDone++;
      setStep(jobId, `Validator: ${vDone}/${vBatches.length} batches done`);
      await pushProgress(jobId);
    });

    await runWithConcurrency(vTasks, MAX_CONCURRENT);
    setStep(jobId, `Validator complete for ${forReview.length} questions`);

    // ── Phase 4: Re-run adversarial ──
    setState(jobId, { phase: 'adversarial' });
    setStep(jobId, `Re-running adversarial review on ${forReview.length} questions...`);
    await pushProgress(jobId);

    // Re-fetch for latest fixed versions
    const { data: postValidatorQs } = await supabase
      .from('qb_questions')
      .select('*')
      .in('id', flaggedIds)
      .order('question_number', { ascending: true });

    const forAdversarial = ((postValidatorQs || forReview) as Record<string, unknown>[]).filter(q => {
      if (q.is_image_question && !q.image_url) return false;
      return true;
    });

    const aBatches = chunk(forAdversarial, BATCH_SIZE);
    let aDone = 0;

    const aTasks = aBatches.map((batch, bi) => async () => {
      setStep(jobId, `[Adversarial] Batch ${bi + 1}/${aBatches.length}: scoring ${batch.length} questions...`);

      const results = await runAdversarialBatch(batch, 'qbank', courseName || 'exam preparation', examFormat);

      for (let i = 0; i < batch.length; i++) {
        const q = batch[i];
        const result = results[i];
        const rawScore = result?.adversarial_score;

        // Empty/truncated adversarial response — don't fabricate a score-5. Record
        // the failure and leave the prior adversarial_score untouched.
        if (rawScore == null) {
          const failTrail = Array.isArray(q.audit_trail) ? [...(q.audit_trail as unknown[])] : [];
          failTrail.push({
            phase: 'reprocess_adversarial_failed',
            reason: 'No score returned (empty or truncated review response)',
            timestamp: new Date().toISOString(),
          });
          await supabase.from('qb_questions').update({ audit_trail: failTrail }).eq('id', q.id);
          continue;
        }

        const score = rawScore as number;
        const changes = (result.changes_required as string[]) || [];

        const trail = Array.isArray(q.audit_trail) ? [...(q.audit_trail as unknown[])] : [];
        trail.push({
          phase: 'reprocess_adversarial',
          score,
          changes: changes.length > 0 ? changes : null,
          summary: (result.summary as string) || '',
          timestamp: new Date().toISOString(),
        });

        await supabase.from('qb_questions').update({
          adversarial_score: score,
          audit_trail: trail,
        }).eq('id', q.id);

        // Apply fixes if needed
        if (score <= 7 && changes.length > 0) {
          const fixResult = await fixQuestion(q, changes, courseName);
          if (fixResult.fixed && fixResult.question) {
            const fixedQ = fixResult.question;
            const trail2 = [...trail, {
              phase: 'reprocess_adversarial_fix',
              changes_requested: changes,
              changes_applied: fixResult.changesApplied || [],
              timestamp: new Date().toISOString(),
            }];
            await persistFix(q, fixedQ, trail2, changes, jobId);
          }
        }
      }

      aDone++;
      setStep(jobId, `Adversarial: ${aDone}/${aBatches.length} batches done`);
      await pushProgress(jobId);
    });

    await runWithConcurrency(aTasks, MAX_CONCURRENT);
    setStep(jobId, `Adversarial complete for ${forAdversarial.length} questions`);

    // ── Phase 5: Re-audit ──
    setState(jobId, { phase: 'auditing' });
    setStep(jobId, `Re-auditing ${total} questions...`);
    await pushProgress(jobId);

    // Re-fetch all flagged (includes those still without images)
    const { data: preAuditQs } = await supabase
      .from('qb_questions')
      .select('*')
      .in('id', flaggedIds)
      .order('question_number', { ascending: true });

    const toAudit = (preAuditQs || questionsToFix) as Record<string, unknown>[];
    const auditBatches = chunk(toAudit, BATCH_SIZE);
    let reApproved = 0;
    let stillFlagged = 0;
    let needsReview = 0;
    let auditDone = 0;

    const auditTasks = auditBatches.map((batch, bi) => async () => {
      setStep(jobId, `[Audit] Batch ${bi + 1}/${auditBatches.length}: scoring ${batch.length} questions...`);

      const results = await runAuditBatch(batch);

      for (let i = 0; i < batch.length; i++) {
        const q = batch[i];
        const result = results[i];
        const rawScore = result?.quality_score;

        // Audit returned no usable score — empty/truncated review, not a real
        // quality problem. Don't fabricate a score-5 flag (the false-flag loop
        // that could never clear). Mark 'needs_review' so it's excluded from the
        // flagged count but retried on the next reprocess pass.
        if (rawScore == null) {
          const nrTrail = Array.isArray(q.audit_trail) ? [...(q.audit_trail as unknown[])] : [];
          nrTrail.push({
            phase: 'reprocess_audit_failed',
            reason: 'No score returned (empty or truncated review response)',
            timestamp: new Date().toISOString(),
          });
          await supabase.from('qb_questions').update({
            status: 'needs_review',
            audit_trail: nrTrail,
          }).eq('id', q.id);
          needsReview++;
          continue;
        }

        const auditScore = rawScore as number;
        const newStatus = auditScore >= 7 ? 'approved' : 'flagged';

        const vScore = (q.validator_score as number) || 0;
        const aScore = (q.adversarial_score as number) || 0;
        const combinedScore = vScore && aScore
          ? Math.round(((vScore + aScore + auditScore) / 3) * 10) / 10
          : auditScore;

        const trail = Array.isArray(q.audit_trail) ? [...(q.audit_trail as unknown[])] : [];
        trail.push({
          phase: 'reprocess_audit',
          score: auditScore,
          combined_score: combinedScore,
          reason: (result.reason as string) || '',
          issues: (result.issues as string[]) || [],
          timestamp: new Date().toISOString(),
        });

        await supabase.from('qb_questions').update({
          quality_score: auditScore,
          combined_score: combinedScore,
          status: newStatus,
          audit_trail: trail,
        }).eq('id', q.id);

        if (newStatus === 'approved') reApproved++;
        else stillFlagged++;
      }

      auditDone++;
      setState(jobId, { reApproved, stillFlagged, needsReview });
      setStep(jobId, `Audit: ${auditDone}/${auditBatches.length} batches — ${reApproved} approved, ${stillFlagged} still flagged${needsReview ? `, ${needsReview} need re-review` : ''}`);
      await pushProgress(jobId);
    });

    await runWithConcurrency(auditTasks, MAX_CONCURRENT);

    // ── Finalize ──
    const nrSuffix = needsReview ? `, ${needsReview} need re-review (review call failed)` : '';
    const finalMsg = `Reprocess complete — ${reApproved}/${total} recovered (approved), ${stillFlagged} still flagged${nrSuffix}`;
    setStep(jobId, finalMsg);
    setState(jobId, { status: 'complete', phase: 'done', reApproved, stillFlagged, needsReview });

    // Update job — keep status as 'complete', update progress
    await supabase.from('qb_jobs').update({
      status: 'complete',
      progress: {
        reprocess: true,
        phase: 'done',
        step: finalMsg,
        total,
        fixed: totalFixed,
        image_retried: imageRetried,
        re_approved: reApproved,
        still_flagged: stillFlagged,
        needs_review: needsReview,
        events: runningReprocesses.get(jobId)?.events.slice(-10) || [],
      },
    }).eq('id', jobId);

    console.log(`\n✅ Reprocess complete: ${reApproved}/${total} recovered, ${stillFlagged} still flagged, ${needsReview} need re-review\n`);
  } catch (e) {
    console.error(`Reprocess pipeline failed for job ${jobId}:`, e);
    const errMsg = e instanceof Error ? e.message : 'Reprocess failed';
    setStep(jobId, `ERROR: ${errMsg}`);
    setState(jobId, { status: 'failed', phase: 'error' });

    await supabase.from('qb_jobs').update({
      progress: { reprocess: true, phase: 'error', step: errMsg },
    }).eq('id', jobId);
  }
}

// ── Entry point: start or poll ──

export async function reprocessFlaggedForJob(jobId: string): Promise<{
  status: string;
  phase: string;
  step: string;
  total: number;
  processed: number;
  fixed: number;
  imageRetried: number;
  reApproved: number;
  stillFlagged: number;
  needsReview?: number;
  events: string[];
}> {
  const cached = runningReprocesses.get(jobId);
  if (cached) {
    if (cached.status === 'complete' || cached.status === 'failed') {
      runningReprocesses.delete(jobId);
    }
    return {
      status: cached.status,
      phase: cached.phase,
      step: cached.step,
      total: cached.total,
      processed: cached.processed,
      fixed: cached.fixed,
      imageRetried: cached.imageRetried,
      reApproved: cached.reApproved,
      stillFlagged: cached.stillFlagged,
      events: cached.events.slice(-15),
    };
  }

  // Count effectively flagged questions (same logic as displayStatus in UI).
  // Paginate so the count is correct on jobs with >1000 questions.
  const candidates = await fetchAllRows<Record<string, any>>((from, to) =>
    supabase
      .from('qb_questions')
      .select('status, quality_score, validator_score, adversarial_score')
      .eq('job_id', jobId)
      .in('status', REPROCESS_CANDIDATE_STATUSES)
      .is('replaced_by_id', null)
      .order('id', { ascending: true })
      .range(from, to)
  );

  const total = (candidates || []).filter(isEffectivelyFlagged).length;

  if (total === 0) {
    return {
      status: 'complete', phase: 'done', step: 'No flagged questions to reprocess',
      total: 0, processed: 0, fixed: 0, imageRetried: 0, reApproved: 0, stillFlagged: 0, events: [],
    };
  }

  // Start the pipeline
  runningReprocesses.set(jobId, {
    status: 'running',
    phase: 'init',
    step: `Starting reprocess of ${total} flagged questions...`,
    total,
    processed: 0,
    fixed: 0,
    imageRetried: 0,
    reApproved: 0,
    stillFlagged: 0,
    events: [`Starting reprocess of ${total} flagged questions...`],
  });

  runReprocessPipeline(jobId).catch((e) => {
    console.error('runReprocessPipeline failed:', e);
    const s = runningReprocesses.get(jobId);
    if (s) { s.status = 'failed'; s.phase = 'error'; s.step = e instanceof Error ? e.message : 'Reprocess failed'; }
  });

  return {
    status: 'running',
    phase: 'init',
    step: `Starting reprocess of ${total} flagged questions...`,
    total,
    processed: 0,
    fixed: 0,
    imageRetried: 0,
    reApproved: 0,
    stillFlagged: 0,
    events: [],
  };
}

// Read-only peek at an in-flight reprocess — returns current state WITHOUT
// starting a new run (unlike reprocessFlaggedForJob, which triggers one when
// nothing is cached). Lets the UI re-attach its progress stream after a refresh
// or a dropped connection. Returns null when no reprocess is running for the job.
export function peekReprocess(jobId: string): {
  status: string; phase: string; step: string; total: number;
  processed: number; fixed: number; imageRetried: number;
  reApproved: number; stillFlagged: number; needsReview?: number; events: string[];
} | null {
  const s = runningReprocesses.get(jobId);
  if (!s) return null;
  return {
    status: s.status, phase: s.phase, step: s.step, total: s.total,
    processed: s.processed, fixed: s.fixed, imageRetried: s.imageRetried,
    reApproved: s.reApproved, stillFlagged: s.stillFlagged, needsReview: s.needsReview,
    events: s.events.slice(-15),
  };
}
