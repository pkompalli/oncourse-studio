/**
 * Repair defects a QA pass found in the latest generation of each course.
 *
 * Four classes, all deterministic — none of this regenerates a question, and none of it
 * touches a stem, an exhibit or a numeric key. Run without --apply to see every edit.
 *
 * 1. DUPLICATE OPTION. A document-review span whose key is "No change is required" also
 *    offered an option repeating the original passage verbatim. Both are the same claim, so
 *    a learner choosing the identical wording was marked wrong for agreeing with the key.
 *    Drops the duplicate and leaves the key alone.
 *
 * 2. INTERNAL FIELD NAMES. Four Bar case sets instructed the learner "For each mcq_single
 *    question..." — the generator's own type names, which mean nothing to a candidate.
 *
 * 3. RESPONSE INSTRUCTIONS THAT DESCRIBE FIELDS THE TASK DOES NOT HAVE. The instructions
 *    were assembled from a generic clause pool rather than from the task, so they told
 *    learners to "complete every matrix and dropdown field" on tasks with four amount boxes,
 *    and to use a minus sign on tasks whose only control is a dropdown of unsigned strings.
 *    Every numeric key in the affected set is positive and every sub-question already asks
 *    for positive amounts, so the minus-sign clauses were wrong wherever they appeared.
 *    Rebuilds the instructions from the task's actual field inventory.
 *
 * 4. REG accord-and-satisfaction MCQ keyed to the wrong option. See MISKEYS below.
 *
 * 5. JOURNAL-ENTRY LINE ORDER (BAR 55/56, REG 76, TCP 72). The grids score per row id, so a
 *    correct entry whose lines sit in another order loses the moved lines — one scored 2 of 30.
 *    The grader is downstream of this repo (QuestionRenderer only displays the key), so the
 *    fix available here is to state the order the key uses. An order-insensitive grader would
 *    be the better fix and still belongs on whoever owns the delivery platform.
 *
 * Classes 1-3 and 5 have since moved into services/generation/coherence.ts, which generation
 * runs on its own output — so a new question never acquires them and this script is history.
 * What stays here is what only applies to THIS bank: the mis-key, the per-question text fixes,
 * and the one distractor that had to be derived from a specific exhibit.
 *
 * Three questions could not be edited into correctness and were retired and regenerated
 * instead (AUD 83 and 84 were whole tasks from another exam; ISC 86 keyed all eight passages
 * "No change is required", so it scored 8/8 without being read). That was done with
 * topUpJobFormats --subject, not here.
 */
import 'dotenv/config';
import { supabase } from '../db/supabase.js';
import { fetchAllRows } from '../db/pagination.js';
import { subjectExamMap } from '../services/generation/examSize.js';
import { repairCoherence, JOURNAL_ORDER_RULE } from '../services/generation/coherence.js';

const APPLY = process.argv.includes('--apply');

const JOBS = {
  CPA: 'e2d9e0b5-87b8-44d0-b8d1-b9f6eb4cfa67',
  BAREXAM: 'af81661d-6458-4ba2-a4d6-0134a386eee6',
  CFA: 'f36246fa-6b66-430d-a585-263443917916',
};

/** The one mis-keyed question, with the authority that settles it. */
const MISKEYS: Record<string, { from: string; to: string; explanation: string }> = {
  'CPA/REG-3': {
    from: 'A',
    to: 'C',
    explanation:
      'Option C is correct. Under UCC 3-311 a claim is discharged when the person against whom ' +
      'a claim is asserted tenders, in good faith, an instrument conspicuously marked as payment ' +
      'in full of a claim that is unliquidated or subject to a bona fide dispute, and the claimant ' +
      'obtains payment of that instrument. All three conditions are satisfied: the $50,000 claim ' +
      'was disputed in good faith, the $35,000 check conspicuously stated it was payment in full, ' +
      'and the service provider deposited it. Striking the notation and writing "Accepted under ' +
      'protest; full balance reserved" does not preserve the balance, because UCC 1-308(b) ' +
      'expressly provides that the reservation-of-rights rule does not apply to an accord and ' +
      'satisfaction. Option A is wrong because it rests on that reservation defeating the accord, ' +
      'which 1-308(b) forecloses. Option B is wrong for the same reason and because the provider ' +
      'retained the $35,000. Option D is wrong because a claimant cannot both keep the payment and ' +
      'reject the settlement; the discharge follows from obtaining payment. A creditor who wants to ' +
      'avoid discharge must refuse the check or, under UCC 3-311(c)(2), repay the $35,000 within 90 days.',
  },
};



/**
 * Exact-string edits to learner-visible text, applied only where the string still matches.
 * Each one removes a promise the task cannot keep; none changes what is being asked.
 */
const TEXT_FIXES: Record<string, Array<{ field: string; from: string; to: string; why: string }>> = {
  // Four amount boxes, and no assertion or procedure control anywhere in the task.
  'CPA/AUD-81': [{
    field: 'question',
    from: 'Using Exhibits 1 through 4, identify the affected assertions, select procedures responsive to the identified risks, and calculate the corrected inventory balance.',
    to: 'Using Exhibits 1 through 4, calculate the required adjustments to recorded inventory and the corrected inventory balance.',
    why: 'stem promised assertion and procedure selections the task has no fields for',
  }],
  // The vignette defines Exhibit 1 only.
  'CFA/L3-PoMa-6': [{
    field: 'prompt',
    from: 'Exhibits 1 and 2',
    to: 'Exhibit 1',
    why: 'cited an Exhibit 2 that does not exist',
  }],
  // Part B keys the one-year liquidity need at USD72m (spending + capital calls), but the
  // vignette gave no basis for leaving the 0.6% costs out, so USD75.6m was equally defensible.
  // Says how the costs are met without naming the liquidity requirement, which would give
  // Part B away. Part A still grosses the required return up by the same 0.6%.
  'CFA/L3-PrWe-8': [{
    field: 'vignette',
    from: 'Annual investment-management and administrative costs equal 0.6% of beginning assets, and expected annual inflation is 2.4%.',
    to: 'Annual investment-management and administrative costs equal 0.6% of beginning assets and are charged directly against portfolio returns rather than funded from liquid reserves. Expected annual inflation is 2.4%.',
    why: 'vignette left it open whether the 0.6% costs belong in the liquidity requirement',
  }],
};

/**
 * Journal-entry grids score per row id, so a correct entry whose lines sit in another order
 * loses the moved lines. The rule itself now lives in services/generation/coherence.ts, so
 * generation states it on every new journal-entry task; this list is the four that predate it.
 */
const NEEDS_ORDER_RULE = ['CPA/BAR-55', 'CPA/BAR-56', 'CPA/REG-76', 'CPA/TCP-72'];

/**
 * Restores a third choice to a span left with two by the duplicate-option fix.
 *
 * BAR 52 span 4 is the current-aging allowance: $800,000 less the $12,000 Maple return is
 * $788,000, at 1% = $7,880, so the document is right and "No change is required" is the key.
 * Removing the verbatim "$7,880" option left only "$8,000" — the candidate who forgets the
 * return — so the item became a coin flip. $7,760 is $776,000 at 1%, the candidate who
 * deducts the return twice: derivable from the exhibits, wrong for a stated reason, and
 * distinct from every other figure in the schedule.
 */
const ADD_SPAN_OPTIONS: Record<string, Array<{ span: string; insertAt: number; option: string }>> = {
  'CPA/BAR-52': [{ span: '4', insertAt: 0, option: '$7,760' }],
};

async function main() {
  const edits: Array<{ ref: string; id: string; what: string[]; patch: Record<string, unknown> }> = [];

  for (const [label, jobId] of Object.entries(JOBS)) {
    const rows = await fetchAllRows<any>((f, t) =>
      supabase.from('qb_questions').select('*').eq('job_id', jobId)
        .is('replaced_by_id', null).in('status', ['approved', 'reviewed', 'generated'])
        .order('question_number', { ascending: true }).range(f, t));

    const { data: job } = await supabase.from('qb_jobs').select('course_id').eq('id', jobId).single();
    const { data: course } = await supabase.from('qb_courses').select('structure').eq('id', job!.course_id).single();
    const structure = (course?.structure || {}) as any;
    const examOfSubject = subjectExamMap(structure);
    const codeOf = new Map<string, string>((structure.exams || []).map((e: any) => [String(e.name), String(e.code)]));

    const seen = new Map<string, number>();
    for (const q of rows) {
      const exam = String(q.tags?.exam || examOfSubject[q.subject] || '');
      const code = codeOf.get(exam) || exam || 'ALL';
      const n = (seen.get(code) || 0) + 1;
      seen.set(code, n);
      const ref = `${label}/${code}-${n}`;

      const content = JSON.parse(JSON.stringify(q.content ?? {}));
      const what: string[] = [];
      const patch: Record<string, unknown> = {};

      // The mechanical repairs — duplicate options, internal type names, instructions rebuilt
      // from the task's own fields, the journal-entry line order — now live in
      // services/generation/coherence.ts and run inside generation itself, so a new question
      // never needs them. This call is what repaired the existing bank.
      what.push(...repairCoherence(content));

      for (const add of ADD_SPAN_OPTIONS[ref] || []) {
        for (const s of content.sub_questions || []) {
          const sp = (s.spans || []).find((x: any) => String(x.id) === add.span);
          if (!sp || (sp.options || []).includes(add.option)) continue;
          sp.options.splice(add.insertAt, 0, add.option);
          what.push(`span ${add.span}: added distractor ${add.option} (was down to two choices)`);
        }
      }

      for (const fix of TEXT_FIXES[ref] || []) {
        const before = String(content[fix.field] ?? '');
        if (before.includes(fix.from)) {
          content[fix.field] = before.split(fix.from).join(fix.to);
          what.push(`${fix.field}: ${fix.why}`);
        }
      }

      // A journal-entry task that predates the shared rule and whose instructions were already
      // rebuilt: repairCoherence appends the order rule when it rebuilds, so this only catches
      // one whose instructions were otherwise correct.
      if (NEEDS_ORDER_RULE.includes(ref)) {
        const cur = String(content.response_instructions || '');
        if (!cur.includes(JOURNAL_ORDER_RULE)) {
          content.response_instructions = `${cur} ${JOURNAL_ORDER_RULE}`.trim();
          what.push('stated the line order the journal-entry key uses');
        }
      }

      const mis = MISKEYS[ref];
      if (mis) {
        const current = String(q.correct_option ?? content?.answer?.key ?? '');
        if (current !== mis.from) {
          console.log(`  !! ${ref} expected key ${mis.from} but found ${current} — skipped`);
        } else {
          if (content.answer && typeof content.answer === 'object') content.answer.key = mis.to;
          content.explanation = mis.explanation;
          patch.correct_option = mis.to;
          if (q.explanation != null) patch.explanation = mis.explanation;
          what.push(`re-keyed ${mis.from} -> ${mis.to} and rewrote the explanation`);
        }
      }

      if (!what.length) continue;
      patch.content = content;
      edits.push({ ref, id: q.id, what, patch });
    }
  }

  const byWhat = new Map<string, number>();
  for (const e of edits) for (const w of e.what) {
    const k = w.split(' (')[0]; byWhat.set(k, (byWhat.get(k) || 0) + 1);
  }

  console.log(`\n${APPLY ? 'APPLYING' : 'DRY RUN'} — ${edits.length} question(s) to change\n`);
  for (const e of edits) {
    console.log(`${e.ref}  ${e.id}`);
    for (const w of e.what) console.log(`    - ${w}`);
    const ri = (e.patch.content as any)?.response_instructions;
    if (ri) console.log(`    instructions -> ${ri}`);
  }
  console.log('\nsummary:');
  for (const [k, n] of byWhat) console.log(`  ${n}  ${k}`);

  if (!APPLY) { console.log('\nRe-run with --apply to write these.'); return; }

  let ok = 0;
  for (const e of edits) {
    const { error } = await supabase.from('qb_questions').update(e.patch).eq('id', e.id);
    if (error) console.log(`  FAILED ${e.ref}: ${error.message}`);
    else ok++;
  }
  console.log(`\nwrote ${ok}/${edits.length}`);
}

await main();
