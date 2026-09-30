/**
 * Raise the floor on how many questions a grouped stimulus must carry.
 *
 * MCAT's 37 passage sets carry 150 questions — 35 of them have exactly 4 sub-questions and only
 * 2 have 5. The spec is not wrong: it says science passages "support 4–6 sub-questions" and CARS
 * 5–7, with sub_question_min 4 and max 7. The generator simply answers a range at its cheapest
 * end, every time. That is the same failure as the counts themselves — a permitted minimum is
 * treated as the target — and it costs 36 questions against a 230-item paper.
 *
 * A real MCAT passage carries 4 to 7 questions averaging about 4.7, so 4 is legal but sits on the
 * floor for almost every passage in the bank. Raising the minimum to 5 puts the average where the
 * real exam is and needs fewer passages to reach 185 passage-based questions, which is closer to
 * the real 39 than padding with more 4-question passages would be.
 *
 * Only the minimum moves. The maximum stays, so a passage that warrants 6 or 7 questions can
 * still have them, and the existing 37 are left alone — they are legitimate items and rewriting
 * good content to chase an average would be worse than topping up.
 *
 * NOT SAFE TO APPLY TO A BANK THAT ALREADY EXISTS, which is why NEW_MIN is back at 4 here.
 * topUpJobFormats reads sub_question_min as its THIN-ITEM threshold, so raising it to 5 reclassified
 * all 35 four-question passages as too thin and planned to retire them and regenerate 42 — 150
 * legitimate questions destroyed to raise an average. The floor belongs in the spec a course is
 * generated FROM, not retrofitted onto one it has already produced.
 *
 * Dry run by default. Pass --apply.
 */
import 'dotenv/config';
import { supabase } from '../db/supabase.js';

const APPLY = process.argv.includes('--apply');
const COURSE = '42c85248-7209-4bfe-9f94-ea128e3ab598'; // MCAT
const FORMAT = 'passage_set';
const NEW_MIN = 4;

const { data, error } = await supabase
  .from('qb_courses').select('name,generation_guidelines').eq('id', COURSE).single();
if (error) throw new Error(error.message);

const gl = JSON.parse(JSON.stringify((data as any).generation_guidelines || {})) as Record<string, any>;
const spec = gl.format_specs?.[FORMAT];
if (!spec) { console.log(`no ${FORMAT} spec on ${(data as any).name}`); process.exit(1); }

const changes: string[] = [];

const params = spec.schema_params || {};
if (Number(params.sub_question_min) !== NEW_MIN) {
  changes.push(`schema_params.sub_question_min ${params.sub_question_min} -> ${NEW_MIN}`);
  spec.schema_params = { ...params, sub_question_min: NEW_MIN };
}

// The prose the model actually reads has to agree with the parameter, or it keeps answering the
// old range. Both the instruction and the check that polices it are rewritten.
const bump = (arr: unknown, label: string) => {
  if (!Array.isArray(arr)) return arr;
  let hit = 0;
  const out = arr.map((line) => {
    const s = String(line);
    const next = s
      .replace(/4\s*[–-]\s*6 sub-questions/g, '5–6 sub-questions')
      .replace(/4\s*[–-]\s*6 sub_questions/g, '5–6 sub_questions')
      .replace(/has 4\s*[–-]\s*6/g, 'has 5–6');
    if (next !== s) hit++;
    return next;
  });
  if (hit) changes.push(`${label}: raised the stated minimum on ${hit} line(s)`);
  return out;
};
spec.syntax_rules = bump(spec.syntax_rules, 'syntax_rules');
spec.validation_checks = bump(spec.validation_checks, 'validation_checks');
spec.structure_requirements = bump(spec.structure_requirements, 'structure_requirements');
spec.content_rules = bump(spec.content_rules, 'content_rules');

// content_schema is deliberately LEFT ALONE.
//
// It is what schemaErrorsFor enforces, so raising its minItems would be the stronger move — and
// it would also declare the 35 four-question passages already in the bank invalid. Those are
// legitimate MCAT items that met the spec when they were written; a real passage carries 4 to 7
// questions. Condemning good content to raise an average is a worse trade than letting the
// occasional 4 through, and a full re-review would otherwise flag all 35 at once.
//
// Generation reads the prose and schema_params, which is where the floor needs to move to change
// what gets produced. Validation stays where it is, so nothing already written becomes a defect.
const schemaMin = spec.content_schema?.properties?.sub_questions?.minItems;
console.log(`content_schema.sub_questions.minItems left at ${schemaMin} so the existing 4-question passages stay valid`);

console.log(`course: ${(data as any).name} — ${FORMAT}`);
console.log(`\n${APPLY ? 'APPLYING' : 'DRY RUN'} — ${changes.length} change(s)`);
for (const c of changes) console.log(`  - ${c}`);
console.log(`\nafter  — min=${spec.schema_params?.sub_question_min} max=${spec.schema_params?.sub_question_max} schemaMinItems=${spec.content_schema?.properties?.sub_questions?.minItems}`);

if (!changes.length) { console.log('\nnothing to do'); process.exit(0); }
if (!APPLY) { console.log('\nRe-run with --apply to write.'); process.exit(0); }
const { error: upErr } = await supabase.from('qb_courses')
  .update({ generation_guidelines: gl }).eq('id', COURSE);
console.log(upErr ? `FAILED: ${upErr.message}` : 'written');
