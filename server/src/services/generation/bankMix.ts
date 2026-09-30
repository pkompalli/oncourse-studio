/**
 * Bank-level checks: faults you can only see by comparing questions to each other.
 *
 * `coherence.ts` asks whether a question contradicts itself, which is a property of one
 * question. Some faults are invisible at that scale and only appear across a whole exam:
 *
 *   - THREE of BAR's 57 questions tested one narrow point — whether a cash flow hedge of a
 *     forecast purchase adjusts the asset's basis. Each was individually fine. Together they
 *     spent 5% of a section on a single paragraph of ASC 815, and because all three were keyed
 *     the same wrong way, one authoring error cost a candidate three questions instead of one.
 *     That is the argument for checking mix: a repeated concept multiplies a mistake.
 *   - A subject the curriculum marks high-yield can end up with fewer questions than a
 *     low-yield one, which no per-question check can notice.
 *
 * Deliberately advisory. Nothing here fails a question or blocks a job: concentration is a
 * judgment call about a blueprint, and the right number of questions on a topic is not something
 * a script should decide. It reports, and generation logs it, so a human sees it before release.
 */

/** Words too common in exam prose to identify a concept. */
const STOPWORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'been', 'before', 'both', 'but', 'by', 'company',
  'corporation', 'did', 'do', 'does', 'during', 'each', 'entity', 'following', 'for', 'from',
  'had', 'has', 'have', 'how', 'in', 'is', 'it', 'its', 'not', 'of', 'on', 'one', 'or', 'should',
  'no', 'that', 'the', 'their', 'then', 'there', 'these', 'this', 'to', 'was', 'were', 'what',
  'when', 'which', 'who', 'will', 'with', 'would', 'year', 'years', 'client', 'other', 'under',
  'amount', 'amounts', 'reports', 'report', 'following', 'above', 'below', 'must', 'may', 'can',
  // Directive vocabulary. Every simulation in a bank shares it, so leaving it in clusters
  // questions on their response instructions rather than on what they ask.
  'using', 'exhibit', 'exhibits', 'select', 'selects', 'complete', 'completes', 'marked',
  'passage', 'passages', 'highlighted', 'review', 'determine', 'determines', 'calculate',
  'calculates', 'enter', 'enters', 'schedule', 'assume', 'assuming', 'closest', 'most', 'least',
  'appropriate', 'correct', 'best', 'likely',
]);

/**
 * How alike two questions must be, on distinctive vocabulary, to count as the same concept.
 *
 * Counting a shared phrase was the obvious approach and it does not work: "federal income tax"
 * appears in 14 of 81 tax questions, which is the subject matter rather than a concentration,
 * while the three questions that genuinely repeated one rule shared only "cash flow hedge" and
 * ranked below the noise. Pairwise overlap separates them, because near-duplicate questions
 * share most of their vocabulary with EACH OTHER, not just one term with the crowd.
 */
const SIMILARITY = 0.3;
/** Questions in one cluster before it is worth reporting. */
const CLUSTER_MIN = 3;
/** Terms every member must share, so a transitively-chained cluster is not reported. */
const MIN_SHARED_TERMS = 3;

export interface MixFinding {
  kind: 'concept-concentration' | 'weight-mismatch';
  exam: string;
  detail: string;
  /** Question ids involved, so a reviewer can go straight to them. */
  ids: string[];
}

const normalise = (s: string) =>
  s.toLowerCase().replace(/[^a-z0-9\s-]/g, ' ').split(/\s+/).filter(Boolean);

/** Distinctive vocabulary of a question, with boilerplate and bare numbers stripped. */
function terms(text: string): Set<string> {
  return new Set(
    normalise(text).filter((w) => !STOPWORDS.has(w) && w.length > 3 && !/^\d+$/.test(w))
  );
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  let shared = 0;
  for (const w of a) if (b.has(w)) shared++;
  return shared / (a.size + b.size - shared);
}

export interface MixInput {
  id: string;
  exam: string;
  subject?: string;
  /** The learner-visible prose that identifies the concept being tested. */
  text: string;
}

/**
 * Concepts tested by an unusual number of questions within one exam.
 *
 * Works on vocabulary overlap rather than a topic tag, because the tags are assigned round-robin
 * at generation and do not describe what a question actually asks: the three hedge questions were
 * tagged "Lessor accounting and sale-leaseback", "Revenue recognition" and "Business
 * combinations". Only the prose showed they were the same question three times.
 */
export function conceptConcentration(rows: MixInput[]): MixFinding[] {
  const byExam = new Map<string, MixInput[]>();
  for (const r of rows) {
    if (!byExam.has(r.exam)) byExam.set(r.exam, []);
    byExam.get(r.exam)!.push(r);
  }

  const findings: MixFinding[] = [];
  for (const [exam, list] of byExam) {
    const vocab = list.map((r) => ({ id: r.id, t: terms(r.text) }));

    // Connected components over "these two questions are largely the same words".
    const parent = new Map<string, string>(vocab.map((v) => [v.id, v.id]));
    const find = (x: string): string => {
      let r = x;
      while (parent.get(r) !== r) r = parent.get(r)!;
      return r;
    };
    const union = (a: string, b: string) => { parent.set(find(a), find(b)); };
    for (let i = 0; i < vocab.length; i++) {
      for (let j = i + 1; j < vocab.length; j++) {
        if (jaccard(vocab[i].t, vocab[j].t) >= SIMILARITY) union(vocab[i].id, vocab[j].id);
      }
    }

    const groups = new Map<string, string[]>();
    for (const v of vocab) {
      const root = find(v.id);
      if (!groups.has(root)) groups.set(root, []);
      groups.get(root)!.push(v.id);
    }

    for (const ids of groups.values()) {
      if (ids.length < CLUSTER_MIN) continue;
      // Name the cluster by the vocabulary every member shares.
      const sets = ids.map((id) => vocab.find((v) => v.id === id)!.t);
      const shared = [...sets[0]].filter((w) => sets.every((s) => s.has(w)));
      // Single-linkage chains members together transitively, so A and C can land in one group
      // while sharing almost nothing. A cluster whose members have only a word or two in common
      // ("rate") is an artefact of that chaining, not a concept worth reviewing.
      if (shared.length < MIN_SHARED_TERMS) continue;
      const pct = ((ids.length / list.length) * 100).toFixed(1);
      findings.push({
        kind: 'concept-concentration',
        exam,
        detail:
          `${ids.length} of ${list.length} questions (${pct}%) test what looks like one concept — `
          + `they share: ${shared.slice(0, 8).join(', ') || '(no common terms)'}`,
        ids,
      });
    }
  }
  return findings.sort((a, b) => b.ids.length - a.ids.length);
}

/**
 * Subjects the curriculum marks high-yield that carry fewer questions than subjects it does not.
 *
 * The v3 curriculum files carry official weights and high-yield flags at subject and topic
 * level (see importCurriculumV3.ts), so this is checkable against what the course actually
 * declares rather than against a guess.
 */
export function weightMismatch(
  rows: MixInput[],
  structure: Record<string, unknown>
): MixFinding[] {
  const subjects = (structure.subjects as Array<Record<string, unknown>>) || [];
  if (!subjects.length) return [];
  const highYield = new Map<string, boolean>();
  const examOf = new Map<string, string>();
  for (const s of subjects) {
    const name = String(s.name || '');
    const topics = (s.topics as Array<Record<string, unknown>>) || [];
    // A subject counts as high-yield when the curriculum flags any of its topics that way.
    highYield.set(name, topics.some((t) => t.high_yield === true));
    examOf.set(name, String(s.exam || ''));
  }

  const counts = new Map<string, number>();
  for (const r of rows) {
    if (!r.subject) continue;
    counts.set(r.subject, (counts.get(r.subject) || 0) + 1);
  }

  const findings: MixFinding[] = [];
  const byExam = new Map<string, string[]>();
  for (const [subject] of counts) {
    const exam = examOf.get(subject);
    if (!exam) continue;
    if (!byExam.has(exam)) byExam.set(exam, []);
    byExam.get(exam)!.push(subject);
  }

  for (const [exam, subjectNames] of byExam) {
    const hy = subjectNames.filter((s) => highYield.get(s));
    const lo = subjectNames.filter((s) => !highYield.get(s));
    if (!hy.length || !lo.length) continue;
    const minHy = Math.min(...hy.map((s) => counts.get(s) || 0));
    const maxLo = Math.max(...lo.map((s) => counts.get(s) || 0));
    if (minHy >= maxLo) continue;
    const thinnest = hy.find((s) => (counts.get(s) || 0) === minHy)!;
    const fattest = lo.find((s) => (counts.get(s) || 0) === maxLo)!;
    findings.push({
      kind: 'weight-mismatch',
      exam,
      detail:
        `high-yield subject "${thinnest}" has ${minHy} question(s) while "${fattest}", which the `
        + `curriculum does not mark high-yield, has ${maxLo}`,
      ids: [],
    });
  }
  return findings;
}

/** Every bank-level finding for a set of questions. */
export function bankMixFindings(rows: MixInput[], structure: Record<string, unknown> = {}): MixFinding[] {
  return [...conceptConcentration(rows), ...weightMismatch(rows, structure)];
}

/**
 * Load a whole job and report its bank-level findings. Called once, at the end of audit, which
 * is the first point in the pipeline that holds every question at the same time.
 *
 * Reads the exam from the question's own tag where generation stamped one, falling back to the
 * course structure's subject -> exam map, which is the same resolution the export uses.
 */
export async function bankMixForJob(jobId: string): Promise<MixFinding[]> {
  const { supabase } = await import('../../db/supabase.js');
  const { fetchAllRows } = await import('../../db/pagination.js');
  const { subjectExamMap } = await import('./examSize.js');

  const rows = await fetchAllRows<Record<string, any>>((from, to) =>
    supabase.from('qb_questions')
      .select('id,subject,tags,content')
      .eq('job_id', jobId).is('replaced_by_id', null)
      .in('status', ['approved', 'reviewed', 'generated'])
      .order('question_number', { ascending: true }).range(from, to));
  if (!rows.length) return [];

  const { data: job } = await supabase.from('qb_jobs').select('course_id').eq('id', jobId).single();
  const { data: course } = job?.course_id
    ? await supabase.from('qb_courses').select('structure').eq('id', job.course_id).single()
    : { data: null };
  const structure = (course?.structure || {}) as Record<string, unknown>;
  const examOfSubject = subjectExamMap(structure);

  const inputs: MixInput[] = rows.map((r) => {
    const c = (r.content || {}) as Record<string, unknown>;
    return {
      id: String(r.id),
      exam: String(r.tags?.exam || examOfSubject[r.subject] || 'unassigned'),
      subject: r.subject ? String(r.subject) : undefined,
      // The prose that says what is being TESTED, which for a grouped item is the stimulus and
      // not the directive. Reading `question` first clustered four simulations together on
      // "using, exhibits, review, marked, passage, select" — their shared response instructions,
      // identical across every document review in the bank and saying nothing about the subject.
      // The stimulus comes first now, and the directive is only a fallback for items with none.
      text: String(c.stem ?? c.case_narrative ?? c.vignette ?? c.scenario ?? c.question ?? ''),
    };
  }).filter((i) => i.text.length > 0);

  return bankMixFindings(inputs, structure);
}
