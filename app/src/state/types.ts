/**
 * Contrat de données entre l'API et les vues.
 *
 * Règle qui gouverne ce fichier : **une valeur peut être absente**. Le backend ne
 * fabrique jamais de chiffre plausible pour combler un trou — il renvoie `null` et
 * explique pourquoi. Les types disent donc `| null` partout où la mesure peut
 * manquer, et les vues doivent afficher une indisponibilité, pas un zéro.
 */

export type HealthLevel = 'ok' | 'warn' | 'err' | 'inactive';

/** Nom du compte connecté. Un seul compte administrateur par défaut. */
export type AdminUser = string;

/**
 * Identifiant d'une identité d'administrateur, tel que déclaré dans
 * `config/owners.yaml` et posé sur les conteneurs par l'étiquette
 * `com.wopr.owner`. Volontairement ouvert : l'interface ne connaît aucun compte
 * en dur, elle affiche ce que `/api/status` lui donne. `shared` est le seul
 * identifiant garanti — c'est le repli quand rien ne tranche.
 */
export type Owner = string;

/** Teintes admises pour une identité. Voir `TONE_CLASSES` dans Badge.tsx. */
export type OwnerTone = 'cyan' | 'purple' | 'emerald' | 'amber' | 'rose' | 'sky' | 'slate';

/** Une identité telle que l'interface doit l'afficher. */
export interface OwnerInfo {
  id: Owner;
  label: string;
  tone: OwnerTone;
  /** Infobulle du badge. */
  description: string;
  /** Ligne de contexte sous le compteur de la vue Docker. Peut être vide. */
  blurb: string;
}

/** Identifiant du repli « partagé », toujours présent. */
export const SHARED_OWNER = 'shared';

export interface AlertItem {
  id: string;
  level: 'warn' | 'err' | 'info';
  component: string;
  message: string;
  since: string;
  acknowledged: boolean;
}

export interface SubsystemStatus {
  id: string;
  label: string;
  level: HealthLevel;
  value: string;
  subvalue?: string;
  spark?: number[];
  viewId: string;
}

export interface ActiveMode {
  id: string;
  label: string;
  icon: string;
  since: string;
  activatedBy: string;
  reason: string;
  autoRevertAt: string | null;
  remainingMinutes: number | null;
}

export interface OverviewData {
  host: string;
  health: {
    level: HealthLevel;
    summary: string;
    detail: string;
  };
  uptimeSeconds: number;
  loadavg: [number, number, number];
  activeMode: ActiveMode;
  /** Somme CPU (RAPL) + GPU (NVML). `null` si aucune des deux n'est mesurable. */
  powerEstimateW: number | null;
  /** Ce que couvre réellement la mesure ci-dessus, à afficher tel quel. */
  powerScope: string | null;
  subsystems: SubsystemStatus[];
  alerts: AlertItem[];
  historicalMetrics: {
    timestamps: string[];
    cpuPct: number[];
    ramPct: number[];
    gpuPct: number[];
    tempMaxC: number[];
    netRxMBs: number[];
    netTxMBs: number[];
  };
}

export interface ProcessTop {
  pid: number;
  name: string;
  user?: string;
  cpuPct?: number;
  rssMiB?: number;
}

export interface CpuRamData {
  cpu: {
    model: string;
    cores: number;
    threads: number;
    utilPct: number;
    freqMhzAvg: number | null;
    freqMhzMax: number | null;
    /** Gouverneur réellement appliqué, lu dans /sys. */
    governor: string | null;
    governorAvailable: string[];
    /** Préférence énergie/performance (amd-pstate-epp). */
    epp: string | null;
    eppAvailable: string[];
    scalingDriver: string | null;
    tempPkgC: number | null;
    /** Puissance mesurée. `null` si RAPL n'est pas lisible. */
    powerW: number | null;
    /** `'rapl'` quand la valeur est mesurée ; `null` quand elle est absente. */
    powerSource: 'rapl' | null;
    perThread: number[];
    loadavg: [number, number, number];
    topCpu: ProcessTop[];
    history: { time: string; util: number; load1: number; load5: number }[];
  };
  ram: {
    totalGiB: number;
    usedGiB: number;
    cacheGiB: number;
    freeGiB: number;
    swapUsedGiB: number;
    swapTotalGiB: number;
    topMem: ProcessTop[];
    history: { time: string; usedGiB: number }[];
  };
  motherboard: {
    model: string;
    biosVersion: string;
    biosDate: string;
    /** `range` et `ok` valent `null` quand le chip ne déclare pas de bornes. */
    voltages: { name: string; value: number; range: [number, number] | null; ok: boolean | null }[];
    temps: { name: string; value: number }[];
  };
}

export interface GpuProcess {
  pid: number;
  name: string;
  type: 'C' | 'G';
  memMiB: number;
}

export interface GpuItem {
  index: number;
  name: string;
  uuid: string;
  memTotalMiB: number;
  memUsedMiB: number;
  memUtilPct: number;
  utilPct: number;
  tempC: number | null;
  /**
   * `null` sur une carte à refroidissement passif (la Tesla P100 à venir, par
   * exemple) : NVML n'y rapporte aucun ventilateur. À afficher « refroidissement
   * châssis », surtout pas « 0 % ».
   */
  fanPct: number | null;
  /** NVML ne donne qu'un pourcentage, jamais de tr/min. Toujours `null`. */
  fanRpm: number | null;
  cooling: 'chassis' | 'active';
  powerW: number | null;
  powerLimitW: number | null;
  /** Plage propre à CETTE carte, lue via NVML. */
  powerLimitRangeW: [number, number] | null;
  clockSmMhz: number | null;
  clockMemMhz: number | null;
  pcie: string | null;
  hasDisplayOut: boolean;
  driver: string;
  vbios: string;
  /** Absent des cartes grand public sans ECC. */
  ecc: { corrected: number; uncorrected: number } | null;
  processes: GpuProcess[];
  history: { time: string; util: number; temp: number; vram: number; power: number }[];
}

export interface LoadedModel {
  id: string;
  name: string;
  engine: 'ollama';
  /** Cartes portant un processus du moteur. */
  gpus: number[];
  vramMiB: number;
  /**
   * Répartition par carte. `null` quand plusieurs modèles sont résidents :
   * Ollama n'indique pas quel modèle occupe quelle carte, et on préfère ne rien
   * afficher plutôt que de répartir au hasard.
   */
  vramPerGpuMiB: Record<string, number> | null;
  sizeMiB: number;
  contextTokens: number | null;
  quant: string;
  parameterSize: string;
  /** Ollama n'expose aucun débit de génération : toujours `null`. */
  tokensPerSec: number | null;
  loadedAt: string | null;
  lastUsedAt: string | null;
  expiresAt: string | null;
  state: 'active' | 'idle';
  pinned: boolean;
}

export interface AvailableModel {
  name: string;
  sizeGiB: number;
  quant: string;
  parameterSize: string;
  family: string;
}

export interface GpuData {
  available: boolean;
  unavailableReason: string | null;
  ollamaReachable: boolean;
  /** Version rapportée par `/api/version`, `null` si Ollama est injoignable. */
  ollamaVersion: string | null;
  aggregate: {
    count: number;
    vramUsedMiB: number;
    vramTotalMiB: number;
    utilAvgPct: number;
    powerW: number | null;
    powerLimitW: number | null;
    modelsLoaded: number;
    gpuProcesses: number;
    pressure: 'ok' | 'tendu' | 'saturé';
  };
  gpus: GpuItem[];
  models: LoadedModel[];
  availableModels: AvailableModel[];
}

export interface TempSensor {
  id: string;
  label: string;
  tempC: number;
  warnC: number;
  critC: number;
  source: string;
  /** Variation sur ~30 s. `null` tant qu'il n'y a pas assez d'historique. */
  delta: number | null;
  spark: number[];
  history: { time: string; temp: number }[];
}

export interface FanItem {
  id: string;
  label: string;
  rpm: number;
  dutyPct: number;
  mode: 'auto' | 'manual' | 'curve';
  sourceSensor: string | null;
  controllable: boolean;
  fault: 'stall' | null;
}

export interface FanCurvePoint {
  temp: number;
  duty: number;
}

export interface ThermalData {
  sensors: TempSensor[];
  fans: FanItem[];
  /** Régime moyen des ventilateurs détectés, aux mêmes horodatages que `TempSensor.history`. */
  fanHistory: { time: string; rpm: number }[];
  /** Faux quand le noyau n'expose aucun contrôleur (module nct6775 non chargé). */
  fansAvailable: boolean;
  fansUnavailableReason: string | null;
  curvePresets: string[];
  /** `null` = la carte mère pilote (Smart Fan IV), le dashboard ne s'en mêle pas. */
  activeCurvePreset: string | null;
  presetForcedByMode: string | null;
  currentCurvePoints: FanCurvePoint[];
  /** Température de référence des courbes. */
  controlTempC: number | null;
  /** Le chien de garde thermique a rendu la main à la carte mère. */
  failsafeEngaged: boolean;
  failsafeReason: string | null;
  manualFans: Record<string, number>;
}

export interface StorageMount {
  path: string;
  fs: string;
  device: string;
  type: 'nvme' | 'nfs' | 'sata';
  usedGiB: number;
  totalGiB: number;
  usedPct: number;
  inodePct: number;
  readMBs: number;
  writeMBs: number;
  iops: number;
  tempC: number | null;
  /** `unknown` : SMART non lu (SATA, NFS, lecture en échec) — surtout pas « ok ». */
  smart: 'ok' | 'warn' | 'err' | 'unknown';
  /** Aller-retour vers le serveur NFS. `null` pour un disque local. */
  latencyMs: number | null;
  /** Compteurs SMART NVMe. `null` sur un disque qui ne les expose pas. */
  powerOnHours: number | null;
  /** Total écrit en téraoctets, dérivé de `data_units_written`. */
  tbw: number | null;
  /** Usure déclarée par le contrôleur, en pourcentage. */
  wearPct: number | null;
  reachable: boolean;
  /** Seuils d'occupation de ce montage (thresholds.yaml, surcharges comprises). */
  warnPct: number;
  critPct: number;
}

export interface NetworkInterface {
  name: string;
  up: boolean;
  ipv4: string;
  mac: string;
  speedMbps: number;
  duplex: string;
  mtu: number;
  rxMBs: number;
  txMBs: number;
  rxErrors: number;
  txErrors: number;
  rxTotalGiB: number;
  txTotalGiB: number;
  rxHistory: number[];
  txHistory: number[];
  /** Pont Docker ou interface virtuelle : rangée à part dans la vue. */
  virtual: boolean;
}

export interface NetworkListener {
  port: number;
  proto: 'tcp' | 'udp';
  process: string;
  pid: number | null;
  listen: string;
  container: string | null;
}

export interface StorageNetworkData {
  mounts: StorageMount[];
  interfaces: NetworkInterface[];
  listeners: NetworkListener[];
  firewall: { active: boolean | null; backend: string | null; detail: string };
  gateway: { ip: string | null; pingMs: number | null };
  internet: { target?: string; ip: string | null; pingMs: number | null };
}

/**
 * Leviers d'un mode.
 *
 * Seuls figurent ici ceux qui agissent réellement sur la machine. La maquette
 * annonçait aussi « mises à jour auto suspendues », « notifications en sourdine »,
 * « mise en veille » et « limites de ressources conteneurs » : rien n'était branché
 * derrière, donc ces leviers ont été retirés plutôt que d'être affichés en vain.
 */
export interface ModePolicy {
  cpuGovernor?: string;
  cpuEpp?: string;
  /** Watts, `"max"`, `"min"`, ou un pourcentage de la plage propre à la carte. */
  gpuPowerLimit?: number | string | Record<string, number | string>;
  fanCurvePreset?: string | null;
  ollamaKeepAlive?: string | number;
  containers?: { stop: string[]; start: string[] };
}

export interface ModeItem {
  id: string;
  label: string;
  icon: string;
  description: string;
  policies: ModePolicy;
}

/** Compte rendu d'un levier après application d'un mode. */
export interface LeverResult {
  lever: string;
  ok: boolean;
  detail: string;
}

export interface ModeHistoryItem {
  id: string;
  at: string;
  by: string;
  from: string;
  to: string;
  reason: string;
  autoRevertAt: string | null;
}

export interface ModesData {
  active: string;
  activeDetail: ActiveMode;
  /** Ce qui a réellement été appliqué au dernier changement, levier par levier. */
  lastApplication: LeverResult[];
  modes: ModeItem[];
  /** La planification horaire n'est pas implémentée : toujours vide. */
  schedules: never[];
  history: ModeHistoryItem[];
}

export interface DockerContainer {
  id: string;
  fullId: string;
  name: string;
  service: string;
  image: string;
  state: 'running' | 'restarting' | 'stopped' | 'paused' | 'unhealthy';
  health: 'healthy' | 'unhealthy' | 'starting' | 'none';
  /** `null` tant que le flux de statistiques n'a pas produit d'échantillon. */
  /** Conteneur du dashboard lui-même : arrêt, pause et suppression refusés. */
  isSelf: boolean;
  cpuPct: number | null;
  memMiB: number | null;
  memLimitMiB: number | null;
  uptimeSeconds: number;
  ports: string[];
  managedBy: 'compose' | 'jarvis' | 'manual';
  owner: Owner;
  usesGpu: number[] | null;
  restarts: number;
  privileged: boolean;
  restartPolicy: string | null;
  networkMode: string | null;
  volumes: string[];
  /** Noms des variables d'environnement seulement — jamais leurs valeurs. */
  envKeys: string[];
}

export interface DockerStack {
  name: string;
  owner: Owner;
  /** Stack exclue du périmètre du dashboard : actions refusées côté API. */
  outOfScope: boolean;
  /** Stack du dashboard lui-même : `up` et `down` refusés côté API. */
  containsSelf: boolean;
  configFiles: string | null;
  workingDir: string | null;
  containers: DockerContainer[];
}

export interface DockerData {
  available: boolean;
  unavailableReason: string | null;
  summary: {
    running: number;
    total: number;
    unhealthy: number;
    recentRestarts: number;
  };
  stacks: DockerStack[];
}

export interface ContainerLogLine {
  time: string;
  level: 'info' | 'warn' | 'err';
  message: string;
}

export interface ProcessItem {
  pid: number;
  ppid: number;
  user: string;
  cmd: string;
  cpuPct: number;
  memPct: number;
  rssMiB: number;
  threads: number;
  nice: number;
  state: 'R' | 'S' | 'D' | 'Z';
  startedAt: string;
  containerId: string | null;
}

export interface ProcessesData {
  summary: {
    count: number;
    threads: number;
    zombies: number;
    loadavg: [number, number, number];
  };
  processes: ProcessItem[];
}

export interface SystemService {
  name: string;
  state: 'active' | 'inactive' | 'failed';
  restartable: boolean;
  description: string;
}

export interface SystemActionItem {
  id: string;
  at: string;
  by: string;
  action: string;
  target: string;
  result: string;
}

export interface SystemData {
  os: string;
  kernel: string;
  hostname: string;
  bootedAt: string;
  uptimeSeconds: number;
  needsReboot: boolean;
  /** `null` quand le comptage n'a pas pu être fait — ce n'est pas « zéro ». */
  pendingUpdates: number | null;
  securityUpdates: number | null;
  /** Faux si le conteneur ne peut pas atteindre l'hôte : actions système grisées. */
  hostControl: boolean;
  services: SystemService[];
  recentActions: SystemActionItem[];
}

export interface AuditLogItem {
  id: string;
  at: string;
  by: string;
  category: 'mode' | 'docker' | 'system' | 'process' | 'llm' | 'alert' | 'fan';
  target: string;
  detail: string;
  result: 'succès' | 'attention' | 'échec' | 'info';
}

export interface AuditPage {
  total: number;
  items: AuditLogItem[];
  /**
   * Auteurs distincts présents dans le journal, du plus actif au moins actif.
   * Calculés par le serveur sur la totalité du journal : la liste déroulante
   * de filtrage ne propose donc que des valeurs qui donneront un résultat.
   */
  actors: string[];
}

export interface SpeedtestResult {
  downloadMbps: number | null;
  uploadMbps: number | null;
  latencyMs: number | null;
  at: string;
}

export interface StatusData {
  status: string;
  live: boolean;
  hostname: string;
  authenticated: boolean;
  user: AdminUser | null;
  /**
   * Étiquette `com.wopr.owner` correspondant à la personne connectée. Le compte de
   * connexion et l'appartenance des conteneurs sont deux notions distinctes :
   * c'est cette valeur qui dit quels conteneurs sont « les siens ».
   */
  ownerIdentity: Owner;
  /** Identités déclarées, dans l'ordre du fichier. Toujours au moins `shared`. */
  owners: OwnerInfo[];
  dockerAvailable: boolean;
  gpuAvailable: boolean;
  hostControl: boolean;
  /** La base d'historique longue durée reçoit les échantillons. */
  historyDb: boolean;
}

/** Réponse de `/api/history` : moyennes par pas régulier, `null` où rien n'a été mesuré. */
export interface HistoryData {
  range: '1m' | '5m' | '1h' | '6h';
  stepSeconds: number;
  /** Début de chaque pas, en secondes Unix. */
  timestamps: number[];
  series: Record<string, (number | null)[]>;
}
