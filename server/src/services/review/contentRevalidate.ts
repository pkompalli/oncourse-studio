/**
 * Content re-validation — a second-pass, format-aware content audit that runs on
 * ALL questions in a job (not just flagged), including already-APPROVED ones.
 *
 * The initial validator/adversarial/audit occasionally approve questions with
 * content defects the LLM missed (wrong distractor math, leaked exhibit slugs,
 * cross-task rule contradictions, inaccurate response_instructions, etc.). This
 * pass re-examines every question with the strengthened checks and fixes what it
 * finds, preserving gradability. It is resumable (marks tags.content_reviewed)
 * and tags anything it still can't auto-review as needs_manual_check.
 */
import { supabase } from '../../db/supabase.js';
import { brCall, MODELS } from '../llm/bedrock.js';
import { gradabilityIssues } from './shared.js';

const CONCURRENCY = 6;

type RevalStatus = {
  jobId: string;
  total: number;
  reviewed: number;
  changed: number;
  manualCheck: number;
  running: boolean;
  startedAt: string;
  finishedAt?: string;
};
const statuses = new Map<string, RevalStatus>();
export const getRevalidateStatus = (jobId: string) => statuses.get(jobId) || null;

function grabJson(raw: string): Record<string, unknown> | null {
  let s = raw || '';
  if (s.includes('```')) s = s.split('```')[1].replace(/^json/, '').split('```')[0];
  const m = s.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try { return JSON.parse(m[0]); } catch { return null; }
}

const isCase = (q: Record<string, any>) =>
  ['case_study', 'task_based_simulation', 'tbs'].includes(q.tags?.format_type || q.format_type);

const CASE_AUDIT = `Audit this case study for CONTENT correctness; fix genuine errors ONLY (preserve good content, keys, and gradability):
1) LEAKED SLUGS → reference exhibits by LABEL ("Exhibit 1") only.
2) DISTRACTOR↔RATIONALE: recompute each distractor; its value MUST equal the error its rationale describes.
3) MECHANICS: every sub-question must reflect the mechanics stated in the narrative (no physical-vs-cash mixups).
4) response_instructions: describe ONLY the response types present, with accepted formats.
5) NUMERIC options ascending by value.
6) RULE GROUNDING: any rule a key depends on must appear in an exhibit; add it if missing.`;

async function reviewCaseFull(q: Record<string, any>): Promise<{ nc: Record<string, unknown>; changed: boolean } | null> {
  const c = q.content || {};
  const prompt = `${CASE_AUDIT}
EXHIBITS:${JSON.stringify(c.exhibits || [])}
NARRATIVE:${String(c.case_narrative || '').slice(0, 1200)}
RESPONSE_INSTRUCTIONS:${c.response_instructions || ''}
SUB_QUESTIONS:${JSON.stringify(c.sub_questions || [])}
Return ONLY JSON {"changed":bool,"exhibits":[...],"sub_questions":[...],"response_instructions":"..."}.`;
  const r = await brCall(MODELS.AUDITOR, '', prompt, { maxTokens: 26000, thinking: true });
  const p = grabJson(r.content);
  if (!p?.sub_questions) return null;
  const nc = { ...c, exhibits: p.exhibits || c.exhibits, sub_questions: p.sub_questions, response_instructions: p.response_instructions ?? c.response_instructions };
  return gradabilityIssues({ ...q, content: nc }).length === 0 ? { nc, changed: !!p.changed } : null;
}

// Fallback for very large cases whose full-review output won't fit: review the
// sub-questions in small chunks (exhibits provided as shared context) and merge.
async function reviewCaseChunked(q: Record<string, any>): Promise<{ nc: Record<string, unknown>; changed: boolean } | null> {
  const c = q.content || {};
  const subs = (c.sub_questions as Record<string, unknown>[]) || [];
  if (subs.length === 0) return null;
  const CHUNK = 2;
  const fixed: Record<string, unknown>[] = [];
  let changed = false;
  for (let i = 0; i < subs.length; i += CHUNK) {
    const slice = subs.slice(i, i + CHUNK);
    const prompt = `${CASE_AUDIT}
(You are auditing sub-questions ${i + 1}-${i + slice.length} of a larger case. Exhibits and narrative are shared context.)
EXHIBITS:${JSON.stringify(c.exhibits || [])}
NARRATIVE:${String(c.case_narrative || '').slice(0, 1200)}
SUB_QUESTIONS:${JSON.stringify(slice)}
Return ONLY JSON {"changed":bool,"sub_questions":[...]} with exactly these ${slice.length} sub-question(s), keeping structure/keys.`;
    const r = await brCall(MODELS.AUDITOR, '', prompt, { maxTokens: 12000, thinking: true });
    const p = grabJson(r.content);
    const subsOut = p?.sub_questions as Record<string, unknown>[] | undefined;
    if (subsOut && subsOut.length === slice.length) { fixed.push(...subsOut); if (p!.changed) changed = true; }
    else fixed.push(...slice); // keep originals for this chunk
  }
  const nc = { ...c, sub_questions: fixed };
  return gradabilityIssues({ ...q, content: nc }).length === 0 ? { nc, changed } : null;
}

async function reviewStandalone(q: Record<string, any>): Promise<{ nc: Record<string, unknown>; changed: boolean } | null> {
  const c = q.content || {};
  const prompt = `Audit this standalone ${q.tags?.format_type || q.format_type} question; fix genuine errors ONLY:
1) DISTRACTOR↔RATIONALE recompute; each value must match the error its explanation describes.
2) NUMERIC options ascending by value (relabel letters + correct answer to match).
3) No leaked internal ids/slugs in candidate-visible text.
4) The correct answer must be factually right and unambiguous.
STEM:${c.stem || q.question || ''}
OPTIONS:${JSON.stringify(c.options || q.options)}
ANSWER:${JSON.stringify(c.answer || q.correct_option)}
EXPLANATION:${String(c.explanation || q.explanation || '').slice(0, 900)}
Return ONLY JSON {"changed":bool,"stem":"...","options":[{"key","text"}],"answer":{...},"explanation":"..."}.`;
  const r = await brCall(MODELS.AUDITOR, '', prompt, { maxTokens: 3500 });
  const p = grabJson(r.content);
  if (!p) return null;
  const nc = { ...c, stem: p.stem ?? c.stem, options: p.options ?? c.options, answer: p.answer ?? c.answer, explanation: p.explanation ?? c.explanation };
  return gradabilityIssues({ ...q, content: nc }).length === 0 ? { nc, changed: !!p.changed } : null;
}

export async function revalidateContentForJob(jobId: string): Promise<void> {
  const st: RevalStatus = { jobId, total: 0, reviewed: 0, changed: 0, manualCheck: 0, running: true, startedAt: new Date().toISOString() };
  statuses.set(jobId, st);
  try {
    const { data: qs } = await supabase.from('qb_questions').select('*').eq('job_id', jobId).is('replaced_by_id', null);
    const todo = (qs || []).filter((q: any) => q.tags?.content_reviewed !== true);
    st.total = todo.length;

    let idx = 0;
    const worker = async () => {
      while (idx < todo.length) {
        const q = todo[idx++];
        try {
          let res = isCase(q) ? await reviewCaseFull(q) : await reviewStandalone(q);
          if (!res && isCase(q)) res = await reviewCaseChunked(q); // large-case fallback
          if (res) {
            const tags = { ...(q.tags || {}), content_reviewed: true };
            delete (tags as any).content_review_status;
            await supabase.from('qb_questions').update({ content: res.changed ? res.nc : q.content, tags }).eq('id', q.id);
            st.reviewed++; if (res.changed) st.changed++;
          } else {
            const tags = { ...(q.tags || {}), content_review_status: 'needs_manual_check' };
            await supabase.from('qb_questions').update({ tags }).eq('id', q.id);
            st.manualCheck++;
          }
        } catch { st.manualCheck++; }
      }
    };
    await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  } finally {
    st.running = false;
    st.finishedAt = new Date().toISOString();
  }
}
