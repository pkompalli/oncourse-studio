/**
 * What was asked of the fixer, and what the fixer actually did.
 *
 * Audit exists to confirm the repairs were made correctly. It could not do that, because it was
 * never shown them: `getAuditPrompt` scored each question from scratch on its merits, and the
 * evidence it needed was sitting unread in the row. `reviewPipeline` already writes, for every
 * repair, the list of `changes_requested` and a before/after — and for every failure, a
 * `*_fix_failed` entry saying the change was never applied at all. Audit selected those columns
 * and dropped them on the floor.
 *
 * The consequence is quiet and bad. A change that was requested and silently not applied leaves
 * a question that reads well, scores nine on its merits, and still has the defect the validator
 * found. Nothing downstream ever looks again.
 *
 * This renders that history so the auditor can be asked the question it exists to answer: for
 * each change requested, was it applied, and is it now right?
 *
 * Which fields moved is computed here rather than left to the model. Whether the options array
 * differs between two snapshots is a fact, and a fact the auditor should be told rather than
 * asked to infer — its job is judging whether the change was CORRECT, not detecting whether one
 * occurred.
 */

interface TrailEntry {
  phase?: string;
  changes_requested?: string[];
  changes?: string[] | null;
  feedback?: string[];
  error?: string;
  success?: boolean;
  before?: Record<string, unknown>;
  after?: Record<string, unknown>;
  changed_fields?: string[];
  before_image?: string | null;
  after_image?: string | null;
  timestamp?: string;
}

const REPAIR_PHASES = new Set(['validator_fix', 'adversarial_fix']);
const FAILED_PHASES = new Set(['validator_fix_failed', 'adversarial_fix_failed']);
const IMAGE_PHASES = new Set(['validator_image_fix', 'adversarial_image_fix']);

/** The fields a repair is recorded against, in the order a reader wants them. */
const TRACKED = ['question', 'options', 'correct_option', 'explanation', 'content'] as const;

const stable = (v: unknown): string => {
  if (v === null || v === undefined) return '';
  return typeof v === 'string' ? v : JSON.stringify(v);
};

/**
 * Which tracked fields differ between two snapshots.
 *
 * Exported because reviewPipeline computes it at write time, where both objects are in hand and
 * `content` is still available. Older rows were written before that, and carry before/after for
 * the legacy columns only — for a grouped item, where the whole repair lives in `content`, those
 * columns can be identical on both sides of a real change. `changedFields` returning nothing is
 * therefore not evidence that nothing happened, and the rendering below says so rather than
 * letting the auditor read absence as proof.
 */
export function changedFields(before: Record<string, unknown> = {}, after: Record<string, unknown> = {}): string[] {
  const out: string[] = [];
  for (const f of TRACKED) {
    const b = stable(before[f]);
    const a = stable(after[f]);
    if (b === '' && a === '') continue;
    if (b !== a) out.push(f);
  }
  return out;
}

function describeMovement(e: TrailEntry): string {
  const recorded = e.changed_fields ?? changedFields(e.before || {}, e.after || {});
  if (recorded.length) {
    const parts = recorded.map((f) => {
      if (f === 'correct_option') {
        return `correct_option ${stable(e.before?.correct_option) || '(none)'} → ${stable(e.after?.correct_option) || '(none)'}`;
      }
      return `${f} changed`;
    });
    return `      fields that moved: ${parts.join(', ')}`;
  }
  // Nothing moved — but that is only evidence if the evidence was recorded.
  //
  // Entries written before `content` was captured hold the legacy columns alone, and for a
  // grouped item the whole repair lives in `content`, so both snapshots are identical across a
  // change that certainly happened. Reading that as "the fixer did nothing" would have the
  // auditor mark every such repair not_applied. 240 of the 1,164 live questions were repaired
  // and almost none of those entries carry content, so this distinction is the difference
  // between a working gate and a wall of false findings.
  const recordedContent = e.changed_fields !== undefined
    || (e.before !== undefined && Object.prototype.hasOwnProperty.call(e.before, 'content'));
  return recordedContent
    ? '      fields that moved: NONE — the fixer returned the question unchanged'
    : '      fields that moved: NOT RECORDED for this repair (the trail predates content capture) — judge the question itself, and do not treat this as evidence either way';
}

/**
 * Render one question's repair history, or null when it was never repaired.
 *
 * A question with no history needs no verification section — it is being audited on its merits
 * like any other, and saying "no repairs" for eight of ten questions in a batch is noise.
 */
export function fixHistoryBlock(question: Record<string, unknown>, label: string): string | null {
  const trail = Array.isArray(question.audit_trail) ? (question.audit_trail as TrailEntry[]) : [];
  if (!trail.length) return null;

  const lines: string[] = [];
  let repairs = 0;
  let failures = 0;

  for (const e of trail) {
    const phase = String(e.phase || '');

    if (REPAIR_PHASES.has(phase)) {
      repairs++;
      const asked = e.changes_requested || [];
      lines.push(`    [${phase}] ${asked.length} change(s) requested:`);
      asked.forEach((c, i) => lines.push(`      ${i + 1}. ${String(c).slice(0, 300)}`));
      lines.push(describeMovement(e));
      continue;
    }

    if (FAILED_PHASES.has(phase)) {
      failures++;
      const asked = e.changes_requested || [];
      lines.push(`    [${phase}] ⚠ THE REPAIR FAILED — these changes were NEVER APPLIED:`);
      asked.forEach((c, i) => lines.push(`      ${i + 1}. ${String(c).slice(0, 300)}`));
      if (e.error) lines.push(`      reason: ${String(e.error).slice(0, 200)}`);
      continue;
    }

    if (IMAGE_PHASES.has(phase)) {
      const ok = e.success === true;
      lines.push(`    [${phase}] image ${ok ? 'regenerated' : '⚠ REGENERATION FAILED — the old image is still attached'}`);
      for (const f of (e.feedback || []).slice(0, 4)) lines.push(`      • ${String(f).slice(0, 200)}`);
      if (!ok) failures++;
      continue;
    }
  }

  if (!lines.length) return null;

  const header = `  ${label} — ${repairs} repair(s) applied, ${failures} failed:`;
  return [header, ...lines].join('\n');
}

/**
 * Changes a repair attempt failed to apply, for every question in a batch.
 *
 * Used as a deterministic gate. A `*_fix_failed` entry is not an opinion about quality — the
 * fixer itself recorded that it could not make the change — so a question carrying one, with no
 * later successful repair, is flagged without consulting the auditor at all.
 */
export function unappliedChanges(question: Record<string, unknown>): string[] {
  const trail = Array.isArray(question.audit_trail) ? (question.audit_trail as TrailEntry[]) : [];
  if (!trail.length) return [];

  const out: string[] = [];
  trail.forEach((e, idx) => {
    const phase = String(e.phase || '');
    if (!FAILED_PHASES.has(phase)) return;
    // A later successful repair of the same stage supersedes the failure.
    const stage = phase.replace('_fix_failed', '');
    const repaired = trail.slice(idx + 1).some((later) => String(later.phase || '') === `${stage}_fix`);
    if (repaired) return;
    for (const c of e.changes_requested || []) out.push(String(c));
  });
  return out;
}
