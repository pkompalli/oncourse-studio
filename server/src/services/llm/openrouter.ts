const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || '';
const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';

export interface LLMResponse {
  content: string;
  model: string;
  usage?: { prompt_tokens: number; completion_tokens: number };
}

export type ContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } };

const MAX_RETRIES = 3;
const INITIAL_BACKOFF_MS = 2000;

export async function orCall(
  model: string,
  systemPrompt: string,
  userPrompt: string | ContentPart[],
  options?: {
    temperature?: number;
    maxTokens?: number;
    jsonMode?: boolean;
  }
): Promise<LLMResponse> {
  const userContent = typeof userPrompt === 'string' ? userPrompt : userPrompt;

  const body = JSON.stringify({
    model,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userContent },
    ],
    temperature: options?.temperature ?? 0.7,
    max_tokens: options?.maxTokens ?? 4096,
    ...(options?.jsonMode ? { response_format: { type: 'json_object' } } : {}),
  });

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const res = await fetch(`${OPENROUTER_BASE_URL}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${OPENROUTER_API_KEY}`,
          'HTTP-Referer': 'https://qbank-studio.vercel.app',
        },
        body,
      });

      if (res.status === 429 || res.status >= 500) {
        const err = await res.text();
        if (attempt < MAX_RETRIES) {
          const delay = INITIAL_BACKOFF_MS * Math.pow(2, attempt);
          console.log(`  [OpenRouter] ${res.status} on attempt ${attempt + 1}, retrying in ${delay}ms...`);
          await new Promise((r) => setTimeout(r, delay));
          continue;
        }
        throw new Error(`OpenRouter error (${res.status}): ${err}`);
      }

      if (!res.ok) {
        const err = await res.text();
        throw new Error(`OpenRouter error (${res.status}): ${err}`);
      }

      const data = await res.json();
      const choice = data.choices?.[0];
      if (!choice) {
        if (attempt < MAX_RETRIES) {
          const delay = INITIAL_BACKOFF_MS * Math.pow(2, attempt);
          console.log(`  [OpenRouter] Empty response on attempt ${attempt + 1}, retrying in ${delay}ms...`);
          await new Promise((r) => setTimeout(r, delay));
          continue;
        }
        throw new Error('No response from OpenRouter after retries');
      }

      return {
        content: choice.message?.content || '',
        model: data.model || model,
        usage: data.usage,
      };
    } catch (e) {
      if (attempt < MAX_RETRIES && (e instanceof TypeError || (e as Error).message?.includes('fetch'))) {
        const delay = INITIAL_BACKOFF_MS * Math.pow(2, attempt);
        console.log(`  [OpenRouter] Network error on attempt ${attempt + 1}, retrying in ${delay}ms...`);
        await new Promise((r) => setTimeout(r, delay));
        continue;
      }
      throw e;
    }
  }

  throw new Error('No response from OpenRouter after retries');
}

// Default models (from V1 config — app.py lines 71-75)
// Generation + Fixing: Claude (OR_MAIN_MODEL)
// Review + Audit: GPT (OR_VALIDATOR_MODEL / OR_ADVERSARIAL_MODEL)
// Images: GPT (OR_IMAGE_MODEL via OpenAI direct API)
export const MODELS = {
  GENERATOR: process.env.OR_MAIN_MODEL || 'anthropic/claude-sonnet-4-6',        // generation, profiles, structure
  VALIDATOR: process.env.OR_VALIDATOR_MODEL || 'openai/gpt-5.4',                // validator review
  ADVERSARIAL: process.env.OR_ADVERSARIAL_MODEL || 'openai/gpt-5.4',           // adversarial review
  AUDITOR: process.env.OR_VALIDATOR_MODEL || 'openai/gpt-5.4',                 // final audit scoring
  FIXER: process.env.OR_MAIN_MODEL || 'anthropic/claude-sonnet-4-6',            // apply fixes (conservative)
  STRUCTURE: process.env.OR_MAIN_MODEL || 'anthropic/claude-sonnet-4-6',        // course structure
};
