/**
 * Export questions of the live USMLE bank (project ylbwdadhbcjolwylidja, course 'US Medical PG') to a
 * file in the same shape as the earlier exports (usmle_questions_post_2025-01-31.json), for
 * importUsmleExport.ts --in. Reads only: it connects with LIVE_DATABASE_URL, a read-only role, and every
 * statement runs in a READ ONLY transaction.
 *
 *   LIVE_DATABASE_URL=… npx tsx src/scripts/exportLiveUsmle.ts --before 2025-01-31 \
 *     --exclude backups/usmle_export/usmle_pre2025_sample100.json --out backups/usmle_export/usmle_questions_pre_2025-01-31.json
 *
 * --before / --after bound questions.created_at; disabled and duplicate questions are left out, as before.
 * --exclude takes an export file (or a JSON array of ids) whose questions are skipped.
 */
import 'dotenv/config';
import { readFileSync, writeFileSync } from 'node:fs';
import pg from 'pg';

const COURSE = '28bfff47-9345-4a3a-9c71-c7f01b336ec5';
const PAGE = 500;
const arg = (n: string) => { const i = process.argv.indexOf(`--${n}`); return i >= 0 ? process.argv[i + 1] : undefined; };
const url = process.env.LIVE_DATABASE_URL;
if (!url) throw new Error('LIVE_DATABASE_URL is not set (server/.env)');
const before = arg('before'), after = arg('after'), out = arg('out');
if (!out) throw new Error('--out required');
const exclude = new Set<string>();
if (arg('exclude')) {
  const x = JSON.parse(readFileSync(arg('exclude')!, 'utf8'));
  for (const v of Array.isArray(x) ? x : x.questions) exclude.add(typeof v === 'string' ? v : v.id);
}

const client = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
await client.connect();
await client.query('set session characteristics as transaction read only');

// The live bank's tags (NEET-PG-2013, AIIMS-2017, PYQ …) ride along to the import and back out in the
// final export (exportSimple.ts), so a write-back keeps every year filter. The export role needs
// SELECT on tags and question_tags; without it this stops rather than silently dropping them.
const { rows: [priv] } = await client.query(`select has_table_privilege('tags', 'select') and has_table_privilege('question_tags', 'select') as ok`);
if (!priv.ok) throw new Error(`the export role cannot read tags/question_tags — grant it: grant select on public.tags, public.question_tags to qbank_export_ro;`);

const where = [`s.course_id = $1`, `coalesce(q.validation_status, '') not in ('disabled', 'duplicate')`];
const params: unknown[] = [COURSE];
if (before) { params.push(before); where.push(`q.created_at <= $${params.length}`); }
if (after) { params.push(after); where.push(`q.created_at > $${params.length}`); }

const { rows: idRows } = await client.query(
  `select q.id from questions q join topics t on t.id = q.topic_id join subjects s on s.id = t.subject_id where ${where.join(' and ')} order by q.created_at, q.id`, params);
const ids = idRows.map((r) => r.id as string).filter((id) => !exclude.has(id));
console.log(`${idRows.length} questions match; ${idRows.length - ids.length} excluded; exporting ${ids.length}`);

const questions: unknown[] = [];
for (let i = 0; i < ids.length; i += PAGE) {
  const { rows } = await client.query(`
    select q.id, q.created_at, s.name as subject, t.name as topic, q.question_text, q.explanation, q.difficulty, q.blooms_level,
           q.format, q.question_type, q.validation_status, q.last_validated_at, q.content, q.image_details, q.metadata,
           coalesce((select json_agg(json_build_object('id', o.id, 'text', o.option_text, 'is_correct', o.is_correct) order by o.id)
                     from options o where o.question_id = q.id), '[]'::json) as options,
           coalesce((select json_agg(json_build_object('asset_id', a.id, 'url', a.public_url, 'description', a.description) order by qa.created_at)
                     from question_assets qa join assets a on a.id = qa.asset_id where qa.question_id = q.id), '[]'::json) as assets,
           coalesce((select json_agg(tg.name order by tg.name) from question_tags qt join tags tg on tg.id = qt.tag_id
                     where qt.question_id = q.id), '[]'::json) as tags
    from questions q join topics t on t.id = q.topic_id join subjects s on s.id = t.subject_id
    where q.id = any($1::uuid[]) order by q.created_at, q.id`, [ids.slice(i, i + PAGE)]);
  questions.push(...rows);
  console.log(`  ${questions.length}/${ids.length}`);
}
await client.end();

const filter = [`course 'US Medical PG' (28bfff47-...)`, before && `questions.created_at <= '${before}'`, after && `questions.created_at > '${after}'`, `validation_status not disabled/duplicate`, exclude.size && `excluding ${exclude.size} ids from ${arg('exclude')}`].filter(Boolean).join(', ');
writeFileSync(out, JSON.stringify({ exported_at: new Date().toISOString().slice(0, 10), source_project: 'ylbwdadhbcjolwylidja', filter, count: questions.length, questions }, null, 1));
console.log(`wrote ${questions.length} to ${out}`);
process.exit(0);
