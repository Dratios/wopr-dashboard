/**
 * Sections de l'onglet Paramètres qui ne se déduisent pas du registre :
 * mot de passe, préférences du navigateur, export/import et fichiers bruts.
 */

import React, { useEffect, useState } from 'react';
import {
  Download, Upload, FileText, Loader2, KeyRound, Trash2, AlertTriangle, Copy, Check,
} from 'lucide-react';

import { api, ApiError } from '../../state/api';
import { store } from '../../state/store';
import { useWoprStore } from '../../state/useWoprStore';
import type { SettingsData, UiPrefs } from '../../state/settingsTypes';
import { DEFAULT_UI_PREFS } from '../../state/settingsTypes';
import {
  BUTTON_GHOST, BUTTON_PRIMARY, FieldRow, INPUT_CLASS, SELECT_CLASS,
  SegmentedControl, SettingsCard, Toggle,
} from '../common/FormControls';
import { ConfirmDialog } from '../common/ConfirmDialog';

// ------------------------------------------------------ préférences locales

const PREFS_KEY = 'wopr-ui-prefs';

export function loadPrefs(): UiPrefs {
  try {
    const raw = localStorage.getItem(PREFS_KEY);
    return raw ? { ...DEFAULT_UI_PREFS, ...JSON.parse(raw) } : { ...DEFAULT_UI_PREFS };
  } catch {
    // Navigation privée, stockage bloqué : les défauts font parfaitement l'affaire.
    return { ...DEFAULT_UI_PREFS };
  }
}

export function savePrefs(prefs: UiPrefs): void {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
  } catch {
    /* rien à faire : la préférence sera simplement oubliée */
  }
}

// ---------------------------------------------------------- mot de passe

export const PasswordCard: React.FC<{ username: string }> = ({ username }) => {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);

  const tooShort = next.length > 0 && next.length < 12;
  const mismatch = confirm.length > 0 && confirm !== next;
  const canSubmit = current && next.length >= 12 && next === confirm && !busy;

  const strength = (() => {
    let score = 0;
    if (next.length >= 12) score++;
    if (next.length >= 20) score++;
    if (/[a-z]/.test(next) && /[A-Z]/.test(next)) score++;
    if (/\d/.test(next)) score++;
    if (/[^A-Za-z0-9]/.test(next)) score++;
    return score;
  })();
  const strengthLabel = ['très faible', 'faible', 'correct', 'bon', 'solide', 'excellent'][strength];

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    try {
      const res = await api.changePassword(current, next);
      store.addToast({ type: 'success', title: 'Mot de passe', message: res.detail });
      setCurrent(''); setNext(''); setConfirm('');
    } catch (error) {
      store.addToast({
        type: 'err', title: 'Mot de passe — échec',
        message: error instanceof ApiError ? error.message : String(error),
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <SettingsCard
      title="Mot de passe"
      description={`Compte « ${username} ». Le changement prend effet immédiatement, sans
                    redémarrage, et ferme toutes les autres sessions ouvertes.`}
    >
      <form onSubmit={submit} className="pt-3 space-y-3 max-w-md">
        <div>
          <label className="block text-xs font-medium text-wopr-text mb-1.5">
            Mot de passe actuel
          </label>
          <input
            type="password"
            value={current}
            autoComplete="current-password"
            onChange={(e) => setCurrent(e.target.value)}
            className={INPUT_CLASS}
          />
        </div>
        <div>
          <label className="block text-xs font-medium text-wopr-text mb-1.5">
            Nouveau mot de passe
          </label>
          <input
            type="password"
            value={next}
            autoComplete="new-password"
            onChange={(e) => setNext(e.target.value)}
            className={INPUT_CLASS}
          />
          {tooShort && (
            <p className="text-[11px] text-wopr-warn mt-1">12 caractères au minimum.</p>
          )}
          {next.length >= 12 && (
            <div className="flex items-center gap-2 mt-1.5">
              <div className="flex-1 h-1 rounded-full bg-[#0d1117] overflow-hidden">
                <div
                  className={`h-full transition-all ${
                    strength <= 2 ? 'bg-wopr-warn' : strength <= 3 ? 'bg-wopr-accent' : 'bg-wopr-ok'
                  }`}
                  style={{ width: `${(strength / 5) * 100}%` }}
                />
              </div>
              <span className="text-[10px] text-wopr-textMuted w-20">{strengthLabel}</span>
            </div>
          )}
        </div>
        <div>
          <label className="block text-xs font-medium text-wopr-text mb-1.5">
            Confirmation
          </label>
          <input
            type="password"
            value={confirm}
            autoComplete="new-password"
            onChange={(e) => setConfirm(e.target.value)}
            className={INPUT_CLASS}
          />
          {mismatch && (
            <p className="text-[11px] text-wopr-err mt-1">
              Les deux saisies ne correspondent pas.
            </p>
          )}
        </div>
        <button type="submit" disabled={!canSubmit} className={BUTTON_PRIMARY}>
          <span className="flex items-center gap-1.5">
            {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  : <KeyRound className="w-3.5 h-3.5" />}
            Changer le mot de passe
          </span>
        </button>
      </form>
    </SettingsCard>
  );
};

// ---------------------------------------------------- préférences d'interface

interface InterfaceProps {
  prefs: UiPrefs;
  onChange: (prefs: UiPrefs) => void;
  views: { id: string; label: string }[];
}

export const InterfaceSection: React.FC<InterfaceProps> = ({ prefs, onChange, views }) => {
  const set = <K extends keyof UiPrefs>(key: K, value: UiPrefs[K]) =>
    onChange({ ...prefs, [key]: value });

  return (
    <SettingsCard
      title="Préférences d'affichage"
      description="Enregistrées dans ce navigateur uniquement. Elles ne changent rien pour
                   l'autre administrateur, et ne sont pas envoyées au serveur."
    >
      <FieldRow
        label="Thème"
        help="L'interface est aujourd'hui dessinée en sombre : le mode clair ne repeint que
              le fond de la page, les cartes restent sombres."
      >
        <SegmentedControl
          value={prefs.theme}
          onChange={(theme) => {
            set('theme', theme);
            document.documentElement.dataset.theme = theme;
            document.documentElement.classList.toggle('light', theme === 'light');
          }}
          options={[
            { value: 'dark', label: 'Sombre' },
            { value: 'light', label: 'Clair' },
            { value: 'auto', label: 'Auto' },
          ]}
        />
      </FieldRow>

      <FieldRow label="Vue au démarrage" help="Page ouverte à la connexion.">
        <select
          value={prefs.startView}
          onChange={(e) => set('startView', e.target.value)}
          className={SELECT_CLASS}
        >
          {views.map((view) => (
            <option key={view.id} value={view.id}>{view.label}</option>
          ))}
        </select>
      </FieldRow>

      <FieldRow label="Densité" help="Compact resserre les marges des cartes.">
        <SegmentedControl
          value={prefs.density}
          onChange={(density) => set('density', density)}
          options={[
            { value: 'comfortable', label: 'Confortable' },
            { value: 'compact', label: 'Compact' },
          ]}
        />
      </FieldRow>

      <FieldRow label="Fenêtre par défaut des graphes">
        <SegmentedControl
          value={prefs.chartRange}
          onChange={(chartRange) => set('chartRange', chartRange)}
          options={[
            { value: '1m', label: '1 min' },
            { value: '5m', label: '5 min' },
            { value: '1h', label: '1 h' },
            { value: '6h', label: '6 h' },
          ]}
        />
      </FieldRow>

      <FieldRow
        label="Afficher les réglages avancés"
        help="Montre les réglages fins (cadences internes, capteur pilote, secret de session)
              dans toutes les sections."
      >
        <Toggle
          checked={prefs.showAdvanced}
          onChange={(showAdvanced) => set('showAdvanced', showAdvanced)}
          label="Réglages avancés"
        />
      </FieldRow>
    </SettingsCard>
  );
};

// ------------------------------------------------------------------- avancé

export const AdvancedSection: React.FC<{
  data: SettingsData;
  onReload: () => void;
}> = ({ data, onReload }) => {
  const [busy, setBusy] = useState<string | null>(null);
  const [resetTarget, setResetTarget] = useState<string | null>(null);
  const [files, setFiles] = useState<
    { label: string; path: string; exists: boolean; content: string | null;
      backups: { name: string; size: number; at: number }[] }[] | null>(null);
  const [openFile, setOpenFile] = useState<string | null>(null);

  useEffect(() => {
    api.configFiles().then((res) => setFiles(res.files)).catch(() => setFiles([]));
  }, []);

  const exportConfig = async (withSecrets: boolean) => {
    setBusy('export');
    try {
      const blob = await api.exportConfig(withSecrets);
      const url = URL.createObjectURL(
        new Blob([JSON.stringify(blob, null, 2)], { type: 'application/json' }));
      const link = document.createElement('a');
      link.href = url;
      link.download = `wopr-dashboard-config-${blob.exportedAt.slice(0, 10)}.json`;
      link.click();
      URL.revokeObjectURL(url);
    } catch (error) {
      store.addToast({
        type: 'err', title: 'Export — échec',
        message: error instanceof ApiError ? error.message : String(error),
      });
    } finally {
      setBusy(null);
    }
  };

  const importConfig = async (file: File) => {
    setBusy('import');
    try {
      const parsed = JSON.parse(await file.text());
      const res = await api.importConfig(parsed);
      store.addToast({
        type: 'success', title: 'Import',
        message: `Appliqué : ${res.applied.join(', ')}.`,
      });
      onReload();
    } catch (error) {
      store.addToast({
        type: 'err', title: 'Import — échec',
        message: error instanceof ApiError ? error.message
          : 'Fichier illisible : un export JSON du dashboard est attendu.',
      });
    } finally {
      setBusy(null);
    }
  };

  const doReset = async () => {
    if (!resetTarget) return;
    setBusy('reset');
    try {
      const res = await api.resetSettingsSection(resetTarget);
      store.addToast({
        type: 'success', title: 'Réinitialisation',
        message: res.removed.length
          ? `${res.removed.length} réglage(s) ramené(s) au défaut.`
          : 'Cette section était déjà aux valeurs par défaut.',
      });
      onReload();
    } catch (error) {
      store.addToast({
        type: 'err', title: 'Réinitialisation — échec',
        message: error instanceof ApiError ? error.message : String(error),
      });
    } finally {
      setBusy(null);
      setResetTarget(null);
    }
  };

  const resettable = data.sections.filter(
    (s) => !['thresholds', 'modes', 'interface', 'advanced'].includes(s.id));

  return (
    <div className="space-y-4">
      <SettingsCard
        title="Export et import"
        description="Une archive JSON de la configuration : réglages, seuils et modes. Utile
                     pour garder une trace avant un gros changement, ou repartir d'une base
                     connue."
      >
        <div className="pt-3 flex items-center gap-3 flex-wrap">
          <button
            type="button"
            onClick={() => exportConfig(false)}
            disabled={busy !== null}
            className={BUTTON_GHOST}
          >
            <span className="flex items-center gap-1.5">
              <Download className="w-3.5 h-3.5" /> Exporter (sans les secrets)
            </span>
          </button>
          <label className={`${BUTTON_GHOST} cursor-pointer`}>
            <span className="flex items-center gap-1.5">
              <Upload className="w-3.5 h-3.5" /> Importer un fichier
            </span>
            <input
              type="file"
              accept="application/json"
              className="hidden"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) void importConfig(file);
                e.target.value = '';
              }}
            />
          </label>
          {busy && <Loader2 className="w-4 h-4 animate-spin text-wopr-accent" />}
        </div>
        <p className="text-[11px] text-wopr-textMuted pt-2">
          Le jeton Telegram, l'empreinte du mot de passe et les mots de passe de base ne
          sont jamais exportés.
        </p>
      </SettingsCard>

      <SettingsCard
        title="Réinitialiser une section"
        description="Retire les valeurs enregistrées d'une section : les réglages retombent
                     sur le .env, puis sur les défauts du code."
      >
        <div className="pt-3 flex flex-wrap gap-2">
          {resettable.map((section) => (
            <button
              key={section.id}
              type="button"
              onClick={() => setResetTarget(section.id)}
              className={BUTTON_GHOST}
            >
              <span className="flex items-center gap-1.5">
                <Trash2 className="w-3.5 h-3.5" /> {section.label}
              </span>
            </button>
          ))}
        </div>
      </SettingsCard>

      <SettingsCard
        title="Fichiers de configuration"
        description="Ce que le dashboard lit réellement sur le disque, et les sauvegardes
                     déposées avant chaque écriture."
      >
        <div className="pt-3 space-y-2">
          {files === null && <p className="text-[11px] text-wopr-textMuted">Chargement…</p>}
          {files?.map((file) => (
            <div key={file.path} className="rounded-lg border border-wopr-border overflow-hidden">
              <button
                type="button"
                onClick={() => setOpenFile(openFile === file.path ? null : file.path)}
                className="w-full flex items-center gap-2.5 px-3 py-2 hover:bg-white/[0.02]
                           transition-colors text-left"
              >
                <FileText className="w-3.5 h-3.5 text-wopr-textMuted shrink-0" />
                <span className="text-xs text-wopr-text">{file.label}</span>
                <span className="text-[10px] font-mono text-wopr-textSubtle truncate flex-1">
                  {file.path}
                </span>
                <span className="text-[10px] text-wopr-textMuted shrink-0">
                  {file.backups.length} sauvegarde{file.backups.length > 1 ? 's' : ''}
                </span>
              </button>
              {openFile === file.path && (
                <div className="border-t border-wopr-border/50 p-3 bg-[#0d1117]">
                  {file.content === null ? (
                    <p className="text-[11px] text-wopr-textMuted">
                      {file.label === 'settings.yaml'
                        ? "Contenu non affiché : ce fichier porte le jeton Telegram et "
                          + "l'empreinte du mot de passe."
                        : 'Fichier absent ou illisible.'}
                    </p>
                  ) : (
                    <pre className="text-[10px] font-mono text-wopr-textMuted overflow-x-auto
                                    max-h-72 whitespace-pre">{file.content}</pre>
                  )}
                  {file.backups.length > 0 && (
                    <div className="mt-2 pt-2 border-t border-wopr-border/40 space-y-0.5">
                      {file.backups.slice(0, 5).map((backup) => (
                        <div key={backup.name}
                             className="text-[10px] font-mono text-wopr-textSubtle">
                          {backup.name} — {new Date(backup.at * 1000).toLocaleString('fr-FR')}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
      </SettingsCard>

      <ConfirmDialog
        isOpen={resetTarget !== null}
        title="Réinitialiser cette section ?"
        isDestructive
        description={
          <span>
            Les réglages enregistrés de la section «&nbsp;
            {data.sections.find((s) => s.id === resetTarget)?.label}&nbsp;» seront retirés
            du fichier. Les valeurs reviendront à celles du <code className="font-mono">.env</code>,
            puis aux défauts du code. Une sauvegarde est déposée avant l'écriture.
          </span>
        }
        confirmText="Réinitialiser"
        onConfirm={doReset}
        onCancel={() => setResetTarget(null)}
      />
    </div>
  );
};

// ------------------------------------------------- bandeau « recréation requise »

export const PendingRestartCard: React.FC<{ data: SettingsData }> = ({ data }) => {
  const [copied, setCopied] = useState(false);
  if (data.pendingRestart.length === 0) return null;

  return (
    <div className="rounded-xl border border-wopr-warn/40 bg-wopr-warn/10 p-4 space-y-3">
      <div className="flex items-start gap-2.5">
        <AlertTriangle className="w-4 h-4 text-wopr-warn shrink-0 mt-0.5" />
        <div className="min-w-0">
          <p className="text-xs font-semibold text-wopr-warn">
            {data.pendingRestart.length} réglage{data.pendingRestart.length > 1 ? 's' : ''} en
            attente d'une recréation du conteneur
          </p>
          <p className="text-[11px] text-wopr-warn/80 mt-0.5 leading-relaxed">
            Ces valeurs sont écrites dans le <code className="font-mono">.env</code> mais ne
            sont lues qu'à la création du conteneur. Un simple redémarrage ne suffit pas :
            docker compose ne relit le fichier qu'à la recréation.
          </p>
        </div>
      </div>

      <table className="w-full text-[11px]">
        <tbody className="divide-y divide-wopr-warn/20">
          {data.pendingRestart.map((item) => (
            <tr key={item.key}>
              <td className="py-1.5 pr-3 text-wopr-warn/90">{item.label}</td>
              <td className="py-1.5 font-mono text-wopr-textMuted">
                {item.running} → <span className="text-wopr-warn">{item.saved}</span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <div className="flex items-center gap-2">
        <code className="flex-1 text-[11px] font-mono bg-[#0d1117] border border-wopr-border
                         rounded-lg px-3 py-2 text-wopr-text overflow-x-auto whitespace-nowrap">
          {data.restartCommand}
        </code>
        <button
          type="button"
          onClick={() => {
            navigator.clipboard?.writeText(data.restartCommand);
            setCopied(true);
            setTimeout(() => setCopied(false), 2000);
          }}
          className={BUTTON_GHOST}
          title="Copier la commande"
        >
          {copied ? <Check className="w-3.5 h-3.5 text-wopr-ok" />
                  : <Copy className="w-3.5 h-3.5" />}
        </button>
      </div>
    </div>
  );
};
