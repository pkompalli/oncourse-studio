import { useState, useEffect, useRef } from 'react';
import { useAppStore } from '../../store/appStore';
import { jobs, questions as questionsApi } from '../../services/api';
import { supabase } from '../../services/supabase';
import type { Job, Question } from '../../types';
import { Play, Loader2, CheckCircle2, XCircle, Clock, History, ArrowRight, Trash2, ChevronDown, ChevronUp, ImageIcon, AlertTriangle } from 'lucide-react';
import QuestionImage from '../common/QuestionImage';
import { useSnapshots, groupSnapshotsBySubject, STAGE_LABELS } from '../../hooks/useSnapshots';
import type { SnapshotStage } from '../../hooks/useSnapshots';
import StageSelector from '../common/StageSelector';
import { displayStatus } from '../../utils/questionStatus';

interface SubjectProgress {
  subject: string;
  status: 'pending' | 'generating' | 'done' | 'error';
  count?: number;
  error?: string;
}

const STATUS_STEP_MAP: Record<string, string> = {
  pending: 'generate',
  generating: 'generate',
  reviewing: 'review',
  auditing: 'audit',
  replacing: 'export', // legacy — treat as complete
  complete: 'export',
  failed: 'generate',
};

const STATUS_LABELS: Record<string, string> = {
  pending: 'Pending',
  generating: 'Generating...',
  reviewing: 'Ready for Review',
  auditing: 'Ready for Audit',
  complete: 'Complete',
  failed: 'Failed',
};

function formatDate(dateStr: string): string {
  const d = new Date(dateStr);
  const now = new Date();
  const diffMs = now.getTime() - d.getTime();
  const diffMin = Math.floor(diffMs / 60000);
  if (diffMin < 1) return 'just now';
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  const diffDay = Math.floor(diffHr / 24);
  if (diffDay < 7) return `${diffDay}d ago`;
  return d.toLocaleDateString();
}

export default function Step2Generate() {
  const { course, job, setJob, contentMode, qbankMode, completeStep, setStep, setQuestions } = useAppStore();
  const questions = useAppStore((s) => s.questions);
  const [subjectProgress, setSubjectProgress] = useState<SubjectProgress[]>([]);
  const [overallStatus, setOverallStatus] = useState<'idle' | 'running' | 'done' | 'error'>('idle');
  const [statusMessage, setStatusMessage] = useState('');
  const [recentJobs, setRecentJobs] = useState<Job[]>([]);
  const [loadingRecents, setLoadingRecents] = useState(false);
  const [expandedSubject, setExpandedSubject] = useState<string | null>(null);
  const [viewStage, setViewStage] = useState<SnapshotStage | null>(null);
  const [questionsPerTopic, setQuestionsPerTopic] = useState(5);
  const { snapshotQuestions, loading: snapshotLoading, availableStages } = useSnapshots(job?.id, viewStage);
  const channelRef = useRef<ReturnType<typeof supabase.channel> | null>(null);

  // Auto-load recent jobs for this course
  useEffect(() => {
    if (course?.id) loadRecentJobs();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [course?.id]);

  // If we arrive at this step with a completed generation, load questions + show done state
  useEffect(() => {
    if (job && ['reviewing', 'auditing', 'complete'].includes(job.status)) {
      if (overallStatus === 'idle') {
        setOverallStatus('done');
        setStatusMessage('Generation complete');
      }
      if (questions.length === 0) {
        questionsApi.list(job.id).then((res) => setQuestions(res.questions as Question[])).catch(() => {});
      }
      // Build subject progress from questions if we have them
      if (questions.length > 0 && subjectProgress.length === 0) {
        const bySubj = new Map<string, number>();
        for (const q of questions) { bySubj.set(q.subject || 'Unknown', (bySubj.get(q.subject || 'Unknown') || 0) + 1); }
        setSubjectProgress(Array.from(bySubj.entries()).map(([subject, count]) => ({ subject, status: 'done' as const, count })));
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [job?.status, questions.length]);

  useEffect(() => {
    return () => {
      if (channelRef.current) {
        supabase.removeChannel(channelRef.current);
      }
    };
  }, []);

  const loadRecentJobs = async () => {
    if (!course) return;
    setLoadingRecents(true);
    try {
      const res = await jobs.list(course.id);
      setRecentJobs((res.jobs || []) as Job[]);
    } catch {
      // silent
    } finally {
      setLoadingRecents(false);
    }
  };

  const resumeJob = async (resumeJob: Job) => {
    setJob(resumeJob);

    // Load questions for this job
    try {
      const res = await questionsApi.list(resumeJob.id);
      setQuestions((res.questions || []) as Question[]);
    } catch {
      // silent — questions may not exist yet
    }

    // Determine which step to navigate to based on job status
    const targetStep = STATUS_STEP_MAP[resumeJob.status] || 'generate';

    // Mark completed steps up to the target
    const stepOrder = ['structure', 'generate', 'review', 'audit', 'replace', 'export'];
    const targetIdx = stepOrder.indexOf(targetStep);
    for (let i = 0; i < targetIdx; i++) {
      completeStep(stepOrder[i] as 'structure' | 'generate' | 'review' | 'audit' | 'export');
    }

    // If generation is done, mark it complete and go to the right step
    const s = resumeJob.status;
    if (['reviewing', 'auditing', 'replacing', 'complete'].includes(s)) {
      completeStep('generate');
    }
    if (['auditing', 'replacing', 'complete'].includes(s)) {
      completeStep('review');
    }
    if (['replacing', 'complete'].includes(s)) {
      completeStep('audit');
    }

    setStep(targetStep as 'structure' | 'generate' | 'review' | 'audit' | 'export');
  };

  const subscribeToJob = (jobId: string) => {
    const channel = supabase
      .channel(`job:${jobId}`)
      .on('postgres_changes', {
        event: 'UPDATE',
        schema: 'public',
        table: 'qb_jobs',
        filter: `id=eq.${jobId}`,
      }, (payload) => {
        const updated = payload.new as Job;
        setJob(updated);
        if (updated.progress?.message) {
          setStatusMessage(updated.progress.message);
        }
        const completedList = (updated.progress as Record<string, unknown>)?.completed_subjects as string[] | undefined;
        const currentSubj = updated.progress?.current_subject;
        if (completedList || currentSubj) {
          setSubjectProgress((prev) =>
            prev.map((s) => {
              if (completedList?.includes(s.subject)) return { ...s, status: 'done' as const };
              if (s.subject === currentSubj) return { ...s, status: 'generating' as const };
              return s;
            })
          );
        }
        if (updated.status === 'reviewing') {
          setSubjectProgress((prev) => prev.map((s) => ({ ...s, status: 'done' as const })));
          setOverallStatus('done');
          completeStep('generate');
        }
        if (updated.status === 'failed') {
          setOverallStatus('error');
          setStatusMessage(updated.error || 'Generation failed');
        }
      })
      .subscribe();

    channelRef.current = channel;
  };

  const startGeneration = async () => {
    if (!course) return;
    setOverallStatus('running');
    setStatusMessage('Starting generation...');

    const subjects = course.structure?.subjects || [];
    setSubjectProgress(
      subjects.map((s) => ({ subject: s.name, status: 'pending' }))
    );

    try {
      const jobType = contentMode === 'lessons' ? 'lessons' : qbankMode;
      const isTopicWise = contentMode === 'qbank' && (qbankMode === 'topic_wise' || qbankMode === 'topic_qbank');
      const res = await jobs.create({
        course_id: course.id,
        type: jobType,
        config: {
          contentMode,
          qbankMode: contentMode === 'qbank' ? qbankMode : undefined,
          ...(isTopicWise ? { questions_per_topic: questionsPerTopic } : {}),
        },
      });
      const newJob = res.job as Job;
      setJob(newJob);
      subscribeToJob(newJob.id);
      pollNextBatch(newJob.id);
    } catch (e) {
      setOverallStatus('error');
      setStatusMessage(e instanceof Error ? e.message : 'Failed to start generation');
    }
  };

  const pollNextBatch = async (jobId: string) => {
    try {
      const res = await jobs.nextBatch(jobId, 'generate');
      const batchResult = res.batch_result as Record<string, unknown> | undefined;

      if (res.status === 'complete' || res.status === 'reviewing') {
        setSubjectProgress((prev) => prev.map((s) => ({ ...s, status: 'done' as const })));
        setOverallStatus('done');
        setStatusMessage(`Generation complete — ${batchResult?.completed || ''}/${batchResult?.total || ''} subjects`);
        completeStep('generate');
        // Load questions so user can drill down
        questionsApi.list(jobId).then((res2) => setQuestions(res2.questions as Question[])).catch(() => {});
        return;
      }

      if (res.status === 'failed') {
        setOverallStatus('error');
        setStatusMessage((batchResult?.error as string) || 'Generation failed');
        return;
      }

      setTimeout(() => pollNextBatch(jobId), 3000);
    } catch {
      setTimeout(() => pollNextBatch(jobId), 5000);
    }
  };

  const [retryingImages, setRetryingImages] = useState(false);
  const [retryResult, setRetryResult] = useState<string | null>(null);

  const missingImageCount = questions.filter(q => q.is_image_question && !q.image_url).length;

  const handleRetryImages = async () => {
    if (!job) return;
    setRetryingImages(true);
    setRetryResult(null);
    try {
      const res = await jobs.retryImages(job.id);
      setRetryResult(`${res.totalSuccess}/${res.totalProcessed} images generated${res.totalFailed > 0 ? `, ${res.totalFailed} failed` : ''}`);
      // Reload questions to get updated image_urls
      const qRes = await questionsApi.list(job.id);
      setQuestions((qRes.questions || []) as Question[]);
    } catch (e) {
      setRetryResult(e instanceof Error ? e.message : 'Failed to retry images');
    } finally {
      setRetryingImages(false);
    }
  };

  const proceedToReview = () => {
    setStep('review');
  };

  const completedSubjects = subjectProgress.filter((s) => s.status === 'done').length;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold text-slate-800">
            {contentMode === 'qbank' ? 'Generate Questions' : 'Generate Lessons'}
          </h2>
          <p className="text-sm text-slate-500 mt-1">
            {course?.name} &middot; {contentMode === 'qbank' ? (qbankMode === 'mock_exam' ? 'Mock Exam' : 'Topic-wise') : 'Lessons'}
          </p>
        </div>
        {overallStatus === 'idle' && !job && (
          <div className="flex items-center gap-4">
            {contentMode === 'qbank' && (qbankMode === 'topic_wise' || qbankMode === 'topic_qbank') && (
              <div className="flex items-center gap-2">
                <label className="text-sm text-slate-600 whitespace-nowrap">Qs per topic</label>
                <input
                  type="number"
                  min={1}
                  max={20}
                  value={questionsPerTopic}
                  onChange={(e) => setQuestionsPerTopic(Math.max(1, Math.min(20, parseInt(e.target.value) || 5)))}
                  className="w-16 px-2 py-1.5 border border-slate-300 rounded-lg text-sm text-center focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 outline-none"
                />
              </div>
            )}
            <button
              onClick={startGeneration}
              className="flex items-center gap-2 px-6 py-2 bg-indigo-600 text-white rounded-lg font-medium hover:bg-indigo-700 transition-colors"
            >
              <Play className="w-4 h-4" /> Start Generation
            </button>
          </div>
        )}
        {overallStatus === 'done' && (
          <button
            onClick={proceedToReview}
            className="flex items-center gap-2 px-6 py-2 bg-green-600 text-white rounded-lg font-medium hover:bg-green-700 transition-colors"
          >
            <CheckCircle2 className="w-4 h-4" /> Proceed to Review
          </button>
        )}
      </div>

      {/* Recent Jobs — shown when idle and no active job */}
      {overallStatus === 'idle' && !job && recentJobs.length > 0 && (
        <div className="space-y-2">
          <div className="flex items-center gap-2 text-sm font-medium text-slate-600">
            <History className="w-4 h-4" />
            <span>Resume from History</span>
          </div>
          <div className="space-y-2">
            {recentJobs.map((rj) => {
              const progress = (rj.progress || {}) as Record<string, unknown>;
              const totalQ = (progress.total as number) || 0;
              const statusLabel = STATUS_LABELS[rj.status] || rj.status;
              const isResumable = !['failed', 'pending'].includes(rj.status);

              return (
                <div
                  key={rj.id}
                  className={`p-3 rounded-lg border transition-colors ${
                    isResumable
                      ? 'border-slate-200 bg-white hover:border-indigo-300 hover:bg-indigo-50'
                      : 'border-slate-100 bg-slate-50 opacity-60'
                  }`}
                >
                  <div className="flex items-center justify-between">
                    <div
                      className={`flex items-center gap-3 min-w-0 flex-1 ${isResumable ? 'cursor-pointer' : 'cursor-not-allowed'}`}
                      onClick={() => isResumable && resumeJob(rj)}
                    >
                      <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${
                        rj.status === 'complete' ? 'bg-green-100 text-green-700' :
                        rj.status === 'failed' ? 'bg-red-100 text-red-700' :
                        rj.status === 'generating' ? 'bg-blue-100 text-blue-700' :
                        'bg-amber-100 text-amber-700'
                      }`}>
                        {statusLabel}
                      </span>
                      <span className="text-sm text-slate-600">
                        {rj.type === 'mock_exam' ? 'Mock Exam' : rj.type === 'topic_qbank' ? 'Topic QBank' : 'Lessons'}
                      </span>
                      {totalQ > 0 && (
                        <span className="text-xs text-slate-400">{totalQ} questions</span>
                      )}
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      <span className="text-xs text-slate-400">{formatDate(rj.created_at)}</span>
                      {isResumable && <ArrowRight className="w-4 h-4 text-slate-400" />}
                      <button
                        onClick={async (e) => {
                          e.stopPropagation();
                          if (!confirm('Delete this job and all its questions?')) return;
                          try {
                            await jobs.delete(rj.id);
                            setRecentJobs((prev) => prev.filter((j) => j.id !== rj.id));
                          } catch { /* silent */ }
                        }}
                        className="p-1 text-slate-400 hover:text-red-500 transition-colors"
                        title="Delete job"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {loadingRecents && recentJobs.length === 0 && (
        <div className="flex items-center gap-2 text-sm text-slate-400">
          <Loader2 className="w-4 h-4 animate-spin" />
          Loading history...
        </div>
      )}

      {/* Status Banner */}
      {overallStatus !== 'idle' && (
        <div className={`p-4 rounded-lg border ${
          overallStatus === 'running' ? 'bg-blue-50 border-blue-200' :
          overallStatus === 'done' ? 'bg-green-50 border-green-200' :
          'bg-red-50 border-red-200'
        }`}>
          <div className="flex items-center gap-2">
            {overallStatus === 'running' && <Loader2 className="w-4 h-4 text-blue-600 animate-spin" />}
            {overallStatus === 'done' && <CheckCircle2 className="w-4 h-4 text-green-600" />}
            {overallStatus === 'error' && <XCircle className="w-4 h-4 text-red-600" />}
            <span className={`text-sm font-medium ${
              overallStatus === 'running' ? 'text-blue-700' :
              overallStatus === 'done' ? 'text-green-700' :
              'text-red-700'
            }`}>
              {statusMessage}
            </span>
          </div>
          {overallStatus === 'running' && subjectProgress.length > 0 && (
            <div className="mt-2 text-xs text-blue-600">
              {completedSubjects}/{subjectProgress.length} subjects
            </div>
          )}
        </div>
      )}

      {/* Missing images alert */}
      {overallStatus === 'done' && missingImageCount > 0 && (
        <div className="flex items-center justify-between bg-amber-50 border border-amber-200 rounded-lg px-5 py-3">
          <div className="text-sm text-amber-800">
            <AlertTriangle className="w-4 h-4 inline mr-1.5 -mt-0.5" />
            <strong>{missingImageCount}</strong> image question{missingImageCount > 1 ? 's' : ''} missing images
          </div>
          <button
            onClick={handleRetryImages}
            disabled={retryingImages}
            className="flex items-center gap-2 px-4 py-1.5 bg-amber-600 text-white rounded-lg text-sm font-medium hover:bg-amber-700 disabled:opacity-50 transition-colors"
          >
            {retryingImages
              ? <><Loader2 className="w-3.5 h-3.5 animate-spin" />Generating images...</>
              : <><ImageIcon className="w-3.5 h-3.5" />Retry Image Generation</>}
          </button>
        </div>
      )}
      {retryResult && (
        <div className="text-sm text-slate-600 bg-slate-50 border border-slate-200 rounded-lg px-4 py-2">
          {retryResult}
        </div>
      )}

      {/* Subject Progress Cards */}
      {(() => {
        // Use snapshot data if a stage is selected, otherwise use current questions
        const useSnapshot = viewStage && snapshotQuestions && snapshotQuestions.length > 0;
        const snapshotBySubject = useSnapshot ? groupSnapshotsBySubject(snapshotQuestions!) : null;

        const questionsBySubject = new Map<string, Question[]>();
        for (const q of questions) {
          const subj = q.subject || 'Unknown';
          if (!questionsBySubject.has(subj)) questionsBySubject.set(subj, []);
          questionsBySubject.get(subj)!.push(q);
        }

        // For card list: prefer subjectProgress (during generation), then snapshot subjects, then current questions
        const cards = subjectProgress.length > 0
          ? subjectProgress
          : snapshotBySubject
          ? Array.from(snapshotBySubject.entries()).map(([subject, qs]) => ({
              subject, status: 'done' as const, count: qs.length,
            }))
          : Array.from(questionsBySubject.entries()).map(([subject, qs]) => ({
              subject, status: 'done' as const, count: qs.length,
            }));

        if (cards.length === 0) return null;

        // For drill-down: use snapshot or current questions
        const drillDownBySubject = snapshotBySubject || questionsBySubject;

        return (
          <div className="space-y-2">
            {(questions.length > 0 || useSnapshot) && overallStatus !== 'running' && (
              <div className="flex items-center justify-between flex-wrap gap-2">
                <h3 className="text-sm font-medium text-slate-600">Results by Subject (click to expand)</h3>
                <StageSelector
                  availableStages={availableStages}
                  currentStage={viewStage}
                  onStageChange={setViewStage}
                  loading={snapshotLoading}
                  defaultLabel="Latest"
                />
              </div>
            )}
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
              {cards.map((sp) => {
                const hasDrillDown = drillDownBySubject instanceof Map
                  ? (drillDownBySubject.get(sp.subject)?.length || 0) > 0
                  : false;
                const canExpand = hasDrillDown && overallStatus !== 'running';
                const isExpanded = expandedSubject === sp.subject;

                return (
                  <div
                    key={sp.subject}
                    onClick={() => canExpand && setExpandedSubject(isExpanded ? null : sp.subject)}
                    className={`p-4 rounded-lg border ${
                      sp.status === 'generating' ? 'border-blue-300 bg-blue-50' :
                      sp.status === 'done' ? 'border-green-300 bg-green-50' :
                      sp.status === 'error' ? 'border-red-300 bg-red-50' :
                      'border-slate-200 bg-white'
                    } ${canExpand ? 'cursor-pointer hover:shadow-sm' : ''}`}
                  >
                    <div className="flex items-center justify-between">
                      <span className="text-sm font-medium text-slate-700 truncate">{sp.subject}</span>
                      <div className="flex items-center gap-1">
                        {sp.status === 'pending' && <Clock className="w-4 h-4 text-slate-300" />}
                        {sp.status === 'generating' && <Loader2 className="w-4 h-4 text-blue-500 animate-spin" />}
                        {sp.status === 'done' && <CheckCircle2 className="w-4 h-4 text-green-500" />}
                        {sp.status === 'error' && <XCircle className="w-4 h-4 text-red-500" />}
                        {canExpand && (isExpanded
                          ? <ChevronUp className="w-4 h-4 text-slate-400" />
                          : <ChevronDown className="w-4 h-4 text-slate-400" />
                        )}
                      </div>
                    </div>
                    {(() => {
                      // Show approved/flagged counts from drill-down data
                      const subjItems = drillDownBySubject instanceof Map ? (drillDownBySubject.get(sp.subject) || []) : [];
                      const count = subjItems.length || sp.count || 0;
                      const approved = subjItems.filter((q: Record<string, unknown>) => displayStatus(q) === 'approved').length;
                      const flagged = subjItems.filter((q: Record<string, unknown>) => displayStatus(q) === 'flagged').length;
                      return count > 0 ? (
                        <div className="flex items-center gap-3 mt-1">
                          <span className="text-xs text-slate-500">{count} Qs</span>
                          {approved > 0 && <span className="text-xs text-green-600">{approved} approved</span>}
                          {flagged > 0 && <span className="text-xs text-red-600">{flagged} flagged</span>}
                        </div>
                      ) : null;
                    })()}
                    {sp.error && (
                      <div className="text-xs text-red-600 mt-1">{sp.error}</div>
                    )}
                  </div>
                );
              })}
            </div>

            {/* Expanded subject questions — from snapshot or current */}
            {expandedSubject && (() => {
              const expandedItems = drillDownBySubject instanceof Map
                ? (drillDownBySubject.get(expandedSubject) || [])
                : [];
              if (expandedItems.length === 0) return null;

              return (
              <div className="mt-3 p-4 rounded-lg border border-slate-200 bg-white space-y-2">
                <div className="flex items-center justify-between mb-2">
                  <h4 className="text-sm font-semibold text-slate-700">
                    {expandedSubject} — Questions
                    {viewStage && <span className="ml-2 text-xs font-normal text-indigo-500">({STAGE_LABELS[viewStage]})</span>}
                  </h4>
                  <button onClick={() => setExpandedSubject(null)} className="text-xs text-slate-400 hover:text-slate-600">Close</button>
                </div>
                {expandedItems.map((q: Record<string, unknown>, i: number) => (
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
                          {q.blooms_level && <span className="text-xs text-slate-400">{q.blooms_level as string}</span>}
                          {q.is_image_question && !q.image_url && (
                            <span className="text-xs px-1.5 py-0.5 rounded-full bg-purple-100 text-purple-600 flex items-center gap-1">
                              <ImageIcon className="w-3 h-3" /> image pending
                            </span>
                          )}
                        </div>
                        {q.image_url && (
                          <QuestionImage
                            imageUrl={q.image_url as string}
                            imageType={q.image_type as string}
                            imageSource={q.image_source as string}
                          />
                        )}
                        <p className="text-sm text-slate-700">{q.question as string}</p>
                        <div className="grid grid-cols-2 gap-1 mt-2">
                          {Object.entries((q.options as Record<string, string>) || {}).map(([key, val]) => (
                            <div key={key} className={`text-xs p-1.5 rounded ${
                              key === (q.correct_option as string)
                                ? 'bg-green-100 border border-green-200 text-green-800 font-medium'
                                : 'bg-white text-slate-600'
                            }`}>
                              <span className="font-medium">{key}.</span> {val}
                            </div>
                          ))}
                        </div>
                        {q.explanation && (
                          <p className="text-xs text-slate-500 mt-2 bg-white p-2 rounded">{q.explanation as string}</p>
                        )}
                      </div>
                      {!viewStage && (
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          if (!confirm('Delete this question?')) return;
                          questionsApi.delete(q.id as string).then(() => {
                            setQuestions(questions.filter((x: Question) => x.id !== q.id));
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
    </div>
  );
}
