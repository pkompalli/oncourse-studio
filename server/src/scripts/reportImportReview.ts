/**
 * A side-by-side HTML report of an imported run, for a person to read: each item's live-bank original
 * beside its final version (stem, options with the key marked, explanation, image), what each review
 * stage found, what the fixer changed, the audit verdict, and — with --compare — how the same item
 * came out of an earlier run.
 *
 *   npx tsx src/scripts/reportImportReview.ts --detail backups/neetpg_export/pilot2_parts/part_01_detail.json \
 *     --source backups/neetpg_export/neetpg_10k_sample.json \
 *     --compare backups/neetpg_export/pilot_parts/part_01_detail.json --out backups/neetpg_export/pilot2_review.html
 *
 * --detail is exportReviewed.ts output; --source the live-bank export the items came from. Read-only.
 */
import { readFileSync, writeFileSync } from 'node:fs';

const arg = (n: string) => { const i = process.argv.indexOf(`--${n}`); return i >= 0 ? process.argv[i + 1] : undefined; };
const DETAIL = arg('detail'), SOURCE = arg('source'), COMPARE = arg('compare'), OUT = arg('out');
if (!DETAIL || !SOURCE || !OUT) throw new Error('--detail, --source and --out required');

type Row = Record<string, any>;
const items: Row[] = JSON.parse(readFileSync(DETAIL, 'utf8')).questions;
const src = new Map<string, Row>((JSON.parse(readFileSync(SOURCE, 'utf8')).questions as Row[]).map((q) => [q.id, q]));
const prev = COMPARE ? new Map<string, Row>((JSON.parse(readFileSync(COMPARE, 'utf8')).questions as Row[]).map((q) => [q.source_question_id, q])) : null;

const esc = (s: unknown) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const md = (s: unknown) => esc(s).replace(/\*\*\*(.+?)\*\*\*/g, '<b><i>$1</i></b>').replace(/\*\*(.+?)\*\*/g, '<b>$1</b>').replace(/\*(.+?)\*/g, '<i>$1</i>').replace(/\n/g, '<br>');
const L = 'ABCDEFGHIJ';
const band = (d: unknown) => (d === 'easy' || d === '1' ? 'easy' : ['hard', '3', '4', '5'].includes(String(d)) ? 'hard' : 'medium');

// The key moved when the final keyed option is not the live option that was keyed: exportReviewed.ts
// maps each final option to its live option id by text, so a reworded or reordered key is not a change.
const keyId = (opts: Row[]) => opts.find((o) => o.is_correct)?.source_option_id ?? null;

const stats = { n: items.length, approved: 0, flagged: 0, other: 0, stem: 0, expl: 0, optText: 0, optSet: 0, keyChanged: 0, imgReplaced: 0, imgRemoved: 0, untouched: 0, newVersion: 0 };
const vsPrev: Record<string, number> = {};
const reasons: Record<string, number> = {};

const cards = items.map((q, idx) => {
  const s = src.get(q.source_question_id) || {};
  const fin = q.question || {};
  const orig = q.original || { stem: s.question_text, explanation: s.explanation, options: (s.options || []).map((o: Row) => ({ text: o.text, is_correct: o.is_correct })) };
  const origImg = (s.assets || []).find((a: Row) => a.url)?.url || null;
  const finImg = fin.image_url || null;
  const imgReplaced = Boolean(origImg && finImg && origImg !== finImg);
  const imgRemoved = Boolean(origImg && !finImg);
  const origKeyId = (s.options || []).find((o: Row) => o.is_correct)?.id ?? null;
  const keyChanged = Boolean(origKeyId) && keyId(fin.options || []) !== origKeyId;
  const ch = q.changed || {};
  const optSet = (ch.options_added || 0) + (ch.options_removed || 0) > 0;
  stats[q.status === 'approved' ? 'approved' : q.status === 'flagged' ? 'flagged' : 'other']++;
  if (ch.stem) stats.stem++; if (ch.explanation) stats.expl++; if (ch.option_text) stats.optText++; if (optSet) stats.optSet++;
  if (keyChanged) stats.keyChanged++; if (imgReplaced) stats.imgReplaced++; if (imgRemoved) stats.imgRemoved++;
  if (q.requires_new_version) stats.newVersion++;
  if (!ch.stem && !ch.explanation && !ch.option_text && !optSet && !imgReplaced && !imgRemoved) stats.untouched++;
  const p = prev?.get(q.source_question_id);
  if (p) { const k = `${p.status} → ${q.status}`; vsPrev[k] = (vsPrev[k] || 0) + 1; }
  const audit = q.review?.audit || {};
  // Each flagged item counted once per kind of reason its audit gave.
  if (q.status !== 'approved') {
    const kinds = new Set(((audit.issues || []) as string[]).map((i) => /none of the above|all of the above|combined-answer|combination/i.test(i) ? 'none/all-of-the-above or combined option'
      : /SAME_CONCEPT|no longer tests/i.test(i) ? 'concept changed by the fix'
      : /\b(image|photograph|radiograph|figure|slide|MRI|CT)\b/i.test(i) ? 'image vs text'
      : /correct answer (is|should be)|keyed (answer|option) is (wrong|incorrect|not)|more than one|two .{0,20}(defensible|correct)|not a sound|supported answer|best answer/i.test(i) ? 'answer key / one best answer'
      : /homogene|parallel|categor|plausib|distractor|overlap/i.test(i) ? 'distractor quality'
      : /\bwords?\b|exceeds|too long|lengthy/i.test(i) ? 'stem length/style'
      : /NOT_APPLIED|NEVER APPLIED|applied_incorrectly/i.test(i) ? 'repair not applied'
      : 'other'));
    for (const r of kinds) reasons[r] = (reasons[r] || 0) + 1;
  }

  const optList = (opts: Row[]) => `<ol type="A">${(opts || []).map((o) => `<li class="${o.is_correct ? 'key' : ''}">${esc(o.text)}${o.is_correct ? ' ✔' : ''}</li>`).join('')}</ol>`;
  const findings = (label: string, r: Row | undefined) => r && ((r.findings || r.issues || []).length || r.score != null)
    ? `<div class="stage"><b>${label}</b>${r.score != null ? ` <span class="score">score ${r.score}</span>` : ''}${r.reason ? ` — ${esc(r.reason)}` : ''}<ul>${((r.findings || r.issues || []) as string[]).map((f) => `<li>${esc(f)}</li>`).join('')}</ul></div>` : '';
  const badges = [
    `<span class="b ${q.status}">${esc(q.status)}</span>`,
    keyChanged && '<span class="b warn">KEY CHANGED</span>',
    imgReplaced && '<span class="b warn">IMAGE REPLACED (AI)</span>',
    imgRemoved && '<span class="b warn">IMAGE REMOVED</span>',
    optSet && '<span class="b warn">OPTIONS ADDED/REMOVED</span>',
    ch.option_text && '<span class="b">option wording</span>',
    ch.stem && `<span class="b">stem edited (overlap ${ch.stem_overlap})</span>`,
    ch.explanation && '<span class="b">explanation edited</span>',
    p && `<span class="b prev">pilot 1: ${esc(p.status)}</span>`,
  ].filter(Boolean).join(' ');
  return `<section id="q${idx + 1}" data-status="${esc(q.status)}" data-key="${keyChanged}" data-img="${imgReplaced || imgRemoved}">
<h3>#${idx + 1} · ${esc(q.subject)} / ${esc(q.topic)} · ${band(s.difficulty)}${origImg ? ' · image' : ''} <small>live id ${esc(q.source_question_id)}</small></h3>
<div>${badges}</div>
<div class="cols">
 <div class="col"><h4>Original (live bank)</h4><p>${md(orig.stem)}</p>${origImg ? `<img src="${esc(origImg)}" loading="lazy">` : ''}${optList(orig.options)}<details><summary>explanation</summary>${md(orig.explanation)}</details></div>
 <div class="col"><h4>Final</h4><p>${md(fin.stem)}</p>${finImg ? `<img src="${esc(finImg)}" loading="lazy">` : ''}${optList(fin.options)}<details><summary>explanation</summary>${md(fin.explanation)}</details></div>
</div>
<details class="rev"><summary>review trail</summary>${findings('Validator', q.review?.validator)}${findings('Adversarial', q.review?.adversarial)}${findings('Audit', audit)}
${q.answer_adjudication ? `<div class="stage"><b>Answer adjudication</b><pre>${esc(JSON.stringify(q.answer_adjudication, null, 1))}</pre></div>` : ''}
${(q.change_notes || []).length ? `<div class="stage"><b>Change notes</b><ul>${q.change_notes.map((x: string) => `<li>${esc(x)}</li>`).join('')}</ul></div>` : ''}
${(q.unresolved || []).length ? `<div class="stage"><b>Unresolved</b><ul>${q.unresolved.map((x: string) => `<li>${esc(x)}</li>`).join('')}</ul></div>` : ''}</details>
</section>`;
});

const pct = (x: number) => `${x} (${((100 * x) / stats.n).toFixed(0)}%)`;
const html = `<!doctype html><meta charset="utf-8"><title>Import review — ${esc(DETAIL)}</title>
<style>body{font:14px/1.45 system-ui,sans-serif;margin:24px;max-width:1500px}section{border-top:2px solid #ddd;padding:12px 0}
.cols{display:grid;grid-template-columns:1fr 1fr;gap:20px}.col{background:#fafafa;padding:10px;border-radius:6px}
img{max-width:100%;max-height:320px;display:block;margin:6px 0}li.key{font-weight:600;color:#0a6b2d}
.b{display:inline-block;padding:1px 7px;margin:2px;border-radius:10px;background:#eee;font-size:12px}.b.approved{background:#d6f5df}.b.flagged{background:#fde2c8}
.b.warn{background:#ffd5d5}.b.prev{background:#e3e8ff}.stage{margin:6px 0}.score{color:#555}table{border-collapse:collapse}td,th{border:1px solid #ccc;padding:3px 8px}
small{color:#888;font-weight:normal}.filters a{margin-right:12px}</style>
<h1>Import review</h1>
<table><tr><th>items</th><td>${stats.n}</td><th>approved</th><td>${pct(stats.approved)}</td><th>flagged</th><td>${pct(stats.flagged)}</td></tr>
<tr><th>untouched</th><td>${pct(stats.untouched)}</td><th>stem edited</th><td>${pct(stats.stem)}</td><th>explanation edited</th><td>${pct(stats.expl)}</td></tr>
<tr><th>option wording</th><td>${pct(stats.optText)}</td><th>options added/removed</th><td>${pct(stats.optSet)}</td><th>key changed</th><td>${pct(stats.keyChanged)}</td></tr>
<tr><th>image replaced by AI</th><td>${pct(stats.imgReplaced)}</td><th>image removed</th><td>${pct(stats.imgRemoved)}</td><th>needs new version in prod</th><td>${pct(stats.newVersion)}</td></tr></table>
${prev ? `<h3>Against the earlier run</h3><table>${Object.entries(vsPrev).sort().map(([k, v]) => `<tr><td>${esc(k)}</td><td>${v}</td></tr>`).join('')}</table>` : ''}
<h3>Why the flagged items are flagged (items per kind of audit issue; an item can have several)</h3><table>${Object.entries(reasons).sort((a, b) => b[1] - a[1]).map(([k, v]) => `<tr><td>${esc(k)}</td><td>${v}</td></tr>`).join('')}</table>
<p class="filters">Show: <a href="#" onclick="f('all')">all</a><a href="#" onclick="f('flagged')">flagged</a><a href="#" onclick="f('key')">key changed</a><a href="#" onclick="f('img')">image replaced/removed</a></p>
<script>function f(k){document.querySelectorAll('section').forEach(s=>{s.style.display=k==='all'||(k==='flagged'&&s.dataset.status==='flagged')||(k==='key'&&s.dataset.key==='true')||(k==='img'&&s.dataset.img==='true')?'':'none'});return false}</script>
${cards.join('\n')}`;
writeFileSync(OUT, html);
console.log(JSON.stringify({ ...stats, vsPrev, reasons }));
console.log(`→ ${OUT}`);
