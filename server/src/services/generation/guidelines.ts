/**
 * Generation Guidelines — produces a comprehensive rule document
 * from the course structure + exam format that guides both generation and validation.
 */

import { orCall, MODELS } from '../llm/openrouter.js';
import { extractFormatSlugs, renderContractsForPrompt, buildContentSchema, normalizeSchemaParams, canonicalizeFormatSlug, resolveFormat, FORMAT_CONTRACTS } from './formatContracts.js';

/** Canonicalize every format slug in the guidelines (format_specs keys +
 *  format_distribution) so the whole pipeline uses the fixed registry vocabulary. */
function canonicalizeGuidelines(g: Record<string, unknown>): Record<string, unknown> {
  const specs = g.format_specs as Record<string, Record<string, unknown>> | undefined;
  if (specs && typeof specs === 'object') {
    const out: Record<string, Record<string, unknown>> = {};
    for (const [slug, spec] of Object.entries(specs)) {
      // Resolve by STRUCTURE using the spec's own prose, so a format the guidelines
      // LLM mislabeled (e.g. a human-scored work product called task_based_simulation)
      // is corrected here too — slug-only canonicalization cannot catch that.
      const specText = [spec?.when_to_use, ...(Array.isArray(spec?.structure_requirements) ? spec.structure_requirements : []), spec?.gradability].filter(Boolean).join(' ');
      const canon = resolveFormat({ slug, description: specText });
      out[canon] = out[canon] ? { ...spec, ...out[canon] } : spec;
    }
    g.format_specs = out;
  }
  const fd = g.format_distribution as Array<Record<string, unknown>> | undefined;
  if (Array.isArray(fd)) {
    const map = new Map<string, Record<string, unknown>>();
    for (const f of fd) {
      const canon = resolveFormat({ slug: String(f.format || f.slug || ''), description: String(f.description || '') });
      if (!canon) continue;
      const ex = map.get(canon);
      if (ex) ex.percentage = (Number(ex.percentage) || 0) + (Number(f.percentage) || 0);
      else map.set(canon, { ...f, format: canon });
    }
    g.format_distribution = [...map.values()];
  }
  return g;
}

/** GUARANTEE: every format in format_distribution has a format_specs entry with a
 *  materialized content_schema — so the guidelines step ends with each question
 *  type backed by a fixed schema. */
function ensureSchemaForEveryFormat(g: Record<string, unknown>): Record<string, unknown> {
  const fd = (g.format_distribution as Array<Record<string, unknown>>) || [];
  const specs = (g.format_specs = (g.format_specs as Record<string, Record<string, unknown>>) || {});
  for (const f of fd) {
    const fmt = canonicalizeFormatSlug(String(f.format || f.slug || ''));
    if (!fmt) continue;
    const spec = (specs[fmt] = specs[fmt] || {});
    if (!spec.content_schema) {
      try { spec.content_schema = buildContentSchema(fmt, normalizeSchemaParams(spec.schema_params)); } catch { /* unknown format → no schema */ }
    }
  }
  return g;
}

/**
 * Materialize a deterministic JSON Schema for each format in format_specs,
 * seeded from the canonical contract and tightened by the exam-specific
 * schema_params the model supplied. This is the authoritative structural
 * contract both generation and validation enforce — always valid JSON Schema,
 * regardless of what the model wrote in prose.
 */
function attachContentSchemas(guidelines: Record<string, unknown>): Record<string, unknown> {
  const specs = guidelines.format_specs as Record<string, Record<string, unknown>> | undefined;
  if (!specs || typeof specs !== 'object') return guidelines;
  for (const [fmt, spec] of Object.entries(specs)) {
    if (!spec || typeof spec !== 'object') continue;
    try {
      spec.content_schema = buildContentSchema(fmt, normalizeSchemaParams(spec.schema_params));
    } catch { /* leave this format without a schema rather than fail the whole doc */ }
  }
  return guidelines;
}


/**
 * The ANALYSIS is authoritative on WHICH formats this exam uses — it resolves them
 * structurally (resolveFormat), so its question_types are already canonical. The
 * guidelines LLM only INTERPRETS them; it must not re-pick the set. Left to itself
 * it invents and substitutes: a CFA "Constructed-Response Item Set" came back from
 * the analysis correctly as constructed_response and the guidelines re-labelled it
 * task_based_simulation, silently dropping the format.
 *
 * This forces format_distribution to exactly the analysed set, carries the analysed
 * percentages, and seeds each grouped format's sub-question bounds from
 * items_per_unit — so a 4-question CFA vignette stops inheriting the generic
 * "exactly 6 sub-questions" default.
 */
function reconcileToAnalysisFormats(g: Record<string, unknown>, examFormat: Record<string, unknown>): Record<string, unknown> {
  const qts = Array.isArray(examFormat?.question_types) ? (examFormat.question_types as Array<Record<string, unknown>>) : [];
  if (qts.length === 0) return g;

  const want = new Map<string, Record<string, unknown>>();
  for (const t of qts) {
    const slug = canonicalizeFormatSlug(String(t.slug || ''));
    if (slug) want.set(slug, t);
  }
  if (want.size === 0) return g;

  const specs = (g.format_specs = (g.format_specs as Record<string, Record<string, unknown>>) || {});
  const fd = Array.isArray(g.format_distribution) ? (g.format_distribution as Array<Record<string, unknown>>) : [];
  const byFmt = new Map(fd.map((f) => [String(f.format || f.slug || ''), f]));

  const out: Array<Record<string, unknown>> = [];
  for (const [slug, t] of want) {
    const existing = byFmt.get(slug) || {};
    out.push({
      ...existing,
      format: slug,
      percentage: Number(t.percentage) || Number(existing.percentage) || 0,
      description: (existing.description as string) || (t.description as string) || '',
    });
    const spec = (specs[slug] = specs[slug] || {});

    // A spec this function had to CREATE (because the model mislabelled or omitted
    // the format) would otherwise be an empty shell: no rules for the generator,
    // nothing for the validator's per-format checklist. Seed anything missing from
    // the canonical contract so it is never rule-less.
    const contract = FORMAT_CONTRACTS[slug];
    if (contract) {
      const empty = (v: unknown) => !Array.isArray(v) || v.length === 0;
      if (!spec.when_to_use) spec.when_to_use = (t.description as string) || contract.label;
      if (empty(spec.structure_requirements)) {
        spec.structure_requirements = [contract.structure, ...(contract.stimulusRule ? [contract.stimulusRule] : [])];
      }
      if (empty(spec.syntax_rules)) spec.syntax_rules = [...contract.syntax];
      if (!spec.gradability) spec.gradability = contract.gradability;
      if (empty(spec.validation_checks)) {
        spec.validation_checks = [
          `Verify the record matches the required structure: ${contract.structure}`,
          contract.gradability,
        ];
      }
    }
    // The analysis knows how many scored questions one unit yields; that beats the
    // generic contract default the guidelines tends to copy.
    const ipu = Number(t.items_per_unit) || 0;
    if (ipu > 1) {
      const sp = (spec.schema_params = (spec.schema_params as Record<string, unknown>) || {});
      sp.sub_question_min = ipu;
      sp.sub_question_max = ipu;
      delete spec.content_schema; // force a rebuild with the corrected bounds
    }
  }
  // Drop anything the analysis never declared (LLM inventions/substitutions).
  for (const k of Object.keys(specs)) if (!want.has(k)) delete specs[k];
  g.format_distribution = out;
  return g;
}


/**
 * A generation_template that cannot satisfy its own content_schema is worse than
 * none: generation copies the template, then validation rejects what it produced.
 *
 * Seen on CFA — the model described "Constructed-Response Item Set" as a grouped
 * case-study shape (case_narrative + sub_questions, no prompt, no scoring_rubric)
 * while the constructed_response schema requires prompt + scoring_rubric. Dropping
 * the contradictory template makes buildFormatSchema fall back to the built-in one,
 * which is correct by construction.
 */
function dropContradictoryTemplates(g: Record<string, unknown>): Record<string, unknown> {
  const specs = g.format_specs as Record<string, Record<string, unknown>> | undefined;
  if (!specs) return g;
  // The template describes the RAW generation shape; the schema describes the
  // NORMALIZED content that buildContentFromQuestion produces from it. Compare via
  // aliases, or a correct template (question -> stem, correct_answer -> answer.key)
  // would be thrown away for "missing" fields it legitimately supplies.
  const ALIASES: Record<string, string[]> = {
    stem: ['stem', 'question', 'prompt'],
    prompt: ['prompt', 'question', 'stem'],
    answer: ['answer', 'correct_answer', 'correct_answers', 'correct_option', 'keyed_answer', 'correct_ids'],
    case_narrative: ['case_narrative', 'scenario', 'question'],
    passage: ['passage', 'reading_passage'],
    row_headers: ['row_headers', 'rows'],
    column_headers: ['column_headers', 'columns'],
    blanks: ['blanks', 'choices'],
    correct_order: ['correct_order', 'items'],
  };
  for (const [slug, spec] of Object.entries(specs)) {
    const tmpl = spec?.generation_template as Record<string, unknown> | undefined;
    const schema = spec?.content_schema as { required?: string[] } | undefined;
    if (!tmpl || typeof tmpl !== 'object' || !Array.isArray(schema?.required)) continue;
    const has = (k: string) => (ALIASES[k] || [k]).some((a) => Object.prototype.hasOwnProperty.call(tmpl, a));
    const missing = schema.required.filter((k) => !has(k));
    if (missing.length > 0) {
      console.warn(`  [Guidelines] ${slug}: generation_template is missing required field(s) ${missing.join(', ')} — discarding it and using the canonical template`);
      delete spec.generation_template;
    }
  }
  return g;
}

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

  // Turn the analysis's described question-grouping into an explicit instruction:
  // map each shared-stimulus group onto a concrete grouped machine format.
  // The analysis already resolved these structurally, so they are canonical and
  // authoritative. Naming them explicitly stops the model substituting a similar
  // format (a constructed-response set re-labelled task_based_simulation, say).
  const qTypes = Array.isArray(examFormat.question_types) ? (examFormat.question_types as Array<Record<string, unknown>>) : [];
  const formatListBlock = qTypes.length > 0
    ? qTypes.map((t) => {
        const slug = canonicalizeFormatSlug(String(t.slug || ''));
        const ipu = Number(t.items_per_unit) || 1;
        return `  - ${slug} — ${t.percentage}% of scored weight${ipu > 1 ? `; ONE unit yields ${ipu} scored questions (use this for sub_question_min/max)` : ''}. ${String(t.description || '').slice(0, 220)}`;
      }).join('\n')
    : '  (none declared — infer from the specification above)';

  const groups = Array.isArray(examFormat.question_groups) ? (examFormat.question_groups as Array<Record<string, unknown>>) : [];
  const groupingBlock = groups.length > 0
    ? `The exam groups some questions under a shared stimulus. For EACH group, add a format_specs entry for the mapped machine format AND a format_distribution entry:\n` +
      groups.map((g, i) => `  Group ${i + 1}: stimulus_type=${g.stimulus_type}, ${JSON.stringify(g.members_per_group)} questions/group, member formats ${JSON.stringify(g.member_formats)} — ${g.description || ''}`).join('\n') +
      `\nMAPPING (by ANSWER MODEL, not by name): reading_passage → passage_set (ONE shared "passage" + sub_questions[]); case_scenario → case_study (shared narrative + mixed sub-questions); exhibit_set/data_set → task_based_simulation ONLY IF its components are individually MACHINE-SCORED (numeric entry, dropdown, grid). If the exhibits instead feed ONE extended, human-scored work product (a memo, letter, brief, analysis), that is performance_task — a STANDALONE format, NOT a grouped set — and must NOT be emitted as task_based_simulation; image → keep the member formats with is_image_question=true.\nFor a grouped format: set schema_params.sub_question_min/max from members_per_group; structure_requirements MUST require the shared stimulus embedded IN the question; each sub-question fully gradable.`
    : `This exam has no shared-stimulus grouping — all questions are standalone.${(examFormat.structure_overview ? ` Structure: ${examFormat.structure_overview}` : '')}`;

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

─── QUESTION GROUPING (from the analysis — turn described grouping into concrete grouped formats) ───
${groupingBlock}

─── THE EXAM'S FORMATS (AUTHORITATIVE — use EXACTLY these slugs as the keys of format_specs and the "format" values in format_distribution; do NOT rename, merge, substitute or omit any of them) ───
${formatListBlock}

Produce a JSON object with these exact sections:

{
  "subject_distribution": {
    "<Subject Name>": { "questions": <number>, "percentage": <number> }
  },

  "format_distribution": [
    { "format": "<format_slug>", "percentage": <number — share of the exam's SCORED WEIGHT / emphasis, not raw item count; sums to 100>, "count": <number>, "description": "<when to use this format>" }
  ],

  "format_specs": {
    "<format_slug>": {
      "when_to_use": "<in THIS exam, what this format is used to test>",
      "syntax_rules": ["<how the stem/options are phrased for this exam — e.g. lead-in style, option count & labeling, markers, 'Select all that apply' wording>"],
      "structure_requirements": ["<the required fields for this format (from the canonical contract) PLUS any exam-specific structural requirement — e.g. 'reading-comprehension items MUST include a 200–450 word passage in content.passage', 'each case has exactly 6 sub-questions', 'TBS exhibits provided as markdown tables'>"],
      "content_rules": ["<exam-specific content quality rules — realism, data sourcing, rule-grounding, distractor construction for this format>"],
      "gradability": "<the machine-readable answer-key requirement for this format (from the canonical contract), restated concretely>",
      "validation_checks": ["<what the validator must verify for a question of this format to pass — concrete, checkable assertions>"],
      "difficulty_target": "<typical difficulty/Bloom for this format on this exam>",
      "generation_template": { "<a CONCRETE example object showing the EXACT JSON the generator must emit for ONE question of this format on this exam — filled with a realistic (short) example, not placeholders>": "" },
      "schema_params": {
        "num_options": <exact number of options this exam fixes for this format, e.g. 5 for LSAT; null if variable>,
        "option_keys": <array of exact option keys if fixed, e.g. ["A","B","C","D","E"]; null otherwise>,
        "sub_question_count": <exact sub-question count for case_study (e.g. 6); null if N/A>,
        "sub_question_min": <min sub-questions/tasks for TBS; null if N/A>,
        "sub_question_max": <max sub-questions/tasks for TBS; null if N/A>,
        "exhibits_as_markdown": <true if TBS/case exhibits must be markdown; null if N/A>,
        "parts_min": <constructed_response ITEM SETS only: minimum labelled parts scored separately (e.g. CFA Level III sets); null for a single-prompt essay>,
        "parts_max": <constructed_response ITEM SETS only: maximum labelled parts; null if N/A>
      }
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
- Format slugs should be: mcq_single, mcq_multi, sata, ordered_response, drag_drop, fill_blank, hot_spot, matrix_grid, cloze_dropdown, emq, case_study, task_based_simulation, passage_set
- Be specific and actionable — these rules will be programmatically enforced
- format_specs is MANDATORY and must contain one entry for EVERY format that appears in format_distribution. Each entry must interpret THIS exam onto the canonical contract above: concrete syntax_rules, structure_requirements (including any required stimulus — reading passage, exhibit, image, sub-questions), gradability, and validation_checks. This is the section the generator and validator rely on most — make it precise and course-specific.
- generation_template is MANDATORY per format and DRIVES generation: it is a concrete, realistic (keep it short) example object of EXACTLY the JSON the generator must output for ONE question of that format. Follow these output conventions:
    • Common meta fields on every top-level object: "format_type", "question" (the stem), "explanation", "difficulty", "bloom_level", and "is_image_question" (+ "image_type"/"image_search_terms" only if an image is needed).
    • mcq_single: "options": ["A. …","B. …",…], "correct_answer": "<letter>". Include "passage": "<full text>" ONLY for reading/comprehension items.
    • sata/mcq_multi: "options": [...], "correct_answers": ["A","C"].
    • ordered_response/drag_drop: "items": [...], "correct_order": [2,1,3].
    • fill_blank: "correct_answer_value", "correct_answer_unit", "acceptable_range".
    • matrix_grid: "row_headers": [...], "column_headers": [...], "correct_cells": [{"row":0,"col":1}].
    • cloze_dropdown: "blanks": [{"id","options":[...],"correct"}].
    • hot_spot: "stimulus_type", "targets"/"regions" with slug ids, "correct_ids": [...].
    • emq: "theme", "option_list": [...], "scenarios": [{"stem","correct_answer"}].
    • GROUPED formats (case_study, task_based_simulation, passage_set, or any shared-stimulus set): ONE object with the shared stimulus + a "sub_questions" array. Shared stimulus field: passage_set → "passage"; case_study → "case_narrative"; task_based_simulation → "exhibits":[{label,title,type,content(markdown)}]. Each sub-question: {"number","format_type","question", <that sub-format's answer scaffolding as above>, "rationale","difficulty"}.
- If a constructed-response format is delivered as an ITEM SET (a shared vignette followed by labelled parts scored separately, as at CFA Level III), you MUST set schema_params.parts_min/parts_max to the real number of parts, and structure_requirements MUST state that each part carries its own point value and its own rubric, with total_points equal to their sum. Do not describe it as a single merged prompt.
- STIMULUS COMPLETENESS: for any format whose questions can reference a passage/excerpt/figure/exhibit, structure_requirements MUST state that the stimulus is embedded in the question (reading passage in content.passage; TBS/case exhibits as markdown; figures as images) and validation_checks MUST include "a question that references a passage/figure/exhibit not present is ungradable — reject it".
- anti_patterns MUST include an authenticity rule: questions must TEST each skill by making the candidate PERFORM it on real material (a real argument/passage/data/scenario), NOT ask ABOUT the skill. Explicitly forbid meta / definitional / test-strategy / study-skill questions (e.g. "what is a good reading technique?", "what is the definition of a necessary assumption?"). A topic name is the TASK the question must require, never a subject to describe.
- explanation_guidelines.must_address_distractors MUST be true — every explanation must discuss why EACH wrong option is wrong, not just defend the correct answer
- The correct answer must ALWAYS be a structured value, not prose. Ungradable questions are rejected.
- If case_study format is present, its format_specs entry must require: exactly 6 sub-questions per case, at least 3 different format_types per case, per-sub-question rationale, and a per-sub-question reasoning_step tag using a step taxonomy appropriate to THIS exam's discipline (e.g. nursing/NCLEX: Recognize Cues → Evaluate Outcomes; audit/CPA: Identify Risk → Report; do NOT impose clinical-judgment steps on non-clinical exams)
- If hot_spot format is present, add custom_rule: hot_spot answers MUST use the stimulus+correct_ids contract — enumerate clickable elements as targets with stable lowercase-slug ids, set answer.correct_ids to the correct target id(s). NEVER use answer.region/label/landmark. Use text_targets type for discrete text elements (medication orders, charting entries, lab values) and image_regions type only for genuine photos/figures. Include ≥2 targets, scoring (dichotomous/plus_minus), and rationale keyed by target id.
- difficulty_distribution MUST have all three levels (easy/medium/hard) with non-zero percentages
- bloom_level values must be normalized: 2_understand, 3_apply, 4_analyze, 5_evaluate (no NCJMM_* prefixes, no raw text labels)

Return ONLY the JSON object. No preamble, no markdown fences.`;

  const guidelines = await callAndParseJson(prompt, 0.3);
  // Pipeline: canonicalize slugs → materialize per-format schemas → guarantee
  // grouped formats → guarantee a schema for EVERY declared format.
  // canonicalize slugs -> force the analysed format set -> materialize schemas ->
  // guarantee grouped formats -> guarantee a schema for every declared format.
  // canonicalize slugs -> force the analysed format set -> materialize schemas ->
  // guarantee grouped formats -> guarantee a schema for every format -> discard any
  // template that contradicts its schema.
  return dropContradictoryTemplates(ensureSchemaForEveryFormat(
    reconcileGroupedFormats(
      attachContentSchemas(reconcileToAnalysisFormats(canonicalizeGuidelines(guidelines), examFormat)),
      examFormat
    )
  ));
}

// Deterministic reconciliation: whenever the analysis describes a shared-stimulus
// group (exam_format.question_groups), GUARANTEE the mapped grouped format has a
// materialized content_schema — even if the guidelines LLM forgot to emit a
// format_specs entry for it. This makes "grouping described → grouped format
// enforceable" a guarantee, not dependent on LLM variance. (Allocation routes the
// format to its subjects separately, from question_groups.)
const STIMULUS_TO_FORMAT: Record<string, string> = {
  reading_passage: 'passage_set',
  case_scenario: 'case_study',
  exhibit_set: 'task_based_simulation',
  data_set: 'task_based_simulation',
};
function reconcileGroupedFormats(guidelines: Record<string, unknown>, examFormat: Record<string, unknown>): Record<string, unknown> {
  const groups = Array.isArray(examFormat?.question_groups) ? (examFormat.question_groups as Array<Record<string, unknown>>) : [];
  if (groups.length === 0) return guidelines;
  const specs = (guidelines.format_specs = (guidelines.format_specs as Record<string, Record<string, unknown>>) || {});
  // Only reconcile a grouped format this exam ACTUALLY declares. Otherwise an
  // "exhibit_set" group would resurrect task_based_simulation even when the exam's
  // real format is a human-scored performance_task (the answer models differ).
  const declared = new Set(((guidelines.format_distribution as Array<Record<string, unknown>>) || [])
    .map((f) => String(f.format || f.slug || '')));
  for (const g of groups) {
    const fmt = STIMULUS_TO_FORMAT[String(g.stimulus_type)];
    if (!fmt) continue;
    if (declared.size > 0 && !declared.has(fmt)) continue;
    const spec = (specs[fmt] = specs[fmt] || {});
    const params = normalizeSchemaParams(spec.schema_params);
    const mm = Array.isArray(g.members_per_group) ? (g.members_per_group as number[]) : [5, 8];
    if (!params.subQuestionMin) params.subQuestionMin = Number(mm[0]) || undefined;
    if (!params.subQuestionMax) params.subQuestionMax = Number(mm[1]) || undefined;
    if (!spec.content_schema) {
      try { spec.content_schema = buildContentSchema(fmt, params); } catch { /* leave unschema'd */ }
    }
  }
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
  // Retry on ANY failure, not just a bad parse. Guidelines generation is a long,
  // expensive call and a single transient "fetch failed" used to abort the whole
  // run, losing the work with nothing retried.
  const nudge = `${prompt}\n\nIMPORTANT: Return a COMPLETE, valid JSON object. Keep prose fields concise so the JSON is not truncated. Do not stop mid-string.`;
  const attempts = [
    { p: prompt, t: temperature },
    { p: nudge, t: Math.max(0, temperature - 0.2) },
    { p: nudge, t: Math.max(0, temperature - 0.2) },
  ];
  let lastErr: unknown;
  for (let i = 0; i < attempts.length; i++) {
    try {
      const r = await orCall(MODELS.STRUCTURE, '', attempts[i].p, { maxTokens: 24000, temperature: attempts[i].t });
      return JSON.parse(extractJsonObject(r.content));
    } catch (e) {
      lastErr = e;
      const msg = e instanceof Error ? e.message : String(e);
      const cause = (e as { cause?: { message?: string; code?: string } })?.cause;
      const detail = cause?.code || cause?.message || '';
      console.warn(`  [Guidelines] attempt ${i + 1}/${attempts.length} failed: ${msg.slice(0, 100)}${detail ? ` (${detail})` : ''}`);
      if (i < attempts.length - 1) await new Promise((r) => setTimeout(r, 3000 * (i + 1)));
    }
  }
  throw new Error(`Guidelines generation failed after ${attempts.length} attempts: ${lastErr instanceof Error ? lastErr.message : String(lastErr)}`);
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
  const updated = (result.updated_guidelines as Record<string, unknown>) || null;
  return {
    // Re-materialize schemas so an edit to num_options / sub-question counts /
    // exhibit rules updates the deterministic contract too.
    updated_guidelines: updated ? attachContentSchemas(updated) : null,
    response: (result.response as string) || 'Guidelines updated.',
  };
}
