/**
 * Import an authoritative v3 curriculum file into a course's structure.
 *
 * These files are maintained outside the app (Subjects-Topics-Chapters/*-curriculum-v3.json)
 * and are the source of truth for the hierarchy:
 *
 *     course > exam > subject > topic > chapter
 *
 * They already carry what the app otherwise has to guess or infer: which exam each subject
 * belongs to, subject names made unique across exams ("Ethical and Professional Standards
 * (L1)" vs "(L2)" vs "(L3)"), official subject weights, high-yield flags at both topic and
 * chapter level, and per-chapter objectives. Deriving any of that with an LLM is strictly
 * worse — it guesses at something already written down.
 *
 * All four known files share the schema:
 *     bar   1 exam    10 subjects   60 topics
 *     lsat  1 exam    13 subjects   47 topics
 *     cfa   3 exams   28 subjects  182 topics
 *     cpa   6 exams   22 subjects  126 topics
 *
 * CFA LEVEL III PATHWAYS. Level III is one sitting whose specialized pathway (30-35%) is
 * elected at registration — a candidate sits the common core plus exactly ONE of three. The
 * file models that with a `block` on each Level III subject. With --split-pathways the
 * importer fans that exam into one exam per pathway, duplicating the common-core subjects
 * under pathway-qualified names, so each variant is a paper someone actually sits. A subject
 * carries exactly one `exam` tag, which is why the core must be duplicated rather than shared.
 *
 * Dry run by default — prints the proposed structure and writes nothing. Pass --apply.
 */
import 'dotenv/config';
import { supabase } from '../db/supabase.js';
import { readFileSync } from 'node:fs';

const APPLY = process.argv.includes('--apply');
const SPLIT_PATHWAYS = process.argv.includes('--split-pathways');
const FILE = (process.argv.find((a) => a.startsWith('--file=')) || '').split('=')[1] || '';
const COURSE = (process.argv.find((a) => a.startsWith('--course=')) || '').split('=')[1] || '';

if (!FILE || !COURSE) {
  console.error('usage: importCurriculumV3.ts --file=<curriculum-v3.json> --course=<uuid> [--split-pathways] [--apply]');
  process.exit(1);
}

interface SrcChapter { chapter?: string; hyt?: boolean }
interface SrcTopic { topic?: string; hyt?: boolean; chapters?: SrcChapter[] }
interface SrcSubject {
  subject?: string; weight?: string; weight_2026?: string; block?: string;
  pathway_note?: string; topics?: SrcTopic[];
}
interface SrcExam { exam?: string; exam_id?: string; subjects?: SrcSubject[] }

interface OutSubject {
  name: string; exam: string; description?: string; weight?: string;
  topics: Array<{ name: string; high_yield: boolean; chapters: Array<{ name: string }> }>;
}

/** A pathway subject is elected, not universal — the file says so on the subject itself. */
const isPathway = (s: SrcSubject) => Boolean(s.pathway_note) || /specialized pathway/i.test(s.block || '');

function mapTopics(src: SrcTopic[] | undefined): OutSubject['topics'] {
  return (src || [])
    .filter((t) => t.topic)
    .map((t) => ({
      name: String(t.topic),
      high_yield: Boolean(t.hyt),
      chapters: (t.chapters || []).filter((c) => c.chapter).map((c) => ({ name: String(c.chapter) })),
    }));
}

function main() {
  const raw = JSON.parse(readFileSync(FILE, 'utf8')) as Record<string, unknown>;
  const srcExams = (raw.exams as SrcExam[]) || [];
  if (srcExams.length === 0) throw new Error('curriculum file declares no exams');

  console.log(`${raw.course} — v${raw.structure_version}, ${srcExams.length} exam(s)`);
  console.log(`counts: ${JSON.stringify(raw.counts)}\n`);

  const subjects: OutSubject[] = [];
  const exams: Array<{ code: string; name: string; subject_count: number; topic_count: number }> = [];

  // Codes must be unique: initialling the pathway names gave "Portfolio Management" and
  // "Private Markets" the same PM, so two CFA Level III variants shipped as L3-PM.
  const usedCodes = new Set<string>();
  const uniqueCode = (want: string) => {
    let code = want || 'EXAM';
    for (let n = 2; usedCodes.has(code); n++) code = `${want}${n}`;
    usedCodes.add(code);
    return code;
  };

  const addExam = (name: string, code: string, members: OutSubject[]) => {
    subjects.push(...members);
    exams.push({
      code: uniqueCode(code), name,
      subject_count: members.length,
      topic_count: members.reduce((n, s) => n + s.topics.length, 0),
    });
  };

  for (const ex of srcExams) {
    const examName = String(ex.exam || '').trim();
    if (!examName) continue;
    const code = String(ex.exam_id || examName).replace(/^.*-/, '').toUpperCase();
    const srcSubjects = ex.subjects || [];

    const pathways = srcSubjects.filter(isPathway);
    const core = srcSubjects.filter((s) => !isPathway(s));

    if (SPLIT_PATHWAYS && pathways.length > 1) {
      // One exam per elected pathway: common core (duplicated, since a subject carries a
      // single exam tag) plus that one pathway's subject.
      for (const p of pathways) {
        const pathwayName = String(p.subject).replace(/\s*Pathway\s*$/i, '').trim();
        const variantExam = `${examName} (${pathwayName})`;
        const members: OutSubject[] = core.map((s) => ({
          name: `${s.subject} — ${pathwayName}`,
          exam: variantExam,
          weight: s.weight_2026 || s.weight,
          topics: mapTopics(s.topics),
        }));
        members.push({
          name: String(p.subject),
          exam: variantExam,
          weight: p.weight_2026 || p.weight,
          topics: mapTopics(p.topics),
        });
        // Two letters per word, because initials collide: Portfolio Management and Private
        // Markets are both "PM". PoMa / PrMa / PrWe stay short and stay distinct.
        const short = pathwayName.split(/\s+/).slice(0, 2)
          .map((w) => w.charAt(0).toUpperCase() + w.charAt(1).toLowerCase()).join('');
        addExam(variantExam, `${code}-${short}`, members);
      }
      continue;
    }

    addExam(examName, code, srcSubjects.map((s) => ({
      name: String(s.subject),
      exam: examName,
      weight: s.weight_2026 || s.weight,
      topics: mapTopics(s.topics),
    })));
  }

  // ── Validate: the invariants the rest of the pipeline silently depends on ──
  const problems: string[] = [];

  // subjectExamMap (examSize.ts) keys by subject NAME — a duplicate would drop an exam's
  // subjects without any error.
  const names = subjects.map((s) => s.name);
  const dupes = [...new Set(names.filter((n, i) => names.indexOf(n) !== i))];
  if (dupes.length > 0) problems.push(`duplicate subject names: ${dupes.slice(0, 5).join(', ')}`);

  for (const s of subjects) {
    if (s.topics.length === 0) problems.push(`subject "${s.name}" has no topics`);
    if (!exams.some((e) => e.name === s.exam)) problems.push(`subject "${s.name}" tagged to unknown exam "${s.exam}"`);
  }
  for (const e of exams) if (e.subject_count === 0) problems.push(`exam "${e.name}" has no subjects`);

  // Conservation against the file's own counts. With --split-pathways the core is
  // deliberately duplicated, so compare per exam rather than globally.
  const srcTopicTotal = srcExams.reduce((n, e) =>
    n + (e.subjects || []).reduce((m, s) => m + (s.topics || []).length, 0), 0);
  const outTopicTotal = subjects.reduce((n, s) => n + s.topics.length, 0);
  if (!SPLIT_PATHWAYS && srcTopicTotal !== outTopicTotal) {
    problems.push(`topic count changed: file has ${srcTopicTotal}, output has ${outTopicTotal}`);
  }

  // ── Report ──
  for (const e of exams) {
    console.log(`  ${e.name}  —  ${e.subject_count} subjects, ${e.topic_count} topics`);
    for (const s of subjects.filter((x) => x.exam === e.name)) {
      const ch = s.topics.reduce((n, t) => n + t.chapters.length, 0);
      const hy = s.topics.filter((t) => t.high_yield).length;
      console.log(`      ${String(s.topics.length).padStart(3)} topics ${String(ch).padStart(4)} ch  ${hy ? `${hy} HY  ` : '      '}${s.weight ? `${s.weight.padEnd(9)}` : '         '}${s.name}`);
    }
    console.log('');
  }
  const chapters = subjects.reduce((n, s) => n + s.topics.reduce((m, t) => m + t.chapters.length, 0), 0);
  console.log(`TOTAL: ${exams.length} exams, ${subjects.length} subjects, ${outTopicTotal} topics, ${chapters} chapters` +
    (SPLIT_PATHWAYS ? `  (file: ${srcTopicTotal} topics before the pathway fan-out)` : ''));

  if (problems.length > 0) {
    console.error(`\nVALIDATION FAILED — ${problems.length} problem(s), nothing written:`);
    for (const p of problems) console.error(`  - ${p}`);
    process.exit(1);
  }
  console.log('Validation passed: unique subject names, every subject populated, every exam populated.');

  if (!APPLY) {
    console.log('\nDry run — nothing written. Re-run with --apply to save.');
    return;
  }
  return { subjects, exams };
}

const result = main();
if (result) {
  const { data: course, error } = await supabase
    .from('qb_courses').select('id,name,structure').eq('id', COURSE).single();
  if (error || !course) throw new Error(error?.message || 'course not found');

  const next = {
    ...((course.structure || {}) as Record<string, unknown>),
    subjects: result.subjects,
    exams: result.exams,
    selected_exam: '__all__',
  };
  const { error: upErr } = await supabase.from('qb_courses').update({ structure: next }).eq('id', COURSE);
  if (upErr) throw new Error(upErr.message);
  console.log(`\nApplied to ${course.name}: ${result.exams.length} exams, ${result.subjects.length} subjects.`);
  console.log('Next: regenerate the exam format and guidelines so each exam gets its own size.');
}
