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

const THINKING_BUDGET = parseInt(process.env.BR_THINKING_BUDGET || '4096', 10);

// Mantle config
const MANTLE_REGION = process.env.MANTLE_REGION || 'us-east-1';
const MANTLE_BASE = `https://bedrock-mantle.${MANTLE_REGION}.api.aws/openai/v1`;

function isMantleModel(model: string): boolean {
  return model.startsWith('openai.');
}

console.log(`[Bedrock] Converse: ${bedrockRegion}, Mantle: ${MANTLE_REGION}`);
console.log(`[Bedrock] Generator: ${MODELS.GENERATOR} (${isMantleModel(MODELS.GENERATOR) ? 'Mantle' : 'Converse'})`);
console.log(`[Bedrock] Reviewer:  ${MODELS.VALIDATOR} (thinking=${THINKING_MODELS.has(MODELS.VALIDATOR)}, budget=${THINKING_BUDGET})`);

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

      if (attempt < MAX_RETRIES && (
        errMsg.includes('ThrottlingException') ||
        errMsg.includes('429') ||
        errMsg.includes('500') ||
        errMsg.includes('ServiceUnavailable') ||
        errMsg.includes('ETIMEDOUT') ||
        errMsg.includes('ECONNRESET')
      )) {
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
        temperature: useThinking ? undefined : (options?.temperature ?? 0.7),
        ...(useThinking ? {
          providerOptions: {
            bedrock: {
              reasoningConfig: { type: 'adaptive', budgetTokens: THINKING_BUDGET },
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

      if (attempt < MAX_RETRIES && (
        errMsg.includes('ThrottlingException') ||
        errMsg.includes('429') ||
        errMsg.includes('500') ||
        errMsg.includes('ServiceUnavailable') ||
        errMsg.includes('ETIMEDOUT') ||
        errMsg.includes('ECONNRESET')
      )) {
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
