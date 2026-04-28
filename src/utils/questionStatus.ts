/**
 * Derive display status from a question's raw status and quality_score.
 *
 * The review pipeline sets status = "reviewed". The audit pipeline later
 * sets status = "approved" or "flagged". But if audit has run and set a
 * quality_score while status is still "reviewed", we derive the display
 * status from the score: > 7 → approved, ≤ 7 → flagged.
 */
export function displayStatus(q: Record<string, unknown>): string {
  const raw = (q.status as string) || 'generated';
  if (raw === 'reviewed' && q.quality_score != null) {
    return (q.quality_score as number) > 7 ? 'approved' : 'flagged';
  }
  return raw;
}
