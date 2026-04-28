/**
 * Audit Pipeline — V2 Step 4
 *
 * Single-pass GPT-5.4 scoring of reviewed questions.
 * Score > 7 → approved, ≤ 7 → flagged.
 * Combined score = (validator_score + adversarial_score) / 2, capped at 10.
 */

import { supabase } from '../../db/supabase.js';
import { orCall, MODELS } from '../llm/openrouter.js';
import type { ContentPart } from '../llm/openrouter.js';
import { formatQuestionsForReviewWithImages, extractJsonArray } from '../review/shared.js';
import { saveJobSnapshots } from '../snapshots.js';

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

function getAuditPrompt(): string {
  return `You are a final quality gate auditor for medical exam questions.

You will receive questions that have already passed validator and adversarial review.
Your job is a FINAL holistic quality check — one combined score per question.

Score each question 1-10 based on:
1. Factual accuracy of the correct answer and explanation
2. Quality and plausibility of distractors
3. Clinical relevance and educational value
4. Clarity and unambiguity of the question stem
5. Image completeness — if marked as IMAGE: MISSING, the question is UNUSABLE and must score ≤ 4
6. Overall exam-readiness

Scoring guide:
• 9-10: Exam-ready, no changes needed
• 8: Minor polish possible but acceptable
• 7: Borderline — could pass but has notable weakness
• 5-6: Needs improvement before use
• 1-4: Unacceptable — factual errors, ambiguity, or poor construction

For each question, provide:
- quality_score (1-10)
- status: "approved" if score > 7, "flagged" if score <= 7
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

// ── Run audit on a batch ──

async function runAuditBatch(questions: Record<string, unknown>[]): Promise<Record<string, unknown>[]> {
  const prompt = getAuditPrompt();
  const content = formatQuestionsForReviewWithImages(questions);

  let userMessage: string | ContentPart[];
  if (typeof content === 'string') {
    userMessage = `${prompt}\n\nQuestions to audit:\n${content}`;
  } else {
    userMessage = [
      { type: 'text', text: `${prompt}\n\nQuestions to audit:\n` },
      ...content,
    ];
  }

  const response = await orCall(MODELS.AUDITOR, '', userMessage, {
    maxTokens: 4000,
    temperature: 0.2,
  });

  let results = extractJsonArray(response.content, questions.length);

  if (results.length < questions.length) {
    console.log(`  [Audit] Short response (${results.length}/${questions.length}), retrying...`);
    const response2 = await orCall(MODELS.AUDITOR, '', userMessage, {
      maxTokens: 4000,
      temperature: 0.1,
    });
    const results2 = extractJsonArray(response2.content, questions.length);
    if (results2.length > results.length) results = results2;
  }

  return results;
}

// ── Main pipeline ──

async function runAuditPipeline(jobId: string): Promise<void> {
  try {
    setStep(jobId, 'Fetching reviewed questions...');

    const { data: questions, error } = await supabase
      .from('qb_questions').select('*')
      .eq('job_id', jobId).eq('status', 'reviewed')
      .is('replaced_by_id', null)
      .order('question_number', { ascending: true });

    if (error) throw new Error(error.message);
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
    let batchesDone = 0;

    setState(jobId, { batchesTotal, batchesDone: 0 });
    setStep(jobId, `Audit: sending ${batchesTotal} batches (${total} Qs) to GPT-5.4`);
    await pushProgress(jobId);

    const batchTasks = batches.map((batch, batchIdx) => async () => {
      const batchNum = batchIdx + 1;
      const qStart = batchIdx * AUDIT_BATCH_SIZE + 1;
      const qEnd = qStart + batch.length - 1;

      setStep(jobId, `[Audit] Batch ${batchNum}/${batchesTotal}: scoring Q${qStart}–Q${qEnd} via GPT-5.4...`);

      const results = await runAuditBatch(batch);

      setStep(jobId, `[Audit] Batch ${batchNum}/${batchesTotal}: processing scores for Q${qStart}–Q${qEnd}`);

      for (let i = 0; i < batch.length; i++) {
        const q = batch[i];
        const result = results[i] || {};
        const auditScore = (result.quality_score as number) || 5;

        // Combined score: average of validator + adversarial + audit, or just audit if others missing
        const vScore = (q.validator_score as number) || 0;
        const aScore = (q.adversarial_score as number) || 0;
        const combinedScore = vScore && aScore
          ? Math.round(((vScore + aScore + auditScore) / 3) * 10) / 10
          : auditScore;

        const status = auditScore > 7 ? 'approved' : 'flagged';

        const trail = Array.isArray(q.audit_trail) ? [...(q.audit_trail as unknown[])] : [];
        trail.push({
          phase: 'audit',
          score: auditScore,
          combined_score: combinedScore,
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
        const sc = (r?.quality_score as number) || 5;
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
    const finalMsg = `Audit complete — ${totalApproved} approved, ${totalFlagged} flagged out of ${total}.`;
    setStep(jobId, finalMsg);

    await supabase.from('qb_jobs').update({
      status: nextStatus,
      progress: {
        step: finalMsg,
        audited: totalAudited, approved: totalApproved, flagged: totalFlagged, total,
        events: runningAudits.get(jobId)?.events.slice(-10) || [],
        subjects: runningAudits.get(jobId)?.subjects || [],
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
  const cached = runningAudits.get(jobId);
  if (cached) {
    if (cached.status === 'complete') runningAudits.delete(jobId);
    return {
      status: cached.status, step: cached.step,
      audited: cached.audited, approved: cached.approved, flagged: cached.flagged, total: cached.total,
      batches_total: cached.batchesTotal, batches_done: cached.batchesDone,
      events: cached.events.slice(-15),
      subjects: cached.subjects,
    };
  }

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
