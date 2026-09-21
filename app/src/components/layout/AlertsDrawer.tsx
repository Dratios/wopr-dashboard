import React from 'react';
import { useWoprStore } from '../../state/useWoprStore';
import { store } from '../../state/store';
import type { AlertItem } from '../../state/types';
import { X, AlertOctagon, AlertTriangle, Info, CheckCircle, ShieldCheck } from 'lucide-react';

interface AlertsDrawerProps {
  isOpen: boolean;
  onClose: () => void;
}

const formatSince = (dateStr: string) => {
  const diffMs = Date.now() - new Date(dateStr).getTime();
  const diffMins = Math.floor(diffMs / 60000);
  if (diffMins < 60) return `il y a ${diffMins} min`;
  const diffHours = Math.floor(diffMins / 60);
  if (diffHours < 24) return `il y a ${diffHours} h`;
  return `il y a ${Math.floor(diffHours / 24)} j`;
};

interface SectionStyle {
  title: string;
  Icon: typeof AlertOctagon;
  heading: string;
  card: string;
  component: string;
  separator: string;
  button: string;
}

// Une section par niveau. L'ancienne version n'en avait que pour `err` et `warn` :
// l'alerte pare-feu, de niveau `info`, était comptée dans l'en-tête mais n'apparaissait
// nulle part — le panneau semblait vide.
const LEVEL_SECTIONS: Record<AlertItem['level'], SectionStyle> = {
  err: {
    title: 'Problèmes critiques',
    Icon: AlertOctagon,
    heading: 'text-[#f85149]',
    card: 'bg-[#f85149]/10 border-[#f85149]/30',
    component: 'text-rose-400',
    separator: 'border-rose-500/20',
    button: 'bg-rose-500/20 hover:bg-rose-500/30 text-rose-200',
  },
  warn: {
    title: "Points d'attention",
    Icon: AlertTriangle,
    heading: 'text-[#d29922]',
    card: 'bg-[#d29922]/10 border-[#d29922]/30',
    component: 'text-amber-400',
    separator: 'border-amber-500/20',
    button: 'bg-amber-500/20 hover:bg-amber-500/30 text-amber-200',
  },
  info: {
    title: 'Informations',
    Icon: Info,
    heading: 'text-sky-400',
    card: 'bg-sky-500/10 border-sky-500/30',
    component: 'text-sky-400',
    separator: 'border-sky-500/20',
    button: 'bg-sky-500/20 hover:bg-sky-500/30 text-sky-200',
  },
};

const ACKNOWLEDGED_SECTION: SectionStyle = {
  title: 'Acquittées — toujours actives',
  Icon: CheckCircle,
  heading: 'text-wopr-textMuted',
  card: 'bg-white/[0.03] border-wopr-border opacity-70',
  component: 'text-wopr-textMuted',
  separator: '',
  button: '',
};

const AlertSection: React.FC<{ alerts: AlertItem[]; style: SectionStyle; acknowledgeable: boolean }> = ({
  alerts,
  style,
  acknowledgeable,
}) => {
  if (alerts.length === 0) return null;
  return (
    <div>
      <div className={`flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider mb-2 ${style.heading}`}>
        <style.Icon className="w-3.5 h-3.5" />
        <span>
          {style.title} ({alerts.length})
        </span>
      </div>
      <div className="space-y-2">
        {alerts.map((alert) => (
          <div key={alert.id} className={`p-3 rounded-xl border flex flex-col gap-2 ${style.card}`}>
            <div className="flex items-start justify-between gap-2">
              <div>
                <span className={`text-[11px] font-mono font-semibold uppercase ${style.component}`}>
                  {alert.component}
                </span>
                <h4 className="text-xs font-medium text-wopr-text mt-0.5 leading-snug">{alert.message}</h4>
              </div>
              <span className="text-[10px] font-mono text-wopr-textMuted shrink-0">{formatSince(alert.since)}</span>
            </div>
            {acknowledgeable && (
              <div className={`flex justify-end pt-1 border-t ${style.separator}`}>
                <button
                  onClick={() => store.acknowledgeAlert(alert.id)}
                  className={`px-2.5 py-1 rounded text-xs font-medium transition-colors ${style.button}`}
                >
                  Acquitter
                </button>
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
};

export const AlertsDrawer: React.FC<AlertsDrawerProps> = ({ isOpen, onClose }) => {
  const { overview } = useWoprStore();

  if (!isOpen) return null;

  // Même règle que la pastille de la barre supérieure : seules les alertes non
  // acquittées sont « en attente ». Les acquittées restent visibles, à part, tant
  // que leur condition persiste.
  const pending = overview.alerts.filter((a) => !a.acknowledged);
  const acknowledged = overview.alerts.filter((a) => a.acknowledged);

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-black/60 backdrop-blur-xs animate-in fade-in duration-150">
      <div className="w-full max-w-md bg-[#161b22] border-l border-wopr-border h-full shadow-2xl flex flex-col animate-in slide-in-from-right duration-200">
        {/* Header */}
        <div className="p-4 border-b border-wopr-border flex items-center justify-between">
          <div className="flex items-center gap-2">
            <h3 className="font-semibold text-sm tracking-wide text-wopr-text">
              Alertes actives & Notifications
            </h3>
            <span className="text-xs px-2 py-0.5 rounded-full bg-wopr-surface2 text-wopr-accent font-mono font-bold">
              {pending.length}
            </span>
          </div>
          <button
            onClick={onClose}
            className="p-1 rounded-lg text-wopr-textMuted hover:text-wopr-text hover:bg-white/5 transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Content list */}
        <div className="flex-1 overflow-y-auto p-4 space-y-4">
          {overview.alerts.length === 0 ? (
            <div className="h-64 flex flex-col items-center justify-center text-center p-6 text-wopr-textMuted">
              <ShieldCheck className="w-12 h-12 text-[#3fb950] mb-3 opacity-90" />
              <p className="font-semibold text-wopr-text">Aucune alerte active</p>
              <p className="text-xs text-wopr-textMuted mt-1">
                Tous les sous-systèmes fonctionnent nominalement.
              </p>
            </div>
          ) : (
            <>
              {pending.length === 0 && (
                <p className="text-xs text-wopr-textMuted text-center py-2">
                  Aucune alerte en attente — les alertes ci-dessous ont déjà été acquittées.
                </p>
              )}
              {(['err', 'warn', 'info'] as const).map((level) => (
                <AlertSection
                  key={level}
                  alerts={pending.filter((a) => a.level === level)}
                  style={LEVEL_SECTIONS[level]}
                  acknowledgeable
                />
              ))}
              <AlertSection alerts={acknowledged} style={ACKNOWLEDGED_SECTION} acknowledgeable={false} />
            </>
          )}
        </div>

        {/* Footer */}
        {pending.length > 0 && (
          <div className="p-3 border-t border-wopr-border bg-[#0d1117]/80 flex items-center justify-between">
            <span className="text-xs text-wopr-textMuted">{pending.length} alerte(s) en attente</span>
            <button
              onClick={() => {
                pending.forEach((a) => store.acknowledgeAlert(a.id));
              }}
              className="px-3 py-1 rounded-lg text-xs font-medium bg-white/5 hover:bg-white/10 text-wopr-text border border-wopr-border transition-colors"
            >
              Tout acquitter
            </button>
          </div>
        )}
      </div>
    </div>
  );
};
