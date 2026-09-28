/**
 * Exam size — how many items a mock exam actually has, and how they split across
 * subjects and formats.
 *
 * The analysis is authoritative on all three numbers (total, per-subject, per-format);
 * the guidelines interpret them but must not invent them. Before this existed, the
 * total reached nothing downstream: exam_format.total_questions was displayed on the
 * structure page and read by no server code, so the guidelines LLM chose an exam
 * length of its own — CPA got 100 questions across 22 subjects, a number with no source.
 *
 * A real exam is specified in ITEMS, not percentages, and the two do not interchange:
 * a CPA AUD paper is 78 MCQs and 7 simulations, where MCQs are 91.8% of the items but
 * 50% of the score. Rounding a 10% share of 85 gives 8 or 9 simulations, never 7. So
 * counts travel as counts.
 */

/**
 * Force a set of counts to sum to `total`, keeping their relative shape.
 *
 * Scales proportionally, then walks the largest entries distributing the ±1 residual
 * that rounding leaves behind, never taking an entry below `min`. Lifted verbatim out
 * of fetchMockExamSpecs, which had done exactly this for subjects since the start —
 * the point of sharing it is that the guidelines reconciler stays bug-compatible with
 * the analysis rather than growing a second, subtly different rounding rule.
 *
 * Returns a new object; the input is untouched. A total that cannot be honoured
 * (fewer than `min * entries`) is clamped by the floor, so callers should treat the
 * returned sum as authoritative rather than assuming it equals `total`.
 */
export function rescaleToTotal(
  counts: Record<string, number>,
  total: number,
  min = 1
): Record<string, number> {
  const keys = Object.keys(counts);
  if (keys.length === 0 || !Number.isFinite(total) || total <= 0) return { ...counts };

  const floored: Record<string, number> = {};
  for (const k of keys) floored[k] = Math.max(min, Math.round(Number(counts[k]) || 0));

  const sum = Object.values(floored).reduce((a, b) => a + b, 0);
  if (sum === total || sum <= 0) return floored;

  const factor = total / sum;
  const scaled: Record<string, number> = {};
  for (const [k, c] of Object.entries(floored)) scaled[k] = Math.max(min, Math.round(c * factor));

  // Distribute what rounding left over, biggest entries first so the shape survives.
  let diff = total - Object.values(scaled).reduce((a, b) => a + b, 0);
  const bySize = Object.keys(scaled).sort((a, b) => scaled[b] - scaled[a]);
  let guard = bySize.length * Math.abs(diff) + bySize.length;
  while (diff !== 0 && guard-- > 0) {
    let moved = false;
    for (const k of bySize) {
      if (diff === 0) break;
      if (diff > 0) { scaled[k] += 1; diff -= 1; moved = true; }
      else if (scaled[k] > min) { scaled[k] -= 1; diff += 1; moved = true; }
    }
    if (!moved) break; // everything is at the floor — the floor wins over the total
  }
  return scaled;
}

/** Sum a distribution's counts, reading `questions` on objects or the number itself. */
export function sumCounts(d: Record<string, unknown> | undefined): number {
  if (!d || typeof d !== 'object') return 0;
  return Object.values(d).reduce<number>((n, v) => {
    if (typeof v === 'number') return n + v;
    const q = Number((v as Record<string, unknown>)?.questions);
    return n + (Number.isFinite(q) ? q : 0);
  }, 0);
}

/** The exam-size facts an exam_format can carry. Absent fields mean "not known". */
export interface ExamSize {
  total_questions?: number;
  time_minutes?: number;
  /** Real item count per canonical format slug, summing to total_questions. */
  format_question_counts?: Record<string, number>;
  /**
   * One entry per exam when a course spans several and all are being built.
   * CPA is six sections with six different papers — ISC is 82 MCQ + 6 TBS where AUD is
   * 78 + 7 — so each must be sized against its OWN total. A single blended total, which
   * is all this carried before, produced one paper that was sittable in none of them.
   */
  exam_sizes?: Record<string, ExamSizeEntry>;
}

export interface ExamSizeEntry {
  total_questions: number;
  time_minutes?: number;
  format_question_counts?: Record<string, number>;
}

/**
 * Subject name -> exam name, from structure.subjects[].exam.
 *
 * Safe as a plain map because subject names are unique across a course's exams (checked
 * across every stored course: CPA has 22 subjects over 6 exams with no duplicates). That
 * is what lets one flat subject_distribution carry every exam at once, leaving all its
 * existing consumers untouched.
 */
export function subjectExamMap(structure: Record<string, unknown> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const s of (structure?.subjects as Array<Record<string, unknown>>) || []) {
    const name = String(s?.name || '').trim();
    const exam = String(s?.exam || '').trim();
    if (name && exam) out[name] = exam;
  }
  return out;
}

/** Group keys by the exam each belongs to. Keys with no known exam share one '' group. */
export function groupByExam<T>(items: T[], examOf: (item: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const it of items) {
    const k = examOf(it) || '';
    const list = groups.get(k);
    if (list) list.push(it);
    else groups.set(k, [it]);
  }
  return groups;
}

/** Read the size an exam_format declares, ignoring anything non-numeric. */
export function readExamSize(examFormat: Record<string, unknown> | undefined): ExamSize {
  const num = (v: unknown) => (Number(v) > 0 ? Math.round(Number(v)) : undefined);
  const raw = examFormat?.format_question_counts as Record<string, unknown> | undefined;
  let counts: Record<string, number> | undefined;
  if (raw && typeof raw === 'object') {
    const out: Record<string, number> = {};
    for (const [k, v] of Object.entries(raw)) {
      const n = num(v);
      if (k && n) out[k] = n;
    }
    if (Object.keys(out).length > 0) counts = out;
  }
  const rawSizes = examFormat?.exam_sizes as Record<string, unknown> | undefined;
  let examSizes: Record<string, ExamSizeEntry> | undefined;
  if (rawSizes && typeof rawSizes === 'object') {
    const out: Record<string, ExamSizeEntry> = {};
    for (const [exam, v] of Object.entries(rawSizes)) {
      const e = v as Record<string, unknown> | undefined;
      const total = num(e?.total_questions);
      if (!exam || !total) continue;
      const fc = e?.format_question_counts as Record<string, unknown> | undefined;
      let fcOut: Record<string, number> | undefined;
      if (fc && typeof fc === 'object') {
        const m: Record<string, number> = {};
        for (const [k, n] of Object.entries(fc)) {
          const parsed = num(n);
          if (k && parsed) m[k] = parsed;
        }
        if (Object.keys(m).length > 0) fcOut = m;
      }
      out[exam] = { total_questions: total, time_minutes: num(e?.time_minutes), format_question_counts: fcOut };
    }
    if (Object.keys(out).length > 0) examSizes = out;
  }

  // With per-exam sizes the overall total is their sum, so a caller that only knows about
  // one number still sees a correct one.
  const summed = examSizes
    ? Object.values(examSizes).reduce((n, e) => n + e.total_questions, 0)
    : undefined;

  return {
    total_questions: summed || num(examFormat?.total_questions),
    time_minutes: num(examFormat?.time_minutes),
    format_question_counts: counts,
    exam_sizes: examSizes,
  };
}
