/**
 * How often does the blind image check (imageCheck.checkExistingImage) fail a live-bank image, and on
 * what? Validation turns every failure into a replacement, so a check that fails sound real images
 * would swap good radiographs for drawings. Run it over imported items and compare with audit's own
 * image verdict (IMAGE_CONSISTENT / IMAGE_INTEGRAL) and by eye.
 *
 *   npx tsx src/scripts/benchmarkLiveImageCheck.ts --job <jobId> --out backups/image_bench/live_check.json [--pool 3]
 *
 * Read-only on the database.
 */
import 'dotenv/config';
import { writeFileSync } from 'node:fs';
import { supabase } from '../db/supabase.js';
import { checkExistingImage } from '../services/images/imageCheck.js';

const arg = (n: string) => { const i = process.argv.indexOf(`--${n}`); return i >= 0 ? process.argv[i + 1] : undefined; };
const JOB = arg('job')!, OUT = arg('out')!, POOL = Number(arg('pool') || 3);
if (!JOB || !OUT) throw new Error('--job and --out required');

const { data: rows, error } = await supabase.from('qb_questions').select('*').eq('job_id', JOB).is('replaced_by_id', null).not('image_url', 'is', null).order('question_number');
if (error) throw new Error(error.message);
type Row = Record<string, any>;
const out: Row[] = [];
const auditImageFail = (q: Row) => {
  const a = [...(q.audit_trail || [])].reverse().find((e: Row) => e?.phase === 'audit');
  return (a?.checks || []).some((c: Row) => /^IMAGE_/.test(c.id) && c.result === 'fail');
};
const queue = [...rows!];
await Promise.all(Array.from({ length: POOL }, async () => {
  for (let q = queue.shift(); q; q = queue.shift()) {
    let c = null;
    for (let t = 1; t <= 2 && !c; t++) c = await checkExistingImage(q).catch(() => null);
    out.push({ n: q.question_number, status: q.status, audit_image_fail: auditImageFail(q), check_pass: c?.pass ?? null, missing: c?.missing, read: c?.read?.slice(0, 1200), stem: q.question, key: q.options?.[q.correct_option], url: q.image_url });
    console.log(`Q${q.question_number} [${q.status}${auditImageFail(q) ? ', audit image fail' : ''}] blind check: ${c ? (c.pass ? 'pass' : 'FAIL — ' + c.missing.join('; ').slice(0, 140)) : 'no verdict'}`);
  }
}));
out.sort((a, b) => a.n - b.n);
writeFileSync(OUT, JSON.stringify(out, null, 1));
const judged = out.filter((r) => r.check_pass !== null);
const agree = judged.filter((r) => r.check_pass === !r.audit_image_fail).length;
console.log(`\n${judged.length} judged of ${out.length}: blind check fails ${judged.filter((r) => !r.check_pass).length}; audit fails the image on ${out.filter((r) => r.audit_image_fail).length}; agreement with audit ${agree}/${judged.length}`);
process.exit(0);
