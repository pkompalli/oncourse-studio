/**
 * LLM abstraction layer
 *
 * Currently backed by AWS Bedrock. The orCall function and MODELS export
 * are kept for backward compatibility — all callers use these names.
 */

export interface LLMResponse {
  content: string;
  model: string;
  usage?: { prompt_tokens: number; completion_tokens: number };
}

export type ContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } };

// Re-export from bedrock
import { brCall, MODELS as BR_MODELS } from './bedrock.js';

export const MODELS = BR_MODELS;

/**
 * Unified LLM call — delegates to Bedrock.
 * Signature kept identical so all existing callers work unchanged.
 */
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
  return brCall(model, systemPrompt, userPrompt, options);
}
