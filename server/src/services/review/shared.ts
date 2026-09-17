/**
 * Shared utilities for review pipeline — formatting and parsing
 * Format-agnostic: handles MCQ, SATA, ordered response, fill-blank, hot-spot, etc.
 */

import type { ContentPart } from '../llm/openrouter.js';

// ── Format a single question as text block (format-aware) ──

// Formats whose per-format serializer above captures 100% of the answer-bearing
// content, so the raw-JSON safety net would be redundant. Everything else gets it.
const SIMPLE_FORMATS = new Set(['mcq_single', 'mcq_multi', 'sata', 'true_false', 'fill_blank']);
// Cap the raw-content dump so a huge case narrative can't blow up the batch payload.
const GROUND_TRUTH_CAP = 8000;

const _has = (v: unknown) =>
  v !== undefined && v !== null && v !== '' &&
  !(Array.isArray(v) && v.length === 0) &&
  !(typeof v === 'object' && !Array.isArray(v) && Object.keys(v as object).length === 0);

/** Structural check for ONE case-study/TBS sub-question (fields live on the sub-q). */
function subQuestionIssues(sq: Record<string, unknown>, n: number): string[] {
  const f = (sq.format_type as string) || 'mcq_single';
  const key = sq.correct_answer ?? sq.keyed_answer ?? sq.answer;
  const tag = `Sub-Q${n} (${f})`;
  const out: string[] = [];
  switch (f) {
    case 'mcq_single': if (!_has(sq.options)) out.push(`${tag}: missing options`); if (!_has(key)) out.push(`${tag}: missing correct_answer`); break;
    case 'sata': case 'mcq_multi': if (!_has(sq.options)) out.push(`${tag}: missing options`); if (!_has(sq.correct_answers) && !_has(key)) out.push(`${tag}: missing correct_answers`); break;
    case 'matrix_grid': if (!_has(sq.rows)) out.push(`${tag}: missing rows`); if (!_has(sq.columns)) out.push(`${tag}: missing columns`); if (!_has(key)) out.push(`${tag}: missing correct_answer`); break;
    case 'cloze_dropdown': if (!_has(sq.choices) && !_has(sq.blanks)) out.push(`${tag}: missing choices`); if (!_has(key)) out.push(`${tag}: missing correct_answer`); break;
    case 'fill_blank': if (!_has(key)) out.push(`${tag}: missing correct_answer (answer only in prose is invalid)`); break;
    case 'ordered_response': case 'drag_drop': if (!_has(sq.items)) out.push(`${tag}: missing items`); if (!_has(sq.correct_order)) out.push(`${tag}: missing correct_order`); break;
    case 'emq': if (!_has(sq.response_options)) out.push(`${tag}: missing response_options`); if (!_has(key) && !_has(sq.items)) out.push(`${tag}: missing answers`); break;
    case 'hot_spot': if (!_has(sq.stimulus)) out.push(`${tag}: missing stimulus`); if (!_has(sq.answer) && !_has(key)) out.push(`${tag}: missing answer`); break;
    default: if (!_has(key) && !_has(sq.correct_answers) && !_has(sq.correct_order)) out.push(`${tag}: missing an answer key`);
  }
  return out;
}

/** Structural check for a STANDALONE question (fields live on content, with
 *  legacy-column fallbacks so we never false-flag pre-content-migration data). */
function standaloneIssues(ft: string, c: Record<string, unknown>, q: Record<string, unknown>): string[] {
  const out: string[] = [];
  const answer = (c.answer as Record<string, unknown>) || {};
  switch (ft) {
    case 'mcq_single':
      if (!_has(c.options) && !_has(q.options)) out.push('missing options');
      if (!_has(answer.key) && !_has(q.correct_option)) out.push('missing answer');
      break;
    case 'sata': case 'mcq_multi':
      if (!_has(c.options) && !_has(q.options)) out.push('missing options');
      if (!_has(answer.keys) && !_has(q.correct_answers) && !_has(q.correct_option)) out.push('missing answers');
      break;
    case 'ordered_response': case 'drag_drop':
      if (!_has(c.items) && !_has(q.items)) out.push('missing items');
      if (!_has(c.correct_order) && !_has(q.correct_order)) out.push('missing correct_order');
      break;
    case 'fill_blank':
      if (!_has(answer.value) && !_has(answer.text) && !_has(answer.acceptable_range) && !_has(q.correct_answer_value) && !_has(q.correct_answer)) out.push('missing answer');
      break;
    case 'matrix_grid':
      if (!_has(c.row_headers) && !_has(c.rows)) out.push('missing row_headers');
      if (!_has(c.column_headers) && !_has(c.columns)) out.push('missing column_headers');
      if (!_has(c.correct_cells) && !_has(c.correct_answer)) out.push('missing correct_cells');
      break;
    case 'cloze_dropdown': {
      const blanks = (c.blanks as Array<Record<string, unknown>>) || [];
      if (!_has(blanks) && !_has(c.choices)) { out.push('missing blanks/choices'); break; }
      blanks.forEach((b, i) => {
        if (!_has(b.options)) out.push(`blank ${i + 1}: missing options`);
        if (!_has(b.correct) && !_has(b.correct_answer)) out.push(`blank ${i + 1}: missing correct`);
      });
      break;
    }
    case 'hot_spot': {
      const okNew = _has(c.stimulus) && _has(answer.correct_ids);
      const okLegacy = _has(answer.region) || _has(q.correct_region);
      if (!okNew && !okLegacy) out.push('missing stimulus/correct_ids');
      break;
    }
    case 'emq':
      if (!_has(c.option_list)) out.push('missing option_list');
      if (!_has(c.scenarios) && !_has(c.items)) out.push('missing scenarios');
      break;
    default:
      // Unknown/new format: require at least a recognizable answer somewhere.
      if (!_has(answer) && !_has(c.correct_answer) && !_has(q.correct_option) && !_has(q.correct_answer)) out.push(`format "${ft}": no recognizable answer key`);
  }
  return out.map((s) => `[${ft}] ${s}`);
}

/**
 * A question is only ANSWERABLE if any shared stimulus it references is actually
 * present. Reading-comprehension / passage / excerpt items (LSAT RC, GMAT/GRE
 * verbal, comprehension sets) and "shown above" figure items are ungradable when
 * the stem points at a passage/figure that lives nowhere in the record — even
 * though options + answer key exist. This is orthogonal to answer scaffolding, so
 * it's checked separately from standaloneIssues/subQuestionIssues.
 */
// Reference to a separate reading passage/excerpt, OR to an author's stance /
// a named "account" that is only meaningful if a passage is provided. Bare "the
// author" is intentionally NOT here — logical-reasoning stems print the argument
// inline and refer to "the author" of that inline argument.
const PASSAGE_REF_RX = /\bthe passage\b|\bin the passage\b|\baccording to the passage\b|\bbased on the passage\b|\bthe (?:excerpt|extract|reading)\b|\bpassages? (?:above|below)\b|\bpassage [AB]\b|\bthe author'?s? (?:attitude|position|view|viewpoint|opinion|stance|tone|main point|primary purpose|argument|claim|conclusion|reasoning)\b|\bthe (?:conventional|traditional|standard|prevailing|received) account\b/i;
// Reference to a visual that should be attached as an image or described in content.
const VISUAL_REF_RX = /\b(?:shown|depicted|illustrated|pictured|displayed) (?:above|below)\b|\bthe (?:figure|diagram|graph|chart|image|table|map|photograph) (?:above|below)\b|\bin the (?:figure|diagram|graph|chart|image) (?:above|below)\b/i;

// A genuine passage-based question that's MISSING its passage is a bare question
// (~a sentence or two). A self-contained question that legitimately refers to
// "the author" or "the account" prints the passage/argument inline, making the
// stem long. This length gate cleanly separates the two and avoids false-flagging
// self-contained items across any exam.
const INLINE_STIMULUS_MIN = 400;

/** True if a shared stimulus (passage/excerpt/exhibit field) is present. */
function stimulusPresent(c: Record<string, unknown>): boolean {
  if (_has(c.passage) || _has(c.stimulus) || _has(c.reading_passage) || _has(c.shared_stimulus) || _has(c.excerpt) || _has(c.context) || _has(c.scenario)) return true;
  return Array.isArray(c.exhibits) && c.exhibits.length > 0;
}

function referencedStimulusMissing(c: Record<string, unknown>, q: Record<string, unknown>): string[] {
  const stem = String((c.stem as string) ?? (q.question as string) ?? '');
  // Long stems carry their passage/argument inline → treat as self-contained.
  if (!stem || stem.length >= INLINE_STIMULUS_MIN || stimulusPresent(c)) return [];
  const out: string[] = [];
  if (PASSAGE_REF_RX.test(stem))
    out.push('stem refers to a reading passage / author\'s stance not present in the record (add the full passage to content.passage) — question is unanswerable as-is');
  const hasImage = !!q.is_image_question || _has(c.image) || (Array.isArray(c.media) && c.media.length > 0);
  if (!hasImage && VISUAL_REF_RX.test(stem))
    out.push('stem refers to a figure/diagram/table that is neither attached as an image nor described in content — question is unanswerable as-is');
  return out;
}

/**
 * Deterministic STRUCTURAL gradability check for ANY format — standalone
 * questions and case_study/TBS sub-questions alike. Returns concrete problems
 * (empty = fully gradable). Used as a HARD gate so an ungradable question can
 * never pass QA, regardless of format or course.
 */
export function gradabilityIssues(q: Record<string, unknown>): string[] {
  const ft = (q.format_type as string) || ((q.tags as Record<string, unknown>)?.format_type as string) || 'mcq_single';
  const c = (q.content as Record<string, unknown>) || {};
  // Grouped question — a shared stimulus feeding several sub-questions (case study,
  // TBS, reading passage set, or ANY future shared-stimulus format). Detected by
  // SHAPE (presence of sub_questions), not a hardcoded slug list, so new grouped
  // formats work with no code. The legacy slug list is kept only so a grouped
  // format that arrived with an EMPTY sub_questions array still fails loudly.
  const isGrouped = Array.isArray(c.sub_questions) || ['case_study', 'task_based_simulation', 'tbs', 'passage_set'].includes(ft);
  if (isGrouped) {
    const subs = (c.sub_questions as Array<Record<string, unknown>>) || [];
    if (subs.length === 0) return ['Grouped question has no machine-readable sub_questions'];
    const out = subs.flatMap((sq, i) => subQuestionIssues(sq, (sq.number as number) ?? i + 1));
    // The shared stimulus the sub-questions depend on must be present.
    const hasStimulus = _has(c.passage) || _has(c.case_narrative) || _has(c.scenario) || (Array.isArray(c.exhibits) && c.exhibits.length > 0);
    if (!hasStimulus) out.push('Grouped question is missing its shared stimulus (passage / narrative / exhibits)');
    return out;
  }
  return [...standaloneIssues(ft, c, q), ...referencedStimulusMissing(c, q)];
}

// Normalize difficulty to the labels the reviewer expects. Stored as int 1/2/3
// in the DB column but the rubric wants easy/medium/hard.
function normalizeDifficulty(v: unknown): string {
  if (v == null || v === '') return '';
  const s = String(v).toLowerCase().trim();
  if (['easy', 'medium', 'hard'].includes(s)) return s;
  return ({ '1': 'easy', '2': 'medium', '3': 'hard' } as Record<string, string>)[s] || s;
}

// Normalize Bloom's to the "N_label" form the validator expects. Stored as a
// bare number ('2'..'5') in the DB column, or already-normalized in content.
function normalizeBloom(v: unknown): string {
  if (v == null || v === '') return '';
  const s = String(v).toLowerCase().trim();
  if (/^[1-6]_/.test(s)) return s;
  return ({ '1': '1_remember', '2': '2_understand', '3': '3_apply', '4': '4_analyze', '5': '5_evaluate', '6': '6_create' } as Record<string, string>)[s] || s;
}

// Coerce a value (string or {text}/{label}/{id,text} object) to display text.
function asText(v: unknown): string {
  if (v == null) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'object') {
    const o = v as Record<string, unknown>;
    return String(o.text ?? o.label ?? o.name ?? o.value ?? JSON.stringify(o));
  }
  return String(v);
}

// Serialize a single sub-question of a case study so the reviewer can actually
// verify its stem, options, answer, and rationale (not just a count).
function formatSubQuestion(sq: Record<string, unknown>, j: number): string {
  const ft = (sq.format_type as string) || 'mcq_single';
  const stem = (sq.question as string) || (sq.stem as string) || '';
  const stepVal = sq.reasoning_step || sq.cjmm_step;
  const step = stepVal ? ` (step: ${stepVal})` : '';
  const lines = [`  Sub-Q${j + 1} [${ft}]${step}: ${stem}`];

  const opts = sq.options as unknown;
  if (Array.isArray(opts) && opts.length > 0) {
    lines.push('    Options: ' + opts.map((o) => {
      if (typeof o === 'string') return o;
      const oo = o as Record<string, unknown>;
      return `${oo.key ?? oo.id ?? ''}. ${asText(oo)}`.trim();
    }).join(' | '));
  }
  if (Array.isArray(sq.items) && (sq.items as unknown[]).length > 0) {
    lines.push('    Items: ' + (sq.items as unknown[]).map(asText).join(' | '));
  }
  const ans = sq.answer ?? sq.correct_answers ?? sq.correct_answer ?? sq.correct_order ?? sq.correct_option;
  if (ans !== undefined && ans !== null) {
    lines.push('    Correct Answer: ' + (typeof ans === 'object' ? JSON.stringify(ans) : String(ans)));
  }
  const rat = sq.rationale ?? sq.explanation;
  if (rat) lines.push('    Rationale: ' + (typeof rat === 'string' ? rat : JSON.stringify(rat)));
  const bloom = sq.blooms_level || sq.bloom;
  if (bloom) lines.push(`    Bloom: ${bloom}`);
  if (sq.difficulty) lines.push(`    Difficulty: ${sq.difficulty}`);
  return lines.join('\n');
}

function formatOneQuestion(q: Record<string, unknown>, i: number): string {
  const formatType = (q.format_type as string) || ((q.tags as Record<string, unknown>)?.format_type as string) || 'mcq_single';
  const content = q.content as Record<string, unknown> | undefined;

  // Use content JSONB if available, otherwise fall back to legacy columns
  const stem = (content?.stem as string) || (q.question as string) || '';

  // Shared reading stimulus (passage/excerpt). Lives in content but the mcq_single
  // serializer below only emits options+answer, and mcq_single skips the raw-content
  // dump — so without this the reviewer would score a passage-based question blind
  // (or wrongly flag a good one as "no passage"). Emit it right after the stem.
  const passageRaw = content?.passage ?? content?.reading_passage ?? content?.excerpt ?? content?.stimulus_text;
  const passageBlock = passageRaw ? `Passage:\n${asText(passageRaw)}\n` : '';

  let bodyStr = '';

  // Shape-driven grouped serialization: ANY question carrying sub_questions (case
  // study, TBS, reading passage set, or any future shared-stimulus format) is
  // serialized as shared stimulus + each sub-question — so the reviewer never sees
  // a grouped question "blind" (previously TBS fell through and rendered nothing).
  const groupedSubs = Array.isArray(content?.sub_questions) ? (content!.sub_questions as Array<Record<string, unknown>>) : null;
  if (groupedSubs) {
    const narrative = (content?.case_narrative as string) || (content?.scenario as string) || '';
    const exhibits = Array.isArray(content?.exhibits) ? (content!.exhibits as Array<Record<string, unknown>>) : [];
    const exhibitStr = exhibits.length
      ? '\nExhibits:\n' + exhibits.map((e, k) => `  [${asText(e.label) || `Exhibit ${k + 1}`}]${e.title ? ` ${asText(e.title)}` : ''}\n${asText(e.content)}`).join('\n')
      : '';
    const subStr = groupedSubs.map((sq, j) => formatSubQuestion(sq, j)).join('\n');
    bodyStr = `${narrative ? `Scenario/Narrative: ${narrative}\n` : ''}${exhibitStr}\nSub-questions (${groupedSubs.length}):\n${subStr}`;
  } else switch (formatType) {
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
      const subStr = subQs.map((sq, j) => formatSubQuestion(sq, j)).join('\n');
      bodyStr = `Case Narrative: ${narrative}\n\nSub-questions (${subQs.length}):\n${subStr}`;
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

  // Surface difficulty + Bloom's level. These live in DB COLUMNS (difficulty,
  // blooms_level), not in content JSONB, so if we don't emit them the reviewer
  // flags them "missing" on every question and caps the score at ~6. Normalize
  // to the labels the validator expects (easy/medium/hard, N_label).
  const difficulty = normalizeDifficulty(content?.difficulty ?? q.difficulty);
  const bloom = normalizeBloom(content?.bloom_level ?? q.blooms_level ?? q.bloom_level);
  const metaParts = [difficulty ? `Difficulty: ${difficulty}` : '', bloom ? `Bloom's level: ${bloom}` : ''].filter(Boolean);
  const metaLine = metaParts.length ? `\n${metaParts.join(' | ')}` : '';

  // Ground-truth safety net: the per-format serializers above are best-effort and
  // format-specific. For any complex/nested/unknown format (or a new format with
  // no dedicated branch, in any course), also attach the raw structured content so
  // a reviewer can never score "blind" because a branch omitted a field. Simple
  // MCQ-like formats are fully covered above, so we skip the redundant dump there.
  let groundTruth = '';
  if (content && !SIMPLE_FORMATS.has(formatType)) {
    const raw = JSON.stringify(content);
    const capped = raw.length > GROUND_TRUTH_CAP ? raw.slice(0, GROUND_TRUTH_CAP) + '…(truncated)' : raw;
    groundTruth = `\n[FULL STRUCTURED CONTENT — authoritative; verify against this]:\n${capped}`;
  }

  return `--- Q${i + 1} ---${formatLabel}${metaLine}
${passageBlock}Question: ${stem}
${bodyStr}
Explanation: ${explanation}${imageStatus ? '\n' + imageStatus : ''}${groundTruth}`;
}

// ── Format questions as plain text (no images) ──

export function formatQuestionsForReview(questions: Record<string, unknown>[]): string {
  return questions.map((q, i) => formatOneQuestion(q, i)).join('\n\n');
}

// ── Format questions as multimodal content (text + images) ──
// Returns ContentPart[] if any question has an image_url, otherwise returns a plain string.

// Download an image and return it as a base64 data URL, with retry + timeout.
// Returns null if the image is genuinely missing (404/403) or unreachable after
// retries. We fetch it OURSELVES (rather than letting the AI SDK download the URL)
// so a single transient "fetch failed" can't throw AI_DownloadError and crash the
// entire review pipeline — a failed image just degrades that one question to
// text-only review.
async function fetchImageAsDataUrl(url: string, attempts = 3): Promise<string | null> {
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 15000);
      const res = await fetch(url, { signal: controller.signal });
      clearTimeout(timer);
      if (!res.ok) {
        // Genuinely missing/forbidden — no point retrying.
        if (res.status === 404 || res.status === 403) return null;
        throw new Error(`HTTP ${res.status}`);
      }
      const buf = Buffer.from(await res.arrayBuffer());
      const mime = res.headers.get('content-type') || 'image/png';
      return `data:${mime};base64,${buf.toString('base64')}`;
    } catch (e) {
      if (attempt === attempts) {
        console.warn(`  [review] Image fetch failed after ${attempts} attempts (…${url.slice(-48)}): ${e instanceof Error ? e.message : e}`);
        return null;
      }
      await new Promise(r => setTimeout(r, 500 * attempt));
    }
  }
  return null;
}

export async function formatQuestionsForReviewWithImages(
  questions: Record<string, unknown>[]
): Promise<string | ContentPart[]> {
  const hasAnyImage = questions.some(q => q.is_image_question && q.image_url);

  if (!hasAnyImage) {
    // No images to show — return plain text (cheaper, faster)
    return formatQuestionsForReview(questions);
  }

  // Pre-fetch all images concurrently (as data URLs). Failures resolve to null.
  const dataUrls = await Promise.all(
    questions.map(q =>
      q.is_image_question && q.image_url
        ? fetchImageAsDataUrl(q.image_url as string)
        : Promise.resolve(null)
    )
  );

  // Build multimodal content parts: text blocks interleaved with images
  const parts: ContentPart[] = [];

  for (let i = 0; i < questions.length; i++) {
    const q = questions[i];
    const baseText = formatOneQuestion(q, i);
    const dataUrl = dataUrls[i];

    if (q.is_image_question && q.image_url && dataUrl) {
      parts.push({ type: 'text', text: baseText });
      parts.push({ type: 'image_url', image_url: { url: dataUrl } });
    } else if (q.is_image_question && q.image_url && !dataUrl) {
      // Image exists but could not be downloaded — review text-only rather than
      // crashing the batch. Tell the reviewer not to penalise the absent image.
      parts.push({
        type: 'text',
        text: baseText + '\nIMAGE: ⚠️ Could not be loaded for review — evaluate the text only; do NOT penalise for the missing image.',
      });
    } else {
      parts.push({ type: 'text', text: baseText });
    }
  }

  return parts;
}

// ── Parse JSON array from LLM response (V1 _extract_json_array pattern) ──

export function extractJsonArray(raw: string, expectedCount: number): Record<string, unknown>[] {
  let text = raw ?? '';
  if (text.includes('```json')) text = text.split('```json')[1].split('```')[0];
  else if (text.includes('```')) text = text.split('```')[1].split('```')[0];

  // Fast path: a complete array (first '[' to last ']') parses cleanly.
  const full = text.match(/\[[\s\S]*\]/);
  if (full) {
    try {
      const arr = JSON.parse(full[0].trim());
      if (Array.isArray(arr)) return arr.slice(0, expectedCount);
    } catch {
      // fall through to salvage
    }
  }

  // Salvage path: the response was truncated or malformed — e.g. the model hit
  // maxTokens mid-array, producing an "Unterminated string in JSON" error. The
  // old behaviour discarded the ENTIRE batch here (returned []), which the review
  // pipeline then scored as a default 5 and permanently flagged. Instead, recover
  // every complete top-level {...} object and drop only the truncated tail.
  //
  // Salvage scans from the first '[' to the END of the response (NOT the greedy
  // last-']' match, which can sit inside an object's own array value and chop a
  // valid object off).
  const open = text.indexOf('[');
  const body = open >= 0 ? text.slice(open) : text;
  const salvaged = salvageJsonObjects(body, expectedCount);
  if (salvaged.length < expectedCount) {
    console.warn(
      `  [extractJsonArray] Recovered ${salvaged.length}/${expectedCount} objects ` +
      `from malformed/truncated response (raw length=${raw?.length ?? 0})`
    );
  }
  return salvaged;
}

// Scan a (possibly truncated) JSON-array string and parse each complete
// top-level {...} object individually, skipping any trailing partial object.
// String-aware so braces inside string values don't corrupt depth tracking.
function salvageJsonObjects(text: string, limit: number): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  let depth = 0, start = -1, inStr = false, esc = false;
  for (let i = 0; i < text.length && out.length < limit; i++) {
    const ch = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') { inStr = true; continue; }
    if (ch === '{') { if (depth === 0) start = i; depth++; }
    else if (ch === '}') {
      depth--;
      if (depth === 0 && start >= 0) {
        try {
          const obj = JSON.parse(text.slice(start, i + 1));
          if (obj && typeof obj === 'object') out.push(obj as Record<string, unknown>);
        } catch {
          // this object itself is malformed — skip it
        }
        start = -1;
      }
    }
  }
  return out;
}
