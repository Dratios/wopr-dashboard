import React, { useEffect, useState } from 'react';
import { Activity, Gauge, Leaf, Moon, Sliders, Wrench, Zap } from 'lucide-react';
import { store } from '../../state/store';
import type { ModeItem, ModePolicy } from '../../state/types';
import { ConfirmDialog } from './ConfirmDialog';

/** Mode de retour automatique, cf. `DEFAULT_MODE_ID` dans server/modes.py. */
export const DEFAULT_MODE_ID = 'equilibre';

/**
 * Icône d'un mode. Les noms viennent de `config/modes.yaml`, en minuscules
 * (`zap`, `moon`…) : l'ancienne correspondance attendait `Zap`, `Moon`… et tous les
 * modes retombaient sur l'icône par défaut.
 */
export const ModeIcon: React.FC<{ icon: string; className?: string }> = ({ icon, className = 'w-5 h-5' }) => {
  switch (icon.toLowerCase()) {
    case 'zap':
      return <Zap className={`${className} text-amber-400`} />;
    case 'gauge':
      return <Gauge className={`${className} text-emerald-400`} />;
    case 'activity':
      return <Activity className={`${className} text-emerald-400`} />;
    case 'moon':
      return <Moon className={`${className} text-cyan-400`} />;
    case 'leaf':
      return <Leaf className={`${className} text-lime-400`} />;
    case 'wrench':
      return <Wrench className={`${className} text-purple-400`} />;
    default:
      return <Sliders className={`${className} text-wopr-accent`} />;
  }
};

/** Une consigne de limite GPU, en français lisible. */
export function describeGpuLimit(spec: ModePolicy['gpuPowerLimit']): string {
  if (spec === undefined || spec === null) return 'inchangée';
  if (typeof spec === 'object') {
    return Object.entries(spec)
      .map(([index, value]) =>
        index === 'all' ? describeGpuLimit(value) : `carte ${index} : ${describeGpuLimit(value)}`)
      .join(' · ');
  }
  if (spec === 'max') return 'maximum de la carte';
  if (spec === 'min') return 'minimum de la carte';
  if (typeof spec === 'number') return `${spec} W`;
  if (spec.endsWith('%')) return `${spec} de la plage`;
  return String(spec);
}

export function describeFanPreset(preset: ModePolicy['fanCurvePreset']): string {
  if (preset === undefined) return 'inchangée';
  // `null` a un sens précis : on rend la main au Smart Fan IV de la carte mère.
  if (preset === null) return 'pilotage carte mère';
  return preset;
}

export function describeKeepAlive(value: ModePolicy['ollamaKeepAlive']): string {
  if (value === undefined) return 'inchangée';
  if (value === 0 || value === '0') return 'déchargement immédiat';
  if (value === -1 || value === '-1') return 'jamais déchargés';
  return String(value);
}

/** Conteneurs qu'un mode va explicitement arrêter ou démarrer. */
export function containerImpact(policies: ModePolicy): string[] {
  const { stop = [], start = [] } = policies.containers ?? {};
  return [
    ...stop.map((name) => `${name} (arrêt)`),
    ...start.map((name) => `${name} (démarrage)`),
  ];
}

const DiffRow: React.FC<{ label: string; from: string; to: string }> = ({ label, from, to }) => (
  <div className="flex justify-between gap-3">
    <span className="shrink-0">{label}</span>
    <span className={`text-right font-bold ${from === to ? 'text-wopr-textMuted' : 'text-amber-400'}`}>
      {from === to ? to : `${from} → ${to}`}
    </span>
  </div>
);

interface ModeActivationDialogProps {
  /** Mode à activer ; `null` ferme la boîte de dialogue. */
  target: ModeItem | null;
  current: ModeItem | undefined;
  onClose: () => void;
}

/**
 * Confirmation d'un changement de mode : différentiel des leviers, motif obligatoire
 * et retour automatique. Partagée par la vue Modes, la barre supérieure et la vue
 * d'ensemble — ces deux dernières changeaient de mode en un clic, sans motif ni
 * aperçu de ce qui allait être modifié.
 */
export const ModeActivationDialog: React.FC<ModeActivationDialogProps> = ({ target, current, onClose }) => {
  const [revertDuration, setRevertDuration] = useState<number>(60);

  useEffect(() => {
    if (target) setRevertDuration(target.id === DEFAULT_MODE_ID ? 0 : 60);
  }, [target]);

  if (!target) return null;

  const from = current?.policies ?? {};
  const to = target.policies;
  const impact = containerImpact(to);

  return (
    <ConfirmDialog
      isOpen
      title={`Activer le mode : ${target.label}`}
      requireReason
      description={
        <div className="space-y-3">
          <p className="text-xs text-wopr-textMuted">
            Vous allez faire basculer le serveur <strong>wopr</strong> du profil{' '}
            <strong className="text-wopr-text">{current?.label ?? '—'}</strong> vers{' '}
            <strong className="text-wopr-accent">{target.label}</strong>.
          </p>

          <div className="p-3 rounded-lg bg-[#0d1117] border border-wopr-border text-xs font-mono space-y-1.5">
            <div className="text-[10px] uppercase font-bold text-wopr-textSubtle pb-1 border-b border-wopr-border/50">
              Leviers appliqués :
            </div>
            <DiffRow label="Gouverneur CPU :" from={from.cpuGovernor ?? 'inchangé'} to={to.cpuGovernor ?? 'inchangé'} />
            <DiffRow label="Préférence énergie :" from={from.cpuEpp ?? 'inchangée'} to={to.cpuEpp ?? 'inchangée'} />
            <DiffRow label="Limite GPU :" from={describeGpuLimit(from.gpuPowerLimit)} to={describeGpuLimit(to.gpuPowerLimit)} />
            <DiffRow label="Ventilation :" from={describeFanPreset(from.fanCurvePreset)} to={describeFanPreset(to.fanCurvePreset)} />
            <DiffRow label="Rétention modèles :" from={describeKeepAlive(from.ollamaKeepAlive)} to={describeKeepAlive(to.ollamaKeepAlive)} />
            {impact.length > 0 && (
              <div className="mt-2 pt-2 border-t border-wopr-border/50 text-amber-400">
                <span className="font-bold">Conteneurs affectés : </span>
                {impact.join(', ')}
              </div>
            )}
          </div>

          {target.id !== DEFAULT_MODE_ID && (
            <div>
              <label className="block text-xs font-medium text-wopr-text mb-1">
                Retour automatique vers le mode Équilibré :
              </label>
              <select
                value={revertDuration}
                onChange={(e) => setRevertDuration(Number(e.target.value))}
                className="w-full bg-[#0d1117] border border-wopr-border rounded-lg p-2 text-xs text-wopr-text focus:outline-none focus:border-wopr-accent"
              >
                <option value={30}>Après 30 minutes</option>
                <option value={60}>Après 1 heure</option>
                <option value={120}>Après 2 heures</option>
                <option value={0}>Désactivé (changement manuel uniquement)</option>
              </select>
            </div>
          )}
        </div>
      }
      confirmText="Appliquer le profil machine"
      onConfirm={(reason) => {
        void store.setMode(target.id, reason || 'Changement manuel de profil', revertDuration);
        onClose();
      }}
      onCancel={onClose}
    />
  );
};
