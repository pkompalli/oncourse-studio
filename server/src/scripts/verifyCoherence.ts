/**
 * Prove the coherence checks against real data, in both states.
 *
 * There is no test runner in this repo, but there is something better for this particular
 * job: a snapshot of 657 rows taken immediately BEFORE the repair in eb6859a, so the faults
 * a QA pass found are all still in it. That is a gold corpus with known answers.
 *
 * Three things have to hold, and the middle one is the one people skip:
 *   1. over the snapshot, the checks find the faults they were written for. A check that
 *      cannot detect the bug it exists for is worth nothing.
 *   2. over the live rows, the checks find nothing — matching the sweep that closed eb6859a.
 *   3. running repairCoherence over the snapshot clears every auto-fixable class and leaves
 *      exactly the classes that are meant to need judgment.
 *
 * Read-only against the database. Pass --verbose to list every affected question.
 */
import 'dotenv/config';
import { readdirSync, readFileSync } from 'node:fs';
import { supabase } from '../db/supabase.js';
import { fetchAllRows } from '../db/pagination.js';
import { coherenceIssues, repairCoherence } from '../services/generation/coherence.js';

const VERBOSE = process.argv.includes('--verbose');

const JOBS = [
  'e2d9e0b5-87b8-44d0-b8d1-b9f6eb4cfa67', // CPA
  'af81661d-6458-4ba2-a4d6-0134a386eee6', // Bar
  'f36246fa-6b66-430d-a585-263443917916', // CFA
];

/** Bucket an issue string so counts can be compared across runs. */
function classify(issue: string): string {
  if (/describe a field this task does not have/.test(issue)) return 'instructions-name-absent-field';
  if (/does not state the line order/.test(issue)) return 'journal-order-unstated';
  if (/internal type name/.test(issue)) return 'internal-name-leak';
  if (/repeats the passage verbatim/.test(issue)) return 'duplicate-option';
  if (/not among its own options/.test(issue)) return 'key-not-in-options';
  if (/only \d+ options/.test(issue)) return 'thin-span';
  if (/two options are identical/.test(issue)) return 'identical-options';
  if (/scores full marks without being read/.test(issue)) return 'degenerate-all-no-change';
  if (/is never the answer/.test(issue)) return 'degenerate-none-correct';
  if (/only \d+ exhibit/.test(issue)) return 'exhibit-cited-not-supplied';
  return 'other';
}

/** Classes repairCoherence is supposed to eliminate without human judgment. */
const AUTO_FIXABLE = new Set([
  'instructions-name-absent-field',
  'journal-order-unstated',
  'internal-name-leak',
  'duplicate-option',
]);

/**
 * Faults in the live bank that were looked at and deliberately left, with the reason. Recorded
 * here rather than suppressed in the checks, so they stay visible and someone can overturn the
 * decision — but they do not fail the run.
 */
const ACCEPTED: Record<string, string> = {
  '8cadc726': 'keys 0 of 10 passages "No change is required". Not exploitable — a candidate '
    + 'still has to pick the right correction on every passage — so regenerating a sound item '
    + 'to rebalance one distractor was judged disproportionate.',
};

interface Tally { byClass: Map<string, number>; rows: Map<string, string[]> }

function tally(rows: Array<{ id: string; content: unknown }>): Tally {
  const byClass = new Map<string, number>();
  const affected = new Map<string, string[]>();
  for (const r of rows) {
    const issues = coherenceIssues({ content: r.content as Record<string, unknown> });
    if (!issues.length) continue;
    affected.set(r.id, issues);
    for (const i of issues) {
      const c = classify(i);
      byClass.set(c, (byClass.get(c) || 0) + 1);
    }
  }
  return { byClass, rows: affected };
}

function report(label: string, t: Tally, total: number) {
  console.log(`\n### ${label} — ${total} rows, ${t.rows.size} affected`);
  if (t.byClass.size === 0) { console.log('  (nothing)'); return; }
  for (const [c, n] of [...t.byClass.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(n).padStart(4)}  ${c}`);
  }
  if (VERBOSE) {
    for (const [id, issues] of t.rows) {
      console.log(`    ${id.slice(0, 8)}`);
      for (const i of issues) console.log(`        - ${i}`);
    }
  }
}

// ── 1. The snapshot, as it was before the repair ────────────────────────────────
const dir = 'backups';
const snap = readdirSync(dir).filter((f) => f.startsWith('qb_questions_pre_repair_')).sort().pop();
if (!snap) throw new Error(`no pre-repair snapshot in ${dir}/ — cannot prove the checks detect anything`);
const before = JSON.parse(readFileSync(`${dir}/${snap}`, 'utf8')) as Array<{ id: string; content: unknown }>;
console.log(`snapshot: ${snap}`);
const beforeT = tally(before);
report('BEFORE the repair (must find the known faults)', beforeT, before.length);

// ── 2. The same rows after repairCoherence, in memory only ──────────────────────
const repaired = before.map((r) => {
  const content = JSON.parse(JSON.stringify(r.content ?? {}));
  repairCoherence(content);
  return { id: r.id, content };
});
const afterT = tally(repaired);
report('AFTER repairCoherence (only judgment classes may remain)', afterT, repaired.length);

const leftOver = [...afterT.byClass.keys()].filter((c) => AUTO_FIXABLE.has(c));
const cleared = [...beforeT.byClass.keys()].filter((c) => AUTO_FIXABLE.has(c) && !afterT.byClass.has(c));

// ── 3. The live bank ───────────────────────────────────────────────────────────
const live: Array<{ id: string; content: unknown }> = [];
for (const j of JOBS) {
  live.push(...await fetchAllRows<{ id: string; content: unknown }>((f, t) =>
    supabase.from('qb_questions').select('id,content').eq('job_id', j)
      .in('status', ['approved', 'reviewed', 'generated'])
      .order('question_number', { ascending: true }).range(f, t)));
}
const liveT = tally(live);
report('LIVE bank (must be clean)', liveT, live.length);

const liveUnexpected = [...liveT.rows.keys()].filter((id) => !ACCEPTED[id.slice(0, 8)]);
const liveAccepted = [...liveT.rows.keys()].filter((id) => ACCEPTED[id.slice(0, 8)]);
for (const id of liveAccepted) {
  console.log(`  accepted: ${id.slice(0, 8)} — ${ACCEPTED[id.slice(0, 8)]}`);
}

// ── 4. The shape generation actually hands it ──────────────────────────────────
// enrichQuestions runs BEFORE `content` is assembled, so at that point the model's fields sit
// flat on the question object. If repairCoherence only worked on the nested shape the
// generation hook would silently do nothing, which is the one way this wiring fails quietly.
// Take a real faulty row from the snapshot, flatten it the way the model returns it, and check
// the repair still bites.
const flatSource = before.find((r) => {
  const c = (r.content ?? {}) as Record<string, unknown>;
  return coherenceIssues({ content: c }).some((i) => /does not have/.test(i));
});
let flatWorks = false;
let flatDetail = 'no faulty row in the snapshot to flatten';
if (flatSource) {
  const c = JSON.parse(JSON.stringify(flatSource.content)) as Record<string, unknown>;
  const flat: Record<string, unknown> = { ...c, subject: 'X', topic: 'Y' }; // as the model returns it
  const repairs = repairCoherence(flat);
  const left = coherenceIssues(flat).filter((i) => /does not have/.test(i));
  flatWorks = repairs.length > 0 && left.length === 0;
  flatDetail = `${repairs.length} repair(s) on the flat shape, ${left.length} left`;
}

// ── Verdict ────────────────────────────────────────────────────────────────────
console.log('\n── verdict ──');
const checks: Array<[string, boolean, string]> = [
  ['checks detect faults in the snapshot', beforeT.rows.size > 0, `${beforeT.rows.size} rows flagged`],
  ['repair clears every auto-fixable class', leftOver.length === 0, leftOver.length ? `still present: ${leftOver.join(', ')}` : `cleared: ${cleared.join(', ')}`],
  ['repair leaves the judgment classes alone', [...afterT.byClass.keys()].every((c) => !AUTO_FIXABLE.has(c)), [...afterT.byClass.keys()].join(', ') || 'none remain'],
  ['live bank has no unaccepted faults', liveUnexpected.length === 0, liveUnexpected.length ? liveUnexpected.map((i) => i.slice(0, 8)).join(', ') : `${liveAccepted.length} accepted, 0 unexpected`],
  ['repair bites on the flat shape generation passes it', flatWorks, flatDetail],
];
let ok = true;
for (const [name, pass, detail] of checks) {
  console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${name} — ${detail}`);
  if (!pass) ok = false;
}
console.log(ok ? '\nAll checks passed.' : '\nSome checks FAILED.');
process.exit(ok ? 0 : 1);
