/**
 * AWS Bedrock LLM Client
 *
 * Dual-backend:
 *   - GPT 5.6 Sol → Bedrock Mantle /openai/v1/responses (via aws4fetch signing)
 *   - Claude Sonnet 5 → Bedrock Converse API (via @ai-sdk/amazon-bedrock)
 *
 * Supports Anthropic thinking/reasoning mode for review tasks.
 */

import { createAmazonBedrock } from '@ai-sdk/amazon-bedrock';
import { generateText } from 'ai';
import { AwsV4Signer } from 'aws4fetch';
import type { LLMResponse, ContentPart } from './openrouter.js';
import { addTokens } from './tokenTracker.js';

// ── Provider setup (for Claude models via Converse API) ──

const awsRegion = process.env.AWS_REGION || 'us-east-1';
const bedrockRegion = process.env.BR_REGION || 'us-east-1'; // Converse API region (models may not be in AWS_REGION)
const awsAccessKeyId = process.env.AWS_ACCESS_KEY_ID!;
const awsSecretAccessKey = process.env.AWS_SECRET_ACCESS_KEY!;

const bedrock = createAmazonBedrock({
  region: bedrockRegion,
  accessKeyId: awsAccessKeyId,
  secretAccessKey: awsSecretAccessKey,
  ...(process.env.AWS_SESSION_TOKEN ? { sessionToken: process.env.AWS_SESSION_TOKEN } : {}),
});

// ── Model config ──

export const MODELS = {
  GENERATOR: process.env.BR_GENERATOR_MODEL || 'openai.gpt-5.6-sol',          // generation via Mantle
  VALIDATOR: process.env.BR_VALIDATOR_MODEL || 'us.anthropic.claude-sonnet-5', // validator review (with thinking)
  ADVERSARIAL: process.env.BR_ADVERSARIAL_MODEL || 'us.anthropic.claude-sonnet-5',
  AUDITOR: process.env.BR_AUDITOR_MODEL || 'us.anthropic.claude-sonnet-5',
  FIXER: process.env.BR_FIXER_MODEL || 'us.anthropic.claude-sonnet-5',        // apply fixes
  STRUCTURE: process.env.BR_STRUCTURE_MODEL || 'openai.gpt-5.6-sol',          // course structure via Mantle
};

// Which models should use thinking/reasoning (Claude only)
const THINKING_MODELS = new Set([
  MODELS.VALIDATOR,
  MODELS.ADVERSARIAL,
  MODELS.AUDITOR,
]);

// Claude 5 reasons adaptively and shares the output budget with its answer. Left
// uncapped on a large review batch it spends the WHOLE budget thinking and returns
// EMPTY text — measured: 16000/16000 output tokens, 0 characters, 0/10 questions
// scored. maxReasoningEffort is the only cap type 'adaptive' honours (budgetTokens
// is read only under type 'enabled', which this model rejects). At 'low' the same
// batch scores 10/10 using ~6300 tokens INCLUDING the answer.
const REASONING_EFFORT = (process.env.BR_REASONING_EFFORT || 'low') as 'low' | 'medium' | 'high';
/** Budget for the one retry after an empty, reasoning-exhausted answer. */
const EMPTY_ANSWER_RETRY_TOKENS = parseInt(process.env.BR_EMPTY_RETRY_TOKENS || '32000', 10);

// Mantle config
const MANTLE_REGION = process.env.MANTLE_REGION || 'us-east-1';
const MANTLE_BASE = `https://bedrock-mantle.${MANTLE_REGION}.api.aws/openai/v1`;

function isAnthropic(model: string): boolean {
  return model.includes('anthropic');
}

function isMantleModel(model: string): boolean {
  return model.startsWith('openai.');
}

console.log(`[Bedrock] Converse: ${bedrockRegion}, Mantle: ${MANTLE_REGION}`);
console.log(`[Bedrock] Generator: ${MODELS.GENERATOR} (${isMantleModel(MODELS.GENERATOR) ? 'Mantle' : 'Converse'})`);
console.log(`[Bedrock] Reviewer:  ${MODELS.VALIDATOR} (thinking=${THINKING_MODELS.has(MODELS.VALIDATOR)}, effort=${REASONING_EFFORT})`);

// ── Retry config ──

const MAX_RETRIES = 3;
const INITIAL_BACKOFF_MS = 2000;

// ── Mantle call (GPT 5.6 Sol via /openai/v1/responses) ──

async function mantleCall(
  model: string,
  systemPrompt: string,
  userPrompt: string | ContentPart[],
  options?: {
    temperature?: number;
    maxTokens?: number;
    jsonMode?: boolean;
  }
): Promise<LLMResponse> {
  const url = `${MANTLE_BASE}/responses`;

  // Build input for Responses API
  const input: Array<Record<string, unknown>> = [];

  if (systemPrompt) {
    input.push({ role: 'developer', content: systemPrompt });
  }

  if (typeof userPrompt === 'string') {
    input.push({ role: 'user', content: userPrompt });
  } else {
    const parts = userPrompt.map((p) => {
      if (p.type === 'text') return { type: 'input_text', text: p.text };
      if (p.type === 'image_url') return { type: 'input_image', image_url: p.image_url.url };
      return { type: 'input_text', text: '' };
    });
    input.push({ role: 'user', content: parts });
  }

  const reqBody: Record<string, unknown> = {
    model,
    input,
    max_output_tokens: options?.maxTokens ?? 4096,
  };

  // Reasoning models (Sol) don't support temperature — omit it

  if (options?.jsonMode) {
    reqBody.text = { format: { type: 'json_object' } };
  }

  const body = JSON.stringify(reqBody);

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const signer = new AwsV4Signer({
        url,
        method: 'POST',
        body,
        accessKeyId: awsAccessKeyId,
        secretAccessKey: awsSecretAccessKey,
        region: MANTLE_REGION,
        service: 'bedrock-mantle',
      });

      const signed = await signer.sign();
      const headers: Record<string, string> = {};
      signed.headers.forEach((v: string, k: string) => { headers[k] = v; });
      headers['content-type'] = 'application/json';

      const res = await fetch(url, { method: 'POST', headers, body });
      const data = await res.json() as Record<string, unknown>;

      if (!res.ok) {
        const errMsg = (data as { error?: { message?: string } })?.error?.message || JSON.stringify(data);
        throw new Error(`Mantle ${res.status}: ${errMsg}`);
      }

      // Extract text from Responses API output
      let text = '';
      const output = data.output as Array<{ content?: Array<{ text?: string }> }>;
      if (output) {
        for (const item of output) {
          if (item.content) {
            for (const c of item.content) {
              if (c.text) text += c.text;
            }
          }
        }
      }

      const usage = data.usage as { input_tokens?: number; output_tokens?: number } | undefined;
      const pt = usage?.input_tokens || 0;
      const ct = usage?.output_tokens || 0;
      addTokens(pt, ct);

      return {
        content: text,
        model,
        usage: usage ? { prompt_tokens: pt, completion_tokens: ct } : undefined,
      };
    } catch (e) {
      const errMsg = e instanceof Error ? e.message : String(e);

      if (errMsg.includes('403') || errMsg.includes('401') || errMsg.includes('AccessDenied')) {
        throw new Error(`Mantle auth error: ${errMsg}`);
      }

      if (attempt < MAX_RETRIES && isTransientLlmError(e)) {
        const delay = INITIAL_BACKOFF_MS * Math.pow(2, attempt);
        console.log(`  [Mantle] ${errMsg.slice(0, 80)} — retry ${attempt + 1} in ${delay}ms`);
        await new Promise((r) => setTimeout(r, delay));
        continue;
      }

      throw e;
    }
  }

  throw new Error('No response from Mantle after retries');
}

// ── Converse call (Claude via AI SDK) ──

async function converseCall(
  model: string,
  systemPrompt: string,
  userPrompt: string | ContentPart[],
  options?: {
    temperature?: number;
    maxTokens?: number;
    jsonMode?: boolean;
    thinking?: boolean;
  }
): Promise<LLMResponse> {
  const useThinking = options?.thinking ?? THINKING_MODELS.has(model);

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const common = {
        model: bedrock(model),
        system: systemPrompt || undefined,
        maxOutputTokens: options?.maxTokens ?? 4096,
        // Claude 5 rejects temperature outright ("`temperature` is deprecated for
        // this model"), so it must never be sent to an Anthropic model — not just
        // suppressed while thinking is on. Otherwise any thinking:false call to the
        // reviewer throws, including the empty-answer fallback below.
        temperature: (useThinking || isAnthropic(model)) ? undefined : (options?.temperature ?? 0.7),
        ...(useThinking ? {
          providerOptions: {
            bedrock: {
              // Claude 5 REQUIRES type 'adaptive' ('enabled' is rejected outright),
              // and the provider reads budgetTokens only under 'enabled' — so the
              // budgetTokens we used to pass here was silently discarded and
              // reasoning ran uncapped. 'adaptive' takes maxReasoningEffort instead.
              reasoningConfig: { type: 'adaptive', maxReasoningEffort: REASONING_EFFORT },
            },
          },
        } : {}),
      };

      const result = typeof userPrompt === 'string'
        ? await generateText({ ...common, prompt: userPrompt })
        : await generateText({
            ...common,
            messages: [
              { role: 'user' as const, content: userPrompt.map((p) => {
                if (p.type === 'text') return { type: 'text' as const, text: p.text };
                if (p.type === 'image_url') {
                  const u = p.image_url.url;
                  // Decode data URLs to bytes ourselves so the AI SDK never makes a
                  // network download (which throws AI_DownloadError on a transient
                  // failure and crashes the whole call). Callers pre-fetch images to
                  // data URLs; a raw http(s) URL only reaches here as a fallback.
                  if (u.startsWith('data:')) {
                    const b64 = u.slice(u.indexOf(',') + 1);
                    return { type: 'image' as const, image: Buffer.from(b64, 'base64') };
                  }
                  return { type: 'image' as const, image: new URL(u) };
                }
                return { type: 'text' as const, text: '' };
              }) },
            ],
          });

      const pt = result.usage?.inputTokens ?? 0;
      const ct = result.usage?.outputTokens ?? 0;
      addTokens(pt, ct);

      // An empty answer that burned the whole output budget is reasoning exhaustion,
      // not a quality signal. It used to travel silently: callers parse '' into zero
      // results and every question in the batch lands in needs_review with no error
      // anywhere. Say so loudly, and buy the answer back by retrying without thinking
      // — a review scored without reasoning beats no review at all.
      const maxOut = options?.maxTokens ?? 4096;
      if (!result.text && ct >= maxOut * 0.95 && maxOut < EMPTY_ANSWER_RETRY_TOKENS) {
        // Reasoning ate the whole budget and the answer never arrived. This used to
        // travel in total silence: callers parse '' into zero results and every
        // question in the batch lands in needs_review with no error logged anywhere
        // — 28 CFA questions sat in that state. Say so, and buy the answer back with
        // a bigger budget. Turning thinking OFF is NOT a fallback: Claude 5 reasons
        // adaptively regardless, and an empty answer comes back just the same.
        console.warn(
          `  [Bedrock] ${model} returned EMPTY text after ${ct}/${maxOut} output tokens ` +
          `(reasoning consumed the budget on a ${pt}-token prompt) — retrying with ${EMPTY_ANSWER_RETRY_TOKENS}`
        );
        return converseCall(model, systemPrompt, userPrompt, { ...options, maxTokens: EMPTY_ANSWER_RETRY_TOKENS });
      }

      return {
        content: result.text || '',
        model,
        usage: result.usage ? { prompt_tokens: pt, completion_tokens: ct } : undefined,
      };
    } catch (e) {
      const errMsg = e instanceof Error ? e.message : String(e);

      if (errMsg.includes('403') || errMsg.includes('401') || errMsg.includes('AccessDenied')) {
        throw new Error(`Bedrock auth error: ${errMsg}`);
      }

      if (attempt < MAX_RETRIES && isTransientLlmError(e)) {
        const delay = INITIAL_BACKOFF_MS * Math.pow(2, attempt);
        console.log(`  [Bedrock] ${errMsg.slice(0, 80)} — retry ${attempt + 1} in ${delay}ms`);
        await new Promise((r) => setTimeout(r, delay));
        continue;
      }

      throw e;
    }
  }

  throw new Error('No response from Bedrock after retries');
}

// ── Main call function — routes to Mantle or Converse ──


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
  const err = e as { message?: string; code?: string; cause?: { message?: string; code?: string } };
  const blob = [err?.message, err?.code, err?.cause?.message, err?.cause?.code]
    .filter(Boolean).join(' | ');
  return /ThrottlingException|429|\b5\d\d\b|ServiceUnavailable|ETIMEDOUT|ECONNRESET|fetch failed|HeadersTimeout|BodyTimeout|UND_ERR|socket hang up|ECONNREFUSED|ENOTFOUND|EPIPE|network|terminated|AbortError/i
    .test(blob);
}

export async function brCall(
  model: string,
  systemPrompt: string,
  userPrompt: string | ContentPart[],
  options?: {
    temperature?: number;
    maxTokens?: number;
    jsonMode?: boolean;
    thinking?: boolean;
  }
): Promise<LLMResponse> {
  if (isMantleModel(model)) {
    return mantleCall(model, systemPrompt, userPrompt, options);
  }
  return converseCall(model, systemPrompt, userPrompt, options);
}
