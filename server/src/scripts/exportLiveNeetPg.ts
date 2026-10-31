/**
 * Export the 10K NEET PG validation sample from the live bank (project ylbwdadhbcjolwylidja, course
 * 'Indian PG' 967d23a4…) in the shape exportLiveUsmle.ts writes, for importUsmleExport-style loading.
 *
 * Which questions: neetPgSample.sql — validated, tagged NEET-PG, not tagged PYQ, sampled to the subject,
 * topic, difficulty and image mix of the 2019–2025 NEET PG papers. The export role (qbank_export_ro)
 * cannot read question_tags, so the selection is computed through the read-only Supabase MCP and handed
 * over as a bitmap over this course's validated question ids in id order (--bitmap). Every checksum
 * is re-computed here: the universe must be the same ids the bitmap was built on, and the decoded ids
 * must hash to the selection's md5, or nothing is written.
 *
 *   npx tsx src/scripts/exportLiveNeetPg.ts --bitmap backups/neetpg_export/selection_bitmap.json \
 *     --out backups/neetpg_export/neetpg_10k_sample.json
 *
 * Any other selection over the same universe works the same way; --filter records how it was built.
 *
 * Reads only: every statement runs in a READ ONLY transaction.
 */
import 'dotenv/config';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import pg from 'pg';

const COURSE = '967d23a4-3bc7-4653-a5c3-82e91420c615';
const PAGE = 500;
const arg = (n: string) => { const i = process.argv.indexOf(`--${n}`); return i >= 0 ? process.argv[i + 1] : undefined; };
const url = process.env.LIVE_DATABASE_URL;
if (!url) throw new Error('LIVE_DATABASE_URL is not set (server/.env)');
const bitmapFile = arg('bitmap'), out = arg('out');
if (!bitmapFile || !out) throw new Error('--bitmap and --out required');
const bm = JSON.parse(readFileSync(bitmapFile, 'utf8'));
const hex: string = bm.chunks.join('');
const md5 = (s: string) => createHash('md5').update(s).digest('hex');
if (hex.length !== bm.hex_len || md5(hex) !== bm.hex_md5) throw new Error('bitmap file is corrupt (length or md5 mismatch)');

const client = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
await client.connect();
await client.query('set session characteristics as transaction read only');

const { rows: [u] } = await client.query(`
  select count(*)::int as n, md5(string_agg(q.id::text, ',' order by q.id)) as md5, array_agg(q.id::text order by q.id) as ids
  from questions q join topics t on t.id = q.topic_id join subjects s on s.id = t.subject_id
  where s.course_id = $1 and q.validation_status = 'validated'`, [COURSE]);
if (u.n !== bm.universe_n || u.md5 !== bm.universe_md5)
  throw new Error(`the bank changed since the selection was computed (universe ${u.n}/${u.md5}, bitmap built on ${bm.universe_n}/${bm.universe_md5}); recompute the bitmap`);

const ids = (u.ids as string[]).filter((_, i) => (parseInt(hex[i >> 2], 16) >> (3 - (i & 3))) & 1);
const { rows: [chk] } = await client.query(`select md5(string_agg(id::text, ',' order by id)) as md5 from unnest($1::uuid[]) id`, [ids]);
if (ids.length !== bm.pick_n || chk.md5 !== bm.pick_md5) throw new Error(`decoded ${ids.length} ids hashing to ${chk.md5}; expected ${bm.pick_n}/${bm.pick_md5}`);
console.log(`selection verified: ${ids.length} ids`);

const questions: any[] = [];
for (let i = 0; i < ids.length; i += PAGE) {
  const { rows } = await client.query(`
    select q.id, q.created_at, s.name as subject, t.name as topic, q.question_text, q.explanation, q.difficulty, q.blooms_level,
           q.format, q.question_type, q.validation_status, q.last_validated_at, q.content, q.image_details, q.metadata,
           coalesce((select json_agg(json_build_object('id', o.id, 'text', o.option_text, 'is_correct', o.is_correct) order by o.id)
                     from options o where o.question_id = q.id), '[]'::json) as options,
           coalesce((select json_agg(json_build_object('asset_id', a.id, 'url', a.public_url, 'description', a.description) order by qa.created_at)
                     from question_assets qa join assets a on a.id = qa.asset_id where qa.question_id = q.id), '[]'::json) as assets
    from questions q join topics t on t.id = q.topic_id join subjects s on s.id = t.subject_id
    where q.id = any($1::uuid[]) order by s.name, t.name, q.id`, [ids.slice(i, i + PAGE)]);
  questions.push(...rows);
  console.log(`  ${questions.length}/${ids.length}`);
}
await client.end();

// The mix as the sample defines it: difficulty on one scale, image = has an attached asset.
const band = (d: string | null) => (d === 'easy' || d === '1' ? 'easy' : ['hard', '3', '4', '5'].includes(d ?? '') ? 'hard' : 'medium');
const subj = (s: string) => (s === 'General Medicine' ? 'Internal Medicine' : s);
const report: Record<string, { n: number; image: number; easy: number; medium: number; hard: number }> = {};
for (const q of questions) {
  const r = (report[subj(q.subject)] ??= { n: 0, image: 0, easy: 0, medium: 0, hard: 0 });
  r.n++; if (q.assets.length) r.image++; r[band(q.difficulty) as 'easy']++;
}
const tot = Object.values(report).reduce((a, r) => ({ n: a.n + r.n, image: a.image + r.image, easy: a.easy + r.easy, medium: a.medium + r.medium, hard: a.hard + r.hard }), { n: 0, image: 0, easy: 0, medium: 0, hard: 0 });
const pct = (x: number) => `${((100 * x) / tot.n).toFixed(1)}%`;
console.log(`total ${tot.n}: image ${tot.image} (${pct(tot.image)}), easy/medium/hard ${pct(tot.easy)} / ${pct(tot.medium)} / ${pct(tot.hard)}`);
console.table(Object.fromEntries(Object.entries(report).sort((a, b) => b[1].n - a[1].n)));

// --filter: how the bitmap was built, recorded in the file (default: the 10K sample of neetPgSample.sql).
const filter = arg('filter') ?? `course 'Indian PG' (967d23a4-...), validated, tagged NEET-PG, not tagged PYQ; sampled by neetPgSample.sql to the 2019–2025 NEET PG papers' subject/topic/difficulty/image mix`;
writeFileSync(out, JSON.stringify({ exported_at: new Date().toISOString().slice(0, 10), source_project: 'ylbwdadhbcjolwylidja', filter, selection_md5: bm.pick_md5, count: questions.length, distribution: { total: tot, by_subject: report }, questions }, null, 1));
console.log(`wrote ${questions.length} to ${out}`);
process.exit(0);
