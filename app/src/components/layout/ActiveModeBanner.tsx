import React from 'react';
import { useWoprStore } from '../../state/useWoprStore';
import { store } from '../../state/store';
import { Clock, RotateCcw, Plus } from 'lucide-react';
import { DEFAULT_MODE_ID, ModeIcon } from '../common/ModeActivationDialog';

export const ActiveModeBanner: React.FC = () => {
  const { overview, modes } = useWoprStore();

  if (!overview.activeMode.id || overview.activeMode.id === DEFAULT_MODE_ID) {
    return null; // Silent for default mode
  }

  const activeModeItem = modes.modes.find((m) => m.id === overview.activeMode.id);

  return (
    <div className="w-full bg-gradient-to-r from-[#4c9ffe]/15 via-[#4c9ffe]/10 to-transparent border-b border-[#4c9ffe]/30 px-4 py-2 flex flex-wrap items-center justify-between gap-3 text-xs">
      <div className="flex items-center gap-2.5 text-wopr-text">
        <span className="p-1 rounded bg-[#4c9ffe]/25 text-wopr-accent">
          <ModeIcon icon={overview.activeMode.icon} className="w-3.5 h-3.5" />
        </span>
        <span className="font-semibold text-wopr-accent">
          Mode {activeModeItem?.label || overview.activeMode.label} actif
        </span>
        <span className="text-wopr-textMuted">•</span>
        <span className="text-wopr-textMuted">
          Activé par <strong className="text-wopr-text font-mono">@{overview.activeMode.activatedBy}</strong>
        </span>
        {/* `null` (et non `undefined`) quand aucun retour automatique n'est programmé :
            l'ancien test affichait alors « dans ~ min ». */}
        {overview.activeMode.remainingMinutes !== null && overview.activeMode.remainingMinutes !== undefined && (
          <>
            <span className="text-wopr-textMuted">•</span>
            <span className="flex items-center gap-1 text-amber-300 font-mono">
              <Clock className="w-3 h-3" />
              Retour auto à Équilibré dans ~{overview.activeMode.remainingMinutes} min
            </span>
          </>
        )}
      </div>

      <div className="flex items-center gap-2">
        {overview.activeMode.autoRevertAt && (
          <button
            onClick={() => store.extendMode(30)}
            className="flex items-center gap-1 px-2.5 py-1 rounded bg-white/5 hover:bg-white/10 text-wopr-text border border-wopr-border transition-colors font-medium"
          >
            <Plus className="w-3 h-3" />
            <span>Prolonger (+30 min)</span>
          </button>
        )}
        <button
          onClick={() => store.revertMode()}
          className="flex items-center gap-1 px-2.5 py-1 rounded bg-[#4c9ffe]/20 hover:bg-[#4c9ffe]/30 text-wopr-accent border border-[#4c9ffe]/40 transition-colors font-medium"
        >
          <RotateCcw className="w-3 h-3" />
          <span>Rétablir Équilibré</span>
        </button>
      </div>
    </div>
  );
};
