/**
 * Checks that only make sense across a whole generated set.
 *
 * Duplicate concepts: subjects generate in parallel and cannot see each other, and a subject's batches
 * and replacements only see their own subject. The first NCLEX bow-tie set keyed tumour lysis syndrome,
 * malignant hyperthermia and salicylate toxicity twice each across subjects; they were found and
 * replaced by hand. Here items whose keyed answers name the same thing are put to sameConcept(), and
 * the later of a confirmed pair is flagged so the replace step writes a new concept in its place.
 *
 * Generated jobs only: an imported bank's duplicates are its own business (it marks them itself).
 */
import { supabase } from '../../db/supabase.js';
import { fetchAllRows } from '../../db/pagination.js';
import { optionTexts } from './reviewMode.js';
import { sameConcept } from './conceptGuard.js';

type Row = Record<string, any>;

/** What an item's answer names: the keyed option, or a bow-tie's keyed condition. */
function keyedThing(q: Row): string {
  const c = (q.content || {}) as Row;
  if (Array.isArray(c.condition_options)) return String(c.condition_options.find((o: Row) => o.key === c.answer?.condition)?.text ?? '');
  const { texts, key } = optionTexts(q);
  return key >= 0 ? String(texts[key]) : '';
}
const words = (s: string) => new Set(s.toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').split(' ').filter((w) => w.length > 3));
function overlap(a: string, b: string): number {
  const A = words(a), B = words(b);
  if (!A.size || !B.size) return 0;
  let n = 0; for (const w of A) if (B.has(w)) n++;
  return n / Math.min(A.size, B.size);
}

export async function flagDuplicateConcepts(jobId: string, log: (s: string) => void = console.log): Promise<number> {
  const rows = await fetchAllRows<Row>((from, to) => supabase.from('qb_questions')
    .select('id, question_number, question, options, correct_option, content, status, audit_trail')
    .eq('job_id', jobId).is('replaced_by_id', null).in('status', ['approved', 'flagged']).order('question_number').range(from, to));
  const kept: Row[] = [];
  // config.dedup_course: also compare against the course's approved items from other jobs. Per-topic
  // plan jobs generate in parallel and cannot see each other; 85 Step 3 image items carried twelve
  // cross-topic repeats (sigmoid volvulus three times, fixed airway obstruction four). Off by default
  // until measured on other exams.
  const { data: job } = await supabase.from('qb_jobs').select('course_id, config').eq('id', jobId).single();
  if (job?.config?.dedup_course) {
    const others = await fetchAllRows<Row>((from, to) => supabase.from('qb_questions')
      .select('id, job_id, question_number, question, options, correct_option, content')
      .eq('course_id', job.course_id).neq('job_id', jobId).eq('status', 'approved').is('replaced_by_id', null).range(from, to));
    kept.push(...others.map((o) => ({ ...o, _other: true })));
  }
  let flagged = 0;
  for (const q of rows) {
    const thing = keyedThing(q);
    if (!thing) { kept.push(q); continue; }
    // Candidates: an earlier kept item whose keyed answer names much the same thing.
    const cands = kept.filter((k) => overlap(keyedThing(k), thing) >= 0.6);
    let dupOf: Row | null = null;
    for (const k of cands) { if ((await sameConcept(k, q)).same) { dupOf = k; break; } }
    if (!dupOf) { kept.push(q); continue; }
    flagged++;
    const trail = [...(Array.isArray(q.audit_trail) ? q.audit_trail : []), {
      phase: 'set_check', reason: `DUPLICATE CONCEPT — tests the same thing as ${dupOf._other ? `an approved item in another job (${String(dupOf.id).slice(0, 8)})` : `Q${dupOf.question_number}`} ("${thing.slice(0, 80)}")`, timestamp: new Date().toISOString(),
    }];
    await supabase.from('qb_questions').update({ status: 'flagged', audit_trail: trail }).eq('id', q.id);
    log(`  [SetCheck] Q${q.question_number} duplicates ${dupOf._other ? `${String(dupOf.id).slice(0, 8)} (other job)` : `Q${dupOf.question_number}`}: ${thing.slice(0, 60)}`);
  }
  return flagged;
}
