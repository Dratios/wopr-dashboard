/**
 * Éditeur de `config/modes.yaml`.
 *
 * Les leviers proposés sont exactement ceux que `modes.py` sait appliquer — pas
 * un de plus. Le serveur refuse par ailleurs de supprimer le mode actif ou le
 * mode de repli, et vérifie chaque valeur avant d'écrire.
 */

import React, { useEffect, useMemo, useState } from 'react';
import {
  Copy, Loader2, Plus, RotateCcw, Save, Trash2, ChevronDown, ChevronRight, AlertTriangle,
} from 'lucide-react';

import { api, ApiError } from '../../state/api';
import { store } from '../../state/store';
import type { ModeDefinition, ModesConfigPayload } from '../../state/settingsTypes';
import {
  BUTTON_GHOST, BUTTON_PRIMARY, INPUT_CLASS, SELECT_CLASS, SettingsCard,
} from '../common/FormControls';

const GOVERNORS = ['performance', 'powersave'];
const EPP = ['performance', 'balance_performance', 'balance_power', 'power', 'default'];
const ICONS = ['zap', 'gauge', 'moon', 'leaf', 'wrench', 'sliders', 'cpu', 'activity'];

const emptyMode = (id: string): ModeDefinition => ({
  id,
  label: 'Nouveau mode',
  icon: 'sliders',
  description: '',
  policies: {
    cpuGovernor: 'powersave',
    cpuEpp: 'balance_performance',
    gpuPowerLimit: 'max',
    fanCurvePreset: null,
    ollamaKeepAlive: '5m',
    containers: { stop: [], start: [] },
  },
});

const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value));

export const ModesEditor: React.FC = () => {
  const [payload, setPayload] = useState<ModesConfigPayload | null>(null);
  const [draft, setDraft] = useState<ModeDefinition[] | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = async () => {
    try {
      const res = await api.modesConfig();
      setPayload(res);
      setDraft(clone(res.content.modes));
    } catch (error) {
      store.addToast({
        type: 'err', title: 'Modes machine',
        message: error instanceof ApiError ? error.message : String(error),
      });
    }
  };

  useEffect(() => { void load(); }, []);

  const dirty = useMemo(
    () => JSON.stringify(payload?.content.modes) !== JSON.stringify(draft),
    [payload, draft],
  );

  if (!draft || !payload) {
    return (
      <SettingsCard title="Modes machine">
        <p className="text-[11px] text-wopr-textMuted py-3">Chargement…</p>
      </SettingsCard>
    );
  }

  const update = (index: number, patch: Partial<ModeDefinition>) =>
    setDraft((d) => d!.map((m, i) => (i === index ? { ...m, ...patch } : m)));

  const updatePolicy = (index: number, key: string, value: unknown) =>
    setDraft((d) => d!.map((m, i) =>
      i === index ? { ...m, policies: { ...m.policies, [key]: value } } : m));

  const duplicate = (index: number) => {
    const source = draft[index];
    let id = `${source.id}-copie`;
    let n = 2;
    while (draft.some((m) => m.id === id)) id = `${source.id}-copie-${n++}`;
    const copy = { ...clone(source), id, label: `${source.label} (copie)` };
    setDraft([...draft.slice(0, index + 1), copy, ...draft.slice(index + 1)]);
    setOpen(id);
  };

  const remove = (index: number) => setDraft(draft.filter((_, i) => i !== index));

  const add = () => {
    let id = 'nouveau';
    let n = 2;
    while (draft.some((m) => m.id === id)) id = `nouveau-${n++}`;
    setDraft([...draft, emptyMode(id)]);
    setOpen(id);
  };

  const save = async () => {
    setBusy(true);
    try {
      const res = await api.saveModesConfig({ modes: draft });
      setPayload({ ...payload, content: res.content as { modes: ModeDefinition[] } });
      setDraft(clone(res.content.modes as ModeDefinition[]));
      store.addToast({
        type: 'success', title: 'Modes machine',
        message: 'Définitions enregistrées et rechargées.',
      });
      await store.refreshModes().catch(() => undefined);
    } catch (error) {
      store.addToast({
        type: 'err', title: 'Modes machine — échec',
        message: error instanceof ApiError ? error.message : String(error),
      });
    } finally {
      setBusy(false);
    }
  };

  const listField = (index: number, side: 'stop' | 'start') => {
    const containers = draft[index].policies.containers ?? { stop: [], start: [] };
    return (
      <input
        type="text"
        value={(containers[side] ?? []).join(', ')}
        placeholder="aucun"
        onChange={(e) =>
          updatePolicy(index, 'containers', {
            ...containers,
            [side]: e.target.value.split(',').map((s) => s.trim()).filter(Boolean),
          })}
        className={`${INPUT_CLASS} font-mono`}
      />
    );
  };

  return (
    <div className="space-y-4">
      <div className="p-3 rounded-lg bg-amber-500/10 border border-amber-500/25
                      flex items-start gap-2.5 text-[11px] text-amber-300">
        <AlertTriangle className="w-4 h-4 text-amber-400 shrink-0 mt-px" />
        <p className="leading-relaxed">
          Les listes de conteneurs sont vides par défaut, volontairement. Ce serveur est
          partagé : un mode ne doit jamais couper, par surprise, un service qui n'est
          pas le vôtre. Remplissez-les en connaissance de cause, et prévenez l'autre
          administrateur.
        </p>
      </div>

      {draft.map((mode, index) => {
        const isOpen = open === mode.id;
        const isActive = mode.id === payload.activeId;
        const isFallback = mode.id === payload.fallbackId;
        return (
          <div key={`${mode.id}-${index}`}
               className="bg-wopr-surface border border-wopr-border rounded-xl overflow-hidden">
            <button
              type="button"
              onClick={() => setOpen(isOpen ? null : mode.id)}
              className="w-full flex items-center gap-3 px-4 py-3 hover:bg-white/[0.02]
                         transition-colors text-left"
            >
              {isOpen ? <ChevronDown className="w-4 h-4 text-wopr-textMuted" />
                      : <ChevronRight className="w-4 h-4 text-wopr-textMuted" />}
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-sm font-semibold text-wopr-text">{mode.label}</span>
                  <span className="text-[10px] font-mono text-wopr-textSubtle">{mode.id}</span>
                  {isActive && (
                    <span className="text-[9px] uppercase tracking-wider px-1.5 py-0.5 rounded
                                     bg-wopr-ok/15 text-wopr-ok border border-wopr-ok/30">
                      actif
                    </span>
                  )}
                  {isFallback && (
                    <span className="text-[9px] uppercase tracking-wider px-1.5 py-0.5 rounded
                                     bg-wopr-accent/15 text-wopr-accent border border-wopr-accent/30">
                      repli
                    </span>
                  )}
                </div>
                {mode.description && (
                  <p className="text-[11px] text-wopr-textMuted mt-0.5 line-clamp-1">
                    {mode.description}
                  </p>
                )}
              </div>
              <div className="flex items-center gap-1 shrink-0"
                   onClick={(e) => e.stopPropagation()}>
                <button
                  type="button"
                  onClick={() => duplicate(index)}
                  title="Dupliquer"
                  className="text-wopr-textMuted hover:text-wopr-text p-1.5 rounded
                             hover:bg-white/5 transition-colors"
                >
                  <Copy className="w-3.5 h-3.5" />
                </button>
                <button
                  type="button"
                  disabled={isActive || isFallback}
                  onClick={() => remove(index)}
                  title={isActive ? 'Le mode actif ne peut pas être supprimé'
                        : isFallback ? 'Le mode de repli ne peut pas être supprimé'
                        : 'Supprimer'}
                  className="text-wopr-textMuted hover:text-wopr-err p-1.5 rounded
                             hover:bg-white/5 transition-colors disabled:opacity-30
                             disabled:cursor-not-allowed disabled:hover:text-wopr-textMuted"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              </div>
            </button>

            {isOpen && (
              <div className="px-4 pb-4 pt-1 border-t border-wopr-border/50 space-y-3
                              animate-in fade-in duration-150">
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                  <Labelled label="Identifiant">
                    <input
                      type="text"
                      value={mode.id}
                      onChange={(e) => {
                        const id = e.target.value.trim();
                        update(index, { id });
                        setOpen(id);
                      }}
                      className={`${INPUT_CLASS} font-mono`}
                    />
                  </Labelled>
                  <Labelled label="Nom affiché">
                    <input
                      type="text"
                      value={mode.label}
                      onChange={(e) => update(index, { label: e.target.value })}
                      className={INPUT_CLASS}
                    />
                  </Labelled>
                  <Labelled label="Icône">
                    <select
                      value={mode.icon ?? 'sliders'}
                      onChange={(e) => update(index, { icon: e.target.value })}
                      className={SELECT_CLASS}
                    >
                      {ICONS.map((icon) => <option key={icon} value={icon}>{icon}</option>)}
                    </select>
                  </Labelled>
                </div>

                <Labelled label="Description">
                  <textarea
                    rows={2}
                    value={mode.description ?? ''}
                    onChange={(e) => update(index, { description: e.target.value })}
                    className={`${INPUT_CLASS} resize-y`}
                  />
                </Labelled>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <Labelled label="Gouverneur CPU">
                    <select
                      value={String(mode.policies.cpuGovernor ?? '')}
                      onChange={(e) => updatePolicy(index, 'cpuGovernor',
                        e.target.value || undefined)}
                      className={SELECT_CLASS}
                    >
                      <option value="">— ne pas toucher —</option>
                      {GOVERNORS.map((g) => <option key={g} value={g}>{g}</option>)}
                    </select>
                  </Labelled>
                  <Labelled label="Préférence de performance (EPP)">
                    <select
                      value={String(mode.policies.cpuEpp ?? '')}
                      onChange={(e) => updatePolicy(index, 'cpuEpp', e.target.value || undefined)}
                      className={SELECT_CLASS}
                    >
                      <option value="">— ne pas toucher —</option>
                      {EPP.map((v) => <option key={v} value={v}>{v}</option>)}
                    </select>
                  </Labelled>
                  <Labelled
                    label="Limite de puissance GPU"
                    help="Watts, « max », « min » ou un pourcentage de la plage de chaque carte."
                  >
                    <input
                      type="text"
                      value={mode.policies.gpuPowerLimit === undefined
                        ? '' : String(mode.policies.gpuPowerLimit)}
                      placeholder="max"
                      onChange={(e) => {
                        const raw = e.target.value.trim();
                        updatePolicy(index, 'gpuPowerLimit',
                          raw === '' ? undefined : /^\d+$/.test(raw) ? Number(raw) : raw);
                      }}
                      className={`${INPUT_CLASS} font-mono`}
                    />
                  </Labelled>
                  <Labelled label="Préréglage de ventilation">
                    <select
                      value={mode.policies.fanCurvePreset ?? ''}
                      onChange={(e) => updatePolicy(index, 'fanCurvePreset',
                        e.target.value === '' ? null : e.target.value)}
                      className={SELECT_CLASS}
                    >
                      <option value="">carte mère (Smart Fan IV)</option>
                      {payload.fanPresets.map((p) => <option key={p} value={p}>{p}</option>)}
                    </select>
                  </Labelled>
                  <Labelled
                    label="Rétention des modèles (Ollama)"
                    help="Durée en VRAM : « 5m », « 1h », 0 pour décharger aussitôt, -1 pour toujours."
                  >
                    <input
                      type="text"
                      value={mode.policies.ollamaKeepAlive === undefined
                        ? '' : String(mode.policies.ollamaKeepAlive)}
                      onChange={(e) => {
                        const raw = e.target.value.trim();
                        updatePolicy(index, 'ollamaKeepAlive',
                          raw === '' ? undefined : /^-?\d+$/.test(raw) ? Number(raw) : raw);
                      }}
                      className={`${INPUT_CLASS} font-mono`}
                    />
                  </Labelled>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <Labelled label="Conteneurs à arrêter" help="Noms séparés par des virgules.">
                    {listField(index, 'stop')}
                  </Labelled>
                  <Labelled label="Conteneurs à démarrer" help="Noms séparés par des virgules.">
                    {listField(index, 'start')}
                  </Labelled>
                </div>
              </div>
            )}
          </div>
        );
      })}

      <div className="flex items-center justify-between gap-3 flex-wrap">
        <button type="button" onClick={add} className={BUTTON_GHOST}>
          <span className="flex items-center gap-1.5">
            <Plus className="w-3.5 h-3.5" /> Ajouter un mode
          </span>
        </button>
        {dirty && (
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={() => setDraft(clone(payload.content.modes))}
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
                Enregistrer les modes
              </span>
            </button>
          </div>
        )}
      </div>
    </div>
  );
};

const Labelled: React.FC<{ label: string; help?: string; children: React.ReactNode }> = ({
  label, help, children,
}) => (
  <div>
    <label className="block text-xs font-medium text-wopr-text mb-1.5">{label}</label>
    {children}
    {help && <p className="text-[10px] text-wopr-textMuted mt-1">{help}</p>}
  </div>
);
