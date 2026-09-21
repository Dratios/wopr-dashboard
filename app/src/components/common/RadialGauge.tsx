import React from 'react';

interface RadialGaugeProps {
  value: number; // 0 to 100
  max?: number;
  label?: string;
  sublabel?: string;
  size?: number;
  strokeWidth?: number;
  warnThreshold?: number;
  critThreshold?: number;
  showPercentSign?: boolean;
  colorOverride?: string;
}

export const RadialGauge: React.FC<RadialGaugeProps> = ({
  value,
  max = 100,
  label,
  sublabel,
  size = 120,
  strokeWidth = 10,
  warnThreshold = 75,
  critThreshold = 85,
  showPercentSign = true,
  colorOverride,
}) => {
  const clampedValue = Math.max(0, Math.min(max, value));
  const percentage = (clampedValue / max) * 100;

  const radius = (size - strokeWidth) / 2;
  const circumference = 2 * Math.PI * radius;
  // 240 degrees arc for a cockpit gauge feel
  const arcAngle = 240;
  const arcCircumference = (arcAngle / 360) * circumference;
  const strokeDashoffset = arcCircumference - (percentage / 100) * arcCircumference;

  // Determine color based on threshold
  let strokeColor = colorOverride;
  if (!strokeColor) {
    if (percentage >= critThreshold) {
      strokeColor = '#f85149';
    } else if (percentage >= warnThreshold) {
      strokeColor = '#d29922';
    } else {
      strokeColor = '#3fb950';
    }
  }

  // Rotation to position opening at bottom: 90 deg + (360 - arcAngle) / 2 = 90 + 60 = 150 deg
  const rotation = 150;

  return (
    <div className="flex flex-col items-center justify-center relative">
      <div className="relative" style={{ width: size, height: size }}>
        <svg
          width={size}
          height={size}
          viewBox={`0 0 ${size} ${size}`}
          className="overflow-visible"
        >
          {/* Background track */}
          <circle
            cx={size / 2}
            cy={size / 2}
            r={radius}
            fill="none"
            stroke="#21262d"
            strokeWidth={strokeWidth}
            strokeDasharray={`${arcCircumference} ${circumference}`}
            strokeLinecap="round"
            transform={`rotate(${rotation} ${size / 2} ${size / 2})`}
          />
          {/* Active gauge arc */}
          <circle
            cx={size / 2}
            cy={size / 2}
            r={radius}
            fill="none"
            stroke={strokeColor}
            strokeWidth={strokeWidth}
            strokeDasharray={`${arcCircumference} ${circumference}`}
            strokeDashoffset={strokeDashoffset}
            strokeLinecap="round"
            transform={`rotate(${rotation} ${size / 2} ${size / 2})`}
            className="transition-all duration-300 ease-out"
          />
        </svg>

        {/* Center content */}
        <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none">
          <div className="flex items-baseline justify-center">
            <span className="text-xl font-bold font-mono tracking-tight text-wopr-text tabular">
              {Math.round(clampedValue)}
            </span>
            {showPercentSign && (
              <span className="text-xs font-mono text-wopr-textMuted ml-0.5">%</span>
            )}
          </div>
          {label && (
            <span className="text-[10px] uppercase tracking-wider text-wopr-textMuted font-medium mt-0.5">
              {label}
            </span>
          )}
        </div>
      </div>
      {sublabel && (
        <span className="text-xs text-wopr-textMuted font-mono mt-1 text-center truncate max-w-full">
          {sublabel}
        </span>
      )}
    </div>
  );
};
