/**
 * Éditeur de `config/thresholds.yaml`.
 *
 * Écrit le fichier puis demande au moteur d'alertes de le relire : l'effet est
 * visible au tick suivant, sans redémarrage. Le fichier reste modifiable à la
 * main, et ses commentaires sont préservés à l'écriture.
 */

import React, { useEffect, useMemo, useState } from 'react';
import { Plus, Trash2, Save, RotateCcw, Loader2 } from 'lucide-react';

import { api, ApiError } from '../../state/api';
import { store } from '../../state/store';
import {
  BUTTON_GHOST, BUTTON_PRIMARY, INPUT_CLASS, SettingsCard, Toggle,
} from '../common/FormControls';

const SECTION_LABELS: Record<string, string> = {
  disque: 'Disques et montages',
  charge: 'Charge processeur',
  memoire: 'Mémoire vive et swap',
  gpu: 'Cartes graphiques',
  docker: 'Conteneurs',
  reseau: 'Réseau',
  systeme: 'Système',
};

const KEY_LABELS: Record<string, { label: string; help?: string; unit?: string }> = {
  warnPct: { label: 'Avertissement', unit: '%' },
  critPct: { label: 'Alerte critique', unit: '%' },
  warnRatio: {
    label: 'Avertissement',
    help: 'Charge sur 5 min rapportée au nombre de threads. 1.0 = tous occupés.',
  },
  critRatio: { label: 'Alerte critique' },
  swapWarnPct: { label: 'Avertissement swap', unit: '%' },
  vramWarnPct: { label: 'Avertissement VRAM', unit: '%' },
  vramCritPct: { label: 'Alerte critique VRAM', unit: '%' },
  tempWarnC: { label: 'Avertissement température', unit: '°C' },
  tempCritC: { label: 'Alerte critique température', unit: '°C' },
  restartsWarn: { label: 'Avertissement redémarrages' },
  restartsCrit: { label: 'Alerte critique redémarrages' },
  signalerArretsInattendus: {
    label: 'Signaler les arrêts inattendus',
    help: 'Un conteneur en « unless-stopped » qui est arrêté a probablement échoué.',
  },
  erreursWarn: { label: 'Erreurs cumulées sur une interface' },
  gatewayWarnMs: { label: 'Latence passerelle', unit: 'ms' },
  signalerRebootRequis: { label: 'Signaler qu\'un redémarrage est requis' },
  signalerAbsencePareFeu: { label: 'Signaler l\'absence de pare-feu' },
};

type Content = Record<string, any>;

const clone = (value: Content): Content => JSON.parse(JSON.stringify(value));

export const ThresholdsEditor: React.FC = () => {
  const [server, setServer] = useState<Content | null>(null);
  const [draft, setDraft] = useState<Content | null>(null);
  const [busy, setBusy] = useState(false);
  const [newMount, setNewMount] = useState('');

  const load = async () => {
    try {
      const res = await api.thresholds();
      setServer(res.content);
      setDraft(clone(res.content));
    } catch (error) {
      store.addToast({
        type: 'err', title: 'Seuils d\'alerte',
        message: error instanceof ApiError ? error.message : String(error),
      });
    }
  };

  useEffect(() => { void load(); }, []);

  const dirty = useMemo(
    () => JSON.stringify(server) !== JSON.stringify(draft),
    [server, draft],
  );

  if (!draft || !server) {
    return (
      <SettingsCard title="Seuils d'alerte">
        <p className="text-[11px] text-wopr-textMuted py-3">Chargement…</p>
      </SettingsCard>
    );
  }

  const setValue = (section: string, key: string, value: unknown) =>
    setDraft((d) => ({ ...d!, [section]: { ...d![section], [key]: value } }));

  const setMount = (path: string, key: string, value: number) =>
    setDraft((d) => ({
      ...d!,
      disque: {
        ...d!.disque,
        parMontage: {
          ...(d!.disque.parMontage ?? {}),
          [path]: { ...((d!.disque.parMontage ?? {})[path] ?? {}), [key]: value },
        },
      },
    }));

  const removeMount = (path: string) =>
    setDraft((d) => {
      const parMontage = { ...(d!.disque.parMontage ?? {}) };
      delete parMontage[path];
      return { ...d!, disque: { ...d!.disque, parMontage } };
    });

  const addMount = () => {
    const path = newMount.trim();
    if (!path.startsWith('/')) {
      store.addToast({
        type: 'warn', title: 'Point de montage',
        message: 'Un chemin absolu est attendu, par exemple /mnt/Big.',
      });
      return;
    }
    setDraft((d) => ({
      ...d!,
      disque: {
        ...d!.disque,
        parMontage: {
          ...(d!.disque.parMontage ?? {}),
          [path]: { warnPct: d!.disque.warnPct, critPct: d!.disque.critPct },
        },
      },
    }));
    setNewMount('');
  };

  const save = async () => {
    setBusy(true);
    try {
      const res = await api.saveThresholds(draft);
      setServer(res.content);
      setDraft(clone(res.content));
      store.addToast({
        type: 'success', title: 'Seuils d\'alerte',
        message: 'Enregistrés et rechargés — effet au prochain relevé.',
      });
    } catch (error) {
      store.addToast({
        type: 'err', title: 'Seuils d\'alerte — échec',
        message: error instanceof ApiError ? error.message : String(error),
      });
    } finally {
      setBusy(false);
    }
  };

  const mounts: Record<string, any> = draft.disque?.parMontage ?? {};

  return (
    <div className="space-y-4">
      {Object.entries(draft).map(([section, values]) => (
        <SettingsCard key={section} title={SECTION_LABELS[section] ?? section}>
          {Object.entries(values as Record<string, unknown>)
            .filter(([key]) => key !== 'parMontage')
            .map(([key, value]) => {
              const meta = KEY_LABELS[key] ?? { label: key };
              const changed =
                JSON.stringify((server[section] ?? {})[key]) !== JSON.stringify(value);
              return (
                <div
                  key={key}
                  className={`flex items-center justify-between gap-3 py-2.5 px-2 -mx-1
                              rounded-lg ${changed ? 'bg-wopr-accent/5' : ''}`}
                >
                  <div className="min-w-0">
                    <div className="text-xs text-wopr-text">{meta.label}</div>
                    {meta.help && (
                      <p className="text-[11px] text-wopr-textMuted mt-0.5">{meta.help}</p>
                    )}
                    <div className="text-[10px] text-wopr-textSubtle font-mono">
                      {section}.{key}
                    </div>
                  </div>
                  {typeof value === 'boolean' ? (
                    <Toggle
                      checked={value}
                      onChange={(v) => setValue(section, key, v)}
                      label={meta.label}
                    />
                  ) : (
                    <div className="flex items-center gap-2 shrink-0">
                      <input
                        type="number"
                        step={key.endsWith('Ratio') ? 0.1 : 1}
                        value={String(value)}
                        onChange={(e) =>
                          setValue(section, key, e.target.value === ''
                            ? '' : Number(e.target.value))}
                        className={`${INPUT_CLASS} w-24 font-mono tabular`}
                      />
                      {meta.unit && (
                        <span className="text-[11px] text-wopr-textMuted w-6">{meta.unit}</span>
                      )}
                    </div>
                  )}
                </div>
              );
            })}

          {section === 'disque' && (
            <div className="pt-3 space-y-2">
              <div className="text-[11px] text-wopr-textMuted leading-relaxed">
                Surcharges par point de montage. Utile là où le pourcentage général
                n'a pas de sens : sur un volume de 11 To, 80 % laisse encore 2 To.
              </div>
              {Object.keys(mounts).length === 0 && (
                <p className="text-[11px] text-wopr-textSubtle">Aucune surcharge.</p>
              )}
              {Object.entries(mounts).map(([path, override]) => (
                <div key={path} className="flex items-center gap-2 flex-wrap">
                  <span className="font-mono text-[11px] text-wopr-text w-40 truncate"
                        title={path}>{path}</span>
                  <label className="text-[10px] text-wopr-textMuted">avert.</label>
                  <input
                    type="number"
                    value={String((override as any).warnPct ?? '')}
                    onChange={(e) => setMount(path, 'warnPct', Number(e.target.value))}
                    className={`${INPUT_CLASS} w-20 font-mono tabular`}
                  />
                  <label className="text-[10px] text-wopr-textMuted">crit.</label>
                  <input
                    type="number"
                    value={String((override as any).critPct ?? '')}
                    onChange={(e) => setMount(path, 'critPct', Number(e.target.value))}
                    className={`${INPUT_CLASS} w-20 font-mono tabular`}
                  />
                  <button
                    type="button"
                    onClick={() => removeMount(path)}
                    className="text-wopr-textMuted hover:text-wopr-err p-1 rounded
                               hover:bg-white/5 transition-colors"
                    title="Retirer cette surcharge"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
              ))}
              <div className="flex items-center gap-2 pt-1">
                <input
                  type="text"
                  value={newMount}
                  placeholder="/mnt/…"
                  onChange={(e) => setNewMount(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addMount(); } }}
                  className={`${INPUT_CLASS} w-48 font-mono`}
                />
                <button type="button" onClick={addMount} className={BUTTON_GHOST}>
                  <span className="flex items-center gap-1.5">
                    <Plus className="w-3.5 h-3.5" /> Ajouter
                  </span>
                </button>
              </div>
            </div>
          )}
        </SettingsCard>
      ))}

      {dirty && (
        <div className="flex items-center justify-end gap-3">
          <button
            type="button"
            onClick={() => setDraft(clone(server))}
            className={BUTTON_GHOST}
          >
            <span className="flex items-center gap-1.5">
              <RotateCcw className="w-3.5 h-3.5" /> Annuler
            </span>
          </button>
          <button type="button" onClick={save} disabled={busy} className={BUTTON_PRIMARY}>
            <span className="flex items-center gap-1.5">
              {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    : <Save className="w-3.5 h-3.5" />}
              Enregistrer les seuils
            </span>
          </button>
        </div>
      )}
    </div>
  );
};
