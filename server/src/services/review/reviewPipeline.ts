/**
 * Review Pipeline Orchestrator — V2 Step 3
 *
 * Flow:
 *   1. Fetch all questions with status='generated' for the job
 *   2. Phase A — Validator: batch 10, parallel batches, fix flagged inline
 *   3. Phase B — Adversarial: re-fetch (fixed versions), batch 10, parallel, fix inline
 *   4. Mark all questions status='reviewed', job status='auditing'
 */

import { supabase } from '../../db/supabase.js';
import { runValidatorBatch } from './validator.js';
import { runAdversarialBatch } from './adversarial.js';
import { fixQuestion } from './fixer.js';
import { saveJobSnapshots } from '../snapshots.js';
import { regenerateQuestionImage, isImageGenerationAvailable } from '../images/imageGeneration.js';

const REVIEW_BATCH_SIZE = 10;
const MAX_CONCURRENT_BATCHES = 8;

// ── In-memory state — the single source of truth for polling ──
interface SubjectStatus {
  subject: string;
  count: number;
  reviewed: number;
  fixed: number;
  status: 'pending' | 'validator' | 'adversarial' | 'done';
}

interface ReviewState {
  status: 'running' | 'complete' | 'failed';
  phase: 'init' | 'validator_scoring' | 'validator_fixing' | 'adversarial_scoring' | 'adversarial_fixing' | 'finalizing' | 'done' | 'error';
  step: string;           // human-readable current step, always up-to-date
  reviewed: number;
  fixed: number;
  total: number;
  batchesTotal: number;
  batchesDone: number;
  events: string[];
  subjects: SubjectStatus[];
}

const runningReviews = new Map<string, ReviewState>();

// Update the step message — this is what the poll endpoint reads instantly
function setStep(jobId: string, step: string) {
  const s = runningReviews.get(jobId);
  if (s) {
    s.step = step;
    s.events.push(step);
    if (s.events.length > 30) s.events = s.events.slice(-30);
  }
}

function setState(jobId: string, updates: Partial<ReviewState>) {
  const s = runningReviews.get(jobId);
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

async function fetchJobQuestions(jobId: string, status?: string): Promise<Record<string, unknown>[]> {
  let query = supabase.from('qb_questions').select('*')
    .eq('job_id', jobId).is('replaced_by_id', null)
    .order('question_number', { ascending: true });
  if (status) query = query.eq('status', status);
  const { data, error } = await query;
  if (error) throw new Error(error.message);
  return (data || []) as Record<string, unknown>[];
}

async function getCourseName(jobId: string): Promise<string> {
  const { data: job } = await supabase.from('qb_jobs').select('course_id').eq('id', jobId).single();
  if (!job) return 'Unknown';
  const { data: course } = await supabase.from('qb_courses').select('name').eq('id', job.course_id).single();
  return (course?.name as string) || 'Unknown';
}

function buildSubjectMap(questions: Record<string, unknown>[]): SubjectStatus[] {
  const map = new Map<string, number>();
  for (const q of questions) {
    const subj = (q.subject as string) || 'Unknown';
    map.set(subj, (map.get(subj) || 0) + 1);
  }
  return Array.from(map.entries()).map(([subject, count]) => ({
    subject, count, reviewed: 0, fixed: 0, status: 'pending' as const,
  }));
}

// Detect image-related changes in changes_required (e.g., "Replace the attached chest X-ray...")
const IMAGE_CHANGE_RE = /\b(replace\s+(the\s+)?(attached|current|provided|existing)?\s*(image|x-?ray|ct|mri|scan|radiograph|photo|figure|picture|illustration))|(\b(image|x-?ray|radiograph|scan|figure)\b.*\b(replace|regenerate|update|redo|change|swap))/i;

function isImageRelatedChange(change: string): boolean {
  return IMAGE_CHANGE_RE.test(change);
}

function updateSubjectProgress(jobId: string, subject: string, phase: 'validator' | 'adversarial' | 'done', reviewed: number, fixed: number) {
  const s = runningReviews.get(jobId);
  if (!s) return;
  const subj = s.subjects.find((x) => x.subject === subject);
  if (subj) {
    subj.reviewed += reviewed;
    subj.fixed += fixed;
    if (phase === 'done') subj.status = 'done';
    else if (subj.status === 'pending' || phase === 'adversarial') subj.status = phase;
  }
}

// Push to Supabase (triggers Realtime for the frontend)
async function pushProgress(jobId: string) {
  const s = runningReviews.get(jobId);
  if (!s) return;
  await supabase.from('qb_jobs').update({
    status: 'reviewing',
    progress: {
      phase: s.phase,
      step: s.step,
      reviewed: s.reviewed,
      fixed: s.fixed,
      total: s.total,
      batches_total: s.batchesTotal,
      batches_done: s.batchesDone,
      events: s.events.slice(-10),
      subjects: s.subjects,
    },
  }).eq('id', jobId);
}

// ── Phase A: Validator ──

async function runValidatorPhase(
  jobId: string,
  questions: Record<string, unknown>[],
  courseName: string
): Promise<{ reviewed: number; fixed: number }> {
  const batches = chunk(questions, REVIEW_BATCH_SIZE);
  let totalReviewed = 0;
  let totalFixed = 0;
  let batchesDone = 0;
  const batchesTotal = batches.length;

  setState(jobId, { phase: 'validator_scoring', batchesTotal, batchesDone: 0 });
  setStep(jobId, `Validator: sending ${batchesTotal} batches (${questions.length} Qs) to GPT-5.4`);
  await pushProgress(jobId);

  const batchTasks = batches.map((batch, batchIdx) => async () => {
    const batchNum = batchIdx + 1;
    const qStart = batchIdx * REVIEW_BATCH_SIZE + 1;
    const qEnd = qStart + batch.length - 1;

    // ── Step: Sending to validator ──
    setStep(jobId, `[Validator] Batch ${batchNum}/${batchesTotal}: sending Q${qStart}–Q${qEnd} to GPT-5.4...`);

    const results = await runValidatorBatch(batch);

    // ── Step: Processing scores ──
    setStep(jobId, `[Validator] Batch ${batchNum}/${batchesTotal}: processing scores for Q${qStart}–Q${qEnd}`);

    const toFix: Array<{ dbId: string; question: Record<string, unknown>; changesRequired: string[] }> = [];
    const imageRegenQueue: Array<{ dbId: string; feedback: string[] }> = [];

    for (let i = 0; i < batch.length; i++) {
      const q = batch[i];
      const result = results[i] || {};
      const score = (result.overall_accuracy_score as number) || 5;
      const changes = (result.changes_required as string[]) || [];
      const assetIssues = (result.asset_issues as string[]) || [];
      const missingImages = (result.missing_images as string[]) || [];

      const trail = Array.isArray(q.audit_trail) ? [...(q.audit_trail as unknown[])] : [];
      trail.push({
        phase: 'validator', score,
        changes: changes.length > 0 ? changes : null,
        summary: (result.summary as string) || '',
        timestamp: new Date().toISOString(),
      });

      await supabase.from('qb_questions').update({ validator_score: score, audit_trail: trail }).eq('id', q.id);
      totalReviewed++;

      // Separate image-related changes from text changes
      const textChanges = changes.filter(c => !isImageRelatedChange(c));
      const imageChanges = changes.filter(c => isImageRelatedChange(c));

      if (score <= 7 && textChanges.length > 0) {
        toFix.push({ dbId: q.id as string, question: q, changesRequired: textChanges });
      }

      // Queue image regeneration if reviewer flagged image issues (from dedicated fields OR changes_required)
      const allImageFeedback = [...assetIssues, ...missingImages, ...imageChanges];
      if (q.is_image_question && allImageFeedback.length > 0) {
        imageRegenQueue.push({ dbId: q.id as string, feedback: allImageFeedback });
      }
    }

    const scoresSummary = results.map((r, i) => {
      const sc = (r?.overall_accuracy_score as number) || 5;
      return `Q${qStart + i}:${sc}`;
    }).join(' ');
    setStep(jobId, `[Validator] Batch ${batchNum}: scores — ${scoresSummary}`);

    // ── Step: Fixing flagged ──
    if (toFix.length > 0) {
      setState(jobId, { phase: 'validator_fixing' });
      setStep(jobId, `[Validator] Batch ${batchNum}: fixing ${toFix.length}/${batch.length} flagged Qs via Claude...`);

      const fixPromises = toFix.map(async (item, fixIdx) => {
        setStep(jobId, `[Validator] Batch ${batchNum}: fixing Q${qStart + fixIdx} (${fixIdx + 1}/${toFix.length})...`);
        const fixResult = await fixQuestion(item.question, item.changesRequired, courseName);
        if (fixResult.fixed && fixResult.question) {
          const fixedQ = fixResult.question;

          // Record before/after in audit_trail
          const { data: current } = await supabase.from('qb_questions')
            .select('question, options, correct_option, explanation, audit_trail')
            .eq('id', item.dbId).single();
          const trail = Array.isArray(current?.audit_trail) ? [...(current.audit_trail as unknown[])] : [];
          trail.push({
            phase: 'validator_fix',
            changes_requested: item.changesRequired,
            before: {
              question: current?.question,
              options: current?.options,
              correct_option: current?.correct_option,
              explanation: current?.explanation,
            },
            after: {
              question: fixedQ.question,
              options: fixedQ.options,
              correct_option: fixedQ.correct_option || fixedQ.correct_answer,
              explanation: fixedQ.explanation,
            },
            timestamp: new Date().toISOString(),
          });

          await supabase.from('qb_questions').update({
            question: fixedQ.question, options: fixedQ.options,
            correct_option: fixedQ.correct_option || fixedQ.correct_answer,
            explanation: fixedQ.explanation,
            audit_trail: trail,
          }).eq('id', item.dbId);
          totalFixed++;
        }
      });
      await Promise.all(fixPromises);
      setStep(jobId, `[Validator] Batch ${batchNum}: ${toFix.length} fixes applied`);
    }

    // ── Step: Regenerate flagged images ──
    if (imageRegenQueue.length > 0 && isImageGenerationAvailable()) {
      setStep(jobId, `[Validator] Batch ${batchNum}: regenerating ${imageRegenQueue.length} flagged images...`);
      await Promise.all(
        imageRegenQueue.map(async (item) => {
          // Capture before image
          const { data: before } = await supabase.from('qb_questions')
            .select('image_url, audit_trail').eq('id', item.dbId).single();
          const oldUrl = before?.image_url || null;

          const success = await regenerateQuestionImage(item.dbId, jobId, item.feedback);

          // Record before/after in audit trail
          const { data: after } = await supabase.from('qb_questions')
            .select('image_url, audit_trail').eq('id', item.dbId).single();
          const trail = Array.isArray(after?.audit_trail) ? [...(after.audit_trail as unknown[])] : [];
          trail.push({
            phase: 'validator_image_fix',
            feedback: item.feedback,
            before_image: oldUrl,
            after_image: success ? after?.image_url : null,
            success,
            timestamp: new Date().toISOString(),
          });
          await supabase.from('qb_questions').update({ audit_trail: trail }).eq('id', item.dbId);
        })
      );
    }

    // Update per-subject progress
    const subjCounts = new Map<string, { reviewed: number; fixed: number }>();
    for (const q of batch) {
      const subj = (q.subject as string) || 'Unknown';
      const entry = subjCounts.get(subj) || { reviewed: 0, fixed: 0 };
      entry.reviewed++;
      subjCounts.set(subj, entry);
    }
    for (const item of toFix) {
      const subj = (item.question.subject as string) || 'Unknown';
      const entry = subjCounts.get(subj);
      if (entry) entry.fixed++;
    }
    for (const [subj, counts] of subjCounts) {
      updateSubjectProgress(jobId, subj, 'validator', counts.reviewed, counts.fixed);
    }

    batchesDone++;
    setState(jobId, { reviewed: totalReviewed, fixed: totalFixed, batchesDone, phase: 'validator_scoring' });
    setStep(jobId, `Validator progress: ${batchesDone}/${batchesTotal} batches done, ${totalReviewed}/${questions.length} scored, ${totalFixed} fixed`);
    await pushProgress(jobId);

    return { reviewed: batch.length, fixed: toFix.length };
  });

  await runWithConcurrency(batchTasks, MAX_CONCURRENT_BATCHES);

  setStep(jobId, `Validator complete: ${totalReviewed} reviewed, ${totalFixed} fixed`);
  return { reviewed: totalReviewed, fixed: totalFixed };
}

// ── Phase B: Adversarial ──

async function runAdversarialPhase(
  jobId: string,
  questions: Record<string, unknown>[],
  courseName: string,
  prevFixed: number
): Promise<{ reviewed: number; fixed: number }> {
  const batches = chunk(questions, REVIEW_BATCH_SIZE);
  let totalReviewed = 0;
  let totalFixed = 0;
  let batchesDone = 0;
  const batchesTotal = batches.length;

  setState(jobId, { phase: 'adversarial_scoring', reviewed: 0, batchesTotal, batchesDone: 0 });
  setStep(jobId, `Adversarial: sending ${batchesTotal} batches (${questions.length} Qs) to GPT-5.4`);
  await pushProgress(jobId);

  const batchTasks = batches.map((batch, batchIdx) => async () => {
    const batchNum = batchIdx + 1;
    const qStart = batchIdx * REVIEW_BATCH_SIZE + 1;
    const qEnd = qStart + batch.length - 1;

    setStep(jobId, `[Adversarial] Batch ${batchNum}/${batchesTotal}: sending Q${qStart}–Q${qEnd} to GPT-5.4...`);

    const results = await runAdversarialBatch(batch);

    setStep(jobId, `[Adversarial] Batch ${batchNum}/${batchesTotal}: processing scores for Q${qStart}–Q${qEnd}`);

    const toFix: Array<{ dbId: string; question: Record<string, unknown>; changesRequired: string[] }> = [];
    const imageRegenQueue: Array<{ dbId: string; feedback: string[] }> = [];

    for (let i = 0; i < batch.length; i++) {
      const q = batch[i];
      const result = results[i] || {};
      const score = (result.adversarial_score as number) || 5;
      const changes = (result.changes_required as string[]) || [];
      const assetIssues = (result.asset_issues as string[]) || [];
      const missingImages = (result.missing_images as string[]) || [];

      const trail = Array.isArray(q.audit_trail) ? [...(q.audit_trail as unknown[])] : [];
      trail.push({
        phase: 'adversarial', score,
        changes: changes.length > 0 ? changes : null,
        summary: (result.summary as string) || '',
        timestamp: new Date().toISOString(),
      });

      await supabase.from('qb_questions').update({ adversarial_score: score, audit_trail: trail }).eq('id', q.id);
      totalReviewed++;

      // Separate image-related changes from text changes
      const textChanges = changes.filter(c => !isImageRelatedChange(c));
      const imageChanges = changes.filter(c => isImageRelatedChange(c));

      if (score <= 7 && textChanges.length > 0) {
        toFix.push({ dbId: q.id as string, question: q, changesRequired: textChanges });
      }

      // Queue image regeneration if reviewer flagged image issues (from dedicated fields OR changes_required)
      const allImageFeedback = [...assetIssues, ...missingImages, ...imageChanges];
      if (q.is_image_question && allImageFeedback.length > 0) {
        imageRegenQueue.push({ dbId: q.id as string, feedback: allImageFeedback });
      }
    }

    const scoresSummary = results.map((r, i) => {
      const sc = (r?.adversarial_score as number) || 5;
      return `Q${qStart + i}:${sc}`;
    }).join(' ');
    setStep(jobId, `[Adversarial] Batch ${batchNum}: scores — ${scoresSummary}`);

    if (toFix.length > 0) {
      setState(jobId, { phase: 'adversarial_fixing' });
      setStep(jobId, `[Adversarial] Batch ${batchNum}: fixing ${toFix.length}/${batch.length} flagged Qs via Claude...`);

      const fixPromises = toFix.map(async (item, fixIdx) => {
        setStep(jobId, `[Adversarial] Batch ${batchNum}: fixing Q${qStart + fixIdx} (${fixIdx + 1}/${toFix.length})...`);
        const fixResult = await fixQuestion(item.question, item.changesRequired, courseName);
        if (fixResult.fixed && fixResult.question) {
          const fixedQ = fixResult.question;

          // Record before/after in audit_trail
          const { data: current } = await supabase.from('qb_questions')
            .select('question, options, correct_option, explanation, audit_trail')
            .eq('id', item.dbId).single();
          const trail = Array.isArray(current?.audit_trail) ? [...(current.audit_trail as unknown[])] : [];
          trail.push({
            phase: 'adversarial_fix',
            changes_requested: item.changesRequired,
            before: {
              question: current?.question,
              options: current?.options,
              correct_option: current?.correct_option,
              explanation: current?.explanation,
            },
            after: {
              question: fixedQ.question,
              options: fixedQ.options,
              correct_option: fixedQ.correct_option || fixedQ.correct_answer,
              explanation: fixedQ.explanation,
            },
            timestamp: new Date().toISOString(),
          });

          await supabase.from('qb_questions').update({
            question: fixedQ.question, options: fixedQ.options,
            correct_option: fixedQ.correct_option || fixedQ.correct_answer,
            explanation: fixedQ.explanation,
            audit_trail: trail,
          }).eq('id', item.dbId);
          totalFixed++;
        }
      });
      await Promise.all(fixPromises);
      setStep(jobId, `[Adversarial] Batch ${batchNum}: ${toFix.length} fixes applied`);
    }

    // ── Step: Regenerate flagged images ──
    if (imageRegenQueue.length > 0 && isImageGenerationAvailable()) {
      setStep(jobId, `[Adversarial] Batch ${batchNum}: regenerating ${imageRegenQueue.length} flagged images...`);
      await Promise.all(
        imageRegenQueue.map(async (item) => {
          const { data: before } = await supabase.from('qb_questions')
            .select('image_url, audit_trail').eq('id', item.dbId).single();
          const oldUrl = before?.image_url || null;

          const success = await regenerateQuestionImage(item.dbId, jobId, item.feedback);

          const { data: after } = await supabase.from('qb_questions')
            .select('image_url, audit_trail').eq('id', item.dbId).single();
          const trail = Array.isArray(after?.audit_trail) ? [...(after.audit_trail as unknown[])] : [];
          trail.push({
            phase: 'adversarial_image_fix',
            feedback: item.feedback,
            before_image: oldUrl,
            after_image: success ? after?.image_url : null,
            success,
            timestamp: new Date().toISOString(),
          });
          await supabase.from('qb_questions').update({ audit_trail: trail }).eq('id', item.dbId);
        })
      );
    }

    // Update per-subject progress
    const subjCounts = new Map<string, { reviewed: number; fixed: number }>();
    for (const q of batch) {
      const subj = (q.subject as string) || 'Unknown';
      const entry = subjCounts.get(subj) || { reviewed: 0, fixed: 0 };
      entry.reviewed++;
      subjCounts.set(subj, entry);
    }
    for (const item of toFix) {
      const subj = (item.question.subject as string) || 'Unknown';
      const entry = subjCounts.get(subj);
      if (entry) entry.fixed++;
    }
    for (const [subj, counts] of subjCounts) {
      updateSubjectProgress(jobId, subj, 'adversarial', counts.reviewed, counts.fixed);
    }

    batchesDone++;
    const allFixed = totalFixed + prevFixed;
    setState(jobId, { reviewed: totalReviewed, fixed: allFixed, batchesDone, phase: 'adversarial_scoring' });
    setStep(jobId, `Adversarial progress: ${batchesDone}/${batchesTotal} batches done, ${totalReviewed}/${questions.length} scored, ${allFixed} total fixed`);
    await pushProgress(jobId);

    return { reviewed: batch.length, fixed: toFix.length };
  });

  await runWithConcurrency(batchTasks, MAX_CONCURRENT_BATCHES);

  setStep(jobId, `Adversarial complete: ${totalReviewed} reviewed, ${totalFixed} new fixes`);
  return { reviewed: totalReviewed, fixed: totalFixed };
}

// ── Main Pipeline ──

async function runReviewPipeline(jobId: string): Promise<void> {
  try {
    setStep(jobId, 'Loading course data...');
    const courseName = await getCourseName(jobId);

    setStep(jobId, 'Fetching generated questions from database...');
    const questions = await fetchJobQuestions(jobId, 'generated');

    if (questions.length === 0) {
      setStep(jobId, 'No generated questions found — skipping to audit');
      await supabase.from('qb_jobs').update({
        status: 'auditing', progress: { phase: 'done', step: 'No questions to review', total: 0 },
      }).eq('id', jobId);
      setState(jobId, { status: 'complete', phase: 'done' });
      return;
    }

    // ── Reset audit_trail to prevent duplicates on re-runs ──
    setStep(jobId, 'Clearing stale review data from any prior runs...');
    for (const q of questions) {
      await supabase.from('qb_questions').update({
        audit_trail: [],
        validator_score: null,
        adversarial_score: null,
        quality_score: null,
        status: 'generated',
      }).eq('id', q.id);
      // Update in-memory copy too
      q.audit_trail = [];
      q.validator_score = null;
      q.adversarial_score = null;
    }

    // ── Pre-screen: auto-fail image questions with missing images (V1 pattern) ──
    const validQuestions: Record<string, unknown>[] = [];
    let structuralFailures = 0;

    for (const q of questions) {
      const isImageQ = q.is_image_question as boolean;
      const hasImage = !!q.image_url;
      const stemRefsImage = /shown\s+(below|above|here)|in\s+the\s+(image|figure|scan|x-?ray|ct|mri)|based\s+on\s+the\s+(image|figure)/i.test((q.question as string) || '');

      if (isImageQ && !hasImage) {
        // Auto-score as structural failure — don't waste LLM calls
        const trail = Array.isArray(q.audit_trail) ? [...(q.audit_trail as unknown[])] : [];
        trail.push({
          phase: 'validator', score: 2,
          summary: 'Structural failure: image question has no image generated — unusable without its image.',
          timestamp: new Date().toISOString(),
        });
        await supabase.from('qb_questions').update({
          validator_score: 2, adversarial_score: 0, audit_trail: trail,
        }).eq('id', q.id);
        structuralFailures++;
        console.log(`   ⚠️  Q${q.question_number}: structural failure — image question with no image`);
      } else if (!isImageQ && stemRefsImage && !hasImage) {
        // Question text references an image but none exists
        const trail = Array.isArray(q.audit_trail) ? [...(q.audit_trail as unknown[])] : [];
        trail.push({
          phase: 'validator', score: 2,
          summary: 'Structural failure: question references an image but none is attached.',
          timestamp: new Date().toISOString(),
        });
        await supabase.from('qb_questions').update({
          validator_score: 2, adversarial_score: 0, audit_trail: trail,
        }).eq('id', q.id);
        structuralFailures++;
        console.log(`   ⚠️  Q${q.question_number}: structural failure — references image but none attached`);
      } else {
        validQuestions.push(q);
      }
    }

    if (structuralFailures > 0) {
      console.log(`   Pre-screen: ${structuralFailures} structural failures (missing images), ${validQuestions.length} questions to review`);
    }

    const total = questions.length;
    const subjects = buildSubjectMap(questions);
    setState(jobId, { total, subjects });
    setStep(jobId, `Found ${total} questions (${structuralFailures} auto-flagged for missing images) across ${subjects.length} subjects for "${courseName}" — starting validator review`);
    await pushProgress(jobId);

    // Phase A — only send valid questions (not structural failures)
    const validatorResult = await runValidatorPhase(jobId, validQuestions, courseName);

    // Save post-validator snapshot
    setStep(jobId, 'Saving post-validator snapshots...');
    await saveJobSnapshots(jobId, 'post_validator').catch((e) => console.error('Snapshot error:', e));

    // Transition to adversarial
    setStep(jobId, 'Validator done. Re-fetching questions with fixes applied for adversarial review...');
    await pushProgress(jobId);

    const freshQuestions = await fetchJobQuestions(jobId);
    // Skip structural failures in adversarial too (already auto-scored)
    const freshValid = freshQuestions.filter(q => {
      if (q.is_image_question && !q.image_url) return false;
      if (!q.is_image_question && !q.image_url && /shown\s+(below|above|here)|in\s+the\s+(image|figure|scan|x-?ray|ct|mri)/i.test((q.question as string) || '')) return false;
      return true;
    });

    // Phase B
    const adversarialResult = await runAdversarialPhase(jobId, freshValid, courseName, validatorResult.fixed);

    // Save post-adversarial snapshot
    setStep(jobId, 'Saving post-adversarial snapshots...');
    await saveJobSnapshots(jobId, 'post_adversarial').catch((e) => console.error('Snapshot error:', e));

    // Finalize — mark all subjects done
    const s = runningReviews.get(jobId);
    if (s) s.subjects.forEach((subj) => { subj.status = 'done'; });
    setState(jobId, { phase: 'finalizing' });
    setStep(jobId, 'Marking all questions as reviewed...');
    await supabase.from('qb_questions').update({ status: 'reviewed' })
      .eq('job_id', jobId).is('replaced_by_id', null);

    const totalFixed = validatorResult.fixed + adversarialResult.fixed;
    const finalMsg = `Review complete — ${total} questions reviewed, ${totalFixed} fixed inline. Ready for audit.`;
    setStep(jobId, finalMsg);

    await supabase.from('qb_jobs').update({
      status: 'auditing',
      progress: {
        phase: 'done', step: finalMsg,
        reviewed: total, fixed: totalFixed, total,
        events: runningReviews.get(jobId)?.events.slice(-10) || [],
      },
    }).eq('id', jobId);

    setState(jobId, { status: 'complete', phase: 'done', reviewed: total, fixed: totalFixed });
    console.log(`\n✅ Review pipeline complete: ${total} reviewed, ${totalFixed} fixed\n`);
  } catch (e) {
    console.error(`Review pipeline failed for job ${jobId}:`, e);
    const errMsg = e instanceof Error ? e.message : 'Review failed';
    setStep(jobId, `ERROR: ${errMsg}`);
    setState(jobId, { status: 'failed', phase: 'error' });

    await supabase.from('qb_jobs').update({
      status: 'failed', error: errMsg,
      progress: { phase: 'error', step: errMsg },
    }).eq('id', jobId);
  }
}

// ── Entry point: start or poll ──

export async function reviewBatchForJob(jobId: string): Promise<{
  status: string; phase: string; step: string;
  reviewed: number; fixed: number; total: number;
  batches_total: number; batches_done: number;
  events: string[];
  subjects: SubjectStatus[];
}> {
  const cached = runningReviews.get(jobId);
  if (cached) {
    if (cached.status === 'complete' || cached.status === 'failed') runningReviews.delete(jobId);
    return {
      status: cached.status, phase: cached.phase, step: cached.step,
      reviewed: cached.reviewed, fixed: cached.fixed, total: cached.total,
      batches_total: cached.batchesTotal, batches_done: cached.batchesDone,
      events: cached.events.slice(-15),
      subjects: cached.subjects,
    };
  }

  // Check DB
  const { data: job, error: jobErr } = await supabase
    .from('qb_jobs').select('status, progress').eq('id', jobId).single();
  if (jobErr) throw new Error(jobErr.message);

  if (job.status === 'auditing' || job.status === 'complete') {
    const p = (job.progress || {}) as Record<string, unknown>;
    return {
      status: 'complete', phase: 'done', step: (p.step as string) || 'Review complete',
      reviewed: (p.reviewed as number) || (p.total as number) || 0,
      fixed: (p.fixed as number) || 0, total: (p.total as number) || 0,
      batches_total: 0, batches_done: 0, events: (p.events as string[]) || [],
      subjects: (p.subjects as SubjectStatus[]) || [],
    };
  }

  // First call — kick off
  const questions = await fetchJobQuestions(jobId);
  const total = questions.length;
  const subjects = buildSubjectMap(questions);

  runningReviews.set(jobId, {
    status: 'running', phase: 'init',
    step: `Initializing review pipeline for ${total} questions...`,
    reviewed: 0, fixed: 0, total,
    batchesTotal: 0, batchesDone: 0,
    events: [`Initializing review pipeline for ${total} questions...`],
    subjects,
  });

  runReviewPipeline(jobId).catch((e) => {
    console.error('runReviewPipeline failed:', e);
    const s = runningReviews.get(jobId);
    if (s) { s.status = 'failed'; s.phase = 'error'; s.step = e instanceof Error ? e.message : 'Review failed'; }
  });

  return {
    status: 'running', phase: 'init',
    step: `Initializing review pipeline for ${total} questions...`,
    reviewed: 0, fixed: 0, total,
    batches_total: 0, batches_done: 0, events: [],
    subjects,
  };
}
