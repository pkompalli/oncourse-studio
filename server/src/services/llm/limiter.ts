/**
 * One adaptive cap on LLM calls in flight across the whole process.
 *
 * Parallelism used to be set per stage and per job (LLM_CONCURRENCY batches), and the fixes inside a
 * batch all started at once, so the number of calls actually in flight was unknowable: three jobs at
 * eight batches overran the model's per-minute quota by 150k tokens. Here every call takes a slot, and
 * the number of slots finds the provider's limit by itself:
 *
 *   - slow start: while no rate-limit error has been seen, the limit grows by half each minute in
 *     which the slots were busy;
 *   - a 429 (or an overload 5xx) cuts it to 70% of the calls then in flight, at most once per 30 s,
 *     so a burst of simultaneous refusals counts once;
 *   - after the first cut it grows by 10% a minute again while there are no errors.
 *
 * Off unless LLM_ADAPTIVE=1, so the app server behaves as before. LLM_START (16) and LLM_MAX (256)
 * bound it. A slot is held for the HTTP call only, never during a retry's backoff.
 */

const ENABLED = process.env.LLM_ADAPTIVE === '1';
const MIN = 2;
const MAX = Number(process.env.LLM_MAX) || 256;
let limit = Math.min(MAX, Number(process.env.LLM_START) || 16);
let inFlight = 0;
let seenCongestion = false;
let lastCut = 0;
let lastGrow = Date.now();
let busySince = 0;
const waiters: Array<() => void> = [];

// Per-minute counters for the log line.
let calls = 0, errors429 = 0, tokensIn = 0, tokensOut = 0, peak = 0;
// Successes since the last growth step: the limit rises only on evidence that the current level works.
// Review calls at high effort take several minutes, and growing on 'calls queued' alone raised the
// limit 8 -> 18 in two minutes before a single call had returned.
let okSinceGrow = 0;

function pump() {
  while (inFlight < limit && waiters.length) {
    inFlight++;
    peak = Math.max(peak, inFlight);
    waiters.shift()!();
  }
}

export async function acquire(): Promise<void> {
  if (!ENABLED) return;
  if (inFlight < limit && !waiters.length) { inFlight++; peak = Math.max(peak, inFlight); return; }
  if (!busySince) busySince = Date.now();
  await new Promise<void>((resolve) => waiters.push(resolve));
}

export function release(): void {
  if (!ENABLED) return;
  inFlight = Math.max(0, inFlight - 1);
  if (!waiters.length) busySince = 0;
  pump();
}

/** Record a finished call: its tokens, and whether the provider refused it for load. */
export function report(outcome: { congested?: boolean; tokensIn?: number; tokensOut?: number }): void {
  if (!ENABLED) return;
  calls++;
  if (!outcome.congested) okSinceGrow++;
  tokensIn += outcome.tokensIn ?? 0;
  tokensOut += outcome.tokensOut ?? 0;
  if (!outcome.congested) return;
  errors429++;
  seenCongestion = true;
  const now = Date.now();
  if (now - lastCut < 30000) return;
  lastCut = now;
  lastGrow = now;
  okSinceGrow = 0;
  const next = Math.max(MIN, Math.floor(Math.max(inFlight, 1) * 0.7));
  if (next < limit) {
    console.log(`  [limiter] provider refused for load — limit ${limit} → ${next}`);
    limit = next;
  }
}

// Growth and the minute log. Grows only when the slots were the bottleneck (calls were queued), so an
// idle stretch does not inflate the limit past what has been tested.
if (ENABLED) {
  const timer = setInterval(() => {
    const now = Date.now();
    const queued = waiters.length > 0 || (busySince && now - busySince > 5000);
    // At least half the slots' worth of calls must have come back without refusal since the last step.
    if (queued && okSinceGrow >= Math.ceil(limit / 2) && now - lastGrow >= 60000 && now - lastCut >= 60000 && limit < MAX) {
      const next = Math.min(MAX, seenCongestion ? Math.ceil(limit * 1.1) : Math.ceil(limit * 1.5));
      if (next > limit) { console.log(`  [limiter] ${okSinceGrow} calls succeeded, calls queued — limit ${limit} → ${next}`); limit = next; pump(); }
      lastGrow = now;
      okSinceGrow = 0;
    }
    if (calls || inFlight) {
      console.log(`  [limiter] limit ${limit} | in flight ${inFlight} (peak ${peak}) | queued ${waiters.length} | calls/min ${calls} | 429/min ${errors429} | tokens/min in ${tokensIn} out ${tokensOut}`);
    }
    calls = 0; errors429 = 0; tokensIn = 0; tokensOut = 0; peak = inFlight;
  }, 60000);
  timer.unref();
  console.log(`[limiter] adaptive LLM concurrency on — start ${limit}, max ${MAX}`);
}

export const limiterEnabled = ENABLED;
