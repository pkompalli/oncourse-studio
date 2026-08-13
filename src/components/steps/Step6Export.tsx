import { useState, useEffect, useRef } from 'react';
import { useAppStore } from '../../store/appStore';
import { jobs, questions as questionsApi, exportApi } from '../../services/api';
import { Download, CheckCircle2, AlertTriangle, ImageIcon, ChevronDown, ChevronUp, Loader2, RefreshCw } from 'lucide-react';
import { displayStatus } from '../../utils/questionStatus';
import QuestionImage from '../common/QuestionImage';
import QuestionRenderer from '../common/QuestionRenderer';
import type { Question } from '../../types';

export default function Step6Export() {
  const { job, questions, setQuestions } = useAppStore();
  const [expandedQ, setExpandedQ] = useState<string | null>(null);

  // Load questions (always refresh on mount to pick up reprocess changes)
  useEffect(() => {
    if (job) {
      questionsApi.list(job.id).then((res) => setQuestions((res.questions || []) as Question[])).catch(() => {});
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [job?.id]);

  const approvedCount = questions.filter((q) => {
    const ds = displayStatus(q as Record<string, unknown>);
    return ds === 'approved' || ds === 'reviewed';
  }).length;
  const flaggedCount = questions.filter((q) => displayStatus(q as Record<string, unknown>) === 'flagged').length;

  // ── Reprocess flagged state ──
  const [reprocessing, setReprocessing] = useState(false);
  const [reprocessStatus, setReprocessStatus] = useState<{
    status: string; phase: string; step: string;
    total: number; reApproved: number; stillFlagged: number;
    events: string[];
  } | null>(null);
  const reprocessPollingRef = useRef(false);
  const reprocessFeedRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (reprocessFeedRef.current) {
      reprocessFeedRef.current.scrollTop = reprocessFeedRef.current.scrollHeight;
    }
  }, [reprocessStatus?.events]);

  const startReprocess = async () => {
    if (!job) return;
    setReprocessing(true);
    setReprocessStatus(null);
    reprocessPollingRef.current = true;
    pollReprocess(job.id);
  };

  const pollReprocess = async (jobId: string) => {
    if (!reprocessPollingRef.current) return;
    try {
      const res = await jobs.reprocessFlagged(jobId);
      setReprocessStatus({
        status: res.status,
        phase: res.phase,
        step: res.step,
        total: res.total,
        reApproved: res.reApproved,
        stillFlagged: res.stillFlagged,
        events: res.events,
      });

      if (res.status === 'complete') {
        reprocessPollingRef.current = false;
        setReprocessing(false);
        // Reload questions to reflect updated statuses
        const qRes = await questionsApi.list(jobId);
        setQuestions((qRes.questions || []) as Question[]);
        return;
      }

      if (res.status === 'failed') {
        reprocessPollingRef.current = false;
        setReprocessing(false);
        return;
      }

      setTimeout(() => pollReprocess(jobId), 3000);
    } catch {
      setTimeout(() => pollReprocess(jobId), 5000);
    }
  };

  // Cleanup on unmount
  useEffect(() => {
    return () => { reprocessPollingRef.current = false; };
  }, []);

  const [exporting, setExporting] = useState(false);

  const handleExport = async () => {
    if (!job) return;
    setExporting(true);
    try {
      const payload = await exportApi.json(job.id);
      const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      const courseName = (job as Record<string, unknown>)?.course_name || questions[0]?.course || 'export';
      a.download = `qbank_${String(courseName).replace(/\s+/g, '_').toLowerCase()}_${new Date().toISOString().slice(0, 10)}.json`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } finally {
      setExporting(false);
    }
  };

  return (
    <div className="relative pb-20">
      {/* Header */}
      <div className="mb-4">
        <h2 className="text-lg font-semibold text-slate-800">Export</h2>
        <p className="text-sm text-slate-500 mt-1">Review all questions and export as JSON</p>
      </div>

      {/* Summary cards */}
      <div className="grid grid-cols-3 gap-4 mb-6">
        <div className="bg-white p-4 rounded-xl border border-slate-200 text-center">
          <div className="text-2xl font-bold text-slate-800">{questions.length}</div>
          <div className="text-sm text-slate-500">Total</div>
        </div>
        <div className="bg-green-50 p-4 rounded-xl border border-green-200 text-center">
          <div className="text-2xl font-bold text-green-700">{approvedCount}</div>
          <div className="text-sm text-green-600">Approved</div>
        </div>
        <div className="bg-amber-50 p-4 rounded-xl border border-amber-200 text-center">
          <div className="text-2xl font-bold text-amber-700">{flaggedCount}</div>
          <div className="text-sm text-amber-600">Flagged</div>
        </div>
      </div>

      {/* Reprocess Flagged */}
      {flaggedCount > 0 && !reprocessing && !reprocessStatus && (
        <div className="flex items-center justify-between p-4 rounded-xl border border-amber-200 bg-amber-50">
          <div>
            <p className="text-sm font-medium text-amber-800">
              {flaggedCount} questions flagged — fixable issues detected
            </p>
            <p className="text-xs text-amber-600 mt-0.5">
              Automatically fix using audit feedback, retry missing images, then re-validate and re-audit
            </p>
          </div>
          <button
            onClick={startReprocess}
            className="flex items-center gap-2 px-4 py-2 bg-amber-600 text-white rounded-lg font-medium hover:bg-amber-700 transition-colors shrink-0"
          >
            <RefreshCw className="w-4 h-4" />
            Reprocess {flaggedCount} Flagged
          </button>
        </div>
      )}

      {/* Reprocess Progress */}
      {reprocessing && reprocessStatus && (
        <div className="space-y-3">
          <div className="p-4 rounded-xl border border-indigo-200 bg-indigo-50">
            <div className="flex items-center gap-3">
              <Loader2 className="w-5 h-5 text-indigo-600 animate-spin shrink-0" />
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium text-indigo-800">{reprocessStatus.step}</p>
                <p className="text-xs text-indigo-600 mt-0.5">
                  Phase: {reprocessStatus.phase} | {reprocessStatus.total} questions
                  {reprocessStatus.reApproved > 0 && ` | ${reprocessStatus.reApproved} recovered`}
                </p>
              </div>
            </div>
          </div>

          {reprocessStatus.events.length > 0 && (
            <div className="rounded-lg border border-slate-200 bg-slate-900 overflow-hidden">
              <div className="px-3 py-2 bg-slate-800 border-b border-slate-700 flex items-center gap-2">
                <div className="w-2 h-2 rounded-full bg-green-400 animate-pulse" />
                <span className="text-xs font-medium text-slate-300">Reprocess Feed</span>
              </div>
              <div
                ref={reprocessFeedRef}
                className="p-3 max-h-40 overflow-y-auto font-mono text-xs text-slate-300 space-y-1"
              >
                {reprocessStatus.events.map((event, i) => (
                  <div key={i} className="flex gap-2">
                    <span className="text-slate-500 shrink-0">{String(i + 1).padStart(2, '0')}</span>
                    <span className={
                      event.includes('ERROR') ? 'text-red-400' :
                      event.includes('approved') || event.includes('recovered') ? 'text-green-400' :
                      event.includes('flagged') ? 'text-amber-400' :
                      event.includes('Fixing') || event.includes('Fixed') ? 'text-purple-400' :
                      event.includes('Validator') || event.includes('Adversarial') ? 'text-blue-400' :
                      event.includes('Audit') ? 'text-cyan-400' :
                      'text-slate-300'
                    }>
                      {event}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {/* Reprocess Complete */}
      {!reprocessing && reprocessStatus && reprocessStatus.status === 'complete' && (
        <div className="p-4 rounded-xl border border-green-200 bg-green-50">
          <div className="flex items-center gap-3">
            <CheckCircle2 className="w-5 h-5 text-green-600 shrink-0" />
            <div>
              <p className="text-sm font-medium text-green-800">{reprocessStatus.step}</p>
              <p className="text-xs text-green-600 mt-0.5">
                {reprocessStatus.reApproved} questions recovered to approved
                {reprocessStatus.stillFlagged > 0 && ` · ${reprocessStatus.stillFlagged} still need manual attention`}
              </p>
            </div>
          </div>
        </div>
      )}

      {/* Reprocess Failed */}
      {!reprocessing && reprocessStatus && reprocessStatus.status === 'failed' && (
        <div className="p-4 rounded-xl border border-red-200 bg-red-50">
          <div className="flex items-center gap-3">
            <AlertTriangle className="w-5 h-5 text-red-600 shrink-0" />
            <p className="text-sm font-medium text-red-800">{reprocessStatus.step}</p>
          </div>
        </div>
      )}

      {/* Question list */}
      <div className="space-y-2">
        {questions.map((q, i) => {
          const ds = displayStatus(q as Record<string, unknown>);
          const isExpanded = expandedQ === q.id;

          return (
            <div
              key={q.id}
              className={`bg-white rounded-xl border transition-all ${
                ds === 'approved' ? 'border-green-200' :
                ds === 'flagged' ? 'border-amber-200' :
                'border-slate-200'
              }`}
            >
              {/* Collapsed row */}
              <button
                onClick={() => setExpandedQ(isExpanded ? null : q.id)}
                className="w-full flex items-center gap-3 px-4 py-3 text-left"
              >
                <span className="text-xs font-mono text-slate-400 w-8 shrink-0">
                  #{q.question_number ?? (i + 1)}
                </span>

                {/* Status badge */}
                <span className={`text-xs px-2 py-0.5 rounded-full font-medium shrink-0 ${
                  ds === 'approved' ? 'bg-green-100 text-green-700' :
                  ds === 'flagged' ? 'bg-amber-100 text-amber-700' :
                  ds === 'reviewed' ? 'bg-blue-100 text-blue-700' :
                  'bg-slate-100 text-slate-500'
                }`}>
                  {ds === 'approved' && <CheckCircle2 className="w-3 h-3 inline mr-1 -mt-0.5" />}
                  {ds === 'flagged' && <AlertTriangle className="w-3 h-3 inline mr-1 -mt-0.5" />}
                  {ds}
                </span>

                {/* Compact score journey */}
                {q.audit_trail && (q.audit_trail as Array<Record<string, unknown>>).length > 0 && (
                  <span className="flex items-center gap-0.5 shrink-0">
                    {(q.audit_trail as Array<Record<string, unknown>>)
                      .filter(e => !String(e.phase).includes('_fix'))
                      .map((e, ei) => {
                        const s = e.score as number;
                        const label = String(e.phase)[0].toUpperCase();
                        return (
                          <span key={ei} className={`text-[10px] font-mono px-1 py-0.5 rounded ${
                            s > 7 ? 'bg-green-100 text-green-700' :
                            s > 5 ? 'bg-amber-100 text-amber-700' :
                            'bg-red-100 text-red-700'
                          }`} title={`${e.phase}: ${s}/10`}>
                            {label}{s}
                          </span>
                        );
                      })}
                  </span>
                )}

                {q.is_image_question && (
                  <span className="text-xs px-1.5 py-0.5 rounded-full bg-purple-100 text-purple-600 shrink-0 flex items-center gap-0.5">
                    <ImageIcon className="w-3 h-3" />
                  </span>
                )}

                {/* Question preview */}
                <span className="text-sm text-slate-700 truncate flex-1">
                  {q.question}
                </span>

                <span className="text-xs text-slate-400 shrink-0">{q.subject}</span>

                {q.quality_score != null && (
                  <span className="text-xs font-mono text-slate-400 shrink-0">{q.quality_score}/10</span>
                )}

                {isExpanded
                  ? <ChevronUp className="w-4 h-4 text-slate-400 shrink-0" />
                  : <ChevronDown className="w-4 h-4 text-slate-400 shrink-0" />}
              </button>

              {/* Expanded detail */}
              {isExpanded && (
                <div className="px-4 pb-4 border-t border-slate-100 pt-3 space-y-3">
                  {/* Meta row */}
                  <div className="flex flex-wrap gap-2 text-xs text-slate-500">
                    <span className="px-2 py-0.5 bg-slate-100 rounded">{q.subject}</span>
                    <span className="px-2 py-0.5 bg-slate-100 rounded">{q.topic}</span>
                    {q.blooms_level && <span className="px-2 py-0.5 bg-slate-100 rounded">Bloom's: {q.blooms_level}</span>}
                    {q.difficulty != null && <span className="px-2 py-0.5 bg-slate-100 rounded">Difficulty: {q.difficulty}</span>}
                    {q.quality_score != null && <span className="px-2 py-0.5 bg-indigo-100 text-indigo-700 rounded">Audit: {q.quality_score}/10</span>}
                  </div>

                  {/* Image */}
                  {q.image_url && (
                    <QuestionImage
                      imageUrl={q.image_url}
                      imageType={q.image_type}
                      imageSource={q.image_source}
                    />
                  )}

                  <QuestionRenderer question={q} showAnswer={true} />

                  {/* Audit Trail — quality journey */}
                  {q.audit_trail && q.audit_trail.length > 0 && (
                    <div className="border border-slate-200 rounded-lg overflow-hidden">
                      <div className="px-3 py-2 bg-slate-50 border-b border-slate-200">
                        <span className="text-xs font-medium text-slate-600">Quality Journey</span>
                      </div>
                      <div className="divide-y divide-slate-100">
                        {(q.audit_trail as Array<Record<string, unknown>>).map((entry, idx) => {
                          const phase = entry.phase as string;
                          const score = entry.score as number | undefined;
                          const isFix = phase.includes('_fix');
                          const isImageFix = phase.includes('_image_fix');
                          const phaseLabel: Record<string, string> = {
                            validator: 'Validator Review',
                            validator_fix: 'Validator Fix',
                            validator_image_fix: 'Validator Image Fix',
                            adversarial: 'Adversarial Review',
                            adversarial_fix: 'Adversarial Fix',
                            adversarial_image_fix: 'Adversarial Image Fix',
                            audit: 'Final Audit',
                            reprocess_fix: 'Reprocess Fix',
                            reprocess_validator: 'Reprocess Validator',
                            reprocess_validator_fix: 'Reprocess Validator Fix',
                            reprocess_adversarial: 'Reprocess Adversarial',
                            reprocess_adversarial_fix: 'Reprocess Adversarial Fix',
                            reprocess_audit: 'Reprocess Audit',
                          };
                          const phaseColor: Record<string, string> = {
                            validator: 'text-blue-700 bg-blue-50',
                            validator_fix: 'text-purple-700 bg-purple-50',
                            validator_image_fix: 'text-pink-700 bg-pink-50',
                            adversarial: 'text-orange-700 bg-orange-50',
                            adversarial_fix: 'text-purple-700 bg-purple-50',
                            adversarial_image_fix: 'text-pink-700 bg-pink-50',
                            audit: score && score > 7 ? 'text-green-700 bg-green-50' : 'text-amber-700 bg-amber-50',
                            reprocess_fix: 'text-teal-700 bg-teal-50',
                            reprocess_validator: 'text-blue-700 bg-blue-50',
                            reprocess_validator_fix: 'text-purple-700 bg-purple-50',
                            reprocess_adversarial: 'text-orange-700 bg-orange-50',
                            reprocess_adversarial_fix: 'text-purple-700 bg-purple-50',
                            reprocess_audit: score && score > 7 ? 'text-green-700 bg-green-50' : 'text-amber-700 bg-amber-50',
                          };

                          return (
                            <div key={idx} className="px-3 py-2 text-xs">
                              <div className="flex items-center gap-2 mb-1">
                                <span className={`px-1.5 py-0.5 rounded font-medium ${phaseColor[phase] || 'text-slate-600 bg-slate-50'}`}>
                                  {phaseLabel[phase] || phase}
                                </span>
                                {score != null && (
                                  <span className={`font-mono font-medium ${score > 7 ? 'text-green-600' : score > 5 ? 'text-amber-600' : 'text-red-600'}`}>
                                    {score}/10
                                  </span>
                                )}
                              </div>
                              {entry.summary && (
                                <p className="text-slate-500 mt-0.5">{entry.summary as string}</p>
                              )}
                              {entry.reason && (
                                <p className="text-slate-500 mt-0.5">{entry.reason as string}</p>
                              )}
                              {entry.changes_requested && (
                                <div className="mt-1">
                                  <span className="text-slate-400">Changes requested: </span>
                                  <span className="text-slate-600">{(entry.changes_requested as string[]).join('; ')}</span>
                                </div>
                              )}
                              {entry.issues && (entry.issues as string[]).length > 0 && (
                                <div className="mt-1">
                                  <span className="text-slate-400">Issues: </span>
                                  <span className="text-slate-600">{(entry.issues as string[]).join('; ')}</span>
                                </div>
                              )}
                              {isFix && !isImageFix && entry.before && (
                                <details className="mt-1.5">
                                  <summary className="text-slate-400 cursor-pointer hover:text-slate-600">View before/after diff</summary>
                                  <div className="mt-1 grid grid-cols-2 gap-2">
                                    <div className="p-2 bg-red-50 rounded border border-red-100">
                                      <div className="font-medium text-red-600 mb-1">Before</div>
                                      <p className="text-slate-600">{(entry.before as Record<string, unknown>).question as string}</p>
                                    </div>
                                    <div className="p-2 bg-green-50 rounded border border-green-100">
                                      <div className="font-medium text-green-600 mb-1">After</div>
                                      <p className="text-slate-600">{(entry.after as Record<string, unknown>).question as string}</p>
                                    </div>
                                  </div>
                                </details>
                              )}
                              {isImageFix && (entry.before_image || entry.after_image) && (
                                <details className="mt-1.5" open>
                                  <summary className="text-slate-400 cursor-pointer hover:text-slate-600">View before/after images</summary>
                                  <div className="mt-1 grid grid-cols-2 gap-2">
                                    <div className="p-2 bg-red-50 rounded border border-red-100">
                                      <div className="font-medium text-red-600 mb-1">Before</div>
                                      {entry.before_image ? (
                                        <img src={entry.before_image as string} alt="Before" className="w-full max-h-48 object-contain rounded" />
                                      ) : (
                                        <p className="text-slate-400 italic">No image</p>
                                      )}
                                    </div>
                                    <div className="p-2 bg-green-50 rounded border border-green-100">
                                      <div className="font-medium text-green-600 mb-1">After</div>
                                      {entry.after_image ? (
                                        <img src={entry.after_image as string} alt="After" className="w-full max-h-48 object-contain rounded" />
                                      ) : (
                                        <p className="text-slate-400 italic">{entry.success === false ? 'Regeneration failed' : 'No image'}</p>
                                      )}
                                    </div>
                                  </div>
                                  {entry.feedback && (
                                    <p className="mt-1.5 text-slate-500"><span className="text-slate-400">Feedback: </span>{Array.isArray(entry.feedback) ? (entry.feedback as string[]).join('; ') : entry.feedback as string}</p>
                                  )}
                                </details>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* Fixed export button */}
      <div className="fixed bottom-0 left-0 right-0 bg-white/95 backdrop-blur border-t border-slate-200 px-6 py-4 z-50">
        <div className="max-w-6xl mx-auto flex items-center justify-between">
          <div className="text-sm text-slate-500">
            {questions.length} questions ({approvedCount} approved, {flaggedCount} flagged)
          </div>
          <button
            onClick={handleExport}
            disabled={questions.length === 0 || exporting}
            className="flex items-center gap-2 px-6 py-2.5 bg-indigo-600 text-white rounded-lg font-medium hover:bg-indigo-700 disabled:opacity-50 transition-colors shadow-lg"
          >
            {exporting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Download className="w-4 h-4" />}
            {exporting ? 'Packaging images...' : 'Export JSON'}
          </button>
        </div>
      </div>
    </div>
  );
}
