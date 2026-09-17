/**
 * Generation Guidelines — produces a comprehensive rule document
 * from the course structure + exam format that guides both generation and validation.
 */

import { orCall, MODELS } from '../llm/openrouter.js';
import { extractFormatSlugs, renderContractsForPrompt } from './formatContracts.js';

export async function generateGuidelines(
  courseName: string,
  structure: Record<string, unknown>,
  examFormat: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const structureJson = JSON.stringify(structure, null, 2);
  const examFormatJson = JSON.stringify(examFormat, null, 2);

  // Seed the model with the EXACT structural/gradability contract for each format
  // this exam uses (single source of truth), so it interprets the exam onto real
  // contracts instead of re-inventing structure as prose.
  const slugs = extractFormatSlugs(examFormat);
  const contractsBlock = renderContractsForPrompt(slugs);

  const prompt = `You are a senior exam design architect for the ${courseName} exam. Given a course structure and exam format specification, produce a comprehensive GENERATION GUIDELINES document that INTERPRETS this specific exam into concrete, enforceable requirements.

This document is the single source of truth for BOTH:
1. The AI question generator (exactly what to produce — syntax, structure, format, content)
2. The AI validator (exactly what to check for compliance)

Interpret the exam format faithfully: the syntax (how stems/options are phrased), the structure (what fields each question must contain), the formats (which question types and how THIS exam uses each one), difficulty, cognitive level, and any exam-specific conventions. Be concrete and course-specific — never generic. Every rule must be checkable.

COURSE: ${courseName}

─── COURSE STRUCTURE ───
${structureJson}

─── EXAM FORMAT SPECIFICATION ───
${examFormatJson}

─── CANONICAL FORMAT CONTRACTS (authoritative structure + gradability — do NOT contradict; your job is to LAYER exam-specific interpretation on top of these) ───
${contractsBlock}

Produce a JSON object with these exact sections:

{
  "subject_distribution": {
    "<Subject Name>": { "questions": <number>, "percentage": <number> }
  },

  "format_distribution": [
    { "format": "<format_slug>", "percentage": <number>, "count": <number>, "description": "<when to use this format>" }
  ],

  "format_specs": {
    "<format_slug>": {
      "when_to_use": "<in THIS exam, what this format is used to test>",
      "syntax_rules": ["<how the stem/options are phrased for this exam — e.g. lead-in style, option count & labeling, markers, 'Select all that apply' wording>"],
      "structure_requirements": ["<the required fields for this format (from the canonical contract) PLUS any exam-specific structural requirement — e.g. 'reading-comprehension items MUST include a 200–450 word passage in content.passage', 'each case has exactly 6 sub-questions', 'TBS exhibits provided as markdown tables'>"],
      "content_rules": ["<exam-specific content quality rules — realism, data sourcing, rule-grounding, distractor construction for this format>"],
      "gradability": "<the machine-readable answer-key requirement for this format (from the canonical contract), restated concretely>",
      "validation_checks": ["<what the validator must verify for a question of this format to pass — concrete, checkable assertions>"],
      "difficulty_target": "<typical difficulty/Bloom for this format on this exam>"
    }
  },

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
- Format slugs should be: mcq_single, mcq_multi, sata, ordered_response, drag_drop, fill_blank, hot_spot, matrix_grid, cloze_dropdown, emq, case_study, task_based_simulation
- Be specific and actionable — these rules will be programmatically enforced
- format_specs is MANDATORY and must contain one entry for EVERY format that appears in format_distribution. Each entry must interpret THIS exam onto the canonical contract above: concrete syntax_rules, structure_requirements (including any required stimulus — reading passage, exhibit, image, sub-questions), gradability, and validation_checks. This is the section the generator and validator rely on most — make it precise and course-specific.
- STIMULUS COMPLETENESS: for any format whose questions can reference a passage/excerpt/figure/exhibit, structure_requirements MUST state that the stimulus is embedded in the question (reading passage in content.passage; TBS/case exhibits as markdown; figures as images) and validation_checks MUST include "a question that references a passage/figure/exhibit not present is ungradable — reject it".
- explanation_guidelines.must_address_distractors MUST be true — every explanation must discuss why EACH wrong option is wrong, not just defend the correct answer
- The correct answer must ALWAYS be a structured value, not prose. Ungradable questions are rejected.
- If case_study format is present, its format_specs entry must require: exactly 6 sub-questions per case, at least 3 different format_types per case, per-sub-question rationale, and a per-sub-question reasoning_step tag using a step taxonomy appropriate to THIS exam's discipline (e.g. nursing/NCLEX: Recognize Cues → Evaluate Outcomes; audit/CPA: Identify Risk → Report; do NOT impose clinical-judgment steps on non-clinical exams)
- If hot_spot format is present, add custom_rule: hot_spot answers MUST use the stimulus+correct_ids contract — enumerate clickable elements as targets with stable lowercase-slug ids, set answer.correct_ids to the correct target id(s). NEVER use answer.region/label/landmark. Use text_targets type for discrete text elements (medication orders, charting entries, lab values) and image_regions type only for genuine photos/figures. Include ≥2 targets, scoring (dichotomous/plus_minus), and rationale keyed by target id.
- difficulty_distribution MUST have all three levels (easy/medium/hard) with non-zero percentages
- bloom_level values must be normalized: 2_understand, 3_apply, 4_analyze, 5_evaluate (no NCJMM_* prefixes, no raw text labels)

Return ONLY the JSON object. No preamble, no markdown fences.`;

  const guidelines = await callAndParseJson(prompt, 0.3);
  return guidelines;
}

/** Extract a JSON object from an LLM response, tolerating markdown fences. */
function extractJsonObject(raw: string): string {
  let t = raw.trim();
  if (t.includes('```json')) t = t.split('```json')[1].split('```')[0].trim();
  else if (t.includes('```')) t = t.split('```')[1].split('```')[0].trim();
  const first = t.indexOf('{');
  const last = t.lastIndexOf('}');
  if (first >= 0 && last > first) t = t.slice(first, last + 1);
  return t;
}

/**
 * Call the structure model and parse a JSON object. The guidelines JSON is
 * large (per-format rules, distributions), so a low token cap truncates it into
 * "Unterminated string in JSON". Generous cap + one retry that asks for a
 * COMPLETE, more concise object.
 */
async function callAndParseJson(prompt: string, temperature: number): Promise<Record<string, unknown>> {
  const r1 = await orCall(MODELS.STRUCTURE, '', prompt, { maxTokens: 24000, temperature });
  try {
    return JSON.parse(extractJsonObject(r1.content));
  } catch {
    const r2 = await orCall(
      MODELS.STRUCTURE, '',
      `${prompt}\n\nIMPORTANT: Return a COMPLETE, valid JSON object. Keep prose fields concise so the JSON is not truncated. Do not stop mid-string.`,
      { maxTokens: 24000, temperature: Math.max(0, temperature - 0.2) }
    );
    return JSON.parse(extractJsonObject(r2.content));
  }
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

  const result = await callAndParseJson(prompt, 0.3);
  return {
    updated_guidelines: (result.updated_guidelines as Record<string, unknown>) || null,
    response: (result.response as string) || 'Guidelines updated.',
  };
}
