/**
 * Third QA round: wrong answer keys, and questions no option answers.
 *
 * The tester solved every question blind and compared. Every claim was checked here against the
 * stored question before anything was changed, and every one held. Keyed by question id rather
 * than display index, because NCLEX's numbering runs one behind this pipeline's (their 43, 57 and
 * 73 are rows 44, 58 and 74) while every other course matches — an index is not a safe handle for
 * changing an answer.
 *
 * A pattern worth naming runs through the mis-keys: the explanation does the arithmetic correctly
 * and then states the opposite conclusion, or asserts a rule backwards. These are not arithmetic
 * slips a schema or a coherence check could see — the questions are well-formed and gradable, and
 * wrong.
 *
 *   L1 89      sets out systematic 0.05905 and total 0.06905, then reports the ratio as 73.02%.
 *              0.05905/0.06905 = 85.52%. The key followed the bad division.
 *   PoMa 7.4   computes 210 − 45 = 165 bp against a 175 bp CDS, concludes protection is expensive,
 *              and then recommends BUYING the bond. If protection is dear you sell it and short
 *              the bond that pays less.
 *   PrMa 5.2   adds distributions and deducts contributions, then describes the correct treatment
 *              as option A's error.
 *   PrMa 6.2   deducts the customer-support payroll although Exhibit 1 records it as already
 *              reducing reported EBITDA and recurring — counted twice, 17.5 became 16.3.
 *   TCP 49     says siblings are not related parties. IRC 267(c)(4) names brothers and sisters.
 *   Bar 119    defends a withdrawn partner's liability with general-partnership law. In a
 *              registered LLP there was no personal liability to survive the withdrawal.
 *   MCAT 54.1  calls water permeability "a measure of net osmotic water flow" to justify it
 *              falling when the gradient goes. Permeability is set by aquaporin insertion; the
 *              flow falls, the permeability does not.
 *
 * Where no option was right, the option carrying the wrong figure is corrected rather than a new
 * letter introduced, so each item keeps its key letter and its other distractors keep their
 * meaning. Where a stem contradicted itself or under-specified a rule, the stem moves.
 *
 * Dry run by default. Pass --apply.
 */
import 'dotenv/config';
import { supabase } from '../db/supabase.js';

const APPLY = process.argv.includes('--apply');

interface SubFix {
  number: number;
  key?: { from: string; to: string };
  /** Replace option text by zero-based index. */
  options?: Record<number, string>;
  rationale?: string;
}
interface Fix {
  id: string;
  label: string;
  why: string;
  /** Single-answer MCQ: correct_option and content.answer.key. */
  key?: { from: string; to: string };
  /** Select-two: content.answer.keys, plus correct_option which stores the first. */
  keys?: { from: string[]; to: string[] };
  /** Replace whole option text, by letter. */
  options?: Record<string, string>;
  /** Replace the stem. `from` must still be present, so a re-run cannot double-apply. */
  stem?: { contains: string; to: string };
  explanation?: string;
  subs?: SubFix[];
}

const FIXES: Fix[] = [
  // ── Wrong keys ────────────────────────────────────────────────────────────
  {
    id: '0960d774',
    label: 'Bar 119 — LLP liability',
    why: 'a registered LLP shields a partner who did not do the work, so withdrawal changes nothing; the LLP itself is liable on its own contract',
    keys: { from: ['C', 'E'], to: ['B', 'E'] },
    explanation:
      'B and E are correct. B is correct because the engagement agreement named the limited liability '
      + 'partnership as the architect and the negligent work was performed in the course of its business, '
      + 'so the partnership is liable on its own contract and for the conduct of its partner acting for it. '
      + 'E is correct because limited liability status never shields a partner from liability for that '
      + "partner's own negligence. C is incorrect because in a properly registered limited liability "
      + 'partnership a partner is not personally liable for partnership obligations in the first place, so '
      + 'there is no personal liability for a later withdrawal to carry forward; the rule that a withdrawing '
      + 'partner remains bound by obligations incurred while a partner belongs to a general partnership. '
      + 'A is incorrect for the same reason, since status as a partner alone creates no liability here. '
      + 'D is incorrect because a spouse who is not a partner owes the client no duty, and benefiting from '
      + 'distributions is not a basis for liability. F is incorrect because approving the choice of architect '
      + 'creates no duty to the client on the landlord.',
  },
  {
    id: '4c421ec8',
    label: 'TCP 49 — related-party loss',
    why: 'siblings ARE related parties under IRC 267(c)(4), so the loss is disallowed',
    key: { from: 'A', to: 'C' },
    explanation:
      'C is correct because IRC Section 267(a)(1) disallows a loss on a sale between related parties, and '
      + 'Section 267(c)(4) defines a member of the family to include brothers and sisters, whether of the '
      + 'whole or half blood. The sale to the brother therefore produces no recognized loss, and the '
      + "$30,000 is disallowed permanently to the seller rather than deferred. A is incorrect because it "
      + 'treats siblings as unrelated; they are expressly within the family definition. B is incorrect '
      + 'because investment stock is a capital asset, so any allowable loss would be capital rather than '
      + 'ordinary. D is incorrect because a disallowed related-party loss is not added to the buyer\'s basis; '
      + 'the brother takes a cost basis of $70,000, and Section 267(d) instead lets him reduce a later gain '
      + 'by the disallowed loss when he sells at a profit.',
  },
  {
    id: '8593bb88',
    label: 'L1 89 — systematic share of variance',
    why: 'the explanation divides 0.05905 by 0.06905 and reports 73.02%; it is 85.52%',
    key: { from: 'B', to: 'C' },
    options: {
      A: '14.48%',
      B: '92.47%',
      C: '85.52%',
    },
    explanation:
      'C is correct because systematic variance is 1.35² × 0.18² = 0.059049 and residual variance is '
      + '0.10² = 0.01, so total variance is 0.069049 and the systematic proportion is 0.059049 / 0.069049 '
      + '= 85.52%. A is incorrect because 14.48% is the residual, or nonsystematic, share of total variance, '
      + 'which is the complement of the amount asked for. B is incorrect because 92.47% divides systematic '
      + 'standard deviation by total standard deviation, 24.30% / 26.28%, comparing volatilities where the '
      + 'question asks for a share of variance.',
  },
  {
    id: 'a7ff349f',
    label: 'PoMa 7.4 — cash bond versus CDS',
    why: 'the rationale finds the bond pays 165 bp against 175 bp on the CDS and then recommends buying the bond',
    subs: [{
      number: 4,
      key: { from: 'C', to: 'B' },
      rationale:
        "B is correct because the bond's liquidity-adjusted credit spread is 210 − 45 = 165 bp, which is "
        + 'below the 175 bp CDS premium. Selling protection is therefore paid 10 bp more for the same credit '
        + 'risk than owning the bond is, so the cheap credit exposure is bought by selling CDS protection and '
        + 'the expensive one is sold by shorting the bond. A is wrong because buying protection alongside the '
        + 'bond pays away the dearer spread and earns the cheaper one, losing the basis rather than capturing '
        + 'it. C is wrong because it takes credit risk through the instrument that compensates less for it '
        + 'while paying to shed the same risk through the instrument that compensates more.',
    }],
  },
  {
    id: 'aab088b4',
    label: 'PrMa 5.2 — secondary closing payment',
    why: 'post-reference-date distributions reduce and contributions increase the payment; the rationale inverts both',
    subs: [{
      number: 2,
      key: { from: 'B', to: 'A' },
      rationale:
        'A is correct because the base price is 88% × USD60.0 million = USD52.8 million, from which the '
        + 'USD3.0 million of post-reference-date distributions is deducted, since the seller has already '
        + 'received that cash and the buyer does not, and to which the USD1.0 million post-reference-date '
        + 'contribution is added, since the seller funded capital the buyer acquires the benefit of: '
        + '52.8 − 3.0 + 1.0 = USD50.8 million. B is incorrect because it adds the distributions and deducts '
        + 'the contribution, paying the seller for cash already distributed away. C is incorrect because it '
        + 'applies no discount to the reference net asset value before adjusting for cash flows.',
    }],
  },
  {
    id: 'fd2d10ac',
    label: 'PrMa 6.2 / 6.3 — normalized EBITDA and debt capacity',
    why: 'the recurring payroll already reduces reported EBITDA per Exhibit 1, so deducting it again counts it twice',
    subs: [
      {
        number: 2,
        key: { from: 'B', to: 'C' },
        rationale:
          'C is correct because normalization adjusts reported EBITDA only for items that will not recur. '
          + 'The USD1.5 million litigation expense reduced reported EBITDA and is non-recurring, so it is '
          + 'added back. The USD2.0 million grant increased reported EBITDA and will not continue, so it is '
          + 'removed. The USD1.2 million of customer-support payroll also reduced reported EBITDA, but '
          + 'Exhibit 1 states the employees remain in place and the cost recurs annually, so it belongs in '
          + 'normalized earnings and no adjustment is made: USD18.0 + 1.5 − 2.0 = USD17.5 million. B is '
          + 'incorrect because it deducts that payroll a second time, when reported EBITDA is already net of '
          + 'it. A is incorrect because it removes the grant and the payroll but omits the litigation add-back.',
      },
      {
        number: 3,
        options: { 1: 'B. USD87.5 million.' },
        rationale:
          'B is correct because maximum debt financing is 5.0 × normalized EBITDA of USD17.5 million = '
          + 'USD87.5 million. A is incorrect because USD70.0 million is the existing interest-bearing debt '
          + 'balance rather than the capacity the multiple produces. C is incorrect because USD91.5 million '
          + 'applies the multiple to EBITDA that adds back the litigation expense and removes the recurring '
          + 'payroll while leaving the non-recurring grant in earnings.',
      },
    ],
  },
  {
    id: '0f4a41c5',
    label: 'MCAT 54.1 — permeability versus flow',
    why: 'permeability is set by aquaporin insertion; removing the osmotic gradient stops net flow, not permeability',
    subs: [{
      number: 1,
      key: { from: 'A', to: 'B' },
      rationale:
        'B is correct because desmopressin acts through cAMP to insert aquaporin-2 into the apical membrane, '
        + 'and it is that channel density that sets water permeability. Matching the basolateral solution to '
        + 'the apical one removes the osmotic driving force, so net water movement falls to zero, but the '
        + 'membrane remains just as permeable as before. A is incorrect because it confuses permeability, a '
        + 'property of the membrane, with the flow that a gradient drives across it; the flow falls to '
        + 'baseline while the permeability does not. C is incorrect because cAMP is generated by V2 receptor '
        + 'signalling and does not respond to the osmolality of the basolateral bath. D is incorrect because '
        + 'forskolin raises cAMP downstream of the receptor but the variant organoids still cannot traffic '
        + 'aquaporin-2 normally, so their permeability does not exceed stimulated wild-type organoids.',
    }],
  },

  // ── No option was correct ─────────────────────────────────────────────────
  {
    id: 'ea9fb469',
    label: 'FAR 57 — debt modification fees',
    why: 'a fee paid to the creditor in a modification is a discount and REDUCES the carrying amount to 1,950,000',
    options: { A: 'Debt carrying amount of $1,950,000 and current-period expense of $15,000' },
    explanation:
      'A is correct because a difference of less than 10% means the terms are not substantially different, '
      + 'so the transaction is a modification rather than an extinguishment and the debt is not remeasured to '
      + 'the present value of the modified cash flows. Under ASC 470-50-40-18, the $50,000 fee paid to the '
      + 'creditor is associated with the modified debt as a discount and amortized as interest expense over '
      + 'the remaining term, which reduces the carrying amount to $1,950,000, while the $15,000 paid to a '
      + 'third party is expensed as incurred. B is incorrect because it expenses the creditor fee instead of '
      + 'deferring it. C is incorrect because it defers the third-party cost, which the guidance requires to '
      + 'be expensed, and leaves the creditor fee out of the carrying amount. D is incorrect because '
      + '$1,850,000 remeasures the debt to the present value of the modified cash flows, which is only done '
      + 'when the modification is accounted for as an extinguishment.',
  },
  {
    id: 'f6f8e0f3',
    label: 'FAR 54 — extinguishment with third-party costs',
    why: 'third-party costs on an extinguishment are debt issuance costs presented as a deduction, so the debt is 992,000',
    options: { C: 'Account for the transaction as an extinguishment and report debt of $992,000' },
    explanation:
      'C is correct because a 12% difference exceeds the 10% threshold, so the terms are substantially '
      + 'different and the transaction is an extinguishment. The new debt is recognized at its $1,000,000 '
      + 'fair value, the $25,000 fee paid to the lender is included in the gain or loss on extinguishing the '
      + 'old debt under ASC 470-50-40-17, and the $8,000 of third-party legal costs are debt issuance costs '
      + 'of the new borrowing, presented as a direct deduction from its carrying amount under ASC 835-30-45-1A, '
      + 'giving $992,000. A and D are incorrect because a 12% difference rules out modification accounting. '
      + 'B is incorrect because it also deducts the lender fee from the carrying amount, when that fee belongs '
      + 'in the extinguishment gain or loss.',
  },
  {
    id: '131d7ee1',
    label: 'FAR 8 — capitalized interest in the cash flow statement',
    why: 'capitalized interest is an investing outflow and expensed interest an operating outflow; no single classification was right',
    options: { B: 'Investing cash outflow of $70,000 and operating cash outflow of $20,000' },
    explanation:
      'B is correct because the classification follows what the cash bought rather than the fact that it was '
      + 'interest. Under ASC 230-10-45-13, cash paid for interest that is capitalized as part of the cost of '
      + 'constructing property, plant and equipment is an investing outflow, so the $70,000 is investing, '
      + 'while interest recognized as expense is an operating outflow under ASC 230-10-45-17, so the $20,000 '
      + 'is operating. A is incorrect because repaying borrowings is financing but paying interest on them is '
      + 'not. C is incorrect because it treats the expensed portion as part of the asset. D is incorrect '
      + 'because cash was paid, so nothing here is a noncash activity.',
  },
  {
    id: '4485a5fc',
    label: 'REG 26 — S corporation per-share per-day allocation',
    why: 'the transferor is the shareholder for the day of the sale, so the buyer holds 183 days, not 184',
    options: { B: '$73,200' },
    explanation:
      'B is correct because the default allocation assigns the income equally to each day and then pro rata '
      + 'among the shares outstanding that day: $365,000 / 365 days / 100 shares = $10 per share per day. '
      + 'The transferor is treated as the shareholder for the day of the sale, so Casey holds the 40 shares '
      + 'from July 2 through December 31, which is 183 days: 40 × 183 × $10 = $73,200. A is incorrect '
      + 'because $72,400 counts 181 days, the period before the sale. C and D are incorrect because they '
      + 'allocate by ownership percentage or for the whole year without regard to the days each party held '
      + 'the shares.',
  },
  {
    id: '951df32e',
    label: 'REG 36 — S corporation allocation on a gift',
    why: 'the donor is the shareholder for the day of the gift, so Ava holds 100 shares for 121 days',
    options: { C: '$267,400' },
    explanation:
      'C is correct because income is assigned $10 per share per day, as $365,000 / 365 / 100. The donor is '
      + 'treated as the shareholder for the day of the transfer, so Ava owns all 100 shares from January 1 '
      + 'through May 1, which is 121 days, and 60 shares from May 2 through December 31, which is 244 days: '
      + '(100 × 121 × $10) + (60 × 244 × $10) = $121,000 + $146,400 = $267,400. A is incorrect because it '
      + 'allocates 60% of the year\'s income throughout. B is incorrect because it gives Ava 80% of the '
      + 'income, an average of her two ownership levels rather than a day-weighted allocation. D is '
      + 'incorrect because it ignores the gift entirely.',
  },
  {
    id: '435d57eb',
    label: 'AUD 8 — written representations',
    why: 'AR-C 80 compilations require no written representations; that requirement belongs to a review under AR-C 90',
    stem: {
      contains: 'engaged to compile a nonissuer',
      to:
        "An accountant engaged to review a nonissuer's GAAP financial statements requests the written "
        + 'representations required for the engagement. Management refuses to provide the representations but '
        + 'offers unrestricted access to its accounting records. Under the circumstances, what should the '
        + 'accountant do?',
    },
    options: { A: 'Complete the engagement and disclose the absence of representations in the review report' },
    explanation:
      'D is correct because AR-C 90 requires the accountant to obtain written representations from management '
      + 'for all periods covered by a review, and an unwillingness to provide them precludes completing the '
      + 'engagement, so the accountant withdraws and informs management why. Access to the accounting records '
      + 'is not a substitute: the representations confirm the assertions on which the review conclusion rests. '
      + 'A is incorrect because a review report cannot be issued at all without the representations, so '
      + 'disclosing their absence does not cure the scope limitation. B is incorrect because an '
      + 'emphasis-of-matter paragraph draws attention to something properly presented and cannot remedy a '
      + 'missing requirement. C is incorrect because changing the engagement requires management\'s agreement '
      + 'and a justifiable reason.',
  },
  {
    id: '4c5161c0',
    label: 'AUD 32 — COSO component',
    why: 'evaluating new guidance is risk assessment, which made two components defensible',
    stem: {
      contains: 'evaluates newly issued accounting guidance',
      to:
        'During planning of a nonissuer audit under GAAS, the auditor learns that the financial reporting '
        + 'manager prepares implementation memoranda explaining newly issued accounting guidance, trains '
        + 'affected accounting personnel, and distributes revised closing instructions before each reporting '
        + 'period. Which COSO component is most directly supported by these procedures?',
    },
  },
  {
    id: '6f0f76ac',
    label: 'FAR 28 — contract modification',
    why: 'the stem called the original units distinct and then said the added units are not distinct from them',
    stem: {
      contains: 'contracts to sell 100 distinct units',
      to:
        'A manufacturer contracts to sell 100 units of a customized product to a customer for $1,000 per '
        + 'unit. The units are highly interdependent and together produce a single combined output, so they '
        + 'are not distinct from one another. After 40 units have been delivered, the parties modify the '
        + 'contract to add 20 additional units at a price of $900 per unit, which does not reflect the '
        + 'standalone selling price of the remaining units. Under U.S. GAAP, how should the manufacturer '
        + 'account for the modification?',
    },
  },
  {
    id: '37789bc2',
    label: 'LSAT 44 — inference',
    why: 'the first premise covers selected documentaries, so nothing links the selected local-history films to independent production',
    stem: {
      contains: 'Some films concerning local history were selected',
      to:
        'Every documentary selected for the Norvale festival was produced independently. No independently '
        + 'produced film was financed entirely by a single television network. Some documentaries concerning '
        + 'local history were selected for the festival. Which one of the following is most strongly '
        + 'supported by the information above?',
    },
  },
  {
    id: '41541ecd',
    label: 'NCLEX 57 — hemolysed potassium',
    why: 'option B described discontinuing a lactated Ringer\'s infusion the stem never mentions',
    options: { B: 'Restrict the client\'s dietary potassium and recheck the level in 24 hours.' },
  },
  {
    id: '6f2e900c',
    label: 'NCLEX 43 — opioid respiratory depression',
    why: 'naloxone and bag-mask ventilation were both defensible as the first action',
    options: { B: 'Request a prescription for intravenous naloxone.' },
  },
  {
    id: 'b50181e0',
    label: 'MCAT 80.4 — buffering capacity',
    why: '7.9 is the pKa of the drug BX, not of the bicarbonate buffer, whose pKa is about 6.1',
    subs: [{
      number: 4,
      key: { from: 'C', to: 'A' },
      options: { 0: 'A. pH 7.0, because it is closest to the pKa of the bicarbonate buffer system' },
      rationale:
        'A is correct because buffering capacity is greatest when the solution pH is nearest the pKa of the '
        + 'buffer, where the conjugate acid and base are present in the most nearly equal amounts. The buffer '
        + 'here is bicarbonate, whose relevant pKa is about 6.1, so of the four solutions pH 7.0 lies closest '
        + 'to it and resists added acid or base best. C is incorrect because 7.9 is the pKa of BH+, the '
        + 'protonated drug, and has nothing to do with the capacity of the bicarbonate buffer holding the pH; '
        + 'confusing the pKa of the solute with that of the buffer is the trap. B is incorrect because '
        + 'proximity to physiological pH does not determine buffering capacity. D is incorrect because pH 8.4 '
        + 'is the farthest of the four from the buffer pKa and so the most weakly buffered.',
    }],
  },
];

/** The six jobs these questions live in. */
const JOBS = [
  'b777cd54-545f-480e-a49b-6b72ba8968c5', // CPA
  '074ac820-3fc6-43d3-9759-c534d3790448', // Bar
  '9eafe612-d53f-4efa-8445-2d30b68729a1', // CFA
  '9c01f36e-6ea0-45f7-8d07-d8d607422039', // LSAT
  '5071eac0-7ac1-4e61-ad22-62dc1b95c85a', // NCLEX
  '2317bc4a-5cdb-4582-b7ad-29fb566397c4', // MCAT
];

/**
 * Resolve 8-character id prefixes to full uuids in JS.
 *
 * Postgres will not LIKE a uuid column, and transcribing twenty full uuids by hand to work around
 * that is exactly how the wrong question's answer gets changed. A prefix that matches anything
 * other than exactly one row is reported and skipped rather than guessed at.
 */
async function resolvePrefixes(prefixes: string[]): Promise<Map<string, string>> {
  const { fetchAllRows } = await import('../db/pagination.js');
  const all: string[] = [];
  for (const job of JOBS) {
    const rows = await fetchAllRows<{ id: string }>((f, t) =>
      supabase.from('qb_questions').select('id').eq('job_id', job).range(f, t));
    all.push(...rows.map((r) => r.id));
  }
  const map = new Map<string, string>();
  for (const p of prefixes) {
    const hits = all.filter((id) => id.startsWith(p));
    if (hits.length === 1) map.set(p, hits[0]);
    else console.log(`  !! prefix ${p} matched ${hits.length} of ${all.length} ids — skipped`);
  }
  return map;
}

async function main() {
  const edits: Array<{ label: string; id: string; what: string[]; patch: Record<string, unknown> }> = [];
  const idOf = await resolvePrefixes(FIXES.map((f) => f.id));

  for (const fx of FIXES) {
    // Matched on the id PREFIX: the report identified questions by display index, and the ids were
    // read back from that resolution as 8-character prefixes. Requiring a full uuid here would mean
    // transcribing 20 of them by hand, which is a good way to change the wrong question's answer.
    const fullId = idOf.get(fx.id);
    if (!fullId) { console.log(`  !! ${fx.label}: prefix ${fx.id} unresolved — skipped`); continue; }
    const { data: row, error } = await supabase.from('qb_questions')
      .select('id,options,correct_option,explanation,content,status').eq('id', fullId).single();
    if (error || !row) { console.log(`  !! ${fx.label}: ${error?.message}`); continue; }

    const content = JSON.parse(JSON.stringify((row as any).content ?? {}));
    const patch: Record<string, unknown> = {};
    const what: string[] = [];

    if (fx.stem) {
      const cur = String(content.stem ?? '');
      if (cur === fx.stem.to) { /* already applied */ }
      else if (!cur.includes(fx.stem.contains)) console.log(`  !! ${fx.label}: stem lacks "${fx.stem.contains}" — skipped`);
      else { content.stem = fx.stem.to; what.push('stem rewritten'); }
    }

    if (fx.options) {
      const col: Record<string, string> = { ...((row as any).options || {}) };
      for (const [k, text] of Object.entries(fx.options)) {
        if (col[k] === text) continue;
        col[k] = text;
        const arr = (content.options as Array<Record<string, unknown>>) || [];
        const hit = arr.find((o) => String(o.key) === k);
        if (hit) hit.text = text;
        what.push(`option ${k} replaced`);
      }
      if (what.some((w) => w.startsWith('option'))) patch.options = col;
    }

    if (fx.key) {
      const cur = String((row as any).correct_option ?? content?.answer?.key ?? '');
      if (cur === fx.key.to) { /* already applied */ }
      else if (cur !== fx.key.from) console.log(`  !! ${fx.label}: key is ${cur}, expected ${fx.key.from} — key left alone`);
      else {
        if (content.answer && typeof content.answer === 'object') content.answer.key = fx.key.to;
        patch.correct_option = fx.key.to;
        what.push(`key ${fx.key.from} -> ${fx.key.to}`);
      }
    }

    if (fx.keys) {
      const cur: string[] = content?.answer?.keys ?? [];
      if (JSON.stringify(cur) === JSON.stringify(fx.keys.to)) { /* already applied */ }
      else if (JSON.stringify(cur) !== JSON.stringify(fx.keys.from)) {
        console.log(`  !! ${fx.label}: keys are ${JSON.stringify(cur)}, expected ${JSON.stringify(fx.keys.from)} — left alone`);
      } else {
        content.answer.keys = fx.keys.to;
        patch.correct_option = fx.keys.to[0];
        what.push(`keys ${fx.keys.from.join('+')} -> ${fx.keys.to.join('+')}`);
      }
    }

    if (fx.explanation && String(content.explanation ?? '') !== fx.explanation) {
      content.explanation = fx.explanation;
      if ((row as any).explanation != null) patch.explanation = fx.explanation;
      what.push('explanation rewritten');
    }

    for (const sf of fx.subs || []) {
      const sub = (content.sub_questions || []).find((s: any) => Number(s.number) === sf.number);
      if (!sub) { console.log(`  !! ${fx.label}: no sub-question ${sf.number}`); continue; }
      if (sf.options) {
        for (const [idx, text] of Object.entries(sf.options)) {
          const i = Number(idx);
          if (Array.isArray(sub.options) && sub.options[i] !== text) {
            sub.options[i] = text;
            what.push(`sub ${sf.number} option ${i} replaced`);
          }
        }
      }
      if (sf.key) {
        const cur = String(sub.correct_answer ?? '');
        if (cur === sf.key.to) { /* already applied */ }
        else if (cur !== sf.key.from) console.log(`  !! ${fx.label}: sub ${sf.number} key is ${cur}, expected ${sf.key.from} — left alone`);
        else { sub.correct_answer = sf.key.to; what.push(`sub ${sf.number} key ${sf.key.from} -> ${sf.key.to}`); }
      }
      if (sf.rationale && String(sub.rationale ?? '') !== sf.rationale) {
        sub.rationale = sf.rationale;
        what.push(`sub ${sf.number} rationale rewritten`);
      }
    }

    if (!what.length) continue;
    patch.content = content;
    // A changed key or option must be scored again rather than keep a stale approval.
    if ((row as any).status === 'approved') { patch.status = 'generated'; what.push('status -> generated for re-review'); }
    edits.push({ label: fx.label, id: fullId, what, patch });
  }

  console.log(`\n${APPLY ? 'APPLYING' : 'DRY RUN'} — ${edits.length} question(s) of ${FIXES.length}\n`);
  for (const e of edits) {
    console.log(`${e.label}  (${e.id.slice(0, 8)})`);
    for (const w of e.what) console.log(`    - ${w}`);
  }

  if (!APPLY) { console.log('\nRe-run with --apply, then resume each job from "reviewing".'); return; }
  let ok = 0;
  for (const e of edits) {
    const { error } = await supabase.from('qb_questions').update(e.patch).eq('id', e.id);
    if (error) console.log(`  FAILED ${e.label}: ${error.message}`);
    else ok++;
  }
  console.log(`\nwrote ${ok}/${edits.length}`);
}

await main();
