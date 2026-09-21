import React from 'react';
import { useWoprStore } from '../../state/useWoprStore';
import { store } from '../../state/store';
import { ProgressBar } from '../common/ProgressBar';
import { Sparkline } from '../common/Sparkline';
import { ListeningPortsCard } from './ListeningPortsCard';
import {
  HardDrive,
  Activity,
  Network,
  ShieldAlert,
  ArrowDown,
  ArrowUp,
  Server,
  Globe,
  Radio,
  CheckCircle,
  AlertTriangle,
  XCircle,
  HelpCircle,
  Database,
  Gauge,
  Loader2,
} from 'lucide-react';
import type { StorageMount } from '../../state/types';

/** Latence en ms : vert sous le seuil, ambre au-delà, rouge si aucune réponse. */
const PingValue: React.FC<{ ms: number | null; warnMs: number }> = ({ ms, warnMs }) => (
  <span
    className={`font-bold ${ms === null ? 'text-rose-400' : ms >= warnMs ? 'text-amber-400' : 'text-emerald-400'}`}
  >
    {ms === null ? 'sans réponse' : `${ms} ms`}
  </span>
);

const TYPE_LABEL: Record<StorageMount['type'], string> = { nvme: 'NVMe', sata: 'SATA', nfs: 'NFS' };

function formatSize(gib: number): string {
  return gib >= 1024 ? `${(gib / 1024).toFixed(1)} Tio` : `${Math.round(gib)} Gio`;
}

const SMART_DISPLAY: Record<StorageMount['smart'], { label: string; className: string; Icon: typeof CheckCircle }> = {
  ok: { label: 'OK', className: 'text-emerald-400', Icon: CheckCircle },
  warn: { label: 'ATTENTION', className: 'text-amber-400', Icon: AlertTriangle },
  err: { label: 'CRITIQUE', className: 'text-rose-400', Icon: XCircle },
  unknown: { label: 'NON MESURÉ', className: 'text-wopr-textMuted', Icon: HelpCircle },
};

const SpeedValue: React.FC<{ mbps: number | null; label: string }> = ({ mbps, label }) => (
  <div className="p-3 rounded-lg bg-[#0d1117] border border-wopr-border text-center">
    <span className="text-[10px] text-wopr-textMuted uppercase block">{label}</span>
    <span className="text-xl font-bold font-mono text-wopr-text tabular">
      {mbps === null ? '—' : mbps}
    </span>
    {mbps !== null && <span className="text-[10px] text-wopr-textSubtle"> Mb/s</span>}
  </div>
);

export const StorageNetworkView: React.FC = () => {
  const { storageNetwork, docker, pending, speedtest } = useWoprStore();
  const { mounts, interfaces, listeners, firewall, gateway, internet } = storageNetwork;
  const speedtestRunning = !!pending['net:speedtest'];

  // Interface principale : la première physique active (le collecteur les trie ainsi).
  const netInterface = interfaces.find((i) => !i.virtual && i.up) ?? interfaces[0];

  // Sous-titre construit à partir de ce qui est réellement monté. L'ancien texte
  // annonçait « 2 NVMe locaux » alors que / est sur un SSD SATA.
  const summary = [
    ...(['nvme', 'sata', 'nfs'] as const).flatMap((type) => {
      const list = mounts.filter((m) => m.type === type && m.reachable);
      if (!list.length) return [];
      return [`${TYPE_LABEL[type]} : ${list.map((m) => `${m.path} (${formatSize(m.totalGiB)})`).join(', ')}`];
    }),
    netInterface ? `${netInterface.name} ${netInterface.speedMbps ? `${netInterface.speedMbps} Mb/s` : 'débit inconnu'}` : null,
  ].filter(Boolean).join(' · ');

  return (
    <div className="space-y-6 animate-in fade-in duration-200">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 pb-4 border-b border-wopr-border">
        <div>
          <h1 className="text-xl font-bold tracking-tight text-wopr-text flex items-center gap-2.5">
            <HardDrive className="w-5 h-5 text-wopr-accent" />
            <span>Stockage Disques & Connectivité Réseau</span>
          </h1>
          <p className="text-xs text-wopr-textMuted mt-1">
            {summary}
          </p>
        </div>

        {firewall.active !== true && (
          <div
            className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-amber-500/15 border border-amber-500/30 text-xs text-amber-300 font-mono"
            title={firewall.detail}
          >
            <ShieldAlert className="w-4 h-4 text-amber-400" />
            <span>{firewall.active === false ? 'Aucun pare-feu actif sur wopr' : 'État du pare-feu inconnu'}</span>
          </div>
        )}
      </div>

      {/* SECTION 1: STORAGE MOUNT POINTS */}
      <div>
        <h3 className="text-xs font-semibold uppercase tracking-wider text-wopr-text mb-3">
          Partitions & Volumes de Stockage
        </h3>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          {mounts.map((mount) => {
            // Mêmes seuils que les alertes (thresholds.yaml, surcharges par montage).
            const isCrit = mount.usedPct >= mount.critPct;
            const isWarn = mount.usedPct >= mount.warnPct;

            if (!mount.reachable) {
              return (
                <div
                  key={mount.path}
                  className="bg-rose-500/10 border border-rose-500/40 rounded-xl p-5 flex flex-col gap-2"
                >
                  <div className="flex items-center gap-2">
                    <span className="font-mono font-bold text-base text-wopr-text">{mount.path}</span>
                    <span className="px-1.5 py-0.5 rounded text-[10px] font-mono uppercase bg-wopr-surface2 text-wopr-accent border border-wopr-border font-bold">
                      {mount.type}
                    </span>
                  </div>
                  <div className="text-[11px] font-mono text-wopr-textMuted">{mount.device} · {mount.fs}</div>
                  <div className="flex items-center gap-2 text-sm text-rose-300 font-semibold mt-2">
                    <XCircle className="w-4 h-4" />
                    Montage injoignable : occupation et débits non mesurables.
                  </div>
                </div>
              );
            }

            return (
              <div
                key={mount.path}
                className="bg-wopr-surface border border-wopr-border rounded-xl p-5 flex flex-col justify-between space-y-4"
              >
                {/* Header */}
                <div>
                  <div className="flex items-start justify-between gap-2 pb-3 border-b border-wopr-border">
                    <div>
                      <div className="flex items-center gap-2">
                        <span className="font-mono font-bold text-base text-wopr-text">
                          {mount.path}
                        </span>
                        <span className="px-1.5 py-0.5 rounded text-[10px] font-mono uppercase bg-wopr-surface2 text-wopr-accent border border-wopr-border font-bold">
                          {mount.type}
                        </span>
                      </div>
                      <div className="text-[11px] font-mono text-wopr-textMuted mt-1">
                        {mount.device} · {mount.fs}
                      </div>
                    </div>

                    <div className="text-right">
                      <span
                        className={`text-lg font-bold font-mono tabular ${
                          isCrit ? 'text-rose-400' : isWarn ? 'text-amber-400' : 'text-wopr-text'
                        }`}
                      >
                        {mount.usedPct} %
                      </span>
                      <div className="text-[10px] text-wopr-textSubtle font-mono">
                        Inodes: {mount.inodePct}%
                      </div>
                    </div>
                  </div>

                  {/* Usage Progress Bar */}
                  <div className="my-3">
                    <ProgressBar
                      value={mount.usedPct}
                      valueLabel={`${mount.usedGiB} / ${mount.totalGiB} Gio`}
                      height={10}
                      warnThreshold={mount.warnPct}
                      critThreshold={mount.critPct}
                    />
                  </div>

                  {/* Metrics strip */}
                  <div className="grid grid-cols-2 gap-2 text-xs font-mono pt-1">
                    <div className="p-2 rounded bg-[#0d1117] border border-wopr-border">
                      <span className="text-[10px] text-wopr-textMuted uppercase block">Lecture</span>
                      <span className="font-bold text-wopr-text">{mount.readMBs} Mo/s</span>
                    </div>
                    <div className="p-2 rounded bg-[#0d1117] border border-wopr-border">
                      <span className="text-[10px] text-wopr-textMuted uppercase block">Écriture</span>
                      <span className="font-bold text-wopr-text">{mount.writeMBs} Mo/s</span>
                    </div>
                  </div>

                  {/* SMART and Hardware Info */}
                  <div className="mt-3 pt-3 border-t border-wopr-border/50 text-[11px] font-mono text-wopr-textMuted space-y-1">
                    {(() => {
                      const smart = SMART_DISPLAY[mount.smart] ?? SMART_DISPLAY.unknown;
                      return (
                        <div className="flex justify-between">
                          <span>Santé SMART :</span>
                          <span className={`${smart.className} font-semibold flex items-center gap-1`}>
                            <smart.Icon className="w-3 h-3" />
                            {smart.label}
                          </span>
                        </div>
                      );
                    })()}
                    {mount.tempC !== null && mount.tempC !== undefined && (
                      <div className="flex justify-between">
                        <span>Température SSD :</span>
                        <span className="text-wopr-text">{mount.tempC} °C</span>
                      </div>
                    )}
                    {mount.type === 'nfs' && (
                      <div className="flex justify-between">
                        <span>Latence du serveur NFS :</span>
                        <PingValue ms={mount.latencyMs} warnMs={20} />
                      </div>
                    )}
                    {mount.tbw !== null && (
                      <div className="flex justify-between">
                        <span>Total écrit :</span>
                        <span className="text-wopr-text">{mount.tbw} To</span>
                      </div>
                    )}
                    {mount.wearPct !== null && (
                      <div className="flex justify-between">
                        <span>Usure déclarée :</span>
                        <span className={mount.wearPct >= 80 ? 'text-amber-400' : 'text-wopr-text'}>
                          {mount.wearPct} %
                        </span>
                      </div>
                    )}
                    {mount.powerOnHours !== null && (
                      <div className="flex justify-between">
                        <span>Heures sous tension :</span>
                        <span className="text-wopr-text">
                          {mount.powerOnHours.toLocaleString('fr-FR')} h
                        </span>
                      </div>
                    )}
                  </div>
                </div>

              </div>
            );
          })}
        </div>
      </div>

      {/* SECTION 2: NETWORK INTERFACE & LATENCY */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Network Throughput Card */}
        <div className="lg:col-span-2 bg-wopr-surface border border-wopr-border rounded-xl p-5 flex flex-col justify-between space-y-4">
          {!netInterface ? (
            <p className="text-xs text-wopr-textMuted">Aucune interface réseau détectée.</p>
          ) : (
          <div>
            <div className="flex flex-col sm:flex-row sm:items-center justify-between pb-3 border-b border-wopr-border gap-2">
              <div className="flex items-center gap-2.5">
                <Network className="w-5 h-5 text-wopr-accent" />
                <div>
                  <h3 className="text-base font-bold text-wopr-text tracking-wide font-mono">
                    {netInterface.name} ({netInterface.ipv4 || 'sans IPv4'})
                  </h3>
                  <span className="text-[11px] font-mono text-wopr-textMuted">
                    MAC: {netInterface.mac} · {netInterface.speedMbps ? `${netInterface.speedMbps} Mb/s` : 'débit inconnu'}{' '}
                    {netInterface.duplex} · MTU {netInterface.mtu}
                  </span>
                </div>
              </div>
              {netInterface.up ? (
                <span className="px-2.5 py-1 rounded bg-emerald-500/15 border border-emerald-500/30 text-emerald-400 font-mono text-xs font-bold self-start sm:self-auto">
                  LIEN ACTIF
                </span>
              ) : (
                <span className="px-2.5 py-1 rounded bg-rose-500/15 border border-rose-500/30 text-rose-400 font-mono text-xs font-bold self-start sm:self-auto">
                  LIEN COUPÉ
                </span>
              )}
            </div>

            {/* Live Throughput big numbers */}
            <div className="grid grid-cols-2 gap-4 my-4">
              {([
                { dir: 'rx', label: 'Débit Réception (Rx)', Icon: ArrowDown, iconClass: 'text-emerald-400', color: '#3fb950',
                  rate: netInterface.rxMBs, total: netInterface.rxTotalGiB, errors: netInterface.rxErrors, history: netInterface.rxHistory },
                { dir: 'tx', label: 'Débit Émission (Tx)', Icon: ArrowUp, iconClass: 'text-purple-400', color: '#a371f7',
                  rate: netInterface.txMBs, total: netInterface.txTotalGiB, errors: netInterface.txErrors, history: netInterface.txHistory },
              ] as const).map((d) => (
                <div key={d.dir} className="p-4 rounded-xl bg-[#0d1117] border border-wopr-border flex items-center justify-between">
                  <div>
                    <span className="text-xs text-wopr-textMuted font-mono flex items-center gap-1.5">
                      <d.Icon className={`w-4 h-4 ${d.iconClass}`} />
                      <span>{d.label}</span>
                    </span>
                    <div className="text-2xl font-bold font-mono text-wopr-text mt-1 tabular">
                      {d.rate} Mo/s
                    </div>
                    <span className="text-[10px] text-wopr-textSubtle font-mono">
                      Cumul : {d.total} Gio ·{' '}
                      <span className={d.errors > 0 ? 'text-amber-400' : undefined}>
                        {d.errors} erreur{d.errors > 1 ? 's' : ''}
                      </span>
                    </span>
                  </div>
                  <Sparkline data={[...d.history]} color={d.color} width={80} height={30} />
                </div>
              ))}
            </div>
          </div>
          )}

          {/* Latency strip */}
          <div className="grid grid-cols-2 gap-4 pt-3 border-t border-wopr-border/50 text-xs font-mono">
            <div className="flex items-center justify-between p-2.5 rounded-lg bg-[#0d1117] border border-wopr-border">
              <span className="text-wopr-textMuted flex items-center gap-1.5">
                <Radio className="w-3.5 h-3.5 text-emerald-400" />
                <span>Passerelle LAN ({gateway.ip ?? 'aucune'})</span>
              </span>
              {gateway.ip ? <PingValue ms={gateway.pingMs} warnMs={20} /> : <span className="text-wopr-textSubtle">—</span>}
            </div>

            <div className="flex items-center justify-between p-2.5 rounded-lg bg-[#0d1117] border border-wopr-border">
              <span className="text-wopr-textMuted flex items-center gap-1.5">
                <Globe className="w-3.5 h-3.5 text-wopr-accent" />
                <span>Internet ({internet.target ?? internet.ip})</span>
              </span>
              <PingValue ms={internet.pingMs} warnMs={80} />
            </div>
          </div>
        </div>

        {/* Listening Ports */}
        <ListeningPortsCard listeners={listeners} docker={docker} />
      </div>

      {/* SECTION 3: SPEED TEST */}
      <div className="bg-wopr-surface border border-wopr-border rounded-xl p-5">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pb-3 border-b border-wopr-border">
          <div className="flex items-center gap-2.5">
            <Gauge className="w-5 h-5 text-wopr-accent" />
            <div>
              <h3 className="text-sm font-bold text-wopr-text tracking-wide">Test de débit Internet</h3>
              <p className="text-[11px] text-wopr-textMuted mt-0.5">
                Mesure via l'infrastructure Cloudflare — cible fixe, pas de configuration possible.
              </p>
            </div>
          </div>
          <button
            onClick={() => store.runSpeedtest()}
            disabled={speedtestRunning}
            className="flex items-center justify-center gap-2 py-2 px-4 rounded-lg bg-wopr-accent/15 hover:bg-wopr-accent/25 disabled:opacity-50 disabled:cursor-not-allowed text-wopr-accent border border-wopr-accent/30 font-medium text-xs transition-colors self-start sm:self-auto"
          >
            {speedtestRunning ? (
              <>
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
                <span>Test en cours…</span>
              </>
            ) : (
              <span>Lancer le test</span>
            )}
          </button>
        </div>

        <div className="grid grid-cols-3 gap-3 mt-4">
          <SpeedValue mbps={speedtest?.downloadMbps ?? null} label="Descendant" />
          <SpeedValue mbps={speedtest?.uploadMbps ?? null} label="Montant" />
          <div className="p-3 rounded-lg bg-[#0d1117] border border-wopr-border text-center">
            <span className="text-[10px] text-wopr-textMuted uppercase block">Latence</span>
            <span className="text-xl font-bold font-mono text-wopr-text tabular">
              {speedtest?.latencyMs ?? '—'}
            </span>
            {speedtest?.latencyMs != null && <span className="text-[10px] text-wopr-textSubtle"> ms</span>}
          </div>
        </div>

        {speedtest && (
          <p className="text-[10px] text-wopr-textSubtle font-mono mt-3">
            Dernier test : {new Date(speedtest.at).toLocaleString('fr-FR')}
          </p>
        )}
      </div>
    </div>
  );
};
