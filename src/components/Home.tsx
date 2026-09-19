import { useState, useEffect } from 'react';
import { useAppStore } from '../store/appStore';
import { jobs as jobsApi, courses as coursesApi, questions as questionsApi } from '../services/api';
import type { Job, Course, Question } from '../types';
import { Plus, Clock, CheckCircle2, AlertTriangle, Loader2, FileText, Trash2 } from 'lucide-react';
import Step1Structure from './steps/Step1Structure';

const STATUS_LABELS: Record<string, string> = {
  pending: 'Pending',
  generating: 'Generating',
  reviewing: 'Reviewing',
  auditing: 'Auditing',
  complete: 'Complete',
  failed: 'Failed',
};

const STATUS_COLORS: Record<string, string> = {
  pending: 'bg-slate-100 text-slate-600',
  generating: 'bg-blue-100 text-blue-700',
  reviewing: 'bg-indigo-100 text-indigo-700',
  auditing: 'bg-purple-100 text-purple-700',
  complete: 'bg-green-100 text-green-700',
  failed: 'bg-red-100 text-red-700',
};

function timeAgo(dateStr: string): string {
  const d = new Date(dateStr);
  const now = new Date();
  const diffMs = now.getTime() - d.getTime();
  const diffMin = Math.floor(diffMs / 60000);
  if (diffMin < 1) return 'just now';
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  const diffDay = Math.floor(diffHr / 24);
  if (diffDay < 30) return `${diffDay}d ago`;
  return d.toLocaleDateString();
}

export default function Home() {
  const { setView, setCourse, setJob, setQuestions, setStep, completeStep, resetFrom } = useAppStore();
  const [allJobs, setAllJobs] = useState<(Job & { course_name?: string })[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    loadJobs();
  }, []);

  const loadJobs = async () => {
    setLoading(true);
    try {
      const res = await jobsApi.listAll();
      const jobsList = (res.jobs || []) as Array<Job & { qb_courses?: { name: string } }>;
      setAllJobs(jobsList.map(j => ({
        ...j,
        course_name: j.qb_courses?.name || j.course || 'Unknown Course',
      })));
    } catch {
      // silent
    } finally {
      setLoading(false);
    }
  };

  const resumeJob = async (job: Job & { course_name?: string }) => {
    try {
      const res = await coursesApi.get(job.course_id);
      setCourse(res.course as Course);
    } catch { /* continue */ }

    setJob(job);

    try {
      const res = await questionsApi.list(job.id);
      setQuestions((res.questions || []) as Question[]);
    } catch { /* silent */ }

    const STATUS_STEP_MAP: Record<string, string> = {
      pending: 'generate',
      generating: 'generate',
      reviewing: 'review',
      auditing: 'audit',
      replacing: 'export',
      complete: 'export',
      failed: 'generate',
    };

    const stepOrder = ['structure', 'generate', 'review', 'audit', 'export'] as const;
    const targetStep = STATUS_STEP_MAP[job.status] || 'generate';
    const targetIdx = stepOrder.indexOf(targetStep as typeof stepOrder[number]);

    for (let i = 0; i < targetIdx; i++) {
      completeStep(stepOrder[i]);
    }

    const s = job.status;
    if (['reviewing', 'auditing', 'replacing', 'complete'].includes(s)) completeStep('generate');
    if (['auditing', 'replacing', 'complete'].includes(s)) completeStep('review');
    if (['replacing', 'complete'].includes(s)) completeStep('audit');

    setStep(targetStep as typeof stepOrder[number]);
    setView('pipeline');
  };

  const deleteJob = async (jobId: string, e: React.MouseEvent) => {
    e.stopPropagation();
    if (!confirm('Delete this generation run?')) return;
    try {
      await jobsApi.delete(jobId);
      setAllJobs(prev => prev.filter(j => j.id !== jobId));
    } catch (err) {
      // Never swallow this: a failed delete used to remove the row from the list
      // while the run stayed in the database, so storage never actually dropped.
      console.error('Delete failed', err);
      alert(`Could not delete this run: ${err instanceof Error ? err.message : 'unknown error'}`);
    }
  };

  const getJobStats = (job: Job) => {
    const progress = job.progress as Record<string, unknown> | undefined;
    const total = (progress?.total as number) || 0;
    const approved = (progress?.approved as number) || 0;
    const flagged = (progress?.flagged as number) || 0;
    return { total, approved, flagged };
  };

  return (
    <div className="flex-1 flex">
      {/* Left — main content (Structure step) */}
      <main className="flex-1 p-6 max-w-4xl mx-auto w-full">
        <Step1Structure />
      </main>

      {/* Right — history sidebar */}
      <aside className="w-80 border-l border-slate-200 bg-white flex flex-col overflow-hidden shrink-0">
        <div className="px-4 py-3 border-b border-slate-100">
          <h3 className="text-sm font-semibold text-slate-700">History</h3>
        </div>

        <div className="flex-1 overflow-y-auto">
          {loading && (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="w-5 h-5 animate-spin text-indigo-400" />
            </div>
          )}

          {!loading && allJobs.length === 0 && (
            <div className="text-center py-12 px-4">
              <FileText className="w-8 h-8 text-slate-300 mx-auto mb-2" />
              <p className="text-xs text-slate-400">No runs yet</p>
            </div>
          )}

          {!loading && allJobs.map((job) => {
            const stats = getJobStats(job);
            const isRunning = ['generating', 'reviewing', 'auditing'].includes(job.status);

            return (
              <button
                key={job.id}
                onClick={() => resumeJob(job)}
                className="w-full px-4 py-3 border-b border-slate-100 hover:bg-slate-50 transition-colors text-left group"
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-1.5 mb-0.5">
                      <span className="text-sm font-medium text-slate-700 truncate">
                        {job.course_name}
                      </span>
                    </div>
                    <div className="flex items-center gap-2">
                      <span className={`text-[10px] px-1.5 py-0.5 rounded-full font-medium ${STATUS_COLORS[job.status] || 'bg-slate-100 text-slate-500'}`}>
                        {isRunning && <Loader2 className="w-2.5 h-2.5 inline animate-spin mr-0.5" />}
                        {STATUS_LABELS[job.status] || job.status}
                      </span>
                      <span className="text-[10px] text-slate-400">{timeAgo(job.created_at)}</span>
                    </div>
                    {stats.total > 0 && (
                      <div className="flex items-center gap-2 mt-1 text-[10px] text-slate-500">
                        <span>{stats.total} Qs</span>
                        {stats.approved > 0 && (
                          <span className="text-green-600 flex items-center gap-0.5">
                            <CheckCircle2 className="w-2.5 h-2.5" />{stats.approved}
                          </span>
                        )}
                        {stats.flagged > 0 && (
                          <span className="text-amber-600 flex items-center gap-0.5">
                            <AlertTriangle className="w-2.5 h-2.5" />{stats.flagged}
                          </span>
                        )}
                      </div>
                    )}
                  </div>
                  <button
                    onClick={(e) => deleteJob(job.id, e)}
                    className="opacity-0 group-hover:opacity-100 p-1 text-slate-400 hover:text-red-500 rounded transition-all"
                    title="Delete"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
              </button>
            );
          })}
        </div>
      </aside>
    </div>
  );
}
