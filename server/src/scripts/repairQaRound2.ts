/**
 * Second QA round on the latest CPA, Bar and CFA generations.
 *
 * Where the first round (repairBankDefects.ts) was almost all structural — instructions
 * describing fields that did not exist, options duplicating the passage they corrected — this
 * round is mostly substantive. None of it could have been caught by a schema, a gradability
 * check or the coherence gate: the items are well-formed and gradable, and wrong anyway.
 *
 * THE RELEASE BLOCKER. BAR 33, 39 and 50 apply a basis adjustment to a cash flow hedge of a
 * forecast purchase and call it U.S. GAAP. That is the IFRS treatment. IFRS 9 6.5.11(d)(i)
 * removes the accumulated amount from the cash flow hedge reserve and includes it in the
 * asset's initial cost; ASC 815-30-35-39 does the opposite, leaving it in accumulated other
 * comprehensive income and reclassifying it into earnings only when the hedged item affects
 * earnings — depreciation for equipment, cost of sales for inventory. All three were keyed to
 * the IFRS answer. Rewritten as U.S. GAAP questions, which is what a CPA candidate is tested
 * on, with the IFRS basis adjustment left in place as the distractor it should always have been.
 *
 * BAR 33 carried a second, subtler error: it split $5,000 of the gain out as "hedge
 * ineffectiveness". ASU 2017-12 eliminated separate measurement and reporting of
 * ineffectiveness for a qualifying cash flow hedge — the entire change in the hedging
 * instrument's fair value goes to OCI — so that split has not existed for years. Removed from
 * the stem and from the two options built on it.
 *
 * MISSING OR CONTRADICTORY FACTS. A stem that never gives a figure its key depends on (REG 34's
 * accumulated E&P), a stem that contradicts itself (REG 19 calls income "pretax" and then
 * includes federal income tax expense in it), two options describing the same outcome (REG 8:
 * "reduced to $4,000" and "$10,000 subject to a $6,000 credit"), discount factors from two
 * different rates in one problem (BAR 18: 3.0373 is 12% for four years, 0.6830 is 10%), a stem
 * that says the deferred tax effect was omitted while the key removes a deferred tax liability
 * that would therefore never have existed (FAR 12), and a method named as the opposite of the
 * one its arithmetic uses (TCP 69: capital retention preserves principal, a present value
 * annuity factor liquidates it).
 *
 * AMBIGUOUS KEYS. AUD 5 had three defensible answers: AR-C 70 permits a disclaimer, a
 * compilation, or withdrawal when the no-assurance legend cannot be included, and three of the
 * four options were those three. Recast to ask which course is NOT permitted, so the item now
 * tests the rule it was reaching for. Bar 54 turns on a split of authority the stem did not
 * acknowledge, so the stem now names the view it uses.
 *
 * WORDING. Parties renamed mid-question (Bar 57's "client", Bar 69's "wholesaler"), a stem
 * asking for the opposite of what its key says (Bar 84), a statement punctuated as a question
 * (CFA Private Wealth 20.2), and FAR 54's schedule built as a markdown table whose pipes ended
 * up inside the selectable text, so candidates read "Adjusted inventory balance | $393,000".
 *
 * Dry run by default. Pass --apply.
 */
import 'dotenv/config';
import { supabase } from '../db/supabase.js';
import { fetchAllRows } from '../db/pagination.js';
import { subjectExamMap } from '../services/generation/examSize.js';

const APPLY = process.argv.includes('--apply');

const JOBS: Record<string, string> = {
  CPA: 'e2d9e0b5-87b8-44d0-b8d1-b9f6eb4cfa67',
  BAREXAM: 'af81661d-6458-4ba2-a4d6-0134a386eee6',
  CFA: 'f36246fa-6b66-430d-a585-263443917916',
};

/** A no-basis-adjustment explanation shared in spirit by the three hedge questions. */
const ASC = 'ASC 815-30-35-39';
const IFRS = 'IFRS 9 6.5.11(d)(i)';

interface Edit {
  /** Replace the whole stem. */
  stem?: string;
  /** Replace individual option texts, by key. */
  options?: Record<string, string>;
  /** Move the answer, asserting what it is now so a re-run is a no-op. */
  key?: { from: string; to: string };
  /** Replace the explanation. */
  explanation?: string;
  /** Replace one sub-question's prompt, matched by its `number`. */
  subQuestion?: { number: number; question: string };
  /** Anything that needs code rather than a literal. Returns what it changed. */
  custom?: (content: Record<string, any>) => string[];
  why: string;
}

/**
 * FAR 54's schedule was authored as a markdown table, and the span markers were placed across
 * the cell separators, so each selectable unit carries a raw "|". Rebuilt as a list, and every
 * span text and option de-piped: two-column rows become "label: amount", and the journal-entry
 * rows become "account, debit amount" / "account, credit amount".
 */
function depipe(s: string): string {
  const t = s.trim();
  let m = t.match(/^(.*?)\s*\|\s*(\$[\d,()]+)\s*\|\s*—$/);
  if (m) return `${m[1].trim()}, debit ${m[2]}`;
  m = t.match(/^(.*?)\s*\|\s*—\s*\|\s*(\$[\d,()]+)$/);
  if (m) return `${m[1].trim()}, credit ${m[2]}`;
  m = t.match(/^(.*?)\s*\|\s*(\$[\d,()]+)$/);
  if (m) return `${m[1].trim()}: ${m[2]}`;
  return t;
}

const FAR54_DOCUMENT = `# Cedar Company
## Draft Year-End Inventory Memorandum

### Inventory Adjustment Schedule

- [[span:1]]Unadjusted inventory balance per the general ledger: $255,000[[/span]]
- [[span:2]]Item B — Retain goods held on consignment from the supplier in Cedar's inventory: $0[[/span]]
- [[span:3]]Item C — Add goods delivered to the independent dealer on consignment because Cedar retains ownership: $48,000[[/span]]
- [[span:4]]Item D — Make no adjustment because the goods were not received until January 3: $0[[/span]]
- [[span:5]]Item E — Add goods shipped FOB destination because title had not transferred by December 31: $75,000[[/span]]
- [[span:6]]Item F — Write the obsolete goods down by $10,000 to net realizable value of $30,000[[/span]]
- [[span:7]]Adjusted inventory balance at December 31: $393,000[[/span]]

### Entry to Reverse the Premature Sale of Item E

- [[span:8]]Accounts receivable, debit $110,000[[/span]]
- [[span:9]]Sales revenue, credit $110,000[[/span]]`;

const EDITS: Record<string, Edit> = {
  // ── Wrong under U.S. GAAP ──────────────────────────────────────────────────
  'CPA/BAR-39': {
    key: { from: 'A', to: 'B' },
    why: 'applied the IFRS basis adjustment to a U.S. GAAP cash flow hedge',
    explanation:
      'Option B is correct. Under U.S. GAAP a cash flow hedge of a forecast purchase does not '
      + `adjust the basis of the asset acquired. ${ASC} leaves the amount accumulated in `
      + 'accumulated other comprehensive income where it is and reclassifies it into earnings in '
      + 'the same periods in which the hedged item affects earnings — here, as the equipment is '
      + 'depreciated over its useful life. The equipment is therefore recorded at its $800,000 '
      + 'spot-rate cost, the $45,000 loss stays in AOCI, and there is no immediate effect on '
      + 'earnings. Options A and C apply a basis adjustment, raising or lowering the equipment\'s '
      + `cost by the deferred loss. That is the IFRS treatment — ${IFRS} removes the amount from `
      + 'the cash flow hedge reserve and includes it in the asset\'s initial cost — and it is not '
      + 'permitted under U.S. GAAP. Option D reclassifies the loss to earnings at once, which '
      + 'happens only if the hedge is discontinued and the forecast transaction is no longer '
      + 'expected to occur.',
  },
  'CPA/BAR-33': {
    key: { from: 'C', to: 'D' },
    why: 'applied the IFRS basis adjustment, and split out ineffectiveness that ASU 2017-12 removed',
    stem:
      'A company designates a derivative as a cash flow hedge of a forecast purchase of '
      + 'inventory. Immediately before the purchase, the derivative has a cumulative gain of '
      + '$40,000 recorded in accumulated other comprehensive income, and the hedge qualifies for '
      + 'hedge accounting throughout. The company then purchases the inventory for $500,000 and '
      + 'settles the derivative. How should the purchase and hedge gain be reported under U.S. GAAP?',
    options: {
      B: 'Report inventory at $535,000 and recognize no gain in earnings',
      C: 'Report inventory at $465,000 and recognize no gain in earnings',
    },
    explanation:
      'Option D is correct. U.S. GAAP does not apply a basis adjustment to an asset acquired in a '
      + `hedged forecast purchase. Under ${ASC} the $40,000 accumulated in other comprehensive `
      + 'income stays there and is reclassified into earnings in the same period the hedged item '
      + 'affects earnings — for inventory, when it is sold and charged to cost of sales. The '
      + 'inventory is therefore recorded at its $500,000 purchase price. Option A reclassifies the '
      + 'whole gain to earnings on the purchase date, which happens only if the hedge is '
      + 'discontinued and the forecast purchase is no longer expected to occur. Options B and C '
      + `apply a basis adjustment in one direction or the other; that is what ${IFRS} requires and `
      + 'U.S. GAAP does not permit. Note also that since ASU 2017-12 ineffectiveness is no longer '
      + 'measured or reported separately for a qualifying cash flow hedge — the entire change in '
      + 'the hedging instrument\'s fair value is recorded in OCI — so no part of the gain is split '
      + 'out and recognized immediately.',
  },
  'CPA/BAR-50': {
    key: { from: 'D', to: 'B' },
    why: 'stem asserted a basis-adjustment election that U.S. GAAP does not provide',
    stem:
      'A U.S. company designated a derivative as a qualifying cash flow hedge of a forecasted '
      + 'purchase of inventory. When the company purchased the inventory for $200,000, the '
      + 'derivative had a cumulative $15,000 gain reported in accumulated other comprehensive '
      + 'income. The derivative was settled on the purchase date. At what amount should the '
      + 'company initially recognize the inventory under U.S. GAAP?',
    explanation:
      'Option B is correct. The inventory is recognized at its $200,000 purchase price. U.S. GAAP '
      + 'provides no basis-adjustment election for a cash flow hedge of a forecast purchase of a '
      + `nonfinancial asset: ${ASC} leaves the $15,000 gain in accumulated other comprehensive `
      + 'income and reclassifies it into earnings when the inventory affects earnings, that is, in '
      + 'cost of sales when the inventory is sold. Option D applies the basis adjustment that '
      + `${IFRS} requires but U.S. GAAP does not permit. Option C both applies that adjustment and `
      + 'moves the basis in the wrong direction, since a gain would reduce rather than increase '
      + 'the carrying amount. Option A is the derivative\'s gain, not the cost of the inventory.',
  },

  // ── Missing or contradictory facts ────────────────────────────────────────
  'CPA/REG-34': {
    why: 'key needs at least $25,000 of accumulated E&P and the stem never gave an amount',
    stem:
      "At the beginning of 2025, Lee's basis in the stock of an S corporation was $35,000. The "
      + 'corporation has $40,000 of accumulated earnings and profits from prior C corporation '
      + 'years and had a $20,000 accumulated adjustments account before distributions. During '
      + '2025, the corporation made a $45,000 cash distribution to Lee, and no other basis '
      + "adjustments occurred. What are Lee's dividend income and ending stock basis?",
  },
  'CPA/REG-19': {
    why: 'called the income pretax while including federal income tax expense in it',
    stem:
      'A calendar-year C corporation reports 2025 book income of $600,000 after deducting federal '
      + 'income tax expense. Book income includes $35,000 of estimated bad debt expense, $50,000 '
      + 'of book depreciation, $25,000 of federal income tax expense, and $10,000 of municipal '
      + 'bond interest. For tax purposes, specific bad debts of $20,000 are deductible and '
      + "depreciation is $75,000. What is the corporation's taxable income?",
  },
  'CPA/REG-8': {
    why: 'options B and C described the same outcome — a $4,000 balance still owed',
    options: {
      B: 'The creditor must return the $6,000 before it may enforce any part of the $10,000 claim.',
    },
    explanation:
      'Option C is correct because accord and satisfaction requires a bona fide dispute over the '
      + "debt; since the $10,000 debt was liquidated and undisputed, the debtor's unilateral "
      + 'notation cannot discharge the claim, and the creditor remains entitled to the balance, '
      + 'subject to a $6,000 credit for the payment received. Option A is incorrect because no '
      + 'accord and satisfaction can arise absent a genuine dispute, whatever the notation says. '
      + 'Option B is incorrect because a creditor who receives a part payment on an undisputed '
      + 'debt may retain it and sue for the remainder; no tender back is required as a condition '
      + 'of enforcing the claim. Option D is incorrect because no separate release is needed — the '
      + 'claim was never discharged, so there is nothing for a release to confirm.',
  },
  'CPA/BAR-18': {
    why: 'annuity factor 3.0373 is 12% for four years but the year-4 factor 0.6830 is 10%',
    stem:
      'A company is evaluating equipment costing $500,000 and requiring an immediate $40,000 '
      + 'investment in working capital. The equipment will generate annual pretax net operating '
      + 'cash inflows before depreciation of $170,000 for four years. It will be depreciated '
      + 'straight-line to zero over four years, has no disposal value, and the working capital '
      + 'will be recovered at the end of year 4. The tax rate is 25%. At the required return, the '
      + 'four-year annuity factor is 3.0373 and the year-4 present value factor is 0.6355. What '
      + "is the project's net present value, rounded to the nearest dollar?",
    options: {
      B: '$7,591',
      C: '$(127,324)',
      D: '$(32,409)',
    },
    explanation:
      'Option D is correct because annual depreciation is $125,000 and annual after-tax operating '
      + 'cash flow is $158,750, calculated as $170,000(1 − 25%) + $125,000(25%). The net present '
      + 'value is ($158,750 × 3.0373) + ($40,000 × 0.6355) − $540,000, which equals $(32,409) '
      + 'after rounding. Both factors are drawn from the same 12% required return. Option A is '
      + 'wrong because it omits the discounted recovery of working capital. Option B is wrong '
      + 'because it fails to include the initial $40,000 working-capital outflow while still '
      + 'including its recovery. Option C is wrong because it omits the depreciation tax shield '
      + 'from the annual cash flow.',
  },
  'CPA/FAR-12': {
    why: 'stem said the deferred tax effect was omitted, so the key had no liability to remove',
    stem:
      'In 2025, an SEC registrant preparing comparative 2025 and 2024 financial statements '
      + 'discovered that it omitted $120,000 of depreciation expense from its 2023 U.S. GAAP '
      + 'financial statements. The correct depreciation was deducted on the 2023 tax return, and '
      + 'the registrant recorded the resulting $30,000 deferred tax liability, so only the book '
      + 'depreciation expense was omitted. The enacted tax rate is 25%, and the error is '
      + 'material. How should the registrant correct the error in the comparative financial '
      + 'statements?',
  },
  'CPA/TCP-69': {
    why: 'named the capital retention approach but used a present value annuity factor, which liquidates capital',
    custom: (c) => {
      const before = String(c.stem ?? '');
      const after = before.replace(
        'Using the capital retention (needs-based) approach',
        'Using the capital liquidation (needs-based) approach'
      );
      if (after === before) return [];
      c.stem = after;
      return ['stem: renamed the approach to capital liquidation, which is what the annuity factor computes'];
    },
  },

  // ── Ambiguous keys ────────────────────────────────────────────────────────
  'BAREXAM/undefined-54': {
    why: 'Rule 50(b) renewal is a split of authority and the stem did not say which view it used',
    custom: (c) => {
      const before = String(c.stem ?? '');
      const after = before.replace(
        'Which of the following is the most appropriate advice?',
        'Under the prevailing view that a Rule 50(a) motion must be renewed at the close of all '
        + 'the evidence to preserve the ground, which of the following is the most appropriate advice?'
      );
      if (after === before) return [];
      c.stem = after;
      return ['stem: named the view the question applies, since the rule text alone supports B'];
    },
  },
  'CPA/AUD-5': {
    key: { from: 'D', to: 'C' },
    why: 'AR-C 70 permits a disclaimer, a compilation OR withdrawal, so three options were defensible',
    stem:
      "An accountant is engaged under SSARS to prepare a nonissuer's financial statements but is "
      + 'not engaged to compile, review, or audit them. Management refuses to permit each page to '
      + 'state that no assurance is provided. Which of the following courses of action is NOT '
      + 'permitted under AR-C 70?',
    options: {
      A: 'Perform a compilation engagement in accordance with AR-C 80.',
      B: 'Issue the financial statements with a disclaimer that makes clear that no assurance is provided.',
      C: 'Issue the financial statements without a legend because a preparation engagement provides no assurance.',
      D: 'Withdraw from the engagement and inform management of the reasons for withdrawing.',
    },
    explanation:
      'Option C is correct because it is the one course of action AR-C 70 does not allow. '
      + 'Financial statements prepared under AR-C 70 must state on each page, at a minimum, that '
      + 'no assurance is provided. Where the accountant is unable to include that statement — '
      + 'including because management refuses it — the standard gives three permitted responses, '
      + 'and issuing the statements with no legend at all is not among them. The accountant may '
      + 'issue a disclaimer that makes clear no assurance is provided (Option B), perform a '
      + 'compilation engagement under AR-C 80 (Option A), or withdraw from the engagement and '
      + 'tell management why (Option D). Because each of those three is expressly permitted, none '
      + 'of them can be the answer; only Option C departs from the standard, leaving readers with '
      + 'financial statements carrying no indication of the absence of assurance.',
  },
  'CPA/AUD-4': {
    why: 'key B is right, but the explanation did not address the misstatement already seen in the draft',
    explanation:
      'Option B is correct. Under AU-C 720 the auditor reads the other information in the annual '
      + 'report to identify material inconsistencies with the audited financial statements. Where '
      + 'some or all of that information will not be available until after the audit report '
      + 'release date, the auditor\'s report includes an Other Information section stating that '
      + 'the auditor expects to receive it after that date and will take appropriate action if a '
      + 'material misstatement is identified on reading it. That the auditor has already seen the '
      + '$48 million figure in a draft does not change the response: management has agreed to '
      + 'correct it, the document the section must address is the final annual report, and that '
      + 'document does not yet exist. Option A is wrong because an emphasis-of-matter section '
      + 'draws attention to something presented or disclosed in the audited financial statements, '
      + 'not to other information outside them. Option C is wrong because other information is '
      + 'not part of the financial statements and a misstatement in it does not affect the '
      + 'opinion on them. Option D is wrong because AU-C 720 requires the report to address the '
      + 'other information even though it is not audited.',
  },

  // ── Wording ───────────────────────────────────────────────────────────────
  'BAREXAM/undefined-57': {
    why: 'the consultant\'s counterparty was called "the client", which reads as the represented party',
    custom: (c) => {
      const before = String(c.stem ?? '');
      const after = before.replace('the client is a State B citizen', 'the customer is a State B citizen');
      if (after === before) return [];
      c.stem = after;
      return ['stem: renamed the counterparty "the customer" so it is not confused with the represented client'];
    },
  },
  'BAREXAM/undefined-69': {
    why: 'stem said "supplier" while two options said "wholesaler"',
    options: {
      A: 'Whether the supplier previously negotiated similar purchases directly with the warehouse supervisor.',
      C: 'Whether the company communicated conduct or information to the supplier suggesting the supervisor could place orders of this size.',
    },
  },
  'BAREXAM/undefined-84': {
    why: 'asked for a basis for action while the key advises declining to act',
    custom: (c) => {
      const before = String(c.stem ?? '');
      const after = before.replace(
        'Which of the following is the strongest basis for action by the corporation?',
        "What is the most appropriate advice to the board regarding the shareholder's proposed action?"
      );
      if (after === before) return [];
      c.stem = after;
      return ['stem: asked for advice rather than a basis for action, which is what the key gives'];
    },
  },
  'CFA/L3-PrWe-20': {
    why: 'sub-question 2 was a statement punctuated as a question',
    subQuestion: {
      number: 2,
      question: "Does Chen's referral disclosure to Weller violate the Standards?",
    },
  },
  'CPA/FAR-54': {
    why: 'schedule was a markdown table whose pipes ended up inside the selectable text',
    custom: (c) => {
      const changes: string[] = [];
      const sub = (c.sub_questions || [])[0];
      if (!sub) return changes;
      if (String(sub.document || '').includes('|')) {
        sub.document = FAR54_DOCUMENT;
        changes.push('document: rebuilt the schedule as a list so no table pipes remain');
      }
      let n = 0;
      for (const sp of (sub.spans || [])) {
        const before = JSON.stringify([sp.text, sp.correct, sp.options]);
        sp.text = depipe(String(sp.text ?? ''));
        sp.correct = depipe(String(sp.correct ?? ''));
        sp.options = (sp.options || []).map((o: unknown) => depipe(String(o ?? '')));
        if (JSON.stringify([sp.text, sp.correct, sp.options]) !== before) n++;
      }
      if (n) changes.push(`${n} span(s): replaced column pipes with readable separators`);
      // The keyed answers are stored on the sub-question too and must track the options.
      if (sub.correct_answer && typeof sub.correct_answer === 'object') {
        let k = 0;
        for (const [key, v] of Object.entries(sub.correct_answer as Record<string, unknown>)) {
          const to = depipe(String(v ?? ''));
          if (to === String(v ?? '')) continue;
          (sub.correct_answer as Record<string, unknown>)[key] = to;
          k++;
        }
        if (k) changes.push(`correct_answer: de-piped ${k} keyed answer(s) to match the options`);
      }
      return changes;
    },
  },
};

/**
 * Party renames the coherence gate found on its own, after the round-2 checks were added — not
 * reported by anyone. Keyed by question id rather than display index, because that is how a
 * check reports a finding.
 */
const ID_EDITS: Record<string, { options: Record<string, string>; why: string }> = {
  // Stem says "customer" throughout for the party that repudiated; only this option said "buyer".
  '9a2a81f2-3954-4cbe-bb88-fe3e798cda00': {
    why: 'stem calls the repudiating party the customer; this option called it the buyer',
    options: {
      C: "The seller should seek the entire contract price because the customer's cancellation transferred ownership of the generators.",
    },
  },
  // Stem says "wholesaler" five times; only this option said "supplier".
  '23b1fc4d-171f-4538-bb7e-866ef18c0d89': {
    why: 'stem calls the party the wholesaler; this option called it the supplier',
    options: {
      B: "The company is likely bound because its failure to notify the wholesaler allowed the manager's prior apparent authority to continue.",
    },
  },
};

async function main() {
  const edits: Array<{ ref: string; id: string; what: string[]; patch: Record<string, unknown> }> = [];
  const seenRefs = new Set<string>();

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
      const code = codeOf.get(String(q.tags?.exam || examOfSubject[q.subject] || '')) || 'ALL';
      const n = (seen.get(code) || 0) + 1;
      seen.set(code, n);
      const ref = `${label}/${code}-${n}`;
      const byId = ID_EDITS[q.id];
      const edit: Edit | undefined = EDITS[ref] || (byId ? { options: byId.options, why: byId.why } : undefined);
      if (!edit) continue;
      if (EDITS[ref]) seenRefs.add(ref);

      const content = JSON.parse(JSON.stringify(q.content ?? {}));
      const what: string[] = [];
      const patch: Record<string, unknown> = {};

      if (edit.stem && String(content.stem ?? '') !== edit.stem) {
        content.stem = edit.stem;
        what.push(`stem: ${edit.why}`);
      }

      if (edit.options) {
        const optCol: Record<string, string> = { ...(q.options || {}) };
        for (const [k, text] of Object.entries(edit.options)) {
          if (optCol[k] === text) continue;
          optCol[k] = text;
          const arr = (content.options as Array<Record<string, unknown>>) || [];
          const hit = arr.find((o) => String(o.key) === k);
          if (hit) hit.text = text;
          what.push(`option ${k}: replaced`);
        }
        patch.options = optCol;
      }

      if (edit.key) {
        const current = String(q.correct_option ?? content?.answer?.key ?? '');
        if (current === edit.key.to) {
          // already applied
        } else if (current !== edit.key.from) {
          console.log(`  !! ${ref} expected key ${edit.key.from} but found ${current} — key left alone`);
        } else {
          if (content.answer && typeof content.answer === 'object') content.answer.key = edit.key.to;
          patch.correct_option = edit.key.to;
          what.push(`re-keyed ${edit.key.from} -> ${edit.key.to}: ${edit.why}`);
        }
      }

      if (edit.explanation && String(content.explanation ?? '') !== edit.explanation) {
        content.explanation = edit.explanation;
        if (q.explanation != null) patch.explanation = edit.explanation;
        what.push('explanation: rewritten');
      }

      if (edit.subQuestion) {
        const sub = (content.sub_questions || []).find((s: any) => Number(s.number) === edit.subQuestion!.number);
        if (sub && String(sub.question ?? '') !== edit.subQuestion.question) {
          sub.question = edit.subQuestion.question;
          what.push(`sub-question ${edit.subQuestion.number}: ${edit.why}`);
        }
      }

      if (edit.custom) what.push(...edit.custom(content));

      if (!what.length) continue;
      patch.content = content;
      edits.push({ ref, id: q.id, what, patch });
    }
  }

  for (const ref of Object.keys(EDITS)) {
    if (!seenRefs.has(ref)) console.log(`  !! ${ref} did not resolve to a live question`);
  }

  console.log(`\n${APPLY ? 'APPLYING' : 'DRY RUN'} — ${edits.length} question(s) to change\n`);
  for (const e of edits) {
    console.log(`${e.ref}  ${e.id.slice(0, 8)}`);
    for (const w of e.what) console.log(`    - ${w}`);
  }

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
