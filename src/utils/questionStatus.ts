/**
 * Derive display status from a question's raw status and scores.
 *
 * Priority:
 *   1. quality_score (set by audit) — >= 7 → approved, < 7 → flagged
 *   2. validator_score + adversarial_score (set by review) — both >= 7 → approved, else flagged
 *   3. Raw status as-is
 */
export function displayStatus(q: Record<string, unknown>): string {
  const raw = (q.status as string) || 'generated';

  if (raw === 'reviewed' || raw === 'approved' || raw === 'flagged') {
    if (q.quality_score != null) {
      return (q.quality_score as number) >= 7 ? 'approved' : 'flagged';
    }
    if (q.validator_score != null && q.adversarial_score != null) {
      const vScore = q.validator_score as number;
      const aScore = q.adversarial_score as number;
      return (vScore >= 7 && aScore >= 7) ? 'approved' : 'flagged';
    }
    if (q.validator_score != null) {
      return (q.validator_score as number) >= 7 ? 'approved' : 'flagged';
    }
  }

  return raw;
}
