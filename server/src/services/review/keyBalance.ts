/**
 * Balance answer positions across a whole bank.
 *
 * A reviewer sees ten items at a time and cannot balance letters across thousands; asked to, it
 * moved keys by rewriting content. Balance is a property of the bank, so it is set here, once, after
 * audit, by reordering each item's options — the content of every option is unchanged, only where it
 * sits. Targets come in shuffled blocks of five (each letter once per block, no letter twice in a row
 * across a block boundary), so every letter keys 20% of items and no run exceeds two.
 *
 * Numeric option sets ("Approximately 20 / 25 / 33 / 40 / 50 people") keep ascending order, as the
 * exam lists them, and keep their key where it falls. Items whose explanation cites option letters
 * are moved anyway and reported: the guidelines forbid letter references, and a reorder exposes them.
 *
 * Only for restructure-mode jobs (reviewMode.ts): reordering an item in use moves recorded answers.
 */
import { supabase } from '../../db/supabase.js';
import { fetchAllRows } from '../../db/pagination.js';

const LETTERS = 'ABCDE';
const NUMERIC = /^\s*[~≈<>≤≥]?\s*(approximately |about )?[-+]?\d/i;
const LETTER_REF = /\b(option|choice|answer)\s+[A-E]\b|\(\s*[A-E]\s*\)/i;

/** A small seeded PRNG, so a re-run on the same job gives the same plan. */
function prng(seed: string) {
  let h = 2166136261;
  for (const c of seed) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  return () => { h ^= h << 13; h ^= h >>> 17; h ^= h << 5; return ((h >>> 0) % 1_000_000) / 1_000_000; };
}

export function planPositions(n: number, seed: string): number[] {
  const rand = prng(seed);
  const out: number[] = [];
  while (out.length < n) {
    const block = [0, 1, 2, 3, 4];
    for (let i = 4; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [block[i], block[j]] = [block[j], block[i]]; }
    if (out.length && block[0] === out[out.length - 1]) block.push(block.shift()!);
    out.push(...block);
  }
  return out.slice(0, n);
}

export interface BalanceReport {
  items: number; moved: number; numericKept: number; skippedNotFive: number;
  letterRefs: string[]; before: Record<string, number>; after: Record<string, number>; maxRunAfter: number;
}

export async function balanceJobKeys(jobId: string, apply: boolean): Promise<BalanceReport> {
  const rows = await fetchAllRows<Record<string, any>>((from, to) => supabase.from('qb_questions')
    .select('id, question_number, options, correct_option, explanation, content, audit_trail')
    .eq('job_id', jobId).is('replaced_by_id', null).order('question_number').range(from, to));

  const rep: BalanceReport = { items: rows.length, moved: 0, numericKept: 0, skippedNotFive: 0, letterRefs: [], before: {}, after: {}, maxRunAfter: 0 };
  const plan = planPositions(rows.length, jobId);
  const finalKeys: string[] = [];

  for (let i = 0; i < rows.length; i++) {
    const q = rows[i];
    const opts = (q.options || {}) as Record<string, string>;
    const letters = Object.keys(opts).sort();
    const key = String(q.correct_option || '');
    rep.before[key] = (rep.before[key] || 0) + 1;
    if (letters.length !== 5 || letters.join('') !== LETTERS || !LETTERS.includes(key)) {
      rep.skippedNotFive++; finalKeys.push(key); continue;
    }
    const texts = letters.map((L) => opts[L]);
    if (texts.every((t) => NUMERIC.test(t))) { rep.numericKept++; finalKeys.push(key); continue; }

    const from = LETTERS.indexOf(key), to = plan[i];
    if (from === to) { finalKeys.push(key); continue; }
    if (LETTER_REF.test(String(q.explanation || ''))) rep.letterRefs.push(q.id);

    const next = [...texts];
    [next[from], next[to]] = [next[to], next[from]];
    const newOptions = Object.fromEntries(next.map((t, j) => [LETTERS[j], t]));
    const newKey = LETTERS[to];
    finalKeys.push(newKey);
    rep.moved++;
    if (!apply) continue;

    const content = { ...(q.content || {}) };
    if (Array.isArray(content.options)) content.options = next.map((t, j) => ({ key: LETTERS[j], text: t }));
    if (content.answer && typeof content.answer === 'object') content.answer = { ...content.answer, key: newKey };
    const trail = [...(Array.isArray(q.audit_trail) ? q.audit_trail : []), {
      phase: 'key_balance', from: key, to: newKey, reason: 'answer positions balanced across the bank; option content unchanged',
      timestamp: new Date().toISOString(),
    }];
    const { error } = await supabase.from('qb_questions').update({ options: newOptions, correct_option: newKey, content, audit_trail: trail }).eq('id', q.id);
    if (error) throw new Error(`key balance ${q.id}: ${error.message}`);
  }
  for (const k of finalKeys) rep.after[k] = (rep.after[k] || 0) + 1;
  let run = 0;
  finalKeys.forEach((k, i) => { run = i && k === finalKeys[i - 1] ? run + 1 : 1; rep.maxRunAfter = Math.max(rep.maxRunAfter, run); });
  return rep;
}
