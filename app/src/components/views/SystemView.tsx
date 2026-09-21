import React, { useState } from 'react';
import { useWoprStore } from '../../state/useWoprStore';
import { store } from '../../state/store';
import { ConfirmDialog } from '../common/ConfirmDialog';
import { StatusBadge } from '../common/Badge';
import { ownerTone } from '../common/ownerTones';
import { SHARED_OWNER } from '../../state/types';
import type { SystemService } from '../../state/types';

const RESULT_CLASS: Record<string, string> = {
  succès: 'text-emerald-400',
  attention: 'text-amber-400',
  échec: 'text-rose-400',
  info: 'text-wopr-textMuted',
};

const formatDateTime = (iso: string) =>
  new Date(iso).toLocaleString('fr-FR', {
    day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit',
  });
import {
  Terminal,
  Power,
  RotateCcw,
  Network,
  Boxes,
  Layers,
  Clock,
  ShieldCheck,
  AlertOctagon,
  AlertTriangle,
  History,
  CheckCircle,
  Package,
} from 'lucide-react';

export const SystemView: React.FC = () => {
  const { system, storageNetwork, connected, owners } = useWoprStore();
  const { os, kernel, bootedAt, needsReboot, pendingUpdates, securityUpdates, services,
    recentActions, hostControl } = system;

  // Vrai nom de l'interface principale, lu sur la machine.
  const primaryNic = storageNetwork.interfaces.find((i) => !i.virtual && i.up);

  const [showRebootModal, setShowRebootModal] = useState(false);
  const [showNetRestartModal, setShowNetRestartModal] = useState(false);
  const [serviceToRestart, setServiceToRestart] = useState<SystemService | null>(null);
  const activeCount = services.filter((svc) => svc.state === 'active').length;
  const networkd = services.find((svc) => svc.name === 'systemd-networkd.service');

  // Redémarrage demandé : le serveur cesse de répondre, c'est la perte de la
  // liaison qui fait foi. Aucune barre de progression — nous n'avons aucun moyen
  // de connaître l'avancement d'un reboot depuis un conteneur qui vient de mourir.
  const [rebootRequestedAt, setRebootRequestedAt] = useState<number | null>(null);

  if (rebootRequestedAt !== null) {
    return (
      <div className="h-[calc(100vh-12rem)] flex flex-col items-center justify-center text-center p-6 space-y-5">
        <div className="w-20 h-20 rounded-2xl bg-rose-500/20 border-2 border-rose-500/50 flex items-center justify-center text-rose-400">
          <Power className="w-10 h-10 animate-pulse" />
        </div>

        <div>
          <h2 className="text-2xl font-bold font-mono tracking-tight text-wopr-text">
            Redémarrage de wopr demandé
          </h2>
          <p className="text-sm text-wopr-textMuted mt-2 max-w-md">
            {connected
              ? "Le serveur répond encore — l'extinction des services est en cours."
              : 'Le serveur ne répond plus. La page se reconnectera d\'elle-même quand il sera revenu.'}
          </p>
        </div>

        <p className="text-xs text-wopr-textSubtle font-mono">
          Demandé à {new Date(rebootRequestedAt).toLocaleTimeString('fr-FR')}
        </p>

        <button
          onClick={() => setRebootRequestedAt(null)}
          className="text-xs text-wopr-textMuted hover:text-wopr-text underline"
        >
          Revenir à la vue Système
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-6 animate-in fade-in duration-200">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pb-4 border-b border-wopr-border">
        <div>
          <h1 className="text-xl font-bold tracking-tight text-wopr-text flex items-center gap-2.5">
            <Terminal className="w-5 h-5 text-wopr-accent" />
            <span>Système d'Exploitation & Pilotage Machine</span>
          </h1>
          <p className="text-xs text-wopr-textMuted mt-1">
            Actions d'infrastructure, gestion des démons Linux et maintenance du nœud wopr
          </p>
        </div>

        {needsReboot && (
          <div className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-amber-500/15 border border-amber-500/30 text-amber-300 font-mono text-xs font-semibold">
            <AlertTriangle className="w-4 h-4 text-amber-400" />
            <span>Redémarrage noyau requis (needs-reboot)</span>
          </div>
        )}
      </div>

      {/* SECTION 1: SYSTEM INFO & UPDATES */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        <div className="p-4 rounded-xl bg-wopr-surface border border-wopr-border flex flex-col justify-between">
          <span className="text-[11px] text-wopr-textMuted uppercase font-mono">Système hôte</span>
          <div className="text-base font-bold text-wopr-text font-sans mt-1">{os}</div>
          <span className="text-[10px] text-wopr-textSubtle font-mono mt-0.5">Kernel {kernel}</span>
        </div>

        <div className="p-4 rounded-xl bg-wopr-surface border border-wopr-border flex flex-col justify-between">
          <span className="text-[11px] text-wopr-textMuted uppercase font-mono">Dernier démarrage</span>
          <div className="text-sm font-semibold text-wopr-text font-mono mt-1">
            {bootedAt
              ? new Date(bootedAt).toLocaleString('fr-FR', { dateStyle: 'medium', timeStyle: 'short' })
              : '—'}
          </div>
          <span className={`text-[10px] font-mono mt-0.5 ${needsReboot ? 'text-amber-400' : 'text-wopr-textSubtle'}`}>
            {needsReboot ? 'Redémarrage requis par des mises à jour' : 'Aucun redémarrage requis'}
          </span>
        </div>

        <div className="p-4 rounded-xl bg-wopr-surface border border-wopr-border flex flex-col justify-between">
          <span className="text-[11px] text-wopr-textMuted uppercase font-mono">Paquets APT</span>
          <div className="text-base font-bold text-wopr-text mt-1">
            {pendingUpdates === null ? 'màj non déterminées' : `${pendingUpdates} màj en attente`}
          </div>
          <span className={`text-[10px] font-mono mt-0.5 ${securityUpdates ? 'text-amber-400' : 'text-wopr-textSubtle'}`}>
            {securityUpdates === null ? '—' : `${securityUpdates} correctif${securityUpdates > 1 ? 's' : ''} de sécurité`}
            {' '}· vérifié toutes les 10 min
          </span>
        </div>

        <div className="p-4 rounded-xl bg-wopr-surface border border-wopr-border flex flex-col justify-between">
          <span className="text-[11px] text-wopr-textMuted uppercase font-mono">Administrateurs</span>
          {/* Les identités viennent de `config/owners.yaml` : « partagé » n'est
              pas une personne, il n'a rien à faire dans cette liste. */}
          <div className="text-sm font-bold font-mono mt-1 flex items-center gap-2 flex-wrap">
            {owners
              .filter((o) => o.id !== SHARED_OWNER)
              .map((o, i) => (
                <React.Fragment key={o.id}>
                  {i > 0 && <span className="text-wopr-textMuted">·</span>}
                  <span className={ownerTone(o.tone).text} title={o.description}>
                    {o.label}
                  </span>
                </React.Fragment>
              ))}
          </div>
          <span className="text-[10px] text-wopr-textSubtle font-mono mt-0.5">Actions tracées par compte dans le journal</span>
        </div>
      </div>

      {/* SECTION 2: MACHINE ACTIONS */}
      <div>
        <h3 className="text-xs font-semibold uppercase tracking-wider text-wopr-text mb-3">
          Actions d'administration machine
        </h3>

        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {/* Restart Server (Dangerous) */}
          <div className="p-4 rounded-xl bg-rose-500/10 border border-rose-500/30 flex flex-col justify-between space-y-3">
            <div>
              <div className="flex items-center gap-2 text-rose-400 font-bold text-sm">
                <Power className="w-4 h-4" />
                <span>Redémarrer le serveur wopr</span>
              </div>
              <p className="text-xs text-wopr-textMuted mt-1 leading-relaxed">
                Relance matérielle complète. Interrompt temporairement tous les flux
                réseau, les enregistrements vidéo et les inférences LLM.
              </p>
            </div>
            <button
              onClick={() => setShowRebootModal(true)}
              disabled={!hostControl}
              title={hostControl ? undefined : "Le conteneur n'a pas accès à l'hôte"}
              className="disabled:opacity-40 disabled:cursor-not-allowed w-full py-2 px-3 rounded-lg bg-rose-600 hover:bg-rose-500 text-white font-semibold text-xs transition-colors shadow"
            >
              Redémarrer la machine
            </button>
          </div>

          {/* Shutdown Server */}
          <div className="p-4 rounded-xl bg-wopr-surface border border-dashed border-wopr-border flex flex-col justify-between space-y-3 opacity-70">
            <div>
              <div className="flex items-center gap-2 text-wopr-textMuted font-bold text-sm">
                <Power className="w-4 h-4" />
                <span>Extinction et redémarrage de Docker</span>
              </div>
              <p className="text-xs text-wopr-textMuted mt-1 leading-relaxed">
                Ces deux actions ne sont pas proposées, délibérément. Éteindre wopr
                depuis une page web laisserait la machine inaccessible jusqu'à un appui
                physique sur le bouton. Relancer le démon Docker tuerait le dashboard
                lui-même en même temps que tout le reste — sans qu'il reste rien pour
                signaler ce qui se passe.
              </p>
            </div>
          </div>

          {/* Restart Network Stack */}
          <div className="p-4 rounded-xl bg-wopr-surface border border-wopr-border flex flex-col justify-between space-y-3">
            <div>
              <div className="flex items-center gap-2 text-cyan-400 font-bold text-sm">
                <Network className="w-4 h-4" />
                <span>Redémarrer la pile réseau</span>
              </div>
              <p className="text-xs text-wopr-textMuted mt-1 leading-relaxed">
                Relance systemd-networkd. Brève coupure possible sur la liaison LAN.
              </p>
            </div>
            <button
              onClick={() => setShowNetRestartModal(true)}
              disabled={!hostControl || !networkd}
              title={!networkd ? 'systemd-networkd introuvable sur cet hôte' : undefined}
              className="disabled:opacity-40 disabled:cursor-not-allowed w-full py-2 px-3 rounded-lg bg-white/5 hover:bg-white/10 text-wopr-text border border-wopr-border font-medium text-xs transition-colors"
            >
              Relancer le réseau
            </button>
          </div>

          {/* Drop Caches */}
          <div className="p-4 rounded-xl bg-wopr-surface border border-wopr-border flex flex-col justify-between space-y-3">
            <div>
              <div className="flex items-center gap-2 text-emerald-400 font-bold text-sm">
                <Layers className="w-4 h-4" />
                <span>Vider les caches RAM (`drop_caches`)</span>
              </div>
              <p className="text-xs text-wopr-textMuted mt-1 leading-relaxed">
                Purge les pagecaches et inodes en mémoire libre. Sans interruption de service pour les applications.
              </p>
            </div>
            <button
              onClick={() => store.dropCaches()}
              className="w-full py-2 px-3 rounded-lg bg-emerald-500/15 hover:bg-emerald-500/25 text-emerald-300 border border-emerald-500/30 font-medium text-xs transition-colors"
            >
              Purger les caches
            </button>
          </div>
        </div>
      </div>

      {/* SECTION 3: SYSTEMD SERVICES WHITELIST */}
      <div className="bg-wopr-surface border border-wopr-border rounded-xl p-5 space-y-4">
        <div className="flex items-center justify-between pb-3 border-b border-wopr-border">
          <div>
            <h3 className="text-sm font-semibold uppercase tracking-wider text-wopr-text">
              Services système surveillés (systemd)
            </h3>
            <p className="text-xs text-wopr-textMuted mt-0.5">
              Liste fixée côté serveur ; seuls certains peuvent être redémarrés depuis l'interface
            </p>
          </div>
          <span
            className={`text-xs font-mono font-bold ${
              services.length === 0 ? 'text-wopr-textMuted'
                : activeCount === services.length ? 'text-emerald-400' : 'text-amber-400'
            }`}
          >
            {services.length === 0 ? 'état non lisible' : `${activeCount} / ${services.length} actifs`}
          </span>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
          {services.map((svc) => (
            <div
              key={svc.name}
              className={`p-3 rounded-lg bg-[#0d1117] border flex flex-col justify-between space-y-2 ${
                svc.state === 'failed' ? 'border-rose-500/50' : 'border-wopr-border'
              }`}
            >
              <div>
                <div className="flex items-center justify-between gap-2 font-mono text-xs">
                  {/* Le nom porte déjà « .service » : l'ancien affichage le doublait. */}
                  <span className="font-bold text-wopr-accent truncate" title={svc.name}>{svc.name}</span>
                  <StatusBadge status={svc.state === 'inactive' ? 'idle' : svc.state} />
                </div>
                <p className="text-[11px] text-wopr-textMuted mt-1 line-clamp-2">
                  {svc.description}
                </p>
              </div>

              {svc.restartable ? (
                <button
                  onClick={() => setServiceToRestart(svc)}
                  disabled={!hostControl}
                  className="w-full py-1 rounded bg-white/5 hover:bg-white/10 text-wopr-text text-[11px] font-medium flex items-center justify-center gap-1.5 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  <RotateCcw className="w-3 h-3" />
                  <span>Redémarrer</span>
                </button>
              ) : (
                <span
                  className="w-full py-1 text-center text-[10px] text-wopr-textSubtle"
                  title="Relancer ce service couperait le dashboard lui-même"
                >
                  Non redémarrable depuis l'interface
                </span>
              )}
            </div>
          ))}
        </div>
      </div>

      {/* SECTION 4: RECENT SYSTEM ACTIONS LOG */}
      <div className="bg-wopr-surface border border-wopr-border rounded-xl p-5 space-y-3">
        <div className="flex items-center gap-2 pb-2 border-b border-wopr-border">
          <History className="w-4 h-4 text-wopr-accent" />
          <h3 className="text-xs font-semibold uppercase tracking-wider text-wopr-text">
            Historique des actions système récentes
          </h3>
        </div>

        <div className="space-y-2">
          {recentActions.length === 0 && (
            <p className="text-xs text-wopr-textMuted">Aucune action système enregistrée.</p>
          )}
          {recentActions.map((act) => (
            <div
              key={act.id}
              className="p-2.5 rounded-lg bg-[#0d1117] border border-wopr-border flex items-center justify-between text-xs font-mono"
            >
              <div className="flex items-center gap-2 min-w-0">
                <span className="font-bold text-wopr-text truncate" title={act.action}>{act.action}</span>
                <span className="text-wopr-textMuted shrink-0">({act.target})</span>
                <span className="text-cyan-400 shrink-0">@{act.by}</span>
              </div>
              <div className="flex items-center gap-3 shrink-0">
                <span className="text-wopr-textSubtle text-[10px]">{formatDateTime(act.at)}</span>
                <span className={RESULT_CLASS[act.result] ?? 'text-wopr-textMuted'}>{act.result}</span>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Reboot Confirm Dialog */}
      <ConfirmDialog
        isOpen={showRebootModal}
        title="Redémarrage complet du serveur wopr"
        isDestructive={true}
        countdownSeconds={10}
        requireReason={true}
        requireTextMatch="REBOOT"
        otherAdminWarning="Action critique d'administration machine enregistrée dans le journal d'audit."
        description={
          <div>
            <p>
              Êtes-vous absolument sûr de vouloir redémarrer le serveur <strong>wopr</strong> ?
            </p>
            <p className="mt-2 text-rose-300">
              Toutes les sessions SSH, les conteneurs Docker et les traitements LLM
              seront coupés net.
            </p>
          </div>
        }
        confirmText="Lancer le redémarrage (10s de sécurité)"
        onConfirm={async (reason) => {
          setShowRebootModal(false);
          // Le serveur exige ce mot en clair : une boîte de dialogue côté
          // navigateur ne protège de rien s'il suffit d'appeler l'API.
          const ok = await store.triggerReboot(
            reason || 'Redémarrage depuis la vue Système', 'redemarrer');
          if (ok) setRebootRequestedAt(Date.now());
        }}
        onCancel={() => setShowRebootModal(false)}
      />

      <ConfirmDialog
        isOpen={serviceToRestart !== null}
        title={`Redémarrer ${serviceToRestart?.name ?? ''}`}
        description={
          serviceToRestart?.name === 'ssh.service'
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

      {/* Network restart Dialog */}
      <ConfirmDialog
        isOpen={showNetRestartModal}
        title="Redémarrer l'interface réseau"
        description={`Le service systemd-networkd va être relancé${primaryNic ? ` (interface ${primaryNic.name})` : ''}. Votre session web sera momentanément figée, et la liaison peut mettre quelques secondes à revenir.`}
        confirmText="Redémarrer systemd-networkd"
        onConfirm={() => {
          // Action réelle : le toast de résultat vient de la réponse du serveur,
          // il n'est plus affiché d'avance.
          void store.restartService('systemd-networkd.service');
          setShowNetRestartModal(false);
        }}
        onCancel={() => setShowNetRestartModal(false)}
      />
    </div>
  );
};
