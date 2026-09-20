/**
 * Purge generated question images from the `question-images` bucket.
 *
 * The pg_cron retention purge (migration 004/005) deletes JOBS from the database
 * but cannot touch object storage, so every purged job leaves its images behind
 * forever. Those orphans are the main consumer of the storage quota — the project
 * hit `exceed_storage_size_quota` on exactly this.
 *
 * Images are namespaced by job:  questions/<job_id>/<question_id>_<hash>.<ext>
 * so a job's images are a clean prefix delete.
 *
 * Deletes a job folder when the job is either:
 *   • ORPHANED — no qb_jobs row (already purged by cron or deleted), or
 *   • OLDER than the retention window (default 10 days)
 *
 * A second pass then removes SUPERSEDED files inside the job folders it kept. The
 * path carries an md5 of the image bytes, so regenerating an image writes a new
 * file and strands the old one; a live job slowly fills with charts no question
 * references. Pass 1 cannot see those — its unit is the whole folder, and the job
 * is current.
 *
 * NEVER delete these by removing rows from storage.objects: that drops only the
 * metadata and leaves the actual file in S3, reclaiming nothing.
 *
 * Usage:
 *   npx tsx src/scripts/purgeOldImages.ts            # dry run, 10 days
 *   npx tsx src/scripts/purgeOldImages.ts --apply    # actually delete
 *   npx tsx src/scripts/purgeOldImages.ts --days=30 --apply
 */
import 'dotenv/config';
import { supabase } from '../db/supabase.js';

const BUCKET = 'question-images';
const ROOT = 'questions';

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const DAYS = Number((args.find((a) => a.startsWith('--days=')) || '--days=10').split('=')[1]) || 10;

async function listAll(prefix: string): Promise<{ name: string; size: number }[]> {
  const out: { name: string; size: number }[] = [];
  for (let page = 0; page < 200; page++) {
    const { data, error } = await supabase.storage.from(BUCKET).list(prefix, { limit: 100, offset: page * 100 });
    if (error) { console.warn(`  list(${prefix}) failed: ${error.message}`); break; }
    if (!data || data.length === 0) break;
    for (const f of data) out.push({ name: f.name, size: Number((f.metadata as Record<string, unknown> | null)?.size ?? 0) });
    if (data.length < 100) break;
  }
  return out;
}

const mb = (b: number) => `${(b / 1e6).toFixed(1)}MB`;

async function main() {
  const cutoff = new Date(Date.now() - DAYS * 86400_000);
  console.log(`${APPLY ? 'PURGING' : 'DRY RUN'} — retention ${DAYS} days (cutoff ${cutoff.toISOString().slice(0, 10)})\n`);

  const folders = await listAll(ROOT);
  if (folders.length === 0) { console.log('no job folders found'); return; }

  const { data: jobs } = await supabase.from('qb_jobs').select('id,created_at');
  const jobById = new Map((jobs || []).map((j) => [j.id as string, j.created_at as string]));

  let keptBytes = 0, freedBytes = 0, freedFiles = 0, freedFolders = 0;
  const retained: Array<{ jobId: string; files: Array<{ name: string; size: number }> }> = [];
  for (const folder of folders) {
    const jobId = folder.name;
    const files = await listAll(`${ROOT}/${jobId}`);
    const bytes = files.reduce((s, f) => s + f.size, 0);
    const created = jobById.get(jobId);
    const reason = !created ? 'ORPHANED (no job row)'
      : new Date(created) < cutoff ? `older than ${DAYS}d (${created.slice(0, 10)})`
      : null;

    if (!reason) { keptBytes += bytes; retained.push({ jobId, files }); continue; }
    console.log(`  ${jobId.slice(0, 8)}  ${String(files.length).padStart(4)} files  ${mb(bytes).padStart(8)}  ${reason}`);
    freedBytes += bytes; freedFiles += files.length; freedFolders++;

    if (APPLY && files.length > 0) {
      for (let i = 0; i < files.length; i += 100) {
        const paths = files.slice(i, i + 100).map((f) => `${ROOT}/${jobId}/${f.name}`);
        const { error } = await supabase.storage.from(BUCKET).remove(paths);
        if (error) { console.warn(`    remove failed: ${error.message}`); break; }
      }
    }
  }

  console.log(`\n${APPLY ? 'freed' : 'would free'}: ${freedFolders} job folder(s), ${freedFiles} file(s), ${mb(freedBytes)}`);
  console.log(`retained: ${mb(keptBytes)}`);

  // ── Pass 2: superseded files inside LIVE job folders ────────────────────────
  // The storage path carries an md5 of the image bytes, so regenerating an image
  // writes a NEW file and leaves the old one behind — a live job accumulates dead
  // charts no question references. Pass 1 cannot see these: its unit is the whole
  // job folder, and the job is current.
  let supBytes = 0, supFiles = 0;
  for (const { jobId, files } of retained) {
    const referenced = new Set<string>();
    let rows = 0;
    for (let off = 0; ; off += 1000) {
      const { data, error } = await supabase.from('qb_questions')
        .select('image_url').eq('job_id', jobId).order('id').range(off, off + 999);
      if (error) { console.warn(`  ${jobId.slice(0, 8)}: question fetch failed (${error.message}) — SKIPPING folder`); rows = -1; break; }
      if (!data || data.length === 0) break;
      rows += data.length;
      for (const r of data as Array<{ image_url: string | null }>) {
        if (r.image_url) referenced.add(String(r.image_url).split('/').pop() as string);
      }
      if (data.length < 1000) break;
    }
    // A failed or empty read must never be read as "nothing is referenced" — that
    // would delete every live image in the folder.
    if (rows <= 0) { if (rows === 0) console.warn(`  ${jobId.slice(0, 8)}: no question rows — SKIPPING folder`); continue; }

    const dead = files.filter((f) => !referenced.has(f.name));
    if (dead.length === 0) continue;
    const bytes = dead.reduce((sum, f) => sum + f.size, 0);
    supBytes += bytes; supFiles += dead.length;
    console.log(`  ${jobId.slice(0, 8)}  ${String(dead.length).padStart(4)} superseded of ${files.length}  ${mb(bytes).padStart(8)}  (${rows} questions, ${referenced.size} referenced)`);

    if (APPLY) {
      for (let i = 0; i < dead.length; i += 100) {
        const paths = dead.slice(i, i + 100).map((f) => `${ROOT}/${jobId}/${f.name}`);
        const { error } = await supabase.storage.from(BUCKET).remove(paths);
        if (error) { console.warn(`    remove failed: ${error.message}`); break; }
      }
    }
  }
  console.log(`${APPLY ? 'freed' : 'would free'} (superseded in live jobs): ${supFiles} file(s), ${mb(supBytes)}`);

  if (!APPLY && freedFiles + supFiles > 0) console.log('\nre-run with --apply to delete');
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
