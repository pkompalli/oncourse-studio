import { useState, useEffect, useRef } from 'react';
import { useAppStore } from '../../store/appStore';
import { jobs, questions as questionsApi } from '../../services/api';
import { supabase } from '../../services/supabase';
import type { Job, Question } from '../../types';
import { Play, Loader2, CheckCircle2, XCircle, Clock, History, ArrowRight, Trash2, ChevronDown, ChevronUp, ImageIcon, AlertTriangle } from 'lucide-react';
import QuestionImage from '../common/QuestionImage';
import QuestionRenderer from '../common/QuestionRenderer';
import { useSnapshots, groupSnapshotsBySubject, STAGE_LABELS } from '../../hooks/useSnapshots';
import type { SnapshotStage } from '../../hooks/useSnapshots';
import StageSelector from '../common/StageSelector';
import TokenUsage from '../common/TokenUsage';
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

  // Exams: a course may span multiple exams; a generation set targets exactly one.
  // The exam is normally chosen on the structure page (stored as selected_exam);
  // if so, it's locked here. The picker only appears for legacy courses that have
  // multiple exams but no stored choice.
  const exams = course?.structure?.exams || [];
  const lockedExam = course?.structure?.selected_exam;
  const needsExamChoice = exams.length > 1 && !lockedExam;
  const [selectedExam, setSelectedExam] = useState('');
  useEffect(() => {
    if (lockedExam) setSelectedExam(lockedExam);
    else if (exams.length === 1) setSelectedExam(exams[0].name);
  }, [lockedExam, exams.length, exams]);

  // ── Topic-wise: pick which subjects/topics to generate (with "select all") ──
  const isTopicWiseMode = contentMode === 'qbank' && (qbankMode === 'topic_wise' || qbankMode === 'topic_qbank');
  const scopedSubjects = (course?.structure?.subjects || []).filter((s) => !selectedExam || s.exam === selectedExam);
  const [topicSel, setTopicSel] = useState<Record<string, string[]>>({});
  const [expandedSel, setExpandedSel] = useState<Set<string>>(new Set());

  const subjectTopicNames = (s: { topics?: { name: string }[] }) => (s.topics || []).map((t) => t.name);
  const isTopicPicked = (subj: string, topic: string) => (topicSel[subj] || []).includes(topic);
  const isSubjectFull = (s: { name: string; topics?: { name: string }[] }) => {
    const all = subjectTopicNames(s);
    return all.length > 0 && all.every((t) => (topicSel[s.name] || []).includes(t));
  };
  const isSubjectPartial = (s: { name: string; topics?: { name: string }[] }) =>
    (topicSel[s.name]?.length || 0) > 0 && !isSubjectFull(s);
  const totalSelectedTopics = Object.values(topicSel).reduce((n, a) => n + a.length, 0);

  const toggleTopic = (subj: string, topic: string) => setTopicSel((prev) => {
    const cur = new Set(prev[subj] || []);
    if (cur.has(topic)) cur.delete(topic); else cur.add(topic);
    const next = { ...prev };
    if (cur.size) next[subj] = [...cur]; else delete next[subj];
    return next;
  });
  const toggleSubject = (s: { name: string; topics?: { name: string }[] }) => setTopicSel((prev) => {
    const next = { ...prev };
    if (isSubjectFull(s)) delete next[s.name];
    else next[s.name] = subjectTopicNames(s);
    return next;
  });
  const selectAllTopics = () => {
    const next: Record<string, string[]> = {};
    for (const s of scopedSubjects) { const ts = subjectTopicNames(s); if (ts.length) next[s.name] = ts; }
    setTopicSel(next);
  };
  const clearAllTopics = () => setTopicSel({});
  const toggleSelExpand = (name: string) => setExpandedSel((prev) => {
    const n = new Set(prev); if (n.has(name)) n.delete(name); else n.add(name); return n;
  });
  // Reset selection when the exam scope changes.
  useEffect(() => { setTopicSel({}); setExpandedSel(new Set()); }, [selectedExam]);

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
    const stepOrder = ['structure', 'guidelines', 'generate', 'review', 'audit', 'export'];
    const targetIdx = stepOrder.indexOf(targetStep);
    for (let i = 0; i < targetIdx; i++) {
      completeStep(stepOrder[i] as 'structure' | 'guidelines' | 'generate' | 'review' | 'audit' | 'export');
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
    if (needsExamChoice && !selectedExam) {
      setOverallStatus('error');
      setStatusMessage('Please select which exam to generate for.');
      return;
    }
    if (isTopicWiseMode && totalSelectedTopics === 0) {
      setOverallStatus('error');
      setStatusMessage('Select at least one subject or topic to generate (or use "Select all").');
      return;
    }
    setOverallStatus('running');
    setStatusMessage('Starting generation...');

    const allSubjects = course.structure?.subjects || [];
    let subjects = selectedExam ? allSubjects.filter((s) => s.exam === selectedExam) : allSubjects;
    if (isTopicWiseMode && totalSelectedTopics > 0) {
      subjects = subjects.filter((s) => (topicSel[s.name] || []).length > 0);
    }
    setSubjectProgress(
      subjects.map((s) => ({ subject: s.name, status: 'pending' }))
    );

    try {
      const jobType = contentMode === 'lessons' ? 'lessons' : qbankMode;
      const res = await jobs.create({
        course_id: course.id,
        type: jobType,
        config: {
          contentMode,
          qbankMode: contentMode === 'qbank' ? qbankMode : undefined,
          ...(selectedExam ? { exam: selectedExam } : {}),
          ...(isTopicWiseMode ? { questions_per_topic: questionsPerTopic, topic_selection: topicSel } : {}),
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

      // Update progress from polling (in case Supabase Realtime isn't delivering)
      if (res.status === 'generating' && batchResult) {
        const completed = (batchResult.completed as number) || 0;
        const total = (batchResult.total as number) || 0;
        const message = batchResult.message as string | undefined;
        const completedList = batchResult.completed_subjects as string[] | undefined;
        const phase = batchResult.phase as string | undefined;

        // Use server message if available, otherwise build one
        if (message) {
          setStatusMessage(message);
        } else if (completed > 0 || total > 0) {
          setStatusMessage(`Generating... ${completed}/${total} subjects complete`);
        }

        // During image phase, mark all subjects as done
        if (phase === 'images') {
          setSubjectProgress((prev) => prev.map((s) => ({ ...s, status: 'done' as const })));
        } else if (completedList && completedList.length > 0) {
          // Update subject progress from completed list
          setSubjectProgress((prev) =>
            prev.map((s) => {
              if (completedList.includes(s.subject)) return { ...s, status: 'done' as const };
              return s;
            })
          );
        }
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
            {selectedExam && <> &middot; <span className="font-medium text-indigo-600">{selectedExam}</span></>}
          </p>
        </div>
        {overallStatus === 'idle' && !job && (
          <div className="flex items-center gap-4">
            {needsExamChoice && (
              <div className="flex items-center gap-2">
                <label className="text-sm text-slate-600 whitespace-nowrap">Exam</label>
                <select
                  value={selectedExam}
                  onChange={(e) => setSelectedExam(e.target.value)}
                  className="px-3 py-1.5 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 outline-none max-w-[16rem]"
                >
                  <option value="">Select exam…</option>
                  {exams.map((ex) => (
                    <option key={ex.name} value={ex.name}>
                      {ex.code ? `${ex.code} — ${ex.name}` : ex.name}
                    </option>
                  ))}
                </select>
              </div>
            )}
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
              disabled={isTopicWiseMode && totalSelectedTopics === 0}
              className="flex items-center gap-2 px-6 py-2 bg-indigo-600 text-white rounded-lg font-medium hover:bg-indigo-700 transition-colors disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-indigo-600"
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

      {/* Topic-wise subject/topic selector */}
      {isTopicWiseMode && overallStatus === 'idle' && !job && scopedSubjects.length > 0 && (
        <div className="bg-white rounded-xl border border-slate-200 p-4">
          <div className="flex items-center justify-between mb-3 gap-2 flex-wrap">
            <div>
              <h3 className="text-sm font-semibold text-slate-700">Select subjects &amp; topics to generate</h3>
              <p className="text-xs text-slate-500">
                {totalSelectedTopics > 0
                  ? `${totalSelectedTopics} topic${totalSelectedTopics === 1 ? '' : 's'} selected across ${Object.keys(topicSel).length} subject${Object.keys(topicSel).length === 1 ? '' : 's'}`
                  : 'Nothing selected — pick subjects/topics or use "Select all"'}
              </p>
            </div>
            <div className="flex items-center gap-2">
              <button
                onClick={selectAllTopics}
                className="text-xs px-3 py-1.5 rounded-lg border border-indigo-200 text-indigo-600 hover:bg-indigo-50 font-medium"
              >
                Select all
              </button>
              <button
                onClick={clearAllTopics}
                className="text-xs px-3 py-1.5 rounded-lg border border-slate-200 text-slate-500 hover:bg-slate-50 font-medium"
              >
                Clear
              </button>
            </div>
          </div>

          <div className="space-y-1.5 max-h-96 overflow-y-auto pr-1">
            {scopedSubjects.map((s) => {
              const topics = s.topics || [];
              const picked = topicSel[s.name]?.length || 0;
              const open = expandedSel.has(s.name);
              return (
                <div key={s.name} className="border border-slate-100 rounded-lg">
                  <div className="flex items-center gap-2 px-3 py-2">
                    <input
                      type="checkbox"
                      className="w-4 h-4 accent-indigo-600 shrink-0"
                      checked={isSubjectFull(s)}
                      ref={(el) => { if (el) el.indeterminate = isSubjectPartial(s); }}
                      onChange={() => toggleSubject(s)}
                    />
                    <button
                      onClick={() => toggleSelExpand(s.name)}
                      className="flex-1 flex items-center justify-between min-w-0"
                    >
                      <span className="text-sm font-medium text-slate-700 truncate">{s.name}</span>
                      <span className="flex items-center gap-2 shrink-0">
                        <span className="text-xs text-slate-400">{picked}/{topics.length}</span>
                        {open ? <ChevronUp className="w-4 h-4 text-slate-400" /> : <ChevronDown className="w-4 h-4 text-slate-400" />}
                      </span>
                    </button>
                  </div>
                  {open && topics.length > 0 && (
                    <div className="px-3 pb-2 pt-0.5 grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-1 border-t border-slate-50">
                      {topics.map((t) => (
                        <label key={t.name} className="flex items-center gap-2 text-xs text-slate-600 cursor-pointer py-0.5">
                          <input
                            type="checkbox"
                            className="w-3.5 h-3.5 accent-indigo-600 shrink-0"
                            checked={isTopicPicked(s.name, t.name)}
                            onChange={() => toggleTopic(s.name, t.name)}
                          />
                          <span className="truncate">{t.name}</span>
                          {(t.high_yield || t.is_high_yield) && <span className="text-amber-500 font-medium shrink-0">HY</span>}
                        </label>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

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
          {overallStatus === 'done' && (job?.progress as Record<string, unknown>)?.token_usage && (
            <TokenUsage label="Generation" data={((job?.progress as Record<string, unknown>)?.token_usage as Record<string, unknown>)?.generation as { prompt_tokens: number; completion_tokens: number; total_tokens: number; calls: number } | undefined} />
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
                        <QuestionRenderer question={q as Question} showAnswer={true} />
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
