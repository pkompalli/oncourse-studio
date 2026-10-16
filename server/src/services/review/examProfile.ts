/**
 * The exam's qualitative profile, as every review stage sees it: how the exam tests, what its items look
 * like, what it never does, and whose rules decide the right answer.
 *
 * Generation always read this material (exam_format.exam_pattern, custom_rules, image_guidelines, the
 * distractor guidance). Review did not. The validator and adversarial prompts looked for
 * testing_philosophy, distinctive_patterns and what_NOT_to_do at the top level of exam_format, where no
 * course keeps them — every course stores them under exam_pattern — so their exam-format block was empty
 * for every course; audit and the fixer were given none of it. An item was therefore generated to the
 * exam's profile and then reviewed, repaired and approved against a fixed checklist written for USMLE
 * ("current US practice", "medical authority", five options). Here it is built once, from the course's
 * own records, and handed to every stage.
 *
 * Bounded by length, not by rule count: the earlier caps (3, 8, 20 rules) dropped rules a course had
 * written down, while the whole qualitative profile of the largest course is about 12k characters.
 */

import { supabase } from '../../db/supabase.js';

type Row = Record<string, unknown>;

export interface ExamProfile {
  /** The profile text for a review prompt; empty when the course has none. */
  text: string;
  /** Whose rules decide the correct answer, for KEY_CORRECT and answer adjudication. */
  authority: string;
  /** What the exam's subject matter is ("medicine", "accounting", …), for the adjudicator's role. */
  domain: string;
  /** Options in a single-best-answer item, from the format contract; null when not stated. */
  optionCount: number | null;
}

const MAX_CHARS = 14000;

const list = (v: unknown): string[] => (Array.isArray(v) ? v.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))) : []);
const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : v && typeof v === 'object' ? JSON.stringify(v) : '');
const bullets = (xs: string[]) => xs.map((x) => `  • ${x}`).join('\n');

/** exam_pattern lives under exam_format; a course built by an older path has it at the top level. */
function patternOf(examFormat: Row | undefined): Row {
  const ef = examFormat || {};
  const p = ef.exam_pattern;
  return (p && typeof p === 'object' ? p : ef) as Row;
}

export function optionCountOf(examFormat: Row | undefined, guidelines: Row | undefined): number | null {
  const specs = (guidelines?.format_specs || {}) as Record<string, Row>;
  const fromSpec = Number((specs.mcq_single?.schema_params as Row | undefined)?.num_options);
  if (fromSpec > 1) return fromSpec;
  const qf = (examFormat?.question_format || {}) as Row;
  const fromFormat = Number(qf.num_options ?? examFormat?.num_options);
  return fromFormat > 1 ? fromFormat : null;
}

/** `maxChars`: a shorter profile for prompts sent once per item (the fixer). */
export function examProfile(courseName: string, examFormat?: Row, guidelines?: Row, maxChars = MAX_CHARS): ExamProfile {
  const p = patternOf(examFormat);
  const g = guidelines || {};
  const board = str(p.exam_board);
  const authority = str(p.answer_authority)
    || `the current, authoritative standards this exam is written to${board ? ` (exam board: ${board})` : ''}, as they stand today`;
  const domain = str(p.subject_domain) || 'the subject this exam covers';
  const optionCount = optionCountOf(examFormat, guidelines);

  const parts: string[] = [];
  const add = (label: string, v: string) => { if (v) parts.push(`${label}: ${v}`); };
  const addList = (label: string, xs: string[]) => { if (xs.length) parts.push(`${label}:\n${bullets(xs)}`); };

  add('Exam board', board);
  add('Correct answers are decided by', authority);
  add('Examiner role', str(p.examiner_role));
  add('Testing philosophy', str(p.testing_philosophy));
  const rr = p.recall_vs_reasoning_ratio as Row | undefined;
  add('Recall vs reasoning', str(rr?.description ?? rr));
  add('Primary format', str(p.primary_format));
  addList('Distinctive patterns of real items', list(p.distinctive_patterns));
  addList('What this exam does NOT do', list(p.what_NOT_to_do));
  addList('Example stem templates (the shape and register real items take)', list(p.example_stem_templates));
  const stem = (g.stem_guidelines || {}) as Row;
  const stemRules = [
    stem.style && `style ${stem.style}`,
    stem.vignette_required && 'vignette required',
    (stem.min_words || stem.max_words) && `${stem.min_words || '?'}–${stem.max_words || '?'} words`,
    (stem.scenario_depth ?? stem.clinical_scenario_depth) && `scenario depth: ${stem.scenario_depth ?? stem.clinical_scenario_depth}`,
  ].filter(Boolean) as string[];
  if (stemRules.length) parts.push(`Stem: ${stemRules.join('; ')}`);
  if (optionCount) parts.push(`Options in a single-best-answer item: ${optionCount}`);
  const dist = (g.distractor_guidelines || {}) as Row;
  add('Distractor homogeneity', str(dist.homogeneity));
  addList('Distractor rules', list(dist.quality_rules));
  addList('Errors real distractors are built on', list(dist.common_errors_to_use));
  addList('Anti-patterns', list(g.anti_patterns));
  addList('Course rules', list(g.custom_rules));
  add('Images', str(g.image_guidelines));

  let text = parts.join('\n');
  if (text.length > maxChars) text = `${text.slice(0, maxChars)}\n  …`;
  return {
    text: text ? `EXAM PROFILE — ${courseName}. Judge every item against how THIS exam writes its items:\n${text}` : '',
    authority, domain, optionCount,
  };
}

const byJob = new Map<string, Promise<ExamProfile | null>>();

/** The profile of a job's course, read once per job. Null when the job or course cannot be read. */
export function profileForJob(jobId: string, maxChars = MAX_CHARS): Promise<ExamProfile | null> {
  const k = `${jobId}:${maxChars}`;
  if (!byJob.has(k)) {
    byJob.set(k, (async () => {
      const { data: job } = await supabase.from('qb_jobs').select('course_id').eq('id', jobId).single();
      if (!job?.course_id) return null;
      const { data: c } = await supabase.from('qb_courses').select('name, exam_format, generation_guidelines').eq('id', job.course_id).single();
      return c ? examProfile(String(c.name), c.exam_format as Row, c.generation_guidelines as Row, maxChars) : null;
    })().catch(() => null));
  }
  return byJob.get(k)!;
}
