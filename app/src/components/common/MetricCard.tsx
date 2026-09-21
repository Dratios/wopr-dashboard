import React from 'react';
import { HealthDot } from './HealthDot';
import { Sparkline } from './Sparkline';
import { HealthLevel } from '../../state/types';
import { ArrowUpRight, ArrowDownRight } from 'lucide-react';

interface MetricCardProps {
  title: string;
  value: string | number;
  unit?: string;
  subvalue?: string;
  delta?: {
    value: string;
    isPositive?: boolean;
    isNeutral?: boolean;
  };
  level?: HealthLevel;
  icon?: React.ReactNode;
  sparklineData?: number[];
  onClick?: () => void;
  className?: string;
}

export const MetricCard: React.FC<MetricCardProps> = ({
  title,
  value,
  unit,
  subvalue,
  delta,
  level = 'ok',
  icon,
  sparklineData,
  onClick,
  className = '',
}) => {
  const sparkColor = {
    ok: '#3fb950',
    warn: '#d29922',
    err: '#f85149',
    inactive: '#6e7681',
  }[level];

  return (
    <div
      onClick={onClick}
      className={`relative bg-wopr-surface hover:bg-wopr-surface2 border border-wopr-border hover:border-wopr-borderLight rounded-xl p-4 transition-all duration-150 group ${
        onClick ? 'cursor-pointer hover:shadow-lg hover:-translate-y-0.5' : ''
      } ${className}`}
    >
      <div className="flex items-start justify-between gap-2 mb-2">
        <div className="flex items-center gap-2">
          {icon && (
            <span className="text-wopr-textMuted group-hover:text-wopr-accent transition-colors">
              {icon}
            </span>
          )}
          <span className="text-xs font-medium text-wopr-textMuted uppercase tracking-wider">
            {title}
          </span>
        </div>
        <HealthDot level={level} size="sm" />
      </div>

      <div className="flex items-baseline justify-between gap-3">
        <div className="flex items-baseline gap-1.5">
          <span className="text-2xl font-bold font-mono tracking-tight text-wopr-text tabular">
            {value}
          </span>
          {unit && <span className="text-xs font-mono text-wopr-textMuted">{unit}</span>}
        </div>

        {sparklineData && (
          <div className="shrink-0 opacity-80 group-hover:opacity-100 transition-opacity">
            <Sparkline data={sparklineData} color={sparkColor} width={70} height={24} />
          </div>
        )}
      </div>

      {(subvalue || delta) && (
        <div className="mt-2.5 pt-2 border-t border-wopr-border/50 flex items-center justify-between text-xs">
          {subvalue && (
            <span className="text-wopr-textMuted truncate max-w-[170px]">{subvalue}</span>
          )}
          {delta && (
            <span
              className={`flex items-center font-mono ml-auto ${
                delta.isNeutral
                  ? 'text-wopr-textMuted'
                  : delta.isPositive
                  ? 'text-emerald-400'
                  : 'text-rose-400'
              }`}
            >
              {delta.isPositive ? (
                <ArrowUpRight className="w-3.5 h-3.5 mr-0.5" />
              ) : delta.isNeutral ? null : (
                <ArrowDownRight className="w-3.5 h-3.5 mr-0.5" />
              )}
              {delta.value}
            </span>
          )}
        </div>
      )}
    </div>
  );
};
