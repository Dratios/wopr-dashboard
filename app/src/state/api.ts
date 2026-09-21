/**
 * Client HTTP de l'API WOPR.
 *
 * Toutes les mutations passent par ici, et **aucune n'est optimiste** : la vue
 * n'affiche un succès qu'après réponse favorable du serveur. La version d'origine
 * appliquait l'effet dans le store puis avalait l'échec réseau dans un
 * `console.error` — l'interface annonçait donc des actions qui n'avaient pas eu lieu.
 */

import type {
  ConfigExport,
  ModesConfigPayload,
  NotificationJournalItem,
  SettingsData,
  ThresholdsPayload,
} from './settingsTypes';
import type {
  AuditPage,
  ContainerLogLine,
  CpuRamData,
  DockerData,
  GpuData,
  HistoryData,
  LeverResult,
  ModesData,
  OverviewData,
  ProcessesData,
  SpeedtestResult,
  StatusData,
  StorageNetworkData,
  SystemData,
  AlertItem,
} from './types';

/** Levée quand le serveur répond une erreur : le message est celui de l'API. */
export class ApiError extends Error {
  constructor(message: string, public status: number) {
    super(message);
    this.name = 'ApiError';
  }
}

/** Levée sur 401 : la session a expiré ou n'a jamais existé. */
export class UnauthorizedError extends ApiError {
  constructor() {
    super('Session expirée', 401);
    this.name = 'UnauthorizedError';
  }
}

type Listener = () => void;
const unauthorizedListeners = new Set<Listener>();

/** Permet au store de ramener l'utilisateur à l'écran de connexion. */
export function onUnauthorized(listener: Listener): () => void {
  unauthorizedListeners.add(listener);
  return () => unauthorizedListeners.delete(listener);
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, {
      credentials: 'same-origin',
      headers: init?.body ? { 'Content-Type': 'application/json' } : undefined,
      ...init,
    });
  } catch {
    throw new ApiError('Serveur injoignable', 0);
  }

  if (response.status === 401) {
    unauthorizedListeners.forEach((l) => l());
    throw new UnauthorizedError();
  }

  if (!response.ok) {
    // FastAPI met le message lisible dans `detail`.
    let detail = `Erreur ${response.status}`;
    try {
      const body = await response.json();
      if (typeof body?.detail === 'string') detail = body.detail;
    } catch {
      /* corps non JSON : on garde le message générique */
    }
    throw new ApiError(detail, response.status);
  }

  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

const post = <T>(path: string, body?: unknown) =>
  request<T>(path, {
    method: 'POST',
    body: body === undefined ? undefined : JSON.stringify(body),
  });

export const api = {
  // ------------------------------------------------------------- session
  status: () => request<StatusData>('/api/status'),
  login: (username: string, password: string) =>
    post<{ user: string }>('/api/auth/login', { username, password }),
  logout: () => post<void>('/api/auth/logout'),

  // ------------------------------------------------------------- lectures
  overview: () => request<OverviewData>('/api/overview'),
  cpuRam: () => request<CpuRamData>('/api/cpu-ram'),
  history: (range: HistoryData['range'], metrics: string[]) =>
    request<HistoryData>(
      `/api/history?range=${range}&metrics=${encodeURIComponent(metrics.join(','))}`,
    ),
  gpu: () => request<GpuData>('/api/gpu'),
  thermal: () => request<import('./types').ThermalData>('/api/thermal'),
  storageNetwork: () => request<StorageNetworkData>('/api/storage-network'),
  docker: () => request<DockerData>('/api/docker'),
  processes: () => request<ProcessesData>('/api/processes'),
  system: () => request<SystemData>('/api/system'),
  modes: () => request<ModesData>('/api/modes'),
  alerts: () => request<AlertItem[]>('/api/alerts'),
  audit: (params: {
    limit?: number;
    offset?: number;
    category?: string;
    by?: string;
    result?: string;
  } = {}) => {
    const query = new URLSearchParams();
    Object.entries(params).forEach(([k, v]) => {
      if (v !== undefined && v !== '') query.set(k, String(v));
    });
    return request<AuditPage>(`/api/audit?${query.toString()}`);
  },

  // ------------------------------------------------------------- Docker
  containerAction: (id: string, action: string, reason = '') =>
    post<{ status: string }>(`/api/docker/container/${id}/action`, { action, reason }),
  stackAction: (name: string, action: string, reason = '') =>
    post<{ status: string; detail: string }>(
      `/api/docker/stack/${encodeURIComponent(name)}/action`, { action, reason }),
  containerLogs: (id: string, tail = 200) =>
    request<{ containerId: string; logs: ContainerLogLine[] }>(
      `/api/docker/container/${id}/logs?tail=${tail}`),

  // ------------------------------------------------------------- GPU / LLM
  setPowerLimit: (index: number, watts: number) =>
    post<{ watts: number }>(`/api/gpu/${index}/power-limit`, { watts }),
  loadModel: (name: string) => post<void>('/api/models/load', { name }),
  unloadModel: (name: string) => post<void>('/api/models/unload', { name }),
  pinModel: (name: string, pinned: boolean) =>
    post<void>('/api/models/pin', { name, pinned }),

  // ------------------------------------------------------------- ventilation
  controlFan: (fanId: string, mode: 'auto' | 'manual' | 'curve', dutyPct = 50) =>
    post<{ detail: string }>(`/api/thermal/fan/${encodeURIComponent(fanId)}`,
      { mode, dutyPct }),
  setCurvePreset: (preset: string | null) =>
    post<{ detail: string }>('/api/thermal/preset', { preset }),
  updateCurvePoint: (index: number, temp: number, duty: number) =>
    post<{ detail: string }>('/api/thermal/curve-point', { index, temp, duty }),

  // ------------------------------------------------------------- modes
  activateMode: (modeId: string, reason = '', revertMinutes = 0) =>
    post<{ mode: string; applied: LeverResult[] }>('/api/modes/activate',
      { modeId, reason, revertMinutes }),
  extendMode: (minutes: number) =>
    post<{ autoRevertAt: string }>('/api/modes/extend', { minutes }),
  revertMode: () => post<{ mode: string; applied: LeverResult[] }>('/api/modes/revert'),

  // ------------------------------------------------------------- processus
  killProcess: (pid: number, signal: 'SIGTERM' | 'SIGKILL') =>
    post<void>(`/api/processes/${pid}/kill`, { signal }),
  reniceProcess: (pid: number, nice: number) =>
    post<void>(`/api/processes/${pid}/renice`, { nice }),

  // ------------------------------------------------------------- système
  restartService: (name: string) =>
    post<void>(`/api/system/service/${encodeURIComponent(name)}/restart`),
  dropCaches: () => post<{ detail: string }>('/api/system/drop-caches'),
  /** `confirm` doit valoir « redemarrer » : le serveur refuse sinon. */
  reboot: (reason: string, confirm: string) =>
    post<{ detail: string }>('/api/system/reboot', { reason, confirm }),
  acknowledgeAlert: (id: string) =>
    post<void>(`/api/alerts/${encodeURIComponent(id)}/acknowledge`),

  // ------------------------------------------------------------- réseau
  speedtest: () => post<SpeedtestResult>('/api/network/speedtest'),

  // ------------------------------------------------------------- paramètres
  settings: () => request<SettingsData>('/api/settings'),
  /**
   * `values` est un patch partiel. Un champ secret absent ou vide signifie
   * « inchangé » : le serveur ne l'efface jamais sur une chaîne vide.
   */
  saveSettings: (values: Record<string, unknown>,
                 families?: Record<string, { level: string; resolved: boolean }>) =>
    post<SettingsData & { changed: { live: string[]; cold: string[] } }>(
      '/api/settings', { values, families }),
  resetSettingsSection: (section: string) =>
    post<SettingsData & { removed: string[] }>('/api/settings/reset', { section }),
  changePassword: (current: string, next: string) =>
    post<{ detail: string }>('/api/settings/password', { current, new: next }),
  testTelegram: (botToken = '', chatId = '') =>
    post<{ detail: string }>('/api/settings/telegram/test', { botToken, chatId }),
  notificationJournal: (days = 7, limit = 200) =>
    request<{ items: NotificationJournalItem[]; sent: number; suppressed: number }>(
      `/api/settings/notifications/journal?days=${days}&limit=${limit}`),
  thresholds: () => request<ThresholdsPayload>('/api/settings/thresholds'),
  saveThresholds: (content: Record<string, unknown>) =>
    post<ThresholdsPayload>('/api/settings/thresholds', { content }),
  modesConfig: () => request<ModesConfigPayload>('/api/settings/modes'),
  saveModesConfig: (content: { modes: unknown[] }) =>
    post<ModesConfigPayload>('/api/settings/modes', { content }),
  exportConfig: (secrets = false) =>
    request<ConfigExport>(`/api/settings/export?secrets=${secrets ? 'true' : 'false'}`),
  importConfig: (payload: Partial<ConfigExport>) =>
    post<SettingsData & { applied: string[] }>('/api/settings/import', payload),
  configFiles: () =>
    request<{ files: { label: string; path: string; exists: boolean; content: string | null;
                       backups: { name: string; size: number; at: number }[] }[] }>(
      '/api/settings/files'),
};
