/**
 * Deterministic internal-consistency checks — does everything the item asserts agree?
 *
 * Sibling to ./coherence.ts, and the division between them is worth keeping straight.
 * `coherence.ts` asks whether the item contradicts its own STRUCTURE: instructions naming a
 * control the task does not have, a span keyed to an option that is not offered. This module
 * asks whether the item contradicts its own CONTENT: a figure that does not follow from the
 * figures it is derived from, an explanation that names one option while the key names
 * another, two options carrying the same value.
 *
 * Why it exists: a QA pass over the six mock banks returned 19 items whose keys or options
 * were wrong, and in every one of them the explanation AGREED with the key. "B is correct
 * because…" where B was indeed what the row stored. Nothing that compares the key against the
 * explanation's verdict can see those — key and explanation were wrong together. What could be
 * seen, in the cases that turn on a number, is that the explanation's own arithmetic does not
 * hold. One asserted
 *
 *     systematic proportion is 0.05905/0.06905 = 73.02%
 *
 * and that division is 85.52%. The item was keyed to the 73.02% option. No model has to be
 * consulted to know the quotient is wrong; it is arithmetic, and arithmetic is checkable.
 *
 * Every check here is deliberately built to under-report. It runs as a blocking gate in the
 * validator, so a false positive costs a good question a fixer run and a capped score, while a
 * false negative costs nothing that the LLM stages were not already going to miss. Where an
 * expression admits several readings — a percentage that might be a fraction or might be a
 * number, a ratio that might be stated as a percent — every reading is tried and the item is
 * flagged only when NONE of them works.
 *
 * Pure module, following ./schemaValidate.ts and ./coherence.ts: no I/O, no LLM, no database.
 */

/** Blocking issues fail the gate; advisory ones are reported and scored but do not block. */
const ADVISORY_PATTERNS: RegExp[] = [
  /numeric options are not in ascending order/,
];

export function isBlockingConsistency(issue: string): boolean {
  return !ADVISORY_PATTERNS.some((re) => re.test(issue));
}

// ── Number parsing ───────────────────────────────────────────────────────────────────────────

/**
 * Thousands grouping is required rather than optional, and that strictness is the whole point.
 *
 * A permissive `[\d,]*` lets the regex engine backtrack: given "…= $560,000." the trailing
 * sentence period fails a following lookahead, the engine gives digits back, and the match
 * settles on "$560" — which then "disagrees" with an addition that was in fact correct. Nine
 * of the first twelve findings in a trial run were that one bug. Requiring groups of exactly
 * three digits removes the backtracking path entirely.
 */
const NUM = String.raw`\$?\d{1,3}(?:,\d{3})*(?:\.\d+)?%?[²³]?|\$?\d+(?:\.\d+)?%?[²³]?`;
const OP = String.raw`÷|/|×|x|\*|\+|-|−`;

/**
 * `a op b (op c …) = d`, with at least one operator on the left.
 *
 * The right-hand side has to be the WHOLE result, and the three lookaheads are what stop the
 * engine shortening it to get a match. Given "1/2 × 1/2 = 1/4" it would otherwise read the
 * result as "1"; given "195/110 = 1.7727 − 1 = 77.27%" it would give back the decimal digits
 * one at a time until "1" satisfied whatever followed. Both call true statements false. When
 * no complete reading exists the chain is skipped rather than guessed at.
 */
const CHAIN = new RegExp(
  String.raw`(?<![\w.])((?:${NUM})(?:\s*(?:${OP})\s*(?:${NUM}))+)\s*=\s*(${NUM})(?!\.\d)(?![\d,])(?!\s*(?:${OP}))`,
  'g'
);

/**
 * Notation this module cannot read, appearing where the expression continues.
 *
 * An explanation is free to write "$1,000(1.05) + $1,500/1.05 + $2,000/1.05² = $4,292.63" or
 * "0.06 × √100 × 0.75 = 0.45". Both are correct and neither parses here: the match starts
 * after the part it cannot read, evaluates a fragment, and reports a sound calculation as
 * wrong. Rather than grow a parser for parentheses and radicals, refuse to judge any chain
 * whose left edge abuts one — the cost is a missed check on expressions of that shape, which
 * is the right side to err on for a gate that blocks.
 */
const CONTINUES_LEFT = /[+\-×÷*/()√^−]$/;

interface Term { value: number; percent: boolean }

function parseTerm(raw: string): Term | null {
  let s = raw.trim().replace(/\$/g, '').replace(/,/g, '').replace(/−/g, '-');
  let power = 1;
  if (s.endsWith('²')) { power = 2; s = s.slice(0, -1); }
  else if (s.endsWith('³')) { power = 3; s = s.slice(0, -1); }
  let percent = false;
  if (s.endsWith('%')) { percent = true; s = s.slice(0, -1); }
  const v = Number(s);
  if (!Number.isFinite(v)) return null;
  return { value: Math.pow(v, power), percent };
}

/**
 * Evaluate a chain with ×/÷ binding tighter than +/−.
 *
 * `asFraction` decides how a percentage operand is read. Explanations use both conventions in
 * the same breath — "0.75 × 18% = 13.5" works in percentage points, "1 − 40% = 60%" works in
 * fractions — so rather than guess, the caller evaluates under both and accepts either.
 */
function evaluateChain(expr: string, asFraction: boolean): number | null {
  const parts = expr.split(new RegExp(String.raw`\s*(${OP})\s*`));
  const values: Term[] = [];
  const ops: string[] = [];
  for (let i = 0; i < parts.length; i++) {
    if (i % 2 === 0) {
      const t = parseTerm(parts[i]);
      if (!t) return null;
      values.push(t);
    } else {
      ops.push(parts[i].replace('−', '-'));
    }
  }
  if (values.length !== ops.length + 1) return null;

  const nums = values.map((t) => (t.percent && asFraction ? t.value / 100 : t.value));
  const stack = [...nums];
  const rest = [...ops];
  for (let i = 0; i < rest.length;) {
    const op = rest[i];
    if (op === '×' || op === '*' || op === 'x' || op === '/' || op === '÷') {
      const a = stack[i];
      const b = stack[i + 1];
      if ((op === '/' || op === '÷') && b === 0) return null;
      stack.splice(i, 2, op === '×' || op === '*' || op === 'x' ? a * b : a / b);
      rest.splice(i, 1);
    } else {
      i++;
    }
  }
  let out = stack[0];
  for (let i = 0; i < rest.length; i++) out = rest[i] === '+' ? out + stack[i + 1] : out - stack[i + 1];
  return Number.isFinite(out) ? out : null;
}

/** Close enough that no reader would call it an error: half a percent, or a cent. */
function near(stated: number, actual: number): boolean {
  return Math.abs(stated - actual) <= Math.max(0.01, Math.abs(actual) * 0.005);
}

/**
 * A stated result that no reading of its own expression produces.
 *
 * Candidates cover both percentage conventions and the ×100 a ratio picks up when it is
 * written as a percent, because "1.04²/1.03 − 1 = 5.01%" is correct and its literal quotient
 * is 0.0501. Accepting the scaled forms unconditionally gives up detection of a genuine
 * hundredfold slip, which is the right trade for a gate that must not fire on sound work.
 */
export function arithmeticIssues(text: string): string[] {
  const out: string[] = [];
  if (!text) return out;
  for (const m of text.matchAll(CHAIN)) {
    const before = text.slice(0, m.index ?? 0).trimEnd();
    if (CONTINUES_LEFT.test(before)) continue;
    const stated = parseTerm(m[2]);
    if (!stated) continue;
    const candidates: number[] = [];
    for (const asFraction of [true, false]) {
      const got = evaluateChain(m[1], asFraction);
      if (got === null) continue;
      candidates.push(got, got * 100, got / 100);
    }
    if (!candidates.length) continue;
    if (candidates.some((c) => near(stated.value, c))) continue;
    const truth = evaluateChain(m[1], true);
    out.push(
      `the explanation states "${m[0].trim().slice(0, 80)}" but that expression evaluates to ${
        truth === null ? 'something else' : round(truth)
      }`
    );
    if (out.length >= 3) break;
  }
  return out;
}

function round(n: number): string {
  const abs = Math.abs(n);
  if (abs !== 0 && abs < 0.01) return n.toPrecision(4);
  return String(Math.round(n * 10000) / 10000);
}

// ── Verdict agreement ────────────────────────────────────────────────────────────────────────

const LETTER = '([A-J])';
/** "B is correct", "Option B is correct", "the correct answer is B". */
const ASSERTS_CORRECT: RegExp[] = [
  new RegExp(String.raw`\b(?:option\s+)?${LETTER}\b\s+is\s+(?:the\s+)?correct\b`, 'gi'),
  new RegExp(String.raw`\bcorrect\s+answer\s+is\s+(?:option\s+)?${LETTER}\b`, 'gi'),
];
/** "B is incorrect", "B is wrong", "B is not correct". */
const ASSERTS_WRONG = new RegExp(
  String.raw`\b(?:option\s+)?${LETTER}\b\s+is\s+(?:not\s+correct|incorrect|wrong)\b`,
  'gi'
);

/**
 * The explanation's own verdict, against the key the row stores.
 *
 * This did not fire once across the 19 round-3 defects, because in every one of them the
 * explanation and the key agreed and were wrong together. It stays because the failure it
 * describes is cheap to test and catastrophic when it happens — the learner is shown a
 * justification for an option the grader marks wrong — and because a fixer that changes a key
 * without rewriting the explanation creates it from nothing.
 */
export function verdictIssues(explanation: string, keys: string[]): string[] {
  if (!explanation || !keys.length) return [];
  const keySet = new Set(keys.map((k) => k.toUpperCase()));
  const out: string[] = [];
  const claimed = new Set<string>();
  for (const re of ASSERTS_CORRECT) {
    for (const m of explanation.matchAll(re)) claimed.add(m[1].toUpperCase());
  }
  for (const letter of claimed) {
    if (!keySet.has(letter)) {
      out.push(`the explanation says option ${letter} is correct but the key is ${[...keySet].join('+')}`);
    }
  }
  for (const m of explanation.matchAll(ASSERTS_WRONG)) {
    const letter = m[1].toUpperCase();
    if (keySet.has(letter)) {
      out.push(`the explanation calls option ${letter} incorrect, and ${letter} is the keyed answer`);
    }
  }
  return [...new Set(out)];
}

// ── Option-set consistency ───────────────────────────────────────────────────────────────────

/**
 * The value of an option that IS a number, and nothing for one that merely contains one.
 *
 * Taking the first number out of free prose compares things that are not comparable: "File
 * Form 8-K by Tuesday" and "File Form 8-K by Friday" both reduce to 8, and "$0 dividend income
 * and $3,000 basis" reduces to 0 alongside a genuinely different option. That single
 * loose reading produced 202 of the 208 findings in a trial run. An option counts as numeric
 * only when the whole of it is a quantity, allowing a trailing unit and closing punctuation.
 */
const PURE_NUMBER = new RegExp(
  String.raw`^-?(?:${NUM})\s*(?:million|billion|thousand|bps|basis points|days?|weeks?|months?|years?|shares?|units?|times?)?[.,;]?$`,
  'i'
);

const numericOf = (s: string): number | null => {
  const t = String(s).trim();
  if (!PURE_NUMBER.test(t)) return null;
  // The sign is part of the value. Matching NUM alone read "-0.866" as 0.866 and called it a
  // duplicate of the "0.866" option sitting beside it — two genuinely opposite answers.
  const m = t.match(new RegExp(String.raw`-?(?:${NUM})`));
  if (!m) return null;
  const negative = m[0].startsWith('-');
  const parsed = parseTerm(m[0].replace(/^-/, ''));
  return parsed ? (negative ? -parsed.value : parsed.value) : null;
};

/**
 * Two options that are the same answer.
 *
 * A duplicated value means the item has two keys or none, whichever way it is graded. Compared
 * on the numeric value rather than the text, because "$73,600" and "73,600" are the same
 * answer written twice, and a candidate choosing the unkeyed one is marked wrong for agreeing.
 */
export function optionIssues(optionTexts: string[]): string[] {
  const out: string[] = [];
  if (optionTexts.length < 2) return out;

  const seen = new Map<string, number>();
  optionTexts.forEach((t, i) => {
    const norm = String(t).replace(/^\s*[A-J][.)]\s*/, '').replace(/\s+/g, ' ').trim().toLowerCase();
    if (!norm) return;
    if (seen.has(norm)) out.push(`options ${seen.get(norm)! + 1} and ${i + 1} are the same text`);
    else seen.set(norm, i);
  });

  const values = optionTexts.map((t) => numericOf(t.replace(/^\s*[A-J][.)]\s*/, '')));
  const allNumeric = values.every((v) => v !== null) && values.length >= 3;
  if (allNumeric) {
    const nums = values as number[];
    const dupes = new Map<number, number>();
    nums.forEach((v, i) => {
      if (dupes.has(v)) out.push(`options ${dupes.get(v)! + 1} and ${i + 1} carry the same value ${v}`);
      else dupes.set(v, i);
    });
    const ascending = nums.every((v, i) => i === 0 || v >= nums[i - 1]);
    const descending = nums.every((v, i) => i === 0 || v <= nums[i - 1]);
    if (!ascending && !descending) out.push('numeric options are not in ascending order');
  }
  return out;
}

// ── Entry point ──────────────────────────────────────────────────────────────────────────────

function optionTextsOf(source: Record<string, unknown>, fallback?: Record<string, unknown>): string[] {
  const opts = source.options ?? fallback?.options;
  if (Array.isArray(opts)) {
    return opts.map((o) => (typeof o === 'string' ? o : String((o as Record<string, unknown>)?.text ?? '')));
  }
  if (opts && typeof opts === 'object') return Object.values(opts as Record<string, unknown>).map(String);
  return [];
}

function keysOf(source: Record<string, unknown>, row?: Record<string, unknown>): string[] {
  const answer = (source.answer as Record<string, unknown>) || {};
  const raw = answer.keys ?? answer.key ?? source.correct_answer ?? source.correct_answers
    ?? row?.correct_option ?? row?.correct_answers;
  if (Array.isArray(raw)) return raw.map(String);
  if (typeof raw === 'string' && raw.trim()) return [raw.trim()];
  return [];
}

/**
 * Report internal inconsistencies. Accepts a question row (with `.content`) or a bare content
 * object, matching `coherenceIssues` so the validator can call them side by side.
 *
 * Grouped items are checked per sub-question as well as at the top level: a case study's
 * rationale belongs to its own sub-question, and comparing it against the parent's key would
 * be meaningless.
 */
export function consistencyIssues(q: Record<string, unknown>): string[] {
  const content = ((q.content as Record<string, unknown>) || q) as Record<string, unknown>;
  const row = q as Record<string, unknown>;
  const issues: string[] = [];

  const explanation = String(content.explanation ?? row.explanation ?? '');
  const subs = (content.sub_questions as Array<Record<string, unknown>>) || [];

  if (!subs.length) {
    issues.push(...arithmeticIssues(explanation));
    issues.push(...verdictIssues(explanation, keysOf(content, row)));
    issues.push(...optionIssues(optionTextsOf(content, row)));
    return issues;
  }

  // A grouped item's own explanation is an overview of the set; it carries no key of its own,
  // so only its arithmetic is meaningful here.
  issues.push(...arithmeticIssues(explanation));
  subs.forEach((s, i) => {
    const rationale = String(s.rationale ?? s.explanation ?? '');
    const tag = `sub-question ${i + 1}`;
    for (const issue of arithmeticIssues(rationale)) issues.push(`${tag}: ${issue}`);
    for (const issue of verdictIssues(rationale, keysOf(s))) issues.push(`${tag}: ${issue}`);
    for (const issue of optionIssues(optionTextsOf(s))) issues.push(`${tag}: ${issue}`);
  });
  return issues;
}
