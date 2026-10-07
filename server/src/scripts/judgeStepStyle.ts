/**
 * Blind pairwise judgement: which revision of a live-bank item reads more like a real USMLE Step
 * item. Two pilot runs of the same items (e.g. Sonnet 5.5 vs GPT 6.1 Sol reviewers) are compared
 * item by item by a third model that is neither reviewer, shown both versions as X and Y in random
 * order, then again with the order swapped. A version wins only if it wins both orderings; a split
 * is a tie. The original is shown for context, so a revision that changes what was asked loses.
 *
 * Images are not shown — the judgement is on the text a candidate reads.
 *
 *   npx tsx src/scripts/judgeStepStyle.ts --a backups/usmle_export/pilot_run3_report.json --a-name sonnet \
 *     --b backups/usmle_export/pilot_sol3_report.json --b-name sol --out backups/usmle_export/judge_sonnet_vs_sol.json
 */
import 'dotenv/config';
import { readFileSync, writeFileSync } from 'node:fs';
import { orCall, extractJson } from './_judgeLib.js';

const arg = (n: string, d = '') => { const i = process.argv.indexOf(`--${n}`); return i >= 0 ? process.argv[i + 1] : d; };
const JUDGE = arg('judge', 'us.anthropic.claude-opus-5-5');
type Q = Record<string, any>;
const load = (f: string) => new Map((JSON.parse(readFileSync(f, 'utf8')).questions as Q[]).map((q) => [q.source_id, q]));
const A = load(arg('a')), Bm = load(arg('b'));
const aName = arg('a-name', 'A'), bName = arg('b-name', 'B');
const STEP: Record<string, string> = { step1: 'USMLE Step 1', step2: 'USMLE Step 2 CK', step3: 'USMLE Step 3' };

const render = (v: Q) => [
  `STEM:\n${v.stem}`,
  `OPTIONS:\n${v.options.map((o: Q, i: number) => `  ${String.fromCharCode(65 + i)}. ${o.text}${o.is_correct ? '   [keyed]' : ''}`).join('\n')}`,
  `EXPLANATION:\n${v.explanation}`,
].join('\n\n');

const prompt = (q: Q, x: Q, y: Q) => `You are a senior NBME item writer reviewing revisions of an existing ${STEP[q.step]} question bank item. Candidates have already answered the original, so a revision must keep testing the same thing with the same answer choices.

Judge which revision, X or Y, is closer to a real ${STEP[q.step]} item, using NBME item-writing standards:
1. Clinical vignette: patient age/sex, setting, history, exam, and the labs or imaging the decision needs; no superfluous or contradictory data; nothing that names the answer.
2. Lead-in: one focused, closed question ("Which of the following is the most likely diagnosis?" style) that can be answered before reading the options.
3. Options: homogeneous in kind, length and specificity; no cue (longest/most qualified keyed option, grammatical cues, absolute terms); one best answer.
4. Explanation: why the key is right and why each distractor is wrong, naming options by their text (not letter).
5. Accuracy under current US practice, and fidelity to the original item (same question, same choices, same key unless the original key was wrong).

ORIGINAL (for context):
${render(q.original)}

=== REVISION X ===
${render(x)}

=== REVISION Y ===
${render(y)}

Return ONLY a JSON object:
{"winner": "X" | "Y" | "tie", "margin": "clear" | "slight", "scores": {"X": {"vignette":1-5,"lead_in":1-5,"options":1-5,"explanation":1-5,"accuracy_fidelity":1-5}, "Y": {...same}}, "reason": "<one or two sentences naming the decisive difference>"}`;

async function judgeOnce(q: Q, x: Q, y: Q) {
  const r = await orCall(JUDGE, '', prompt(q, x, y), { maxTokens: 6000 });
  return extractJson(r.content);
}

const ids = [...A.keys()].filter((k) => Bm.has(k)).filter((k) => {
  const a = A.get(k)!.final, b = Bm.get(k)!.final;
  return JSON.stringify([a.stem, a.explanation, a.options]) !== JSON.stringify([b.stem, b.explanation, b.options]);
});
console.log(`${ids.length} items differ between ${aName} and ${bName}; judging each twice with ${JUDGE}`);

const results: Q[] = [];
let next = 0;
await Promise.all(Array.from({ length: 6 }, async () => {
  while (next < ids.length) {
    const k = ids[next++];
    const q = A.get(k)!, a = A.get(k)!.final, b = Bm.get(k)!.final;
    try {
      const [r1, r2] = await Promise.all([judgeOnce(q, a, b), judgeOnce(q, b, a)]); // r1: X=A, r2: X=B
      const w1 = r1.winner === 'X' ? aName : r1.winner === 'Y' ? bName : 'tie';
      const w2 = r2.winner === 'X' ? bName : r2.winner === 'Y' ? aName : 'tie';
      const winner = w1 === w2 ? w1 : 'tie';
      const sc = (r: Q, side: string) => r.scores?.[side] || {};
      results.push({ source_id: k, step: q.step, subject: q.subject, winner, orderings: [w1, w2],
        scores: { [aName]: [sc(r1, 'X'), sc(r2, 'Y')], [bName]: [sc(r1, 'Y'), sc(r2, 'X')] },
        reasons: [r1.reason, r2.reason] });
      process.stdout.write(winner === aName ? 'a' : winner === bName ? 'b' : '=');
    } catch (e) { console.error(`\n${k}: ${e instanceof Error ? e.message : e}`); }
  }
}));
console.log();
const tally: Record<string, number> = {};
for (const r of results) tally[r.winner] = (tally[r.winner] || 0) + 1;
const dims = ['vignette', 'lead_in', 'options', 'explanation', 'accuracy_fidelity'];
const mean = (name: string, d: string) => { const v = results.flatMap((r) => r.scores[name].map((s: Q) => Number(s[d]))).filter((n) => n > 0); return v.length ? (v.reduce((x, y) => x + y, 0) / v.length).toFixed(2) : '-'; };
console.log('winner (both orderings agree, else tie):', tally);
console.log('order-consistency:', results.filter((r) => r.orderings[0] === r.orderings[1]).length, '/', results.length);
for (const d of dims) console.log(`  ${d.padEnd(18)} ${aName} ${mean(aName, d)}   ${bName} ${mean(bName, d)}`);
writeFileSync(arg('out', 'backups/usmle_export/judge.json'), JSON.stringify({ judge: JUDGE, a: aName, b: bName, tally, results }, null, 1));
process.exit(0);
