/**
 * Repair CPA simulations that were generated and stored as case_study.
 *
 * The analysis named the format "Task-Based Simulation (TBS)" but emitted the slug
 * case_study, and resolveFormat took the slug (fixed forward in the contract
 * registry). These questions were therefore built to the wrong contract:
 *   - stored as case_study, where `exhibits` is optional rather than required
 *   - carrying task types a CPA simulation never uses — sequencing, and lettered
 *     multiple choice, which belongs to the MCQ testlets, not the work area
 *
 * Repair per question:
 *   1. drop sub-questions whose response model CPA does not use
 *   2. backfill to the original task count with entry/dropdown/classification tasks
 *      written from that question's OWN exhibits, so every answer stays derivable
 *   3. re-tag to task_based_simulation and move the narrative into `question`
 *      (TBS directions) while keeping the exhibits
 *   4. re-validate against the TBS schema; leave the question untouched on failure
 */
import 'dotenv/config';
import { supabase } from '../db/supabase.js';
import { fetchAllRows } from '../db/pagination.js';
import { orCall, MODELS } from '../services/llm/openrouter.js';
import { extractJsonArray } from '../services/review/shared.js';
import { buildContentSchema, normalizeSchemaParams } from '../services/generation/formatContracts.js';
import { schemaErrorsFor } from '../services/generation/schemaValidate.js';
import { gradabilityIssues } from '../services/review/shared.js';
import { enrichSubQuestion } from '../services/generation/questionGeneration.js';

const APPLY = process.argv.includes('--apply');
const LIMIT = Number((process.argv.find((a) => a.startsWith('--limit=')) || '').split('=')[1]) || 0;
const COURSE = 'dc805023-9958-463b-ad2c-54c67ed9b51a';
/** --only=<id prefix>  --force=<format>[:<grid_kind>] — steer one simulation's format. */
const ONLY = (process.argv.find((a) => a.startsWith('--only=')) || '').split('=')[1] || '';
const FORCE = (process.argv.find((a) => a.startsWith('--force=')) || '').split('=')[1] || '';
const CONCURRENCY = 5;
const MIX = process.argv.includes('--mix');
/** Re-run only the simulations a previous --mix pass skipped, keeping their assigned format. */
const REDO_SKIPPED = process.argv.includes('--redo-skipped');

/**
 * Target mix. Only one relative frequency is documented — the dropdown option grid
 * is the commonest TBS shape — so that anchors the top and the rest is ordered by
 * how often each appears in practice. Weights are applied to each SECTION's legal
 * formats and renormalised, which is what keeps journal entries out of AUD and
 * research out of ISC without a second rule.
 *
 * Left to choose freely the generator picked document_review for four simulations
 * in nine and option_grid for one — roughly the inverse of the real exam.
 */
const MIX_WEIGHTS: Record<string, number> = {
  'data_entry_grid:option_grid': 30,
  'document_review': 20,
  'data_entry_grid:numeric_entry': 15,
  'data_entry_grid:journal_entry': 15,
  'data_entry_grid:form': 12,
  'applied_research': 8,
};
const fmtKey = (f: Fmt) => (f.grid_kind ? `${f.id}:${f.grid_kind}` : f.id);

/** Largest-remainder allocation so a section's counts sum exactly to its simulations. */
function allocateMix(sec: string, n: number): string[] {
  const legal = formatsFor(sec).map(fmtKey);
  const total = legal.reduce((t, k) => t + (MIX_WEIGHTS[k] || 0), 0);
  const exact = legal.map((k) => ({ k, v: (n * (MIX_WEIGHTS[k] || 0)) / total }));
  const out = exact.map((e) => ({ k: e.k, n: Math.floor(e.v), r: e.v - Math.floor(e.v) }));
  let short = n - out.reduce((t, e) => t + e.n, 0);
  out.sort((a, b) => b.r - a.r);
  for (let i = 0; short > 0; i++, short--) out[i % out.length].n++;
  const list: string[] = [];
  // interleave rather than emitting all of one format in a block, so any partial run
  // still ends up with a representative spread
  const pools = out.filter((e) => e.n > 0).map((e) => ({ k: e.k, left: e.n }));
  while (list.length < n && pools.some((pl) => pl.left > 0)) {
    for (const pl of pools) if (pl.left > 0 && list.length < n) { list.push(pl.k); pl.left--; }
  }
  return list;
}

/**
 * The CPA format taxonomy, with the sections each format is actually set in.
 * A simulation is ONE of these, not a mix — partial credit is awarded per cell,
 * per line or per passage WITHIN the single task.
 */
type Fmt = { id: string; grid_kind?: string; label: string; sections: string[] | null; shape: string };
const FORMATS: Fmt[] = [
  { id: 'data_entry_grid', grid_kind: 'option_grid', label: 'Dropdown option grid — the commonest TBS shape', sections: null,
    shape: 'columns: [{"key":"answer","label":"<what is chosen>","input":"select","options":[<the candidate list, same for every row>]}], rows: [{"id":"1","label":"<the item being judged>"}, ...], correct_answer: {"1":{"answer":"<one of the options>"}, ...}' },
  { id: 'data_entry_grid', grid_kind: 'numeric_entry', label: 'Numeric entry — computed amounts typed into cells, no options', sections: null,
    shape: 'columns: [{"key":"amount","label":"Amount","input":"number","unit":"USD","precision":0}], rows: [{"id":"1","label":"<the amount being computed>"}, ...], correct_answer: {"1":{"amount":123456}, ...}' },
  { id: 'data_entry_grid', grid_kind: 'journal_entry', label: 'Journal entry — select accounts, enter debits and credits', sections: ['FAR', 'BAR', 'REG', 'TCP'],
    shape: 'columns: [{"key":"account","label":"Account","input":"select","options":[<chart of accounts>]},{"key":"debit","label":"Debit","input":"number","unit":"USD","precision":2},{"key":"credit","label":"Credit","input":"number","unit":"USD","precision":2}], rows: one per line across ALL entries, correct_answer keyed by row id, constraints: [{"type":"balanced","columns":["debit","credit"]}]. Several entries in one simulation is normal.' },
  { id: 'data_entry_grid', grid_kind: 'form', label: 'Form / schedule / reconciliation completion — line by line on a template', sections: ['REG', 'TCP', 'FAR', 'BAR'],
    shape: 'columns: [{"key":"amount","label":"Amount","input":"number","unit":"USD","precision":0}] — add a {"input":"select","options":[..]} column where the template asks the candidate to choose (a treatment, a code, a classification); rows: [{"id":"line1","label":"<the line exactly as the form names it>"}, ...]; rows the candidate is GIVEN carry "values":{"amount":12345} and "editable":false; correct_answer: {"line3":{"amount":98765}, ...} for the lines they complete. columns and rows are BOTH required.' },
  { id: 'document_review', label: 'Document review (DRS) — correct the passages of a real document', sections: null,
    shape: 'document: the full document as markdown with each reviewable passage wrapped [[span:1]]text[[/span]], spans: [{"id":"1","text":"...","options":["<replacement>","<replacement>","No change is required"],"correct":"..."}]. At least one span must already be correct.' },
  { id: 'applied_research', label: 'Applied research — apply a standards excerpt that is SUPPLIED', sections: ['AUD', 'FAR', 'REG'],
    shape: 'ONE object with: source (the standard the excerpt comes from, e.g. "AU-C 240.17"), excerpt (that authoritative text quoted verbatim as markdown — REQUIRED, or exhibit_label naming the exhibit carrying it), question (the framing), and items: [{"id":"1","prompt":"<what is asked of the excerpt>","options":["..",".."],"answer":"<one of the options>"}, ...] with 3-4 entries, each one scored response. NEVER ask the candidate to find or cite a reference — the excerpt is supplied.' },
];

/** Which CPA section a subject belongs to — it decides which formats are legal. */
const SECTION_RULES: Array<[RegExp, string]> = [
  [/ethics.*general principles|assessing risk|further procedures|forming conclusions/i, 'AUD'],
  [/financial reporting|balance sheet accounts|select transactions|state and local/i, 'FAR'],
  [/federal tax|business law|property transactions \(dis/i, 'REG'],
  [/business analysis|technical accounting/i, 'BAR'],
  [/information systems|security, confidentiality|soc engagements/i, 'ISC'],
  [/tax compliance|entity tax/i, 'TCP'],
];
const sectionOf = (subject: string) => SECTION_RULES.find(([rx]) => rx.test(subject || ''))?.[1] || 'OTHER';
const formatsFor = (sec: string) => FORMATS.filter((f) => !f.sections || f.sections.includes(sec));

function prompt(q: any, forcedKey?: string): string {
  const sec = sectionOf(q.subject);
  const legal = formatsFor(sec);
  const ex = (q.content?.exhibits || []).map((e: any) => `${e.label} — ${e.title} [${e.type}]\n${e.content}`).join('\n\n');
  // Left to choose freely the model reaches for the same two easy shapes, leaving
  // journal entry and applied research unrepresented. --force pins one simulation.
  const want = forcedKey || FORCE;
  const forced = want ? legal.filter((f) => fmtKey(f) === want || f.id === want) : [];
  const offer = forced.length ? forced : legal;
  const menu = offer.map((f, i) =>
    `${i + 1}. format_type "${f.id}"${f.grid_kind ? `, grid_kind "${f.grid_kind}"` : ''} — ${f.label}\n   ${f.shape}`).join('\n\n');

  return `You are rewriting the work area of a CPA Exam Task-Based Simulation in the ${sec} section.

A TBS is ONE task of ONE format, carrying roughly 5-10 gradable cells — partial credit is awarded per cell, per line or per passage inside that single task. It is NOT a set of mini-questions in assorted formats, and it never uses lettered A/B/C/D multiple choice or sequencing: those belong to the MCQ testlets.

DIRECTIONS ALREADY GIVEN TO THE CANDIDATE:
${q.content?.case_narrative || q.content?.question || q.question || ''}

EXHIBITS (the only facts available — every answer MUST be derivable from these):
${ex}

${forced.length ? `THIS SIMULATION MUST USE THIS FORMAT:` : `FORMATS SET IN ${sec} — choose the ONE these exhibits genuinely support:`}
${menu}

Write the work area as a JSON array containing EXACTLY ONE task object carrying 5-10 SCORING OPPORTUNITIES — counted the way this exam awards partial credit: per cell for an option grid or numeric entry, per LINE for a journal entry or a form/schedule, per passage for a document review, per entry in items[] for applied research. A journal entry of six lines is six scoring opportunities, not eighteen.

The simulation is ONE exam item, so it is ONE question with many scored entries — never Task 1 and Task 2 with separate directions. Several journal entries go in ONE grid, its rows labelled by entry ("Entry 1 — retainage", "Entry 2 — grant"); several questions on one standards excerpt go in ONE applied_research object as items[]. 
EVERY column with "input":"select" MUST carry its own "options" array — the candidate picks from that list, so a select column without options cannot be answered. Give a number column a unit and a precision.

Each object needs: number, question, format_type${legal.some((f) => f.grid_kind) ? ', grid_kind where the format has one' : ''}, rationale, reasoning_step, bloom_level, difficulty, plus the scaffolding and the answer key (correct_answer) shown for that format above.
Reference exhibits by their visible label ("Using Exhibit 2...").

Return ONLY the JSON array. No preamble, no markdown fences.`;
}

async function main() {
  const { data: jobs } = await supabase.from('qb_jobs').select('id')
    .eq('course_id', COURSE).order('created_at', { ascending: false }).limit(1);
  const jobId = (jobs as any[])[0].id;

  const all = await fetchAllRows<any>((from, to) =>
    supabase.from('qb_questions').select('*').eq('job_id', jobId).order('id').range(from, to));
  // Every simulation is rebuilt: the old work areas are six mixed mini-questions,
  // which is a different item type wearing the TBS name. There is nothing to keep.
  let targets = all.filter((r: any) => !r.replaced_by_id &&
    ['case_study', 'task_based_simulation'].includes(r.tags?.format_type));
  if (ONLY) targets = targets.filter((r: any) => String(r.id).startsWith(ONLY));
  if (LIMIT) targets = targets.slice(0, LIMIT);

  // A simulation this pass already rebuilt is a single question in one of the
  // current formats; anything else still carries the old six-mini-question work
  // area and is what --redo-skipped picks up.
  const CURRENT = new Set(['data_entry_grid', 'document_review', 'applied_research']);
  const rebuilt = (r: any) => {
    const subs = r.content?.sub_questions || [];
    return subs.length === 1 && CURRENT.has(subs[0]?.format_type);
  };

  // Assign each simulation its format up front, per section, so the finished bank
  // matches the exam's shape rather than the generator's preference.
  const assigned = new Map<string, string>();
  if (MIX || REDO_SKIPPED) {
    const bySection = new Map<string, any[]>();
    for (const q of targets) {
      const sec = sectionOf(q.subject);
      if (!bySection.has(sec)) bySection.set(sec, []);
      bySection.get(sec)!.push(q);
    }
    console.log('target mix by section:');
    for (const [sec, qs] of bySection) {
      const plan = allocateMix(sec, qs.length);
      qs.forEach((q, i) => assigned.set(q.id, plan[i]));
      const tally: Record<string, number> = {};
      for (const k of plan) tally[k] = (tally[k] || 0) + 1;
      console.log(`  ${sec.padEnd(5)} ${String(qs.length).padStart(3)} sims  ${Object.entries(tally).map(([k, v]) => `${k.replace('data_entry_grid:', '')} ${v}`).join(' · ')}`);
    }
    console.log('');
  }

  if (REDO_SKIPPED) {
    // The allocation above ran over ALL simulations in the same order, so each
    // skipped one keeps the format the full plan gave it — re-running a subset
    // never re-balances the bank.
    const before = targets.length;
    targets = targets.filter((r: any) => !rebuilt(r));
    console.log(`redoing ${targets.length} skipped of ${before}`);
  }

  console.log(`job ${jobId.slice(0, 8)} | ${targets.length} simulation(s)`);
  if (!APPLY) console.log('DRY RUN — no writes\n');

  const schema = buildContentSchema('task_based_simulation', normalizeSchemaParams({}));
  const guidelinesShim = { format_specs: { task_based_simulation: { content_schema: schema } } };
  let repaired = 0, failed = 0;
  const chosen: Record<string, number> = {};

  for (let i = 0; i < targets.length; i += CONCURRENCY) {
    await Promise.all(targets.slice(i, i + CONCURRENCY).map(async (q: any) => {
      const sec = sectionOf(q.subject);
      let tasks: any[] = [];
      try {
        const r = await orCall(MODELS.GENERATOR, '', prompt(q, assigned.get(q.id)), { maxTokens: 12000, temperature: 0.4 });
        tasks = extractJsonArray(r.content || '', 2)
          .filter((t: any) => formatsFor(sec).some((f) => f.id === t.format_type))
          .map((t: any, n: number) => enrichSubQuestion(t, n));
      } catch (e) {
        console.warn(`  ${q.id.slice(0, 8)}: generation failed — ${e instanceof Error ? e.message : e}`);
      }
      if (tasks.length === 0) { console.warn(`  ${q.id.slice(0, 8)} [${sec}]: no usable task — SKIPPED`); failed++; return; }

      // One simulation, one format. If the model mixed them, keep the first format
      // it chose rather than persisting a set the exam would never set.
      // One simulation is one exam item: a single work area, however many scored
      // entries it holds. Anything past the first object would read as a second
      // question on the same exhibits.
      const fmt = tasks[0].format_type, kind = tasks[0].grid_kind;
      const kept = [{ ...tasks[0], number: 1 }];
      if (tasks.length > 1) console.warn(`  ${q.id.slice(0, 8)}: model split the work across ${tasks.length} tasks — keeping the first`);

      const content = { ...q.content, sub_questions: kept,
        question: q.content?.question || q.content?.case_narrative || q.question || '' };
      delete (content as any).case_narrative;

      const errs = schemaErrorsFor(guidelinesShim, 'task_based_simulation', content);
      const gaps = gradabilityIssues({ ...q, content, tags: { ...q.tags, format_type: 'task_based_simulation' } });
      if (errs.length || gaps.length) {
        console.warn(`  ${q.id.slice(0, 8)} [${sec}]: ${[...errs, ...gaps].slice(0, 2).join('; ')} — SKIPPED`);
        failed++; return;
      }

      // Applied research has no per-cell unit — each question put to the excerpt is
      // one scored response, so a set of them is smaller than a grid of cells.
      const cells = cellCount(kept);
      const [lo, hi] = fmt === 'applied_research' ? [2, 8] : [4, 12];
      if (cells < lo || cells > hi) {
        console.warn(`  ${q.id.slice(0, 8)} [${sec}]: ${cells} scoring opportunities — outside ${lo}-${hi}, SKIPPED`);
        failed++; return;
      }
      const label = fmt + (kind ? `:${kind}` : '');
      chosen[label] = (chosen[label] || 0) + 1;
      if (APPLY) {
        const trail = [...(q.audit_trail || []), {
          phase: 'format_repair_v2', to: 'task_based_simulation', format: label,
          tasks: kept.length, cells: cellCount(kept),
          reason: 'A CPA TBS is one task of one format carrying 5-10 gradable cells; the previous work area was six mini-questions in mixed formats, including response models (matrix classification, lettered MCQ, sequencing) the exam does not set.',
          timestamp: new Date().toISOString(),
        }];
        const { error } = await supabase.from('qb_questions').update({
          content, audit_trail: trail,
          tags: { ...q.tags, format_type: 'task_based_simulation', schema_valid: true },
        }).eq('id', q.id);
        if (error) { console.error(`  ${q.id.slice(0, 8)}: write failed ${error.message}`); failed++; return; }
      }
      console.log(`  ${q.id.slice(0, 8)} [${sec}] ${label} — ${kept.length} task(s), ${cellCount(kept)} cells`);
      repaired++;
    }));
  }
  console.log(`\n${APPLY ? 'repaired' : 'would repair'}: ${repaired} | skipped: ${failed}`);
  console.log('formats chosen:', JSON.stringify(chosen));
}

/**
 * Scoring opportunities, counted in the unit the exam awards partial credit in:
 * per CELL for an option grid or numeric entry, per LINE for a journal entry or a
 * form/schedule, per PASSAGE for a document review. Counting a journal entry per
 * cell triple-counts it — account, debit and credit are one scored line.
 */
function cellCount(tasks: any[]): number {
  let n = 0;
  for (const t of tasks) {
    const key = t.correct_answer || {};
    if (t.format_type === 'data_entry_grid') {
      const perLine = ['journal_entry', 'form', 'schedule', 'reconciliation'].includes(String(t.grid_kind));
      if (perLine) n += Object.keys(key).length;
      else for (const r of Object.keys(key)) n += Object.keys(key[r] || {}).length;
    } else if (t.format_type === 'document_review') n += (t.spans || []).length;
    // applied research scores each question put to the shared excerpt
    else if (t.format_type === 'applied_research') n += Array.isArray(t.items) ? t.items.length : 1;
    else n += 1;
  }
  return n;
}

main().catch((e) => { console.error(e); process.exit(1); });
