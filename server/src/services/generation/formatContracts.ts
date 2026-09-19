/**
 * Format Contract Registry — the SINGLE SOURCE OF TRUTH for the syntax,
 * structure, and gradability requirements of every question format.
 *
 * The generator (buildFormatSchema), the gradability gate (review/shared.ts),
 * and the guidelines engine (guidelines.ts) must all agree on what a well-formed
 * question of each format looks like. This registry states that contract once, in
 * one place, so the guidelines document can be seeded with the EXACT structural
 * requirements (rather than the LLM re-inventing them as prose each run) and the
 * validator can check compliance against the same contract the generator targets.
 *
 * The guidelines engine layers EXAM-SPECIFIC interpretation on top of these
 * course-agnostic contracts (e.g. "LSAT reading-comprehension mcq_single MUST
 * include a 200–450 word passage"; "CPA TBS exhibits are documents, never images").
 */

export type FormatContract = {
  slug: string;
  label: string;
  /** Structural fields the stored record MUST contain (the "shape"). */
  structure: string;
  /** What makes a response of this format machine-gradable (the answer key shape). */
  gradability: string;
  /** Stem / option / labeling conventions the writer must follow. */
  syntax: string[];
  /** Whether this format may carry a shared stimulus the stem depends on. */
  stimulusRule?: string;
};

export const FORMAT_CONTRACTS: Record<string, FormatContract> = {
  mcq_single: {
    slug: 'mcq_single',
    label: 'Single Best Answer MCQ',
    structure: 'stem (question); options[] (each {key,text}); answer.key = exactly one option letter; explanation.',
    gradability: 'answer.key must be a single option letter that exists in options[].',
    syntax: [
      'One unambiguously best option; the rest are plausible distractors of similar length/category.',
      'No "All/None of the above" unless the real exam uses them.',
    ],
    stimulusRule: 'If the stem refers to a reading passage/excerpt, the FULL passage MUST be in content.passage. Never reference "the passage" without including it. If it refers to a figure, set is_image_question=true or describe the data inline.',
  },
  mcq_multi: {
    slug: 'mcq_multi',
    label: 'Multiple Response MCQ',
    structure: 'stem; options[]; answer.keys[] = the set of correct option letters; explanation.',
    gradability: 'answer.keys[] must be a non-empty set of letters, each present in options[].',
    syntax: ['Stem must clearly state that more than one answer applies.'],
    stimulusRule: 'Same passage/figure rule as mcq_single.',
  },
  sata: {
    slug: 'sata',
    label: 'Select All That Apply',
    structure: 'stem (states "Select all that apply"); options[] (5–6 typical); answer.keys[] = all correct letters; explanation.',
    gradability: 'answer.keys[] non-empty, each present in options[]. Partial credit per-option ("scoring":"partial") allowed.',
    syntax: ['Stem must explicitly say "Select all that apply".', 'Each option independently true or false — no interdependence.'],
    stimulusRule: 'Same passage/figure rule as mcq_single.',
  },
  ordered_response: {
    slug: 'ordered_response',
    label: 'Ordered Response / Drag-and-Drop Sequence',
    structure: 'stem; items[] (the elements to arrange); correct_order = array of 1-based item indices in the CORRECT sequence (e.g. [2,4,1,3] = item 2 first); explanation.',
    gradability: 'correct_order must be a permutation of 1..items.length. NOT an item→position map.',
    syntax: ['Items must have a single defensible ordering.'],
  },
  drag_drop: {
    slug: 'drag_drop',
    label: 'Drag-and-Drop Sequence',
    structure: 'Same as ordered_response: items[] + correct_order (1-based indices).',
    gradability: 'correct_order must be a permutation of 1..items.length.',
    syntax: ['Single defensible ordering.'],
  },
  fill_blank: {
    slug: 'fill_blank',
    label: 'Fill in the Blank / Calculation',
    structure: 'stem; answer.value (the exact numeric/text answer); answer.unit (if applicable); answer.acceptable_range (if numeric); explanation shows the calculation.',
    gradability: 'answer.value must be an explicit structured value — NEVER only stated in the explanation prose.',
    syntax: ['Ask for one specific value.', 'State the required unit/format in the stem when relevant.'],
  },
  hot_spot: {
    slug: 'hot_spot',
    label: 'Hot Spot (click-to-select)',
    structure: 'stem; stimulus{type:"text_targets"|"image_regions", targets/regions each with a lowercase-slug id}; answer.correct_ids[]; rationale keyed by target id.',
    gradability: 'answer.correct_ids[] non-empty; every id must exist in stimulus targets/regions. FORBIDDEN: answer.region/label/landmark.',
    syntax: ['≥2 targets.', 'text_targets for discrete text elements; image_regions ONLY for genuine photos/figures.', 'scoring: dichotomous (single) | plus_minus (multiple).'],
    stimulusRule: 'The stimulus (targets or image) is REQUIRED — it is what the candidate clicks.',
  },
  matrix_grid: {
    slug: 'matrix_grid',
    label: 'Matrix / Grid Classification',
    structure: 'stem; row_headers[] (items to classify); column_headers[] (categories); correct_cells[] ({row,col} indices) OR a row→column map; explanation.',
    gradability: 'Both row_headers and column_headers must be present, and one correct column per row. Missing rows/columns = ungradable.',
    syntax: ['Every row gets exactly one (or a defined number of) correct column(s).'],
  },
  cloze_dropdown: {
    slug: 'cloze_dropdown',
    label: 'Cloze with Dropdowns',
    structure: 'stem with [Blank N] / [[BLANKn]] markers; blanks[] each {id, options[], correct} (or choices{} + correct{}); explanation.',
    gradability: 'Each blank must have an options list AND a correct value drawn from that list.',
    syntax: ['Every blank marker in the stem must have a matching blank entry, and vice-versa.'],
  },
  emq: {
    slug: 'emq',
    label: 'Extended Matching Questions',
    structure: 'theme; option_list[] (shared lettered options, typically 5–10); scenarios[] each {stem, correct_answer letter}; explanation per scenario.',
    gradability: 'Each scenario\'s correct_answer must be a letter present in option_list. Option list shared across all scenarios.',
    syntax: ['All options belong to one homogeneous theme.', 'Each scenario resolves to exactly one option.'],
  },
  case_study: {
    slug: 'case_study',
    label: 'Case Study (shared narrative + sub-questions)',
    structure: 'case_narrative (with the data/evidence to analyze); topics[]; response_instructions; sub_questions[] (each a fully-formed question of its own format_type with its own answer key, rationale, and reasoning_step); overall explanation.',
    gradability: 'EVERY sub-question must carry the COMPLETE machine-readable answer scaffolding for ITS format (options/rows/columns/choices/items + a structured answer key). A sub-answer that exists only in rationale prose is INVALID.',
    syntax: [
      'The number of sub-questions per set is whatever THIS exam uses (see schema_params.sub_question_min/max) — do not assume 6; use at least 2 different sub-question format_types where the exam mixes them.',
      'reasoning_step per sub-question using THIS exam\'s discipline taxonomy (no clinical steps on non-clinical exams).',
      'Reference exhibits by visible LABEL only — never an internal id/slug.',
      'Any rule/fact a key depends on must appear in the narrative or an exhibit.',
    ],
    stimulusRule: 'The narrative (and any exhibits) is the shared stimulus; every sub-question must be answerable from it.',
  },
  passage_set: {
    slug: 'passage_set',
    label: 'Reading Passage Set (shared passage + questions)',
    structure: 'passage (the full shared reading text — a single passage, or a comparative pair labeled "Passage A"/"Passage B"); sub_questions[] (each a fully-formed, gradable question of its own format_type — usually mcq_single — about the passage, with its own answer key, rationale, and topic); overall explanation.',
    gradability: 'EVERY sub-question must carry the COMPLETE machine-readable answer scaffolding for ITS format (options + a structured answer key). A sub-answer that exists only in rationale prose is INVALID. The shared passage must be present.',
    syntax: [
      'One shared passage feeds ALL sub-questions; each sub-question is answerable ONLY from the passage.',
      'Typically 5–8 sub-questions per passage; use standard exam lead-ins.',
      'Comparative sets label the two texts "Passage A" and "Passage B" within the passage.',
    ],
    stimulusRule: 'The passage is the shared stimulus and is REQUIRED — never a sub-question referencing a passage that is not present.',
  },
  task_based_simulation: {
    slug: 'task_based_simulation',
    label: 'Task-Based Simulation (TBS)',
    structure: 'question (directions/memo); exhibits[] (2–5 documents, each {label,title,type,content} where content is MARKDOWN — tables for numeric data); sub_questions[] (4–8 tasks referencing exhibits by label, each with its format\'s answer key + rationale + reasoning_step); response_instructions; explanation.',
    gradability: 'Each task carries its format\'s complete answer key. Every fact a task needs must actually appear in an exhibit\'s markdown.',
    syntax: [
      'NOT an image question (is_image_question=false); exhibit data is MARKDOWN, never an image.',
      'Tasks reference exhibits by label ("Using Exhibit 1…").',
      'Mix realistic task types (fill_blank, cloze_dropdown, matrix_grid, mcq_single, emq, ordered_response).',
    ],
    stimulusRule: 'Exhibits are the shared stimulus and are REQUIRED, embedded as markdown.',
  },
};

// tbs is an alias for task_based_simulation.
FORMAT_CONTRACTS.tbs = { ...FORMAT_CONTRACTS.task_based_simulation, slug: 'tbs' };

FORMAT_CONTRACTS.constructed_response = {
  slug: 'constructed_response',
  label: 'Constructed Response / Essay (human-scored)',
  structure: 'prompt (the task framing) + scoring_rubric. For an ITEM SET (e.g. CFA Level III): also vignette (the shared scenario every part refers to), parts[] — each {label:"A", prompt, points, scoring_rubric, sample_response?} scored SEPARATELY — and total_points. A single-prompt essay omits vignette/parts. No machine answer key; scored by a human against the rubric.',
  gradability: 'Not auto-gradable by design, but NOT unscorable: a prompt AND a scoring_rubric are required. The rubric is this format\'s answer key — it states what earns credit, the point allocation across any labeled parts, and what earns none.',
  syntax: [
    'State the task clearly and say what the response must contain.',
    'Provide any source material / vignette the writer must respond to.',
    'For an ITEM SET: label the parts A, B, C…, give EACH part its own point value and its own rubric, and set total_points to their sum. Parts are scored separately — never merge them into one prompt.',
  ],
};

FORMAT_CONTRACTS.performance_task = {
  slug: 'performance_task',
  label: 'Performance Task (source materials + extended constructed work product)',
  structure: 'prompt (the assigned lawyering/professional task, e.g. draft/analyze/advise) + exhibits[] (the supplied source materials — client file, legal authorities, data — each {label,title,type,content:MARKDOWN}) + scoring_rubric + optional sample_response. The response is an extended constructed work product, human-scored — there is no machine answer key.',
  gradability: 'Not auto-gradable by design, but NOT unscorable: a prompt, at least one source exhibit, and a scoring_rubric are ALL required. The rubric is this format\'s answer key — a task without one cannot be scored, and a task without exhibits is not closed-universe.',
  syntax: [
    'State the task and deliverable clearly (what the examinee must produce).',
    'Provide the source materials as markdown exhibits referenced by the task.',
    'Include a scoring_rubric describing what a strong response demonstrates.',
  ],
  stimulusRule: 'The source materials (exhibits) are the shared stimulus the task operates on and should be embedded as markdown.',
};

// ── Canonical format slugs ──────────────────────────────────────────────────
// Analysis/guidelines LLMs invent slug variants (mcq_single_lr, mcq_shared_stimulus,
// reading_comprehension, argumentative_writing…). Map ANY such slug onto the fixed
// registry so every declared format resolves to a canonical question type with a
// fixed schema. Order matters — more specific patterns first.
const FORMAT_ALIASES: Array<[RegExp, string]> = [
  [/select[_\s-]?all|\bsata\b|multiple[_\s-]?response|mcq[_\s-]?multi|multi[_\s-]?select/, 'sata'],
  [/shared[_\s-]?stimulus|passage[_\s-]?set|reading[_\s-]?comprehension|passage[_\s-]?based|comprehension[_\s-]?set|\brc\b/, 'passage_set'],
  [/task[_\s-]?based|\btbs\b|simulation/, 'task_based_simulation'],
  [/case[_\s-]?study|case[_\s-]?based|\bcase\b/, 'case_study'],
  [/extended[_\s-]?matching|\bemq\b/, 'emq'],
  [/ordered[_\s-]?response|drag[_\s-]?(and[_\s-]?)?drop|sequenc|ordering|reorder/, 'ordered_response'],
  [/hot[_\s-]?spot|image[_\s-]?region|point[_\s-]?and[_\s-]?click|click[_\s-]?to/, 'hot_spot'],
  [/\bmatrix\b|\bgrid\b/, 'matrix_grid'],
  [/cloze|dropdown/, 'cloze_dropdown'],
  [/fill[_\s-]?in|fill[_\s-]?blank|numeric[_\s-]?entry/, 'fill_blank'],
  [/essay|constructed[_\s-]?response|writing[_\s-]?sample|argumentative[_\s-]?writing|free[_\s-]?text|written[_\s-]?response|short[_\s-]?answer/, 'constructed_response'],
  [/single|best[_\s-]?answer|one[_\s-]?best|standard[_\s-]?mcq|mcq|multiple[_\s-]?choice/, 'mcq_single'],
];

/** Map any (possibly LLM-invented) format slug to a canonical registry slug. */
export function canonicalizeFormatSlug(raw: string): string {
  const s = String(raw || '').toLowerCase().trim().replace(/\s+/g, '_');
  if (!s) return 'mcq_single';
  if (FORMAT_CONTRACTS[s]) return s === 'tbs' ? 'task_based_simulation' : s; // already canonical
  for (const [rx, canon] of FORMAT_ALIASES) if (rx.test(s)) return canon;
  return s; // genuinely unknown — leave as-is (buildContentSchema gives it no constraints)
}

/**
 * Resolve a declared format to a canonical registry slug by STRUCTURE / answer-model,
 * not just its name. First tries the slug (fast path); if that stays non-canonical,
 * inspects name + description + answer_format for the format's actual shape. This is
 * how "Integrated Question Sets" resolves to case_study and "Performance Tasks" to
 * performance_task even though their invented slugs match nothing by name.
 */
export function resolveFormat(hint: { slug?: string; name?: string; description?: string; answer_format?: string }): string {
  // Exam docs hyphenate heavily ("single-best-answer", "constructed-response",
  // "vignette-based"). Normalise separators so keyword tests actually match.
  const text = `${hint.name || ''} ${hint.description || ''} ${hint.answer_format || ''}`
    .toLowerCase().replace(/[-_]+/g, ' ').replace(/\s+/g, ' ');
  const has = (...ws: string[]) => ws.some((w) => text.includes(w));

  // ANSWER-MODEL OVERRIDE — this beats a canonical-but-WRONG slug. An extended
  // free-text WORK PRODUCT built on supplied source documents is a human-scored
  // performance task, never an auto-graded format. The analysis LLM readily
  // mislabels these as task_based_simulation (both carry exhibits), so the
  // structure must win over the slug here.
  const extendedConstructed = has('work product', 'extended free-text', 'extended free text', 'extended constructed', 'constructed work', 'drafting', 'draft a legal', 'memorandum', 'lawyering task');
  const hasSourceDocs = has('client file', 'source material', 'supplied authorities', 'authorities', 'library', 'realistic client', 'practice file', 'closed-universe');
  if (has('performance task', 'performance_task') || (extendedConstructed && hasSourceDocs)) return 'performance_task';

  // A slug that only says "these questions share a stimulus" (shared_stimulus,
  // question_set, integrated…) does NOT say WHICH kind — a reading passage or a
  // client matter. Skip the slug fast-path for those and let the structure decide,
  // otherwise "shared_stimulus" would always become passage_set.
  const slugText = String(hint.slug || '').toLowerCase();
  const ambiguousGrouped = /shared[_\s-]?stimulus|question[_\s-]?set|item[_\s-]?set|integrated|vignette[_\s-]?set/.test(slugText);
  const bySlug = canonicalizeFormatSlug(hint.slug || '');

  // Correct a canonical-but-contradicted grouped slug. A passage_set asserts a
  // READING passage; with no reading signal anywhere it is really a case/client
  // set. (And vice-versa for an explicitly reading-based case_study.)
  const readingSignal = has('passage', 'reading comprehension', 'reading passage', 'excerpt');
  if (bySlug === 'passage_set' && !readingSignal) return 'case_study';
  if (bySlug === 'case_study' && has('reading passage', 'reading comprehension')) return 'passage_set';

  if (!ambiguousGrouped && FORMAT_CONTRACTS[bySlug]) return bySlug; // known canonical slug

  // A shared stimulus feeding SEVERAL sibling questions → grouped set.
  const severalQuestions =
    has('several', 'multiple questions', 'related questions', 'set of questions', 'component questions',
        'each set', 'followed by', 'separately scored', 'item set', 'sub questions', 'labeled parts')
    || /\b(two|three|four|five|six|seven|eight|nine|ten|\d+)\s+[a-z ]{0,28}\b(questions|items|parts)\b/.test(text);
  const sharedStimulus = has('shared', 'common scenario', 'integrated', 'shared stimulus', 'scenario',
        'source materials, followed', 'passage', 'stimulus', 'vignette');
  if (has('integrated') || (sharedStimulus && severalQuestions)) {
    if (has('passage', 'reading comprehension', 'reading passage')) return 'passage_set';
    return 'case_study';
  }

  // Remaining constructed / selected-answer signals.
  if (extendedConstructed || has('constructed response', 'essay', 'short answer')) return 'constructed_response';
  if (has('select all', 'more than one', 'multiple correct', 'select each')) return 'sata';
  if (has('single best answer', 'best answer', 'multiple-choice', 'multiple choice', 'four options', 'one correct', 'select the correct')) return 'mcq_single';

  return bySlug;
}

/** Resolve a set of (possibly messy) format slugs to their contracts, de-duped. */
export function contractsFor(slugs: Iterable<string>): FormatContract[] {
  const seen = new Set<string>();
  const out: FormatContract[] = [];
  for (const raw of slugs) {
    const slug = String(raw || '').toLowerCase().trim();
    const c = FORMAT_CONTRACTS[slug];
    if (c && !seen.has(c.slug === 'tbs' ? 'task_based_simulation' : c.slug)) {
      seen.add(c.slug === 'tbs' ? 'task_based_simulation' : c.slug);
      out.push(c);
    }
  }
  return out;
}

/** Render one contract as a compact, prompt-ready text block. */
export function renderContract(c: FormatContract): string {
  const lines = [
    `### ${c.slug} — ${c.label}`,
    `- STRUCTURE: ${c.structure}`,
    `- GRADABILITY: ${c.gradability}`,
    `- SYNTAX: ${c.syntax.join(' ')}`,
  ];
  if (c.stimulusRule) lines.push(`- STIMULUS: ${c.stimulusRule}`);
  return lines.join('\n');
}

/** Render the contracts for a set of formats (falls back to the core set). */
export function renderContractsForPrompt(slugs: Iterable<string>): string {
  let contracts = contractsFor(slugs);
  if (contracts.length === 0) contracts = contractsFor(['mcq_single', 'sata', 'case_study']);
  return contracts.map(renderContract).join('\n\n');
}

// ─────────────────────────────────────────────────────────────────────────────
// JSON Schema builders — the DETERMINISTIC contract.
//
// buildContentSchema(format, params) returns a draft-07 JSON Schema describing the
// NORMALIZED `content` object the generator persists for a format (the shape that
// buildContentFromQuestion produces). The guidelines step materializes one of these
// per format — seeded from the canonical contract, tightened by exam-specific
// params — and stores it. Generation validates its output against it; the validator
// runs it as a deterministic pre-pass. Conditional rules that a static schema can't
// express (e.g. "IF the stem cites a passage THEN content.passage must exist") stay
// in the semantic gradability gate (review/shared.ts).
// ─────────────────────────────────────────────────────────────────────────────

export type SchemaParams = {
  numOptions?: number;        // exact option count (e.g. 5 for LSAT A–E)
  optionKeys?: string[];      // exact option keys, if the exam fixes them
  subQuestionCount?: number;  // exact sub-question count (case_study: 6)
  subQuestionMin?: number;    // TBS lower bound
  subQuestionMax?: number;    // TBS upper bound
  exhibitsAsMarkdown?: boolean; // TBS/case exhibits carry markdown content (default true)
  partsMin?: number;          // constructed_response item set: minimum labelled parts
  partsMax?: number;          // constructed_response item set: maximum labelled parts
};

type JsonSchema = Record<string, unknown>;
const NON_EMPTY_STR: JsonSchema = { type: 'string', minLength: 1 };
const STR: JsonSchema = { type: 'string' };

function optionsArraySchema(p: SchemaParams): JsonSchema {
  const item: JsonSchema = { type: 'object', required: ['key', 'text'], properties: { key: NON_EMPTY_STR, text: NON_EMPTY_STR } };
  const s: JsonSchema = { type: 'array', items: item };
  if (p.numOptions && p.numOptions > 0) { s.minItems = p.numOptions; s.maxItems = p.numOptions; }
  else s.minItems = 2;
  return s;
}

/** Map the LLM's snake_case schema_params onto the typed SchemaParams. */
export function normalizeSchemaParams(raw: unknown): SchemaParams {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const num = (v: unknown) => (typeof v === 'number' && v > 0 ? v : undefined);
  return {
    numOptions: num(r.num_options),
    optionKeys: Array.isArray(r.option_keys) ? (r.option_keys as unknown[]).map(String) : undefined,
    subQuestionCount: num(r.sub_question_count),
    subQuestionMin: num(r.sub_question_min),
    subQuestionMax: num(r.sub_question_max),
    exhibitsAsMarkdown: typeof r.exhibits_as_markdown === 'boolean' ? (r.exhibits_as_markdown as boolean) : undefined,
    partsMin: num(r.parts_min),
    partsMax: num(r.parts_max),
  };
}

export function buildContentSchema(format: string, p: SchemaParams = {}): JsonSchema {
  const base: JsonSchema = { $schema: 'http://json-schema.org/draft-07/schema#', type: 'object', additionalProperties: true };
  switch (format) {
    case 'mcq_single':
      return { ...base, required: ['stem', 'options', 'answer', 'explanation'], properties: {
        stem: NON_EMPTY_STR, passage: STR, options: optionsArraySchema(p),
        answer: { type: 'object', required: ['key'], properties: { key: NON_EMPTY_STR } },
        explanation: STR } };
    case 'mcq_multi':
    case 'sata':
      return { ...base, required: ['stem', 'options', 'answer', 'explanation'], properties: {
        stem: NON_EMPTY_STR, passage: STR, options: optionsArraySchema(p),
        answer: { type: 'object', required: ['keys'], properties: { keys: { type: 'array', minItems: 1, items: NON_EMPTY_STR } } },
        explanation: STR } };
    case 'ordered_response':
    case 'drag_drop':
      return { ...base, required: ['stem', 'items', 'correct_order', 'explanation'], properties: {
        stem: NON_EMPTY_STR,
        items: { type: 'array', minItems: 2, items: NON_EMPTY_STR },
        correct_order: { type: 'array', minItems: 2, items: { type: 'integer', minimum: 1 } },
        explanation: STR } };
    case 'fill_blank':
      return { ...base, required: ['stem', 'answer', 'explanation'], properties: {
        stem: NON_EMPTY_STR,
        answer: { type: 'object', required: ['value'], properties: {
          value: { anyOf: [{ type: 'string', minLength: 1 }, { type: 'number' }] }, unit: STR, acceptable_range: STR } },
        explanation: STR } };
    case 'hot_spot':
      return { ...base, required: ['stem', 'answer'], properties: {
        stem: NON_EMPTY_STR,
        stimulus: { type: 'object', properties: { type: { enum: ['text_targets', 'image_regions'] } } },
        answer: { type: 'object', anyOf: [
          { required: ['correct_ids'], properties: { correct_ids: { type: 'array', minItems: 1, items: NON_EMPTY_STR } } },
          { required: ['region'] } ] },
        explanation: STR } };
    case 'matrix_grid':
      return { ...base, required: ['stem', 'row_headers', 'column_headers'], properties: {
        stem: NON_EMPTY_STR,
        row_headers: { type: 'array', minItems: 1, items: NON_EMPTY_STR },
        column_headers: { type: 'array', minItems: 1, items: NON_EMPTY_STR },
        correct_cells: { type: 'array', items: { type: 'object', required: ['row', 'col'], properties: { row: { type: 'integer' }, col: { type: 'integer' } } } },
        correct_answer: { type: 'object' },
        explanation: STR },
        anyOf: [{ required: ['correct_cells'], properties: { correct_cells: { minItems: 1 } } }, { required: ['correct_answer'] }] };
    case 'cloze_dropdown':
      return { ...base, required: ['stem', 'blanks'], properties: {
        stem: NON_EMPTY_STR,
        blanks: { type: 'array', minItems: 1, items: { type: 'object', required: ['options', 'correct'],
          properties: { options: { type: 'array', minItems: 2, items: NON_EMPTY_STR }, correct: NON_EMPTY_STR } } },
        explanation: STR } };
    case 'emq':
      return { ...base, required: ['option_list', 'scenarios'], properties: {
        theme: STR,
        option_list: { type: 'array', minItems: 2, items: NON_EMPTY_STR },
        scenarios: { type: 'array', minItems: 1, items: { type: 'object', required: ['stem', 'correct_answer'],
          properties: { stem: NON_EMPTY_STR, correct_answer: NON_EMPTY_STR } } },
        explanation: STR } };
    case 'case_study': {
      const sub: JsonSchema = { type: 'array', items: { type: 'object', required: ['format_type'], properties: { format_type: NON_EMPTY_STR } } };
      if (p.subQuestionCount) { sub.minItems = p.subQuestionCount; sub.maxItems = p.subQuestionCount; } else sub.minItems = 1;
      return { ...base, required: ['case_narrative', 'sub_questions'], properties: {
        case_narrative: NON_EMPTY_STR, topics: { type: 'array' }, sub_questions: sub, response_instructions: STR, explanation: STR } };
    }
    case 'constructed_response':
    case 'essay':
      // Human-scored free text — a prompt is the only required field; no answer key.
      // The RUBRIC is the answer key — without it the item cannot be scored.
      //
      // An ITEM SET (CFA Level III) is a shared vignette plus labelled parts scored
      // SEPARATELY, so each part carries its own points and its own rubric. parts[]
      // is optional (a plain essay has none) but strictly validated when present;
      // an exam whose responses are always item sets sets parts_min.
      {
        const parts: JsonSchema = {
          type: 'array',
          items: {
            type: 'object',
            required: ['label', 'prompt', 'points', 'scoring_rubric'],
            properties: {
              label: NON_EMPTY_STR,
              prompt: NON_EMPTY_STR,
              points: { type: 'number', minimum: 1 },
              scoring_rubric: NON_EMPTY_STR,
              sample_response: STR,
            },
          },
        };
        if (p.partsMin) parts.minItems = p.partsMin;
        if (p.partsMax) parts.maxItems = p.partsMax;
        return { ...base, required: ['prompt', 'scoring_rubric', ...(p.partsMin ? ['parts'] : [])], properties: {
          prompt: NON_EMPTY_STR, vignette: STR, source_material: STR,
          parts, total_points: { type: 'number', minimum: 1 },
          sample_response: STR, scoring_rubric: NON_EMPTY_STR } };
      }
    case 'performance_task': {
      // Source-material exhibits + an extended constructed work product, human-scored.
      const exhibitContent: JsonSchema = p.exhibitsAsMarkdown === false ? STR : NON_EMPTY_STR;
      // A performance task is human-scored and closed-universe: the RUBRIC is its
      // answer key, and the supplied exhibits are the universe the examinee works
      // from. Requiring only `prompt` let rubric-less, source-less tasks pass.
      return { ...base, required: ['prompt', 'scoring_rubric', 'exhibits'], properties: {
        prompt: NON_EMPTY_STR,
        exhibits: { type: 'array', minItems: 1, items: { type: 'object', required: ['label', 'content'],
          properties: { label: NON_EMPTY_STR, title: STR, type: STR, content: exhibitContent } } },
        scoring_rubric: NON_EMPTY_STR, sample_response: STR } };
    }
    case 'passage_set': {
      const sub: JsonSchema = { type: 'array', minItems: p.subQuestionMin || 2,
        items: { type: 'object', required: ['format_type'], properties: { format_type: NON_EMPTY_STR } } };
      if (p.subQuestionMax) sub.maxItems = p.subQuestionMax;
      return { ...base, required: ['passage', 'sub_questions'], properties: {
        passage: NON_EMPTY_STR, topics: { type: 'array' }, sub_questions: sub, explanation: STR } };
    }
    case 'task_based_simulation':
    case 'tbs': {
      const exhibitContent: JsonSchema = p.exhibitsAsMarkdown === false ? STR : NON_EMPTY_STR;
      const sub: JsonSchema = { type: 'array', minItems: p.subQuestionMin || 1,
        items: { type: 'object', required: ['format_type'], properties: { format_type: NON_EMPTY_STR } } };
      if (p.subQuestionMax) sub.maxItems = p.subQuestionMax;
      return { ...base, required: ['exhibits', 'sub_questions'], properties: {
        scenario: STR, question: STR,
        exhibits: { type: 'array', minItems: 1, items: { type: 'object', required: ['label', 'content'],
          properties: { label: NON_EMPTY_STR, title: STR, type: STR, content: exhibitContent } } },
        sub_questions: sub, response_instructions: STR, explanation: STR } };
    }
    default:
      return base; // unknown/new format — no structural constraints (gate still applies)
  }
}

/**
 * Best-effort extraction of the format slugs an exam uses, tolerating the several
 * shapes the exam-format spec can take across courses.
 */
export function extractFormatSlugs(examFormat: Record<string, unknown> | undefined): string[] {
  if (!examFormat) return [];
  const out: string[] = [];
  const pushFrom = (arr: unknown, keys: string[]) => {
    if (!Array.isArray(arr)) return;
    for (const el of arr) {
      if (typeof el === 'string') { out.push(el); continue; }
      if (el && typeof el === 'object') {
        for (const k of keys) {
          const v = (el as Record<string, unknown>)[k];
          if (typeof v === 'string') { out.push(v); break; }
        }
      }
    }
  };
  pushFrom(examFormat.format_distribution, ['format', 'slug', 'type']);
  pushFrom(examFormat.question_formats, ['slug', 'type', 'format']);
  pushFrom(examFormat.question_type_allocations, ['slug', 'type', 'format']);
  pushFrom(examFormat.formats, ['slug', 'type', 'format']);
  // Also scan per-subject allocations if present.
  const subjects = examFormat.subjects || examFormat.subject_distribution;
  if (Array.isArray(subjects)) {
    for (const s of subjects) pushFrom((s as Record<string, unknown>)?.question_type_allocations, ['slug', 'type', 'format']);
  }
  return [...new Set(out.map((s) => s.toLowerCase().trim()).filter(Boolean))];
}
