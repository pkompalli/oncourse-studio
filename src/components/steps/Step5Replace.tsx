import { useState } from 'react';
import { useAppStore } from '../../store/appStore';
import { jobs } from '../../services/api';
import { RefreshCw, Loader2, CheckCircle2, AlertCircle } from 'lucide-react';

export default function Step5Replace() {
  const { job, questions, completeStep, setStep } = useAppStore();
  const [replacing, setReplacing] = useState(false);
  const [statusMessage, setStatusMessage] = useState('');
  const isComplete = useAppStore((s) => s.completedSteps.has('replace'));

  const flagged = questions.filter(
    (q) => q.status === 'flagged' || (q.quality_score !== undefined && q.quality_score <= 7)
  );
  const manualReview = questions.filter((q) => q.status === 'manual_review');
  const replaced = questions.filter((q) => q.status === 'replaced');

  const startReplace = async () => {
    if (!job) return;
    setReplacing(true);
    setStatusMessage(`Regenerating ${flagged.length} flagged items (max 2 attempts each)...`);
    try {
      await pollReplace();
    } catch {
      setStatusMessage('Replacement failed');
      setReplacing(false);
    }
  };

  const pollReplace = async () => {
    if (!job) return;
    try {
      const res = await jobs.nextBatch(job.id, 'replace');
      if (res.status === 'complete') {
        setStatusMessage('Replacement complete');
        setReplacing(false);
        completeStep('replace');
      } else {
        setTimeout(pollReplace, 3000);
      }
    } catch {
      setTimeout(pollReplace, 5000);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold text-slate-800">Replace Flagged Items</h2>
          <p className="text-sm text-slate-500 mt-1">
            Regenerate flagged items with same metadata. Max 2 attempts before manual review.
          </p>
        </div>
        <div className="flex gap-3">
          {!isComplete && flagged.length > 0 && (
            <button
              onClick={startReplace}
              disabled={replacing}
              className="flex items-center gap-2 px-5 py-2 bg-indigo-600 text-white rounded-lg font-medium hover:bg-indigo-700 disabled:opacity-50 transition-colors"
            >
              {replacing ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />}
              {replacing ? 'Replacing...' : `Replace ${flagged.length} Items`}
            </button>
          )}
          {!isComplete && flagged.length === 0 && (
            <button
              onClick={() => { completeStep('replace'); setStep('export'); }}
              className="flex items-center gap-2 px-5 py-2 bg-green-600 text-white rounded-lg font-medium hover:bg-green-700 transition-colors"
            >
              <CheckCircle2 className="w-4 h-4" /> No items to replace — Skip
            </button>
          )}
          {isComplete && (
            <button
              onClick={() => setStep('export')}
              className="flex items-center gap-2 px-5 py-2 bg-green-600 text-white rounded-lg font-medium hover:bg-green-700 transition-colors"
            >
              <CheckCircle2 className="w-4 h-4" /> Proceed to Export
            </button>
          )}
        </div>
      </div>

      {statusMessage && (
        <div className="p-3 rounded-lg bg-blue-50 border border-blue-200 flex items-center gap-2">
          {replacing && <Loader2 className="w-4 h-4 text-blue-600 animate-spin" />}
          <span className="text-sm text-blue-700">{statusMessage}</span>
        </div>
      )}

      {/* Summary */}
      <div className="grid grid-cols-3 gap-4">
        <div className="bg-amber-50 p-5 rounded-xl border border-amber-200 text-center">
          <div className="text-2xl font-bold text-amber-700">{flagged.length}</div>
          <div className="text-sm text-amber-600">Flagged</div>
        </div>
        <div className="bg-green-50 p-5 rounded-xl border border-green-200 text-center">
          <div className="text-2xl font-bold text-green-700">{replaced.length}</div>
          <div className="text-sm text-green-600">Replaced</div>
        </div>
        <div className="bg-red-50 p-5 rounded-xl border border-red-200 text-center">
          <div className="text-2xl font-bold text-red-700">{manualReview.length}</div>
          <div className="text-sm text-red-600">Manual Review</div>
        </div>
      </div>

      {/* Manual Review Items */}
      {manualReview.length > 0 && (
        <div>
          <h3 className="text-sm font-semibold text-slate-700 mb-3 flex items-center gap-2">
            <AlertCircle className="w-4 h-4 text-red-500" />
            Needs Manual Review (failed 2 replacement attempts)
          </h3>
          <div className="space-y-2">
            {manualReview.map((q) => (
              <div key={q.id} className="p-3 bg-red-50 rounded-lg border border-red-200">
                <div className="text-sm text-slate-700">{q.question.slice(0, 150)}...</div>
                <div className="flex gap-3 text-xs text-red-600 mt-2">
                  <span>{q.subject} / {q.topic}</span>
                  <span>Attempts: {q.attempt_number}</span>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
