import React from 'react';
import { useWoprStore } from '../../state/useWoprStore';
import { HealthBanner } from '../common/HealthBanner';
import { MetricCard } from '../common/MetricCard';
import { TimeSeriesChart } from '../common/TimeSeriesChart';
import { Minimize2, Clock, Cpu, Sparkles, Tv } from 'lucide-react';

interface KioskViewProps {
  onExitKiosk: () => void;
}

export const KioskView: React.FC<KioskViewProps> = ({ onExitKiosk }) => {
  const { overview, storageNetwork, system, cpuRam } = useWoprStore();

  // Nom réel de l'interface principale de la machine.
  const primaryNic = storageNetwork.interfaces.find((i) => !i.virtual && i.up);

  const formatUptime = (seconds: number) => {
    const days = Math.floor(seconds / 86400);
    const hours = Math.floor((seconds % 86400) / 3600);
    const mins = Math.floor((seconds % 3600) / 60);
    return `${days}j ${hours}h ${mins}m`;
  };

  return (
    <div className="min-h-screen bg-[#0d1117] text-wopr-text p-6 space-y-6 select-none">
      {/* Top Kiosk Header */}
      <div className="flex items-center justify-between pb-4 border-b border-wopr-border">
        <div className="flex items-center gap-4">
          <div className="w-10 h-10 rounded-xl bg-wopr-accent/20 border border-wopr-accent/40 flex items-center justify-center text-wopr-accent font-mono font-black text-xl">
            W
          </div>
          <div>
            <div className="flex items-center gap-2.5">
              <h1 className="text-2xl font-black font-mono tracking-tight text-wopr-text">
                {overview.host || 'wopr'}
              </h1>
              <span className="text-xs px-2.5 py-0.5 rounded-full bg-wopr-surface2 text-wopr-accent font-mono font-bold uppercase border border-wopr-border">
                Écran mural (Kiosk)
              </span>
            </div>
            <div className="text-xs font-mono text-wopr-textMuted mt-0.5 flex items-center gap-4">
              <span>
                {[system.os, cpuRam.cpu.model, cpuRam.ram.totalGiB ? `${cpuRam.ram.totalGiB} Gio RAM` : null]
                  .filter(Boolean)
                  .join(' · ')}
              </span>
              <span>•</span>
              <span className="text-amber-400">Mode : {overview.activeMode.label}</span>
            </div>
          </div>
        </div>

        <div className="flex items-center gap-6 font-mono text-sm">
          <div className="flex items-center gap-2">
            <Clock className="w-4 h-4 text-wopr-textSubtle" />
            <span>Uptime:</span>
            <span className="font-bold text-wopr-text">{formatUptime(overview.uptimeSeconds)}</span>
          </div>

          <div className="flex items-center gap-2">
            <Cpu className="w-4 h-4 text-wopr-textSubtle" />
            <span>Load:</span>
            <span className="font-bold text-wopr-text">{overview.loadavg[0]}</span>
          </div>

          <div className="flex items-center gap-2">
            <Sparkles className="w-4 h-4 text-amber-400" />
            <span>Conso:</span>
            <span className="font-bold text-wopr-text" title={overview.powerScope ?? 'Puissance non mesurable'}>
              {overview.powerEstimateW !== null ? `${overview.powerEstimateW} W` : '—'}
            </span>
          </div>

          <button
            onClick={onExitKiosk}
            className="p-2 rounded-lg bg-wopr-surface2 hover:bg-wopr-surface3 border border-wopr-border text-wopr-textMuted hover:text-wopr-text transition-colors"
            title="Quitter le mode plein écran mural"
          >
            <Minimize2 className="w-5 h-5" />
          </button>
        </div>
      </div>

      {/* Main Health Banner */}
      <HealthBanner
        level={overview.health.level}
        summary={overview.health.summary}
        detail={overview.health.detail}
        alertsCount={overview.alerts.filter((a) => !a.acknowledged).length}
      />

      {/* Subsystem Tiles in large format */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        {overview.subsystems.map((sub) => (
          <MetricCard
            key={sub.id}
            title={sub.label}
            value={sub.value}
            subvalue={sub.subvalue}
            level={sub.level}
            sparklineData={sub.spark}
            className="p-5"
          />
        ))}
      </div>

      {/* Real-time Large Graphs */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <TimeSeriesChart
          title="Charge CPU (%) & température maximale (°C)"
          series={[
            {
              id: 'cpu_pct',
              name: 'CPU %',
              color: '#4c9ffe',
              unit: '%',
              data: overview.historicalMetrics.cpuPct,
            },
            {
              id: 'temp_max',
              name: 'Température (°C)',
              color: '#d29922',
              unit: '°C',
              data: overview.historicalMetrics.tempMaxC,
            },
          ]}
          timestamps={overview.historicalMetrics.timestamps}
          historyMetrics={{ cpu_pct: 'cpu', temp_max: 'tempMax' }}
          height={240}
        />

        <TimeSeriesChart
          title={`Débit réseau des interfaces physiques${primaryNic ? ` (dont ${primaryNic.name})` : ''}`}
          series={[
            {
              id: 'rx',
              name: 'Réception (Rx)',
              color: '#3fb950',
              unit: 'Mo/s',
              data: overview.historicalMetrics.netRxMBs,
            },
            {
              id: 'tx',
              name: 'Émission (Tx)',
              color: '#a371f7',
              unit: 'Mo/s',
              data: overview.historicalMetrics.netTxMBs,
            },
          ]}
          timestamps={overview.historicalMetrics.timestamps}
          historyMetrics={{ rx: 'netRx', tx: 'netTx' }}
          height={240}
        />
      </div>

      {/* Alerts tickers in kiosk mode */}
      {overview.alerts.length > 0 && (
        <div className="bg-wopr-surface border border-wopr-border rounded-xl p-4">
          <div className="flex items-center gap-2 mb-3 text-xs font-semibold uppercase tracking-wider text-amber-400">
            <span>Points de surveillance actifs ({overview.alerts.length}) :</span>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
            {overview.alerts.map((a) => (
              <div
                key={a.id}
                className="p-3 rounded-lg bg-[#0d1117] border border-wopr-border text-xs flex items-center gap-3"
              >
                <span
                  className={`w-2 h-2 rounded-full shrink-0 ${
                    a.level === 'err' ? 'bg-rose-500 animate-pulse' : a.level === 'warn' ? 'bg-amber-500' : 'bg-sky-400'
                  }`}
                />
                <div className={`truncate ${a.acknowledged ? 'opacity-60' : ''}`}>
                  <div className="font-mono font-bold text-wopr-text">{a.component}</div>
                  <div className="text-wopr-textMuted text-[11px] truncate">{a.message}</div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
};
