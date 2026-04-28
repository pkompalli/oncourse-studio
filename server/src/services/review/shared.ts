/**
 * Shared utilities for review pipeline — formatting and parsing
 */

import type { ContentPart } from '../llm/openrouter.js';

// ── Format a single question as text block ──

function formatOneQuestion(q: Record<string, unknown>, i: number): string {
  const opts = q.options;
  let optsStr = '';
  if (typeof opts === 'object' && opts !== null && !Array.isArray(opts)) {
    optsStr = Object.entries(opts as Record<string, string>)
      .map(([k, v]) => `  ${k}. ${v}`)
      .join('\n');
  } else if (Array.isArray(opts)) {
    optsStr = (opts as string[]).map((o, j) => `  ${String.fromCharCode(65 + j)}. ${o}`).join('\n');
  }

  const imageStatus = q.is_image_question
    ? (q.image_url
        ? `IMAGE: Present (${q.image_type || 'clinical image'}) — shown below, evaluate for clinical accuracy, relevance to the question stem, and appropriate modality.`
        : `IMAGE: ⚠️ MISSING — this is an image-based question but no image was generated. Score ≤ 4.`)
    : '';

  return `--- Q${i + 1} ---
Question: ${q.question || ''}
Options:
${optsStr}
Correct Answer: ${q.correct_option || ''}
Explanation: ${q.explanation || ''}${imageStatus ? '\n' + imageStatus : ''}`;
}

// ── Format questions as plain text (no images) ──

export function formatQuestionsForReview(questions: Record<string, unknown>[]): string {
  return questions.map((q, i) => formatOneQuestion(q, i)).join('\n\n');
}

// ── Format questions as multimodal content (text + images) ──
// Returns ContentPart[] if any question has an image_url, otherwise returns a plain string.

export function formatQuestionsForReviewWithImages(
  questions: Record<string, unknown>[]
): string | ContentPart[] {
  const hasAnyImage = questions.some(q => q.is_image_question && q.image_url);

  if (!hasAnyImage) {
    // No images to show — return plain text (cheaper, faster)
    return formatQuestionsForReview(questions);
  }

  // Build multimodal content parts: text blocks interleaved with images
  const parts: ContentPart[] = [];

  for (let i = 0; i < questions.length; i++) {
    const q = questions[i];

    // Add question text
    parts.push({ type: 'text', text: formatOneQuestion(q, i) });

    // Add image if present
    if (q.is_image_question && q.image_url) {
      parts.push({
        type: 'image_url',
        image_url: { url: q.image_url as string },
      });
    }
  }

  return parts;
}

// ── Parse JSON array from LLM response (V1 _extract_json_array pattern) ──

export function extractJsonArray(raw: string, expectedCount: number): Record<string, unknown>[] {
  let text = raw;
  if (text.includes('```json')) text = text.split('```json')[1].split('```')[0];
  else if (text.includes('```')) text = text.split('```')[1].split('```')[0];
  const match = text.match(/\[[\s\S]*\]/);
  if (match) text = match[0];
  try {
    const arr = JSON.parse(text.trim());
    if (Array.isArray(arr)) return arr.slice(0, expectedCount);
  } catch {
    // couldn't parse
  }
  return [];
}
