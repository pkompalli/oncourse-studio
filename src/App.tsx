import Stepper from './components/layout/Stepper';
import { useAppStore } from './store/appStore';
import Step1Structure from './components/steps/Step1Structure';
import Step1bGuidelines from './components/steps/Step1bGuidelines';
import Step2Generate from './components/steps/Step2Generate';
import Step3Review from './components/steps/Step3Review';
import Step4Audit from './components/steps/Step4Audit';
import Step5Export from './components/steps/Step6Export';
import Home from './components/Home';

const STEP_COMPONENTS: Record<string, React.FC> = {
  structure: Step1Structure,
  guidelines: Step1bGuidelines,
  generate: Step2Generate,
  review: Step3Review,
  audit: Step4Audit,
  export: Step5Export,
};

export default function App() {
  const { view, goHome, currentStep } = useAppStore();
  const StepComponent = STEP_COMPONENTS[currentStep];

  return (
    <div className="min-h-screen bg-slate-50 flex flex-col">
      {/* Header */}
      <header className="bg-white border-b border-slate-200 px-6 py-3">
        <button onClick={goHome} className="hover:opacity-80 transition-opacity text-left">
          <h1 className="text-xl font-bold text-slate-800">Oncourse studio</h1>
          <p className="text-xs text-slate-400 tracking-wide">QBank &middot; Lessons &middot; Flashcards</p>
        </button>
      </header>

      {/* Content */}
      {view === 'home' ? (
        <Home />
      ) : (
        <>
          <Stepper />
          <main className="flex-1 p-6 max-w-6xl mx-auto w-full">
            <StepComponent />
          </main>
        </>
      )}
    </div>
  );
}
