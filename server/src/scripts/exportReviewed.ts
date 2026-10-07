/**
 * Export reviewed questions from imported jobs, traceable to the live bank they came from.
 *
 * Every row leads with `source_question_id`, the id of the question in the live bank, and every
 * option carries the `source_option_id` of the live option it came from, matched by text (an option
 * may have moved, or been reworded). An option with no match is new; a row with any new or removed
 * option, or a changed key, is marked `requires_new_version`: recorded answers cannot carry over.
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
import { optionIdentity, OPTION_IDENTITY_MIN } from '../services/review/fixer.js';

const jobIds = process.argv.slice(2).filter((a) => /^[0-9a-f-]{36}$/.test(a));
const oi = process.argv.indexOf('--out');
const OUT = oi >= 0 ? process.argv[oi + 1] : 'backups/usmle_export/reviewed';
const SOURCE = 'backups/usmle_export/usmle_questions_post_2025-01-31.json';
if (!jobIds.length) { console.log('usage: exportReviewed.ts <jobId> [<jobId> …] --out <path-without-extension>'); process.exit(1); }

type Row = Record<string, any>;
const src = new Map((JSON.parse(readFileSync(SOURCE, 'utf8')).questions as Row[]).map((q) => [q.id, q]));
const words = (s: string) => new Set((s || '').toLowerCase().match(/[a-z0-9]+/g) || []);
const overlap = (a: string, b: string) => { const A = words(a), B = words(b); const i = [...A].filter((w) => B.has(w)).length; return A.size + B.size - i ? +(i / (A.size + B.size - i)).toFixed(2) : 1; };

/** Each final option's live option id: best text matches first, each live option used once. */
function matchToSource(original: Row[], finals: string[]): Array<string | null> {
  const pairs: Array<{ f: number; o: number; s: number }> = [];
  finals.forEach((t, f) => original.forEach((x, o) => pairs.push({ f, o, s: t.trim() === String(x.text).trim() ? 2 : optionIdentity(String(x.text), t) })));
  pairs.sort((a, b) => b.s - a.s);
  const out: Array<string | null> = finals.map(() => null);
  const usedF = new Set<number>(), usedO = new Set<number>();
  for (const p of pairs) {
    if (p.s < OPTION_IDENTITY_MIN || usedF.has(p.f) || usedO.has(p.o)) continue;
    out[p.f] = original[p.o].id; usedF.add(p.f); usedO.add(p.o);
  }
  return out;
}

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
  const origOptions = (s?.options || []) as Row[];
  // Each final option is matched to the live option it came from by TEXT — options may have been
  // reordered (keyBalance.ts) or, in restructure mode, reworded, replaced or added. A match keeps the
  // live option id, so recorded answers stay attached wherever the option now sits; an option with no
  // match is new, and its item has to be released as a new version.
  const ids = matchToSource(origOptions, letters.map((L) => String(q.options[L])));
  const options = letters.map((L, i) => ({ source_option_id: ids[i], letter: L, text: q.options[L], is_correct: L === q.correct_option }));
  const origKeyId = origOptions.find((o) => o.is_correct)?.id ?? null;
  const newKeyId = options.find((o) => o.is_correct)?.source_option_id ?? null;
  const stemChanged = s ? q.question !== s.question_text : false;
  const stemOverlap = s ? overlap(s.question_text, q.question) : 1;
  const keyMoved = Boolean(s) && origKeyId !== newKeyId;
  const newOptions = options.filter((o) => !o.source_option_id).length;
  const droppedOptions = origOptions.filter((o) => !ids.includes(o.id)).length;
  const optionTextChanged = options.some((o) => o.source_option_id && o.text !== origOptions.find((x) => x.id === o.source_option_id)?.text);
  const orderChanged = options.some((o, i) => o.source_option_id && origOptions[i]?.id !== o.source_option_id);
  const requiresNewVersion = newOptions > 0 || droppedOptions > 0 || keyMoved;
  const blindDisagreed = (a?.changes || []).some((c: string) => /^ANSWER KEY — key [A-J], attempt [A-J]/.test(c));

  const clinician: string[] = [];
  if (keyMoved) clinician.push(`Keyed answer changed from "${origOptions.find((o) => o.is_correct)?.text ?? ''}" to "${options.find((o) => o.is_correct)?.text ?? ''}"`);
  if (stemChanged && stemOverlap < 0.5) clinician.push(`Stem rewritten (word overlap ${stemOverlap} with the original)`);
  if (blindDisagreed && !keyMoved) clinician.push('An independent blind solve chose a different answer; the key was kept');
  if (newOptions || droppedOptions) clinician.push(`Options changed: ${newOptions} new, ${droppedOptions} removed — release as a new version`);

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
      option_text: optionTextChanged, option_order: orderChanged, options_added: newOptions, options_removed: droppedOptions, key_moved: keyMoved,
      image: Boolean(s && q.image_url !== ((s.assets || []).find((x: Row) => x.url)?.url ?? null)),
    },
    requires_new_version: requiresNewVersion,
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
const header = ['source_question_id', 'step', 'subject', 'topic', 'status', 'exam_tags', 'audit_score', 'stem_changed', 'explanation_changed', 'key_moved', 'requires_new_version', 'needs_clinician_review', 'audit_reason', 'studio_question_id'];
const lines = [header.join(','), ...out.map((r) => [
  r.source_question_id, r.step, r.subject, r.topic, r.status, r.exam_tags.join('; '), r.scores.audit,
  r.changed.stem, r.changed.explanation, r.changed.key_moved, r.requires_new_version, r.needs_clinician_review.join(' | '), r.review.audit?.reason ?? '', r.studio_question_id,
].map(csvCell).join(','))];
writeFileSync(`${OUT}.csv`, lines.join('\n'));

const n = (f: (r: Row) => boolean) => out.filter(f).length;
console.log(JSON.stringify({
  exported: out.length, with_source_id: n((r) => Boolean(r.source_question_id)),
  status: out.reduce((m: Row, r) => { m[r.status] = (m[r.status] || 0) + 1; return m; }, {}),
  tagged_other_exam: n((r) => Boolean(r.belongs_to_exam)), needs_clinician_review: n((r) => r.needs_clinician_review.length > 0),
  requires_new_version: n((r) => r.requires_new_version), five_options: n((r) => r.question.options.length === 5),
}));
console.log(`→ ${OUT}.json, ${OUT}.csv`);
