import React, { useState } from 'react';
import { useWoprStore } from '../../state/useWoprStore';
import { Measure, TextValue } from '../common/Measure';
import { store } from '../../state/store';
import { RadialGauge } from '../common/RadialGauge';
import { StackedBar } from '../common/StackedBar';
import { ProgressBar } from '../common/ProgressBar';
import { ConfirmDialog } from '../common/ConfirmDialog';
import {
  Tv2,
  Cpu,
  Zap,
  Thermometer,
  Wind,
  Pin,
  Trash2,
  Plus,
  Play,
  Clock,
  Sliders,
  ShieldCheck,
  CheckCircle2,
  Layers,
} from 'lucide-react';
import { GpuItem, LoadedModel } from '../../state/types';

export const GpuView: React.FC = () => {
  const { gpu } = useWoprStore();
  const { aggregate, gpus, models, availableModels } = gpu;

  const [showLoadModal, setShowLoadModal] = useState(false);
  const [modelToUnload, setModelToUnload] = useState<LoadedModel | null>(null);

  // Load model form state
  // Choisi à l'ouverture de la fenêtre : initialisé au montage de la vue, il restait
  // vide si la liste d'Ollama arrivait après, et « Charger » ne faisait rien.
  const [selectedModelName, setSelectedModelName] = useState('');
  const openLoadModal = () => {
    const loaded = new Set(models.map((m) => m.name));
    setSelectedModelName(
      availableModels.find((m) => !loaded.has(m.name))?.name ?? availableModels[0]?.name ?? '');
    setShowLoadModal(true);
  };

  // Power limit adjustment state
  const [editingPowerGpu, setEditingPowerGpu] = useState<number | null>(null);
  const [newPowerLimit, setNewPowerLimit] = useState<number>(170);

  const vramTotalPct = aggregate.vramTotalMiB ? (aggregate.vramUsedMiB / aggregate.vramTotalMiB) * 100 : 0;
  const pressureStyle = {
    ok: 'bg-emerald-500/15 border-emerald-500/30 text-emerald-300',
    tendu: 'bg-amber-500/15 border-amber-500/30 text-amber-300',
    saturé: 'bg-rose-500/15 border-rose-500/30 text-rose-300',
  }[aggregate.pressure];
  const powerHeadroomW =
    aggregate.powerW !== null && aggregate.powerLimitW !== null ? aggregate.powerLimitW - aggregate.powerW : null;

  // Colors for LLM models stacked bar
  const modelColors = ['#4c9ffe', '#a371f7', '#f0883e', '#3fb950', '#d29922'];

  const vramSegments = models.map((m, idx) => ({
    id: m.id,
    label: m.name.split(':')[0],
    value: m.vramMiB / 1024,
    color: modelColors[idx % modelColors.length],
    unit: 'Gio',
  }));

  const handleOpenPowerModal = (g: GpuItem) => {
    // Une carte dont NVML ne donne ni limite ni plage n'est pas réglable :
    // le bouton est déjà désactivé, on se protège quand même ici.
    if (g.powerLimitW === null || g.powerLimitRangeW === null) return;
    setEditingPowerGpu(g.index);
    setNewPowerLimit(g.powerLimitW);
  };

  // Plage de la carte en cours d'édition, lue via NVML. Chaque carte a la sienne
  // — la RTX 3060 accepte 100-187 W, une P100 aurait d'autres bornes.
  const editedGpuRange: [number, number] =
    (editingPowerGpu !== null
      ? gpus.find((g) => g.index === editingPowerGpu)?.powerLimitRangeW
      : null) ?? [100, 250];

  const handleSavePowerLimit = () => {
    if (editingPowerGpu !== null) {
      store.setGpuPowerLimit(editingPowerGpu, newPowerLimit);
      setEditingPowerGpu(null);
    }
  };

  const handleConfirmLoadModel = () => {
    if (selectedModelName) {
      // Ollama choisit lui-même la répartition sur les cartes et le contexte :
      // l'API ne prend que le nom du modèle.
      store.loadModel(selectedModelName);
      setShowLoadModal(false);
    }
  };

  return (
    <div className="space-y-6 animate-in fade-in duration-200">
      {/* Header & Aggregate Multi-GPU Summary */}
      <div className="bg-wopr-surface border border-wopr-border rounded-xl p-5 space-y-4">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between pb-3 border-b border-wopr-border gap-3">
          <div>
            <h1 className="text-xl font-bold tracking-tight text-wopr-text flex items-center gap-2.5">
              <Tv2 className="w-5 h-5 text-wopr-accent" />
              <span>Accélérateurs Graphiques & Moteurs LLM</span>
            </h1>
            <p className="text-xs text-wopr-textMuted mt-1">
              {gpus.length === 0
                ? (gpu.unavailableReason ?? 'Aucune carte NVIDIA détectée')
                : gpus.map((g) => `${g.name} (${Math.round(g.memTotalMiB / 1024)} Gio)`).join(' + ')}
            </p>
          </div>

          <div className="flex items-center gap-2">
            <span className={`text-xs px-2.5 py-1 rounded-md border font-mono font-semibold ${pressureStyle}`}>
              Pression VRAM : {aggregate.pressure.toUpperCase()}
            </span>
            <button
              onClick={openLoadModal}
              disabled={!gpu.ollamaReachable}
              title={gpu.ollamaReachable ? undefined : 'Ollama injoignable'}
              className="disabled:opacity-40 disabled:cursor-not-allowed flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-wopr-accent hover:bg-wopr-accentHover text-white text-xs font-semibold shadow transition-colors"
            >
              <Plus className="w-4 h-4" />
              <span>Charger un modèle LLM</span>
            </button>
          </div>
        </div>

        {/* Aggregate key metrics strip */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 pt-1">
          <div className="p-3 rounded-lg bg-[#0d1117] border border-wopr-border">
            <span className="text-[11px] text-wopr-textMuted uppercase font-mono">VRAM Totale</span>
            <div className="text-lg font-bold font-mono text-wopr-text mt-1 tabular">
              {(aggregate.vramUsedMiB / 1024).toFixed(1)} / {(aggregate.vramTotalMiB / 1024).toFixed(1)} Gio
            </div>
            <span className="text-[10px] text-wopr-accent font-mono">{vramTotalPct.toFixed(1)} % allouée</span>
          </div>

          <div className="p-3 rounded-lg bg-[#0d1117] border border-wopr-border">
            <span className="text-[11px] text-wopr-textMuted uppercase font-mono">Calcul Moyen</span>
            <div className="text-lg font-bold font-mono text-wopr-text mt-1 tabular">
              {aggregate.utilAvgPct} %
            </div>
            <span className="text-[10px] text-wopr-textMuted font-mono">
              Sur {aggregate.count} GPU
            </span>
          </div>

          <div className="p-3 rounded-lg bg-[#0d1117] border border-wopr-border">
            <span className="text-[11px] text-wopr-textMuted uppercase font-mono">Puissance GPU</span>
            <div className="text-lg font-bold font-mono text-wopr-text mt-1 tabular">
              <Measure value={aggregate.powerW} /> / <Measure value={aggregate.powerLimitW} unit="W" />
            </div>
            <span className={`text-[10px] font-mono ${
              powerHeadroomW === null ? 'text-wopr-textSubtle'
                : powerHeadroomW < 10 ? 'text-amber-400' : 'text-emerald-400'
            }`}>
              {powerHeadroomW === null ? 'non mesurée' : `${powerHeadroomW} W sous la limite`}
            </span>
          </div>

          <div className="p-3 rounded-lg bg-[#0d1117] border border-wopr-border">
            <span className="text-[11px] text-wopr-textMuted uppercase font-mono">Modèles en mémoire</span>
            <div className="text-lg font-bold font-mono text-wopr-text mt-1">
              {models.length} modèle{models.length > 1 ? 's' : ''}
            </div>
            <span className={`text-[10px] font-mono ${gpu.ollamaReachable ? 'text-purple-300' : 'text-rose-400'}`}>
              {gpu.ollamaReachable ? `Ollama ${gpu.ollamaVersion ?? ''}`.trim() : 'Ollama injoignable'}
            </span>
          </div>
        </div>

        {/* Global VRAM Stacked Bar */}
        <div className="pt-2">
          <div className="flex items-center justify-between text-xs mb-1.5 font-medium">
            <span className="text-wopr-textMuted">Répartition globale de la VRAM</span>
            <span className="text-wopr-text font-mono">
              {(aggregate.vramUsedMiB / 1024).toFixed(1)} / {(aggregate.vramTotalMiB / 1024).toFixed(1)} Gio
            </span>
          </div>
          <StackedBar
            total={aggregate.vramTotalMiB / 1024}
            segments={vramSegments}
            height={16}
          />
        </div>
      </div>

      {/* Per-GPU Cards (N GPUs) */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {gpus.map((gpuItem) => {
          const vramPct = (gpuItem.memUsedMiB / gpuItem.memTotalMiB) * 100;
          const powerPct =
            gpuItem.powerW !== null && gpuItem.powerLimitW
              ? (gpuItem.powerW / gpuItem.powerLimitW) * 100
              : 0;

          return (
            <div
              key={gpuItem.index}
              className="bg-wopr-surface border border-wopr-border rounded-xl p-5 flex flex-col justify-between space-y-4 relative overflow-hidden"
            >
              {/* Header */}
              <div>
                <div className="flex items-start justify-between gap-2 pb-3 border-b border-wopr-border">
                  <div>
                    <div className="flex items-center gap-2">
                      <span className="px-2 py-0.5 rounded bg-wopr-surface2 border border-wopr-border text-xs font-mono font-bold text-wopr-accent">
                        GPU {gpuItem.index}
                      </span>
                      <h3 className="text-base font-bold text-wopr-text tracking-wide">
                        {gpuItem.name}
                      </h3>
                    </div>
                    <div className="flex flex-wrap items-center gap-2 mt-1.5 text-[11px] font-mono text-wopr-textMuted">
                      <span>{gpuItem.pcie}</span>
                      <span>•</span>
                      <span>Driver {gpuItem.driver}</span>
                      <span>•</span>
                      <span>VBIOS {gpuItem.vbios}</span>
                      <span>•</span>
                      <span className={gpuItem.hasDisplayOut ? 'text-emerald-400' : 'text-wopr-textSubtle'}>
                        {gpuItem.hasDisplayOut ? 'Sortie vidéo OK' : 'Pas de sortie vidéo'}
                      </span>
                    </div>
                  </div>

                  <button
                    onClick={() => handleOpenPowerModal(gpuItem)}
                    disabled={gpuItem.powerLimitW === null || gpuItem.powerLimitRangeW === null}
                    className="disabled:opacity-40 disabled:cursor-not-allowed p-1.5 rounded-lg bg-white/5 hover:bg-white/10 text-wopr-textMuted hover:text-wopr-text border border-wopr-border transition-colors text-xs flex items-center gap-1 font-mono"
                    title={gpuItem.powerLimitRangeW ? 'Ajuster la limite de puissance (W)' : 'Limite de puissance non réglable sur cette carte'}
                  >
                    <Sliders className="w-3.5 h-3.5" />
                    <span>PL</span>
                  </button>
                </div>

                {/* Gauges row */}
                <div className="grid grid-cols-2 gap-4 my-4 py-2 bg-[#0d1117] rounded-xl border border-wopr-border p-3">
                  <div className="flex flex-col items-center">
                    <RadialGauge
                      value={gpuItem.utilPct}
                      size={110}
                      strokeWidth={10}
                      label="CALCUL GPU"
                      warnThreshold={80}
                      critThreshold={90}
                    />
                  </div>

                  <div className="flex flex-col items-center">
                    <RadialGauge
                      value={vramPct}
                      size={110}
                      strokeWidth={10}
                      label="VRAM"
                      sublabel={`${(gpuItem.memUsedMiB / 1024).toFixed(1)} / ${(gpuItem.memTotalMiB / 1024).toFixed(1)} Gio`}
                      warnThreshold={85}
                      critThreshold={95}
                    />
                  </div>
                </div>

                {/* Thermal, Fan & Power Specs */}
                <div className="grid grid-cols-3 gap-2 text-xs font-mono">
                  {/* Temp */}
                  <div className="p-2.5 rounded-lg bg-[#0d1117] border border-wopr-border">
                    <div className="text-wopr-textMuted flex items-center gap-1 text-[11px] mb-1">
                      <Thermometer className="w-3.5 h-3.5 text-amber-400" />
                      <span>Température</span>
                    </div>
                    <div
                      className={`text-base font-bold tabular ${
                        gpuItem.tempC !== null && gpuItem.tempC >= 80
                          ? 'text-amber-400'
                          : 'text-wopr-text'
                      }`}
                    >
                      <Measure value={gpuItem.tempC} unit="°C"
                        unavailableHint="Température non exposée par cette carte" />
                    </div>
                  </div>

                  {/* Fan / Cooling */}
                  <div className="p-2.5 rounded-lg bg-[#0d1117] border border-wopr-border">
                    <div className="text-wopr-textMuted flex items-center gap-1 text-[11px] mb-1">
                      <Wind className="w-3.5 h-3.5 text-cyan-400" />
                      <span>Ventilation</span>
                    </div>
                    {gpuItem.cooling === 'chassis' ? (
                      <div>
                        <div className="text-xs font-semibold text-wopr-text mt-0.5">
                          Passif (châssis)
                        </div>
                        <div className="text-[10px] text-wopr-textSubtle">
                          Aucun ventilateur sur la carte
                        </div>
                      </div>
                    ) : (
                      <div>
                        <div className="text-base font-bold text-wopr-text tabular">
                          <Measure value={gpuItem.fanPct} unit="%" />
                        </div>
                        <div className="text-[10px] text-wopr-textSubtle"
                             title="NVML ne rapporte qu'un rapport cyclique, pas de tr/min">
                          rapport cyclique
                        </div>
                      </div>
                    )}
                  </div>

                  {/* Power */}
                  <div className="p-2.5 rounded-lg bg-[#0d1117] border border-wopr-border">
                    <div className="text-wopr-textMuted flex items-center gap-1 text-[11px] mb-1">
                      <Zap className="w-3.5 h-3.5 text-wopr-accent" />
                      <span>Puissance</span>
                    </div>
                    <div className="text-base font-bold text-wopr-text tabular">
                      <Measure value={gpuItem.powerW} unit="W" />
                    </div>
                    <div className="text-[10px] text-wopr-textSubtle">
                      Limite : <Measure value={gpuItem.powerLimitW} unit="W" />
                    </div>
                  </div>
                </div>

                {/* ECC : présent seulement sur les cartes qui l'exposent (P100…). Les
                    compteurs sont ceux de NVML depuis le dernier chargement du pilote. */}
                {gpuItem.ecc && (
                  <div
                    className={`mt-3 p-2 rounded-lg border flex items-center justify-between text-xs font-mono ${
                      gpuItem.ecc.uncorrected > 0
                        ? 'bg-rose-500/10 border-rose-500/30 text-rose-300'
                        : gpuItem.ecc.corrected > 0
                          ? 'bg-amber-500/10 border-amber-500/30 text-amber-300'
                          : 'bg-emerald-500/10 border-emerald-500/20 text-emerald-400'
                    }`}
                  >
                    <span className="flex items-center gap-1.5">
                      <ShieldCheck className="w-3.5 h-3.5" />
                      Mémoire ECC
                    </span>
                    <span>
                      {gpuItem.ecc.corrected} corrigée{gpuItem.ecc.corrected > 1 ? 's' : ''} ·{' '}
                      {gpuItem.ecc.uncorrected} non corrigée{gpuItem.ecc.uncorrected > 1 ? 's' : ''}
                    </span>
                  </div>
                )}
              </div>

              {/* Processes running on this GPU */}
              <div className="pt-3 border-t border-wopr-border/60">
                <span className="text-[11px] font-semibold uppercase tracking-wider text-wopr-textMuted block mb-2">
                  Processus actifs sur GPU {gpuItem.index} ({gpuItem.processes.length})
                </span>
                <div className="space-y-1.5">
                  {gpuItem.processes.map((proc, pidx) => (
                    <div
                      key={pidx}
                      className="p-2 rounded bg-[#0d1117] border border-wopr-border flex items-center justify-between text-xs font-mono"
                    >
                      <div className="flex items-center gap-2">
                        <span className="px-1.5 py-0.5 rounded bg-wopr-surface2 text-wopr-textSubtle text-[10px]">
                          {proc.type}
                        </span>
                        <span className="text-wopr-text font-medium">{proc.name}</span>
                        <span className="text-wopr-textMuted text-[10px]">PID {proc.pid}</span>
                      </div>
                      <span className="text-wopr-accent font-bold">
                        {(proc.memMiB / 1024).toFixed(1)} Gio
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {/* Loaded LLM Models Table */}
      <div className="bg-wopr-surface border border-wopr-border rounded-xl p-5 space-y-4">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between pb-3 border-b border-wopr-border gap-2">
          <div className="flex items-center gap-2.5">
            <Layers className="w-5 h-5 text-wopr-accent" />
            <h3 className="text-base font-bold text-wopr-text tracking-wide">
              Modèles LLM actuellement résidents en mémoire
            </h3>
          </div>
          <span className="text-xs font-mono text-wopr-textMuted">
            Moteur d'inférence :{' '}
            <strong className="text-wopr-text">
              {gpu.ollamaReachable ? `Ollama ${gpu.ollamaVersion ?? ''}`.trim() : 'Ollama injoignable'}
            </strong>
          </span>
        </div>

        {models.length === 0 ? (
          <div className="py-8 text-center text-wopr-textMuted text-xs">
            Aucun modèle n'est actuellement chargé en VRAM.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="border-b border-wopr-border text-wopr-textMuted uppercase font-mono text-[11px]">
                <tr>
                  <th className="pb-2 font-medium">Modèle</th>
                  <th className="pb-2 font-medium">Moteur</th>
                  <th className="pb-2 font-medium">GPU(s)</th>
                  <th className="pb-2 font-medium">VRAM Allouée</th>
                  <th className="pb-2 font-medium">Contexte</th>
                  <th className="pb-2 font-medium">Quant</th>
                  <th className="pb-2 font-medium">Débit</th>
                  <th className="pb-2 font-medium">Rétention</th>
                  <th className="pb-2 font-medium text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-wopr-border/50 font-mono">
                {models.map((model) => (
                  <tr key={model.id} className="hover:bg-white/5 transition-colors">
                    <td className="py-3 font-semibold text-wopr-text font-sans">
                      <div className="flex items-center gap-1.5">
                        {model.pinned && <Pin className="w-3.5 h-3.5 text-amber-400 shrink-0" />}
                        <span>{model.name}</span>
                      </div>
                    </td>
                    <td className="py-3 text-wopr-textMuted">{model.engine}</td>
                    <td className="py-3">
                      <div className="flex gap-1">
                        {model.gpus.map((g) => (
                          <span
                            key={g}
                            className="px-1.5 py-0.5 rounded bg-wopr-surface2 text-wopr-accent text-[10px] font-bold border border-wopr-border"
                          >
                            GPU {g}
                          </span>
                        ))}
                      </div>
                    </td>
                    <td className="py-3 font-bold text-wopr-text">
                      {(model.vramMiB / 1024).toFixed(1)} Gio
                    </td>
                    <td className="py-3 text-wopr-textMuted">
                      {model.contextTokens ? `${model.contextTokens} tokens` : '—'}
                    </td>
                    <td className="py-3 text-wopr-textMuted">{model.quant}</td>
                    <td className="py-3 text-emerald-400 font-bold">
                      {model.tokensPerSec ? `~${model.tokensPerSec} tok/s` : '—'}
                    </td>
                    <td className="py-3">
                      {/* Ollama ne dit pas si un modèle génère : on affiche sa rétention. */}
                      {model.pinned ? (
                        <span className="px-2 py-0.5 rounded-full bg-amber-500/15 text-amber-400 text-[10px] font-semibold border border-amber-500/30">
                          Épinglé
                        </span>
                      ) : (
                        <span
                          className="px-2 py-0.5 rounded-full bg-emerald-500/15 text-emerald-400 text-[10px] font-semibold border border-emerald-500/30"
                          title={model.expiresAt ? `Déchargement prévu à ${new Date(model.expiresAt).toLocaleTimeString('fr-FR')}` : undefined}
                        >
                          {model.expiresAt
                            ? `En VRAM jusqu'à ${new Date(model.expiresAt).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })}`
                            : 'En VRAM'}
                        </span>
                      )}
                    </td>
                    <td className="py-3 text-right">
                      <div className="flex items-center justify-end gap-2">
                        <button
                          onClick={() => store.pinModel(model.name, !model.pinned)}
                          className={`p-1.5 rounded hover:bg-white/10 transition-colors ${
                            model.pinned ? 'text-amber-400' : 'text-wopr-textMuted'
                          }`}
                          title={model.pinned ? 'Détacher (expiration auto)' : 'Épingler en mémoire'}
                        >
                          <Pin className="w-3.5 h-3.5" />
                        </button>
                        <button
                          onClick={() => setModelToUnload(model)}
                          className="px-2.5 py-1 rounded bg-rose-500/15 hover:bg-rose-500/25 text-rose-300 font-sans text-xs border border-rose-500/30 transition-colors"
                        >
                          Décharger
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Unload confirmation dialog */}
      <ConfirmDialog
        isOpen={!!modelToUnload}
        title="Décharger le modèle LLM"
        description={
          <div>
            <p>
              Voulez-vous libérer la mémoire VRAM occupée par{' '}
              <strong className="text-wopr-text">{modelToUnload?.name}</strong> ?
            </p>
            <p className="mt-2 text-xs text-wopr-textMuted">
              {(modelToUnload?.vramMiB ? (modelToUnload.vramMiB / 1024).toFixed(1) : 0)} Gio seront
              immédiatement libérés{modelToUnload?.gpus.length ? ` sur GPU ${modelToUnload.gpus.join(', ')}` : ''}.
            </p>
          </div>
        }
        confirmText="Décharger de la VRAM"
        onConfirm={() => {
          if (modelToUnload) {
            // Le nom : Ollama identifie un modèle par son nom, pas par l'empreinte
            // tronquée qui sert de clé à la vue.
            store.unloadModel(modelToUnload.name);
            setModelToUnload(null);
          }
        }}
        onCancel={() => setModelToUnload(null)}
      />

      {/* Load Model Modal */}
      {showLoadModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/75 backdrop-blur-sm animate-in fade-in">
          <div className="w-full max-w-md bg-[#161b22] border border-wopr-border rounded-xl p-5 shadow-2xl space-y-4">
            <h3 className="text-sm font-semibold text-wopr-text tracking-wide pb-2 border-b border-wopr-border">
              Charger un modèle LLM en mémoire GPU
            </h3>

            <div>
              <label className="block text-xs font-medium text-wopr-textMuted mb-1">
                Modèles installés dans Ollama :
              </label>
              {availableModels.length === 0 && (
                <p className="text-xs text-wopr-textMuted mb-2">Ollama ne liste aucun modèle installé.</p>
              )}
              <select
                value={selectedModelName}
                onChange={(e) => setSelectedModelName(e.target.value)}
                className="w-full bg-[#0d1117] border border-wopr-border rounded-lg p-2 text-xs text-wopr-text focus:outline-none focus:border-wopr-accent"
              >
                {availableModels.map((m) => (
                  <option key={m.name} value={m.name}>
                    {m.name} (~{m.sizeGiB} Gio - {m.quant})
                  </option>
                ))}
              </select>
            </div>

            <p className="text-[11px] text-wopr-textMuted leading-relaxed bg-[#0d1117] border border-wopr-border rounded-lg p-2.5">
              La répartition sur les cartes et la fenêtre de contexte sont décidées
              par Ollama à partir de la VRAM disponible — son API ne permet pas de les
              imposer. Les réglages correspondants ont été retirés plutôt que laissés
              sans effet.
            </p>

            <div className="flex justify-end gap-2 pt-3 border-t border-wopr-border">
              <button
                onClick={() => setShowLoadModal(false)}
                className="px-3 py-1.5 rounded-lg text-xs text-wopr-textMuted hover:text-wopr-text hover:bg-white/5"
              >
                Annuler
              </button>
              <button
                onClick={handleConfirmLoadModel}
                disabled={!selectedModelName}
                className="disabled:opacity-40 disabled:cursor-not-allowed px-4 py-1.5 rounded-lg bg-wopr-accent hover:bg-wopr-accentHover text-white text-xs font-semibold shadow"
              >
                Charger en mémoire
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Power Limit Adjustment Modal */}
      {editingPowerGpu !== null && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/75 backdrop-blur-sm animate-in fade-in">
          <div className="w-full max-w-sm bg-[#161b22] border border-wopr-border rounded-xl p-5 shadow-2xl space-y-4">
            <h3 className="text-sm font-semibold text-wopr-text tracking-wide pb-2 border-b border-wopr-border">
              Ajuster la limite de puissance (GPU {editingPowerGpu})
            </h3>

            <div>
              <div className="flex justify-between text-xs font-mono mb-2">
                <span className="text-wopr-textMuted">Limite consigne :</span>
                <span className="font-bold text-wopr-accent text-sm">{newPowerLimit} W</span>
              </div>
              <input
                type="range"
                min={editedGpuRange[0]}
                max={editedGpuRange[1]}
                value={newPowerLimit}
                onChange={(e) => setNewPowerLimit(Number(e.target.value))}
                className="w-full accent-wopr-accent cursor-pointer"
              />
              <div className="flex justify-between text-[10px] font-mono text-wopr-textSubtle mt-1">
                <span>Min : {editedGpuRange[0]} W</span>
                <span>Max : {editedGpuRange[1]} W</span>
              </div>
            </div>

            <div className="flex justify-end gap-2 pt-2 border-t border-wopr-border">
              <button
                onClick={() => setEditingPowerGpu(null)}
                className="px-3 py-1.5 rounded-lg text-xs text-wopr-textMuted hover:text-wopr-text"
              >
                Annuler
              </button>
              <button
                onClick={handleSavePowerLimit}
                className="px-3.5 py-1.5 rounded-lg bg-wopr-accent hover:bg-wopr-accentHover text-white text-xs font-semibold"
              >
                Appliquer
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
