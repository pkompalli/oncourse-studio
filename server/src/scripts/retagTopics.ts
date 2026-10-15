/**
 * Re-tag a job's questions with the course-structure topic each one tests. Questions generated before
 * topics were resolved against the structure (questionGeneration.ts resolveTopic) were given topics in
 * rotation. Per subject, a model picks one topic from that subject's structure list for each question;
 * anything it returns that is not on the list is ignored.
 *
 *   npx tsx src/scripts/retagTopics.ts --job <id> [--apply]
 */
import 'dotenv/config';
import { supabase } from '../db/supabase.js';
import { orCall, MODELS } from '../services/llm/openrouter.js';
import { structureTopics, resolveTopic } from '../services/generation/questionGeneration.js';

type Row = Record<string, any>;
const arg = (n: string) => { const i = process.argv.indexOf(`--${n}`); return i >= 0 ? process.argv[i + 1] : undefined; };
const JOB = arg('job')!;
const APPLY = process.argv.includes('--apply');

const { data: job } = await supabase.from('qb_jobs').select('course_id').eq('id', JOB).single();
const { data: course } = await supabase.from('qb_courses').select('structure').eq('id', job!.course_id).single();
const { data: rows } = await supabase.from('qb_questions').select('id, subject, topic, question, content, tags').eq('job_id', JOB).is('replaced_by_id', null);

const bySubject = new Map<string, Row[]>();
for (const q of rows || []) bySubject.set(q.subject, [...(bySubject.get(q.subject) || []), q]);

let changed = 0;
for (const [subject, qs] of bySubject) {
  const topics = structureTopics(course!.structure as Row, subject);
  if (!topics.length) { console.log(`${subject}: no structure topics — skipped`); continue; }
  const prompt = `Each question below belongs to the subject "${subject}". Choose the ONE topic from this list that each question tests:
${topics.map((t, i) => `${i + 1}. ${t}`).join('\n')}

${qs.map((q, i) => `Q${i + 1}: ${String(q.question || q.content?.stem || '').slice(0, 600)}`).join('\n\n')}

Reply with a JSON array of topic numbers, one per question in order, e.g. [3, 1, 12]. JSON only.`;
  const r = await orCall(MODELS.VALIDATOR, '', prompt, { maxTokens: 2000 });
  const picks = JSON.parse((r.content.match(/\[[\s\S]*\]/) || ['[]'])[0]) as number[];
  for (const [i, q] of qs.entries()) {
    const topic = topics[(picks[i] ?? 0) - 1] ?? resolveTopic(String(q.topic || ''), String(q.question || ''), topics);
    if (!topic || topic === q.topic) continue;
    changed++;
    console.log(`${subject.slice(0, 24).padEnd(24)} | ${String(q.topic).slice(0, 34).padEnd(34)} → ${topic}`);
    if (APPLY) {
      const { error } = await supabase.from('qb_questions').update({ topic, tags: { ...(q.tags || {}), topic } }).eq('id', q.id);
      if (error) console.error(`  update failed: ${error.message}`);
    }
  }
}
console.log(`${changed} of ${(rows || []).length} re-tagged${APPLY ? '' : ' (dry run — rerun with --apply)'}`);
process.exit(0);
