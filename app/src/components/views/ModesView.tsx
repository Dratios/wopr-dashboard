import React, { useState } from 'react';
import { useWoprStore } from '../../state/useWoprStore';
import { store } from '../../state/store';
import {
  ModeActivationDialog, ModeIcon, containerImpact, describeFanPreset, describeGpuLimit,
  describeKeepAlive, DEFAULT_MODE_ID,
} from '../common/ModeActivationDialog';
import { Sliders, CheckCircle, Calendar, History, ArrowRight } from 'lucide-react';
import { ModeItem, ModePolicy } from '../../state/types';


/**
 * Rendu des leviers d'un mode.
 *
 * Ne sont listés que ceux qui agissent réellement sur la machine. La maquette
 * affichait aussi « mises à jour auto », « notifications » et « limites de
 * ressources conteneurs » : aucun mécanisme ne les appliquait, ils ont été retirés.
 */

const PolicyRow: React.FC<{ label: string; value: string; muted?: boolean }> = ({
  label,
  value,
  muted,
}) => (
  <div className="flex justify-between gap-3">
    <span className="text-wopr-textSubtle shrink-0">{label}</span>
    <span className={`font-semibold text-right truncate ${muted ? 'text-wopr-textMuted' : 'text-wopr-text'}`}>
      {value}
    </span>
  </div>
);

const PolicyRows: React.FC<{ policies: ModePolicy }> = ({ policies }) => {
  const containers = containerImpact(policies);
  return (
    <>
      <PolicyRow
        label="Gouverneur CPU :"
        value={policies.cpuGovernor ?? 'inchangé'}
        muted={!policies.cpuGovernor}
      />
      <PolicyRow
        label="Préférence énergie :"
        value={policies.cpuEpp ?? 'inchangée'}
        muted={!policies.cpuEpp}
      />
      <PolicyRow
        label="Limite GPU :"
        value={describeGpuLimit(policies.gpuPowerLimit)}
        muted={policies.gpuPowerLimit === undefined}
      />
      <PolicyRow
        label="Ventilation :"
        value={describeFanPreset(policies.fanCurvePreset)}
        muted={policies.fanCurvePreset === undefined}
      />
      <PolicyRow
        label="Rétention modèles :"
        value={describeKeepAlive(policies.ollamaKeepAlive)}
        muted={policies.ollamaKeepAlive === undefined}
      />
      <PolicyRow
        label="Conteneurs :"
        value={containers.length ? containers.join(', ') : 'aucun touché'}
        muted={containers.length === 0}
      />
    </>
  );
};

export const ModesView: React.FC = () => {
  const { modes } = useWoprStore();
  const { active, modes: modeList, history } = modes;

  const [selectedModeForActivation, setSelectedModeForActivation] = useState<ModeItem | null>(null);
  const labelOf = (id: string) => modeList.find((m) => m.id === id)?.label ?? id;

  const activeModeObj = modeList.find((m) => m.id === active);

  return (
    <div className="space-y-6 animate-in fade-in duration-200">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 pb-4 border-b border-wopr-border">
        <div>
          <h1 className="text-xl font-bold tracking-tight text-wopr-text flex items-center gap-2.5">
            <Sliders className="w-5 h-5 text-wopr-accent" />
            <span>Modes & Profils Machine</span>
          </h1>
          <p className="text-xs text-wopr-textMuted mt-1">
            Gouvernance centralisée : appliquez en un clic des politiques globales cohérentes (CPU, GPU, ventilation, conteneurs)
          </p>
        </div>

        <div className="flex items-center gap-2">
          <span className="text-xs px-3 py-1.5 rounded-lg bg-wopr-accent/15 border border-wopr-accent/30 text-wopr-accent font-semibold font-mono">
            Profil actif : {activeModeObj?.label}
          </span>
        </div>
      </div>

      {/* SECTION 1: MODE CARDS GRID */}
      <div>
        <h3 className="text-xs font-semibold uppercase tracking-wider text-wopr-text mb-3">
          Profils disponibles ({modeList.length})
        </h3>

        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          {modeList.map((mode) => {
            const isActive = mode.id === active;

            return (
              <div
                key={mode.id}
                className={`rounded-xl border p-5 flex flex-col justify-between space-y-4 transition-all ${
                  isActive
                    ? 'bg-wopr-surface2 border-wopr-accent shadow-lg ring-1 ring-wopr-accent/40 glow-accent'
                    : 'bg-wopr-surface border-wopr-border hover:border-wopr-borderLight'
                }`}
              >
                <div>
                  <div className="flex items-start justify-between gap-3 pb-3 border-b border-wopr-border/60">
                    <div className="flex items-center gap-3">
                      <div className="p-2.5 rounded-lg bg-[#0d1117] border border-wopr-border">
                        <ModeIcon icon={mode.icon} />
                      </div>
                      <div>
                        <h4 className="font-bold text-base text-wopr-text">{mode.label}</h4>
                        <span className="text-[11px] text-wopr-textMuted font-mono">
                          ID: {mode.id}
                        </span>
                      </div>
                    </div>

                    {isActive && (
                      <span className="px-2 py-0.5 rounded text-[10px] font-mono font-bold bg-wopr-accent text-white uppercase shadow-sm">
                        Actif
                      </span>
                    )}
                  </div>

                  <p className="text-xs text-wopr-textMuted my-3 leading-relaxed">
                    {mode.description}
                  </p>

                  {/* Leviers réellement appliqués par ce mode */}
                  <div className="space-y-1.5 pt-2 border-t border-wopr-border/40 text-[11px] font-mono">
                    <PolicyRows policies={mode.policies} />
                  </div>
                </div>

                <div className="pt-3 border-t border-wopr-border/60">
                  {isActive ? (
                    <div className="flex items-center justify-between text-xs text-wopr-accent font-medium">
                      <span className="flex items-center gap-1.5">
                        <CheckCircle className="w-4 h-4" />
                        Profil en cours d'exécution
                      </span>
                      {mode.id !== DEFAULT_MODE_ID && (
                        <button
                          onClick={() => store.revertMode()}
                          className="text-xs text-wopr-textMuted hover:text-wopr-text underline"
                        >
                          Rétablir Équilibré
                        </button>
                      )}
                    </div>
                  ) : (
                    <button
                      onClick={() => setSelectedModeForActivation(mode)}
                      className="w-full py-2 px-3 rounded-lg bg-white/5 hover:bg-wopr-accent hover:text-white border border-wopr-border text-xs font-semibold text-wopr-text transition-all shadow-sm"
                    >
                      Activer ce mode
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* SECTION 2: SCHEDULES & RECENT MODE HISTORY */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Schedules */}
        <div className="bg-wopr-surface border border-wopr-border rounded-xl p-5 flex flex-col justify-between">
          <div>
            <div className="flex items-center justify-between pb-3 border-b border-wopr-border mb-3">
              <div className="flex items-center gap-2">
                <Calendar className="w-4 h-4 text-cyan-400" />
                <h3 className="text-xs font-semibold uppercase tracking-wider text-wopr-text">
                  Planification des modes
                </h3>
              </div>
              <span className="text-[11px] font-mono text-wopr-textMuted">Règles automatiques</span>
            </div>

            <div className="p-3 rounded-lg bg-[#0d1117] border border-dashed border-wopr-border text-xs text-wopr-textMuted leading-relaxed">
              La planification horaire des modes n'est pas encore implémentée. Les
              règles du type « <em>Silencieux de 23:00 à 07:00</em> » figuraient dans
              la maquette mais rien ne les exécutait : elles sont retirées plutôt
              qu'affichées sans effet.
            </div>
          </div>
        </div>

        {/* Mode Change History */}
        <div className="bg-wopr-surface border border-wopr-border rounded-xl p-5 flex flex-col justify-between">
          <div>
            <div className="flex items-center justify-between pb-3 border-b border-wopr-border mb-3">
              <div className="flex items-center gap-2">
                <History className="w-4 h-4 text-purple-400" />
                <h3 className="text-xs font-semibold uppercase tracking-wider text-wopr-text">
                  Journal des transitions de mode
                </h3>
              </div>
              <span className="text-[11px] font-mono text-wopr-textMuted">Audit des admins</span>
            </div>

            <div className="space-y-2.5">
              {history.length === 0 && (
                <p className="text-xs text-wopr-textMuted">Aucun changement de mode enregistré.</p>
              )}
              {history.map((hist) => (
                <div
                  key={hist.id}
                  className="p-3 rounded-lg bg-[#0d1117] border border-wopr-border flex flex-col gap-1.5 text-xs font-mono"
                >
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <span className="text-wopr-textMuted">{labelOf(hist.from)}</span>
                      <ArrowRight className="w-3 h-3 text-wopr-accent" />
                      <span className="font-bold text-wopr-accent">{labelOf(hist.to)}</span>
                    </div>
                    <span className="text-[10px] text-wopr-textSubtle">
                      {new Date(hist.at).toLocaleString('fr-FR', {
                        day: '2-digit',
                        month: '2-digit',
                        hour: '2-digit',
                        minute: '2-digit',
                      })}
                    </span>
                  </div>

                  <div className="flex items-center justify-between text-[11px]">
                    <span className="text-wopr-text font-sans font-medium">{hist.reason}</span>
                    <span className="text-cyan-400">@{hist.by}</span>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>

      <ModeActivationDialog
        target={selectedModeForActivation}
        current={activeModeObj}
        onClose={() => setSelectedModeForActivation(null)}
      />
    </div>
  );
};
