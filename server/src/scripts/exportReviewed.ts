/**
 * Export reviewed questions from imported jobs, traceable to the live bank they came from.
 *
 * Every row leads with `source_question_id`, the id of the question in the live bank, and every
 * option carries its `source_option_id`. Imported items are reviewed with their option count and
 * order locked (fixer.ts, existing-bank mode), so letter → live option id is exact; a row where it
 * is not is marked `option_ids_unmapped` rather than guessed.
 *
 * Writes <out>.json (everything, original beside final) and <out>.csv (one row per question for a
 * spreadsheet). Read-only on the database.
 *
 *   npx tsx src/scripts/exportReviewed.ts <jobId> [<jobId> …] --out backups/usmle_export/reviewed
 */
import 'dotenv/config';
import { readFileSync, writeFileSync } from 'node:fs';
import { supabase } from '../db/supabase.js';
import { fetchAllRows } from '../db/pagination.js';

const jobIds = process.argv.slice(2).filter((a) => /^[0-9a-f-]{36}$/.test(a));
const oi = process.argv.indexOf('--out');
const OUT = oi >= 0 ? process.argv[oi + 1] : 'backups/usmle_export/reviewed';
const SOURCE = 'backups/usmle_export/usmle_questions_post_2025-01-31.json';
if (!jobIds.length) { console.log('usage: exportReviewed.ts <jobId> [<jobId> …] --out <path-without-extension>'); process.exit(1); }

type Row = Record<string, any>;
const src = new Map((JSON.parse(readFileSync(SOURCE, 'utf8')).questions as Row[]).map((q) => [q.id, q]));
const words = (s: string) => new Set((s || '').toLowerCase().match(/[a-z0-9]+/g) || []);
const overlap = (a: string, b: string) => { const A = words(a), B = words(b); const i = [...A].filter((w) => B.has(w)).length; return A.size + B.size - i ? +(i / (A.size + B.size - i)).toFixed(2) : 1; };

const rows: Row[] = [];
for (const jobId of jobIds) {
  rows.push(...await fetchAllRows<Row>((from, to) => supabase.from('qb_questions').select('*')
    .eq('job_id', jobId).is('replaced_by_id', null).order('question_number').range(from, to)));
}

const out = rows.map((q) => {
  const tags = (q.tags || {}) as Row;
  const s = src.get(tags.source_question_id);
  const trail = (q.audit_trail || []) as Row[];
  const last = (phase: string) => trail.filter((e) => e.phase === phase).pop();
  const v = last('validator'), a = last('adversarial'), au = last('audit');
  const letters = Object.keys(q.options || {}).sort();
  const ids = (tags.source_option_ids || {}) as Record<string, string>;
  const mapped = s ? letters.length === (s.options || []).length : false;
  const options = letters.map((L) => ({ source_option_id: mapped ? ids[L] ?? null : null, letter: L, text: q.options[L], is_correct: L === q.correct_option }));
  const origOptions = (s?.options || []) as Row[];
  const origKeyId = origOptions.find((o) => o.is_correct)?.id ?? null;
  const newKeyId = options.find((o) => o.is_correct)?.source_option_id ?? null;
  const stemChanged = s ? q.question !== s.question_text : false;
  const stemOverlap = s ? overlap(s.question_text, q.question) : 1;
  const keyMoved = mapped && origKeyId !== newKeyId;
  const optionTextChanged = mapped && options.some((o, i) => o.text !== origOptions[i]?.text);
  const blindDisagreed = (a?.changes || []).some((c: string) => /^ANSWER KEY — key [A-J], attempt [A-J]/.test(c));

  const clinician: string[] = [];
  if (keyMoved) clinician.push(`Keyed answer changed from "${origOptions.find((o) => o.is_correct)?.text ?? ''}" to "${options.find((o) => o.is_correct)?.text ?? ''}"`);
  if (stemChanged && stemOverlap < 0.5) clinician.push(`Stem rewritten (word overlap ${stemOverlap} with the original)`);
  if (blindDisagreed && !keyMoved) clinician.push('An independent blind solve chose a different answer; the key was kept');
  if (!mapped) clinician.push('Option count differs from the original; option ids could not be mapped');

  return {
    source_question_id: tags.source_question_id ?? null,
    studio_question_id: q.id,
    step: tags.step ?? null,
    subject: q.subject, topic: q.topic,
    status: q.status,
    exam_tags: tags.exam_tags ?? [],
    belongs_to_exam: tags.belongs_to_exam ?? null,
    out_of_scope_reason: tags.out_of_scope_reason ?? null,
    scores: { validator: q.validator_score, adversarial: q.adversarial_score, audit: q.quality_score },
    changed: {
      stem: stemChanged, stem_overlap: stemOverlap,
      explanation: s ? q.explanation !== (s.explanation || '') : false,
      option_text: optionTextChanged, key_moved: keyMoved,
      image: Boolean(s && q.image_url !== ((s.assets || []).find((x: Row) => x.url)?.url ?? null)),
    },
    option_ids_unmapped: !mapped,
    needs_clinician_review: clinician,
    question: { stem: q.question, explanation: q.explanation, options, image_url: q.image_url },
    original: s ? { stem: s.question_text, explanation: s.explanation, options: origOptions.map((o) => ({ source_option_id: o.id, text: o.text, is_correct: o.is_correct })) } : null,
    review: {
      validator: v ? { score: v.score, findings: v.changes || [], label_feedback: v.label_feedback || [], held_for_image: v.held_for_image || [] } : null,
      adversarial: a ? { score: a.score, findings: a.changes || [], label_feedback: a.label_feedback || [], held_for_image: a.held_for_image || [] } : null,
      repairs: trail.filter((e) => /_fix(_failed)?$/.test(e.phase)).map((e) => ({ phase: e.phase, requested: e.changes_requested || [], changed_fields: e.changed_fields || [], error: e.error || null })),
      audit: au ? { score: au.score, reason: au.reason, issues: au.issues || [] } : null,
    },
  };
});

writeFileSync(`${OUT}.json`, JSON.stringify({ exported_at: new Date().toISOString(), jobs: jobIds, count: out.length, questions: out }, null, 1));

const csvCell = (v: unknown) => { const t = v == null ? '' : String(v); return /[",\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t; };
const header = ['source_question_id', 'step', 'subject', 'topic', 'status', 'exam_tags', 'audit_score', 'stem_changed', 'explanation_changed', 'key_moved', 'needs_clinician_review', 'audit_reason', 'studio_question_id'];
const lines = [header.join(','), ...out.map((r) => [
  r.source_question_id, r.step, r.subject, r.topic, r.status, r.exam_tags.join('; '), r.scores.audit,
  r.changed.stem, r.changed.explanation, r.changed.key_moved, r.needs_clinician_review.join(' | '), r.review.audit?.reason ?? '', r.studio_question_id,
].map(csvCell).join(','))];
writeFileSync(`${OUT}.csv`, lines.join('\n'));

const n = (f: (r: Row) => boolean) => out.filter(f).length;
console.log(JSON.stringify({
  exported: out.length, with_source_id: n((r) => Boolean(r.source_question_id)),
  status: out.reduce((m: Row, r) => { m[r.status] = (m[r.status] || 0) + 1; return m; }, {}),
  tagged_other_exam: n((r) => Boolean(r.belongs_to_exam)), needs_clinician_review: n((r) => r.needs_clinician_review.length > 0),
  option_ids_unmapped: n((r) => r.option_ids_unmapped),
}));
console.log(`→ ${OUT}.json, ${OUT}.csv`);
