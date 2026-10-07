/**
 * Measure the options-only probe (cueProbe.ts) and the deterministic cue checks (reviewMode.ts) on
 * pilot snapshots before either gates anything.
 *
 *   npx tsx src/scripts/benchmarkCueProbe.ts backups/usmle_export/pilot60_originals.json backups/usmle_export/pilot_restr2_export.json
 *
 * Reads the originals format (question_text, options[{text,is_correct}]) and the export format
 * (question.stem, question.options[{text,is_correct}]).
 */
import 'dotenv/config';
import fs from 'fs';
import { probeCues, keySpotted, implausibleDistractors } from '../services/review/cueProbe.js';
import { keyLengthCue, oddOneOut } from '../services/review/reviewMode.js';

type Row = Record<string, any>;
function toItem(r: Row): Row | null {
  const stem = r.question?.stem ?? r.question_text;
  const opts: Row[] = r.question?.options ?? r.options ?? [];
  if (!stem || opts.length < 3 || opts.filter((o) => o.is_correct).length !== 1) return null;
  const options: Record<string, string> = {};
  let key = '';
  opts.forEach((o, i) => { const L = 'ABCDEFGHIJ'[i]; options[L] = String(o.text ?? o.option_text ?? ''); if (o.is_correct) key = L; });
  return { id: r.source_question_id ?? r.id, question: stem, options, correct_option: key };
}

async function main() {
  for (const file of process.argv.slice(2)) {
    const items = (JSON.parse(fs.readFileSync(file, 'utf8')).questions as Row[]).map(toItem).filter(Boolean) as Row[];
    const batches: Row[][] = [];
    for (let i = 0; i < items.length; i += 10) batches.push(items.slice(i, i + 10));
    const results = (await Promise.all(batches.map((b) => probeCues(b)))).flat();
    let correct = 0, high = 0, spotted = 0, elim = 0, elimItems = 0, len = 0, odd = 0;
    const examples: string[] = [];
    items.forEach((q, i) => {
      const r = results[i];
      if (r?.guess === q.correct_option) correct++;
      if (r?.confidence === 'high') high++;
      if (keySpotted(q, r)) { spotted++; examples.push(`SPOTTED ${q.id.slice(0, 8)} [${r!.cues.join(',')}] key: ${q.options[q.correct_option].slice(0, 90)}`); }
      const im = implausibleDistractors(q, r);
      if (im.length) { elimItems++; elim += im.length; im.forEach((x) => examples.push(`ELIM ${q.id.slice(0, 8)} [${x.reason}] "${x.text.slice(0, 90)}"`)); }
      if (keyLengthCue(q)) len++;
      if (oddOneOut(q).length) odd++;
    });
    console.log(JSON.stringify({ file, n: items.length, probe_guessed_key: correct, chance: +(items.reduce((s, q) => s + 1 / Object.keys(q.options).length, 0)).toFixed(1), high_confidence: high, key_spotted: spotted, items_with_eliminable: elimItems, eliminable_total: elim, key_longest: len, odd_one_out: odd }));
    examples.forEach((e) => console.log('   ' + e));
  }
}
main();
