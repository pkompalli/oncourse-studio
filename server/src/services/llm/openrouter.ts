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

  const res = await fetch(`${OPENROUTER_BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${OPENROUTER_API_KEY}`,
      'HTTP-Referer': 'https://qbank-studio.vercel.app',
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userContent },
      ],
      temperature: options?.temperature ?? 0.7,
      max_tokens: options?.maxTokens ?? 4096,
      ...(options?.jsonMode ? { response_format: { type: 'json_object' } } : {}),
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`OpenRouter error (${res.status}): ${err}`);
  }

  const data = await res.json();
  const choice = data.choices?.[0];
  if (!choice) throw new Error('No response from OpenRouter');

  return {
    content: choice.message?.content || '',
    model: data.model || model,
    usage: data.usage,
  };
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
