/**
 * Gather what review and audit did to each question in imported jobs, against the live original,
 * into one JSON file for a report: findings, what reached the fixer and what was only recorded,
 * what changed, and the audit verdict.
 *
 *   npx tsx src/scripts/reportPilot.ts <jobId> [<jobId> …] --out backups/usmle_export/pilot_report.json
 */
import 'dotenv/config';
import { readFileSync, writeFileSync } from 'node:fs';
import { supabase } from '../db/supabase.js';

const jobIds = process.argv.slice(2).filter((a) => /^[0-9a-f-]{36}$/.test(a));
const oi = process.argv.indexOf('--out');
const OUT = oi >= 0 ? process.argv[oi + 1] : 'backups/usmle_export/pilot_report.json';
const src = new Map((JSON.parse(readFileSync('backups/usmle_export/usmle_questions_post_2025-01-31.json', 'utf8')).questions as Array<Record<string, any>>).map((q) => [q.id, q]));

const words = (s: string) => new Set((s || '').toLowerCase().match(/[a-z0-9]+/g) || []);
const sim = (a: string, b: string) => { const A = words(a), B = words(b); const i = [...A].filter((w) => B.has(w)).length; return A.size + B.size - i ? +(i / (A.size + B.size - i)).toFixed(2) : 1; };

const { data: qs, error } = await supabase.from('qb_questions').select('*').in('job_id', jobIds).order('question_number');
if (error) throw new Error(error.message);

const out = qs!.map((q) => {
  const s = src.get(q.tags.source_question_id)!;
  const trail = (q.audit_trail || []) as Array<Record<string, any>>;
  const stage = (p: string) => trail.filter((e) => e.phase === p).pop();
  const v = stage('validator'), a = stage('adversarial'), au = stage('audit');
  const fixes = trail.filter((e) => /_fix$/.test(e.phase) || /_fix_failed$/.test(e.phase) || /_image_fix$/.test(e.phase));
  const origOpts = (s.options as any[]).map((o) => ({ text: o.text, is_correct: o.is_correct }));
  const letters = Object.keys(q.options).sort();
  const nowOpts = letters.map((k) => ({ text: q.options[k], is_correct: k === q.correct_option }));
  const origKey = origOpts.find((o) => o.is_correct)?.text ?? null;
  const nowKey = q.options[q.correct_option] ?? null;
  // A key moves when a different OPTION is keyed. Rewording the keyed option in place is not a
  // move; with options locked in count and order, position identifies the option.
  const origKeyIdx = origOpts.findIndex((o) => o.is_correct);
  const keyMoved = origOpts.length === letters.length ? letters.indexOf(q.correct_option) !== origKeyIdx : origKey !== nowKey;
  const origImg = (s.assets || []).find((x: any) => x.url)?.url ?? null;
  return {
    studio_id: q.id, source_id: s.id, step: q.tags.step, subject: q.subject, topic: q.topic,
    status: q.status, scores: { validator: q.validator_score, adversarial: q.adversarial_score, audit: q.quality_score },
    has_image: Boolean(origImg),
    original: { stem: s.question_text, explanation: s.explanation, options: origOpts, difficulty: s.difficulty, blooms: s.blooms_level, image_url: origImg },
    final: { stem: q.question, explanation: q.explanation, options: nowOpts, image_url: q.image_url },
    changed: {
      stem: q.question !== s.question_text, stem_similarity: sim(s.question_text, q.question),
      explanation: q.explanation !== (s.explanation || ''),
      options: JSON.stringify(origOpts.map((o) => o.text)) !== JSON.stringify(nowOpts.map((o) => o.text)),
      key_moved: keyMoved, key_reworded: !keyMoved && origKey !== nowKey, key_from: origKey, key_to: nowKey,
      image_regenerated: Boolean(q.image_url && q.image_url !== origImg),
    },
    validator: v ? { score: v.score, findings: v.changes || [], summary: v.summary, label: v.label_feedback || [], batch: v.batch_feedback_not_applied || [], held_for_image: v.held_for_image || [] } : null,
    adversarial: a ? { score: a.score, findings: a.changes || [], summary: a.summary, label: a.label_feedback || [], batch: a.batch_feedback_not_applied || [], held_for_image: a.held_for_image || [] } : null,
    fixes: fixes.map((e) => ({ phase: e.phase, requested: e.changes_requested || e.feedback || [], changed_fields: e.changed_fields || [], error: e.error || null, success: e.success ?? null })),
    audit: au ? { score: au.score, reason: au.reason, issues: au.issues || [] } : null,
  };
});
writeFileSync(OUT, JSON.stringify({ generated_at: new Date().toISOString(), jobs: jobIds, questions: out }, null, 1));
const n = (f: (x: typeof out[number]) => boolean) => out.filter(f).length;
console.log(JSON.stringify({
  questions: out.length,
  approved: n((x) => x.status === 'approved'), flagged: n((x) => x.status === 'flagged'),
  stem_changed: n((x) => x.changed.stem), stem_rewritten: n((x) => x.changed.stem && x.changed.stem_similarity < 0.5),
  explanation_changed: n((x) => x.changed.explanation), option_text_changed: n((x) => x.changed.options),
  key_moved: n((x) => x.changed.key_moved), image_regenerated: n((x) => x.changed.image_regenerated),
  untouched: n((x) => !x.changed.stem && !x.changed.explanation && !x.changed.options && !x.changed.image_regenerated),
  fix_failed: n((x) => x.fixes.some((f) => /_failed$/.test(f.phase))),
  with_label_feedback: n((x) => Boolean(x.validator?.label.length || x.adversarial?.label.length)),
  with_batch_notes: n((x) => Boolean(x.validator?.batch.length || x.adversarial?.batch.length)),
  held_for_image: n((x) => Boolean(x.validator?.held_for_image.length || x.adversarial?.held_for_image.length)),
}, null, 1));
console.log('→', OUT);
