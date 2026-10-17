/**
 * Blind pairwise check of repaired items against their live-bank originals: for each id, the current
 * version and the original are judged in both orders (conceptGuard.preferOriginal), and the item is
 * counted as better, worse or a tie. Used to make sure a looser concept guard does not let worse
 * rewrites through.
 *
 *   npx tsx src/scripts/judgeAgainstOriginal.ts --ids <ids.json> [--approved-only] --out <report.json>
 */
import 'dotenv/config';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { supabase } from '../db/supabase.js';
import { orCall, MODELS } from '../services/llm/openrouter.js';

type Row = Record<string, any>;
const arg = (n: string) => { const i = process.argv.indexOf(`--${n}`); return i >= 0 ? process.argv[i + 1] : undefined; };
const ids: string[] = JSON.parse(readFileSync(arg('ids')!, 'utf8'));
const APPROVED = process.argv.includes('--approved-only');
const SOURCES = ['backups/usmle_export/usmle_questions_post_2025-01-31.json', 'backups/usmle_export/usmle_questions_pre_2025-01-31.json', 'backups/usmle_export/usmle_pre2025_sample100.json'].filter(existsSync);
const src = new Map(SOURCES.flatMap((f) => JSON.parse(readFileSync(f, 'utf8')).questions as Row[]).map((q) => [q.id, q]));

const L = 'ABCDEFGHIJ';
const renderCurrent = (q: Row) => {
  const o = q.options as Record<string, string>;
  return `${q.question}\n${Object.keys(o).sort().map((k) => `${k}. ${o[k]}${k === q.correct_option ? '   (keyed)' : ''}`).join('\n')}\nExplanation: ${String(q.explanation ?? '').slice(0, 1500)}`;
};
const renderOriginal = (s: Row) => `${s.question_text}\n${(s.options as Row[]).map((o, i) => `${L[i]}. ${o.text}${o.is_correct ? '   (keyed)' : ''}`).join('\n')}\nExplanation: ${String(s.explanation ?? '').slice(0, 1500)}`;
const PAIR = (x: string, y: string) => `Two versions of the same USMLE-style item. Judge which is the better exam item TODAY: medical accuracy under current guidelines, a single defensible answer, an exam-style stem with what the decision needs and no giveaway, a closed lead-in, homogeneous plausible options with no cue to the key, and a complete explanation.

VERSION X:
${x}

VERSION Y:
${y}

Reply with JSON only: {"better": "X" | "Y" | "tie", "reason": "<one sentence>"}`;
const pick = (t: string) => { try { return JSON.parse(t.match(/\{[\s\S]*\}/)?.[0] ?? '{}'); } catch { return {}; } };

const rows: Row[] = [];
for (let i = 0; i < ids.length; i += 30) { const { data } = await supabase.from('qb_questions').select('*').in('id', ids.slice(i, i + 30)); rows.push(...data!); }
const todo = rows.filter((q) => !APPROVED || q.status === 'approved');
const out: Row[] = [];
let k = 0;
await Promise.all(Array.from({ length: 10 }, async () => {
  for (let q = todo[k++]; q; q = todo[k++]) {
    const s = src.get(q.tags?.source_question_id);
    if (!s) continue;
    const a = renderCurrent(q), b = renderOriginal(s);
    const [r1, r2] = await Promise.all([orCall(MODELS.AUDITOR, '', PAIR(a, b), { maxTokens: 300, temperature: 0 }), orCall(MODELS.AUDITOR, '', PAIR(b, a), { maxTokens: 300, temperature: 0 })].map((p) => p.then((r) => pick(r.content)).catch(() => ({} as Row))));
    const verdict = r1.better === 'X' && r2.better === 'Y' ? 'revised' : r1.better === 'Y' && r2.better === 'X' ? 'original' : 'tie';
    out.push({ id: q.id, status: q.status, verdict, reason: r1.reason ?? '' });
  }
}));
writeFileSync(arg('out')!, JSON.stringify(out, null, 1));
const c = (v: string) => out.filter((x) => x.verdict === v).length;
console.log(`${out.length} judged: revised better ${c('revised')}, original better ${c('original')}, tie ${c('tie')}`);
process.exit(0);
