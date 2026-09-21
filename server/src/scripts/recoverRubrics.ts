/**
 * Un-stringify rubrics the fixer flattened.
 *
 * `scoring_rubric` was declared a bare string, so a structured marking scheme failed
 * validation and the fixer satisfied it with JSON.stringify — schema-valid, useless.
 * The stringify was lossless, so parsing it back restores the criteria exactly.
 */
import 'dotenv/config';
import { supabase } from '../db/supabase.js';
import { fetchAllRows } from '../db/pagination.js';

const APPLY = process.argv.includes('--apply');

function parseIfJson(v: unknown): unknown | null {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  if (!(t.startsWith('{') || t.startsWith('['))) return null;
  try {
    const p = JSON.parse(t);
    return p && typeof p === 'object' ? p : null;
  } catch { return null; }
}

/** Walk content, restoring every stringified rubric. Returns how many it fixed. */
function restore(node: any): number {
  if (!node || typeof node !== 'object') return 0;
  let n = 0;
  if (node.scoring_rubric !== undefined) {
    const parsed = parseIfJson(node.scoring_rubric);
    if (parsed) { node.scoring_rubric = parsed; n++; }
  }
  for (const v of Object.values(node)) {
    if (Array.isArray(v)) v.forEach((x) => { n += restore(x); });
    else n += restore(v);
  }
  return n;
}

async function main() {
  const { data: jobs } = await supabase.from('qb_jobs').select('id,course_id');
  const { data: courses } = await supabase.from('qb_courses').select('id,name');
  const cname = new Map((courses as any[]).map((c) => [c.id, c.name]));
  let totalQ = 0, totalR = 0;

  for (const j of (jobs || []) as any[]) {
    const rows = await fetchAllRows<any>((from, to) =>
      supabase.from('qb_questions').select('id,content').eq('job_id', j.id).is('replaced_by_id', null).order('id').range(from, to));
    let jq = 0, jr = 0;
    for (const q of rows) {
      const content = q.content;
      const before = JSON.stringify(content);
      const fixed = restore(content);
      if (fixed === 0 || JSON.stringify(content) === before) continue;
      jq++; jr += fixed;
      if (APPLY) {
        const { error } = await supabase.from('qb_questions').update({ content }).eq('id', q.id);
        if (error) console.error(`  ${q.id.slice(0, 8)}: write failed ${error.message}`);
      }
    }
    if (jq) console.log(`  ${j.id.slice(0, 8)}  ${String(cname.get(j.course_id) || '?').slice(0, 10).padEnd(10)} ${jq} question(s), ${jr} rubric(s)`);
    totalQ += jq; totalR += jr;
  }
  console.log(`\n${APPLY ? 'restored' : 'would restore'}: ${totalR} rubric(s) across ${totalQ} question(s)`);
}
main().catch((e) => { console.error(e); process.exit(1); });
