/**
 * Squelettes vides des tranches de données.
 *
 * Ils remplacent les 37 Ko de fausses données de `initialData.ts`, qui servaient
 * d'état initial à la maquette et restaient affichés quand une requête échouait —
 * l'interface montrait alors des mesures inventées sans le dire.
 *
 * Ces squelettes ne sont **jamais rendus** : `App` affiche un écran de chargement
 * tant que la première photographie complète n'est pas arrivée. Ils n'existent que
 * pour donner un type non nul aux vues, qui n'ont ainsi pas à tester chaque champ.
 */

import type {
  CpuRamData,
  OwnerInfo,
  DockerData,
  GpuData,
  ModesData,
  OverviewData,
  ProcessesData,
  StorageNetworkData,
  SystemData,
  ThermalData,
} from './types';

export const emptyOverview: OverviewData = {
  host: '',
  health: { level: 'inactive', summary: '', detail: '' },
  uptimeSeconds: 0,
  loadavg: [0, 0, 0],
  activeMode: {
    id: '', label: '', icon: 'gauge', since: '', activatedBy: '',
    reason: '', autoRevertAt: null, remainingMinutes: null,
  },
  powerEstimateW: null,
  powerScope: null,
  subsystems: [],
  alerts: [],
  historicalMetrics: {
    timestamps: [], cpuPct: [], ramPct: [], gpuPct: [],
    tempMaxC: [], netRxMBs: [], netTxMBs: [],
  },
};

export const emptyCpuRam: CpuRamData = {
  cpu: {
    model: '', cores: 0, threads: 0, utilPct: 0,
    freqMhzAvg: null, freqMhzMax: null,
    governor: null, governorAvailable: [], epp: null, eppAvailable: [],
    scalingDriver: null, tempPkgC: null, powerW: null, powerSource: null,
    perThread: [], loadavg: [0, 0, 0], topCpu: [], history: [],
  },
  ram: {
    totalGiB: 0, usedGiB: 0, cacheGiB: 0, freeGiB: 0,
    swapUsedGiB: 0, swapTotalGiB: 0, topMem: [], history: [],
  },
  motherboard: { model: '', biosVersion: '', biosDate: '', voltages: [], temps: [] },
};

export const emptyGpu: GpuData = {
  available: false,
  unavailableReason: null,
  ollamaReachable: false,
  ollamaVersion: null,
  aggregate: {
    count: 0, vramUsedMiB: 0, vramTotalMiB: 0, utilAvgPct: 0,
    powerW: null, powerLimitW: null, modelsLoaded: 0, gpuProcesses: 0, pressure: 'ok',
  },
  gpus: [],
  models: [],
  availableModels: [],
};

export const emptyThermal: ThermalData = {
  sensors: [],
  fans: [],
  fanHistory: [],
  fansAvailable: false,
  fansUnavailableReason: null,
  curvePresets: [],
  activeCurvePreset: null,
  presetForcedByMode: null,
  currentCurvePoints: [],
  controlTempC: null,
  failsafeEngaged: false,
  failsafeReason: null,
  manualFans: {},
};

export const emptyStorageNetwork: StorageNetworkData = {
  mounts: [],
  interfaces: [],
  listeners: [],
  firewall: { active: null, backend: null, detail: '' },
  gateway: { ip: null, pingMs: null },
  internet: { ip: null, pingMs: null },
};

export const emptyModes: ModesData = {
  active: '',
  activeDetail: emptyOverview.activeMode,
  lastApplication: [],
  modes: [],
  schedules: [],
  history: [],
};

export const emptyDocker: DockerData = {
  available: false,
  unavailableReason: null,
  summary: { running: 0, total: 0, unhealthy: 0, recentRestarts: 0 },
  stacks: [],
};

export const emptyProcesses: ProcessesData = {
  summary: { count: 0, threads: 0, zombies: 0, loadavg: [0, 0, 0] },
  processes: [],
};

export const emptySystem: SystemData = {
  os: '', kernel: '', hostname: '', bootedAt: '', uptimeSeconds: 0,
  needsReboot: false, pendingUpdates: null, securityUpdates: null,
  hostControl: false, services: [], recentActions: [],
};

/**
 * Identités connues avant la première réponse de `/api/status`. Réduites au
 * repli « partagé » : tant que le serveur n'a pas parlé, l'interface ne prétend
 * pas savoir qui administre la machine.
 */
export const emptyOwners: OwnerInfo[] = [
  { id: 'shared', label: 'Partagé', tone: 'emerald',
    description: 'Partagé (accessible / utilisé par tous)', blurb: '' },
];
