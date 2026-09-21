/**
 * Question Snapshots — captures question state at each pipeline stage.
 *
 * Stages: generated, post_validator, post_adversarial, post_audit, post_replace
 */

import { supabase } from '../db/supabase.js';
import { fetchAllRows } from '../db/pagination.js';

export type SnapshotStage = 'generated' | 'post_validator' | 'post_adversarial' | 'post_audit' | 'post_replace';

/** Fields captured in a snapshot */
interface SnapshotData {
  question: string;
  options: Record<string, string>;
  correct_option: string;
  explanation: string;
  subject: string;
  topic: string;
  blooms_level?: string;
  difficulty?: number;
  status: string;
  validator_score?: number;
  adversarial_score?: number;
  quality_score?: number;
  combined_score?: number;
  audit_trail: unknown[];
}

function extractSnapshotData(q: Record<string, unknown>): SnapshotData {
  return {
    question: (q.question as string) || '',
    options: (q.options as Record<string, string>) || {},
    correct_option: (q.correct_option as string) || '',
    explanation: (q.explanation as string) || '',
    subject: (q.subject as string) || '',
    topic: (q.topic as string) || '',
    blooms_level: q.blooms_level as string | undefined,
    difficulty: q.difficulty as number | undefined,
    status: (q.status as string) || '',
    validator_score: q.validator_score as number | undefined,
    adversarial_score: q.adversarial_score as number | undefined,
    quality_score: q.quality_score as number | undefined,
    combined_score: q.combined_score as number | undefined,
    audit_trail: (q.audit_trail as unknown[]) || [],
  };
}

/**
 * Save snapshots for a batch of questions at the given stage.
 * Uses upsert so re-running a stage overwrites previous snapshot.
 */
export async function saveSnapshots(
  jobId: string,
  stage: SnapshotStage,
  questions: Record<string, unknown>[]
): Promise<void> {
  if (questions.length === 0) return;

  const rows = questions.map((q) => ({
    question_id: q.id as string,
    job_id: jobId,
    stage,
    data: extractSnapshotData(q),
  }));

  // Batch insert in chunks of 100 to avoid payload limits
  for (let i = 0; i < rows.length; i += 100) {
    const batch = rows.slice(i, i + 100);
    const { error } = await supabase
      .from('qb_question_snapshots')
      .upsert(batch, { onConflict: 'question_id,stage' });
    if (error) {
      console.error(`Snapshot save error (${stage}, batch ${i}):`, error.message);
    }
  }
}

/**
 * Save snapshots for all questions in a job at the given stage.
 * Fetches questions from DB and saves their current state.
 */
export async function saveJobSnapshots(jobId: string, stage: SnapshotStage): Promise<void> {
  // Paginate. PostgREST caps a plain select at 1000 rows, so a job larger than that
  // was silently snapshotting only its first 1000 questions — and a snapshot is the
  // safety net you reach for precisely when a bulk repair went wrong. The CPA job
  // has 1258 questions and 1000 snapshots; 258 had no recovery point at all.
  let data: Record<string, unknown>[];
  try {
    data = await fetchAllRows<Record<string, unknown>>((from, to) =>
      supabase
        .from('qb_questions')
        .select('*')
        .eq('job_id', jobId)
        .is('replaced_by_id', null)
        .order('question_number', { ascending: true })
        .range(from, to)
    );
  } catch (e) {
    console.error(`Failed to fetch questions for snapshot (${stage}):`, e instanceof Error ? e.message : e);
    return;
  }

  await saveSnapshots(jobId, stage, data);
}

/**
 * Fetch snapshots for a job at a specific stage.
 */
export async function getSnapshots(
  jobId: string,
  stage: SnapshotStage
): Promise<Array<{ question_id: string; data: SnapshotData }>> {
  const { data, error } = await supabase
    .from('qb_question_snapshots')
    .select('question_id, data')
    .eq('job_id', jobId)
    .eq('stage', stage)
    .order('created_at', { ascending: true });

  if (error) {
    console.error(`Failed to fetch snapshots (${stage}):`, error.message);
    return [];
  }

  return (data || []) as Array<{ question_id: string; data: SnapshotData }>;
}

/**
 * Get all available stages for a job.
 */
export async function getAvailableStages(jobId: string): Promise<string[]> {
  const { data, error } = await supabase
    .from('qb_question_snapshots')
    .select('stage')
    .eq('job_id', jobId);

  if (error) return [];
  const stages = new Set((data || []).map((r: { stage: string }) => r.stage));
  return Array.from(stages);
}
