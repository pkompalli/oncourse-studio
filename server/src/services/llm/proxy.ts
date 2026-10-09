/**
 * ai-proxy LLM Client
 *
 * Every call goes to the shared ai-proxy (OpenAI Responses API) as GPT 6.1 Sol at high
 * reasoning effort, through the AI SDK's OpenAI provider.
 */

import { createOpenAI } from '@ai-sdk/openai';
import { APICallError, NoObjectGeneratedError, Output, streamText } from 'ai';
import type { FinishReason, LanguageModelUsage } from 'ai';
import type { LLMResponse, ContentPart } from './openrouter.js';
import { addTokens } from './tokenTracker.js';
import { acquire, release, report } from './limiter.js';

const proxy = createOpenAI({
  baseURL: process.env.AI_PROXY_URL,
  apiKey: process.env.AI_PROXY_KEY,
});

// ── Model config ──

const SOL = 'gpt-6.1-sol';

export const MODELS = {
  GENERATOR: SOL,
  VALIDATOR: SOL,
  ADVERSARIAL: SOL,
  AUDITOR: SOL,
  FIXER: SOL,
  STRUCTURE: SOL,
};

// High effort spends output tokens on reasoning before any answer text appears, so a call
// can use its whole max_output_tokens budget and return EMPTY text. Callers parse '' into
// zero results and every question in the batch lands in needs_review with no error logged.
// The guard below retries such a call once with a bigger budget.
// LLM_REASONING_EFFORT overrides it for one run: the USMLE full run uses 'low', the setting every pilot
// and the 150-question batch were validated on; high made a ten-question review take 17 minutes.
const REASONING_EFFORT = (['minimal', 'low', 'medium', 'high'].includes(String(process.env.LLM_REASONING_EFFORT))
  ? process.env.LLM_REASONING_EFFORT : 'high') as 'minimal' | 'low' | 'medium' | 'high';
/** Smallest budget for the retry after an empty, reasoning-exhausted answer. */
const EMPTY_ANSWER_RETRY_TOKENS = 32000;
/** No retry once a call already had this much; an empty answer at this size is not a budget problem. */
const EMPTY_ANSWER_MAX_TOKENS = 64000;

console.log(`[ai-proxy] ${process.env.AI_PROXY_URL || '(AI_PROXY_URL not set)'} — ${SOL}, effort=${REASONING_EFFORT}`);
if (!process.env.AI_PROXY_KEY) console.warn('[ai-proxy] AI_PROXY_KEY not set — LLM calls will fail');

// ── Retry config ──

const MAX_RETRIES = 3;
const INITIAL_BACKOFF_MS = 2000;
// A quota is per minute, so a 2–8 s backoff retries straight into the same window: the 150-question
// USMLE batch hit 513 quota errors and lost 42 fixes that way. Quota errors wait 15 s, doubling to 120 s.
const QUOTA_RETRIES = 6;
const QUOTA_BACKOFF_MS = 15000;
const statusOf = (e: unknown) => (APICallError.isInstance(e) ? e.statusCode : undefined);
// The proxy's own capacity errors are quota errors too: "503 auth_unavailable: no auth available"
// means every upstream account is busy, and "507 exceeded request buffer limit" a large request it
// could not hold while retrying upstream. Retried on the 2–8 s schedule, the first full-run attempt
// lost its calls within a minute; they need the quota backoff.
const isQuotaError = (e: unknown, msg: string) =>
  statusOf(e) === 429 || statusOf(e) === 507 || /\b429\b|quota|Too Many Requests|rate limit|auth_unavailable|no auth available|request buffer limit|overloaded/i.test(msg);
const isAuthError = (e: unknown) => statusOf(e) === 401 || statusOf(e) === 403;

/**
 * Is this error worth retrying?
 *
 * undici surfaces network faults as a bare `TypeError: fetch failed` and hides the
 * real reason in `error.cause` (HeadersTimeoutError / UND_ERR_HEADERS_TIMEOUT,
 * socket hang up, ECONNREFUSED…). The old whitelist matched only the top-level
 * message, so a transient blip on a long call threw straight out with no retry —
 * which is how a single hiccup could kill an entire guidelines generation.
 */
function isTransientLlmError(e: unknown): boolean {
  const status = statusOf(e);
  if (status != null) return status === 408 || status === 429 || status >= 500;
  const err = e as { message?: string; code?: string; cause?: { message?: string; code?: string } };
  const blob = [err?.message, err?.code, err?.cause?.message, err?.cause?.code]
    .filter(Boolean).join(' | ');
  // A streamed call reports the provider's errors inside the stream, with no HTTP status ("Our servers
  // are currently overloaded", "stream disconnected before completion"); they were thrown at once.
  return /overloaded|stream error|stream disconnected|stream closed|response\.completed|server_error|429|\b5\d\d\b|ServiceUnavailable|ETIMEDOUT|ECONNRESET|fetch failed|HeadersTimeout|BodyTimeout|UND_ERR|socket hang up|ECONNREFUSED|ENOTFOUND|EPIPE|network|terminated|AbortError/i
    .test(blob);
}

/**
 * Error text with the HTTP status, and never the request headers (they carry the key). The proxy's
 * own errors ({"error":"Invalid API key"}) are not in OpenAI's shape, so the SDK leaves the message
 * empty; fall back to the response body.
 */
function describeError(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  if (!APICallError.isInstance(e)) return msg;
  return `ai-proxy ${e.statusCode ?? '?'}: ${msg.trim() || e.responseBody?.slice(0, 300) || '(no body)'}`;
}

// ── Prompt building ──

/** Our OpenAI-style content parts → AI SDK user content (text parts, and file parts for images). */
function toUserContent(parts: ContentPart[]) {
  return parts.map((p) => {
    if (p.type === 'text') return { type: 'text' as const, text: p.text };
    if (p.type === 'image_url') {
      const u = p.image_url.url;
      // Decode data URLs to bytes ourselves so the AI SDK never makes a network
      // download (which throws AI_DownloadError on a transient failure and crashes
      // the whole call). Callers pre-fetch images to data URLs; an http(s) URL is
      // passed through to the proxy as an image URL.
      if (u.startsWith('data:')) {
        const mediaType = u.slice(5, u.indexOf(';'));
        const b64 = u.slice(u.indexOf(',') + 1);
        return { type: 'file' as const, data: Buffer.from(b64, 'base64'), mediaType: mediaType || 'image' };
      }
      return { type: 'file' as const, data: new URL(u), mediaType: 'image' };
    }
    return { type: 'text' as const, text: '' };
  });
}

// ── Main call function ──

export async function proxyCall(
  model: string,
  systemPrompt: string,
  userPrompt: string | ContentPart[],
  options?: {
    temperature?: number;
    maxTokens?: number;
    jsonMode?: boolean;
  }
): Promise<LLMResponse> {
  const maxOut = options?.maxTokens ?? 4096;

  // Quota errors get more attempts than other transient errors (see QUOTA_RETRIES); the catch stops the rest at MAX_RETRIES.
  for (let attempt = 0; attempt <= QUOTA_RETRIES; attempt++) {
    let text: string;
    let usage: LanguageModelUsage | undefined;
    let finishReason: FinishReason | undefined;

    // One slot of the process-wide cap (limiter.ts) for the HTTP call itself; released before any backoff.
    await acquire();
    try {
      // Reasoning models (Sol) don't support temperature — options.temperature is ignored.
      const common = {
        model: proxy.responses(model),
        system: systemPrompt || undefined,
        maxOutputTokens: maxOut,
        maxRetries: 0, // retries are handled below, with the quota backoff
        // reasoningSummary: null — the SDK asks for a 'detailed' summary by default; nothing reads it.
        providerOptions: { openai: { reasoningEffort: REASONING_EFFORT, reasoningSummary: null } },
        ...(options?.jsonMode ? { output: Output.json() } : {}),
      };

      // Streamed, then collected. The proxy sits behind Cloudflare, which ends a request with 524 when
      // the origin sends nothing for 100 s; a high-effort review of ten questions takes minutes, so
      // every review call of the first full run timed out. A stream sends headers and events at once.
      let streamErr: unknown;
      const stream = typeof userPrompt === 'string'
        ? streamText({ ...common, prompt: userPrompt, onError: ({ error }) => { streamErr = error; } })
        : streamText({ ...common, messages: [{ role: 'user' as const, content: toUserContent(userPrompt) }], onError: ({ error }) => { streamErr = error; } });
      let result: { text: string; usage: LanguageModelUsage; finishReason: FinishReason };
      try {
        const [t, u, f] = await Promise.all([stream.text, stream.usage, stream.finishReason]);
        result = { text: t, usage: u, finishReason: f };
      } catch (e) {
        throw streamErr ?? e;
      }
      if (streamErr) throw streamErr;
      release();
      report({ tokensIn: result.usage?.inputTokens, tokensOut: result.usage?.outputTokens });
      text = result.text;
      usage = result.usage;
      finishReason = result.finishReason;
    } catch (e) {
      release();
      const st = statusOf(e);
      report({ failed: !NoObjectGeneratedError.isInstance(e), congested: st === 429 || st === 502 || st === 503 || st === 504 || st === 507 || isQuotaError(e, describeError(e)) });
      if (NoObjectGeneratedError.isInstance(e)) {
        // JSON mode parses the answer, and throws when it is cut off or malformed. Callers
        // have always received the raw text and repair truncated JSON themselves, so hand
        // it back rather than failing the call.
        text = e.text ?? '';
        usage = e.usage;
        finishReason = e.finishReason;
      } else {
        const errMsg = describeError(e);

        if (isAuthError(e)) {
          throw new Error(`ai-proxy auth error: ${errMsg}`);
        }

        const quota = isQuotaError(e, errMsg);
        if (attempt < (quota ? QUOTA_RETRIES : MAX_RETRIES) && isTransientLlmError(e)) {
          const delay = quota
            ? Math.min(QUOTA_BACKOFF_MS * Math.pow(2, attempt), 120000) + Math.floor(Math.random() * 5000)
            : INITIAL_BACKOFF_MS * Math.pow(2, attempt);
          console.log(`  [ai-proxy] ${errMsg.slice(0, 80)} — retry ${attempt + 1} in ${delay}ms`);
          await new Promise((r) => setTimeout(r, delay));
          continue;
        }

        throw new Error(errMsg, { cause: e });
      }
    }

    const pt = usage?.inputTokens ?? 0;
    const ct = usage?.outputTokens ?? 0;
    addTokens(pt, ct);

    // An empty answer that hit the output cap is reasoning exhaustion, not a quality signal.
    // Say so, and buy the answer back with a bigger budget.
    if (!text && (finishReason === 'length' || ct >= maxOut * 0.95) && maxOut < EMPTY_ANSWER_MAX_TOKENS) {
      const retryTokens = Math.min(Math.max(EMPTY_ANSWER_RETRY_TOKENS, maxOut * 2), EMPTY_ANSWER_MAX_TOKENS);
      console.warn(
        `  [ai-proxy] ${model} returned EMPTY text after ${ct}/${maxOut} output tokens ` +
        `(reasoning consumed the budget on a ${pt}-token prompt) — retrying with ${retryTokens}`
      );
      return proxyCall(model, systemPrompt, userPrompt, { ...options, maxTokens: retryTokens });
    }

    return {
      content: text,
      model,
      usage: usage ? { prompt_tokens: pt, completion_tokens: ct } : undefined,
    };
  }

  throw new Error('No response from ai-proxy after retries');
}
