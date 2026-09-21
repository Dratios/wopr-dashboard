/**
 * Formes renvoyées par `/api/settings`.
 *
 * Le serveur envoie son **registre** de réglages, pas seulement des valeurs :
 * libellé, aide, type, bornes, portée. L'onglet Paramètres se dessine à partir
 * de lui, si bien qu'ajouter un réglage côté Python le fait apparaître ici sans
 * toucher au TypeScript.
 */

export type SettingKind =
  | 'bool' | 'int' | 'float' | 'str' | 'secret' | 'enum' | 'url' | 'time';

/** `live` s'applique sans redémarrage, `cold` attend une recréation du conteneur. */
export type SettingScope = 'live' | 'cold';

/** D'où vient la valeur affichée. */
export type SettingSource = 'settings' | 'env' | 'default';

export interface SettingDescriptor {
  key: string;
  section: string;
  label: string;
  help: string;
  kind: SettingKind;
  default: unknown;
  env: string | null;
  scope: SettingScope;
  unit: string | null;
  min: number | null;
  max: number | null;
  choices: string[] | null;
  choiceLabels: Record<string, string> | null;
  secret: boolean;
  readonly: boolean;
  advanced: boolean;
  /** Toujours `''` pour un secret : le serveur ne le renvoie jamais en clair. */
  value: unknown;
  /** Uniquement pour un secret : une valeur est-elle enregistrée ? */
  isSet: boolean | null;
  source: SettingSource;
}

export interface SettingsSection {
  id: string;
  label: string;
  icon: string;
  help: string;
}

export interface FamilyMeta {
  id: string;
  label: string;
  patterns: string[];
}

export type FamilyLevel = 'inherit' | 'never' | 'err' | 'warn' | 'info';

export interface FamilyRule {
  level: FamilyLevel;
  resolved: boolean;
}

export interface PendingRestartItem {
  key: string;
  label: string;
  env: string;
  running: string;
  saved: string;
}

export interface SettingsData {
  sections: SettingsSection[];
  settings: SettingDescriptor[];
  families: {
    meta: FamilyMeta[];
    levels: FamilyLevel[];
    levelLabels: Record<FamilyLevel, string>;
    rules: Record<string, FamilyRule>;
  };
  pendingRestart: PendingRestartItem[];
  restartCommand: string;
  writable: { config: boolean; dotenv: boolean; comments: boolean };
  paths: { settings: string; thresholds: string; modes: string; dotenv: string };
  account: { username: string; users: string[] };
  telegram: { configured: boolean };
}

export interface NotificationJournalItem {
  id: string;
  at: string;
  kind: 'alert' | 'resolved' | 'event' | 'digest' | 'test';
  alertId: string | null;
  family: string | null;
  level: string | null;
  title: string;
  sent: boolean;
  reason: string | null;
}

export interface ThresholdsPayload {
  content: Record<string, any>;
  path: string;
}

export interface ModePolicy {
  cpuGovernor?: string | null;
  cpuEpp?: string | null;
  gpuPowerLimit?: unknown;
  fanCurvePreset?: string | null;
  ollamaKeepAlive?: unknown;
  containers?: { stop: string[]; start: string[] };
}

export interface ModeDefinition {
  id: string;
  label: string;
  icon?: string;
  description?: string;
  policies: ModePolicy;
}

export interface ModesConfigPayload {
  content: { modes: ModeDefinition[] };
  path: string;
  activeId: string;
  fallbackId: string;
  fanPresets: string[];
}

export interface ConfigExport {
  exportedAt: string;
  host: string;
  includesSecrets: boolean;
  settings: Record<string, any>;
  thresholds: Record<string, any>;
  modes: { modes: ModeDefinition[] };
}

/** Préférences propres au navigateur, jamais envoyées au serveur. */
export interface UiPrefs {
  theme: 'dark' | 'light' | 'auto';
  startView: string;
  density: 'comfortable' | 'compact';
  chartRange: '1m' | '5m' | '1h' | '6h';
  showAdvanced: boolean;
}

export const DEFAULT_UI_PREFS: UiPrefs = {
  theme: 'dark',
  startView: 'overview',
  density: 'comfortable',
  chartRange: '5m',
  showAdvanced: false,
};
