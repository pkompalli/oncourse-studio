/**
 * How often does AI image generation produce a usable image for an exam item? Measured, not assumed.
 *
 * Takes a stratified sample of live-bank image items (by kind of image, in the proportions the export
 * has them), writes each a specification from the question (imageSpec.ts), draws it and checks it
 * blind (drawCheckedImage), and reports the first-attempt and final pass rates by kind. Every image and
 * its verdict is saved, so the check itself can be audited by eye.
 *
 *   npx tsx src/scripts/benchmarkImageGen.ts --in backups/neetpg_export/neetpg_10k_sample.json --n 40 --out backups/image_bench/run1
 *   npx tsx src/scripts/benchmarkImageGen.ts --studio "<courseId>:16,<courseId>:6" --out backups/image_bench/generated1
 *     [--kinds "labelled,radiology"] [--seed s] [--pool 3]
 *
 * Resumable: rerun with the same --out and items that already have a verdict are kept; an item that was
 * drawn but whose check the proxy dropped is checked again on its saved image, not redrawn.
 *
 * Writes nothing to the database. Images go to <out>/<n>_<kind>_a<attempt>.png, results to <out>/results.json.
 */
import 'dotenv/config';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import crypto from 'node:crypto';
import { specifyImage, applySpec } from '../services/images/imageSpec.js';
import { drawCheckedImage } from '../services/images/imageGeneration.js';
import { checkImageVoted } from '../services/images/imageCheck.js';
import { supabase } from '../db/supabase.js';

const arg = (n: string) => { const i = process.argv.indexOf(`--${n}`); return i >= 0 ? process.argv[i + 1] : undefined; };
const IN = arg('in')!, STUDIO = arg('studio'), OUT = arg('out')!, N = Number(arg('n') || 40), POOL = Number(arg('pool') || 3), SEED = arg('seed') || 'imgbench';
const ONLY = arg('kinds')?.split(',');
if ((!IN && !STUDIO) || !OUT) throw new Error('--in (or --studio) and --out required');
mkdirSync(OUT, { recursive: true });

type Row = Record<string, any>;
export function kindOf(q: Row): string {
  const t = `${q.question_text} ${q.assets?.[0]?.description || ''}`.toLowerCase();
  if (/\b(marked|arrow|labell?ed|label|structure [a-z]\b|\bx\b|\by\b|identify the (structure|muscle|nerve|bone|part))/.test(t) && /diagram|illustrat|specimen|anatom|bone|muscle|nerve|structure|section|marked|arrow/.test(t)) return 'labelled';
  if (/x-?ray|radiograph|\bct\b|\bmri\b|ultraso|usg|mammo|angiogra|barium|ivp|hsg|scan/.test(t)) return 'radiology';
  if (/\becg\b|ekg|tracing/.test(t)) return 'ecg';
  if (/histo|h&e|slide|smear|biopsy|microscop|stain|cells/.test(t)) return 'histology';
  if (/fundus|slit|retina|cornea|\beye\b/.test(t)) return 'eye';
  if (/skin|lesion|rash|derma|nail|hair|photograph|patient|child|face|clinical/.test(t)) return 'clinical-photo';
  if (/graph|chart|curve|table|plot|flow/.test(t)) return 'chart';
  if (/instrument|device|equipment|forceps|tube|needle|catheter/.test(t)) return 'instrument';
  return 'other';
}

const L = 'ABCDEFGHIJ';
const h = (s: string) => crypto.createHash('md5').update(SEED + s).digest('hex');
// One shape for both sources: the row the image is drawn for, and whether a specification is written
// first (imported items) or the item's own generated one is used (--studio, as production's first draw).
interface Item { id: string; kind: string; stem: string; key: string; live_image: string | null; row: Row; useSpec: boolean }
const sample: Item[] = [];
if (STUDIO) {
  // --studio "courseId:n,courseId:n": generated items with an AI image, drawn from their own specification.
  for (const part of STUDIO.split(',')) {
    const [course, n] = part.split(':');
    const { data, error } = await supabase.from('qb_questions').select('*').eq('course_id', course).eq('is_image_question', true)
      .not('image_description', 'is', null).like('image_source', 'AI Generated%').is('replaced_by_id', null);
    if (error) throw new Error(error.message);
    const picked = [...data!].sort((a, b) => h(a.id).localeCompare(h(b.id))).slice(0, Number(n) || 10);
    for (const q of picked) sample.push({
      id: q.id, kind: `${String(q.course).split(' ')[0]}:${kindOf({ question_text: q.question, assets: [{ description: `${q.image_type} ${q.image_description}` }] })}`,
      stem: q.question, key: q.options?.[q.correct_option], live_image: q.image_url,
      row: { id: q.id, question: q.question, options: q.options, correct_option: q.correct_option, explanation: q.explanation, course: q.course, image_type: q.image_type, image_description: q.image_description, image_search_terms: q.image_search_terms, content: q.content },
      useSpec: false,
    });
  }
} else {
  const all = (JSON.parse(readFileSync(IN, 'utf8')).questions as Row[]).filter((q) => q.assets?.some((a: Row) => a.url) && (q.options || []).some((o: Row) => o.is_correct));
  const byKind = new Map<string, Row[]>();
  for (const q of all) { const k = kindOf(q); if (!ONLY || ONLY.includes(k)) (byKind.get(k) ?? byKind.set(k, []).get(k)!).push(q); }
  const total = [...byKind.values()].reduce((a, x) => a + x.length, 0);
  for (const [kind, qs] of byKind) {
    const take = Math.max(2, Math.round((N * qs.length) / total));
    for (const q of [...qs].sort((a, b) => h(a.id).localeCompare(h(b.id))).slice(0, take)) {
      const opts = Object.fromEntries((q.options as Row[]).map((o, j) => [L[j], o.text]));
      const key = L[(q.options as Row[]).findIndex((o) => o.is_correct)];
      sample.push({ id: q.id, kind, stem: q.question_text, key: opts[key], live_image: q.assets[0].url,
        row: { id: q.id, question: q.question_text, options: opts, correct_option: key, explanation: q.explanation, course: 'NEET PG', image_description: q.assets[0].description || '' }, useSpec: true });
    }
  }
}
const kinds = [...new Set(sample.map((s) => s.kind))];
console.log(`sample ${sample.length}: ${kinds.map((k) => `${k} ${sample.filter((s) => s.kind === k).length}`).join(', ')}`);

const prior: Row[] = existsSync(`${OUT}/results.json`) ? JSON.parse(readFileSync(`${OUT}/results.json`, 'utf8')) : [];
// --recheck-all: judge every saved image again with the current checker (no redraws), so a run's numbers
// come from one version of imageCheck.ts.
const RECHECK_ALL = process.argv.includes('--recheck-all');
const results: Row[] = RECHECK_ALL ? [] : prior.filter((r) => r.pass !== null && r.pass !== undefined);
const done = new Set(RECHECK_ALL ? prior.filter((r) => !r.file).map((r) => r.i) : results.map((r) => r.i));
const recheck = new Map(prior.filter((r) => (RECHECK_ALL || r.pass === null || r.pass === undefined) && r.file && existsSync(r.file)).map((r) => [r.i, r]));
if (prior.length) console.log(`resuming: ${results.length} with a verdict kept, ${recheck.size} to re-check on their saved image`);
const work = async (i: number) => {
  const { id, kind, stem, key, live_image, row: base, useSpec } = sample[i];
  const row: Row = { ...base, question_number: i + 1 };
  const t0 = Date.now();
  const old = recheck.get(i + 1);
  if (old) {
    let c = null;
    for (let t = 1; t <= 3 && !c; t++) c = await checkImageVoted(old.spec ? applySpec(row, old.spec) : row, readFileSync(old.file)).catch(() => null);
    results.push({ ...old, pass: c?.pass ?? null, first_pass: c ? old.attempts === 1 && c.pass : null, votes: c?.votes, missing: c?.missing, read: c?.read?.slice(0, 1500), rechecked: true });
    console.log(`[${results.length}/${sample.length}] #${i + 1} ${kind}: ${!c ? 'UNCHECKED' : c.pass ? 'PASS' : 'FAIL'} (re-checked saved image)`);
    writeFileSync(`${OUT}/results.json`, JSON.stringify([...results, ...prior.filter((r) => !results.some((x) => x.i === r.i))], null, 1));
    return;
  }
  const spec = useSpec ? await specifyImage(row, { course: String(row.course) }) : null;
  if (useSpec && !spec) { results.push({ i: i + 1, kind, id, error: 'no spec' }); return; }
  const qq = spec ? applySpec(row, spec) : row;
  const d = await drawCheckedImage(qq, undefined, i + 1);
  const r = d.result;
  let file: string | null = null;
  if (r && !('safetyRefused' in r)) { file = `${OUT}/${String(i + 1).padStart(2, '0')}_${kind.replace(/[^a-z0-9-]+/gi, '_')}.png`; writeFileSync(file, r.imageBytes); }
  results.push({
    i: i + 1, kind, id, stem, key, live_image,
    spec, source: d.source ?? 'image model', ecg_spec: d.ecgSpec, votes: d.check?.votes, refused: Boolean(r && 'safetyRefused' in r), drawn: Boolean(file), file,
    attempts: d.attempts, pass: d.check?.pass ?? null, first_pass: d.check ? (d.attempts === 1 && d.check.pass) : null,
    missing: d.check?.missing, read: d.check?.read?.slice(0, 1500),
    history: d.history.map((c) => ({ pass: c.pass, votes: c.votes, missing: c.missing, read: c.read.slice(0, 1500) })), secs: Math.round((Date.now() - t0) / 1000),
  });
  console.log(`[${results.length}/${sample.length}] #${i + 1} ${kind}: ${!d.check ? (r && !('safetyRefused' in r) ? 'UNCHECKED' : 'NOT DRAWN') : d.check.pass ? 'PASS' : 'FAIL'} after ${d.attempts} (${Math.round((Date.now() - t0) / 1000)}s)${d.source ? ' [rendered]' : ''}`);
  writeFileSync(`${OUT}/results.json`, JSON.stringify(results, null, 1));
};
const queue = sample.map((_, i) => i).filter((i) => !done.has(i + 1));
await Promise.all(Array.from({ length: POOL }, async () => { for (let i = queue.shift(); i !== undefined; i = queue.shift()) await work(i); }));

// Rates are over the items the check could judge; an item whose check the proxy dropped is counted as
// unchecked, not as a failed image.
const tab: Record<string, { n: number; unchecked: number; first: number; final: number; drawn: number }> = {};
for (const r of results) {
  for (const k of [r.kind, 'ALL']) {
    tab[k] ??= { n: 0, unchecked: 0, first: 0, final: 0, drawn: 0 };
    if (r.drawn && r.pass === null) { tab[k].unchecked++; continue; }
    tab[k].n++; if (r.first_pass) tab[k].first++; if (r.pass) tab[k].final++; if (r.drawn) tab[k].drawn++;
  }
}
console.table(Object.fromEntries(Object.entries(tab).map(([k, v]) => [k, { ...v, first_pct: `${Math.round((100 * v.first) / (v.n || 1))}%`, final_pct: `${Math.round((100 * v.final) / (v.n || 1))}%` }])));
writeFileSync(`${OUT}/results.json`, JSON.stringify(results, null, 1));
process.exit(0);
