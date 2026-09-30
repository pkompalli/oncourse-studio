/**
 * The one repair that came out of the round-3 "arguable" list.
 *
 * CFA L2, Northbank vignette, sub-question 4. The stem asks how "Kwan's assessment ... is most
 * appropriately described", but all three options describe the RISK, not the assessment. Read
 * literally, option A *is* an accurate description of Kwan's assessment — he does believe duration
 * matching removes the risk — while the keyed answer B describes the risk itself. Two different
 * readings, two different answers, and the stem is what picks between them.
 *
 * Pointing the stem at the position rather than at Kwan's description of it leaves exactly one
 * defensible answer. The options and the rationale are sound and are not touched.
 *
 * Every other item on the arguable list was checked and kept as-is.
 *
 * Dry run by default. Pass --apply.
 */
import 'dotenv/config';
import { writeFileSync, mkdirSync } from 'node:fs';
import { supabase } from '../db/supabase.js';
import { fetchAllRows } from '../db/pagination.js';

const APPLY = process.argv.includes('--apply');
const JOB_PREFIX = '9eafe612';                 // CFA Level II
const ROW_PREFIX = 'a9ee0ea2';
const SUB_INDEX = 3;                           // sub-question 4

const OLD_STEM = "Kwan's assessment of Northbank's risk is most appropriately described by:";
const NEW_STEM = "The risk of Northbank's position is most appropriately described by:";

const { data: jobs } = await supabase.from('qb_jobs').select('id');
const jobId = (jobs || []).map((j: any) => j.id).find((id: string) => id.startsWith(JOB_PREFIX));
if (!jobId) { console.log(`no job starting ${JOB_PREFIX}`); process.exit(1); }

const rows = await fetchAllRows<any>((f, t) =>
  supabase.from('qb_questions').select('id,question_number,content').eq('job_id', jobId).range(f, t));
const row = rows.find((r: any) => String(r.id).startsWith(ROW_PREFIX));
if (!row) { console.log(`no question starting ${ROW_PREFIX}`); process.exit(1); }

const content = JSON.parse(JSON.stringify(row.content || {}));
const sub = (content.sub_questions || [])[SUB_INDEX];
if (!sub) { console.log(`no sub_questions[${SUB_INDEX}]`); process.exit(1); }
if (String(sub.question).trim() !== OLD_STEM) {
  console.log(`stem already changed — found:\n  ${sub.question}`);
  process.exit(1);
}

console.log(`question ${row.id}  (#${row.question_number})  sub ${SUB_INDEX + 1}`);
console.log(`  was: ${OLD_STEM}`);
console.log(`  now: ${NEW_STEM}`);
console.log(`  key ${sub.correct_answer} unchanged; options and rationale untouched`);

if (!APPLY) { console.log('\nDRY RUN — re-run with --apply.'); process.exit(0); }

mkdirSync('backups', { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
writeFileSync(`backups/qb_question_${ROW_PREFIX}_pre_arguable_${stamp}.json`, JSON.stringify(row, null, 2));

sub.question = NEW_STEM;
const { error } = await supabase.from('qb_questions').update({ content }).eq('id', row.id);
console.log(error ? `FAILED: ${error.message}` : 'written');
