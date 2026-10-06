/**
 * Run the post-generation review stages over questions exported from ANOTHER database — no
 * `qb_questions` rows, no job, and nothing written back anywhere. The export is read from a JSON
 * file and every verdict, repair and audit result goes to a JSONL file beside it.
 *
 * Stages and gates are the ones reviewPipeline.ts and auditPipeline.ts apply, per batch of 10:
 *   validator → fixer (score ≤ 7 with text changes) → adversarial → fixer → audit
 * Image regeneration is NOT run (it would upload files); image feedback is recorded instead.
 *
 * Course context: the Step's `exam_format` from qb_courses, read once. The USMLE course rows have
 * no generation_guidelines, so the validator checks against the exam pattern only.
 *
 * Option ids: the export carries each option's id, ordered by id and lettered A–E. Revised options
 * are mapped back to those ids BY POSITION, so a later write-back edits option_text in place and
 * never orphans a student's recorded answer. A repair that changes the option count cannot be
 * mapped and is marked `option_count_changed`.
 *
 *   npx tsx src/scripts/reviewExportedQuestions.ts --in backups/usmle_export/usmle_questions_post_2025-01-31.json --limit 30
 *   npx tsx src/scripts/reviewExportedQuestions.ts --in ... --out backups/usmle_export/review_full   # all; resumable
 *   npx tsx src/scripts/reviewExportedQuestions.ts --in ... --out ... --report                     # rebuild summary only
 */
import 'dotenv/config';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { supabase } from '../db/supabase.js';
import { runValidatorBatch } from '../services/review/validator.js';
import { runAdversarialBatch } from '../services/review/adversarial.js';
import { fixQuestion } from '../services/review/fixer.js';
import { gradabilityIssues } from '../services/review/shared.js';
import { runAuditBatch } from '../services/audit/auditPipeline.js';
import { changedFields, unappliedChanges } from '../services/audit/fixHistory.js';
import { coherenceIssues, partitionIssues } from '../services/generation/coherence.js';
import { startTracking, getStepTokens } from '../services/llm/tokenTracker.js';

const argStr = (name: string, fallback = ''): string => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};
const argNum = (name: string, fallback: number): number => Number(argStr(name, String(fallback)));
const IN = argStr('in', 'backups/usmle_export/usmle_questions_post_2025-01-31.json');
const LIMIT = argNum('limit', 0);
const OUT = argStr('out', `backups/usmle_export/review${LIMIT ? `_sample${LIMIT}` : ''}`);
const CONCURRENCY = argNum('concurrency', 6);
const REPORT_ONLY = process.argv.includes('--report');
const BATCH = 10;
const RUN_ID = `export-review-${OUT}`;

// The latest course row per Step; the earlier duplicates carry the same exam_format.
const STEP_COURSES: Record<Step, string> = {
  step1: 'f9d20070-4b7d-4248-b545-f6e774cd006f',
  step2: '2b2ab63c-5aa7-4c99-b2d5-e55642f9faac',
  step3: '90b430d9-d9c8-4758-b0d1-1f04ec0b06e7',
};
const STEP_NAMES: Record<Step, string> = { step1: 'USMLE Step 1', step2: 'USMLE Step 2 CK', step3: 'USMLE Step 3' };
type Step = 'step1' | 'step2' | 'step3';

// ── Export shape ──

interface ExportOption { id: string; text: string; is_correct: boolean }
interface ExportAsset { url?: string; description?: string | null }
interface Exported {
  id: string; created_at: string; subject: string; topic: string;
  question_text: string; explanation: string | null; difficulty: string | null; blooms_level: string | null;
  question_type: string | null; validation_status: string | null;
  image_details: { images?: Array<{ url?: string }>; assetUrl?: string } | null;
  metadata: Record<string, unknown> | null;
  options: ExportOption[] | null; assets: ExportAsset[] | null;
}

const STEP1_SUBJECTS = new Set(['Anatomy', 'Physiology', 'Biochemistry', 'Microbiology', 'Pathology', 'Pharmacology', 'Immunology', 'Behavioral Science']);
const STEP3_SUBJECTS = new Set(['Diagnosis', 'Management', 'Biostatistics', 'Patient Safety', 'CCS Cases']);

/** The Step the importer recorded, else the Step whose blueprint owns the subject. */
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

const LETTERS = 'ABCDEFGHIJ';

/** The review stages read the qb_questions row shape; build it from the export. */
function toRow(q: Exported, step: Step): Record<string, unknown> {
  const opts = q.options || [];
  const options: Record<string, string> = {};
  opts.forEach((o, i) => { options[LETTERS[i]] = o.text; });
  const keyIdx = opts.findIndex((o) => o.is_correct);
  const asset = (q.assets || []).find((a) => a.url);
  const imageUrl = asset?.url || q.image_details?.images?.[0]?.url || q.image_details?.assetUrl || null;
  return {
    id: q.id,
    subject: q.subject,
    topic: q.topic,
    course: STEP_NAMES[step],
    format_type: 'mcq_single',
    question: q.question_text,
    options,
    correct_option: keyIdx >= 0 ? LETTERS[keyIdx] : '',
    explanation: q.explanation || '',
    difficulty: q.difficulty,
    bloom_level: q.blooms_level,
    is_image_question: Boolean(imageUrl),
    image_url: imageUrl,
    image_description: asset?.description || null,
    audit_trail: [] as unknown[],
  };
}

// The fixer is sent the whole row as JSON; give it only what it may change.
const EDITABLE = ['question', 'options', 'correct_option', 'explanation'] as const;
const editable = (r: Record<string, unknown>) =>
  Object.fromEntries(EDITABLE.map((f) => [f, r[f]])) as Record<string, unknown>;

// Change requests the text fixer must never see. Each is recorded on the outcome instead.
//
// image — reviewPipeline's IMAGE_CHANGE_RE misses "Replace the ECG image…" and "Replace the chest
//   image…", so those reached the fixer, which cannot touch an image and instead wrote the finding
//   into the stem ("ECG shows an irregularly irregular rhythm…"), handing the candidate the answer.
//   Once a question has ANY image finding, its text requests are held too (see routeChanges): a
//   blind solve that disagrees because the picture is wrong is still a text request, and the fixer
//   answered it by describing the right ECG in the stem.
// batch — adversarial compares a question with the others in its batch. In a generated job those
//   are siblings; here they are ten unrelated bank questions, and a "CONCEPT OVERLAP" note had the
//   fixer replace a HIPAA disclosure question with a different HIPAA question. Key-distribution
//   notes ("one of three 'B' answers") are the same artefact and invite key moves.
// label — difficulty/Bloom's relabels. The fixer cannot edit those fields, so audit then reports
//   the repair as never applied and flags a question whose content is fine.
const IMAGE_NOUN_RE = /\b(image|images|ecg|ekg|x-?ray|radiograph|ct\b|mri|scan|photo|photograph|figure|picture|illustration|tracing|micrograph|smear|histolog)/i;
const IMAGE_WORD_RE = /\b(image|images|picture|photo|photograph|figure|tracing|micrograph)\b/i;
const BATCH_RELATIVE_RE = /^CONCEPT OVERLAP:|\b(answer|key)s?\b.*\b(distribution|balance|diversify)\b|\bone of (two|three|four|\d+) '?[A-E]'? answers\b|\bQ\d+\b.*\b(same|overlap|duplicate)|\bskew|\blettering\b/i;
const LABEL_RE = /^DIFFICULTY:|\b(difficulty|bloom'?s?)\s+(label|level|rating)\b|\breconsider difficulty\b/i;
type Route = 'fix' | 'image' | 'batch' | 'label';
const routeOf = (c: string): Route =>
  BATCH_RELATIVE_RE.test(c) ? 'batch'
  : LABEL_RE.test(c) ? 'label'
  // Misrouting a text defect here only leaves it recorded and unfixed; misrouting an image defect
  // to the fixer rewrites the stem around a picture it cannot change. Err this way.
  // "Explanation does not address option E (HIDA scan)" names a test, not the picture; only an
  // explicit image word, or a request to replace one, counts.
  : (IMAGE_WORD_RE.test(c) && /\b(replace|regenerate|swap|redo|provide|correct the|does not|doesn't|do not|fails? to|inconsistent|contradict|mismatch|inconsistent_data|not (clearly )?(show|depict|demonstrat|match))\b/i.test(c))
    || (IMAGE_NOUN_RE.test(c) && /\b(replace|regenerate|swap|redo)\b/i.test(c)) ? 'image'
  : 'fix';

/** Word-level Jaccard similarity; below 0.5 the stem has been rewritten rather than edited. */
function similarity(a: string, b: string): number {
  const wa = new Set(a.toLowerCase().match(/[a-z0-9]+/g) || []);
  const wb = new Set(b.toLowerCase().match(/[a-z0-9]+/g) || []);
  const inter = [...wa].filter((w) => wb.has(w)).length;
  return wa.size + wb.size - inter ? inter / (wa.size + wb.size - inter) : 1;
}
const STEM_REFS_IMAGE = /shown\s+(below|above|here)|in\s+the\s+(image|figure|scan|x-?ray|ct|mri)|based\s+on\s+the\s+(image|figure)/i;

interface StageFix { attempted: boolean; fixed?: boolean; changes_applied?: string[]; error?: string; changed_fields?: string[] }
interface Outcome {
  id: string; step: Step; step_from: string; subject: string; topic: string; validation_status: string | null;
  prescreen_failure?: string;
  validator?: { score: number | null; changes: string[]; summary: string };
  validator_fix?: StageFix;
  adversarial?: { score: number | null; changes: string[]; summary: string; blind_answer?: unknown; blind_confidence?: unknown; key_disagreement?: unknown };
  adversarial_fix?: StageFix;
  audit?: { score: number | null; raw_score: number | null; reason: string; issues: string[]; repair_verification: unknown[] };
  status: 'approved' | 'flagged' | 'needs_review' | 'structural_failure';
  // A moved key or a rewritten stem on a question students have already answered is a clinical
  // call, whatever the auditor scored it.
  needs_clinician_review: string[];
  image_feedback: string[];
  label_feedback: string[];
  dropped_batch_relative: string[];
  held_for_image: string[];
  changed: boolean;
  original: { question_text: string; explanation: string | null; options: ExportOption[] };
  revised?: { question_text: string; explanation: string; options: Array<{ id: string | null; letter: string; text: string; is_correct: boolean }>; key_moved: boolean; option_count_changed: boolean };
}

function changesFrom(result: Record<string, unknown>, kind: 'validator' | 'adversarial'): string[] {
  const list = (k: string) => (result[k] as string[]) || [];
  const str = (k: string) => (result[k] as string) || '';
  if (kind === 'validator') return [
    ...list('changes_required'),
    ...list('format_compliance_issues').map((s) => `FORMAT: ${s}`),
    ...list('case_study_issues').map((s) => `CASE_STUDY: ${s}`),
    ...list('difficulty_issues').map((s) => `DIFFICULTY: ${s}`),
    ...list('explanation_issues').map((s) => `EXPLANATION: ${s}`),
    ...list('hotspot_issues').map((s) => `HOTSPOT: ${s}`),
    ...(str('answer_key_issue') ? [`ANSWER KEY: ${str('answer_key_issue')}`] : []),
  ];
  return [
    ...list('changes_required'),
    ...(str('concept_overlap') ? [`CONCEPT OVERLAP: ${str('concept_overlap')}`] : []),
    ...(str('answer_key_issue') ? [`ANSWER KEY: ${str('answer_key_issue')}`] : []),
    ...list('case_study_issues').map((s) => `CASE_STUDY: ${s}`),
    ...list('explanation_contradictions').map((s) => `EXPLANATION: ${s}`),
  ];
}

/** Record image, label and batch-relative requests on the outcome; return only what the fixer should get. */
function routeChanges(o: Outcome, r: Record<string, unknown>, changes: string[]): string[] {
  o.image_feedback.push(...((r.asset_issues as string[]) || []), ...((r.missing_images as string[]) || []));
  const text: string[] = [];
  for (const c of changes) {
    const route = routeOf(c);
    if (route === 'image') o.image_feedback.push(c);
    else if (route === 'label') o.label_feedback.push(c);
    else if (route === 'batch') o.dropped_batch_relative.push(c);
    else text.push(c);
  }
  // A question whose picture contradicts it is unusable until the picture is replaced, and every
  // text repair made before then is written around the wrong image.
  if (o.image_feedback.length && text.length) {
    o.held_for_image.push(...text);
    return [];
  }
  return text;
}

/** Apply a fixer pass to `row` in place, recording the repair on its trail the way the pipeline does. */
async function repair(row: Record<string, unknown>, changes: string[], phase: 'validator' | 'adversarial', courseName: string): Promise<StageFix> {
  const res = await fixQuestion(editable(row), changes, courseName);
  const trail = row.audit_trail as unknown[];
  if (res.fixed && res.question) {
    const before = editable(row);
    const fq = res.question;
    const after = {
      question: fq.question ?? row.question,
      options: fq.options ?? row.options,
      correct_option: fq.correct_option || fq.correct_answer || row.correct_option,
      explanation: fq.explanation ?? row.explanation,
    };
    const moved = changedFields(before, after);
    trail.push({ phase: `${phase}_fix`, changes_requested: changes, before, after, changed_fields: moved, timestamp: new Date().toISOString() });
    Object.assign(row, after);
    return { attempted: true, fixed: true, changes_applied: res.changesApplied, changed_fields: moved };
  }
  const error = res.error || 'fixer returned no usable question';
  trail.push({ phase: `${phase}_fix_failed`, changes_requested: changes, error, timestamp: new Date().toISOString() });
  return { attempted: true, fixed: false, error };
}

async function reviewBatch(items: Array<{ q: Exported; step: Step; from: string }>, step: Step, examFormat: Record<string, unknown>): Promise<Outcome[]> {
  const courseName = STEP_NAMES[step];
  const out: Outcome[] = [];
  const live: Array<{ row: Record<string, unknown>; o: Outcome }> = [];

  for (const { q, from } of items) {
    const row = toRow(q, step);
    const o: Outcome = {
      id: q.id, step, step_from: from, subject: q.subject, topic: q.topic, validation_status: q.validation_status,
      status: 'needs_review', needs_clinician_review: [], image_feedback: [], label_feedback: [], dropped_batch_relative: [], held_for_image: [], changed: false,
      original: { question_text: q.question_text, explanation: q.explanation, options: q.options || [] },
    };
    out.push(o);
    // Same pre-screen as reviewPipeline: no LLM call for a question that cannot be answered as stored.
    if (!row.is_image_question && STEM_REFS_IMAGE.test(String(row.question))) {
      o.prescreen_failure = 'Question text references an image but none is attached.';
      o.status = 'structural_failure';
      continue;
    }
    live.push({ row, o });
  }
  if (!live.length) return out;
  const rows = live.map((l) => l.row);

  // Validator
  const vRes = await runValidatorBatch(rows, 'qbank', courseName, examFormat, undefined);
  await Promise.all(live.map(async ({ row, o }, i) => {
    const r = vRes[i] || {};
    const score = typeof r.overall_accuracy_score === 'number' ? r.overall_accuracy_score : null;
    const changes = changesFrom(r, 'validator');
    o.validator = { score, changes, summary: String(r.summary || '') };
    (row.audit_trail as unknown[]).push({ phase: 'validator', score: score ?? 5, changes: changes.length ? changes : null, summary: o.validator.summary, timestamp: new Date().toISOString() });
    const text = routeChanges(o, r, changes);
    if ((score ?? 5) <= 7 && text.length) o.validator_fix = await repair(row, text, 'validator', courseName);
  }));

  // Adversarial — sees the validator's repair, as in the pipeline.
  const aRes = await runAdversarialBatch(rows, 'qbank', courseName, examFormat);
  await Promise.all(live.map(async ({ row, o }, i) => {
    const r = aRes[i] || {};
    const score = typeof r.adversarial_score === 'number' ? r.adversarial_score : null;
    const changes = changesFrom(r, 'adversarial');
    o.adversarial = { score, changes, summary: String(r.summary || ''), blind_answer: r.blind_answer, blind_confidence: r.blind_confidence, key_disagreement: r.key_disagreement };
    (row.audit_trail as unknown[]).push({ phase: 'adversarial', score: score ?? 5, changes: changes.length ? changes : null, summary: o.adversarial.summary, timestamp: new Date().toISOString() });
    const text = routeChanges(o, r, changes);
    if ((score ?? 5) <= 7 && text.length) o.adversarial_fix = await repair(row, text, 'adversarial', courseName);
  }));

  // Audit — gates copied from auditPipeline.ts.
  const auRes = await runAuditBatch(rows);
  live.forEach(({ row, o }, i) => {
    const r = auRes[i] || {};
    const raw = typeof r.quality_score === 'number' ? r.quality_score : null;
    const issues = [...((r.issues as string[]) || [])];
    let reason = String(r.reason || '');
    if (raw == null) {
      o.audit = { score: null, raw_score: null, reason: 'No score returned (empty or truncated review response)', issues, repair_verification: [] };
      o.status = 'needs_review';
    } else {
      let score = raw;
      const grade = gradabilityIssues(row);
      if (grade.length && score >= 7) { score = 3; reason = `Not gradable: ${grade.slice(0, 3).join('; ')}`; issues.push(...grade.map((s) => `NOT GRADABLE — ${s}`)); }
      const unapplied = unappliedChanges(row);
      const verdicts = (r.repair_verification as Array<Record<string, unknown>>) || [];
      const bad = verdicts.filter((v) => ['not_applied', 'applied_incorrectly'].includes(String(v?.verdict || '').toLowerCase()));
      if (unapplied.length || bad.length) {
        const notes = [
          ...unapplied.map((c) => `REPAIR NEVER APPLIED — the fixer failed and nothing since has addressed: ${String(c).slice(0, 220)}`),
          ...bad.map((v) => `REPAIR ${String(v.verdict).toUpperCase()} — ${String(v.change ?? '').slice(0, 160)}: ${String(v.note ?? '').slice(0, 200)}`),
        ];
        if (score >= 7) score = 4;
        issues.push(...notes);
        reason = `Requested repair not carried through: ${notes[0].slice(0, 160)}`;
      }
      const { blocking } = partitionIssues(coherenceIssues(row));
      issues.push(...blocking.map((s) => `NOT COMPLIANT — coherence: ${s}`));
      o.audit = { score, raw_score: raw, reason, issues, repair_verification: verdicts };
      o.status = score >= 7 && blocking.length === 0 ? 'approved' : 'flagged';
    }

    const orig = o.original;
    const opts = row.options as Record<string, string>;
    const letters = Object.keys(opts).sort();
    const key = String(row.correct_option || '');
    const origKey = orig.options.findIndex((x) => x.is_correct);
    o.changed = o.validator_fix?.fixed === true || o.adversarial_fix?.fixed === true;
    if (o.changed) {
      o.revised = {
        question_text: String(row.question),
        explanation: String(row.explanation),
        options: letters.map((L, idx) => ({ id: orig.options[idx]?.id ?? null, letter: L, text: opts[L], is_correct: L === key })),
        key_moved: letters.indexOf(key) !== origKey,
        option_count_changed: letters.length !== orig.options.length,
      };
      const sim = similarity(orig.question_text, o.revised.question_text);
      if (o.revised.key_moved) o.needs_clinician_review.push(`Answer key moved from ${LETTERS[origKey] ?? 'none'} ("${orig.options[origKey]?.text.slice(0, 80) ?? ''}") to ${key} ("${opts[key]?.slice(0, 80) ?? ''}")`);
      if (sim < 0.5) o.needs_clinician_review.push(`Stem rewritten, not edited (word overlap ${sim.toFixed(2)})`);
      if (o.revised.option_count_changed) o.needs_clinician_review.push(`Option count changed ${orig.options.length} → ${letters.length}; option ids cannot be mapped`);
    }
    // A blind solve that disagreed and was not resolved by a repair is a key a clinician should look at.
    if (o.adversarial?.key_disagreement && !o.revised?.key_moved) o.needs_clinician_review.push(`Blind solve chose ${String(o.adversarial.blind_answer)} (${String(o.adversarial.blind_confidence)}) against key ${key}; key not changed`);
  });
  return out;
}

async function runWithConcurrency(tasks: Array<() => Promise<void>>, max: number) {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(max, tasks.length) }, async () => {
    while (next < tasks.length) {
      const i = next++;
      try { await tasks[i](); } catch (e) { console.error(`  batch ${i} failed (continuing): ${e instanceof Error ? e.message : e}`); }
    }
  }));
}

function report(all: Exported[], outcomes: Outcome[]) {
  const byId = new Map(outcomes.map((o) => [o.id, o]));
  const tally = (f: (o: Outcome) => string) => outcomes.reduce<Record<string, number>>((m, o) => { const k = f(o); m[k] = (m[k] || 0) + 1; return m; }, {});
  const avg = (xs: Array<number | null | undefined>) => { const v = xs.filter((x): x is number => typeof x === 'number'); return v.length ? +(v.reduce((a, b) => a + b, 0) / v.length).toFixed(2) : null; };
  const summary = {
    generated_at: new Date().toISOString(),
    input: IN, exported: all.length, reviewed: outcomes.length,
    status: tally((o) => o.status),
    by_step: tally((o) => `${o.step} (${o.step_from})`),
    changed: outcomes.filter((o) => o.changed).length,
    key_moved: outcomes.filter((o) => o.revised?.key_moved).length,
    option_count_changed: outcomes.filter((o) => o.revised?.option_count_changed).length,
    fix_failed: outcomes.filter((o) => o.validator_fix?.fixed === false || o.adversarial_fix?.fixed === false).length,
    blind_disagreed_with_key: outcomes.filter((o) => o.adversarial?.key_disagreement).length,
    with_image_feedback: outcomes.filter((o) => o.image_feedback.length).length,
    needs_clinician_review: outcomes.filter((o) => o.needs_clinician_review?.length).length,
    approved_but_needs_clinician_review: outcomes.filter((o) => o.status === 'approved' && o.needs_clinician_review?.length).length,
    with_label_feedback: outcomes.filter((o) => o.label_feedback?.length).length,
    batch_relative_dropped: outcomes.filter((o) => o.dropped_batch_relative?.length).length,
    text_fixes_held_for_image: outcomes.filter((o) => o.held_for_image?.length).length,
    avg_scores: {
      validator: avg(outcomes.map((o) => o.validator?.score)),
      adversarial: avg(outcomes.map((o) => o.adversarial?.score)),
      audit: avg(outcomes.map((o) => o.audit?.score)),
    },
    status_by_subject: outcomes.reduce<Record<string, Record<string, number>>>((m, o) => { (m[o.subject] ??= {})[o.status] = (m[o.subject][o.status] || 0) + 1; return m; }, {}),
  };
  writeFileSync(`${OUT}/summary.json`, JSON.stringify(summary, null, 2));
  // The export with each question's review result attached, in the export's own shape.
  const merged = all.filter((q) => byId.has(q.id)).map((q) => ({ ...q, review: byId.get(q.id) }));
  writeFileSync(`${OUT}/reviewed_questions.json`, JSON.stringify(merged, null, 1));
  console.log(JSON.stringify({ ...summary, status_by_subject: undefined }, null, 2));
}

// ── Main ──

mkdirSync(OUT, { recursive: true });
const RESULTS = `${OUT}/results.jsonl`;
const exported = (JSON.parse(readFileSync(IN, 'utf8')) as { questions: Exported[] }).questions;
// ids are random UUIDs, so an evenly spaced slice of the id-sorted list is an unbiased sample.
const stride = LIMIT ? Math.max(1, Math.floor(exported.length / LIMIT)) : 1;
// --offset shifts the sample so a second pilot sees different questions.
const OFFSET = argNum('offset', 0) % stride;
const selected = LIMIT ? exported.filter((_, i) => i % stride === OFFSET).slice(0, LIMIT) : exported;

const done = new Map<string, Outcome>();
if (existsSync(RESULTS)) for (const line of readFileSync(RESULTS, 'utf8').split('\n')) if (line.trim()) { const o = JSON.parse(line) as Outcome; done.set(o.id, o); }

if (!REPORT_ONLY) {
  const { data: courses, error } = await supabase.from('qb_courses').select('id, exam_format').in('id', Object.values(STEP_COURSES));
  if (error) throw new Error(error.message);
  const formats = Object.fromEntries((Object.keys(STEP_COURSES) as Step[]).map((s) => [s, (courses!.find((c) => c.id === STEP_COURSES[s])?.exam_format || {}) as Record<string, unknown>]));

  const todo = selected.filter((q) => !done.has(q.id)).map((q) => ({ q, ...((s) => ({ step: s.step, from: s.from }))(stepOf(q)) }));
  const batches: Array<{ step: Step; items: typeof todo }> = [];
  for (const step of Object.keys(STEP_COURSES) as Step[]) {
    const mine = todo.filter((t) => t.step === step);
    for (let i = 0; i < mine.length; i += BATCH) batches.push({ step, items: mine.slice(i, i + BATCH) });
  }
  console.log(`${selected.length} selected, ${done.size} already reviewed, ${todo.length} to go in ${batches.length} batches (concurrency ${CONCURRENCY}) → ${OUT}`);

  startTracking(RUN_ID, 'review');
  const t0 = Date.now();
  let finished = 0;
  await runWithConcurrency(batches.map((b) => async () => {
    const outcomes = await reviewBatch(b.items, b.step, formats[b.step]);
    for (const o of outcomes) { appendFileSync(RESULTS, JSON.stringify(o) + '\n'); done.set(o.id, o); }
    finished++;
    const tok = getStepTokens(RUN_ID, 'review');
    const mins = (Date.now() - t0) / 60000;
    console.log(`  batch ${finished}/${batches.length} [${b.step}] ${outcomes.map((o) => o.status[0]).join('')} | ${mins.toFixed(1)} min | tokens in ${tok?.prompt_tokens ?? 0} out ${tok?.completion_tokens ?? 0} calls ${tok?.calls ?? 0}`);
  }), CONCURRENCY);
}

report(exported, selected.map((q) => done.get(q.id)).filter((o): o is Outcome => Boolean(o)));
