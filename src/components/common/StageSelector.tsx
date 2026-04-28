import type { SnapshotStage } from '../../hooks/useSnapshots';
import { STAGE_LABELS } from '../../hooks/useSnapshots';
import { History, Loader2 } from 'lucide-react';

interface StageSelectorProps {
  availableStages: string[];
  currentStage: SnapshotStage | null;
  onStageChange: (stage: SnapshotStage | null) => void;
  loading?: boolean;
  /** The default label shown when no snapshot is selected (current/live data) */
  defaultLabel?: string;
}

const STAGE_ORDER: SnapshotStage[] = ['generated', 'post_validator', 'post_adversarial', 'post_audit', 'post_replace'];

export default function StageSelector({ availableStages, currentStage, onStageChange, loading, defaultLabel = 'Current' }: StageSelectorProps) {
  if (availableStages.length === 0) return null;

  const orderedStages = STAGE_ORDER.filter((s) => availableStages.includes(s));

  return (
    <div className="flex items-center gap-2 flex-wrap">
      <div className="flex items-center gap-1.5 text-xs text-slate-500">
        <History className="w-3.5 h-3.5" />
        <span>View stage:</span>
      </div>
      <button
        onClick={() => onStageChange(null)}
        className={`text-xs px-2.5 py-1 rounded-full transition-colors ${
          currentStage === null
            ? 'bg-indigo-100 text-indigo-700 font-medium'
            : 'bg-slate-100 text-slate-500 hover:bg-slate-200'
        }`}
      >
        {defaultLabel}
      </button>
      {orderedStages.map((stage) => (
        <button
          key={stage}
          onClick={() => onStageChange(stage)}
          className={`text-xs px-2.5 py-1 rounded-full transition-colors ${
            currentStage === stage
              ? 'bg-indigo-100 text-indigo-700 font-medium'
              : 'bg-slate-100 text-slate-500 hover:bg-slate-200'
          }`}
        >
          {STAGE_LABELS[stage]}
        </button>
      ))}
      {loading && <Loader2 className="w-3.5 h-3.5 text-slate-400 animate-spin" />}
    </div>
  );
}
