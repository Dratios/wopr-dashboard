import React, { useState } from 'react';

export interface StackedSegment {
  id: string;
  label: string;
  value: number;
  color: string;
  unit?: string;
}

interface StackedBarProps {
  total: number;
  segments: StackedSegment[];
  height?: number;
  showLegend?: boolean;
  className?: string;
}

export const StackedBar: React.FC<StackedBarProps> = ({
  total,
  segments,
  height = 14,
  showLegend = true,
  className = '',
}) => {
  const [hoveredSegment, setHoveredSegment] = useState<StackedSegment | null>(null);

  const sumValues = segments.reduce((acc, s) => acc + s.value, 0);
  const remaining = Math.max(0, total - sumValues);

  const allSegments = [...segments];
  if (remaining > 0.1) {
    allSegments.push({
      id: 'free_space',
      label: 'Libre / Inoccupé',
      value: remaining,
      color: '#21262d',
      unit: segments[0]?.unit,
    });
  }

  return (
    <div className={`w-full ${className}`}>
      {/* Interactive Stacked Bar */}
      <div
        className="w-full flex rounded-lg overflow-hidden border border-wopr-border/50 bg-[#161b22] relative"
        style={{ height }}
      >
        {allSegments.map((seg) => {
          const pct = total > 0 ? (seg.value / total) * 100 : 0;
          if (pct <= 0) return null;
          return (
            <div
              key={seg.id}
              onMouseEnter={() => setHoveredSegment(seg)}
              onMouseLeave={() => setHoveredSegment(null)}
              className="h-full transition-all duration-150 cursor-pointer relative group"
              style={{
                width: `${pct}%`,
                backgroundColor: seg.color,
                opacity: hoveredSegment && hoveredSegment.id !== seg.id ? 0.45 : 1,
              }}
              title={`${seg.label}: ${seg.value.toLocaleString()} ${seg.unit || ''} (${pct.toFixed(1)}%)`}
            />
          );
        })}
      </div>

      {/* Legend & Details */}
      {showLegend && (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 mt-2.5 text-xs font-mono">
          {allSegments.map((seg) => {
            const pct = total > 0 ? (seg.value / total) * 100 : 0;
            return (
              <div
                key={seg.id}
                onMouseEnter={() => setHoveredSegment(seg)}
                onMouseLeave={() => setHoveredSegment(null)}
                className={`flex items-center gap-1.5 transition-opacity cursor-pointer ${
                  hoveredSegment && hoveredSegment.id !== seg.id ? 'opacity-40' : 'opacity-100'
                }`}
              >
                <span
                  className="w-2.5 h-2.5 rounded-sm shrink-0"
                  style={{ backgroundColor: seg.color }}
                />
                <span className="text-wopr-text font-sans font-medium">{seg.label} :</span>
                <span className="text-wopr-textMuted tabular">
                  {typeof seg.value === 'number' ? seg.value.toFixed(1) : seg.value} {seg.unit || ''}
                </span>
                <span className="text-wopr-textSubtle text-[11px] tabular">
                  ({pct.toFixed(1)}%)
                </span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};
