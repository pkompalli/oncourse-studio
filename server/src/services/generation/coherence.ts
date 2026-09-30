/**
 * Deterministic coherence checks — does a question contradict itself?
 *
 * Two deterministic gates already exist and neither models this. `gradabilityIssues`
 * (review/shared.ts) asks whether a question can be graded at all; `schemaErrorsFor`
 * (./schemaValidate.ts) asks whether it matches its format's content_schema. A QA pass over
 * the CPA, Bar and CFA banks found 52 faults that passed BOTH — every one gradable, every one
 * schema-valid — which is exactly why they reached a tester:
 *
 *   - response_instructions told learners to "complete every matrix and dropdown field" on a
 *     task whose only controls are four amount boxes, and to use a minus sign on a task whose
 *     only control is a dropdown of unsigned strings. 40 questions in one job.
 *   - a document-review span keyed "No change is required" also offered an option repeating
 *     the passage verbatim, so a learner who agreed with the key was marked wrong.
 *   - one document review keyed all eight passages "No change is required", so it scored 8/8
 *     without being read.
 *   - four Bar case sets instructed "For each mcq_single question…" — the generator's own
 *     type names.
 *
 * Prompting does not fix this. questionGeneration.ts already instructs the model that
 * "response_instructions must describe ONLY the response types that actually appear in the
 * sub-questions", and that was violated 40 times in a single job. Hence deterministic code.
 *
 * Shape follows ./schemaValidate.ts deliberately: a pure module with no I/O, imported by
 * generation (to repair its own output) and by review/validator.ts (as a deterministic
 * pre-pass). Nothing here calls an LLM or touches the database.
 *
 * The split between repair and flag is the important design line. `repairCoherence` only
 * changes what follows mechanically from the task's own fields — it never invents content and
 * never touches a stem, an exhibit or an answer key. Everything needing judgment is reported
 * by `coherenceIssues` and left alone.
 */

/**
 * What controls does this task actually put in front of the learner?
 *
 * Two different shapes carry controls and both have to be understood, or correct instructions
 * get flagged as wrong. A CPA simulation holds ONE work area whose controls are `spans`, or
 * `columns` with an `input` type, or a `grid_kind`. A case study holds SEVERAL sub-questions
 * whose own `format_type` IS the control — a `matrix_grid` sub-question is a matrix even
 * though it has no `columns`. Reading only the first shape made every case study look like it
 * had no controls at all, so its accurate "For the matrix, classify each row" read as a
 * reference to a field that did not exist.
 */
export interface FieldInventory {
  /** Document-review passages to be corrected in place. */
  spans: number;
  /** Cells the learner types a number into. */
  numeric: number;
  /** Per-row or per-blank single-choice controls. */
  dropdown: number;
  /** Row-by-column classification. */
  matrix: number;
  /** Account + debit/credit lines. */
  journal: number;
  /** Free prose. */
  freetext: number;
  /** Plain option lists (single- or multi-select). */
  options: number;
  /** Items placed in a sequence. */
  ordered: number;
  hasAnyControl: boolean;
  /**
   * True only for the single-work-area simulation shape, whose instructions this module can
   * regenerate faithfully. A case study's instructions are per-sub-format prose written for a
   * heterogeneous set; rebuilding them from an inventory would lose more than it fixed, so
   * those are checked but never rewritten.
   */
  rebuildable: boolean;
}

const NO_CHANGE = 'No change is required';

const norm = (v: unknown): string => String(v ?? '').replace(/\s+/g, ' ').trim();

/** Format slugs that are internal vocabulary and must never reach a learner. */
const INTERNAL_SLUGS = [
  'mcq_single', 'mcq_multi', 'mcq_multiple', 'sata', 'cloze_dropdown', 'matrix_grid',
  'document_review', 'data_entry_grid', 'applied_research', 'task_based_simulation',
  'case_study', 'passage_set', 'hotspot', 'drag_drop', 'ordered_response', 'fill_blank',
  'short_answer', 'emq', 'format_type', 'question_type',
];

export function fieldInventory(content: Record<string, unknown>): FieldInventory {
  const inv: FieldInventory = {
    spans: 0, numeric: 0, dropdown: 0, matrix: 0, journal: 0, freetext: 0, options: 0, ordered: 0,
    hasAnyControl: false, rebuildable: false,
  };
  const subs = (content.sub_questions as Array<Record<string, unknown>>) || [];
  let workAreas = 0;

  for (const s of subs) {
    const ft = String(s.format_type || s.question_type || '');
    const hasCols = Array.isArray(s.columns) && s.columns.length > 0;
    const hasSpans = Array.isArray(s.spans) && s.spans.length > 0;

    if (hasSpans) { inv.spans += (s.spans as unknown[]).length; workAreas++; continue; }

    // A journal-entry grid is its own control: an account dropdown plus debit/credit amounts.
    // Counting its columns as a generic dropdown and a number would describe the parts without
    // describing the entry.
    if (s.grid_kind === 'journal_entry') { inv.journal++; workAreas++; continue; }

    if (hasCols) {
      for (const col of (s.columns as Array<Record<string, unknown>>)) {
        if (col.input === 'number') inv.numeric++;
        if (col.input === 'select') inv.dropdown++;
      }
      workAreas++;
    }
    if (ft === 'applied_research') { inv.freetext++; workAreas++; }

    // Sub-question formats that ARE the control, in a case study or passage set.
    if (ft === 'matrix_grid' || (Array.isArray(s.row_headers) && Array.isArray(s.column_headers))) inv.matrix++;
    if (ft === 'cloze_dropdown' || Array.isArray(s.blanks)) inv.dropdown++;
    if (/^(mcq_single|mcq_multi|mcq_multiple|sata|emq)$/.test(ft) || Array.isArray(s.options)) inv.options++;
    if (/^(ordered_response|drag_drop)$/.test(ft)) inv.ordered++;
    if (ft === 'fill_blank' || ft === 'short_answer') inv.freetext++;
  }

  inv.hasAnyControl =
    inv.spans + inv.numeric + inv.dropdown + inv.matrix + inv.journal + inv.freetext + inv.options + inv.ordered > 0;
  // The simulation shape: exactly one work area, and no loose option-list sub-questions beside
  // it. formatContracts.ts states the contract — a TBS holds EXACTLY ONE work area.
  inv.rebuildable = workAreas === 1 && subs.length === 1;
  return inv;
}

/**
 * The order a journal-entry key uses. Verified across all thirteen entries in the CPA bank:
 * debits before credits, each side following the account list. Grids score per row id, so a
 * correct entry whose lines sit in another order loses the moved lines — one scored 2 of 30.
 * The grader is downstream of this repo, so the task has to state the order it expects.
 */
export const JOURNAL_ORDER_RULE =
  'Within each entry, enter all debit lines first, followed by all credit lines, taking the ' +
  'accounts on each side in the order they appear in the account list.';

/** Learner-facing replacements for the internal type names that leaked into instructions. */
const SLUG_REWRITES: Array<[RegExp, string]> = [
  [/For each mcq_single question, select one answer\./g, 'Where a question asks for a single answer, select one option.'],
  [/For each mcq_multi(?:ple)? question, select exactly two answers/g, 'Where a question asks you to select two, select exactly two options'],
  [/For each short_answer question, respond/g, 'For each short-answer question, respond'],
  [/Answer each short_answer question/g, 'Answer each short-answer question'],
  [/\bthe sata question\b/gi, 'the select-all-that-apply question'],
  [/\bsata questions\b/gi, 'select-all-that-apply questions'],
  [/\bsata\b/g, 'select-all-that-apply'],
  [/\bmcq_single\b/g, 'single-answer'],
  [/\bmcq_multi(?:ple)?\b/g, 'select-two'],
  [/\bshort_answer\b/g, 'short-answer'],
  [/\bordered_response\b/g, 'ordered response'],
  [/\bfill_blank\b/g, 'fill-in'],
  [/\bemq\b/g, 'extended matching'],
  [/\bdocument_review\b/g, 'document review'],
  [/\bdata_entry_grid\b/g, 'data-entry grid'],
  [/\bmatrix_grid\b/g, 'matrix'],
  [/\bcloze_dropdown\b/g, 'dropdown'],
  [/\bapplied_research\b/g, 'research'],
];

/**
 * Sentences worth carrying across a rebuild, because they state a durable fact about how to
 * express an answer rather than describing a control. Dropping them loses information the
 * task needs; keeping the wrong ones re-introduces the defect, so each is gated.
 *
 * Unit scale survives any inventory — a dropdown of "1,290" is still thousands of dollars.
 * Rounding only matters where something is typed. Derivation independence is about the
 * exhibits, not the fields, so it always survives.
 *
 * Deliberately NOT carried: precision claims ("percentages to two decimal places"). Those
 * assert a field type, and two of the three in the bank were false — the row in question
 * asked for dollars, not a percentage.
 */
const CARRY_FORWARD: Array<{ test: RegExp; needsNumeric: boolean }> = [
  { test: /whole thousands|in thousands|\$000/i, needsNumeric: false },
  { test: /\bround(?:ing|ed)?\b/i, needsNumeric: true },
  { test: /rather than on a prior response|base each response/i, needsNumeric: false },
];

function splitSentences(s: string): string[] {
  return s.split(/(?<=\.)\s+/).map((x) => x.trim()).filter(Boolean);
}

/**
 * Does this sentence name a control the task does not have, or a sign convention its fields
 * cannot accept?
 *
 * Each clause is matched against the specific control it names, not a lumped "has selections"
 * flag — a task with an account dropdown does not thereby have a matrix, and saying so is what
 * sent learners looking for fields that were not on screen.
 *
 * The sign clause needs no inventory: no task in the bank has a single negative key, and every
 * sub-question already asks for positive amounts, so "use a minus sign" is wrong wherever it
 * appears. That fact is what licensed fixing all 40 at once rather than only the 7 reported.
 */
function sentenceIsFalse(sentence: string, inv: FieldInventory): boolean {
  const anyDropdown = inv.dropdown > 0 || inv.journal > 0;
  const hasNumeric = inv.numeric > 0 || inv.journal > 0;
  if (/minus sign|parenthes|signed amount/i.test(sentence)) return true;
  if (/dropdown/i.test(sentence) && !anyDropdown) return true;
  if (/\bmatrix\b/i.test(sentence) && inv.matrix === 0 && inv.dropdown === 0) return true;
  if (/document[- ]review/i.test(sentence) && inv.spans === 0) return true;
  if (/journal[- ]entry|journal entry/i.test(sentence) && inv.journal === 0) return true;
  if (/numeric cells?|debit or credit|enter zero|enter 0\b/i.test(sentence) && !hasNumeric) return true;
  return false;
}

/** Instructions describing exactly the controls the task has, and nothing else. */
export function buildInstructions(content: Record<string, unknown>, previous = ''): string | null {
  const inv = fieldInventory(content);
  if (!inv.rebuildable) return null;
  const out: string[] = [];

  // Unit scale leads, because it qualifies every figure that follows.
  for (const sentence of splitSentences(previous)) {
    if (sentenceIsFalse(sentence, inv)) continue;
    const rule = CARRY_FORWARD.find((r) => r.test.test(sentence));
    if (rule && !rule.needsNumeric && /thousands|\$000/i.test(sentence)) out.push(sentence);
  }

  if (inv.spans > 0) {
    out.push(
      'For each highlighted passage, select the replacement that makes the statement correct, ' +
      `or select "${NO_CHANGE}" if the passage is already correct.`
    );
  }
  if (inv.journal > 0) {
    out.push(
      'For each line, select the account and enter its amount as a positive number in either ' +
      'the debit or the credit column, entering zero in the column that does not apply.'
    );
  }
  if (inv.numeric > 0 && inv.journal === 0) {
    out.push(
      'Enter all amounts as positive whole U.S. dollars without currency symbols or commas, ' +
      'and enter zero where no amount applies rather than leaving a cell blank.'
    );
  }
  if (inv.dropdown > 0 && inv.journal === 0 && inv.spans === 0) {
    out.push('Select one value for each row from the choices provided.');
  }
  if (inv.freetext > 0) {
    out.push('Enter your response in the field provided, basing it on the exhibits supplied.');
  }

  out.push('Every response field is scored independently, and a field left blank receives no credit.');

  if (inv.journal > 0) out.push(JOURNAL_ORDER_RULE);

  // Remaining durable facts trail the field mechanics.
  for (const sentence of splitSentences(previous)) {
    if (sentenceIsFalse(sentence, inv)) continue;
    if (/thousands|\$000/i.test(sentence)) continue; // already led with it
    const rule = CARRY_FORWARD.find((r) => r.test.test(sentence));
    if (!rule) continue;
    if (rule.needsNumeric && inv.numeric === 0 && inv.journal === 0) continue;
    if (!out.includes(sentence)) out.push(sentence);
  }

  return out.join(' ');
}

/**
 * Apply the repairs that follow mechanically from the task's own fields.
 *
 * Mutates `content` in place and returns a description of each change, so generation can log
 * what it corrected. Never invents content: it rewrites instructions to match the fields,
 * drops an option that duplicates the passage, and renames internal vocabulary. Anything
 * needing judgment is left for `coherenceIssues` to report.
 */
export function repairCoherence(content: Record<string, unknown>): string[] {
  const changes: string[] = [];
  if (!content || typeof content !== 'object') return changes;
  const inv = fieldInventory(content);

  // 1. An option repeating the passage verbatim while the key says to leave it alone. Both say
  //    the same thing, so the learner who agrees with the key is marked wrong.
  for (const s of ((content.sub_questions as Array<Record<string, unknown>>) || [])) {
    for (const sp of ((s.spans as Array<Record<string, unknown>>) || [])) {
      const opts = (sp.options as string[]) || [];
      if (norm(sp.correct) !== NO_CHANGE) continue;
      const keep = opts.filter((o) => norm(o) !== norm(sp.text));
      // Never strand a span below two choices; a thin span is reported instead.
      if (keep.length !== opts.length && keep.length >= 2) {
        sp.options = keep;
        changes.push(`span ${sp.id}: dropped an option repeating the passage verbatim`);
      }
    }
  }

  // 2. Internal type names in learner-visible text.
  for (const field of ['response_instructions', 'question', 'scenario', 'prompt'] as const) {
    const before = String(content[field] ?? '');
    if (!before) continue;
    let after = before;
    for (const [re, to] of SLUG_REWRITES) after = after.replace(re, to);
    if (after !== before) {
      content[field] = after.trim();
      changes.push(`${field}: replaced internal type names with learner-facing wording`);
    }
  }

  // 3. Instructions that name a control the task lacks, or demand a sign its fields cannot
  //    take. Rebuilt from the inventory rather than patched, because the stored text was
  //    assembled from a generic clause pool and is wrong sentence by sentence.
  const ri = String(content.response_instructions ?? '');
  if (ri && inv.rebuildable) {
    const wrong = splitSentences(ri).some((s) => sentenceIsFalse(s, inv));
    const missingOrder = inv.journal > 0 && !ri.includes(JOURNAL_ORDER_RULE);
    if (wrong || missingOrder) {
      const rebuilt = buildInstructions(content, ri);
      if (rebuilt && rebuilt !== ri) {
        content.response_instructions = rebuilt;
        changes.push(
          wrong
            ? 'response_instructions: rebuilt to describe only the fields the task has'
            : 'response_instructions: stated the line order the journal-entry key uses'
        );
      }
    }
  }

  return changes;
}

/**
 * Families of interchangeable party names. A rename shows up as an option using a DIFFERENT
 * member of the same family than the stem does — the stem says "supplier" three times and two
 * options say "wholesaler" about that same party.
 *
 * Kept to tight synonyms, which cost precision to buy correctness. A first attempt grouped a
 * whole supply chain — manufacturer, wholesaler, distributor, retailer, seller — and flagged
 * five sound questions, because in a products case those are DIFFERENT parties and an option is
 * entitled to name one the stem never did. Same for creditor and lender: a judgment creditor is
 * not the purchase-money lender. Only words that denote the same party by definition remain, so
 * this now misses a loose retailer/seller substitution and does not cry wolf.
 */
const ROLE_FAMILIES: string[][] = [
  ['supplier', 'wholesaler'],
  ['buyer', 'purchaser'],
  ['lessor', 'landlord'],
  ['lessee', 'tenant'],
  ['debtor', 'borrower'],
  ['employee', 'worker'],
];

/** Present value of an ordinary annuity of 1 for n periods at rate r. */
const pvAnnuity = (n: number, r: number) => (1 - Math.pow(1 + r, -n)) / r;

/**
 * Discount factors quoted in one stem must come from one rate.
 *
 * A capital-budgeting stem gave a four-year annuity factor of 3.0373 and a year-4 present value
 * factor of 0.6830. The first is 12%, the second is 10%; at 12% the year-4 factor is 0.6355.
 * Nothing about the item is malformed — it is simply unanswerable as a single NPV, and it moved
 * the keyed answer and two distractors once corrected. Solving the rate implied by the single
 * period factor and re-deriving the annuity factor catches it exactly.
 */
function discountFactorIssues(stem: string): string[] {
  // The number pattern must not swallow a sentence-ending period: a greedy [\d.]+ captured
  // "0.6830." and Number() turned that into NaN, so the check silently passed on the very
  // question it was written for.
  const NUM = String.raw`(\d+(?:\.\d+)?)`;
  const ann = stem.match(new RegExp(String.raw`(\w+|\d+)[- ]year annuity factor is ${NUM}`, 'i'))
    || stem.match(new RegExp(String.raw`annuity factor (?:for|over) (\d+) years is ${NUM}`, 'i'));
  const single = stem.match(new RegExp(String.raw`year[- ](\d+) present value factor is ${NUM}`, 'i'))
    || stem.match(new RegExp(String.raw`present value factor (?:for|at) year (\d+) is ${NUM}`, 'i'));
  if (!ann || !single) return [];
  const words: Record<string, number> = { two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };
  const nAnn = Number(ann[1]) || words[String(ann[1]).toLowerCase()];
  const annFactor = Number(ann[2]);
  const nSingle = Number(single[1]);
  const pvFactor = Number(single[2]);
  if (!nAnn || !nSingle || !annFactor || !pvFactor || nAnn !== nSingle) return [];
  const impliedRate = Math.pow(1 / pvFactor, 1 / nSingle) - 1;
  if (!(impliedRate > 0) || !Number.isFinite(impliedRate)) return [];
  const expected = pvAnnuity(nAnn, impliedRate);
  if (Math.abs(expected - annFactor) <= 0.01) return [];
  return [
    `discount factors come from different rates: the year-${nSingle} factor ${pvFactor} implies `
    + `${(impliedRate * 100).toFixed(1)}%, at which the ${nAnn}-year annuity factor is `
    + `${expected.toFixed(4)}, not the stated ${annFactor}`,
  ];
}

/** The same party called one thing in the stem and another in the options. */
function roleDriftIssues(stem: string, optionTexts: string[]): string[] {
  const has = (text: string, word: string) => new RegExp(`\\b${word}s?\\b`, 'i').test(text);
  const opts = optionTexts.join(' ');
  const out: string[] = [];
  for (const family of ROLE_FAMILIES) {
    const inStem = family.filter((w) => has(stem, w));
    if (inStem.length !== 1) continue; // ambiguous or absent — nothing to compare against
    const inOpts = family.filter((w) => has(opts, w) && !has(stem, w));
    if (!inOpts.length) continue;
    out.push(
      `the stem calls the party the "${inStem[0]}" but the options call it the `
      + `"${inOpts.join('", "')}" — the same role under two names`
    );
  }
  return out;
}

/**
 * A stem asking what to DO whose keyed answer is to do nothing.
 *
 * One item asked for "the strongest basis for action by the corporation" and keyed an option
 * beginning "Decline to pursue the director". The answer was right on the law — a disinterested
 * board's informed rejection releases the director — but no candidate reading the stem would
 * pick it, because declining is not a basis for action.
 */
function stemKeyPolarityIssues(stem: string, keyedText: string): string[] {
  const asksForAction = /\b(basis|ground|grounds|claim|cause of action)\b[^.?]*\b(for|to)\b[^.?]*\baction\b/i.test(stem)
    || /strongest (basis|ground|argument) for (action|suit|bringing)/i.test(stem);
  const keyDeclines = /^\s*(decline|do not|don't|refrain|take no action|no action|forgo|abstain)\b/i.test(keyedText);
  if (asksForAction && keyDeclines) {
    return [`the stem asks for a basis for action but the keyed answer declines to act ("${keyedText.slice(0, 50)}…")`];
  }
  return [];
}

/** A declarative sentence given a question mark, with yes/no options underneath it. */
function malformedQuestionIssues(prompt: string, optionTexts: string[]): string[] {
  const whole = prompt.trim();
  if (!whole.endsWith('?')) return [];
  // The interrogative lives in the LAST sentence. A stem is usually a fact pattern followed by
  // the question — "A merchant seller signed… Which of the following is correct?" — so testing
  // the whole thing flags every one of them.
  const t = (whole.split(/(?<=[.?])\s+/).pop() || whole).trim();
  const yesNo = optionTexts.filter((o) => /^\s*(?:[A-D][.)]\s*)?(yes|no)\b/i.test(o)).length;
  if (yesNo < 2) return [];
  // A real question often opens with a scoping clause — "Under Rule 15(c)(1)(C), does the
  // amended claim…" — so drop one leading clause before testing, or every such question is
  // flagged.
  const core = t.replace(/^(?:[^,?]{0,80}),\s*/, '');
  const interrogative = /^(does|do|did|is|are|was|were|has|have|had|can|could|may|might|must|should|would|will|which|what|why|how|who|whom|whose)\b/i
    .test(core);
  if (interrogative) return [];
  return [`reads as a statement but ends in a question mark, and its options are yes/no: "${t.slice(0, 70)}…"`];
}

/**
 * Report contradictions a learner would hit. Used as a deterministic pre-pass by the
 * validator, which caps the score and routes the question to the fixer.
 *
 * Accepts either a question row (with `.content`) or a bare content object.
 */
export function coherenceIssues(q: Record<string, unknown>): string[] {
  const content = ((q.content as Record<string, unknown>) || q) as Record<string, unknown>;
  const subs = (content.sub_questions as Array<Record<string, unknown>>) || [];

  // Checks that apply to a standalone question as much as to a work area, so they run before
  // the grouped-question gate below. An MCQ has no sub_questions at all and these faults —
  // mismatched discount factors, a party renamed between stem and options — were all found in
  // plain MCQs.
  const standalone: string[] = [];
  const optionTexts = (() => {
    const fromContent = content.options;
    if (Array.isArray(fromContent)) return fromContent.map((o: any) => String(o?.text ?? o ?? ''));
    if (fromContent && typeof fromContent === 'object') return Object.values(fromContent as Record<string, unknown>).map(String);
    const col = (q as Record<string, unknown>).options;
    if (col && typeof col === 'object') return Object.values(col as Record<string, unknown>).map(String);
    return [] as string[];
  })();
  const stem = String(content.stem ?? content.question ?? '');
  if (stem) {
    standalone.push(...discountFactorIssues(stem));
    if (optionTexts.length) {
      standalone.push(...roleDriftIssues(stem, optionTexts));
      standalone.push(...malformedQuestionIssues(stem, optionTexts));
      const keyLetter = String((content.answer as Record<string, unknown>)?.key ?? (q as Record<string, unknown>).correct_option ?? '');
      const keyed = (() => {
        if (Array.isArray(content.options)) {
          const hit = (content.options as Array<Record<string, unknown>>).find((o) => String(o.key) === keyLetter);
          return String(hit?.text ?? '');
        }
        const col = (q as Record<string, unknown>).options as Record<string, string> | undefined;
        return String(col?.[keyLetter] ?? '');
      })();
      if (keyed) standalone.push(...stemKeyPolarityIssues(stem, keyed));
    }
  }
  // Sub-questions of a grouped item carry their own prompts and options.
  for (const s of subs) {
    const sp = String(s.question ?? '');
    const so = (() => {
      const o = s.options;
      if (Array.isArray(o)) return o.map((x: any) => String(x?.text ?? x ?? ''));
      if (o && typeof o === 'object') return Object.values(o as Record<string, unknown>).map(String);
      return [] as string[];
    })();
    if (sp && so.length) standalone.push(...malformedQuestionIssues(sp, so));
  }

  if (!subs.length) return standalone;
  const inv = fieldInventory(content);
  const issues: string[] = [...standalone];
  const ri = String(content.response_instructions ?? '');

  // Repairable classes are still reported: a question reaching review with one of these means
  // generation's repair pass did not run, which is itself worth surfacing.
  for (const sentence of splitSentences(ri)) {
    if (!sentenceIsFalse(sentence, inv)) continue;
    issues.push(`response_instructions describe a field this task does not have: "${sentence.slice(0, 80)}"`);
    break;
  }
  if (inv.journal > 0 && !ri.includes(JOURNAL_ORDER_RULE)) {
    issues.push('journal-entry grid does not state the line order its key expects, so a correct entry in another order loses the moved lines');
  }
  const visible = [ri, content.question, content.scenario, content.prompt].map(norm).join(' ');
  const leaked = INTERNAL_SLUGS.find((s) => new RegExp(`\\b${s}\\b`).test(visible));
  if (leaked) issues.push(`learner-visible text contains the internal type name "${leaked}"`);

  for (const s of subs) {
    const spans = (s.spans as Array<Record<string, unknown>>) || [];
    for (const sp of spans) {
      const opts = (sp.options as string[]) || [];
      if (norm(sp.correct) === NO_CHANGE && opts.some((o) => norm(o) === norm(sp.text))) {
        issues.push(`span ${sp.id}: an option repeats the passage verbatim while the key is "${NO_CHANGE}", so both answers are the same claim`);
      }
      if (opts.length && !opts.some((o) => norm(o) === norm(sp.correct))) {
        issues.push(`span ${sp.id}: the keyed answer is not among its own options`);
      }
      if (opts.length > 0 && opts.length < 3) {
        issues.push(`span ${sp.id}: only ${opts.length} options, so the passage is close to a coin flip`);
      }
      if (new Set(opts.map(norm)).size !== opts.length) {
        issues.push(`span ${sp.id}: two options are identical`);
      }
      // A schedule authored as a markdown table, with the span markers placed across the cell
      // separators, makes each selectable unit carry a raw column pipe — candidates read
      // "Adjusted inventory balance | $393,000". Reported rather than repaired: de-piping the
      // span text alone would stop it matching the document it is anchored in, so the document
      // has to be restructured at the same time.
      if (String(sp.text ?? '').includes('|') || opts.some((o) => String(o).includes('|'))) {
        issues.push(`span ${sp.id}: text or options contain a raw table pipe, which the learner sees verbatim`);
      }
    }
    // A document review with nothing to find, or nothing correct, tests neither reading nor
    // judgment: one such task scored 8/8 without being read.
    if (spans.length >= 3) {
      const noChange = spans.filter((sp) => norm(sp.correct) === NO_CHANGE).length;
      if (noChange === spans.length) {
        issues.push(`every one of the ${spans.length} passages is keyed "${NO_CHANGE}", so the task scores full marks without being read`);
      } else if (noChange === 0) {
        issues.push(`no passage is correct as written, so "${NO_CHANGE}" is never the answer in this task`);
      }
    }
  }

  // An exhibit cited but never supplied. Ambiguous which side is wrong, so it is reported
  // rather than repaired.
  const exhibits = (content.exhibits as unknown[]) || [];
  if (exhibits.length > 0) {
    const cited = new Set<number>();
    const prose = [content.question, content.scenario, content.prompt, ...subs.map((s) => s.question)]
      .map((v) => String(v ?? '')).join(' ');
    for (const m of prose.matchAll(/Exhibits?\s+(\d+)(?:\s*(?:and|through|to|-|–)\s*(\d+))?/gi)) {
      cited.add(Number(m[1]));
      if (m[2]) for (let i = Number(m[1]); i <= Number(m[2]); i++) cited.add(i);
    }
    const missing = [...cited].filter((n) => n > exhibits.length).sort((a, b) => a - b);
    if (missing.length) {
      issues.push(`cites Exhibit ${missing.join(', ')} but only ${exhibits.length} exhibit(s) are supplied`);
    }
  }

  return issues;
}
