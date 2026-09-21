import React from 'react';
import { HealthLevel } from '../../state/types';

interface HealthDotProps {
  level: HealthLevel;
  size?: 'sm' | 'md' | 'lg';
  label?: string;
  pulse?: boolean;
  className?: string;
}

export const HealthDot: React.FC<HealthDotProps> = ({
  level,
  size = 'md',
  label,
  pulse = false,
  className = '',
}) => {
  const sizeClasses = {
    sm: 'w-2 h-2',
    md: 'w-2.5 h-2.5',
    lg: 'w-3.5 h-3.5',
  }[size];

  const colorClasses = {
    ok: 'bg-[#3fb950] shadow-[0_0_8px_rgba(63,185,80,0.6)]',
    warn: 'bg-[#d29922] shadow-[0_0_8px_rgba(210,153,34,0.6)]',
    err: 'bg-[#f85149] shadow-[0_0_10px_rgba(248,81,73,0.8)] animate-pulse',
    inactive: 'bg-[#6e7681]',
  }[level];

  return (
    <div className={`inline-flex items-center gap-1.5 ${className}`}>
      <span
        className={`rounded-full shrink-0 ${sizeClasses} ${colorClasses} ${
          pulse ? 'animate-ping' : ''
        }`}
      />
      {label && (
        <span className="text-xs font-medium text-wopr-text tracking-wide uppercase">
          {label}
        </span>
      )}
    </div>
  );
};
