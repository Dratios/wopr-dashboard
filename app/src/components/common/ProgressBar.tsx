import React from 'react';

interface ProgressBarProps {
  value: number; // 0 to 100
  label?: string;
  valueLabel?: string;
  height?: number;
  warnThreshold?: number;
  critThreshold?: number;
  colorOverride?: string;
  className?: string;
}

export const ProgressBar: React.FC<ProgressBarProps> = ({
  value,
  label,
  valueLabel,
  height = 8,
  warnThreshold = 75,
  critThreshold = 85,
  colorOverride,
  className = '',
}) => {
  const percentage = Math.max(0, Math.min(100, value));

  let barColor = colorOverride;
  if (!barColor) {
    if (percentage >= critThreshold) {
      barColor = 'bg-[#f85149]';
    } else if (percentage >= warnThreshold) {
      barColor = 'bg-[#d29922]';
    } else {
      barColor = 'bg-[#3fb950]';
    }
  }

  return (
    <div className={`w-full ${className}`}>
      {(label || valueLabel) && (
        <div className="flex justify-between items-center text-xs mb-1.5 font-medium">
          {label && <span className="text-wopr-textMuted">{label}</span>}
          {valueLabel && <span className="text-wopr-text font-mono tabular">{valueLabel}</span>}
        </div>
      )}
      <div
        className="w-full bg-[#21262d] rounded-full overflow-hidden"
        style={{ height }}
      >
        <div
          className={`h-full rounded-full transition-all duration-300 ease-out ${barColor}`}
          style={{ width: `${percentage}%` }}
        />
      </div>
    </div>
  );
};
