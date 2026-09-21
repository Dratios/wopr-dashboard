import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useWoprStore } from '../../state/useWoprStore';
import { store } from '../../state/store';
import { api } from '../../state/api';
import { Measure } from '../common/Measure';
import { OwnerBadge, StatusBadge } from '../common/Badge';
import { Sparkline } from '../common/Sparkline';
import { ConfirmDialog } from '../common/ConfirmDialog';
import { ownerTone } from '../common/ownerTones';
import {
  Boxes,
  Play,
  Square,
  RotateCcw,
  FileText,
  Trash2,
  Eye,
  EyeOff,
  X,
  FileCode,
  Shield,
  Search,
  User,
  Users,
  Layers,
  Cpu,
  Server,
  RefreshCw,
} from 'lucide-react';
import {
  DockerContainer, DockerStack, Owner, OwnerInfo, ContainerLogLine, SHARED_OWNER,
} from '../../state/types';

interface ActiveContainerInfo {
  container: DockerContainer;
  stackName: string;
  stackOwner: Owner;
}


/**
 * Avertissement de « politesse d'infra » (§1.5 et §5 de wopr-server-rules.md).
 *
 * Agir sur ce qui appartient à l'autre administrateur reste permis, mais ne doit
 * jamais se faire par inadvertance : on le dit avant, et l'audit l'enregistre après.
 */
function otherAdminWarningFor(
  pending: { container?: DockerContainer; stack?: DockerStack; action: string },
  identity: Owner,
  owners: OwnerInfo[],
): string | undefined {
  const target = pending.container ?? pending.stack;
  if (!target) return undefined;

  if (pending.stack?.outOfScope) {
    return `La stack « ${pending.stack.name} » est hors du périmètre du dashboard : ` +
      "l'API refusera cette action.";
  }
  if (target.owner === SHARED_OWNER) {
    return 'Ressource partagée : une décision qui concerne tous les administrateurs.';
  }
  if (target.owner !== identity) {
    const label = owners.find((o) => o.id === target.owner)?.label ?? target.owner;
    return `Cette ressource appartient à ${label}. Vous pouvez agir, mais ` +
      "prévenez la personne concernée — l'action sera inscrite à votre nom dans " +
      "le journal d'audit.";
  }
  return undefined;
}

export const DockerView: React.FC = () => {
  const { docker, containerCpuHistory, ownerIdentity, owners } = useWoprStore();
  const { stacks, summary } = docker;

  const [searchQuery, setSearchQuery] = useState('');
  // `all` ou l'identifiant d'une identité de `config/owners.yaml` : la liste
  // n'est pas connue à la compilation, d'où un simple `string`.
  const [selectedOwnerFilter, setSelectedOwnerFilter] = useState<'all' | Owner>('all');
  const [activeContainerDetailRaw, setActiveContainerDetail] = useState<ActiveContainerInfo | null>(null);
  // Le panneau garde l'identifiant, mais lit le conteneur dans les données courantes :
  // il affichait sinon l'état et les métriques du moment où il avait été ouvert.
  const activeContainerDetail = useMemo<ActiveContainerInfo | null>(() => {
    if (!activeContainerDetailRaw) return null;
    for (const stack of stacks) {
      const live = stack.containers.find((c) => c.id === activeContainerDetailRaw.container.id);
      if (live) return { container: live, stackName: stack.name, stackOwner: stack.owner };
    }
    return activeContainerDetailRaw;
  }, [activeContainerDetailRaw, stacks]);
  const activeContainerId = activeContainerDetail?.container.id ?? null;
  const [activeDrawerTab, setActiveDrawerTab] = useState<'logs' | 'stats' | 'config' | 'gpu'>('logs');
  const [showComposeModal, setShowComposeModal] = useState<DockerStack | null>(null);

  // Confirmation action state for destructive actions
  const [pendingAction, setPendingAction] = useState<{
    container?: DockerContainer;
    stack?: DockerStack;
    action: 'start' | 'stop' | 'restart' | 'delete' | 'down';
  } | null>(null);

  // Journaux du conteneur ouvert : lus à la demande via l'API, pas embarqués
  // dans la charge utile de la liste.
  const [logs, setLogs] = useState<ContainerLogLine[]>([]);
  const [logsLoading, setLogsLoading] = useState(false);
  const [logsError, setLogsError] = useState<string | null>(null);

  const loadLogs = useCallback(async (containerId: string) => {
    setLogsLoading(true);
    setLogsError(null);
    try {
      const { logs: lines } = await api.containerLogs(containerId, 300);
      setLogs(lines);
    } catch (err) {
      setLogsError(err instanceof Error ? err.message : 'Lecture des journaux impossible');
      setLogs([]);
    } finally {
      setLogsLoading(false);
    }
  }, []);

  // Recharge à l'ouverture d'un conteneur et à chaque changement de cible.
  useEffect(() => {
    if (activeContainerId) void loadLogs(activeContainerId);
    else setLogs([]);
  }, [activeContainerId, loadLogs]);

  /**
   * Répartition par identité. Le décompte suit la liste déclarée côté serveur,
   * pas une énumération écrite ici : une identité ajoutée à
   * `config/owners.yaml` apparaît d'elle-même, avec sa carte et son filtre.
   */
  const ownerStats = useMemo(() => {
    const counts: Record<string, { containers: number; stacks: number }> = {};
    owners.forEach((o) => { counts[o.id] = { containers: 0, stacks: 0 }; });

    const bucket = (id: Owner) => (counts[id] ??= { containers: 0, stacks: 0 });

    let totalContainers = 0;
    stacks.forEach((stack) => {
      bucket(stack.owner).stacks++;
      stack.containers.forEach((c) => {
        bucket(c.owner || stack.owner).containers++;
        totalContainers++;
      });
    });

    return { counts, totalContainers };
  }, [stacks, owners]);

  const handleActionClick = (
    container: DockerContainer,
    action: 'start' | 'unpause' | 'stop' | 'restart' | 'delete'
  ) => {
    // Démarrer ou reprendre ne coupe rien : direct. Arrêter, redémarrer et supprimer
    // interrompent un service — potentiellement celui de l'autre administrateur —
    // et passent par une confirmation qui le signale.
    if (action === 'start' || action === 'unpause') {
      void store.dockerContainerAction(container.id, action);
      return;
    }
    setPendingAction({ container, action });
  };

  const handleStackActionClick = (stack: DockerStack, action: 'down' | 'restart') => {
    setPendingAction({ stack, action });
  };

  return (
    <div className="space-y-6 animate-in fade-in duration-200">
      {/* Page Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pb-4 border-b border-wopr-border">
        <div>
          <h1 className="text-xl font-bold tracking-tight text-wopr-text flex items-center gap-2.5">
            <Boxes className="w-5 h-5 text-wopr-accent" />
            <span>Conteneurs Docker & Stacks Compose</span>
          </h1>
          <p className="text-xs text-wopr-textMuted mt-1">
            Démon Docker partagé avec runtime NVIDIA · Répartition par propriétaire
            ({owners.map((o) => o.label).join(' / ')})
          </p>
        </div>

        {/* Status badges */}
        <div className="flex items-center gap-2 font-mono text-xs">
          <span className="px-2.5 py-1 rounded-md bg-emerald-500/15 text-emerald-400 border border-emerald-500/30">
            {summary.running} / {summary.total} en cours
          </span>
          {summary.unhealthy > 0 && (
            <span className="px-2.5 py-1 rounded-md bg-rose-500/15 text-rose-400 border border-rose-500/30 animate-pulse font-bold">
              {summary.unhealthy} dégradé
            </span>
          )}
        </div>
      </div>

      {/* Une carte par identité déclarée : cliquer filtre la liste. */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        {owners.map((owner) => {
          const tone = ownerTone(owner.tone);
          const stats = ownerStats.counts[owner.id] ?? { containers: 0, stacks: 0 };
          const selected = selectedOwnerFilter === owner.id;
          const Icon = owner.id === SHARED_OWNER ? Users : User;

          return (
            <button
              key={owner.id}
              onClick={() => setSelectedOwnerFilter(selected ? 'all' : owner.id)}
              title={owner.description}
              className={`text-left p-3.5 rounded-xl border transition-all cursor-pointer ${
                selected ? tone.cardSelected : tone.cardIdle
              }`}
            >
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <div className={`w-6 h-6 rounded-lg flex items-center justify-center ${tone.bubble}`}>
                    <Icon className="w-3.5 h-3.5" />
                  </div>
                  <span className={`font-mono font-bold text-xs ${tone.text}`}>{owner.label}</span>
                </div>
                <span className="text-[11px] font-mono text-wopr-textMuted">
                  {stats.stacks} stack{stats.stacks > 1 ? 's' : ''}
                </span>
              </div>
              <div className="mt-2.5 flex items-baseline gap-1.5">
                <span className="text-2xl font-mono font-bold text-wopr-text">{stats.containers}</span>
                <span className="text-xs text-wopr-textMuted font-sans">conteneurs</span>
              </div>
              <div className="text-[11px] text-wopr-textSubtle mt-1 flex items-center gap-1.5 truncate">
                <span>{owner.blurb}</span>
                {selected && (
                  <span className={`text-[10px] font-mono font-semibold ml-auto ${tone.text}`}>
                    Filtre actif
                  </span>
                )}
              </div>
            </button>
          );
        })}
      </div>

      {/* Filter and Search toolbar */}
      <div className="flex flex-col sm:flex-row items-center justify-between gap-3 bg-wopr-surface border border-wopr-border rounded-xl p-3">
        <div className="relative w-full sm:w-80">
          <Search className="w-4 h-4 text-wopr-textMuted absolute left-3 top-2.5" />
          <input
            type="text"
            placeholder="Filtrer conteneur, service, image..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="w-full bg-[#0d1117] border border-wopr-border rounded-lg pl-9 pr-3 py-1.5 text-xs text-wopr-text placeholder:text-wopr-textSubtle focus:outline-none focus:border-wopr-accent"
          />
        </div>

        {/* Filter buttons with counts */}
        <div className="flex items-center gap-1.5 w-full sm:w-auto flex-wrap">
          <span className="text-xs text-wopr-textMuted mr-1">Filtrer :</span>

          <button
            onClick={() => setSelectedOwnerFilter('all')}
            className={`px-2.5 py-1 rounded-lg text-xs font-mono transition-colors flex items-center gap-1.5 ${
              selectedOwnerFilter === 'all'
                ? 'bg-wopr-accent text-white font-semibold shadow-sm'
                : 'bg-wopr-surface2 text-wopr-textMuted hover:text-wopr-text hover:bg-white/5'
            }`}
          >
            <span>Tous</span>
            <span className="text-[10px] opacity-75">({ownerStats.totalContainers})</span>
          </button>

          {owners.map((owner) => {
            const tone = ownerTone(owner.tone);
            const selected = selectedOwnerFilter === owner.id;
            const Icon = owner.id === SHARED_OWNER ? Users : User;

            return (
              <button
                key={owner.id}
                onClick={() => setSelectedOwnerFilter(owner.id)}
                title={owner.description}
                className={`px-2.5 py-1 rounded-lg text-xs font-mono transition-colors flex items-center gap-1.5 ${
                  selected ? tone.chipSelected : tone.chipIdle
                }`}
              >
                <Icon className="w-3 h-3" />
                <span>{owner.label}</span>
                <span className="text-[10px] opacity-80">
                  ({ownerStats.counts[owner.id]?.containers ?? 0})
                </span>
              </button>
            );
          })}
        </div>
      </div>

      {/* Stacks & Containers */}
      <div className="space-y-6">
        {stacks.map((stack) => {
          // Filter containers by owner and search term
          const filteredContainers = stack.containers.filter((c) => {
            const containerOwner = c.owner || stack.owner;
            const matchesOwner = selectedOwnerFilter === 'all' || containerOwner === selectedOwnerFilter;
            const matchesSearch =
              !searchQuery ||
              c.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
              c.service.toLowerCase().includes(searchQuery.toLowerCase()) ||
              c.image.toLowerCase().includes(searchQuery.toLowerCase());
            return matchesOwner && matchesSearch;
          });

          // Don't render stack if no containers match
          if (filteredContainers.length === 0) {
            return null;
          }

          return (
            <div
              key={stack.name}
              className="bg-wopr-surface border border-wopr-border rounded-xl overflow-hidden shadow-sm"
            >
              {/* Stack Header */}
              <div className="p-4 bg-[#161b22]/70 border-b border-wopr-border flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                <div className="flex items-center gap-3">
                  <div className="flex items-center gap-2">
                    <span className="font-mono font-bold text-base text-wopr-text">
                      {stack.name}
                    </span>
                    <span className="text-xs text-wopr-textSubtle">
                      ({filteredContainers.length} conteneur{filteredContainers.length > 1 ? 's' : ''})
                    </span>
                  </div>

                  <OwnerBadge owner={stack.owner} />

                  {stack.outOfScope && (
                    <span className="px-2 py-0.5 rounded text-[10px] font-semibold bg-purple-500/15 text-purple-300 border border-purple-500/30 flex items-center gap-1">
                      <Shield className="w-3 h-3" />
                      Géré par agent JARVIS (Hors périmètre)
                    </span>
                  )}
                </div>

                {/* Stack Actions */}
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => setShowComposeModal(stack)}
                    className="p-1.5 rounded-lg bg-white/5 hover:bg-white/10 text-wopr-textMuted hover:text-wopr-text border border-wopr-border text-xs flex items-center gap-1 transition-colors cursor-pointer"
                    title="Voir le compose.yaml"
                  >
                    <FileCode className="w-3.5 h-3.5" />
                    <span>compose.yaml</span>
                  </button>

                  {!stack.outOfScope && (
                    <>
                      <button
                        onClick={() => handleStackActionClick(stack, 'restart')}
                        className="px-2.5 py-1 rounded-lg bg-white/5 hover:bg-white/10 text-wopr-text border border-wopr-border text-xs font-medium flex items-center gap-1 transition-colors cursor-pointer"
                      >
                        <RotateCcw className="w-3 h-3" />
                        <span>Redémarrer stack</span>
                      </button>
                      {!stack.containsSelf && (
                        <button
                          onClick={() => handleStackActionClick(stack, 'down')}
                          className="px-2.5 py-1 rounded-lg bg-rose-500/10 hover:bg-rose-500/20 text-rose-300 border border-rose-500/30 text-xs font-medium flex items-center gap-1 transition-colors cursor-pointer"
                        >
                          <Square className="w-3 h-3" />
                          <span>Arrêter (down)</span>
                        </button>
                      )}
                    </>
                  )}
                </div>
              </div>

              {/* Containers Table */}
              <div className="overflow-x-auto">
                <table className="w-full text-left text-xs">
                  <thead className="border-b border-wopr-border text-wopr-textMuted uppercase font-mono text-[11px] bg-[#0d1117]/50">
                    <tr>
                      <th className="py-2.5 px-4 font-medium">Conteneur</th>
                      <th className="py-2.5 px-4 font-medium">Propriétaire</th>
                      <th className="py-2.5 px-4 font-medium">Service / Image</th>
                      <th className="py-2.5 px-4 font-medium">Statut & Santé</th>
                      <th className="py-2.5 px-4 font-medium">CPU %</th>
                      <th className="py-2.5 px-4 font-medium">Mémoire (RSS)</th>
                      <th className="py-2.5 px-4 font-medium">Ports</th>
                      <th className="py-2.5 px-4 font-medium text-right">Actions</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-wopr-border/40 font-mono">
                    {filteredContainers.map((container) => {
                      const containerOwner = container.owner || stack.owner;

                      return (
                        <tr
                          key={container.id}
                          className="hover:bg-white/5 transition-colors cursor-pointer"
                          onClick={() =>
                            setActiveContainerDetail({
                              container,
                              stackName: stack.name,
                              stackOwner: stack.owner,
                            })
                          }
                        >
                          {/* Container Name & GPU Badge */}
                          <td className="py-3 px-4 font-semibold text-wopr-text font-sans">
                            <div className="flex items-center gap-2">
                              <span className="font-bold">{container.name}</span>
                              {container.usesGpu && container.usesGpu.length > 0 && (
                                <span className="px-1.5 py-0.2 rounded bg-purple-500/20 text-purple-300 border border-purple-500/30 text-[9px] font-bold">
                                  GPU {container.usesGpu.join(',')}
                                </span>
                              )}
                            </div>
                          </td>

                          {/* Owner Badge */}
                          <td className="py-3 px-4">
                            <OwnerBadge owner={containerOwner} size="sm" />
                          </td>

                          {/* Service / Image */}
                          <td className="py-3 px-4 text-wopr-textMuted">
                            <div className="text-wopr-text font-sans">{container.service}</div>
                            <div className="text-[10px] text-wopr-textSubtle truncate max-w-[180px]">
                              {container.image}
                            </div>
                          </td>

                          {/* Status & Health */}
                          <td className="py-3 px-4">
                            <div className="flex items-center gap-2">
                              <StatusBadge status={container.state} />
                              {/* Le healthcheck n'était pas affiché : un conteneur
                                  « unhealthy » apparaissait en vert. */}
                              {container.health === 'unhealthy' && (
                                <span className="px-1.5 py-0.5 rounded text-[10px] font-bold bg-rose-500/15 text-rose-400 border border-rose-500/30">
                                  healthcheck KO
                                </span>
                              )}
                              {container.health === 'starting' && (
                                <span className="text-[10px] text-amber-400">démarrage…</span>
                              )}
                              {container.restarts > 0 && (
                                <span
                                  className={`text-[10px] font-bold ${container.restarts >= 3 ? 'text-rose-400' : 'text-amber-400'}`}
                                  title="Redémarrages comptés par Docker depuis la création du conteneur"
                                >
                                  ({container.restarts} redémarrage{container.restarts > 1 ? 's' : ''})
                                </span>
                              )}
                            </div>
                          </td>

                          {/* CPU % */}
                          <td className="py-3 px-4">
                            <div className="flex items-center gap-2">
                              <span className="font-bold text-wopr-text tabular">
                                <Measure value={container.cpuPct} unit="%" digits={1}
                                  unavailableHint="En attente du premier échantillon de statistiques" />
                              </span>
                              {containerCpuHistory[container.id]?.length > 1 && (
                                <Sparkline
                                  data={containerCpuHistory[container.id]}
                                  color="#4c9ffe"
                                  width={45}
                                  height={16}
                                />
                              )}
                            </div>
                          </td>

                          {/* Memory */}
                          <td className="py-3 px-4 text-wopr-text font-medium">
                            <Measure value={container.memMiB} unit="Mio"
                              unavailableHint={container.state === 'running' ? 'En attente du premier échantillon' : 'Conteneur arrêté'} />
                            {container.memLimitMiB && container.memMiB !== null && (
                              <span className="text-wopr-textSubtle text-[10px] ml-1">
                                / {container.memLimitMiB} Mio
                              </span>
                            )}
                          </td>

                          {/* Ports */}
                          <td className="py-3 px-4 text-wopr-accent text-[11px]">
                            {/* Docker publie souvent la même liaison en IPv4 et IPv6. */}
                            {container.ports.length > 0 ? [...new Set(container.ports)].join(', ') : '—'}
                          </td>

                          {/* Actions */}
                          <td className="py-3 px-4 text-right" onClick={(e) => e.stopPropagation()}>
                            {!stack.outOfScope ? (
                              <div className="flex items-center justify-end gap-1.5">
                                {container.isSelf ? null : container.state === 'paused' ? (
                                  <button
                                    onClick={() => handleActionClick(container, 'unpause')}
                                    className="p-1 rounded text-wopr-textMuted hover:text-emerald-400 hover:bg-white/5 transition-colors cursor-pointer"
                                    title="Reprendre le conteneur (unpause)"
                                  >
                                    <Play className="w-3.5 h-3.5" />
                                  </button>
                                ) : container.state === 'running' || container.state === 'restarting' ? (
                                  <button
                                    onClick={() => handleActionClick(container, 'stop')}
                                    className="p-1 rounded text-wopr-textMuted hover:text-amber-400 hover:bg-white/5 transition-colors cursor-pointer"
                                    title="Arrêter le conteneur"
                                  >
                                    <Square className="w-3.5 h-3.5" />
                                  </button>
                                ) : (
                                  <button
                                    onClick={() => handleActionClick(container, 'start')}
                                    className="p-1 rounded text-wopr-textMuted hover:text-emerald-400 hover:bg-white/5 transition-colors cursor-pointer"
                                    title="Démarrer le conteneur"
                                  >
                                    <Play className="w-3.5 h-3.5" />
                                  </button>
                                )}

                                <button
                                  onClick={() => handleActionClick(container, 'restart')}
                                  disabled={container.state === 'paused'}
                                  className="disabled:opacity-30 disabled:cursor-not-allowed p-1 rounded text-wopr-textMuted hover:text-wopr-text hover:bg-white/5 transition-colors cursor-pointer"
                                  title={container.isSelf ? 'Redémarrer le dashboard (reconnexion automatique)' : 'Redémarrer'}
                                >
                                  <RotateCcw className="w-3.5 h-3.5" />
                                </button>

                                <button
                                  onClick={() =>
                                    setActiveContainerDetail({
                                      container,
                                      stackName: stack.name,
                                      stackOwner: stack.owner,
                                    })
                                  }
                                  className="p-1 rounded text-wopr-textMuted hover:text-wopr-accent hover:bg-white/5 transition-colors cursor-pointer"
                                  title="Voir les détails, logs et métriques"
                                >
                                  <FileText className="w-3.5 h-3.5" />
                                </button>

                                {!container.isSelf && (
                                  <button
                                    onClick={() => handleActionClick(container, 'delete')}
                                    className="p-1 rounded text-wopr-textMuted hover:text-rose-400 hover:bg-white/5 transition-colors cursor-pointer"
                                    title="Supprimer le conteneur"
                                  >
                                    <Trash2 className="w-3.5 h-3.5" />
                                  </button>
                                )}
                              </div>
                            ) : (
                              <span className="text-[10px] text-wopr-textSubtle italic">Protégé</span>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          );
        })}
      </div>

      {/* CONTAINER DETAIL DRAWER */}
      {activeContainerDetail && (
        <div className="fixed inset-0 z-50 flex justify-end bg-black/60 backdrop-blur-xs animate-in fade-in">
          <div className="w-full max-w-xl bg-[#161b22] border-l border-wopr-border h-full shadow-2xl flex flex-col animate-in slide-in-from-right">
            {/* Drawer Header */}
            <div className="p-4 border-b border-wopr-border flex items-center justify-between">
              <div>
                <div className="flex items-center gap-2 flex-wrap">
                  <h3 className="font-bold text-base text-wopr-text font-mono">
                    {activeContainerDetail.container.name}
                  </h3>
                  <StatusBadge status={activeContainerDetail.container.state} />
                  <OwnerBadge
                    owner={
                      activeContainerDetail.container.owner || activeContainerDetail.stackOwner
                    }
                    size="sm"
                  />
                </div>
                <div className="text-xs font-mono text-wopr-textMuted mt-0.5">
                  ID: {activeContainerDetail.container.id} · Image:{' '}
                  {activeContainerDetail.container.image}
                </div>
              </div>

              <button
                onClick={() => setActiveContainerDetail(null)}
                className="p-1.5 rounded-lg text-wopr-textMuted hover:text-wopr-text hover:bg-white/5 cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {/* Tabs */}
            <div className="flex items-center gap-2 px-4 border-b border-wopr-border bg-[#0d1117]/50 text-xs font-medium">
              {(['logs', 'stats', 'config', 'gpu'] as const).map((tab) => (
                <button
                  key={tab}
                  onClick={() => setActiveDrawerTab(tab)}
                  className={`py-2.5 px-3 border-b-2 font-mono uppercase transition-colors cursor-pointer ${
                    activeDrawerTab === tab
                      ? 'border-wopr-accent text-wopr-accent font-bold'
                      : 'border-transparent text-wopr-textMuted hover:text-wopr-text'
                  }`}
                >
                  {tab === 'logs'
                    ? 'Logs (Direct)'
                    : tab === 'stats'
                    ? 'Métriques'
                    : tab === 'config'
                    ? 'Configuration'
                    : 'GPU Alloc.'}
                </button>
              ))}
            </div>

            {/* Tab content */}
            <div className="flex-1 overflow-y-auto p-4 font-mono text-xs">
              {activeDrawerTab === 'logs' && (
                <div className="space-y-2">
                  <div className="flex items-center justify-between pb-2 border-b border-wopr-border/50 text-wopr-textMuted text-[11px]">
                    <span>stdout / stderr du conteneur</span>
                    <button
                      onClick={() => void loadLogs(activeContainerDetail.container.id)}
                      className="flex items-center gap-1 text-wopr-accent hover:underline"
                    >
                      <RefreshCw className={`w-3 h-3 ${logsLoading ? 'animate-spin' : ''}`} />
                      {logsLoading ? 'Lecture…' : 'Rafraîchir'}
                    </button>
                  </div>

                  <div className="bg-[#0d1117] p-3 rounded-xl border border-wopr-border text-[11px] leading-relaxed font-mono space-y-1 text-wopr-text max-h-[500px] overflow-y-auto">
                    {logsError ? (
                      <div className="text-rose-400">{logsError}</div>
                    ) : logs.length > 0 ? (
                      logs.map((log, lidx) => (
                        <div key={lidx} className="flex items-start gap-2">
                          <span className="text-wopr-textSubtle shrink-0">[{log.time}]</span>
                          <span
                            className={
                              log.level === 'err'
                                ? 'text-rose-400 font-bold'
                                : log.level === 'warn'
                                ? 'text-amber-400'
                                : 'text-wopr-text'
                            }
                          >
                            {log.message}
                          </span>
                        </div>
                      ))
                    ) : (
                      <div className="text-wopr-textMuted">
                        {logsLoading ? 'Lecture des journaux…' : 'Aucune ligne de journal.'}
                      </div>
                    )}
                  </div>
                </div>
              )}

              {activeDrawerTab === 'stats' && (
                <div className="space-y-4">
                  <div className="grid grid-cols-2 gap-3">
                    <div className="p-3 rounded-lg bg-[#0d1117] border border-wopr-border">
                      <span className="text-[10px] text-wopr-textMuted uppercase">Utilisation CPU</span>
                      <div className="text-xl font-bold text-wopr-text mt-1">
                        <Measure value={activeContainerDetail.container.cpuPct}
                          unit="%" digits={1} />
                      </div>
                    </div>
                    <div className="p-3 rounded-lg bg-[#0d1117] border border-wopr-border">
                      <span className="text-[10px] text-wopr-textMuted uppercase">Mémoire vive</span>
                      <div className="text-xl font-bold text-wopr-text mt-1">
                        <Measure value={activeContainerDetail.container.memMiB} unit="Mio" />
                        {activeContainerDetail.container.memLimitMiB ? (
                          <span className="text-xs text-wopr-textMuted font-normal">
                            {' '}/ {activeContainerDetail.container.memLimitMiB} Mio
                          </span>
                        ) : null}
                      </div>
                    </div>
                  </div>

                  <div className="p-3 rounded-lg bg-[#0d1117] border border-wopr-border space-y-2">
                    <span className="text-[11px] font-semibold text-wopr-text uppercase">
                      Historique instantané CPU
                    </span>
                    {(containerCpuHistory[activeContainerDetail.container.id]?.length ?? 0) > 1 ? (
                      <Sparkline
                        data={containerCpuHistory[activeContainerDetail.container.id]}
                        color="#4c9ffe"
                        width={300}
                        height={40}
                      />
                    ) : (
                      <div className="text-wopr-textMuted text-xs">
                        Mesures en cours d'accumulation depuis l'ouverture de la page.
                      </div>
                    )}
                  </div>
                </div>
              )}

              {activeDrawerTab === 'config' && (
                <div className="space-y-4">
                  {/* Ownership info block */}
                  <div className="p-3.5 rounded-xl bg-[#0d1117] border border-wopr-border flex items-center justify-between">
                    <div>
                      <span className="text-[10px] text-wopr-textMuted uppercase block">
                        Propriétaire & Attribution
                      </span>
                      <div className="text-xs font-semibold text-wopr-text mt-0.5">
                        Stack :{' '}
                        <span className="font-mono text-wopr-accent">
                          {activeContainerDetail.stackName}
                        </span>
                      </div>
                    </div>
                    <OwnerBadge
                      owner={
                        activeContainerDetail.container.owner || activeContainerDetail.stackOwner
                      }
                    />
                  </div>

                  <div>
                    <span className="text-[11px] font-semibold text-wopr-text uppercase block mb-2">
                      Variables d'environnement :
                    </span>
                    <div className="space-y-1.5">
                      {activeContainerDetail.container.envKeys.length > 0 ? (
                        <>
                          <p className="text-[11px] text-wopr-textMuted mb-2 leading-relaxed">
                            Seuls les noms sont affichés. Les valeurs ne quittent jamais
                            le serveur — plusieurs stacks de cette machine y stockent des
                            jetons et des mots de passe.
                          </p>
                          {activeContainerDetail.container.envKeys.map((k) => (
                            <div
                              key={k}
                              className="p-2 rounded bg-[#0d1117] border border-wopr-border"
                            >
                              <span className="text-wopr-accent font-bold">{k}</span>
                            </div>
                          ))}
                        </>
                      ) : (
                        <div className="text-wopr-textMuted text-xs">
                          Aucune variable d'environnement.
                        </div>
                      )}
                    </div>
                  </div>

                  {activeContainerDetail.container.volumes && (
                    <div>
                      <span className="text-[11px] font-semibold text-wopr-text uppercase block mb-2">
                        Montages & Volumes :
                      </span>
                      <div className="space-y-1">
                        {activeContainerDetail.container.volumes.map((vol, vidx) => (
                          <div
                            key={vidx}
                            className="p-2 rounded bg-[#0d1117] border border-wopr-border text-wopr-text"
                          >
                            {vol}
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              )}

              {activeDrawerTab === 'gpu' && (
                <div className="space-y-3">
                  <span className="text-[11px] font-semibold text-wopr-text uppercase block mb-2">
                    Accès direct GPU NVIDIA :
                  </span>
                  {activeContainerDetail.container.usesGpu &&
                  activeContainerDetail.container.usesGpu.length > 0 ? (
                    <div className="p-4 rounded-xl bg-purple-500/10 border border-purple-500/30 text-purple-300 space-y-2">
                      <div className="font-bold text-sm">
                        Accès matériel GPU {activeContainerDetail.container.usesGpu.join(' & ')} actif
                      </div>
                      <p className="text-xs text-wopr-textMuted leading-relaxed">
                        Ce conteneur utilise le runtime NVIDIA (nvidia-container-toolkit) avec
                        pass-through direct des bibliothèques CUDA et des cœurs Tensor.
                      </p>
                    </div>
                  ) : (
                    <div className="p-4 rounded-xl bg-[#0d1117] border border-wopr-border text-wopr-textMuted text-xs">
                      Ce conteneur n'a aucune réservation matérielle GPU.
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Compose YAML Modal */}
      {showComposeModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/75 backdrop-blur-sm animate-in fade-in">
          <div className="w-full max-w-lg bg-[#161b22] border border-wopr-border rounded-xl p-5 shadow-2xl space-y-4">
            <div className="flex items-center justify-between pb-2 border-b border-wopr-border">
              <div className="flex items-center gap-2">
                <h3 className="text-sm font-semibold text-wopr-text font-mono">
                  {showComposeModal.name} — fichiers compose
                </h3>
                <OwnerBadge owner={showComposeModal.owner} size="sm" />
              </div>
              <button
                onClick={() => setShowComposeModal(null)}
                className="text-wopr-textMuted hover:text-wopr-text cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {showComposeModal.configFiles ? (
              <div className="space-y-2">
                <p className="text-[11px] text-wopr-textMuted leading-relaxed">
                  Chemins déclarés par Compose sur l'hôte. Le dashboard ne lit pas le
                  contenu de ces fichiers : ils peuvent contenir des secrets, et les
                  afficher ici reviendrait à les exposer à toute personne connectée.
                </p>
                {showComposeModal.configFiles.split(',').map((path) => (
                  <pre
                    key={path}
                    className="bg-[#0d1117] p-2.5 rounded-lg border border-wopr-border text-xs text-wopr-accent font-mono overflow-x-auto"
                  >
                    {path.trim()}
                  </pre>
                ))}
                {showComposeModal.workingDir && (
                  <div className="text-[11px] font-mono text-wopr-textMuted">
                    Répertoire de projet : {showComposeModal.workingDir}
                  </div>
                )}
              </div>
            ) : (
              <p className="text-xs text-wopr-textMuted leading-relaxed">
                Cette stack n'a pas été lancée par Compose, ou ses étiquettes ont été
                perdues. Les actions de stack se rabattront sur une action conteneur
                par conteneur.
              </p>
            )}

            <div className="flex justify-end pt-2 border-t border-wopr-border">
              <button
                onClick={() => setShowComposeModal(null)}
                className="px-4 py-1.5 rounded-lg bg-wopr-surface2 hover:bg-wopr-surface3 text-wopr-text text-xs cursor-pointer"
              >
                Fermer
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Confirmation des actions qui interrompent un service */}
      {pendingAction && (() => {
        const targetName = pendingAction.container?.name || pendingAction.stack?.name || '';
        const isSelf = pendingAction.container?.isSelf || pendingAction.stack?.containsSelf;
        const destructive = pendingAction.action === 'delete' || pendingAction.action === 'down';
        const explanation: Record<typeof pendingAction.action, string> = {
          start: 'Le conteneur va être démarré.',
          stop: "Le conteneur va être arrêté. Il ne redémarrera pas seul, même avec une politique « unless-stopped ».",
          restart: isSelf
            ? 'Le dashboard va redémarrer : la page perdra la liaison quelques secondes puis se reconnectera.'
            : 'Le service sera indisponible le temps du redémarrage.',
          delete: 'Le conteneur sera supprimé (arrêt forcé s\'il tourne). Ses volumes nommés sont conservés ; tout ce qui n\'est que dans le conteneur est perdu.',
          down: '`docker compose down` : tous les conteneurs de la stack sont arrêtés et supprimés, ainsi que ses réseaux.',
        };
        return (
          <ConfirmDialog
            isOpen
            title={`${pendingAction.stack ? 'Stack' : 'Conteneur'} ${targetName} — ${
              { start: 'démarrer', stop: 'arrêter', restart: 'redémarrer', delete: 'supprimer', down: 'arrêter (down)' }[pendingAction.action]
            }`}
            isDestructive={destructive || pendingAction.action === 'stop'}
            requireTextMatch={destructive ? targetName : undefined}
            otherAdminWarning={otherAdminWarningFor(pendingAction, ownerIdentity, owners)}
            description={<p>{explanation[pendingAction.action]}</p>}
            confirmText="Confirmer l'opération"
            onConfirm={() => {
              if (pendingAction.container) {
                void store.dockerContainerAction(pendingAction.container.id, pendingAction.action);
              } else if (pendingAction.stack) {
                void store.dockerStackAction(pendingAction.stack.name, pendingAction.action);
              }
              setPendingAction(null);
            }}
            onCancel={() => setPendingAction(null)}
          />
        );
      })()}
    </div>
  );
};
