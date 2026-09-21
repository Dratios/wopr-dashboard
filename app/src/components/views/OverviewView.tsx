import React, { useState } from 'react';
import { useWoprStore } from '../../state/useWoprStore';
import { store } from '../../state/store';
import { HealthBanner } from '../common/HealthBanner';
import { MetricCard } from '../common/MetricCard';
import { TimeSeriesChart } from '../common/TimeSeriesChart';
import { ConfirmDialog } from '../common/ConfirmDialog';
import { ModeActivationDialog, ModeIcon } from '../common/ModeActivationDialog';
import type { ModeItem, SystemService } from '../../state/types';
import { ViewId } from '../layout/Sidebar';
import {
  Cpu,
  Tv2,
  ThermometerSnowflake,
  HardDrive,
  Activity,
  Boxes,
  Server,
  Zap,
  RotateCcw,
  Power,
  Layers,
  Sparkles,
  CheckCircle2,
  ArrowRight,
} from 'lucide-react';

interface OverviewViewProps {
  onNavigate: (view: ViewId) => void;
  onOpenAlerts: () => void;
}

export const OverviewView: React.FC<OverviewViewProps> = ({ onNavigate, onOpenAlerts }) => {
  const { overview, modes, docker, gpu, cpuRam, system } = useWoprStore();
  const [showRebootDialog, setShowRebootDialog] = useState(false);
  const [showServiceDialog, setShowServiceDialog] = useState(false);
  const [showModeDialog, setShowModeDialog] = useState(false);
  const [modeToActivate, setModeToActivate] = useState<ModeItem | null>(null);
  const [serviceToRestart, setServiceToRestart] = useState<SystemService | null>(null);

  // Subsystem icon mapping
  const getSubsystemIcon = (id: string) => {
    switch (id) {
      case 'cpu':
        return <Cpu className="w-4 h-4" />;
      case 'ram':
        return <Layers className="w-4 h-4" />;
      case 'gpu':
        return <Tv2 className="w-4 h-4" />;
      case 'thermal':
        return <ThermometerSnowflake className="w-4 h-4" />;
      case 'storage':
        return <HardDrive className="w-4 h-4" />;
      case 'network':
        return <Activity className="w-4 h-4" />;
      case 'docker':
        return <Boxes className="w-4 h-4" />;
      case 'services':
        return <Server className="w-4 h-4" />;
      default:
        return <Activity className="w-4 h-4" />;
    }
  };

  // Bandeau rapide : tout vient des données reçues. La maquette d'origine affichait
  // des valeurs figées (« 13 / 15 en cours », « 2 chargés », « CPU + 2 GPU »,
  // « 8 cœurs / 16 th », une sauvegarde à 04:00 qui n'existe pas).
  const modelsVramGiB = gpu.models.reduce((sum, m) => sum + (m.vramMiB || 0), 0) / 1024;
  const uptimeDays = Math.floor(overview.uptimeSeconds / 86400);
  const uptimeHours = Math.floor((overview.uptimeSeconds % 86400) / 3600);
  const uptimeLabel = uptimeDays > 0 ? `${uptimeDays} j ${uptimeHours} h` : `${uptimeHours} h ${Math.floor((overview.uptimeSeconds % 3600) / 60)} min`;
  const restartableServices = system.services.filter((svc) => svc.restartable);

  // Comme la cloche : seules les alertes non acquittées sont « en attente ».
  const pendingAlerts = overview.alerts.filter((a) => !a.acknowledged);

  return (
    <div className="space-y-6 animate-in fade-in duration-200">
      {/* 1. Health Banner */}
      <HealthBanner
        level={overview.health.level}
        summary={overview.health.summary}
        detail={overview.health.detail}
        alertsCount={pendingAlerts.length}
        onOpenAlerts={onOpenAlerts}
      />

      {/* 2. Quick Info Strip */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
        <div className="bg-wopr-surface border border-wopr-border rounded-xl p-3 flex flex-col justify-between">
          <span className="text-[11px] font-medium text-wopr-textMuted uppercase tracking-wider">
            Mode actif
          </span>
          <div className="flex items-center gap-1.5 mt-1">
            <ModeIcon icon={overview.activeMode.icon} className="w-3.5 h-3.5" />
            <span className="font-semibold text-xs text-wopr-text truncate">
              {overview.activeMode.label}
            </span>
          </div>
          <span className="text-[10px] text-wopr-textSubtle font-mono mt-0.5">
            par @{overview.activeMode.activatedBy}
          </span>
        </div>

        <div className="bg-wopr-surface border border-wopr-border rounded-xl p-3 flex flex-col justify-between">
          <span className="text-[11px] font-medium text-wopr-textMuted uppercase tracking-wider">
            Conteneurs
          </span>
          <span className="font-bold font-mono text-base text-wopr-text mt-1 tabular">
            {docker.available ? `${docker.summary.running} / ${docker.summary.total} en cours` : 'indisponible'}
          </span>
          {docker.available && docker.summary.unhealthy > 0 ? (
            <span className="text-[10px] text-rose-400 font-mono mt-0.5">
              {docker.summary.unhealthy} en anomalie
            </span>
          ) : (
            <span className="text-[10px] text-wopr-textSubtle font-mono mt-0.5">
              {docker.available ? 'aucune anomalie' : docker.unavailableReason ?? ''}
            </span>
          )}
        </div>

        <div className="bg-wopr-surface border border-wopr-border rounded-xl p-3 flex flex-col justify-between">
          <span className="text-[11px] font-medium text-wopr-textMuted uppercase tracking-wider">
            Modèles LLM
          </span>
          <span className="font-bold font-mono text-base text-wopr-text mt-1 tabular">
            {gpu.models.length} chargé{gpu.models.length > 1 ? 's' : ''}
          </span>
          <span className="text-[10px] text-wopr-textMuted font-mono mt-0.5">
            {gpu.ollamaReachable ? `${modelsVramGiB.toFixed(1)} Gio VRAM` : 'Ollama injoignable'}
          </span>
        </div>

        <div className="bg-wopr-surface border border-wopr-border rounded-xl p-3 flex flex-col justify-between">
          <span className="text-[11px] font-medium text-wopr-textMuted uppercase tracking-wider">
            Puissance est.
          </span>
          <div className="flex items-center gap-1 mt-1">
            <Sparkles className="w-3.5 h-3.5 text-amber-400" />
            <span className="font-bold font-mono text-base text-wopr-text tabular">
              {overview.powerEstimateW !== null ? `${overview.powerEstimateW} W` : '—'}
            </span>
          </div>
          <span
            className="text-[10px] text-wopr-textSubtle font-mono mt-0.5 truncate"
            title={overview.powerScope ? `${overview.powerScope} — carte mère, disques et ventilateurs non comptés` : undefined}
          >
            {overview.powerScope ?? 'non mesurable'}
          </span>
        </div>

        <div className="bg-wopr-surface border border-wopr-border rounded-xl p-3 flex flex-col justify-between">
          <span className="text-[11px] font-medium text-wopr-textMuted uppercase tracking-wider">
            Charge 1m
          </span>
          <span className="font-bold font-mono text-base text-wopr-text mt-1 tabular">
            {overview.loadavg[0]}
          </span>
          <span className="text-[10px] text-wopr-textSubtle font-mono mt-0.5">
            {cpuRam.cpu.cores} cœurs / {cpuRam.cpu.threads} th
          </span>
        </div>

        <div className="bg-wopr-surface border border-wopr-border rounded-xl p-3 flex flex-col justify-between">
          <span className="text-[11px] font-medium text-wopr-textMuted uppercase tracking-wider">
            Allumé depuis
          </span>
          <span className="font-bold font-mono text-base text-wopr-text mt-1 tabular">{uptimeLabel}</span>
          <span className="text-[10px] text-wopr-textSubtle font-mono mt-0.5">{overview.host}</span>
        </div>
      </div>

      {/* 3. Subsystems Tiles Grid */}
      <div>
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-sm font-semibold text-wopr-text tracking-wide uppercase">
            Sous-systèmes machine
          </h3>
          <span className="text-xs text-wopr-textMuted">Cliquez sur une tuile pour inspecter</span>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
          {overview.subsystems.map((sub) => (
            <MetricCard
              key={sub.id}
              title={sub.label}
              value={sub.value}
              subvalue={sub.subvalue}
              level={sub.level}
              icon={getSubsystemIcon(sub.id)}
              sparklineData={sub.spark}
              onClick={() => onNavigate(sub.viewId as ViewId)}
            />
          ))}
        </div>
      </div>

      {/* 4. Active Alerts & Quick Action shortcuts */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Alerts panel */}
        <div className="lg:col-span-2 bg-wopr-surface border border-wopr-border rounded-xl p-4 flex flex-col justify-between">
          <div>
            <div className="flex items-center justify-between pb-3 border-b border-wopr-border/60 mb-3">
              <div className="flex items-center gap-2">
                <h3 className="text-sm font-semibold text-wopr-text tracking-wide">
                  Alertes & Points d'attention
                </h3>
                <span className="text-xs font-mono px-2 py-0.5 rounded-full bg-black/30 text-wopr-text">
                  {pendingAlerts.length}
                </span>
              </div>
              <button
                onClick={onOpenAlerts}
                className="text-xs text-wopr-accent hover:underline flex items-center gap-1 font-medium"
              >
                <span>Voir toutes les alertes</span>
                <ArrowRight className="w-3.5 h-3.5" />
              </button>
            </div>

            {pendingAlerts.length === 0 ? (
              <div className="py-8 flex flex-col items-center justify-center text-center text-wopr-textMuted">
                <CheckCircle2 className="w-10 h-10 text-emerald-400 mb-2 opacity-80" />
                <span className="text-sm font-medium text-wopr-text">
                  {overview.alerts.length === 0 ? 'Aucune alerte active' : 'Aucune alerte en attente'}
                </span>
                <span className="text-xs text-wopr-textMuted mt-0.5">
                  {overview.alerts.length === 0
                    ? 'Tous les seuils de surveillance sont respectés'
                    : `${overview.alerts.length} alerte(s) acquittée(s), toujours active(s)`}
                </span>
              </div>
            ) : (
              <div className="space-y-2.5">
                {pendingAlerts.slice(0, 4).map((alert) => (
                  <div
                    key={alert.id}
                    className={`p-3 rounded-lg border flex items-center justify-between gap-3 text-xs ${
                      alert.level === 'err'
                        ? 'bg-rose-500/10 border-rose-500/30 text-rose-300'
                        : alert.level === 'warn'
                          ? 'bg-amber-500/10 border-amber-500/30 text-amber-300'
                          : 'bg-sky-500/10 border-sky-500/30 text-sky-300'
                    }`}
                  >
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="font-mono font-bold uppercase">{alert.component}</span>
                        <span className="text-[10px] opacity-75 font-mono">
                          {new Date(alert.since).toLocaleTimeString('fr-FR', {
                            hour: '2-digit',
                            minute: '2-digit',
                          })}
                        </span>
                      </div>
                      <p className="text-wopr-text mt-0.5 truncate">{alert.message}</p>
                    </div>

                    <button
                      onClick={() => store.acknowledgeAlert(alert.id)}
                      className="px-2.5 py-1 rounded bg-black/20 hover:bg-black/40 text-wopr-text text-[11px] font-medium shrink-0 border border-white/10 transition-colors"
                    >
                      Acquitter
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Quick action shortcuts */}
        <div className="bg-wopr-surface border border-wopr-border rounded-xl p-4 flex flex-col justify-between">
          <div>
            <h3 className="text-sm font-semibold text-wopr-text tracking-wide pb-3 border-b border-wopr-border/60 mb-3">
              Raccourcis d'actions
            </h3>
            <p className="text-xs text-wopr-textMuted mb-4">
              Opérations fréquentes, chacune inscrite à votre nom dans le journal d'audit.
            </p>

            <div className="space-y-2.5">
              <button
                onClick={() => setShowModeDialog(true)}
                className="w-full flex items-center justify-between p-3 rounded-lg bg-wopr-surface2 hover:bg-wopr-surface3 border border-wopr-border text-xs font-medium text-wopr-text transition-colors"
              >
                <div className="flex items-center gap-2.5">
                  <Zap className="w-4 h-4 text-wopr-accent" />
                  <span>Changer de profil / mode</span>
                </div>
                <span className="text-wopr-textMuted font-mono text-[11px]">
                  {overview.activeMode.label} →
                </span>
              </button>

              <button
                onClick={() => setShowServiceDialog(true)}
                className="w-full flex items-center justify-between p-3 rounded-lg bg-wopr-surface2 hover:bg-wopr-surface3 border border-wopr-border text-xs font-medium text-wopr-text transition-colors"
              >
                <div className="flex items-center gap-2.5">
                  <RotateCcw className="w-4 h-4 text-emerald-400" />
                  <span>Redémarrer un service systemd</span>
                </div>
                <span className="text-wopr-textMuted text-[11px]">
                  {restartableServices.length} service{restartableServices.length > 1 ? 's' : ''} →
                </span>
              </button>

              <button
                onClick={() => setShowRebootDialog(true)}
                className="w-full flex items-center justify-between p-3 rounded-lg bg-rose-500/15 hover:bg-rose-500/25 border border-rose-500/30 text-xs font-semibold text-rose-300 transition-colors"
              >
                <div className="flex items-center gap-2.5">
                  <Power className="w-4 h-4 text-rose-400" />
                  <span>Redémarrer le serveur wopr</span>
                </div>
                <span className="text-rose-400/80 font-mono text-[11px]">Sécurisé →</span>
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* 5. Historical mini-graphs (24h) */}
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold text-wopr-text tracking-wide uppercase">
            Activité récente
          </h3>
          {/* Historique du serveur : 120 points à 5 s d'intervalle, soit ~10 minutes,
              remis à zéro au redémarrage du dashboard. */}
          <span className="text-xs font-mono text-wopr-textMuted">
            ~10 dernières minutes · un point toutes les 5 s
          </span>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          <TimeSeriesChart
            title="Charge CPU (%) & Température Max (°C)"
            series={[
              {
                id: 'cpu_pct',
                name: 'CPU',
                color: '#4c9ffe',
                unit: '%',
                data: overview.historicalMetrics.cpuPct,
              },
              {
                id: 'temp_max',
                name: 'Temp. max',
                color: '#d29922',
                unit: '°C',
                data: overview.historicalMetrics.tempMaxC,
              },
            ]}
            timestamps={overview.historicalMetrics.timestamps}
            historyMetrics={{ cpu_pct: 'cpu', temp_max: 'tempMax' }}
            warnThreshold={80}
            critThreshold={90}
            height={190}
          />

          <TimeSeriesChart
            title="Trafic réseau des interfaces physiques (Mo/s)"
            series={[
              {
                id: 'net_rx',
                name: 'Réception (Rx)',
                color: '#3fb950',
                unit: 'Mo/s',
                data: overview.historicalMetrics.netRxMBs,
              },
              {
                id: 'net_tx',
                name: 'Émission (Tx)',
                color: '#a371f7',
                unit: 'Mo/s',
                data: overview.historicalMetrics.netTxMBs,
              },
            ]}
            timestamps={overview.historicalMetrics.timestamps}
            historyMetrics={{ net_rx: 'netRx', net_tx: 'netTx' }}
            height={190}
          />
        </div>
      </div>

      {/* Confirmation Dialogs */}
      <ConfirmDialog
        isOpen={showRebootDialog}
        title="Redémarrage du serveur wopr"
        isDestructive={true}
        countdownSeconds={10}
        requireReason={true}
        requireTextMatch="REBOOT"
        otherAdminWarning="Attention : cette opération va redémarrer la machine hôte et interrompre tous les conteneurs."
        description={
          <div>
            <p>
              Êtes-vous sûr de vouloir redémarrer le serveur <strong>wopr</strong> ?
            </p>
            <p className="mt-2 text-rose-300">
              Tous les conteneurs Docker, les inférences LLM et les sessions SSH
              actives seront immédiatement interrompus.
            </p>
          </div>
        }
        confirmText="Lancer le compte à rebours de reboot"
        onConfirm={(reason) => {
          setShowRebootDialog(false);
          // « redemarrer » est la confirmation exigée par l'API elle-même.
          void store.triggerReboot(
            reason || "Redémarrage depuis la vue d'ensemble", 'redemarrer');
        }}
        onCancel={() => setShowRebootDialog(false)}
      />

      {/* Fast Mode Change Dialog */}
      <ConfirmDialog
        isOpen={showModeDialog}
        title="Changer de profil machine"
        description={
          <div className="space-y-3">
            <p>Sélectionnez le mode à appliquer :</p>
            <div className="grid grid-cols-1 gap-2">
              {modes.modes.map((m) => (
                <button
                  key={m.id}
                  onClick={() => {
                    setShowModeDialog(false);
                    if (m.id !== modes.active) setModeToActivate(m);
                  }}
                  className={`p-2.5 rounded-lg border text-left flex items-start justify-between text-xs transition-colors ${
                    m.id === modes.active
                      ? 'bg-wopr-accent/20 border-wopr-accent text-wopr-accent font-semibold'
                      : 'bg-[#0d1117] border-wopr-border hover:bg-white/5 text-wopr-text'
                  }`}
                >
                  <div>
                    <div className="font-semibold">{m.label}</div>
                    <div className="text-[11px] text-wopr-textMuted mt-0.5">{m.description}</div>
                  </div>
                  {m.id === modes.active && (
                    <span className="text-[10px] font-mono uppercase bg-wopr-accent/30 text-wopr-accent px-1.5 py-0.5 rounded">
                      Actif
                    </span>
                  )}
                </button>
              ))}
            </div>
          </div>
        }
        confirmText="Fermer"
        onConfirm={() => setShowModeDialog(false)}
        onCancel={() => setShowModeDialog(false)}
      />

      {/* Fast Service Restart Dialog */}
      <ConfirmDialog
        isOpen={showServiceDialog}
        title="Redémarrer un service systemd"
        description={
          <div className="space-y-2">
            <p className="text-xs text-wopr-textMuted mb-2">
              Choisissez le service à relancer. Seuls les services autorisés sur wopr sont listés :
            </p>
            {/* Liste fournie par le serveur : l'ancienne, écrite en dur dans la
                maquette, n'envoyait que des noms que l'API refuse. */}
            {restartableServices.length === 0 && (
              <p className="text-xs text-wopr-textMuted">Aucun service redémarrable remonté par le serveur.</p>
            )}
            {restartableServices.map((svc) => (
              <button
                key={svc.name}
                onClick={() => {
                  setShowServiceDialog(false);
                  setServiceToRestart(svc);
                }}
                className="w-full p-2.5 rounded-lg bg-[#0d1117] hover:bg-white/5 border border-wopr-border flex items-center justify-between text-xs text-wopr-text transition-colors"
                title={svc.description}
              >
                <span className="font-mono font-bold text-wopr-accent">{svc.name}</span>
                <span
                  className={`font-medium text-[11px] ${
                    svc.state === 'active' ? 'text-emerald-400' : svc.state === 'failed' ? 'text-rose-400' : 'text-wopr-textMuted'
                  }`}
                >
                  {svc.state === 'active' ? 'Actif' : svc.state === 'failed' ? 'En échec' : 'Inactif'} → Relancer
                </span>
              </button>
            ))}
          </div>
        }
        confirmText="Annuler"
        onConfirm={() => setShowServiceDialog(false)}
        onCancel={() => setShowServiceDialog(false)}
      />

      <ConfirmDialog
        isOpen={serviceToRestart !== null}
        title={`Redémarrer ${serviceToRestart?.name ?? ''}`}
        description={
          serviceToRestart?.name === 'systemd-networkd.service'
            ? 'La pile réseau va être relancée : la liaison LAN peut être coupée quelques secondes, et cette page avec.'
            : serviceToRestart?.name === 'ssh.service'
              ? 'Le serveur SSH va être relancé : les nouvelles connexions sont refusées pendant quelques secondes (les sessions ouvertes sont normalement conservées).'
              : `Le service « ${serviceToRestart?.description ?? ''} » va être relancé sur wopr.`
        }
        confirmText="Redémarrer le service"
        onConfirm={() => {
          if (serviceToRestart) void store.restartService(serviceToRestart.name);
          setServiceToRestart(null);
        }}
        onCancel={() => setServiceToRestart(null)}
      />

      <ModeActivationDialog
        target={modeToActivate}
        current={modes.modes.find((m) => m.id === modes.active)}
        onClose={() => setModeToActivate(null)}
      />
    </div>
  );
};
