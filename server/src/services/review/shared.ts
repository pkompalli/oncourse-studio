/**
 * Shared utilities for review pipeline — formatting and parsing
 * Format-agnostic: handles MCQ, SATA, ordered response, fill-blank, hot-spot, etc.
 */

import type { ContentPart } from '../llm/openrouter.js';

// ── Format a single question as text block (format-aware) ──

function formatOneQuestion(q: Record<string, unknown>, i: number): string {
  const formatType = (q.format_type as string) || ((q.tags as Record<string, unknown>)?.format_type as string) || 'mcq_single';
  const content = q.content as Record<string, unknown> | undefined;

  // Use content JSONB if available, otherwise fall back to legacy columns
  const stem = (content?.stem as string) || (q.question as string) || '';

  let bodyStr = '';

  switch (formatType) {
    case 'mcq_single': {
      const opts = content?.options || q.options;
      let optsStr = '';
      if (Array.isArray(opts)) {
        // content.options format: [{key: "A", text: "..."}, ...]
        optsStr = (opts as Array<{ key: string; text: string }>)
          .map((o) => `  ${o.key}. ${o.text}`)
          .join('\n');
      } else if (typeof opts === 'object' && opts !== null) {
        optsStr = Object.entries(opts as Record<string, string>)
          .map(([k, v]) => `  ${k}. ${v}`)
          .join('\n');
      }
      const answer = (content?.answer as Record<string, unknown>)?.key || q.correct_option || '';
      bodyStr = `Options:\n${optsStr}\nCorrect Answer: ${answer}`;
      break;
    }
    case 'sata':
    case 'mcq_multi': {
      const opts = content?.options || q.options;
      let optsStr = '';
      if (Array.isArray(opts)) {
        optsStr = (opts as Array<{ key: string; text: string }>)
          .map((o) => `  ${o.key}. ${o.text}`)
          .join('\n');
      } else if (typeof opts === 'object' && opts !== null) {
        optsStr = Object.entries(opts as Record<string, string>)
          .map(([k, v]) => `  ${k}. ${v}`)
          .join('\n');
      }
      const answers = (content?.answer as Record<string, unknown>)?.keys || q.correct_answers || [q.correct_option || ''];
      bodyStr = `Options (Select All That Apply):\n${optsStr}\nCorrect Answers: ${(answers as string[]).join(', ')}`;
      break;
    }
    case 'ordered_response':
    case 'drag_drop': {
      const items = (content?.items as string[]) || (q.items as string[]) || [];
      const correctOrder = (content?.correct_order as number[]) || (q.correct_order as number[]) || [];
      bodyStr = `Items to order:\n${items.map((item, j) => `  ${j + 1}. ${item}`).join('\n')}\nCorrect Order: ${correctOrder.join(', ')}`;
      break;
    }
    case 'fill_blank': {
      const answer = (content?.answer as Record<string, unknown>) || {};
      bodyStr = `Correct Answer: ${answer.value || q.correct_answer_value || ''}${answer.unit ? ` ${answer.unit}` : ''}`;
      if (answer.acceptable_range) bodyStr += `\nAcceptable Range: ${answer.acceptable_range}`;
      break;
    }
    case 'hot_spot': {
      const answer = (content?.answer as Record<string, unknown>) || {};
      const stimulus = content?.stimulus as Record<string, unknown> | undefined;
      if (stimulus && stimulus.type === 'text_targets') {
        const targets = (stimulus.targets as Array<{ id: string; text: string }>) || [];
        const correctIds = (answer.correct_ids as string[]) || [];
        const scoring = (content?.scoring as string) || '';
        const rationale = (content?.rationale as Record<string, string>) || {};
        bodyStr = `Stimulus (${stimulus.type}): ${stimulus.title || ''}\nTargets:\n${targets.map(t => `  ${t.id}: ${t.text}`).join('\n')}\nCorrect IDs: [${correctIds.join(', ')}]\nScoring: ${scoring}`;
        if (Object.keys(rationale).length > 0) {
          bodyStr += `\nRationale:\n${Object.entries(rationale).map(([id, r]) => `  ${id}: ${r}`).join('\n')}`;
        }
      } else if (stimulus && stimulus.type === 'image_regions') {
        const regions = (stimulus.regions as Array<{ id: string; shape: string; bbox: number[] }>) || [];
        const correctIds = (answer.correct_ids as string[]) || [];
        bodyStr = `Stimulus (image_regions):\nRegions: ${regions.map(r => `${r.id}[${r.bbox?.join(',')}]`).join(', ')}\nCorrect IDs: [${correctIds.join(', ')}]`;
      } else {
        // Legacy fallback
        bodyStr = `Correct Region: ${JSON.stringify(answer.region || q.correct_region || '')}`;
      }
      break;
    }
    case 'matrix_grid': {
      const rows = (content?.row_headers as string[]) || (q.row_headers as string[]) || [];
      const cols = (content?.column_headers as string[]) || (q.column_headers as string[]) || [];
      const cells = (content?.correct_cells as Array<{ row: number; col: number }>) || [];
      bodyStr = `Rows: ${rows.join(', ')}\nColumns: ${cols.join(', ')}\nCorrect Cells: ${cells.map((c) => `(${rows[c.row] || c.row},${cols[c.col] || c.col})`).join(', ')}`;
      break;
    }
    case 'cloze_dropdown': {
      const blanks = (content?.blanks as Array<{ id: string; options: string[]; correct: string }>) || [];
      bodyStr = blanks.map((b) => `  ${b.id}: options=[${b.options?.join(', ')}] correct=${b.correct}`).join('\n');
      break;
    }
    case 'emq': {
      const optionList = (content?.option_list as string[]) || [];
      const scenarios = (content?.scenarios as Array<{ stem: string; correct_answer: string }>) || [];
      bodyStr = `Option List:\n${optionList.map((o) => `  ${o}`).join('\n')}\nScenarios:\n${scenarios.map((s, j) => `  ${j + 1}. ${s.stem} → ${s.correct_answer}`).join('\n')}`;
      break;
    }
    case 'case_study': {
      const narrative = (content?.case_narrative as string) || '';
      const subQs = (content?.sub_questions as Array<Record<string, unknown>>) || [];
      bodyStr = `Case Narrative: ${narrative.slice(0, 200)}${narrative.length > 200 ? '...' : ''}\nSub-questions: ${subQs.length}`;
      break;
    }
    default: {
      // Legacy/unknown format — try standard MCQ fields
      const opts = q.options;
      if (typeof opts === 'object' && opts !== null && !Array.isArray(opts)) {
        bodyStr = `Options:\n${Object.entries(opts as Record<string, string>).map(([k, v]) => `  ${k}. ${v}`).join('\n')}\nCorrect Answer: ${q.correct_option || ''}`;
      } else if (Array.isArray(opts)) {
        bodyStr = `Options:\n${(opts as string[]).map((o, j) => `  ${String.fromCharCode(65 + j)}. ${o}`).join('\n')}\nCorrect Answer: ${q.correct_option || ''}`;
      } else {
        bodyStr = `Answer: ${q.correct_option || q.correct_answer || JSON.stringify(content?.answer || '')}`;
      }
    }
  }

  const explanation = (content?.explanation as string) || (q.explanation as string) || '';

  const imageStatus = q.is_image_question
    ? (q.image_url
        ? `IMAGE: Present (${q.image_type || 'clinical image'}) — shown below, evaluate for clinical accuracy, relevance to the question stem, and appropriate modality.`
        : `IMAGE: ⚠️ MISSING — this is an image-based question but no image was generated. Score ≤ 4.`)
    : '';

  const formatLabel = formatType !== 'mcq_single' ? `\nFormat: ${formatType.replace(/_/g, ' ').toUpperCase()}` : '';

  return `--- Q${i + 1} ---${formatLabel}
Question: ${stem}
${bodyStr}
Explanation: ${explanation}${imageStatus ? '\n' + imageStatus : ''}`;
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
