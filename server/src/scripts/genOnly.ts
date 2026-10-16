/**
 * Generate a job and stop before review — for benchmarking generation on its own
 * (benchmarkExamFidelity.ts score). Uses only modules every recent checkout has, so the same file runs
 * against an older checkout for the "before" side.
 *
 *   npx tsx src/scripts/genOnly.ts --course <id> --counts '{"Biochemistry":5}' --label old1
 */
import 'dotenv/config';
import { supabase } from '../db/supabase.js';
import { generateBatchForJob } from '../services/generation/questionGeneration.js';

const arg = (n: string) => { const i = process.argv.indexOf(`--${n}`); return i >= 0 ? process.argv[i + 1] : undefined; };
const course = arg('course')!;
const counts = JSON.parse(arg('counts') || '{}') as Record<string, number>;
const { data: c } = await supabase.from('qb_courses').select('structure').eq('id', course).single();
const subjects = ((c?.structure as Record<string, any>)?.subjects || []) as Array<Record<string, any>>;
const topicSelection = Object.fromEntries(subjects.filter((s) => counts[s.name]).map((s) => [s.name, (s.topics || []).map((t: Record<string, any>) => t.name)]));
const { data: job, error } = await supabase.from('qb_jobs').insert({
  course_id: course, type: 'topic_wise', status: 'pending', progress: {},
  config: { topic_selection: topicSelection, subject_question_counts: counts, questions_per_topic: 1, benchmark: `generation:${arg('label') ?? ''}` },
}).select('id').single();
if (error) throw new Error(error.message);
await generateBatchForJob(job.id, course);
for (;;) {
  const { data } = await supabase.from('qb_jobs').select('status').eq('id', job.id).single();
  if (data?.status !== 'generating' && data?.status !== 'pending') break;
  await new Promise((r) => setTimeout(r, 15000));
}
console.log(`JOB ${job.id}`);
process.exit(0);
