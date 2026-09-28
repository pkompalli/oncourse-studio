/**
 * Top a finished job up to the format mix its exam actually has.
 *
 * CPA job e2d9e0b5 came back 434 MCQ + 6 TBS where a real set is 400 + 42, with AUD and ISC
 * carrying no simulations at all. The per-exam SIZES were right — the sections landed on
 * 85/57/79/56/88/75 — but three generation defects meant the simulations were mostly never
 * requested, and the ones that were got discarded by a retry that compared batches on raw
 * count. Those are fixed forward; this repairs the bank that already exists.
 *
 * Neither existing top-up path can do this: next-batch 'generate' is a no-op on a complete
 * job and would otherwise regenerate the whole exam; 'replace' is strictly 1:1 against flagged
 * rows and mirrors the format it retires; and topup-from-job only MOVES approved rows between
 * jobs, with no format dimension.
 *
 * Per exam, against its exam_sizes.format_question_counts:
 *   - generate the missing items of each under-supplied format, through the real generator
 *     (professorGenerateQuestions), so this exercises the same path a fresh run uses
 *   - retire the surplus of each over-supplied format to status 'replaced', worst-scoring
 *     first, so the section lands on its real length. Nothing is deleted — every export path
 *     filters on status, so a retired row drops out while the row survives.
 *   - reopen the job to 'reviewing' so the new rows get scored. Precedent: 0866e6d, where
 *     replacements inserted into a 'complete' job sat unreviewed because both phases
 *     short-circuit on that status. Review scopes to status='generated' and audit to
 *     'reviewed', so ONLY the new questions are processed.
 *
 * Dry run by default — prints the plan and writes nothing. Pass --apply.
 */
import 'dotenv/config';
import { supabase } from '../db/supabase.js';
import { fetchAllRows } from '../db/pagination.js';
import { readExamSize, subjectExamMap } from '../services/generation/examSize.js';
import { canonicalizeFormatSlug } from '../services/generation/formatContracts.js';
import { professorGenerateQuestions, insertSubjectQuestions } from '../services/generation/questionGeneration.js';

const APPLY = process.argv.includes('--apply');
const JOB = (process.argv.find((a) => a.startsWith('--job=')) || '').split('=')[1]
  || 'e2d9e0b5-87b8-44d0-b8d1-b9f6eb4cfa67';
const ONLY_FORMAT = (process.argv.find((a) => a.startsWith('--format=')) || '').split('=')[1] || '';
/**
 * --regenerate=slug[,slug] retires every live row of those formats so the count gap rebuilds
 * them. For rows that are the right COUNT but the wrong SHAPE — Bar's six integrated sets were
 * all six uniform multiple-choice components where NextGen mixes short answer and uses a
 * one-component drafting shape. Neither the count gap nor the thin-item check can see that.
 */
const REGENERATE = new Set(
  ((process.argv.find((a) => a.startsWith('--regenerate=')) || '').split('=')[1] || '')
    .split(',').map((s) => s.trim()).filter(Boolean)
);
/**
 * --limit=N caps how many rows of the regenerated format are retired, so a SUBSET can be
 * rebuilt into a different shape. A NextGen exam has both counselling and drafting integrated
 * sets; left alone the generator produced six counselling ones, because that is the shape its
 * examples showed. Rebuilding just two of them needs a way to touch only two.
 */
const LIMIT = Number((process.argv.find((a) => a.startsWith('--limit=')) || '').split('=')[1]) || 0;
/** Extra instruction appended to the generation prompt for the rebuilt rows. */
const SHAPE = (process.argv.find((a) => a.startsWith('--shape=')) || '').split('=').slice(1).join('=') || '';

interface Row { id: string; subject: string; status: string; content?: Record<string, unknown> | null; tags: Record<string, unknown> | null; quality_score: number | null; combined_score: number | null; validator_score: number | null }

async function main() {
  const { data: job, error: jobErr } = await supabase.from('qb_jobs').select('*').eq('id', JOB).single();
  if (jobErr || !job) throw new Error(jobErr?.message || 'job not found');

  const { data: course } = await supabase
    .from('qb_courses').select('name,structure,exam_format,generation_guidelines').eq('id', job.course_id).single();
  if (!course) throw new Error('course not found');

  const courseName = course.name as string;
  const structure = (course.structure || {}) as Record<string, unknown>;
  const examFormat = (course.exam_format || {}) as Record<string, unknown>;
  const guidelines = (course.generation_guidelines || {}) as Record<string, unknown>;
  // A single-exam course (LSAT, NCLEX) has no per-exam sizes — its whole bank is one paper,
  // and the guidelines' format_distribution carries the same per-format item counts. Treat
  // that as one unnamed group so this works for any course, not only the multi-exam ones.
  const readSizes = readExamSize(examFormat).exam_sizes;
  const sizes: Record<string, { total_questions: number; format_question_counts?: Record<string, number> }> =
    readSizes || (() => {
      const counts: Record<string, number> = {};
      for (const f of (guidelines.format_distribution as Array<Record<string, unknown>>) || []) {
        const slug = canonicalizeFormatSlug(String(f.format || f.slug || ''));
        const n = Number(f.count);
        if (slug && n > 0) counts[slug] = n;
      }
      if (Object.keys(counts).length === 0) return {} as Record<string, { total_questions: number; format_question_counts?: Record<string, number> }>;
      return { '': { total_questions: Number(guidelines.total_questions) || 0, format_question_counts: counts } };
    })();
  if (Object.keys(sizes).length === 0) {
    throw new Error('no per-format item counts on this course — regenerate the guidelines first');
  }

  const rows = await fetchAllRows<Row>((from, to) =>
    supabase.from('qb_questions').select('id,subject,status,content,tags,quality_score,combined_score,validator_score')
      .eq('job_id', JOB).is('replaced_by_id', null).range(from, to)
  );
  const live = rows.filter((r) => r.status !== 'replaced');
  console.log(`${courseName} job ${JOB.slice(0, 8)} — ${live.length} live questions across ${Object.keys(sizes).length} exams\n`);

  const examOfSubject = subjectExamMap(structure);
  const examOf = (r: Row) => String((r.tags || {}).exam || examOfSubject[r.subject] || '');
  const fmtOf = (r: Row) => canonicalizeFormatSlug(String((r.tags || {}).format_type || 'mcq_single'));

  const toGenerate: Array<{ exam: string; slug: string; n: number }> = [];
  const toRetire: Row[] = [];

  // A grouped row can be the right COUNT but carry too few scored questions — LSAT's four
  // reading passages held 5,5,6,5 where the real section is 26-28 across four. Retire those
  // so the count gap below regenerates them against the corrected sub-question bounds.
  const thinById = new Set<string>();
  for (const [slug, spec] of Object.entries((guidelines.format_specs || {}) as Record<string, { schema_params?: Record<string, unknown> }>)) {
    const min = Number(spec?.schema_params?.sub_question_min) || 0;
    if (min <= 1) continue;
    for (const r of live) {
      if (fmtOf(r) !== canonicalizeFormatSlug(slug)) continue;
      const n = ((r.content as Record<string, unknown>)?.sub_questions as unknown[] | undefined)?.length || 0;
      if (n < min) {
        thinById.add(r.id);
        console.log(`  thin ${slug}: ${r.subject?.slice(0, 40)} has ${n} sub-questions, needs ${min}`);
      }
    }
  }
  if (thinById.size > 0) {
    toRetire.push(...live.filter((r) => thinById.has(r.id)));
    console.log(`  → ${thinById.size} under-filled grouped item(s) will be retired and regenerated\n`);
  }

  // Explicitly forced rebuilds join the same retire-then-fill-the-gap path.
  for (const slug of REGENERATE) {
    const canon = canonicalizeFormatSlug(slug);
    const all = live.filter((r) => fmtOf(r) === canon && !thinById.has(r.id));
    // Weakest first, so a partial rebuild replaces the least good ones.
    const rows = LIMIT > 0
      ? [...all].sort((a, b) => ((a.combined_score ?? a.quality_score ?? 0) - (b.combined_score ?? b.quality_score ?? 0))).slice(0, LIMIT)
      : all;
    for (const r of rows) thinById.add(r.id);
    toRetire.push(...rows);
    console.log(`  → --regenerate ${canon}: retiring ${rows.length} of ${all.length} live row(s) for rebuild\n`);
  }

  for (const [exam, size] of Object.entries(sizes)) {
    const want = size.format_question_counts;
    if (!want) continue;
    // The single-exam fallback groups under '' while the rows still carry their real exam
    // tag ("LSAT"), so matching on it found nothing and the whole bank looked missing —
    // a dry run that proposed regenerating all 80 questions. An unnamed group IS every row.
    const mine = exam ? live.filter((r) => examOf(r) === exam) : live;
    console.log(`  ${exam}  (${mine.length} live, target ${size.total_questions})`);

    for (const [slug, target] of Object.entries(want)) {
      if (ONLY_FORMAT && slug !== ONLY_FORMAT) continue;
      const have = mine.filter((r) => fmtOf(r) === slug && !thinById.has(r.id));
      const delta = target - have.length;
      if (delta > 0) {
        toGenerate.push({ exam, slug, n: delta });
        console.log(`      ${slug.padEnd(24)} ${have.length}/${target}   generate ${delta}`);
      } else if (delta < 0) {
        // Retire the weakest first, so the section keeps its best questions.
        const worst = [...have].sort((a, b) =>
          ((a.combined_score ?? a.quality_score ?? 0) - (b.combined_score ?? b.quality_score ?? 0))
        ).slice(0, -delta);
        toRetire.push(...worst);
        console.log(`      ${slug.padEnd(24)} ${have.length}/${target}   retire ${-delta} (weakest)`);
      } else {
        console.log(`      ${slug.padEnd(24)} ${have.length}/${target}   ok`);
      }
    }
  }

  const genTotal = toGenerate.reduce((n, g) => n + g.n, 0);
  console.log(`\nPLAN: generate ${genTotal}, retire ${toRetire.length} → ${live.length + genTotal - toRetire.length} live`);
  if (!APPLY) {
    console.log('\nDry run — nothing written. Re-run with --apply.');
    return;
  }
  if (genTotal === 0 && toRetire.length === 0) { console.log('Nothing to do.'); return; }

  // ── Generate ──────────────────────────────────────────────────────────────
  const qf = (examFormat.question_format || {}) as Record<string, unknown>;
  let subjectIndex = 10_000; // keep new question_numbers clear of the originals
  let inserted = 0;

  for (const g of toGenerate) {
    // Spread the needed items over that exam's subjects, biggest first.
    // Same empty-group trap as above: with no exam name, every subject in the bank is in
    // scope. Prefer subjects that already host this format, so a regenerated reading passage
    // lands back in a reading subject rather than an arbitrary one.
    const hosts = [...new Set(live.filter((r) => fmtOf(r) === g.slug).map((r) => r.subject))];
    const subjects = g.exam
      ? Object.entries(examOfSubject).filter(([, e]) => e === g.exam).map(([s]) => s)
      : (hosts.length > 0 ? hosts : [...new Set(live.map((r) => r.subject))]);
    const bySize = subjects
      .map((s) => ({ s, n: live.filter((r) => r.subject === s).length }))
      .sort((a, b) => b.n - a.n);
    if (bySize.length === 0) { console.warn(`  ${g.exam}: no subjects found — skipping`); continue; }

    const per = new Map<string, number>();
    for (let i = 0; i < g.n; i++) {
      const s = bySize[i % bySize.length].s;
      per.set(s, (per.get(s) || 0) + 1);
    }

    for (const [subject, count] of per) {
      const task = {
        subject,
        exam: g.exam,
        num_questions: count,
        num_image_qs: 0,
        bloom_counts: { '3_apply': Math.ceil(count / 2), '4_analyze': Math.floor(count / 2) },
        hyt_topics: [],
        exam_params: {
          style: (qf.type as string) || 'standard',
          num_options: (qf.num_options as number) || 4,
          marking: (examFormat.negative_marking as string) || 'Standard positive marking',
        },
        exam_pattern: examFormat.exam_pattern as Record<string, unknown>,
        question_type_allocations: [{ slug: g.slug, name: g.slug, count, percentage: 100 }],
        // --shape pins one variant of a format for this rebuild. It must go into
        // syntax_rules and structure_requirements: buildFormatSchema (questionGeneration.ts
        // :689-691) renders THOSE into the per-format prompt and never reads when_to_use, so
        // a shape written only there is silently ignored — two "drafting" sets came back as
        // six-component counselling ones with NCLEX formats because of exactly that.
        // Replacing the rules outright, rather than appending, stops the counselling rules
        // ("exactly six sub_questions", "at least three format_types") contradicting it.
        guidelines: SHAPE
          ? {
              ...guidelines,
              format_specs: {
                ...(guidelines.format_specs as Record<string, unknown>),
                [g.slug]: {
                  ...((guidelines.format_specs as Record<string, Record<string, unknown>>)?.[g.slug] || {}),
                  when_to_use: SHAPE,
                  syntax_rules: [SHAPE],
                  structure_requirements: [SHAPE],
                  // specFor (questionGeneration.ts:708) returns a spec ONLY when it carries a
                  // generation_template — clearing it made the whole spec invisible and the
                  // prompt fell back to the hardcoded case_study template, whose skeleton
                  // demonstrates sata / matrix_grid / cloze_dropdown. That is why two
                  // "drafting" sets came back as six-component NCLEX-shaped counselling sets.
                  // Supply a skeleton of the shape we actually want: the demonstrated shape is
                  // what a model copies.
                  generation_template: {
                    format_type: 'case_study',
                    case_narrative: '<the shared client matter: client, parties, chronology, procedural posture or transaction status, and the client objective>',
                    response_instructions: '<what the examinee must produce, its audience and its required length>',
                    sub_questions: [
                      {
                        number: 1,
                        format_type: 'constructed_response',
                        question: '<the drafting assignment — draft a client advice letter / memo section / demand letter / contract clause / motion passage>',
                        scoring_rubric: ['<point a passing answer must cover>', '<another required point>', '<another required point>'],
                        rationale: '<why those points are what a competent answer contains>',
                        reasoning_step: '<the lawyering step this exercises>',
                        difficulty: 'medium',
                      },
                    ],
                    explanation: '<how the facts drive the required work product — 3-5 sentences>',
                    difficulty: 'medium',
                    bloom_level: '5_evaluate',
                    is_image_question: false,
                  },
                },
              },
            }
          : guidelines,
      };
      process.stdout.write(`  ${g.exam} / ${subject}: ${count} × ${g.slug} … `);
      try {
        const fresh = await professorGenerateQuestions(task as never, courseName);
        const kept = fresh.filter((q) => canonicalizeFormatSlug(String(q.format_type || '')) === g.slug);
        if (kept.length === 0) { console.log('nothing usable'); continue; }
        await insertSubjectQuestions(kept, JOB, job.course_id as string, courseName, subjectIndex++, guidelines, g.exam);
        inserted += kept.length;
        console.log(`${kept.length} inserted${kept.length < count ? ` (${count - kept.length} short)` : ''}`);
      } catch (e) {
        console.log(`failed — ${e instanceof Error ? e.message : e}`);
      }
    }
  }

  // ── Retire the surplus ────────────────────────────────────────────────────
  if (toRetire.length > 0) {
    const ids = toRetire.map((r) => r.id);
    for (let i = 0; i < ids.length; i += 100) {
      const { error } = await supabase.from('qb_questions').update({ status: 'replaced' }).in('id', ids.slice(i, i + 100));
      if (error) throw new Error(error.message);
    }
    console.log(`\nretired ${ids.length} surplus question(s) to status 'replaced'`);
  }

  // ── Reopen so the new questions get scored ────────────────────────────────
  if (inserted > 0) {
    const { error } = await supabase.from('qb_jobs').update({ status: 'reviewing', error: null }).eq('id', JOB);
    if (error) throw new Error(error.message);
    console.log(`reopened job to 'reviewing' — ${inserted} new question(s) await review`);
    console.log(`next: POST /api/jobs/${JOB}/resume  (review scopes to status='generated', so only the new ones run)`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
