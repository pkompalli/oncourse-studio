import { useState, useEffect } from 'react';
import { questions as questionsApi } from '../services/api';
import type { Question } from '../types';

export type SnapshotStage = 'generated' | 'post_validator' | 'post_adversarial' | 'post_audit' | 'post_replace';

export const STAGE_LABELS: Record<SnapshotStage, string> = {
  generated: 'Generated',
  post_validator: 'Post Validator',
  post_adversarial: 'Post Adversarial',
  post_audit: 'Post Audit',
  post_replace: 'Post Replace',
};

interface SnapshotQuestion {
  question_id: string;
  question: string;
  options: Record<string, string>;
  correct_option: string;
  explanation: string;
  subject: string;
  topic: string;
  status: string;
  blooms_level?: string;
  difficulty?: number;
  validator_score?: number;
  adversarial_score?: number;
  quality_score?: number;
  combined_score?: number;
  audit_trail: unknown[];
}

/**
 * Hook to load question snapshots for a specific stage.
 * Returns snapshot questions grouped by subject, or null if no snapshots exist.
 */
export function useSnapshots(jobId: string | undefined, stage: SnapshotStage | null) {
  const [snapshotQuestions, setSnapshotQuestions] = useState<SnapshotQuestion[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [availableStages, setAvailableStages] = useState<string[]>([]);

  // Load available stages
  useEffect(() => {
    if (!jobId) return;
    questionsApi.availableStages(jobId)
      .then((res) => setAvailableStages(res.stages || []))
      .catch(() => {});
  }, [jobId]);

  // Load snapshots for selected stage
  useEffect(() => {
    if (!jobId || !stage) {
      setSnapshotQuestions(null);
      return;
    }

    setLoading(true);
    questionsApi.snapshots(jobId, stage)
      .then((res) => {
        if (res.snapshots && res.snapshots.length > 0) {
          setSnapshotQuestions(
            res.snapshots.map((s) => ({
              question_id: s.question_id,
              ...(s.data as Omit<SnapshotQuestion, 'question_id'>),
            }))
          );
        } else {
          setSnapshotQuestions(null);
        }
      })
      .catch(() => setSnapshotQuestions(null))
      .finally(() => setLoading(false));
  }, [jobId, stage]);

  return { snapshotQuestions, loading, availableStages };
}

/**
 * Build a subject map from snapshot questions (same structure as Question[]).
 */
export function groupSnapshotsBySubject(snapshots: SnapshotQuestion[]): Map<string, SnapshotQuestion[]> {
  const map = new Map<string, SnapshotQuestion[]>();
  for (const s of snapshots) {
    const subj = s.subject || 'Unknown';
    if (!map.has(subj)) map.set(subj, []);
    map.get(subj)!.push(s);
  }
  return map;
}
