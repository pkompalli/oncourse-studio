/**
 * Load questions exported from the live USMLE bank into qbank-studio, one job per Step course, so
 * the app's own review and audit can run on them.
 *
 * Each job is marked `config.source = 'import'`, which puts review into existing-bank mode
 * (changeRouting.ts): these items have been answered by candidates, so their option count and
 * order are frozen and a key moves only when it is wrong.
 *
 * Every row keeps the ids it came from — `tags.source_question_id`, and `tags.source_option_ids`
 * mapping each letter to the live option id — so a later write-back edits the same rows and never
 * orphans a recorded answer. Nothing is written to the source bank.
 *
 * Jobs older than 10 days are deleted with their questions by migration 004's cron job, so export
 * the reviewed rows before then.
 *
 *   npx tsx src/scripts/importUsmleExport.ts --limit 20 --offset 75   # dry run of a pilot: 20 per Step
 *   npx tsx src/scripts/importUsmleExport.ts --limit 20 --offset 75 --apply
 *   npx tsx src/scripts/importUsmleExport.ts --apply                  # everything
 */
import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { supabase } from '../db/supabase.js';

const argStr = (name: string, fallback = ''): string => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};
const APPLY = process.argv.includes('--apply');
const IN = argStr('in', 'backups/usmle_export/usmle_questions_post_2025-01-31.json');
const LIMIT = Number(argStr('limit', '0'));
const OFFSET = Number(argStr('offset', '0'));

type Step = 'step1' | 'step2' | 'step3';
const COURSES: Record<Step, string> = {
  step1: 'f9d20070-4b7d-4248-b545-f6e774cd006f',
  step2: '2b2ab63c-5aa7-4c99-b2d5-e55642f9faac',
  step3: '90b430d9-d9c8-4758-b0d1-1f04ec0b06e7',
};
const MCQ_SINGLE_FORMAT_ID = 'd00518ab-09f9-48d7-a742-be9becd5b856';
const LETTERS = 'ABCDEFGHIJ';

interface Exported {
  id: string; created_at: string; subject: string; topic: string;
  question_text: string; explanation: string | null; difficulty: string | null; blooms_level: string | null;
  question_type: string | null; validation_status: string | null;
  image_details: { images?: Array<{ url?: string }>; assetUrl?: string } | null;
  metadata: Record<string, unknown> | null;
  options: Array<{ id: string; text: string; is_correct: boolean }> | null;
  assets: Array<{ asset_id?: string; url?: string; description?: string | null }> | null;
}

const STEP1_SUBJECTS = new Set(['Anatomy', 'Physiology', 'Biochemistry', 'Microbiology', 'Pathology', 'Pharmacology', 'Immunology', 'Behavioral Science']);
const STEP3_SUBJECTS = new Set(['Diagnosis', 'Management', 'Biostatistics', 'Patient Safety', 'CCS Cases']);

/** The Step the importer recorded, else the Step whose blueprint owns the subject (as reviewExportedQuestions). */
function stepOf(q: Exported): { step: Step; from: 'metadata' | 'subject' } {
  const m = q.metadata || {};
  const tag = [m.mappedCourse, m.templateName, m.tagNames, m.source, m.sourceFile]
    .map((v) => JSON.stringify(v ?? '')).join(' ').toLowerCase().replace(/[\s_-]/g, '');
  if (tag.includes('step3')) return { step: 'step3', from: 'metadata' };
  if (tag.includes('step2')) return { step: 'step2', from: 'metadata' };
  if (tag.includes('step1')) return { step: 'step1', from: 'metadata' };
  if (STEP1_SUBJECTS.has(q.subject)) return { step: 'step1', from: 'subject' };
  if (STEP3_SUBJECTS.has(q.subject)) return { step: 'step3', from: 'subject' };
  return { step: 'step2', from: 'subject' };
}

// The bank mostly uses 1–3; a few rows carry words, one a 4.
const DIFFICULTY: Record<string, number> = { '1': 1, '2': 2, '3': 3, '4': 3, easy: 1, medium: 2, hard: 3 };

function toRow(q: Exported, step: Step, from: string, jobId: string, courseName: string, n: number) {
  const opts = q.options || [];
  const options: Record<string, string> = {};
  const sourceOptionIds: Record<string, string> = {};
  opts.forEach((o, i) => { options[LETTERS[i]] = o.text; sourceOptionIds[LETTERS[i]] = o.id; });
  const keyIdx = opts.findIndex((o) => o.is_correct);
  const key = keyIdx >= 0 ? LETTERS[keyIdx] : '';
  const asset = (q.assets || []).find((a) => a.url);
  const imageUrl = asset?.url || q.image_details?.images?.[0]?.url || q.image_details?.assetUrl || null;
  const difficulty = DIFFICULTY[String(q.difficulty ?? '').toLowerCase()] ?? 2;
  const blooms = /^[1-6]$/.test(String(q.blooms_level)) ? String(q.blooms_level) : '3';
  return {
    job_id: jobId,
    course_id: COURSES[step],
    question_number: n,
    question: q.question_text,
    options,
    correct_option: key,
    explanation: q.explanation || '',
    subject: q.subject,
    topic: q.topic,
    course: courseName,
    blooms_level: blooms,
    difficulty,
    is_image_question: Boolean(imageUrl),
    image_url: imageUrl,
    image_description: asset?.description || null,
    image_source: imageUrl ? 'Imported from the live bank' : null,
    status: 'generated',
    audit_trail: [],
    attempt_number: 1,
    format_id: MCQ_SINGLE_FORMAT_ID,
    content: {
      stem: q.question_text,
      options: opts.map((o, i) => ({ key: LETTERS[i], text: o.text })),
      answer: { key },
      explanation: q.explanation || '',
      question_type: q.question_type || 'text',
    },
    tags: {
      subject: q.subject, topic: q.topic, blooms, difficulty,
      format_type: 'mcq_single', question_type: q.question_type || 'text',
      step, step_from: from,
      source_question_id: q.id,
      source_option_ids: sourceOptionIds,
      source_validation_status: q.validation_status,
      source_created_at: q.created_at,
      ...(asset?.asset_id ? { source_asset_id: asset.asset_id } : {}),
    },
    media: [],
  };
}

const all = (JSON.parse(readFileSync(IN, 'utf8')) as { questions: Exported[] }).questions;
const byStep: Record<Step, Array<{ q: Exported; from: string }>> = { step1: [], step2: [], step3: [] };
for (const q of all) { const s = stepOf(q); byStep[s.step].push({ q, from: s.from }); }

// A pilot takes LIMIT per Step, evenly spaced through each Step's id-sorted list (ids are random).
const pick = <T>(xs: T[]) => {
  if (!LIMIT) return xs;
  const stride = Math.max(1, Math.floor(xs.length / LIMIT));
  return xs.filter((_, i) => i % stride === OFFSET % stride).slice(0, LIMIT);
};

const { data: courses, error: cErr } = await supabase.from('qb_courses').select('id, name, generation_guidelines').in('id', Object.values(COURSES));
if (cErr) throw new Error(cErr.message);
for (const step of Object.keys(COURSES) as Step[]) {
  const course = courses!.find((c) => c.id === COURSES[step])!;
  if (!course.generation_guidelines) throw new Error(`${course.name} has no generation_guidelines — run setUsmleGuidelines.ts --apply first`);
}

for (const step of Object.keys(COURSES) as Step[]) {
  const course = courses!.find((c) => c.id === COURSES[step])!;
  const chosen = pick(byStep[step]);
  const images = chosen.filter(({ q }) => (q.assets || []).some((a) => a.url)).length;
  const noKey = chosen.filter(({ q }) => !(q.options || []).some((o) => o.is_correct)).length;
  console.log(`${step}: ${chosen.length} of ${byStep[step].length} questions → ${course.name}${LIMIT ? ' (pilot)' : ''} | ${images} with images | ${noKey} with no keyed option`);
  if (!APPLY || !chosen.length) continue;

  const { data: job, error: jErr } = await supabase.from('qb_jobs').insert({
    course_id: COURSES[step],
    type: 'mock_exam',
    status: 'reviewing',
    progress: {},
    config: {
      source: 'import',
      existing_bank: true,
      source_project: 'ylbwdadhbcjolwylidja',
      source_file: IN.split('/').pop(),
      source_filter: "course 'US Medical PG', created_at > 2025-01-31",
      step,
      pilot: Boolean(LIMIT),
      imported_at: new Date().toISOString(),
    },
  }).select('id').single();
  if (jErr) throw new Error(jErr.message);

  const rows = chosen.map(({ q, from }, i) => toRow(q, step, from, job.id, course.name, i + 1));
  for (let i = 0; i < rows.length; i += 500) {
    const { error } = await supabase.from('qb_questions').insert(rows.slice(i, i + 500));
    if (error) throw new Error(`insert ${step} rows ${i}–${i + 499}: ${error.message}`);
  }
  console.log(`  created job ${job.id} with ${rows.length} questions`);
}
if (!APPLY) console.log('dry run — rerun with --apply to create the jobs');
