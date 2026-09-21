import React, { useEffect, useState } from 'react';
import { api } from '../../state/api';
import type { HistoryData } from '../../state/types';

export interface SeriesConfig {
  id: string;
  name: string;
  color: string;
  unit: string;
  data: number[];
  visible?: boolean;
  /** `right` : échelle propre, graduée à droite, tracée en pointillés sans
   * remplissage — pour superposer une grandeur d'une autre unité. */
  axis?: 'left' | 'right';
}

type Range = HistoryData['range'];

interface TimeSeriesChartProps {
  title?: string;
  series: SeriesConfig[];
  timestamps?: string[];
  /**
   * Série → métrique de l'historique PostgreSQL (`cpu`, `temp:k10temp-0`…). Si
   * fourni, le graphe lit la fenêtre choisie dans `/api/history` et la
   * rafraîchit en direct ; `series[].data` ne sert plus que de repli quand la
   * base ne répond pas.
   */
  historyMetrics?: Record<string, string>;
  height?: number;
  warnThreshold?: number;
  critThreshold?: number;
  showTimeRangeSelector?: boolean;
  className?: string;
}

const RANGE_SECONDS: Record<Range, number> = {
  '1m': 60,
  '5m': 300,
  '1h': 3600,
  '6h': 21600,
};

/** `timestamps` ne contient que "HH:MM:SS" (pas de date) : on ne peut estimer
 * qu'un intervalle d'échantillonnage local, pas franchir minuit proprement —
 * sans importance vu la profondeur de l'historique en mémoire (quelques minutes). */
function estimateSampleIntervalS(timestamps: string[]): number | null {
  const toSeconds = (t: string) => {
    const m = /^(\d{2}):(\d{2}):(\d{2})$/.exec(t);
    return m ? Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) : null;
  };
  for (let i = timestamps.length - 1; i > 0; i--) {
    const a = toSeconds(timestamps[i - 1]);
    const b = toSeconds(timestamps[i]);
    if (a !== null && b !== null && b > a) return b - a;
  }
  return null;
}

function formatTime(epochS: number, withSeconds: boolean): string {
  return new Date(epochS * 1000).toLocaleTimeString('fr-FR', {
    hour: '2-digit',
    minute: '2-digit',
    ...(withSeconds ? { second: '2-digit' } : {}),
  });
}

/**
 * Lit une fenêtre de l'historique et la tient à jour : un rafraîchissement par
 * pas de la fenêtre (5 s à 1 min), borné à 30 s pour que le dernier point, en
 * cours de calcul, ne reste pas figé sur 6 h.
 */
function useHistory(metrics: string[], range: Range, enabled: boolean) {
  const [data, setData] = useState<HistoryData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const key = metrics.join(',');

  useEffect(() => {
    if (!enabled || !key) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const load = async () => {
      let delayS = 30;
      try {
        const result = await api.history(range, key.split(','));
        if (cancelled) return;
        setData(result);
        setError(null);
        delayS = Math.min(30, Math.max(5, result.stepSeconds));
      } catch (e) {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : String(e));
      }
      timer = setTimeout(load, delayS * 1000);
    };
    void load();

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [key, range, enabled]);

  // Une réponse d'une autre fenêtre (clic pendant un chargement) n'est pas affichée.
  return { data: data && data.range === range ? data : null, error };
}

type Point = { x: number; y: number; val: number };

/** Morceaux continus d'une courbe : un trou de mesure coupe le tracé au lieu d'être relié. */
function segments(points: (Point | null)[]): Point[][] {
  const out: Point[][] = [];
  let current: Point[] = [];
  for (const p of points) {
    if (p) current.push(p);
    else if (current.length) {
      out.push(current);
      current = [];
    }
  }
  if (current.length) out.push(current);
  return out;
}

export const TimeSeriesChart: React.FC<TimeSeriesChartProps> = ({
  title,
  series,
  timestamps = [],
  historyMetrics,
  height = 200,
  warnThreshold,
  critThreshold,
  showTimeRangeSelector = true,
  className = '',
}) => {
  const [activeRange, setActiveRange] = useState<Range>(historyMetrics ? '1h' : '5m');
  // Seule la visibilité (bascule via la légende) est un état local ; les
  // données suivent la prop à chaque rendu, sinon le graphe se fige sur son
  // premier tick pendant que la sélection de sondes ou la télémétrie continue
  // d'évoluer côté parent.
  const [hiddenIds, setHiddenIds] = useState<Set<string>>(new Set());
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);

  const toggleSeries = (id: string) => {
    setHiddenIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const wantedMetrics = historyMetrics
    ? series.map((s) => historyMetrics[s.id]).filter((m): m is string => !!m)
    : [];
  const history = useHistory(wantedMetrics, activeRange, wantedMetrics.length > 0);

  let windowSeries: (SeriesConfig & { values: (number | null)[] })[];
  let windowTimestamps: string[];

  if (history.data) {
    // Historique PostgreSQL : grille régulière couvrant toute la fenêtre.
    const count = history.data.timestamps.length;
    const withSeconds = history.data.stepSeconds < 60;
    windowTimestamps = history.data.timestamps.map((t) => formatTime(t, withSeconds));
    windowSeries = series.map((s) => {
      const metric = historyMetrics?.[s.id];
      const fromDb = metric ? history.data!.series[metric] : undefined;
      // Série sans métrique en base : ses points en mémoire, calés à droite.
      const values: (number | null)[] =
        fromDb ?? [...Array(Math.max(0, count - s.data.length)).fill(null), ...s.data.slice(-count)];
      return { ...s, values };
    });
  } else {
    // Repli sur l'historique en mémoire (quelques minutes) : fenêtre dérivée de
    // l'intervalle d'échantillonnage réel, estimé depuis les horodatages.
    const totalLength = Math.max(timestamps.length, ...series.map((s) => s.data.length), 2);
    const intervalS = estimateSampleIntervalS(timestamps);
    const windowLength = intervalS
      ? Math.max(2, Math.min(totalLength, Math.round(RANGE_SECONDS[activeRange] / intervalS) + 1))
      : totalLength;
    const sliceFrom = totalLength - windowLength;
    windowSeries = series.map((s) => ({ ...s, values: s.data.slice(sliceFrom) }));
    windowTimestamps = timestamps.slice(sliceFrom);
  }

  const visibleSeries = windowSeries.filter((s) => !hiddenIds.has(s.id));
  const slicedTimestamps = windowTimestamps;
  const measured = (values: (number | null)[]) => values.filter((v): v is number => v !== null);

  const isRight = (s: SeriesConfig) => s.axis === 'right';

  // Compute scale
  let allVals: number[] = [];
  visibleSeries.filter((s) => !isRight(s)).forEach((s) => {
    allVals = allVals.concat(measured(s.values));
  });
  if (warnThreshold) allVals.push(warnThreshold);
  if (critThreshold) allVals.push(critThreshold);

  const minVal = Math.floor(Math.min(...(allVals.length ? allVals : [0])));
  const maxVal = Math.ceil(Math.max(...(allVals.length ? allVals : [100])));
  const range = maxVal - minVal || 1;

  // Échelle de droite, arrondie à la centaine avec 200 d'amplitude minimale :
  // sans ça, un régime stable à ±10 tr/min remplirait toute la hauteur.
  const rightSeries = visibleSeries.filter(isRight);
  const hasRightAxis = series.some(isRight);
  const rightVals = rightSeries.flatMap((s) => measured(s.values));
  let rightMin = rightVals.length ? Math.floor(Math.min(...rightVals) / 100) * 100 : 0;
  let rightMax = rightVals.length ? Math.ceil(Math.max(...rightVals) / 100) * 100 : 100;
  if (rightMax - rightMin < 200) {
    const pad = (200 - (rightMax - rightMin)) / 2;
    rightMin = Math.max(0, rightMin - pad);
    rightMax = rightMin + 200;
  }
  const rightRange = rightMax - rightMin;

  const dataLength = Math.max(
    ...visibleSeries.map((s) => s.values.length),
    slicedTimestamps.length,
    2
  );

  const padding = { top: 20, right: hasRightAxis ? 50 : 20, bottom: 25, left: 45 };
  const chartWidth = 700; // viewBox units
  const chartHeight = height;

  const plotWidth = chartWidth - padding.left - padding.right;
  const plotHeight = chartHeight - padding.top - padding.bottom;

  const getY = (val: number) => {
    const norm = (val - minVal) / range;
    return padding.top + plotHeight - norm * plotHeight;
  };

  const getYRight = (val: number) => {
    const norm = (val - rightMin) / rightRange;
    return padding.top + plotHeight - norm * plotHeight;
  };

  const getX = (index: number) => {
    return padding.left + (index / (dataLength - 1)) * plotWidth;
  };

  // Generate paths for each series
  const baseline = padding.top + plotHeight;
  const seriesPaths = visibleSeries.map((s) => {
    const points = s.values.map((val, idx) =>
      val === null ? null : { x: getX(idx), y: isRight(s) ? getYRight(val) : getY(val), val },
    );
    const parts = segments(points);

    const pathD = parts
      .map((seg) => seg.map((pt, idx) => `${idx === 0 ? 'M' : 'L'} ${pt.x},${pt.y}`).join(' '))
      .join(' ');

    const areaD = isRight(s)
      ? ''
      : parts
          .map(
            (seg) =>
              `${seg.map((pt, idx) => `${idx === 0 ? 'M' : 'L'} ${pt.x},${pt.y}`).join(' ')} ` +
              `L ${seg[seg.length - 1].x},${baseline} L ${seg[0].x},${baseline} Z`,
          )
          .join(' ');

    return {
      ...s,
      points,
      pathD,
      areaD,
    };
  });

  // Grid lines
  const gridLinesCount = 4;
  const gridYValues = Array.from({ length: gridLinesCount }, (_, i) => {
    return minVal + (range / (gridLinesCount - 1)) * i;
  });

  return (
    <div className={`bg-wopr-surface border border-wopr-border rounded-xl p-4 ${className}`}>
      {/* Header with Title and Range buttons */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 mb-3">
        <div>
          {title && <h3 className="text-sm font-semibold text-wopr-text tracking-wide">{title}</h3>}
          {history.error && !history.data && (
            <p className="text-[11px] text-amber-400 mt-0.5" title={history.error}>
              Historique indisponible — seules les dernières minutes en mémoire sont affichées
            </p>
          )}
        </div>

        {showTimeRangeSelector && (
          <div className="flex items-center gap-1 bg-[#0d1117] p-1 rounded-lg border border-wopr-border text-xs font-mono self-start sm:self-auto">
            {(['1m', '5m', '1h', '6h'] as const).map((r) => (
              <button
                key={r}
                onClick={() => setActiveRange(r)}
                className={`px-2.5 py-1 rounded transition-colors ${
                  activeRange === r
                    ? 'bg-wopr-surface2 text-wopr-accent font-semibold shadow-sm'
                    : 'text-wopr-textMuted hover:text-wopr-text'
                }`}
              >
                {r}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* SVG Chart */}
      <div className="relative w-full overflow-hidden">
        <svg
          viewBox={`0 0 ${chartWidth} ${chartHeight}`}
          className="w-full h-auto overflow-visible select-none"
          onMouseMove={(e) => {
            const rect = e.currentTarget.getBoundingClientRect();
            const mouseX = ((e.clientX - rect.left) / rect.width) * chartWidth;
            const relativeX = mouseX - padding.left;
            const index = Math.round((relativeX / plotWidth) * (dataLength - 1));
            if (index >= 0 && index < dataLength) {
              setHoverIndex(index);
            }
          }}
          onMouseLeave={() => setHoverIndex(null)}
        >
          {/* Gradients */}
          <defs>
            {visibleSeries.map((s) => (
              <linearGradient key={s.id} id={`grad-${s.id}`} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={s.color} stopOpacity="0.2" />
                <stop offset="100%" stopColor={s.color} stopOpacity="0.0" />
              </linearGradient>
            ))}
          </defs>

          {/* Grid lines */}
          {gridYValues.map((val, idx) => (
            <g key={idx}>
              <line
                x1={padding.left}
                y1={getY(val)}
                x2={padding.left + plotWidth}
                y2={getY(val)}
                stroke="#21262d"
                strokeWidth="1"
                strokeDasharray="4 4"
              />
              <text
                x={padding.left - 8}
                y={getY(val) + 3}
                fill="#6e7681"
                fontSize="10"
                fontFamily="monospace"
                textAnchor="end"
              >
                {Math.round(val)}
              </text>
              {rightSeries.length > 0 && (
                <text
                  x={padding.left + plotWidth + 8}
                  y={getY(val) + 3}
                  fill={rightSeries[0].color}
                  fontSize="10"
                  fontFamily="monospace"
                  textAnchor="start"
                >
                  {Math.round(rightMin + (rightRange / (gridLinesCount - 1)) * idx)}
                </text>
              )}
            </g>
          ))}

          {/* Threshold guide lines if present */}
          {warnThreshold && (
            <line
              x1={padding.left}
              y1={getY(warnThreshold)}
              x2={padding.left + plotWidth}
              y2={getY(warnThreshold)}
              stroke="#d29922"
              strokeWidth="1"
              strokeDasharray="2 2"
              opacity="0.6"
            />
          )}
          {critThreshold && (
            <line
              x1={padding.left}
              y1={getY(critThreshold)}
              x2={padding.left + plotWidth}
              y2={getY(critThreshold)}
              stroke="#f85149"
              strokeWidth="1"
              strokeDasharray="2 2"
              opacity="0.8"
            />
          )}

          {/* Series Areas and Lines */}
          {seriesPaths.map((s) => (
            <g key={s.id}>
              <path d={s.areaD} fill={`url(#grad-${s.id})`} />
              <path
                d={s.pathD}
                fill="none"
                stroke={s.color}
                strokeWidth="2"
                strokeDasharray={isRight(s) ? '6 4' : undefined}
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </g>
          ))}

          {/* Hover Crosshair and Markers */}
          {hoverIndex !== null && (
            <g>
              <line
                x1={getX(hoverIndex)}
                y1={padding.top}
                x2={getX(hoverIndex)}
                y2={padding.top + plotHeight}
                stroke="#8b949e"
                strokeWidth="1"
                strokeDasharray="3 3"
              />
              {seriesPaths.map((s) => {
                const pt = s.points[hoverIndex];
                if (!pt) return null;
                return (
                  <circle
                    key={s.id}
                    cx={pt.x}
                    cy={pt.y}
                    r="4"
                    fill={s.color}
                    stroke="#0d1117"
                    strokeWidth="2"
                  />
                );
              })}
            </g>
          )}

          {/* X axis timestamps */}
          {slicedTimestamps.length > 0 &&
            slicedTimestamps.map((t, idx) => {
              if (idx % Math.ceil(slicedTimestamps.length / 6) !== 0 && idx !== slicedTimestamps.length - 1)
                return null;
              return (
                <text
                  key={idx}
                  x={getX(idx)}
                  y={chartHeight - 6}
                  fill="#6e7681"
                  fontSize="10"
                  fontFamily="monospace"
                  textAnchor="middle"
                >
                  {t}
                </text>
              );
            })}
        </svg>

        {/* Hover Floating Tooltip */}
        {hoverIndex !== null && (
          <div
            className="absolute top-2 pointer-events-none bg-[#161b22]/90 backdrop-blur border border-wopr-border p-2.5 rounded-lg text-xs shadow-xl z-20 font-mono"
            style={{
              left: Math.min(
                Math.max(10, (getX(hoverIndex) / chartWidth) * 100),
                70
              ) + '%',
            }}
          >
            {slicedTimestamps[hoverIndex] && (
              <div className="text-wopr-textMuted border-b border-wopr-border pb-1 mb-1.5">
                {slicedTimestamps[hoverIndex]}
              </div>
            )}
            {visibleSeries.map((s) => {
              const val = s.values[hoverIndex];
              return (
                <div key={s.id} className="flex items-center gap-2 py-0.5">
                  <span className="w-2 h-2 rounded-full" style={{ backgroundColor: s.color }} />
                  <span className="text-wopr-text font-sans">{s.name}:</span>
                  <span className="text-wopr-accent font-semibold ml-auto">
                    {val !== undefined && val !== null ? val : '—'} {s.unit}
                  </span>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Clickable Legend */}
      <div className="flex flex-wrap items-center gap-4 mt-3 pt-2.5 border-t border-wopr-border/60 text-xs">
        {series.map((s) => (
          <button
            key={s.id}
            onClick={() => toggleSeries(s.id)}
            className={`flex items-center gap-1.5 transition-opacity px-2 py-1 rounded hover:bg-white/5 ${
              !hiddenIds.has(s.id) ? 'opacity-100' : 'opacity-35 line-through'
            }`}
          >
            <span
              className="w-2.5 h-2.5 rounded-sm"
              style={{ backgroundColor: s.color }}
            />
            <span className="text-wopr-text font-medium">{s.name}</span>
          </button>
        ))}
      </div>
    </div>
  );
};
