/**
 * Before/after benchmark for the exam-profile changes (examProfile.ts): the same generated items reviewed
 * and audited by the old pipeline and by the new one, then judged blind for closeness to the real exam.
 *
 *   gen    npx tsx src/scripts/benchmarkExamFidelity.ts gen
 *          Generates one set per course below and copies it into a twin job, both left at 'reviewing'.
 *          Writes backups/fidelity_bench/manifest.json: [{ course, a, b }] — run job a with the old code
 *          and job b with the new (runGeneratedJob.ts --job <id>).
 *   judge  npx tsx src/scripts/benchmarkExamFidelity.ts judge
 *          For every item: status in each job, an absolute fidelity score (1–5) for each final version
 *          from a judge that sees the exam profile but not which pipeline wrote it, and a pairwise
 *          comparison in both orders. Writes backups/fidelity_bench/report.json and prints the summary.
 */
import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { supabase } from '../db/supabase.js';
import { fetchAllRows } from '../db/pagination.js';
import { generateBatchForJob } from '../services/generation/questionGeneration.js';
import { formatQuestionsForReview } from '../services/review/shared.js';
import { examProfile } from '../services/review/examProfile.js';
import { optionTexts, keyLengthCue, isSingleBest } from '../services/review/reviewMode.js';
import { orCall, MODELS } from '../services/llm/openrouter.js';

type Row = Record<string, any>;
const DIR = path.resolve('backups/fidelity_bench');
const MANIFEST = path.join(DIR, 'manifest.json');

const SETS: Array<{ course: string; counts: Record<string, number> }> = [
  { course: '5e3d672a-5539-4416-8bf5-1a66e8eaf414', counts: { 'Medical-Surgical Nursing': 5, 'Pediatric Nursing': 5, 'Pharmacology Principles': 5 } },
  { course: 'dc805023-9958-463b-ad2c-54c67ed9b51a', counts: { 'Financial Reporting': 5, 'Federal Taxation of Individuals': 5, 'Assessing Risk and Developing a Planned Response': 5 } },
  { course: '42c85248-7209-4bfe-9f94-ea128e3ab598', counts: { Biochemistry: 5, Psychology: 5, 'General Chemistry': 5 } },
];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function createJob(course: string, counts: Record<string, number>): Promise<string> {
  const { data: c } = await supabase.from('qb_courses').select('structure').eq('id', course).single();
  const subjects = ((c?.structure as Row)?.subjects || []) as Row[];
  const topicSelection = Object.fromEntries(subjects.filter((s) => counts[s.name]).map((s) => [s.name, (s.topics || []).map((t: Row) => t.name)]));
  const missing = Object.keys(counts).filter((n) => !topicSelection[n]);
  if (missing.length) throw new Error(`not in the course structure: ${missing.join(', ')}`);
  const { data: job, error } = await supabase.from('qb_jobs').insert({
    course_id: course, type: 'topic_wise', status: 'pending', progress: {},
    config: { topic_selection: topicSelection, subject_question_counts: counts, questions_per_topic: 1, benchmark: 'exam_fidelity' },
  }).select('id').single();
  if (error) throw new Error(error.message);
  return job.id as string;
}

/** A twin of a generated job: the same items under a new job id, at the same status. */
async function cloneJob(jobId: string): Promise<string> {
  const { data: j } = await supabase.from('qb_jobs').select('*').eq('id', jobId).single();
  const { data: twin, error } = await supabase.from('qb_jobs').insert({
    course_id: j!.course_id, type: j!.type, status: j!.status, progress: {}, config: { ...(j!.config as Row), benchmark_twin_of: jobId },
  }).select('id').single();
  if (error) throw new Error(error.message);
  const rows = await fetchAllRows<Row>((from, to) => supabase.from('qb_questions').select('*').eq('job_id', jobId).is('replaced_by_id', null).order('question_number').range(from, to));
  const copies = rows.map(({ id: _id, created_at: _c, ...q }) => ({ ...q, job_id: twin.id }));
  const { error: e2 } = await supabase.from('qb_questions').insert(copies);
  if (e2) throw new Error(e2.message);
  return twin.id as string;
}

async function gen() {
  fs.mkdirSync(DIR, { recursive: true });
  const out = await Promise.all(SETS.map(async (s) => {
    const a = await createJob(s.course, s.counts);
    console.log(`job ${a}: generating for ${s.course.slice(0, 8)}`);
    await generateBatchForJob(a, s.course);
    for (;;) {
      const { data } = await supabase.from('qb_jobs').select('status').eq('id', a).single();
      if (data?.status !== 'generating' && data?.status !== 'pending') break;
      await sleep(15000);
    }
    const b = await cloneJob(a);
    console.log(`job ${a} generated; twin ${b}`);
    return { course: s.course, a, b };
  }));
  fs.writeFileSync(MANIFEST, JSON.stringify(out, null, 2));
  console.log(`manifest: ${MANIFEST}`);
}

const ABS_PROMPT = (profile: string, item: string) => `${profile}

You are an item writer who has written for this exam for many years. Judge how closely the item below resembles a REAL item from this exam, as the profile describes the exam. Not whether it is correct — only whether it reads like the real thing: how it tests, the shape and register of the stem, the lead-in, the options and distractors, and nothing the exam does not do.

ITEM:
${item}

Reply with JSON only: {"fidelity": 1-5, "gap": "<the main way it differs from a real item, or empty>"}
5 indistinguishable from a real item; 4 close with small differences; 3 recognisably this exam with clear differences; 2 generic exam-prep style; 1 does not read like this exam.`;

const PAIR_PROMPT = (profile: string, x: string, y: string) => `${profile}

Two versions of the same item. Which reads more like a REAL item from this exam, as the profile describes it — how it tests, stem shape and register, lead-in, options and distractors — and which is the better exam item overall (accuracy, one best answer, no cue to the key)?

VERSION X:
${x}

VERSION Y:
${y}

Reply with JSON only: {"closer_to_exam": "X" | "Y" | "tie", "better_item": "X" | "Y" | "tie", "reason": "<one sentence>"}`;

const pick = (t: string): Row => { try { return JSON.parse(t.match(/\{[\s\S]*\}/)?.[0] ?? '{}'); } catch { return {}; } };
const render = (q: Row) => formatQuestionsForReview([q]);

async function judge() {
  const manifest = JSON.parse(fs.readFileSync(MANIFEST, 'utf8')) as Array<{ course: string; a: string; b: string }>;
  const report: Row[] = [];
  for (const m of manifest) {
    const { data: c } = await supabase.from('qb_courses').select('name, exam_format, generation_guidelines').eq('id', m.course).single();
    const profile = examProfile(String(c!.name), c!.exam_format as Row, c!.generation_guidelines as Row).text;
    const load = (job: string) => fetchAllRows<Row>((from, to) => supabase.from('qb_questions').select('*').eq('job_id', job).is('replaced_by_id', null).order('question_number').range(from, to));
    const [A, B] = await Promise.all([load(m.a), load(m.b)]);
    const items = await Promise.all(A.map(async (qa) => {
      const qb = B.find((x) => x.question_number === qa.question_number);
      if (!qb) return null;
      const [ra, rb] = [render(qa), render(qb)];
      const call = (p: string) => orCall(MODELS.AUDITOR, '', p, { maxTokens: 600, temperature: 0 }).then((r) => pick(r.content)).catch(() => ({} as Row));
      const [fa, fb, p1, p2] = await Promise.all([call(ABS_PROMPT(profile, ra)), call(ABS_PROMPT(profile, rb)), call(PAIR_PROMPT(profile, ra, rb)), call(PAIR_PROMPT(profile, rb, ra))]);
      // Pairwise in both orders: a version wins only if it wins both; otherwise a tie.
      const both = (k: string) => (p1[k] === 'X' && p2[k] === 'Y' ? 'old' : p1[k] === 'Y' && p2[k] === 'X' ? 'new' : 'tie');
      const fid = (q: Row) => [...((q.audit_trail || []) as Row[])].reverse().find((e) => e?.phase === 'audit')?.exam_fidelity ?? null;
      const cue = (q: Row) => (isSingleBest(q) ? Boolean(keyLengthCue(q)) : null);
      return {
        course: c!.name, n: qa.question_number, format: qa.format_type ?? qa.tags?.format_type, subject: qa.subject,
        old: { status: qa.status, fidelity: Number(fa.fidelity) || null, gap: fa.gap ?? '', keyLongest: cue(qa), options: optionTexts(qa).texts.length },
        new: { status: qb.status, fidelity: Number(fb.fidelity) || null, gap: fb.gap ?? '', keyLongest: cue(qb), options: optionTexts(qb).texts.length, auditFidelity: fid(qb) },
        closer: both('closer_to_exam'), better: both('better_item'), reason: p1.reason ?? '',
      };
    }));
    report.push(...items.filter(Boolean) as Row[]);
  }
  fs.writeFileSync(path.join(DIR, 'report.json'), JSON.stringify(report, null, 2));

  const by = (rows: Row[], label: string) => {
    const mean = (xs: Array<number | null>) => { const v = xs.filter((x): x is number => typeof x === 'number'); return v.length ? (v.reduce((s, x) => s + x, 0) / v.length).toFixed(2) : '–'; };
    const count = (f: (r: Row) => boolean) => rows.filter(f).length;
    const sb = rows.filter((r) => r.old.keyLongest !== null);
    console.log(`\n${label} (${rows.length} items)`);
    console.log(`  approved            old ${count((r) => r.old.status === 'approved')}  new ${count((r) => r.new.status === 'approved')}`);
    console.log(`  fidelity (1-5)      old ${mean(rows.map((r) => r.old.fidelity))}  new ${mean(rows.map((r) => r.new.fidelity))}   (new audit's own: ${mean(rows.map((r) => r.new.auditFidelity))})`);
    console.log(`  closer to exam      old ${count((r) => r.closer === 'old')}  new ${count((r) => r.closer === 'new')}  tie ${count((r) => r.closer === 'tie')}`);
    console.log(`  better item         old ${count((r) => r.better === 'old')}  new ${count((r) => r.better === 'new')}  tie ${count((r) => r.better === 'tie')}`);
    if (sb.length) console.log(`  key longest (SBA)   old ${count((r) => r.old.keyLongest === true)}/${sb.length}  new ${count((r) => r.new.keyLongest === true)}/${sb.length}`);
  };
  for (const name of [...new Set(report.map((r) => r.course))]) by(report.filter((r) => r.course === name), String(name));
  by(report, 'ALL');
}

const cmd = process.argv[2];
if (cmd === 'gen') await gen();
else if (cmd === 'judge') await judge();
else console.log('usage: benchmarkExamFidelity.ts gen | judge');
process.exit(0);
