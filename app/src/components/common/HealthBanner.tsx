import React from 'react';
import { ShieldCheck, AlertTriangle, AlertOctagon, ChevronRight, Bell } from 'lucide-react';
import { HealthLevel } from '../../state/types';

interface HealthBannerProps {
  level: HealthLevel;
  summary: string;
  detail: string;
  alertsCount: number;
  onOpenAlerts?: () => void;
}

export const HealthBanner: React.FC<HealthBannerProps> = ({
  level,
  summary,
  detail,
  alertsCount,
  onOpenAlerts,
}) => {
  const config = {
    ok: {
      bg: 'bg-[#3fb950]/10 border-[#3fb950]/30',
      iconColor: 'text-[#3fb950]',
      titleColor: 'text-[#3fb950]',
      Icon: ShieldCheck,
      defaultTitle: 'Tout est nominal',
    },
    warn: {
      bg: 'bg-[#d29922]/10 border-[#d29922]/30',
      iconColor: 'text-[#d29922]',
      titleColor: 'text-[#d29922]',
      Icon: AlertTriangle,
      defaultTitle: summary,
    },
    err: {
      bg: 'bg-[#f85149]/15 border-[#f85149]/40 glow-err',
      iconColor: 'text-[#f85149]',
      titleColor: 'text-[#f85149]',
      Icon: AlertOctagon,
      defaultTitle: summary,
    },
    inactive: {
      bg: 'bg-wopr-surface border-wopr-border',
      iconColor: 'text-wopr-textMuted',
      titleColor: 'text-wopr-text',
      Icon: ShieldCheck,
      defaultTitle: 'Statut inconnu',
    },
  }[level];

  const Icon = config.Icon;

  return (
    <div
      className={`w-full rounded-xl border p-4 transition-all duration-200 flex flex-col md:flex-row md:items-center justify-between gap-4 ${config.bg}`}
    >
      <div className="flex items-center gap-3.5">
        <div className={`p-2.5 rounded-lg bg-black/20 ${config.iconColor} shrink-0`}>
          <Icon className="w-6 h-6" />
        </div>
        <div>
          <div className="flex items-center gap-2">
            <h2 className={`font-semibold text-base tracking-wide ${config.titleColor}`}>
              {summary}
            </h2>
            {alertsCount > 0 && (
              <span className="text-xs px-2 py-0.5 rounded-full bg-black/30 text-wopr-text font-mono border border-white/10">
                {alertsCount} alerte{alertsCount > 1 ? 's' : ''}
              </span>
            )}
          </div>
          <p className="text-sm text-wopr-textMuted mt-0.5 font-medium">{detail}</p>
        </div>
      </div>

      {alertsCount > 0 && onOpenAlerts && (
        <button
          onClick={onOpenAlerts}
          className="flex items-center self-start md:self-auto gap-2 px-3.5 py-1.5 rounded-lg bg-white/5 hover:bg-white/10 text-xs font-medium text-wopr-text border border-white/10 hover:border-white/20 transition-colors shrink-0"
        >
          <Bell className="w-3.5 h-3.5 text-wopr-accent" />
          <span>Examiner les alertes</span>
          <ChevronRight className="w-3.5 h-3.5 opacity-60" />
        </button>
      )}
    </div>
  );
};
