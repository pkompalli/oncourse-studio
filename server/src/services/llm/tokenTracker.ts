/**
 * Per-job token usage tracker.
 * Pipeline steps call start/stop, and brCall automatically accumulates tokens.
 */

export interface TokenUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  calls: number;
}

const activeJob = { jobId: '', step: '' };
const jobTokens = new Map<string, Map<string, TokenUsage>>();

/** Start tracking tokens for a job+step. */
export function startTracking(jobId: string, step: string) {
  activeJob.jobId = jobId;
  activeJob.step = step;
  if (!jobTokens.has(jobId)) jobTokens.set(jobId, new Map());
  const steps = jobTokens.get(jobId)!;
  if (!steps.has(step)) steps.set(step, { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0, calls: 0 });
}

/** Add token usage from an LLM call (called automatically by brCall). */
export function addTokens(prompt: number, completion: number) {
  if (!activeJob.jobId || !activeJob.step) return;
  const steps = jobTokens.get(activeJob.jobId);
  if (!steps) return;
  const usage = steps.get(activeJob.step);
  if (!usage) return;
  usage.prompt_tokens += prompt;
  usage.completion_tokens += completion;
  usage.total_tokens += prompt + completion;
  usage.calls += 1;
}

/** Get token usage for a specific step. */
export function getStepTokens(jobId: string, step: string): TokenUsage | null {
  return jobTokens.get(jobId)?.get(step) || null;
}

/** Get all step token usage for a job. */
export function getJobTokens(jobId: string): Record<string, TokenUsage> {
  const steps = jobTokens.get(jobId);
  if (!steps) return {};
  const result: Record<string, TokenUsage> = {};
  steps.forEach((v, k) => { result[k] = { ...v }; });
  return result;
}

/** Clean up tracking data for a completed job. */
export function clearJobTokens(jobId: string) {
  jobTokens.delete(jobId);
}
