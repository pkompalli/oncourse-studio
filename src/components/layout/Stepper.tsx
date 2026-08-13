import { STEPS } from '../../types';
import { useAppStore } from '../../store/appStore';
import { Check } from 'lucide-react';
import type { StepId } from '../../types';

export default function Stepper() {
  const { currentStep, completedSteps, setStep } = useAppStore();

  const stepOrder: StepId[] = ['structure', 'guidelines', 'generate', 'review', 'audit', 'export'];

  const canNavigate = (stepId: StepId) => {
    if (stepId === currentStep) return true;
    if (completedSteps.has(stepId)) return true;
    // Allow navigating to any step up to and including the current step index
    const targetIdx = stepOrder.indexOf(stepId);
    const currentIdx = stepOrder.indexOf(currentStep);
    // Also allow navigating to steps whose predecessor is completed
    if (targetIdx <= currentIdx) return true;
    if (targetIdx > 0 && completedSteps.has(stepOrder[targetIdx - 1])) return true;
    return false;
  };

  return (
    <nav className="flex items-center justify-between px-6 py-4 border-b border-slate-200 bg-white">
      {STEPS.map((step, i) => {
        const isActive = currentStep === step.id;
        const isComplete = completedSteps.has(step.id);
        const isClickable = canNavigate(step.id);

        return (
          <div key={step.id} className="flex items-center flex-1">
            <button
              onClick={() => isClickable && setStep(step.id)}
              disabled={!isClickable}
              className={`flex items-center gap-2 px-3 py-2 rounded-lg transition-all ${
                isActive
                  ? 'bg-indigo-50 text-indigo-700'
                  : isComplete
                  ? 'text-green-700 hover:bg-green-50 cursor-pointer'
                  : isClickable
                  ? 'text-slate-600 hover:bg-slate-50 cursor-pointer'
                  : 'text-slate-400 cursor-not-allowed'
              }`}
            >
              <span
                className={`flex items-center justify-center w-8 h-8 rounded-full text-sm font-semibold ${
                  isActive
                    ? 'bg-indigo-600 text-white'
                    : isComplete
                    ? 'bg-green-100 text-green-700'
                    : isClickable
                    ? 'bg-slate-200 text-slate-600'
                    : 'bg-slate-100 text-slate-400'
                }`}
              >
                {isComplete ? <Check className="w-4 h-4" /> : step.number}
              </span>
              <div className="text-left hidden sm:block">
                <div className="text-sm font-medium leading-tight">{step.label}</div>
                <div className="text-xs text-slate-400">{step.description}</div>
              </div>
            </button>

            {i < STEPS.length - 1 && (
              <div
                className={`flex-1 h-0.5 mx-2 ${
                  isComplete ? 'bg-green-300' : 'bg-slate-200'
                }`}
              />
            )}
          </div>
        );
      })}
    </nav>
  );
}
