/**
 * État applicatif.
 *
 * Trois changements de fond par rapport à la version maquette :
 *
 * 1. **Plus de simulation.** `tickSimulation` et `triggerScenario` généraient des
 *    variations et de faux incidents ; ils ont disparu. Tout vient du serveur.
 * 2. **Plus d'effet optimiste.** Une action met à jour l'état seulement après que
 *    le serveur a confirmé. En cas d'échec, un toast dit ce qui s'est passé.
 * 3. **Fraîcheur explicite.** Si le flux temps réel se coupe, `stale` passe à vrai
 *    et l'interface le signale, au lieu de laisser croire que les chiffres affichés
 *    sont ceux de l'instant.
 */

import { api, ApiError, onUnauthorized } from './api';
import type { PendingRestartItem } from './settingsTypes';
import {
  emptyCpuRam, emptyDocker, emptyGpu, emptyModes, emptyOverview, emptyOwners,
  emptyProcesses, emptyStorageNetwork, emptySystem, emptyThermal,
} from './emptyState';
import type {
  AdminUser, AuditPage, CpuRamData, DockerData, GpuData, ModesData, Owner,
  OwnerInfo, OverviewData, ProcessesData, SpeedtestResult, StorageNetworkData,
  SystemData, ThermalData,
} from './types';

export interface ToastItem {
  id: string;
  type: 'success' | 'warn' | 'err' | 'info';
  title: string;
  message?: string;
  timestamp: number;
}

export interface AppState {
  overview: OverviewData;
  cpuRam: CpuRamData;
  gpu: GpuData;
  thermal: ThermalData;
  storageNetwork: StorageNetworkData;
  modes: ModesData;
  docker: DockerData;
  processes: ProcessesData;
  system: SystemData;
  audit: AuditPage;

  /** Utilisateur de la session en cours. `null` = non connecté. */
  currentUser: AdminUser | null;
  /** Propriétaire auquel correspond la personne connectée (cf. StatusData). */
  ownerIdentity: Owner;
  /** Identités déclarées côté serveur, dans l'ordre de `config/owners.yaml`. */
  owners: OwnerInfo[];
  authChecked: boolean;
  /** Vrai dès que la première photographie complète est arrivée. */
  ready: boolean;
  /** Le flux temps réel est-il établi ? */
  connected: boolean;
  /** Les données affichées datent-elles de plus de quelques secondes ? */
  stale: boolean;
  lastUpdate: number | null;

  /**
   * Historique court de la charge CPU par conteneur, construit côté client à
   * partir des photographies reçues. Le démon Docker ne conserve pas d'historique ;
   * ces points sont donc de vraies mesures accumulées depuis l'ouverture de la page.
   */
  containerCpuHistory: Record<string, number[]>;

  theme: 'dark' | 'light';
  toasts: ToastItem[];
  /** Action mutante en cours (identifiant libre), pour désactiver les boutons. */
  pending: Record<string, boolean>;

  /** Dernier test de débit lancé depuis le dashboard. `null` = aucun encore. */
  speedtest: SpeedtestResult | null;

  /**
   * Réglages écrits dans le `.env` mais pas encore pris par le conteneur.
   * Affiché en bandeau depuis n'importe quelle vue : un réglage enregistré qui
   * ne s'applique pas doit se voir, pas attendre qu'on retourne dans Paramètres.
   */
  pendingRestart: PendingRestartItem[];
}

const STALE_AFTER_MS = 12_000;

class WoprStore {
  private state: AppState = {
    overview: emptyOverview,
    cpuRam: emptyCpuRam,
    gpu: emptyGpu,
    thermal: emptyThermal,
    storageNetwork: emptyStorageNetwork,
    modes: emptyModes,
    docker: emptyDocker,
    processes: emptyProcesses,
    system: emptySystem,
    audit: { total: 0, items: [], actors: [] },
    containerCpuHistory: {},

    currentUser: null,
    ownerIdentity: 'shared',
    owners: emptyOwners,
    authChecked: false,
    ready: false,
    connected: false,
    stale: false,
    lastUpdate: null,

    theme: (localStorage.getItem('wopr-theme') as 'dark' | 'light') || 'dark',
    toasts: [],
    pending: {},
    speedtest: null,
    pendingRestart: [],
  };

  private listeners = new Set<() => void>();
  private staleTimer: number | null = null;

  constructor() {
    onUnauthorized(() => this.handleSessionLost());
  }

  getState(): AppState {
    return this.state;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Remplace l'état par un nouvel objet : `useSyncExternalStore` compare par référence. */
  private set(patch: Partial<AppState>): void {
    this.state = { ...this.state, ...patch };
    this.listeners.forEach((l) => l());
  }

  // ------------------------------------------------------------------ session

  async checkSession(): Promise<boolean> {
    try {
      const status = await api.status();
      this.set({
        currentUser: status.user,
        ownerIdentity: status.ownerIdentity,
        // Liste vide = serveur plus ancien que ce frontend : on garde le repli
        // plutôt que de se retrouver sans aucune identité à afficher.
        owners: status.owners?.length ? status.owners : emptyOwners,
        authChecked: true,
      });
      if (status.authenticated) void this.refreshPendingRestart();
      return status.authenticated;
    } catch {
      this.set({ authChecked: true });
      return false;
    }
  }

  /** Relit la liste des réglages « à froid » en attente de recréation. */
  async refreshPendingRestart(): Promise<void> {
    try {
      const settings = await api.settings();
      this.set({ pendingRestart: settings.pendingRestart });
    } catch {
      // Pas de bandeau plutôt qu'un bandeau faux : on ne sait rien, on se tait.
      this.set({ pendingRestart: [] });
    }
  }

  setPendingRestart(items: PendingRestartItem[]): void {
    this.set({ pendingRestart: items });
  }

  async login(username: string, password: string): Promise<void> {
    await api.login(username, password);
    // On relit le statut : il porte aussi l'identité de gouvernance.
    await this.checkSession();
  }

  async logout(): Promise<void> {
    try {
      await api.logout();
    } finally {
      this.handleSessionLost();
    }
  }

  private handleSessionLost(): void {
    this.set({
      currentUser: null,
      ready: false,
      connected: false,
      overview: emptyOverview,
      cpuRam: emptyCpuRam,
      gpu: emptyGpu,
      thermal: emptyThermal,
      storageNetwork: emptyStorageNetwork,
      modes: emptyModes,
      docker: emptyDocker,
      processes: emptyProcesses,
      system: emptySystem,
      containerCpuHistory: {},
    });
  }

  // ------------------------------------------------------------ flux temps réel

  /** Appelé par `live.ts` à chaque photographie reçue. */
  applySnapshot(payload: Partial<AppState>): void {
    const patch: Partial<AppState> = { ...payload };
    if (payload.docker) {
      patch.containerCpuHistory = this.accumulateCpuHistory(payload.docker);
    }
    this.set({ ...patch, lastUpdate: Date.now(), stale: false });
    this.armStaleTimer();
  }

  private static readonly CPU_HISTORY_POINTS = 24;

  /** Ajoute le point courant et oublie les conteneurs disparus. */
  private accumulateCpuHistory(docker: DockerData): Record<string, number[]> {
    const next: Record<string, number[]> = {};
    for (const stack of docker.stacks) {
      for (const container of stack.containers) {
        if (container.cpuPct === null) continue;
        const previous = this.state.containerCpuHistory[container.id] ?? [];
        next[container.id] = [...previous, container.cpuPct].slice(
          -WoprStore.CPU_HISTORY_POINTS,
        );
      }
    }
    return next;
  }

  markReady(): void {
    if (!this.state.ready) this.set({ ready: true });
  }

  setConnected(connected: boolean): void {
    if (this.state.connected !== connected) this.set({ connected });
    if (connected) this.armStaleTimer();
  }

  private armStaleTimer(): void {
    if (this.staleTimer !== null) window.clearTimeout(this.staleTimer);
    this.staleTimer = window.setTimeout(() => {
      // Aucune donnée depuis plus de 12 s : on le dit plutôt que de laisser
      // l'utilisateur croire que l'affichage est à jour.
      this.set({ stale: true });
    }, STALE_AFTER_MS);
  }

  // ------------------------------------------------------------------- toasts

  addToast(toast: Omit<ToastItem, 'id' | 'timestamp'>): void {
    const item: ToastItem = {
      ...toast,
      id: `t${Date.now()}${Math.random().toString(16).slice(2, 6)}`,
      timestamp: Date.now(),
    };
    this.set({ toasts: [...this.state.toasts, item] });
    const ttl = toast.type === 'err' ? 9000 : 5000;
    window.setTimeout(() => this.removeToast(item.id), ttl);
  }

  removeToast(id: string): void {
    this.set({ toasts: this.state.toasts.filter((t) => t.id !== id) });
  }

  toggleTheme(): void {
    const theme = this.state.theme === 'dark' ? 'light' : 'dark';
    localStorage.setItem('wopr-theme', theme);
    document.documentElement.dataset.theme = theme;
    this.set({ theme });
  }

  // ----------------------------------------------------------------- actions

  private setPending(key: string, value: boolean): void {
    const pending = { ...this.state.pending };
    if (value) pending[key] = true;
    else delete pending[key];
    this.set({ pending });
  }

  /**
   * Exécute une mutation : marque l'action en cours, appelle l'API, rafraîchit
   * les tranches concernées, et rapporte l'issue réelle par un toast.
   */
  private async mutate<T>(
    key: string,
    label: string,
    call: () => Promise<T>,
    refresh: () => Promise<void>,
    successMessage?: (result: T) => string | undefined,
  ): Promise<boolean> {
    this.setPending(key, true);
    try {
      const result = await call();
      await refresh().catch(() => undefined);
      this.addToast({
        type: 'success',
        title: label,
        message: successMessage?.(result),
      });
      return true;
    } catch (error) {
      const message = error instanceof ApiError ? error.message : String(error);
      this.addToast({ type: 'err', title: `${label} — échec`, message });
      return false;
    } finally {
      this.setPending(key, false);
    }
  }

  // --- rafraîchissements ciblés ------------------------------------------

  async refreshDocker(): Promise<void> {
    this.set({ docker: await api.docker() });
  }

  async refreshGpu(): Promise<void> {
    this.set({ gpu: await api.gpu() });
  }

  async refreshThermal(): Promise<void> {
    this.set({ thermal: await api.thermal() });
  }

  async refreshModes(): Promise<void> {
    const [modes, overview] = await Promise.all([api.modes(), api.overview()]);
    this.set({ modes, overview });
  }

  async refreshProcesses(): Promise<void> {
    this.set({ processes: await api.processes() });
  }

  async refreshSystem(): Promise<void> {
    this.set({ system: await api.system() });
  }

  async refreshOverview(): Promise<void> {
    this.set({ overview: await api.overview() });
  }

  async refreshAudit(params: Parameters<typeof api.audit>[0] = {}): Promise<void> {
    this.set({ audit: await api.audit(params) });
  }

  // --- Docker --------------------------------------------------------------

  dockerContainerAction(id: string, action: string, reason = ''): Promise<boolean> {
    return this.mutate(
      `container:${id}`,
      `Conteneur — ${action}`,
      () => api.containerAction(id, action, reason),
      () => this.refreshDocker(),
    );
  }

  dockerStackAction(name: string, action: string, reason = ''): Promise<boolean> {
    return this.mutate(
      `stack:${name}`,
      `Stack ${name} — ${action}`,
      () => api.stackAction(name, action, reason),
      () => this.refreshDocker(),
      (r) => r.detail,
    );
  }

  // --- GPU et modèles ------------------------------------------------------

  setGpuPowerLimit(index: number, watts: number): Promise<boolean> {
    return this.mutate(
      `gpu:${index}`,
      `GPU ${index} — limite de puissance`,
      () => api.setPowerLimit(index, watts),
      () => this.refreshGpu(),
      () => `Appliquée à ${watts} W`,
    );
  }

  loadModel(name: string): Promise<boolean> {
    return this.mutate(
      `model:${name}`,
      `Chargement de ${name}`,
      () => api.loadModel(name),
      () => this.refreshGpu(),
      () => 'Modèle résident en VRAM',
    );
  }

  unloadModel(name: string): Promise<boolean> {
    return this.mutate(
      `model:${name}`,
      `Déchargement de ${name}`,
      () => api.unloadModel(name),
      () => this.refreshGpu(),
      () => 'VRAM libérée',
    );
  }

  pinModel(name: string, pinned: boolean): Promise<boolean> {
    return this.mutate(
      `model:${name}`,
      pinned ? `Épinglage de ${name}` : `Désépinglage de ${name}`,
      () => api.pinModel(name, pinned),
      () => this.refreshGpu(),
    );
  }

  // --- Ventilation ---------------------------------------------------------

  controlFan(fanId: string, mode: 'auto' | 'manual' | 'curve', dutyPct = 50): Promise<boolean> {
    return this.mutate(
      `fan:${fanId}`,
      'Ventilateur',
      () => api.controlFan(fanId, mode, dutyPct),
      () => this.refreshThermal(),
      (r) => r.detail,
    );
  }

  setFanCurvePreset(preset: string | null): Promise<boolean> {
    return this.mutate(
      'fan:preset',
      preset ? `Courbe « ${preset} »` : 'Pilotage rendu à la carte mère',
      () => api.setCurvePreset(preset),
      () => this.refreshThermal(),
    );
  }

  updateFanCurvePoint(index: number, temp: number, duty: number): Promise<boolean> {
    return this.mutate(
      'fan:curve',
      'Courbe de ventilation',
      () => api.updateCurvePoint(index, temp, duty),
      () => this.refreshThermal(),
      (r) => r.detail,
    );
  }

  // --- Modes ---------------------------------------------------------------

  setMode(modeId: string, reason = '', revertMinutes = 0): Promise<boolean> {
    return this.mutate(
      `mode:${modeId}`,
      'Changement de mode',
      () => api.activateMode(modeId, reason, revertMinutes),
      async () => {
        await this.refreshModes();
        await Promise.all([this.refreshGpu(), this.refreshThermal()]);
      },
      (r) => {
        // On rend compte de ce qui a réellement été appliqué : un mode peut
        // réussir partiellement (GPU absent, ventilateurs non pilotables…).
        const failed = r.applied.filter((l) => !l.ok);
        if (failed.length === 0) return `${r.applied.length} levier(s) appliqué(s)`;
        return `${r.applied.length - failed.length}/${r.applied.length} leviers appliqués — ` +
          failed.map((l) => `${l.lever} : ${l.detail}`).join(' · ');
      },
    );
  }

  extendMode(minutes: number): Promise<boolean> {
    return this.mutate(
      'mode:extend',
      `Mode prolongé de ${minutes} min`,
      () => api.extendMode(minutes),
      () => this.refreshModes(),
    );
  }

  revertMode(): Promise<boolean> {
    return this.mutate(
      'mode:revert',
      'Retour au mode Équilibré',
      () => api.revertMode(),
      async () => {
        await this.refreshModes();
        await Promise.all([this.refreshGpu(), this.refreshThermal()]);
      },
    );
  }

  // --- Processus -----------------------------------------------------------

  killProcess(pid: number, signal: 'SIGTERM' | 'SIGKILL'): Promise<boolean> {
    return this.mutate(
      `proc:${pid}`,
      `${signal} → PID ${pid}`,
      () => api.killProcess(pid, signal),
      () => this.refreshProcesses(),
    );
  }

  reniceProcess(pid: number, nice: number): Promise<boolean> {
    return this.mutate(
      `proc:${pid}`,
      `Priorité du PID ${pid}`,
      () => api.reniceProcess(pid, nice),
      () => this.refreshProcesses(),
      () => `nice = ${nice}`,
    );
  }

  // --- Système -------------------------------------------------------------

  restartService(name: string): Promise<boolean> {
    return this.mutate(
      `svc:${name}`,
      `Redémarrage de ${name}`,
      () => api.restartService(name),
      () => this.refreshSystem(),
    );
  }

  dropCaches(): Promise<boolean> {
    return this.mutate(
      'sys:caches',
      'Vidage des caches',
      () => api.dropCaches(),
      () => this.refreshOverview(),
      (r) => r.detail,
    );
  }

  /** `confirm` doit valoir « redemarrer » — le serveur revérifie de son côté. */
  triggerReboot(reason: string, confirm: string): Promise<boolean> {
    return this.mutate(
      'sys:reboot',
      'Redémarrage de wopr',
      () => api.reboot(reason, confirm),
      async () => undefined,
      (r) => r.detail,
    );
  }

  acknowledgeAlert(id: string): Promise<boolean> {
    return this.mutate(
      `alert:${id}`,
      'Alerte acquittée',
      () => api.acknowledgeAlert(id),
      () => this.refreshOverview(),
    );
  }

  // --- Réseau ----------------------------------------------------------

  runSpeedtest(): Promise<boolean> {
    return this.mutate(
      'net:speedtest',
      'Test de débit',
      async () => {
        const result = await api.speedtest();
        this.set({ speedtest: result });
        return result;
      },
      async () => undefined,
      (r) => `${r.downloadMbps ?? '?'} Mb/s ↓ / ${r.uploadMbps ?? '?'} Mb/s ↑ / ${r.latencyMs ?? '?'} ms`,
    );
  }
}

export const store = new WoprStore();
