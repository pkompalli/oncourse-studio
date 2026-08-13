import { useState, useEffect, useRef } from 'react';
import { useAppStore } from '../../store/appStore';
import { jobs, questions as questionsApi } from '../../services/api';
import { supabase } from '../../services/supabase';
import type { Job, Question } from '../../types';
import { Loader2, CheckCircle2, XCircle, Shield, Swords, Wrench, ChevronDown, ChevronUp, Clock, Trash2, ImageIcon } from 'lucide-react';
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
  reviewed: number;
  fixed: number;
  status: 'pending' | 'validator' | 'adversarial' | 'done';
}

interface ReviewProgress {
  phase: string;
  step: string;
  reviewed: number;
  fixed: number;
  total: number;
  batchesTotal: number;
  batchesDone: number;
  events: string[];
  subjects: SubjectStatus[];
}

// Map backend phase → which UI card is active
function isValidatorActive(phase: string) {
  return ['init', 'validator_scoring', 'validator_fixing'].includes(phase);
}
function isValidatorDone(phase: string) {
  return ['adversarial_scoring', 'adversarial_fixing', 'finalizing', 'done'].includes(phase);
}
function isAdversarialActive(phase: string) {
  return ['adversarial_scoring', 'adversarial_fixing'].includes(phase);
}
function isAdversarialDone(phase: string) {
  return ['finalizing', 'done'].includes(phase);
}

export default function Step3Review() {
  const { job, setJob, questions, setQuestions, completeStep, setStep } = useAppStore();
  const [progress, setProgress] = useState<ReviewProgress | null>(null);
  const [overallStatus, setOverallStatus] = useState<'idle' | 'running' | 'done' | 'error'>('idle');
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [expandedSubject, setExpandedSubject] = useState<string | null>(null);
  const [loadingQuestions, setLoadingQuestions] = useState(false);
  const [viewStage, setViewStage] = useState<SnapshotStage | null>(null);
  const { snapshotQuestions, loading: snapshotLoading, availableStages } = useSnapshots(job?.id, viewStage);
  const channelRef = useRef<ReturnType<typeof supabase.channel> | null>(null);
  const pollingRef = useRef(false);
  const feedRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    return () => {
      pollingRef.current = false;
      if (channelRef.current) {
        supabase.removeChannel(channelRef.current);
      }
    };
  }, []);

  // Auto-scroll live feed
  useEffect(() => {
    if (feedRef.current) {
      feedRef.current.scrollTop = feedRef.current.scrollHeight;
    }
  }, [progress?.events]);

  // Always load fresh questions on mount
  useEffect(() => {
    if (job) loadQuestions();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [job?.id]);

  // Auto-start review when component mounts if job is in reviewing status
  useEffect(() => {
    if (job && (job.status === 'reviewing' || job.status === 'review') && overallStatus === 'idle') {
      startReview();
    }
    if (job && ['auditing', 'complete'].includes(job.status) && overallStatus === 'idle') {
      setOverallStatus('done');
      setProgress((prev) => prev ? { ...prev, phase: 'done', step: 'Review already complete' } : { phase: 'done', step: 'Review already complete', reviewed: 0, fixed: 0, total: 0, batchesTotal: 0, batchesDone: 0, events: [], subjects: [] });
      loadQuestions();
      completeStep('review');
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
      .channel(`review:${jobId}`)
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
            phase: (prog.phase as string) || 'init',
            step: (prog.step as string) || '',
            reviewed: (prog.reviewed as number) || 0,
            fixed: (prog.fixed as number) || 0,
            total: (prog.total as number) || 0,
            batchesTotal: (prog.batches_total as number) || 0,
            batchesDone: (prog.batches_done as number) || 0,
            events: (prog.events as string[]) || [],
            subjects: (prog.subjects as SubjectStatus[]) || [],
          });
        }

        if (updated.status === 'auditing') {
          pollingRef.current = false;
          setOverallStatus('done');
          setProgress((prev) => prev ? { ...prev, phase: 'done' } : null);
          completeStep('review');
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

  const startReview = async () => {
    if (!job) return;
    setOverallStatus('running');
    setProgress({ phase: 'init', step: 'Starting automated review...', reviewed: 0, fixed: 0, total: 0, batchesTotal: 0, batchesDone: 0, events: ['Starting automated review...'], subjects: [] });

    subscribeToJob(job.id);
    pollingRef.current = true;
    pollReview(job.id);
  };

  const pollReview = async (jobId: string) => {
    if (!pollingRef.current) return;
    try {
      const res = await jobs.nextBatch(jobId, 'review');
      const br = res.batch_result as Record<string, unknown> | undefined;

      if (br) {
        setProgress({
          phase: (br.phase as string) || 'init',
          step: (br.step as string) || '',
          reviewed: (br.reviewed as number) || 0,
          fixed: (br.fixed as number) || 0,
          total: (br.total as number) || 0,
          batchesTotal: (br.batches_total as number) || 0,
          batchesDone: (br.batches_done as number) || 0,
          events: (br.events as string[]) || [],
          subjects: (br.subjects as SubjectStatus[]) || [],
        });
      }

      if (res.status === 'complete' || res.status === 'auditing') {
        pollingRef.current = false;
        setOverallStatus('done');
        completeStep('review');
        loadQuestions();
        return;
      }

      if (res.status === 'failed') {
        pollingRef.current = false;
        setOverallStatus('error');
        return;
      }

      setTimeout(() => pollReview(jobId), 3000);
    } catch {
      setTimeout(() => pollReview(jobId), 5000);
    }
  };

  const batchPct = progress && progress.batchesTotal > 0
    ? Math.round((progress.batchesDone / progress.batchesTotal) * 100)
    : 0;

  const phase = progress?.phase || '';

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold text-slate-800">Automated Review Pipeline</h2>
          <p className="text-sm text-slate-500 mt-1">
            Validator + Adversarial review with inline fixes
          </p>
        </div>
        {overallStatus === 'done' && (
          <button
            onClick={() => setStep('audit')}
            className="flex items-center gap-2 px-6 py-2 bg-green-600 text-white rounded-lg font-medium hover:bg-green-700 transition-colors"
          >
            <CheckCircle2 className="w-4 h-4" /> Proceed to Audit
          </button>
        )}
      </div>

      {/* Current Step — the primary status indicator */}
      {overallStatus === 'running' && progress?.step && (
        <div className="p-4 rounded-lg border border-blue-200 bg-blue-50">
          <div className="flex items-center gap-3">
            <Loader2 className="w-5 h-5 text-blue-600 animate-spin shrink-0" />
            <span className="text-sm font-medium text-blue-800">{progress.step}</span>
          </div>
        </div>
      )}

      {overallStatus === 'error' && progress?.step && (
        <div className="p-4 rounded-lg border border-red-200 bg-red-50">
          <div className="flex items-center gap-3">
            <XCircle className="w-5 h-5 text-red-600 shrink-0" />
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
        </div>
      )}

      {/* Phase Progress Cards */}
      {progress && overallStatus !== 'idle' && (
        <div className="space-y-3">
          {/* Phase A: Validator */}
          <div className={`p-4 rounded-lg border ${
            isValidatorActive(phase) ? 'border-blue-300 bg-blue-50' :
            isValidatorDone(phase) ? 'border-green-300 bg-green-50' :
            'border-slate-200 bg-white'
          }`}>
            <div className="flex items-center gap-3">
              <Shield className={`w-5 h-5 ${
                isValidatorActive(phase) ? 'text-blue-600' :
                isValidatorDone(phase) ? 'text-green-600' : 'text-slate-300'
              }`} />
              <div className="flex-1">
                <div className="flex items-center justify-between">
                  <span className="text-sm font-medium text-slate-700">
                    Phase 1: Validator Review (Sonnet 5)
                    {phase === 'validator_fixing' && <span className="ml-2 text-xs text-amber-600 font-normal">fixing flagged...</span>}
                  </span>
                  {isValidatorActive(phase) && <Loader2 className="w-4 h-4 text-blue-500 animate-spin" />}
                  {isValidatorDone(phase) && <CheckCircle2 className="w-4 h-4 text-green-500" />}
                </div>
                {isValidatorActive(phase) && progress.batchesTotal > 0 && (
                  <div className="mt-2">
                    <div className="w-full bg-blue-100 rounded-full h-2">
                      <div className="bg-blue-500 h-2 rounded-full transition-all duration-500" style={{ width: `${batchPct}%` }} />
                    </div>
                    <div className="text-xs text-blue-600 mt-1">
                      {progress.batchesDone}/{progress.batchesTotal} batches
                      {progress.reviewed > 0 && ` · ${progress.reviewed}/${progress.total} scored`}
                      {progress.fixed > 0 && ` · ${progress.fixed} fixed`}
                    </div>
                  </div>
                )}
              </div>
            </div>
          </div>

          {/* Phase B: Adversarial */}
          <div className={`p-4 rounded-lg border ${
            isAdversarialActive(phase) ? 'border-purple-300 bg-purple-50' :
            isAdversarialDone(phase) ? 'border-green-300 bg-green-50' :
            'border-slate-200 bg-white'
          }`}>
            <div className="flex items-center gap-3">
              <Swords className={`w-5 h-5 ${
                isAdversarialActive(phase) ? 'text-purple-600' :
                isAdversarialDone(phase) ? 'text-green-600' : 'text-slate-300'
              }`} />
              <div className="flex-1">
                <div className="flex items-center justify-between">
                  <span className="text-sm font-medium text-slate-700">
                    Phase 2: Adversarial Review (Sonnet 5)
                    {phase === 'adversarial_fixing' && <span className="ml-2 text-xs text-amber-600 font-normal">fixing flagged...</span>}
                  </span>
                  {isAdversarialActive(phase) && <Loader2 className="w-4 h-4 text-purple-500 animate-spin" />}
                  {isAdversarialDone(phase) && <CheckCircle2 className="w-4 h-4 text-green-500" />}
                  {isValidatorActive(phase) && <span className="text-xs text-slate-400">waiting</span>}
                </div>
                {isAdversarialActive(phase) && progress.batchesTotal > 0 && (
                  <div className="mt-2">
                    <div className="w-full bg-purple-100 rounded-full h-2">
                      <div className="bg-purple-500 h-2 rounded-full transition-all duration-500" style={{ width: `${batchPct}%` }} />
                    </div>
                    <div className="text-xs text-purple-600 mt-1">
                      {progress.batchesDone}/{progress.batchesTotal} batches
                      {progress.reviewed > 0 && ` · ${progress.reviewed}/${progress.total} scored`}
                      {progress.fixed > 0 && ` · ${progress.fixed} total fixed`}
                    </div>
                  </div>
                )}
              </div>
            </div>
          </div>
          {overallStatus === 'done' && (job?.progress as Record<string, unknown>)?.token_usage && (
            <div className="mt-1 px-1">
              <TokenUsage label="Review" data={((job?.progress as Record<string, unknown>)?.token_usage as Record<string, unknown>)?.review as { prompt_tokens: number; completion_tokens: number; total_tokens: number; calls: number } | undefined} />
            </div>
          )}
        </div>
      )}

      {/* Subject Progress Cards */}
      {(() => {
        const useSnapshot = viewStage && snapshotQuestions && snapshotQuestions.length > 0;
        const snapshotBySubject = useSnapshot ? groupSnapshotsBySubject(snapshotQuestions!) : null;

        const questionsBySubject = new Map<string, typeof questions>();
        for (const q of questions) {
          const subj = q.subject || 'Unknown';
          if (!questionsBySubject.has(subj)) questionsBySubject.set(subj, []);
          questionsBySubject.get(subj)!.push(q);
        }

        const drillDownBySubject = snapshotBySubject || questionsBySubject;

        // Use progress.subjects if available (live), otherwise build from questions/snapshots
        const subjectCards: SubjectStatus[] = (progress?.subjects && progress.subjects.length > 0)
          ? progress.subjects
          : Array.from((snapshotBySubject || questionsBySubject).entries()).map(([subject, qs]) => ({
              subject,
              count: qs.length,
              reviewed: qs.length,
              fixed: 0,
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
                const hasDrillDown = drillDownBySubject instanceof Map
                  ? (drillDownBySubject.get(sp.subject)?.length || 0) > 0
                  : false;
                const hasQuestions = hasDrillDown;
                const canExpand = hasQuestions && overallStatus !== 'running';
                const isExpanded = expandedSubject === sp.subject;

                return (
                  <div
                    key={sp.subject}
                    onClick={() => canExpand && setExpandedSubject(isExpanded ? null : sp.subject)}
                    className={`p-4 rounded-lg border transition-colors ${
                      sp.status === 'validator' ? 'border-blue-300 bg-blue-50' :
                      sp.status === 'adversarial' ? 'border-purple-300 bg-purple-50' :
                      sp.status === 'done' ? 'border-green-300 bg-green-50' :
                      'border-slate-200 bg-white'
                    } ${canExpand ? 'cursor-pointer hover:shadow-sm' : ''}`}
                  >
                    <div className="flex items-center justify-between">
                      <span className="text-sm font-medium text-slate-700 truncate">{sp.subject}</span>
                      <div className="flex items-center gap-1">
                        {sp.status === 'pending' && <Clock className="w-4 h-4 text-slate-300" />}
                        {sp.status === 'validator' && <Loader2 className="w-4 h-4 text-blue-500 animate-spin" />}
                        {sp.status === 'adversarial' && <Loader2 className="w-4 h-4 text-purple-500 animate-spin" />}
                        {sp.status === 'done' && <CheckCircle2 className="w-4 h-4 text-green-500" />}
                        {canExpand && (isExpanded
                          ? <ChevronUp className="w-4 h-4 text-slate-400" />
                          : <ChevronDown className="w-4 h-4 text-slate-400" />
                        )}
                      </div>
                    </div>
                    {(() => {
                      const subjItems = drillDownBySubject instanceof Map ? (drillDownBySubject.get(sp.subject) || []) : [];
                      const approved = subjItems.filter((q: Record<string, unknown>) => displayStatus(q) === 'approved').length;
                      const flagged = subjItems.filter((q: Record<string, unknown>) => displayStatus(q) === 'flagged').length;
                      return (
                        <div className="flex items-center gap-3 mt-1">
                          <span className="text-xs text-slate-500">{sp.count} Qs</span>
                          {approved > 0 && <span className="text-xs text-green-600">{approved} approved</span>}
                          {flagged > 0 && <span className="text-xs text-red-600">{flagged} flagged</span>}
                        </div>
                      );
                    })()}
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
                  <div key={(q.id as string) || (q.question_id as string) || i} className={`p-3 rounded-lg border ${
                    displayStatus(q) === 'approved' ? 'border-green-200 bg-green-50' :
                    displayStatus(q) === 'flagged' ? 'border-amber-200 bg-amber-50' :
                    'border-slate-100 bg-slate-50'
                  }`}>
                    <div className="flex items-start justify-between gap-3">
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 mb-1">
                          <span className="text-xs font-mono text-slate-400">#{i + 1}</span>
                          <span className={`text-xs px-1.5 py-0.5 rounded-full font-medium ${
                            displayStatus(q) === 'approved' ? 'bg-green-100 text-green-700' :
                            displayStatus(q) === 'flagged' ? 'bg-amber-100 text-amber-700' :
                            displayStatus(q) === 'reviewed' ? 'bg-blue-100 text-blue-700' :
                            'bg-slate-100 text-slate-500'
                          }`}>{displayStatus(q)}</span>
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
                        onClick={(e) => {
                          e.stopPropagation();
                          if (!confirm('Delete this question?')) return;
                          questionsApi.delete(q.id as string).then(() => {
                            setQuestions(questions.filter((x) => x.id !== (q.id as string)));
                          }).catch(() => {});
                        }}
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

      {/* Live Feed — scrolling log of events */}
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
                  event.includes('fix') || event.includes('Fix') ? 'text-amber-400' :
                  event.includes('complete') || event.includes('Complete') ? 'text-green-400' :
                  event.includes('scores') ? 'text-blue-400' :
                  event.includes('sending') ? 'text-cyan-400' :
                  'text-slate-300'
                }>
                  {event}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Summary Cards when done */}
      {overallStatus === 'done' && (() => {
        const total = progress?.total || questions.length;
        const fixed = progress?.fixed || 0;
        if (total === 0) return null;
        return (
          <div className="grid grid-cols-3 gap-4">
            <div className="p-4 rounded-lg border border-slate-200 bg-white text-center">
              <div className="text-2xl font-bold text-slate-800">{total}</div>
              <div className="text-xs text-slate-500 mt-1">Questions Reviewed</div>
            </div>
            <div className="p-4 rounded-lg border border-slate-200 bg-white text-center">
              <div className="text-2xl font-bold text-green-600">{total - fixed}</div>
              <div className="text-xs text-slate-500 mt-1 flex items-center justify-center gap-1">
                <CheckCircle2 className="w-3 h-3" /> Clean
              </div>
            </div>
            <div className="p-4 rounded-lg border border-slate-200 bg-white text-center">
              <div className="text-2xl font-bold text-amber-600">{fixed}</div>
              <div className="text-xs text-slate-500 mt-1 flex items-center justify-center gap-1">
                <Wrench className="w-3 h-3" /> Fixed Inline
              </div>
            </div>
          </div>
        );
      })()}

      {/* Questions are now viewable via subject card drill-down above */}

      {loadingQuestions && (
        <div className="flex items-center justify-center py-8">
          <Loader2 className="w-6 h-6 text-slate-400 animate-spin" />
        </div>
      )}
    </div>
  );
}
