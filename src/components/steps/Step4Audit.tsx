import { useState, useEffect, useRef } from 'react';
import { useAppStore } from '../../store/appStore';
import { jobs, questions as questionsApi } from '../../services/api';
import { supabase } from '../../services/supabase';
import type { Job, Question } from '../../types';
import { Loader2, CheckCircle2, AlertTriangle, Play, Clock, Trash2, ChevronDown, ChevronUp, ImageIcon } from 'lucide-react';
import QuestionImage from '../common/QuestionImage';
import QuestionRenderer from '../common/QuestionRenderer';
import { useSnapshots, groupSnapshotsBySubject, STAGE_LABELS } from '../../hooks/useSnapshots';
import type { SnapshotStage } from '../../hooks/useSnapshots';
import StageSelector from '../common/StageSelector';
import TokenUsage from '../common/TokenUsage';
import { displayStatus } from '../../utils/questionStatus';

interface SubjectStatus {
  subject: string;
  count: number;
  audited: number;
  approved: number;
  flagged: number;
  status: 'pending' | 'auditing' | 'done';
}

interface AuditProgress {
  step: string;
  audited: number;
  approved: number;
  flagged: number;
  total: number;
  batchesTotal: number;
  batchesDone: number;
  events: string[];
  subjects: SubjectStatus[];
}

export default function Step4Audit() {
  const { job, setJob, questions, setQuestions, completeStep, setStep } = useAppStore();
  const [progress, setProgress] = useState<AuditProgress | null>(null);
  const [overallStatus, setOverallStatus] = useState<'idle' | 'running' | 'done' | 'error'>('idle');
  const [loadingQuestions, setLoadingQuestions] = useState(false);
  const [expandedSubject, setExpandedSubject] = useState<string | null>(null);
  const [viewStage, setViewStage] = useState<SnapshotStage | null>(null);
  const { snapshotQuestions, loading: snapshotLoading, availableStages } = useSnapshots(job?.id, viewStage);
  const channelRef = useRef<ReturnType<typeof supabase.channel> | null>(null);
  const pollingRef = useRef(false);
  const feedRef = useRef<HTMLDivElement>(null);

  const isComplete = useAppStore((s) => s.completedSteps.has('audit'));

  useEffect(() => {
    return () => {
      pollingRef.current = false;
      if (channelRef.current) {
        supabase.removeChannel(channelRef.current);
      }
    };
  }, []);

  useEffect(() => {
    if (feedRef.current) {
      feedRef.current.scrollTop = feedRef.current.scrollHeight;
    }
  }, [progress?.events]);

  // Auto-start if job is in auditing status
  useEffect(() => {
    if (job && job.status === 'auditing' && overallStatus === 'idle' && !isComplete) {
      startAudit();
    }
    if (job && job.status === 'complete' && overallStatus === 'idle') {
      setOverallStatus('done');
      const prog = job.progress as Record<string, unknown> | undefined;
      setProgress((prev) => prev || {
        step: 'Audit already complete',
        audited: (prog?.audited as number) || 0,
        approved: (prog?.approved as number) || 0,
        flagged: (prog?.flagged as number) || 0,
        total: (prog?.total as number) || 0,
        batchesTotal: 0,
        batchesDone: 0,
        events: [],
        subjects: (prog?.subjects as SubjectStatus[]) || [],
      });
      loadQuestions();
      completeStep('audit');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [job?.status]);

  const loadQuestions = async () => {
    if (!job) return;
    setLoadingQuestions(true);
    try {
      const res = await questionsApi.list(job.id);
      setQuestions(res.questions as Question[]);
    } catch {
      // silent
    } finally {
      setLoadingQuestions(false);
    }
  };

  const subscribeToJob = (jobId: string) => {
    const channel = supabase
      .channel(`audit:${jobId}`)
      .on('postgres_changes', {
        event: 'UPDATE',
        schema: 'public',
        table: 'qb_jobs',
        filter: `id=eq.${jobId}`,
      }, (payload) => {
        const updated = payload.new as Job;
        setJob(updated);

        const prog = updated.progress as Record<string, unknown> | undefined;
        if (prog) {
          setProgress({
            step: (prog.step as string) || '',
            audited: (prog.audited as number) || 0,
            approved: (prog.approved as number) || 0,
            flagged: (prog.flagged as number) || 0,
            total: (prog.total as number) || 0,
            batchesTotal: (prog.batches_total as number) || 0,
            batchesDone: (prog.batches_done as number) || 0,
            events: (prog.events as string[]) || [],
            subjects: (prog.subjects as SubjectStatus[]) || [],
          });
        }

        if (updated.status === 'complete') {
          pollingRef.current = false;
          setOverallStatus('done');
          completeStep('audit');
          loadQuestions();
        }
        if (updated.status === 'failed') {
          pollingRef.current = false;
          setOverallStatus('error');
        }
      })
      .subscribe();

    channelRef.current = channel;
  };

  const startAudit = async () => {
    if (!job) return;
    setOverallStatus('running');
    setProgress({ step: 'Starting quality gate audit...', audited: 0, approved: 0, flagged: 0, total: 0, batchesTotal: 0, batchesDone: 0, events: ['Starting quality gate audit...'], subjects: [] });

    subscribeToJob(job.id);
    pollingRef.current = true;
    pollAudit(job.id);
  };

  const pollAudit = async (jobId: string) => {
    if (!pollingRef.current) return;
    try {
      const res = await jobs.nextBatch(jobId, 'audit');
      const br = res.batch_result as Record<string, unknown> | undefined;

      if (br) {
        setProgress({
          step: (br.step as string) || '',
          audited: (br.audited as number) || 0,
          approved: (br.approved as number) || 0,
          flagged: (br.flagged as number) || 0,
          total: (br.total as number) || 0,
          batchesTotal: (br.batches_total as number) || 0,
          batchesDone: (br.batches_done as number) || 0,
          events: (br.events as string[]) || [],
          subjects: (br.subjects as SubjectStatus[]) || [],
        });
      }

      if (res.status === 'complete') {
        pollingRef.current = false;
        setOverallStatus('done');
        completeStep('audit');
        loadQuestions();
        return;
      }

      if (res.status === 'failed') {
        pollingRef.current = false;
        setOverallStatus('error');
        return;
      }

      setTimeout(() => pollAudit(jobId), 3000);
    } catch {
      setTimeout(() => pollAudit(jobId), 5000);
    }
  };

  const deleteQuestion = async (qId: string) => {
    if (!confirm('Delete this question?')) return;
    try {
      await questionsApi.delete(qId);
      setQuestions(questions.filter((q) => q.id !== qId));
    } catch { /* silent */ }
  };

  // Compute summary: prefer counting from loaded questions (most accurate), fall back to progress
  const approvedFromQuestions = questions.filter((q) => displayStatus(q as Record<string, unknown>) === 'approved').length;
  const flaggedFromQuestions = questions.filter((q) => displayStatus(q as Record<string, unknown>) === 'flagged').length;
  const summaryTotal = questions.length || progress?.total || 0;
  const summaryApproved = approvedFromQuestions || progress?.approved || 0;
  const summaryFlagged = flaggedFromQuestions || progress?.flagged || 0;

  const batchPct = progress && progress.batchesTotal > 0
    ? Math.round((progress.batchesDone / progress.batchesTotal) * 100)
    : 0;

  // Group questions by subject for drill-down
  const questionsBySubject = new Map<string, Question[]>();
  for (const q of questions) {
    const subj = q.subject || 'Unknown';
    if (!questionsBySubject.has(subj)) questionsBySubject.set(subj, []);
    questionsBySubject.get(subj)!.push(q);
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold text-slate-800">Quality Gate Audit</h2>
          <p className="text-sm text-slate-500 mt-1">
            Score each item 1-10. Items scoring &le;7 will be flagged for replacement.
          </p>
        </div>
        <div className="flex gap-3">
          {overallStatus === 'idle' && !isComplete && (
            <button
              onClick={startAudit}
              className="flex items-center gap-2 px-5 py-2 bg-indigo-600 text-white rounded-lg font-medium hover:bg-indigo-700 transition-colors"
            >
              <Play className="w-4 h-4" /> Run Audit
            </button>
          )}
          {(overallStatus === 'done' || isComplete) && (
            <button
              onClick={() => setStep('export')}
              className="flex items-center gap-2 px-5 py-2 bg-green-600 text-white rounded-lg font-medium hover:bg-green-700 transition-colors"
            >
              <CheckCircle2 className="w-4 h-4" /> Proceed to Export
            </button>
          )}
        </div>
      </div>

      {/* Current Step */}
      {overallStatus === 'running' && progress?.step && (
        <div className="p-4 rounded-lg border border-blue-200 bg-blue-50">
          <div className="flex items-center gap-3">
            <Loader2 className="w-5 h-5 text-blue-600 animate-spin shrink-0" />
            <span className="text-sm font-medium text-blue-800">{progress.step}</span>
          </div>
          {progress.batchesTotal > 0 && (
            <div className="mt-2">
              <div className="w-full bg-blue-100 rounded-full h-2">
                <div className="bg-blue-500 h-2 rounded-full transition-all duration-500" style={{ width: `${batchPct}%` }} />
              </div>
              <div className="text-xs text-blue-600 mt-1">
                {progress.batchesDone}/{progress.batchesTotal} batches
                {progress.audited > 0 && ` · ${progress.audited}/${progress.total} scored`}
                {progress.approved > 0 && ` · ${progress.approved} approved`}
                {progress.flagged > 0 && ` · ${progress.flagged} flagged`}
              </div>
            </div>
          )}
        </div>
      )}

      {overallStatus === 'error' && progress?.step && (
        <div className="p-4 rounded-lg border border-red-200 bg-red-50">
          <div className="flex items-center gap-3">
            <AlertTriangle className="w-5 h-5 text-red-600 shrink-0" />
            <span className="text-sm font-medium text-red-800">{progress.step}</span>
          </div>
        </div>
      )}

      {overallStatus === 'done' && progress?.step && (
        <div className="p-4 rounded-lg border border-green-200 bg-green-50">
          <div className="flex items-center gap-3">
            <CheckCircle2 className="w-5 h-5 text-green-600 shrink-0" />
            <span className="text-sm font-medium text-green-800">{progress.step}</span>
          </div>
          {(job?.progress as Record<string, unknown>)?.token_usage && (
            <div className="mt-2 space-y-0.5">
              <TokenUsage label="Generation" data={((job?.progress as Record<string, unknown>)?.token_usage as Record<string, unknown>)?.generation as { prompt_tokens: number; completion_tokens: number; total_tokens: number; calls: number } | undefined} />
              <TokenUsage label="Review" data={((job?.progress as Record<string, unknown>)?.token_usage as Record<string, unknown>)?.review as { prompt_tokens: number; completion_tokens: number; total_tokens: number; calls: number } | undefined} />
              <TokenUsage label="Audit" data={((job?.progress as Record<string, unknown>)?.token_usage as Record<string, unknown>)?.audit as { prompt_tokens: number; completion_tokens: number; total_tokens: number; calls: number } | undefined} />
            </div>
          )}
        </div>
      )}

      {/* Audit Summary — uses progress counts as fallback */}
      {(overallStatus === 'done' || isComplete) && summaryTotal > 0 && (
        <div className="grid grid-cols-3 gap-4">
          <div className="bg-white p-5 rounded-xl border border-slate-200 text-center">
            <div className="text-2xl font-bold text-slate-800">{summaryTotal}</div>
            <div className="text-sm text-slate-500">Total</div>
          </div>
          <div className="bg-green-50 p-5 rounded-xl border border-green-200 text-center">
            <div className="text-2xl font-bold text-green-700">{summaryApproved}</div>
            <div className="text-sm text-green-600">Approved (&gt;7)</div>
          </div>
          <div className="bg-amber-50 p-5 rounded-xl border border-amber-200 text-center">
            <div className="text-2xl font-bold text-amber-700">{summaryFlagged}</div>
            <div className="text-sm text-amber-600">Flagged (&le;7)</div>
          </div>
        </div>
      )}

      {/* Subject Cards — clickable to expand questions */}
      {(() => {
        const useSnapshot = viewStage && snapshotQuestions && snapshotQuestions.length > 0;
        const snapshotBySubject = useSnapshot ? groupSnapshotsBySubject(snapshotQuestions!) : null;
        const drillDownBySubject = snapshotBySubject || questionsBySubject;

        // Use progress.subjects if available, otherwise build from questions/snapshots
        const subjectCards: SubjectStatus[] = (progress?.subjects && progress.subjects.length > 0)
          ? progress.subjects
          : Array.from((snapshotBySubject || questionsBySubject).entries()).map(([subject, qs]) => ({
              subject,
              count: qs.length,
              audited: qs.length,
              approved: qs.filter((q) => displayStatus(q) === 'approved').length,
              flagged: qs.filter((q) => displayStatus(q) === 'flagged').length,
              status: 'done' as const,
            }));

        if (subjectCards.length === 0) return null;

        return (
        <div className="space-y-2">
          <div className="flex items-center justify-between flex-wrap gap-2">
            <h3 className="text-sm font-medium text-slate-600">
              {overallStatus === 'running' ? 'Subject Progress' : 'Results by Subject (click to expand)'}
            </h3>
            {overallStatus !== 'running' && (
              <StageSelector
                availableStages={availableStages}
                currentStage={viewStage}
                onStageChange={setViewStage}
                loading={snapshotLoading}
                defaultLabel="Latest"
              />
            )}
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
            {subjectCards.map((sp) => {
              const isExpanded = expandedSubject === sp.subject;
              const drillItems = drillDownBySubject instanceof Map ? (drillDownBySubject.get(sp.subject) || []) : [];
              const canExpand = drillItems.length > 0 && overallStatus !== 'running';

              return (
                <div key={sp.subject} className="col-span-1">
                  <div
                    onClick={() => canExpand && setExpandedSubject(isExpanded ? null : sp.subject)}
                    className={`p-4 rounded-lg border transition-colors ${
                      sp.status === 'auditing' ? 'border-indigo-300 bg-indigo-50' :
                      sp.status === 'done' ? 'border-green-300 bg-green-50' :
                      'border-slate-200 bg-white'
                    } ${canExpand ? 'cursor-pointer hover:shadow-sm' : ''}`}
                  >
                    <div className="flex items-center justify-between">
                      <span className="text-sm font-medium text-slate-700 truncate">{sp.subject}</span>
                      <div className="flex items-center gap-1">
                        {sp.status === 'pending' && <Clock className="w-4 h-4 text-slate-300" />}
                        {sp.status === 'auditing' && <Loader2 className="w-4 h-4 text-indigo-500 animate-spin" />}
                        {sp.status === 'done' && <CheckCircle2 className="w-4 h-4 text-green-500" />}
                        {canExpand && (isExpanded
                          ? <ChevronUp className="w-4 h-4 text-slate-400" />
                          : <ChevronDown className="w-4 h-4 text-slate-400" />
                        )}
                      </div>
                    </div>
                    <div className="flex items-center gap-3 mt-1">
                      <span className="text-xs text-slate-500">{sp.count} Qs</span>
                      {sp.approved > 0 && <span className="text-xs text-green-600">{sp.approved} approved</span>}
                      {sp.flagged > 0 && <span className="text-xs text-amber-600">{sp.flagged} flagged</span>}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>

          {/* Expanded subject questions */}
          {expandedSubject && (() => {
            const items = drillDownBySubject instanceof Map ? (drillDownBySubject.get(expandedSubject) || []) : [];
            if (items.length === 0) return null;
            return (
            <div className="mt-3 p-4 rounded-lg border border-slate-200 bg-white space-y-2">
              <div className="flex items-center justify-between mb-2">
                <h4 className="text-sm font-semibold text-slate-700">
                  {expandedSubject} — Questions
                  {viewStage && <span className="ml-2 text-xs font-normal text-indigo-500">({STAGE_LABELS[viewStage]})</span>}
                </h4>
                <button onClick={() => setExpandedSubject(null)} className="text-xs text-slate-400 hover:text-slate-600">Close</button>
              </div>
              {items.map((q: Record<string, unknown>, i: number) => (
                <div
                  key={(q.id as string) || (q.question_id as string) || i}
                  className={`p-3 rounded-lg border ${
                    displayStatus(q) === 'approved' ? 'border-green-200 bg-green-50' :
                    displayStatus(q) === 'flagged' ? 'border-amber-200 bg-amber-50' :
                    'border-slate-100 bg-slate-50'
                  }`}
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 mb-1">
                        <span className="text-xs font-mono text-slate-400">#{i + 1}</span>
                        <span className={`text-xs px-1.5 py-0.5 rounded-full font-medium ${
                          displayStatus(q) === 'approved' ? 'bg-green-100 text-green-700' :
                          displayStatus(q) === 'flagged' ? 'bg-amber-100 text-amber-700' :
                          'bg-slate-100 text-slate-500'
                        }`}>
                          {displayStatus(q)}
                        </span>
                        {q.quality_score != null && (
                          <span className="text-xs font-mono text-slate-500">Audit: {q.quality_score as number}/10</span>
                        )}
                        {q.is_image_question && !q.image_url && (
                          <span className="text-xs px-1.5 py-0.5 rounded-full bg-purple-100 text-purple-600 flex items-center gap-1">
                            <ImageIcon className="w-3 h-3" /> image pending
                          </span>
                        )}
                      </div>
                      <QuestionRenderer question={q as unknown as Question} showAnswer={true} />
                    </div>
                    {!viewStage && (
                    <button
                      onClick={() => deleteQuestion((q.id as string))}
                      className="p-1 text-slate-400 hover:text-red-500 transition-colors shrink-0"
                      title="Delete question"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                    )}
                  </div>
                </div>
              ))}
            </div>
            );
          })()}
        </div>
        );
      })()}

      {/* Live Feed */}
      {overallStatus === 'running' && progress && progress.events.length > 0 && (
        <div className="rounded-lg border border-slate-200 bg-slate-900 overflow-hidden">
          <div className="px-3 py-2 bg-slate-800 border-b border-slate-700 flex items-center gap-2">
            <div className="w-2 h-2 rounded-full bg-green-400 animate-pulse" />
            <span className="text-xs font-medium text-slate-300">Live Feed</span>
          </div>
          <div
            ref={feedRef}
            className="p-3 max-h-48 overflow-y-auto font-mono text-xs text-slate-300 space-y-1"
          >
            {progress.events.map((event, i) => (
              <div key={i} className="flex gap-2">
                <span className="text-slate-500 shrink-0">{String(i + 1).padStart(2, '0')}</span>
                <span className={
                  event.includes('ERROR') ? 'text-red-400' :
                  event.includes('flagged') ? 'text-amber-400' :
                  event.includes('approved') ? 'text-green-400' :
                  event.includes('scores') ? 'text-blue-400' :
                  event.includes('scoring') ? 'text-cyan-400' :
                  'text-slate-300'
                }>
                  {event}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {loadingQuestions && (
        <div className="flex items-center justify-center py-8">
          <Loader2 className="w-6 h-6 text-slate-400 animate-spin" />
        </div>
      )}
    </div>
  );
}
