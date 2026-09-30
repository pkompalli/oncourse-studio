/**
 * Upload a deterministically rendered chart and attach it to its question.
 *
 * The image model produced a growth chart whose weight points sat below their labels, which makes
 * the figure unreadable for a question decided by which percentiles the weight line crosses. The
 * specification was not at fault — it named every vertex — and a diffusion model does not plot
 * coordinates, which is the same reason a vertex-by-vertex rhythm strip came back as a regular
 * narrow-QRS trace.
 *
 * renderGrowthChart.py draws it from the data instead, so markers and labels cannot drift apart.
 * This uploads that PNG to the same bucket and path convention the generated images use, so
 * nothing downstream needs to know the difference, and records in image_source that the figure was
 * plotted rather than generated.
 *
 * The question returns to 'generated' so review and audit score it again — the auditor reads the
 * image, and this one should now survive that reading.
 *
 * Dry run by default. Pass --apply.
 */
import 'dotenv/config';
import { readFileSync } from 'node:fs';
import crypto from 'node:crypto';
import { supabase } from '../db/supabase.js';
import { fetchAllRows } from '../db/pagination.js';

const APPLY = process.argv.includes('--apply');
const JOB = '5071eac0-7ac1-4e61-ad22-62dc1b95c85a';
const PREFIX = '8c769afd';                    // NCLEX growth-trend question
const FILE = process.env.CHART || '/tmp/qfix3/growth.png';

const rows = await fetchAllRows<any>((f, t) =>
  supabase.from('qb_questions')
    .select('id,topic,status,image_type,image_url,image_source,is_image_question')
    .eq('job_id', JOB).range(f, t));
const row = rows.find((r: any) => String(r.id).startsWith(PREFIX));
if (!row) { console.log(`no question starting ${PREFIX}`); process.exit(1); }

const bytes = readFileSync(FILE);
const hash = crypto.createHash('md5').update(bytes).digest('hex').slice(0, 12);
const path = `questions/${JOB}/${row.id}_${hash}.png`;

console.log(`question: ${row.id}  ${row.topic}`);
console.log(`status=${row.status}  isImageQ=${row.is_image_question}`);
console.log(`current image_source: ${row.image_source ?? '(none)'}`);
console.log(`current url: ${String(row.image_url).slice(0, 88)}`);
console.log(`\nuploading ${FILE} (${bytes.length} bytes) -> ${path}`);

if (!APPLY) { console.log('\nDRY RUN — re-run with --apply.'); process.exit(0); }

const { error: upErr } = await supabase.storage
  .from('question-images')
  .upload(path, bytes, { contentType: 'image/png', upsert: true });
if (upErr) { console.log(`upload FAILED: ${upErr.message}`); process.exit(1); }

const { data: urlData } = supabase.storage.from('question-images').getPublicUrl(path);
const publicUrl = urlData?.publicUrl;
if (!publicUrl) { console.log('no public URL returned'); process.exit(1); }

const { error } = await supabase.from('qb_questions').update({
  image_url: publicUrl,
  image_source: 'Plotted from the figure specification (renderGrowthChart.py), not image-generated',
  // Back for scoring: the auditor reads the image, and the previous one is what it should have
  // caught. This is the check that matters, so let it run.
  status: row.status === 'approved' ? 'generated' : row.status,
}).eq('id', row.id);

console.log(error ? `update FAILED: ${error.message}` : `written\nnew url: ${publicUrl}`);
