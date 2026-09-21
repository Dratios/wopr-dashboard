import React from 'react';
import { useWoprStore } from '../../state/useWoprStore';
import { Measure, TextValue } from '../common/Measure';
import { RadialGauge } from '../common/RadialGauge';
import { StackedBar } from '../common/StackedBar';
import { ProgressBar } from '../common/ProgressBar';
import { TimeSeriesChart } from '../common/TimeSeriesChart';
import { ViewId } from '../layout/Sidebar';
import { Cpu, Layers, CircuitBoard, Zap, Thermometer, ShieldCheck, AlertTriangle } from 'lucide-react';

interface CpuRamViewProps {
  onNavigate: (view: ViewId) => void;
}

export const CpuRamView: React.FC<CpuRamViewProps> = ({ onNavigate }) => {
  const { cpuRam, overview } = useWoprStore();
  const { cpu, ram, motherboard } = cpuRam;

  const ramUsedPct = (ram.usedGiB / ram.totalGiB) * 100;
  const swapUsedPct = ram.swapTotalGiB > 0 ? (ram.swapUsedGiB / ram.swapTotalGiB) * 100 : 0;

  return (
    <div className="space-y-6 animate-in fade-in duration-200">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 pb-4 border-b border-wopr-border">
        <div>
          <h1 className="text-xl font-bold tracking-tight text-wopr-text flex items-center gap-2.5">
            <Cpu className="w-5 h-5 text-wopr-accent" />
            <span>Processeur, Mémoire & Carte Mère</span>
          </h1>
          <p className="text-xs text-wopr-textMuted mt-1">
            {[cpu.model, `${ram.totalGiB} Gio de RAM`, motherboard.model].filter(Boolean).join(' · ')}
          </p>
        </div>

        <div className="flex items-center gap-2">
          <span className="text-xs px-2.5 py-1 rounded-md bg-wopr-surface2 border border-wopr-border font-mono text-wopr-text">
            Gouverneur : <strong className="text-wopr-accent uppercase">
              <TextValue value={cpu.governor} unavailableHint="Gouverneur non lisible dans /sys" />
            </strong>
            {cpu.epp && (
              <span className="text-wopr-textMuted"> · préférence énergie : <strong className="text-wopr-text">{cpu.epp}</strong></span>
            )}
          </span>
          <span className="text-xs px-2.5 py-1 rounded-md bg-wopr-surface2 border border-wopr-border font-mono text-wopr-text">
            Mode : <strong className="text-wopr-text">{overview.activeMode.label}</strong>
          </span>
        </div>
      </div>

      {/* SECTION 1: CPU */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* CPU Summary & Gauges */}
        <div className="bg-wopr-surface border border-wopr-border rounded-xl p-5 flex flex-col justify-between">
          <div>
            <div className="flex items-center justify-between pb-3 border-b border-wopr-border mb-4">
              <span className="text-xs font-semibold uppercase tracking-wider text-wopr-text">
                Charge Processeur Globale
              </span>
              <span className="text-xs font-mono text-wopr-accent font-bold">
                ~<Measure value={cpu.freqMhzAvg} unit="MHz" />
              </span>
            </div>

            <div className="flex items-center justify-center my-2">
              <RadialGauge
                value={cpu.utilPct}
                size={140}
                strokeWidth={12}
                label="CPU TOTAL"
                warnThreshold={80}
                critThreshold={90}
              />
            </div>

            <div className="grid grid-cols-2 gap-3 mt-4 pt-3 border-t border-wopr-border/50 text-xs font-mono">
              <div className="p-2.5 rounded-lg bg-[#0d1117] border border-wopr-border">
                <div className="text-wopr-textMuted flex items-center gap-1.5 mb-1">
                  <Thermometer className="w-3.5 h-3.5 text-amber-400" />
                  <span>Temp. Package</span>
                </div>
                <div className="text-base font-bold text-wopr-text tabular">
                  <Measure value={cpu.tempPkgC} unit="°C" digits={1}
                    unavailableHint="Capteur k10temp non lisible" />
                </div>
              </div>

              <div className="p-2.5 rounded-lg bg-[#0d1117] border border-wopr-border">
                <div className="text-wopr-textMuted flex items-center gap-1.5 mb-1">
                  <Zap className="w-3.5 h-3.5 text-wopr-accent" />
                  <span>Puissance Package</span>
                </div>
                <div
                  className="text-base font-bold text-wopr-text tabular"
                  title={cpu.powerSource === 'rapl'
                    ? 'Mesure RAPL du package processeur'
                    : "RAPL n'est pas lisible : aucune mesure de puissance"}
                >
                  <Measure value={cpu.powerW} unit="W" digits={1}
                    unavailableHint="RAPL non lisible (/sys/class/powercap)" />
                </div>
              </div>
            </div>
          </div>

          <div className="mt-4 pt-3 border-t border-wopr-border/60 flex items-center justify-between text-xs text-wopr-textMuted font-mono">
            <span>Load average :</span>
            <span className="text-wopr-text font-bold">{cpu.loadavg.join('  ·  ')}</span>
          </div>
        </div>

        {/* 16-Thread Heatmap Grid */}
        <div className="bg-wopr-surface border border-wopr-border rounded-xl p-5 flex flex-col justify-between">
          <div>
            <div className="flex items-center justify-between pb-3 border-b border-wopr-border mb-3">
              <span className="text-xs font-semibold uppercase tracking-wider text-wopr-text">
                Matrice d'utilisation par thread ({cpu.perThread.length})
              </span>
              <span className="text-xs text-wopr-textMuted font-mono">
                {cpu.cores} cœurs / {cpu.threads} threads
              </span>
            </div>

            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5 my-2">
              {cpu.perThread.map((threadUtil, idx) => {
                const color =
                  threadUtil >= 85
                    ? 'bg-rose-500'
                    : threadUtil >= 50
                    ? 'bg-amber-500'
                    : 'bg-wopr-accent';

                return (
                  <div
                    key={idx}
                    className="p-2 rounded-lg bg-[#0d1117] border border-wopr-border flex flex-col justify-between gap-1 text-xs"
                  >
                    <div className="flex items-center justify-between font-mono text-[10px] text-wopr-textMuted">
                      <span>T{idx}</span>
                      <span className="font-semibold text-wopr-text tabular">{threadUtil}%</span>
                    </div>
                    <div className="w-full bg-[#21262d] rounded-full h-1.5 overflow-hidden">
                      <div
                        className={`h-full rounded-full transition-all duration-300 ${color}`}
                        style={{ width: `${threadUtil}%` }}
                      />
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          <p className="text-[11px] text-wopr-textSubtle mt-2">
            Mesure rafraîchie toutes les 2 s environ. Code couleur : bleu &lt;50%, ambre 50–85%, rouge &ge;85%.
          </p>
        </div>

        {/* Top 5 CPU Processes */}
        <div className="bg-wopr-surface border border-wopr-border rounded-xl p-5 flex flex-col justify-between">
          <div>
            <div className="flex items-center justify-between pb-3 border-b border-wopr-border mb-3">
              <span className="text-xs font-semibold uppercase tracking-wider text-wopr-text">
                Top processus CPU
              </span>
              <button
                onClick={() => onNavigate('processes')}
                className="text-xs text-wopr-accent hover:underline font-medium"
              >
                Gérer tous →
              </button>
            </div>

            <div className="space-y-2">
              {cpu.topCpu.map((p) => (
                <div
                  key={p.pid}
                  onClick={() => onNavigate('processes')}
                  className="p-2.5 rounded-lg bg-[#0d1117] hover:bg-white/5 border border-wopr-border flex items-center justify-between cursor-pointer transition-colors text-xs"
                >
                  <div className="min-w-0">
                    <div className="font-mono font-semibold text-wopr-text truncate">
                      {p.name}
                    </div>
                    <div className="text-[10px] font-mono text-wopr-textMuted">
                      PID {p.pid} · {p.user}
                    </div>
                  </div>
                  <span className="font-mono font-bold text-amber-400 tabular ml-2">
                    {p.cpuPct?.toFixed(1)} %
                  </span>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>

      {/* SECTION 2: RAM & SWAP */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* RAM breakdown */}
        <div className="lg:col-span-2 bg-wopr-surface border border-wopr-border rounded-xl p-5 flex flex-col justify-between space-y-4">
          <div>
            <div className="flex items-center justify-between pb-3 border-b border-wopr-border mb-3">
              <div className="flex items-center gap-2">
                <Layers className="w-4 h-4 text-wopr-accent" />
                <span className="text-xs font-semibold uppercase tracking-wider text-wopr-text">
                  Mémoire vive ({ram.totalGiB} Gio)
                </span>
              </div>
              <span className="text-xs font-mono font-bold text-wopr-text">
                {ram.usedGiB.toFixed(1)} Gio utilisés ({ramUsedPct.toFixed(1)} %)
              </span>
            </div>

            <StackedBar
              total={ram.totalGiB}
              height={18}
              segments={[
                {
                  id: 'ram_used',
                  label: 'Mémoire active',
                  value: ram.usedGiB,
                  color: '#4c9ffe',
                  unit: 'Gio',
                },
                {
                  id: 'ram_cache',
                  label: 'Tampons & Cache Linux',
                  value: ram.cacheGiB,
                  color: '#8957e5',
                  unit: 'Gio',
                },
              ]}
            />
          </div>

          <div className="pt-3 border-t border-wopr-border/50">
            <div className="flex items-center justify-between text-xs mb-1.5 font-medium">
              <span className="text-wopr-textMuted">Espace Swap</span>
              <span className="text-wopr-text font-mono">
                {ram.swapTotalGiB > 0
                  ? `${ram.swapUsedGiB.toFixed(1)} / ${ram.swapTotalGiB.toFixed(1)} Gio (${swapUsedPct.toFixed(1)} %)`
                  : 'aucun swap configuré'}
              </span>
            </div>
            <ProgressBar value={swapUsedPct} height={8} warnThreshold={40} critThreshold={70} />
          </div>
        </div>

        {/* Top 5 RAM consumers */}
        <div className="bg-wopr-surface border border-wopr-border rounded-xl p-5 flex flex-col justify-between">
          <div>
            <div className="flex items-center justify-between pb-3 border-b border-wopr-border mb-3">
              <span className="text-xs font-semibold uppercase tracking-wider text-wopr-text">
                Top résidents RAM (RSS)
              </span>
              <button
                onClick={() => onNavigate('processes')}
                className="text-xs text-wopr-accent hover:underline font-medium"
              >
                Voir →
              </button>
            </div>

            <div className="space-y-2">
              {ram.topMem.map((p) => (
                <div
                  key={p.pid}
                  onClick={() => onNavigate('processes')}
                  className="p-2.5 rounded-lg bg-[#0d1117] hover:bg-white/5 border border-wopr-border flex items-center justify-between cursor-pointer transition-colors text-xs"
                >
                  <div className="min-w-0">
                    <div className="font-mono font-semibold text-wopr-text truncate">
                      {p.name}
                    </div>
                    <div className="text-[10px] font-mono text-wopr-textMuted">
                      PID {p.pid} · {p.user}
                    </div>
                  </div>
                  <span className="font-mono font-bold text-wopr-accent tabular ml-2">
                    {p.rssMiB} Mio
                  </span>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>

      {/* SECTION 3: MOTHERBOARD & VOLTAGES */}
      <div className="bg-wopr-surface border border-wopr-border rounded-xl p-5">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between pb-3 border-b border-wopr-border mb-4 gap-2">
          <div className="flex items-center gap-2">
            <CircuitBoard className="w-4 h-4 text-emerald-400" />
            <h3 className="text-xs font-semibold uppercase tracking-wider text-wopr-text">
              Carte Mère & Tensions Hardware
            </h3>
          </div>
          <div className="text-xs font-mono text-wopr-textMuted">
            BIOS : <strong className="text-wopr-text">{motherboard.biosVersion || '—'}</strong>
            {motherboard.biosDate && ` (${motherboard.biosDate})`}
          </div>
        </div>

        <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-7 gap-3">
          {motherboard.voltages.map((v) => (
            <div
              key={v.name}
              className={`p-3 rounded-lg bg-[#0d1117] border flex flex-col justify-between ${
                v.ok === false ? 'border-rose-500/50' : 'border-wopr-border'
              }`}
            >
              <div className="flex items-center justify-between text-xs text-wopr-textMuted mb-1 font-mono">
                <span>{v.name}</span>
                {v.ok === true && <ShieldCheck className="w-3.5 h-3.5 text-emerald-400" />}
                {v.ok === false && <AlertTriangle className="w-3.5 h-3.5 text-rose-400" />}
              </div>
              <div className="text-base font-bold font-mono text-wopr-text tabular">
                {v.value.toFixed(2)} V
              </div>
              {/* Les bornes sont celles déclarées par le chip. Sans bornes, on ne juge
                  pas : l'ancienne version inventait une « cible » égale à la mesure. */}
              <div className={`text-[10px] font-mono mt-0.5 ${v.ok === false ? 'text-rose-400' : 'text-wopr-textSubtle'}`}>
                {v.range ? `Plage : ${v.range[0].toFixed(2)}–${v.range[1].toFixed(2)} V` : 'Pas de plage déclarée'}
              </div>
            </div>
          ))}

          {motherboard.temps.map((t) => (
            <div
              key={t.name}
              className="p-3 rounded-lg bg-[#0d1117] border border-wopr-border flex flex-col justify-between"
            >
              <div className="flex items-center justify-between text-xs text-wopr-textMuted mb-1 font-mono">
                <span className="truncate" title={t.name}>{t.name}</span>
                <Thermometer className="w-3.5 h-3.5 text-amber-400 shrink-0" />
              </div>
              <div className="text-base font-bold font-mono text-wopr-text tabular">
                {t.value} °C
              </div>
              <button
                onClick={() => onNavigate('thermal')}
                className="text-[10px] font-mono text-wopr-textSubtle hover:text-wopr-accent mt-0.5 text-left"
              >
                Seuils : vue thermique →
              </button>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
};
