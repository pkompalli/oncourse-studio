/**
 * Does the bank match the blueprint it was generated from?
 *
 * Every other deterministic check in this pipeline reads ONE question. Gradability, schema,
 * coherence and consistency can all be answered without looking at anything else in the bank.
 * A distribution cannot: a question tagged "Business Law" at Bloom 3, medium, mcq_single is
 * unimpeachable on its own and still wrong if the exam already holds twice as many of them as
 * the blueprint asks for.
 *
 * The blueprint is not a guess. The course's generation_guidelines already declare all four:
 *
 *   exam_sizes[exam].format_question_counts   how many of each format this exam holds
 *   subject_distribution[subject].questions   how many questions each subject gets
 *   blooms_distribution                       percentage per normalized Bloom level
 *   difficulty_distribution                   percentage per easy/medium/hard
 *   answer_key_balance                        prose, but it states a hard cap in figures
 *
 * so this compares what was produced against what was asked for, per exam, and says which way
 * each gap runs. Per exam matters: CPA is six exams in one course and a shortfall in ISC is
 * invisible in a course-wide total that AUD's surplus cancels out.
 *
 * Nothing here blocks a question. A distribution gap is not a defect in any single item and
 * cannot be repaired by editing one — the remedy is to generate more of what is missing or
 * retire some of what is over-supplied, which is what topUpJobFormats.ts does. These are
 * reported to the job so a human can act on them, in the same way bankMix.ts reports
 * concentration.
 *
 * Pure module apart from the loader at the bottom: no LLM, no judgment.
 */

export interface DistributionFinding {
  dimension: 'format' | 'subject' | 'bloom' | 'difficulty' | 'answer_key';
  exam: string;
  detail: string;
  /** Negative when the bank is short of the blueprint, positive when it overshoots. */
  gap: number;
}

export interface DistributionInput {
  id: string;
  exam: string;
  subject?: string;
  format: string;
  bloom?: string;
  difficulty?: string;
  /** The keyed answer letter(s), for balance checking. Absent for non-choice formats. */
  answerKey?: string;
}

// ── Normalization ────────────────────────────────────────────────────────────────────────────

/**
 * The guidelines and the rows do not speak the same language, and neither is wrong.
 *
 * generation_guidelines writes Bloom as "3_apply" and difficulty as "medium". The questions
 * store the ordinal alone — blooms_level "3", difficulty 2 — with no text anywhere. Comparing
 * them without this mapping reported every bank in the system as carrying no Bloom or
 * difficulty value at all, which was a fault in the reader, not in 2,800 questions.
 */
const BLOOM_BY_ORDINAL = ['', 'remember', 'understand', 'apply', 'analyze', 'evaluate', 'create', 'integrate'];
const DIFFICULTY_BY_ORDINAL = ['', 'easy', 'medium', 'hard'];

/** "3_apply", "Apply", "apply", "3", 3 → "apply". */
export function bloomLabel(v: unknown): string {
  const s = String(v ?? '').trim().toLowerCase();
  if (!s) return '';
  if (/^\d+$/.test(s)) return BLOOM_BY_ORDINAL[Number(s)] ?? '';
  const m = s.match(/^\d+[_\s-]*(.*)$/);
  const word = (m ? m[1] : s).replace(/[^a-z]/g, '');
  return word || '';
}

/** "medium", "Medium", "2", 2 → "medium". */
export function difficultyLabel(v: unknown): string {
  const s = String(v ?? '').trim().toLowerCase();
  if (!s) return '';
  if (/^\d+$/.test(s)) return DIFFICULTY_BY_ORDINAL[Number(s)] ?? '';
  if (s.startsWith('eas')) return 'easy';
  if (s.startsWith('med') || s.startsWith('mod')) return 'medium';
  if (s.startsWith('har') || s.startsWith('dif')) return 'hard';
  return '';
}

/**
 * How far a count may stray before it is worth reporting, in questions.
 *
 * Deliberately different per dimension, because the blueprint means different things in each.
 * A format count is a structural promise about the paper — an exam that says 78 multiple-choice
 * and 7 simulations is not the same exam with 60 and 25 — so it is held tight. A subject
 * distribution is a sampling intention and drifts legitimately. Bloom and difficulty are
 * declared as percentages of a whole and read as a band.
 *
 * The floor of two questions keeps a small exam from reporting a gap of one, which is the
 * rounding of its own percentage rather than a fault.
 */
function toleranceFor(dimension: DistributionFinding['dimension'], target: number): number {
  switch (dimension) {
    case 'format': return Math.max(1, Math.ceil(target * 0.05));
    case 'subject': return Math.max(2, Math.ceil(target * 0.25));
    default: return Math.max(2, Math.ceil(target * 0.20));
  }
}

const countBy = <T>(rows: T[], key: (r: T) => string): Map<string, number> => {
  const out = new Map<string, number>();
  for (const r of rows) {
    const k = key(r);
    if (!k) continue;
    out.set(k, (out.get(k) || 0) + 1);
  }
  return out;
};

// ── The four blueprint dimensions ────────────────────────────────────────────────────────────

function formatFindings(exam: string, rows: DistributionInput[], guidelines: Record<string, unknown>): DistributionFinding[] {
  const sizes = (guidelines.exam_sizes as Record<string, Record<string, unknown>>) || {};
  const target = (sizes[exam]?.format_question_counts as Record<string, number>) || null;

  // A single-exam course declares its mix as format_distribution instead.
  const fallback = (() => {
    if (target) return null;
    const list = (guidelines.format_distribution as Array<Record<string, unknown>>) || [];
    if (!list.length) return null;
    const out: Record<string, number> = {};
    for (const f of list) {
      const n = Number(f.count);
      if (Number.isFinite(n) && n > 0) out[String(f.format)] = n;
    }
    return Object.keys(out).length ? out : null;
  })();

  const want = target || fallback;
  if (!want) return [];

  const actual = countBy(rows, (r) => r.format);
  const findings: DistributionFinding[] = [];
  for (const [format, expected] of Object.entries(want)) {
    const got = actual.get(format) || 0;
    const gap = got - expected;
    if (Math.abs(gap) <= toleranceFor('format', expected)) continue;
    findings.push({
      dimension: 'format', exam, gap,
      detail: `${format}: blueprint asks for ${expected}, bank holds ${got} (${gap > 0 ? '+' : ''}${gap})`,
    });
  }
  // A format nobody asked for is as much a blueprint breach as a missing one.
  for (const [format, got] of actual) {
    if (format in want) continue;
    findings.push({
      dimension: 'format', exam, gap: got,
      detail: `${format}: ${got} question(s) in a format the blueprint does not list for this exam`,
    });
  }
  return findings;
}

function subjectFindings(exam: string, rows: DistributionInput[], guidelines: Record<string, unknown>, examOfSubject: Record<string, string>): DistributionFinding[] {
  const dist = (guidelines.subject_distribution as Record<string, Record<string, unknown>>) || {};
  if (!Object.keys(dist).length) return [];

  const actual = countBy(rows, (r) => r.subject || '');
  const findings: DistributionFinding[] = [];
  for (const [subject, spec] of Object.entries(dist)) {
    // Only subjects belonging to THIS exam; a course-wide table covers all of them.
    if (examOfSubject[subject] && examOfSubject[subject] !== exam) continue;
    const expected = Number(spec?.questions);
    if (!Number.isFinite(expected) || expected <= 0) continue;
    const got = actual.get(subject) || 0;
    const gap = got - expected;
    if (Math.abs(gap) <= toleranceFor('subject', expected)) continue;
    findings.push({
      dimension: 'subject', exam, gap,
      detail: `${subject}: blueprint asks for ${expected}, bank holds ${got} (${gap > 0 ? '+' : ''}${gap})`,
    });
  }
  return findings;
}

/** Bloom and difficulty are declared as percentages, so compare them as counts of this exam. */
function percentageFindings(
  dimension: 'bloom' | 'difficulty',
  exam: string,
  rows: DistributionInput[],
  declared: Record<string, unknown> | undefined,
  labelOf: (r: DistributionInput) => string
): DistributionFinding[] {
  if (!declared || !Object.keys(declared).length) return [];
  const total = rows.length;
  if (!total) return [];

  const actual = countBy(rows, labelOf);
  const missing = rows.filter((r) => !labelOf(r)).length;
  const findings: DistributionFinding[] = [];

  if (missing > toleranceFor(dimension, total * 0.1)) {
    findings.push({
      dimension, exam, gap: missing,
      detail: `${missing} of ${total} question(s) carry no ${dimension} value at all`,
    });
  }

  for (const [rawLabel, rawPct] of Object.entries(declared)) {
    const pct = Number(rawPct);
    if (!Number.isFinite(pct)) continue;
    const label = dimension === 'bloom' ? bloomLabel(rawLabel) : difficultyLabel(rawLabel);
    if (!label) continue;
    const expected = Math.round((pct / 100) * total);
    const got = actual.get(label) || 0;
    const gap = got - expected;
    // A level the blueprint sets to zero is not a target to hit; only an overshoot matters.
    if (expected === 0 && got === 0) continue;
    if (Math.abs(gap) <= toleranceFor(dimension, Math.max(expected, 1))) continue;
    findings.push({
      dimension, exam, gap,
      detail: `${label}: blueprint asks for ${pct}% (~${expected} of ${total}), bank holds ${got} (${gap > 0 ? '+' : ''}${gap})`,
    });
  }
  return findings;
}

/**
 * Answer-key balance, against the cap the course states in prose.
 *
 * answer_key_balance is free text, but every course states its rule in figures — "no key may
 * account for more than 30% of MCQs", "no run may contain more than three consecutive". Those
 * two numbers are read out of the prose where they are there, and fall back to a permissive
 * default where they are not, since inventing a stricter rule than the course declared would
 * report a bank as broken for obeying its own guidelines.
 */
function answerKeyFindings(exam: string, rows: DistributionInput[], guidelines: Record<string, unknown>): DistributionFinding[] {
  const keyed = rows.filter((r) => r.answerKey && /^[A-J]$/.test(r.answerKey));
  if (keyed.length < 20) return [];

  const prose = String(guidelines.answer_key_balance ?? '');
  const sentences = prose.split(/(?<=[.;])\s+/);

  // Only a sentence unambiguously about ONE letter's share sets the cap. Matching any "more
  // than N%" in the whole paragraph read the Bar's "avoid repeating the same two-letter
  // combination more than 20% of the time" as a 20% cap on single keys, and then reported a
  // perfectly ordinary A/B/C spread of 31/30/23 as three separate breaches. Where no sentence
  // states the rule in a form that can be applied here, a permissive default is used: inventing
  // a stricter rule than the course declared manufactures defects out of compliance.
  const aboutOneLetter = (s: string) =>
    /\b(letter|key)\b/i.test(s)
    && !/combination|two-letter|selections|sata|mcq_multi|ordered/i.test(s);
  const capSentence = sentences.find((s) => aboutOneLetter(s) && /more than\s+\d{1,2}\s*%/i.test(s));
  const cap = capSentence ? Number(capSentence.match(/more than\s+(\d{1,2})\s*%/i)![1]) / 100 : 0.40;

  const words: Record<string, number> = { two: 2, three: 3, four: 4, five: 5 };
  const runSentence = sentences.find((s) => /consecutive/i.test(s) && /more than|no more than/i.test(s));
  const runMatch = runSentence?.match(/more than\s+(two|three|four|five|\d+)\s+consecutive/i)
    ?? runSentence?.match(/(two|three|four|five|\d+)\s+consecutive/i);
  const maxRun = runMatch ? (words[runMatch[1].toLowerCase()] ?? Number(runMatch[1])) : 4;

  const findings: DistributionFinding[] = [];
  const counts = countBy(keyed, (r) => r.answerKey!);
  for (const [key, n] of [...counts].sort((a, b) => b[1] - a[1])) {
    const share = n / keyed.length;
    if (share <= cap) continue;
    findings.push({
      dimension: 'answer_key', exam, gap: n - Math.round(cap * keyed.length),
      detail: `key ${key} is the answer to ${n} of ${keyed.length} choice items (${Math.round(share * 100)}%), above the declared ${Math.round(cap * 100)}% cap`,
    });
  }

  let run = 1;
  let worst = 1;
  let worstKey = '';
  for (let i = 1; i < keyed.length; i++) {
    if (keyed[i].answerKey === keyed[i - 1].answerKey) {
      run++;
      if (run > worst) { worst = run; worstKey = keyed[i].answerKey!; }
    } else {
      run = 1;
    }
  }
  if (worst > maxRun) {
    findings.push({
      dimension: 'answer_key', exam, gap: worst - maxRun,
      detail: `${worst} consecutive items share the key ${worstKey}, above the declared run limit of ${maxRun}`,
    });
  }
  return findings;
}

// ── Entry point ──────────────────────────────────────────────────────────────────────────────

export function distributionFindings(
  rows: DistributionInput[],
  guidelines: Record<string, unknown>,
  examOfSubject: Record<string, string> = {}
): DistributionFinding[] {
  if (!rows.length || !guidelines || !Object.keys(guidelines).length) return [];

  const byExam = new Map<string, DistributionInput[]>();
  for (const r of rows) {
    const exam = r.exam || 'unassigned';
    if (!byExam.has(exam)) byExam.set(exam, []);
    byExam.get(exam)!.push(r);
  }

  const out: DistributionFinding[] = [];
  for (const [exam, group] of byExam) {
    out.push(...formatFindings(exam, group, guidelines));
    out.push(...subjectFindings(exam, group, guidelines, examOfSubject));
    out.push(...percentageFindings('bloom', exam, group, guidelines.blooms_distribution as Record<string, unknown>, (r) => bloomLabel(r.bloom)));
    out.push(...percentageFindings('difficulty', exam, group, guidelines.difficulty_distribution as Record<string, unknown>, (r) => difficultyLabel(r.difficulty)));
    out.push(...answerKeyFindings(exam, group, guidelines));
  }
  return out;
}

/**
 * Load a whole job and report its blueprint conformance.
 *
 * Called at the end of the validator phase, which is the first point that holds every question
 * of a finished bank at once. Exam resolution follows the same rule as the export and
 * bankMix.ts: the tag generation stamped, falling back to the course structure's subject map.
 */
export async function distributionForJob(jobId: string): Promise<DistributionFinding[]> {
  const { supabase } = await import('../../db/supabase.js');
  const { fetchAllRows } = await import('../../db/pagination.js');
  const { subjectExamMap } = await import('./examSize.js');

  const rows = await fetchAllRows<Record<string, any>>((from, to) =>
    supabase.from('qb_questions')
      .select('id,subject,tags,content,difficulty,blooms_level,correct_option,format_id')
      .eq('job_id', jobId).is('replaced_by_id', null)
      .in('status', ['approved', 'reviewed', 'generated'])
      .order('question_number', { ascending: true }).range(from, to));
  if (!rows.length) return [];

  const { data: job } = await supabase.from('qb_jobs').select('course_id').eq('id', jobId).single();
  if (!job?.course_id) return [];
  const { data: course } = await supabase.from('qb_courses')
    .select('structure,generation_guidelines').eq('id', job.course_id).single();
  const guidelines = (course?.generation_guidelines || {}) as Record<string, unknown>;
  if (!Object.keys(guidelines).length) return [];

  const structure = (course?.structure || {}) as Record<string, unknown>;
  const examOfSubject = subjectExamMap(structure);

  const { data: formats } = await supabase.from('qb_question_formats').select('id,slug');
  const slugOf = new Map((formats || []).map((f: { id: string; slug: string }) => [f.id, f.slug]));

  const inputs: DistributionInput[] = rows.map((r) => {
    const c = (r.content || {}) as Record<string, any>;
    const key = c.answer?.key ?? r.correct_option;
    return {
      id: String(r.id),
      exam: String(r.tags?.exam || examOfSubject[r.subject] || 'unassigned'),
      subject: r.subject ? String(r.subject) : undefined,
      format: String(slugOf.get(r.format_id) || r.tags?.format_type || 'unknown'),
      bloom: c.bloom_level ?? r.blooms_level,
      difficulty: c.difficulty ?? r.difficulty,
      answerKey: typeof key === 'string' ? key.trim().toUpperCase() : undefined,
    };
  });

  return distributionFindings(inputs, guidelines, examOfSubject);
}
