/**
 * Generation Guidelines — produces a comprehensive rule document
 * from the course structure + exam format that guides both generation and validation.
 */

import { orCall, MODELS } from '../llm/openrouter.js';

export async function generateGuidelines(
  courseName: string,
  structure: Record<string, unknown>,
  examFormat: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const structureJson = JSON.stringify(structure, null, 2);
  const examFormatJson = JSON.stringify(examFormat, null, 2);

  const prompt = `You are a senior exam design architect. Given a course structure and exam format specification, produce a comprehensive GENERATION GUIDELINES document.

This document will serve as the single source of truth for:
1. The AI question generator (what to produce)
2. The AI validator (what to check for compliance)

COURSE: ${courseName}

─── COURSE STRUCTURE ───
${structureJson}

─── EXAM FORMAT SPECIFICATION ───
${examFormatJson}

Produce a JSON object with these exact sections:

{
  "subject_distribution": {
    "<Subject Name>": { "questions": <number>, "percentage": <number> }
  },

  "format_distribution": [
    { "format": "<format_slug>", "percentage": <number>, "count": <number>, "description": "<when to use this format>" }
  ],

  "stem_guidelines": {
    "style": "<vignette-based | direct-recall | mixed — based on exam format>",
    "min_words": <number or null>,
    "max_words": <number or null>,
    "vignette_required": <boolean>,
    "scenario_depth": "<brief | moderate | detailed — what the exam expects>"
  },

  "distractor_guidelines": {
    "quality_rules": [
      "<rule 1: e.g., All distractors must be plausible and from the same category>",
      "<rule 2: e.g., No 'All of the above' or 'None of the above' unless exam uses them>",
      "<rule 3: e.g., Distractors should be similar length to the correct answer>",
      "<rule 4+>"
    ],
    "homogeneity": "<all options same type/category/length>",
    "common_errors_to_use": [
      "<type 1: e.g., a closely-related concept the candidate may confuse with the answer>",
      "<type 2: e.g., a correct-looking option that applies the right idea in the wrong situation>",
      "<type 3+>"
    ]
  },

  "explanation_guidelines": {
    "required": true,
    "min_sentences": <number>,
    "must_justify_correct": true,
    "must_address_distractors": <boolean — true if exam expects distractor discussion>
  },

  "difficulty_distribution": {
    "easy": <percentage>,
    "medium": <percentage>,
    "hard": <percentage>
  },

  "blooms_distribution": {
    "<level>": <percentage>
  },

  "image_guidelines": {
    "percentage": <overall percentage of questions that should have images>,
    "types": ["<image type 1>", "<image type 2>"],
    "when_required": "<guideline on when a question MUST have an image>"
  },

  "answer_key_balance": "<e.g., Correct answers should be roughly equally distributed across options A-D. No more than 30% of questions should share the same correct answer key.>",

  "coverage_rules": [
    "<rule 1: e.g., Every subject must have at least 1 question>",
    "<rule 2: e.g., High-yield topics must be covered before low-yield ones>",
    "<rule 3: e.g., All format types in format_distribution must appear>",
    "<rule 4: e.g., No single topic should have more than 3 questions unless it has more sub-topics>",
    "<rule 5+>"
  ],

  "anti_patterns": [
    "<pattern 1: e.g., Never use absolute terms like 'always' or 'never' in options>",
    "<pattern 2: e.g., Never give away the answer through option length differences>",
    "<pattern 3: e.g., Avoid testing trivial facts or pure memorization unless exam is recall-heavy>",
    "<pattern 4+>"
  ],

  "custom_rules": [
    "<any exam-specific rules derived from the exam format specification>"
  ]
}

IMPORTANT:
- Base ALL numbers on the exam format specification (total questions, subject distribution, format percentages, etc.)
- If the exam format has subject_distribution with specific question counts, use those EXACTLY
- If the exam format has bloom's or difficulty distributions, use those EXACTLY
- Format slugs should be: mcq_single, sata, ordered_response, fill_blank, hot_spot, matrix_grid, cloze_dropdown, emq, case_study
- Be specific and actionable — these rules will be programmatically enforced
- explanation_guidelines.must_address_distractors MUST be true — every explanation must discuss why EACH wrong option is wrong, not just defend the correct answer
- For EVERY format in format_distribution, add a custom_rule stating its REQUIRED machine-readable structure so questions are auto-gradable:
    • mcq_single: options[] + single correct answer; sata: options[] + correct answer set
    • matrix_grid: row_headers[] + column_headers[] + correct_cells (each row classified)
    • cloze_dropdown: each blank has an options list AND a correct value
    • emq: an option_list + scenarios each with a correct option from the list
    • ordered_response: items[] + correct_order (1-based indices in the correct sequence)
    • fill_blank: an explicit correct answer value (never only in the explanation)
    • hot_spot: stimulus with target ids + answer.correct_ids
  The correct answer must ALWAYS be a structured value, not prose. Ungradable questions are rejected.
- If case_study format is present, add custom_rules for: exactly 6 sub-questions per case, at least 3 different format_types per case, per-sub-question rationale required, and a per-sub-question reasoning_step tag using a step taxonomy appropriate to THIS exam's discipline (e.g. nursing/NCLEX: Recognize Cues → Evaluate Outcomes; audit/CPA: Identify Risk → Report; do NOT impose clinical-judgment steps on non-clinical exams)
- If hot_spot format is present, add custom_rule: hot_spot answers MUST use the stimulus+correct_ids contract — enumerate clickable elements as targets with stable lowercase-slug ids, set answer.correct_ids to the correct target id(s). NEVER use answer.region/label/landmark. Use text_targets type for discrete text elements (medication orders, charting entries, lab values) and image_regions type only for genuine photos/figures. Include ≥2 targets, scoring (dichotomous/plus_minus), and rationale keyed by target id.
- difficulty_distribution MUST have all three levels (easy/medium/hard) with non-zero percentages
- bloom_level values must be normalized: 2_understand, 3_apply, 4_analyze, 5_evaluate (no NCJMM_* prefixes, no raw text labels)

Return ONLY the JSON object. No preamble, no markdown fences.`;

  const response = await orCall(MODELS.STRUCTURE, '', prompt, {
    maxTokens: 6000,
    temperature: 0.3,
  });

  let raw = response.content.trim();
  if (raw.includes('```json')) raw = raw.split('```json')[1].split('```')[0].trim();
  else if (raw.includes('```')) raw = raw.split('```')[1].split('```')[0].trim();

  const guidelines = JSON.parse(raw);
  return guidelines;
}

export async function refineGuidelines(
  currentGuidelines: Record<string, unknown>,
  message: string,
  courseName: string
): Promise<{ updated_guidelines: Record<string, unknown> | null; response: string }> {
  const guidelinesJson = JSON.stringify(currentGuidelines, null, 2);

  const prompt = `You are a senior exam design architect managing generation guidelines for ${courseName}.

Current guidelines:
${guidelinesJson}

The user wants to modify these guidelines. Apply their requested change and return the updated guidelines.

User request: ${message}

Return a JSON object with two fields:
{
  "response": "<1-2 sentence confirmation of what you changed>",
  "updated_guidelines": { ...the complete updated guidelines JSON... }
}

If the request doesn't require changes (just a question), return:
{
  "response": "<your answer>",
  "updated_guidelines": null
}

Return ONLY valid JSON. No preamble, no markdown fences.`;

  const res = await orCall(MODELS.STRUCTURE, '', prompt, {
    maxTokens: 6000,
    temperature: 0.3,
  });

  let raw = res.content.trim();
  if (raw.includes('```json')) raw = raw.split('```json')[1].split('```')[0].trim();
  else if (raw.includes('```')) raw = raw.split('```')[1].split('```')[0].trim();

  const result = JSON.parse(raw);
  return {
    updated_guidelines: result.updated_guidelines || null,
    response: result.response || 'Guidelines updated.',
  };
}
