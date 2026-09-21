import React, { useEffect, useState } from 'react';
import { useWoprStore } from '../../state/useWoprStore';
import { store } from '../../state/store';
import { Sparkline } from '../common/Sparkline';
import { SeriesConfig, TimeSeriesChart } from '../common/TimeSeriesChart';
import {
  ThermometerSnowflake,
  Wind,
  AlertTriangle,
  Sliders,
  Sparkles,
  RotateCcw,
} from 'lucide-react';
import { FanCurvePoint, FanItem, TempSensor } from '../../state/types';

const SERIES_COLORS = ['#4c9ffe', '#f85149', '#d29922', '#3fb950', '#a371f7', '#39c5cf', '#db61a2'];

/**
 * Sondes tracées par défaut : package CPU, SSD NVMe et carte mère. L'ancienne
 * présélection visait des identifiants de maquette (`cpu_pkg`, `gpu0`, `nvme_llm`)
 * qui n'existent pas : le graphe s'ouvrait vide.
 */
function defaultSensorIds(sensors: TempSensor[]): string[] {
  const pick = (source: string) => sensors.find((s) => s.source === source)?.id;
  const ids = [pick('k10temp'), pick('nvme'), pick('nct6799')].filter((id): id is string => !!id);
  return ids.length ? ids : sensors.slice(0, 3).map((s) => s.id);
}

/**
 * Curseur d'un palier de courbe. La valeur suit le glissement localement et n'est
 * envoyée qu'au relâchement : l'ancien curseur appelait l'API à chaque cran, soit
 * une écriture PWM, une ligne d'audit et un toast par pixel parcouru.
 */
const CurvePointEditor: React.FC<{ index: number; point: FanCurvePoint; disabled: boolean }> = ({
  index,
  point,
  disabled,
}) => {
  const [draft, setDraft] = useState(point.duty);
  const [editing, setEditing] = useState(false);

  useEffect(() => {
    if (!editing) setDraft(point.duty);
  }, [point.duty, editing]);

  const commit = () => {
    setEditing(false);
    if (draft !== point.duty) void store.updateFanCurvePoint(index, point.temp, draft);
  };

  return (
    <div className="p-3.5 rounded-xl bg-[#0d1117] border border-wopr-border flex flex-col justify-between gap-2">
      <div className="flex items-center justify-between text-xs font-mono">
        <span className="text-wopr-textMuted">Palier {index + 1}</span>
        <span className="text-amber-400 font-bold">{point.temp} °C</span>
      </div>

      <div>
        <div className="flex justify-between text-xs font-mono mb-1">
          <span className="text-wopr-textSubtle">Consigne :</span>
          <span className="font-bold text-wopr-accent">{draft} %</span>
        </div>
        <input
          type="range"
          min={10}
          max={100}
          value={draft}
          disabled={disabled}
          onChange={(e) => {
            setEditing(true);
            setDraft(Number(e.target.value));
          }}
          onPointerUp={commit}
          onKeyUp={commit}
          onBlur={() => editing && commit()}
          className="w-full accent-wopr-accent cursor-pointer disabled:cursor-not-allowed disabled:opacity-40"
        />
      </div>

      <div className="text-[10px] text-wopr-textSubtle font-mono text-center">
        À {point.temp} °C → {draft} % (interpolé entre les paliers)
      </div>
    </div>
  );
};

const FAN_MODE_BADGE: Record<FanItem['mode'], { label: string; className: string }> = {
  auto: { label: 'carte mère', className: 'bg-wopr-surface2 text-wopr-textMuted border-wopr-border' },
  curve: { label: 'courbe', className: 'bg-wopr-accent/20 text-wopr-accent border-wopr-accent/40' },
  manual: { label: 'manuel', className: 'bg-purple-500/20 text-purple-300 border-purple-500/40' },
};

export const ThermalFansView: React.FC = () => {
  const { thermal, modes } = useWoprStore();
  const { sensors, fans, fanHistory, fansAvailable, fansUnavailableReason, controlTempC,
    failsafeEngaged, failsafeReason,
    curvePresets, activeCurvePreset, presetForcedByMode, currentCurvePoints } =
    thermal;

  // `null` tant que l'utilisateur n'a rien coché : on applique la présélection.
  const [chosenSensorIds, setChosenSensorIds] = useState<string[] | null>(null);
  const selectedSensorIds = chosenSensorIds ?? defaultSensorIds(sensors);
  const [editingFan, setEditingFan] = useState<FanItem | null>(null);
  const [manualDuty, setManualDuty] = useState<number>(50);

  const toggleSensorSelection = (id: string) => {
    setChosenSensorIds(
      selectedSensorIds.includes(id) ? selectedSensorIds.filter((s) => s !== id) : [...selectedSensorIds, id],
    );
  };

  const handleOpenFanControl = (fan: FanItem) => {
    setEditingFan(fan);
    setManualDuty(fan.dutyPct);
  };

  const handleApplyFanDuty = () => {
    if (editingFan) {
      store.controlFan(editingFan.id, 'manual', manualDuty);
      setEditingFan(null);
    }
  };

  // Prepare chart series from selected sensors
  const selectedSensors = sensors.filter((s) => selectedSensorIds.includes(s.id));
  const chartSeries: SeriesConfig[] = selectedSensors.map((s) => ({
    id: s.id,
    name: s.label,
    color: SERIES_COLORS[sensors.indexOf(s) % SERIES_COLORS.length],
    unit: '°C',
    data: s.history.map((h) => h.temp),
  }));
  const chartTimestamps = (sensors.find((s) => selectedSensorIds.includes(s.id))?.history ?? []).map((h) => h.time);
  // Régime moyen aligné par la fin sur les horodatages des sondes : les deux
  // historiques sont alimentés par le même échantillonnage côté serveur.
  const fanRpm = fanHistory.slice(-chartTimestamps.length).map((h) => h.rpm);
  if (fans.length > 0) {
    chartSeries.push({
      id: 'fans-avg',
      name: 'Ventilateurs, moyenne (tr/min, axe droit)',
      color: '#8b949e',
      unit: 'tr/min',
      data: fanRpm,
      axis: 'right',
    });
  }
  // Seuils du graphe : les plus bas parmi les sondes affichées, pour ne masquer
  // aucun dépassement.
  const chartWarn = selectedSensors.length ? Math.min(...selectedSensors.map((s) => s.warnC)) : undefined;
  const chartCrit = selectedSensors.length ? Math.min(...selectedSensors.map((s) => s.critC)) : undefined;
  const controllableCount = fans.filter((f) => f.controllable).length;

  return (
    <div className="space-y-6 animate-in fade-in duration-200">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pb-4 border-b border-wopr-border">
        <div>
          <h1 className="text-xl font-bold tracking-tight text-wopr-text flex items-center gap-2.5">
            <ThermometerSnowflake className="w-5 h-5 text-wopr-accent" />
            <span>Thermique, Sondes & Ventilation Châssis</span>
          </h1>
          <p className="text-xs text-wopr-textMuted mt-1">
            {sensors.length} sonde{sensors.length > 1 ? 's' : ''} thermique{sensors.length > 1 ? 's' : ''} ·{' '}
            {fans.length} ventilateur{fans.length > 1 ? 's' : ''} détecté{fans.length > 1 ? 's' : ''}, dont{' '}
            {controllableCount} pilotable{controllableCount > 1 ? 's' : ''}
          </p>
        </div>

        {presetForcedByMode && (
          <div className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-[#4c9ffe]/15 border border-[#4c9ffe]/30 text-xs text-wopr-accent font-medium">
            <Sparkles className="w-3.5 h-3.5" />
            <span>
              Courbe imposée par le mode{' '}
              <strong>{modes.modes.find((m) => m.id === presetForcedByMode)?.label ?? presetForcedByMode}</strong>
            </span>
          </div>
        )}
      </div>

      {/* SECTION 1: TEMPS SENSORS GRID */}
      <div>
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-xs font-semibold uppercase tracking-wider text-wopr-text">
            Capteurs de température en direct
          </h3>
          <span className="text-xs text-wopr-textMuted">Cochez pour superposer sur le graphe</span>
        </div>

        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-7 gap-3">
          {sensors.map((s) => {
            const isWarn = s.tempC >= s.warnC;
            const isCrit = s.tempC >= s.critC;
            const isSelected = selectedSensorIds.includes(s.id);

            return (
              <div
                key={s.id}
                onClick={() => toggleSensorSelection(s.id)}
                className={`p-3.5 rounded-xl border cursor-pointer transition-all duration-150 flex flex-col justify-between ${
                  isSelected
                    ? 'bg-wopr-surface2 border-wopr-accent/60 shadow-md ring-1 ring-wopr-accent/30'
                    : 'bg-wopr-surface border-wopr-border hover:bg-white/5'
                }`}
              >
                <div>
                  <div className="flex items-start justify-between gap-1 mb-1">
                    <span className="text-[11px] font-semibold text-wopr-textMuted truncate">
                      {s.label}
                    </span>
                    <input
                      type="checkbox"
                      checked={isSelected}
                      readOnly
                      className="accent-wopr-accent rounded pointer-events-none w-3.5 h-3.5"
                    />
                  </div>

                  <div className="flex items-baseline gap-1 mt-1">
                    <span
                      className={`text-xl font-bold font-mono tabular ${
                        isCrit ? 'text-rose-400' : isWarn ? 'text-amber-400' : 'text-wopr-text'
                      }`}
                    >
                      {s.tempC}
                    </span>
                    <span className="text-xs text-wopr-textMuted font-mono">°C</span>
                    {s.delta !== null && s.delta !== 0 && (
                      <span
                        title="Variation sur 30 s"
                        className={`text-[10px] font-mono ml-auto ${
                          s.delta > 0 ? 'text-rose-400' : 'text-emerald-400'
                        }`}
                      >
                        {s.delta > 0 ? `+${s.delta}` : s.delta}
                      </span>
                    )}
                  </div>
                </div>

                <div className="mt-2 pt-2 border-t border-wopr-border/40 flex items-center justify-between text-[10px] font-mono text-wopr-textSubtle">
                  <span title={`Critique : ${s.critC} °C`}>Alerte : {s.warnC} °C</span>
                  {s.spark && (
                    <Sparkline
                      data={s.spark}
                      color={isCrit ? '#f85149' : isWarn ? '#d29922' : '#4c9ffe'}
                      width={40}
                      height={16}
                    />
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Multi-series chart */}
      <TimeSeriesChart
        title="Courbes thermiques sélectionnées (°C) et régime des ventilateurs"
        series={chartSeries}
        timestamps={chartTimestamps}
        historyMetrics={Object.fromEntries(
          chartSeries.map((s) => [s.id, s.id === 'fans-avg' ? 'fan:avg' : `temp:${s.id}`]),
        )}
        warnThreshold={chartWarn}
        critThreshold={chartCrit}
        height={210}
      />

      {/* SECTION 2: FANS LIST & CONTROLS */}
      <div>
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-2">
            <Wind className="w-4 h-4 text-cyan-400" />
            <h3 className="text-xs font-semibold uppercase tracking-wider text-wopr-text">
              Ventilateurs Châssis & Refroidissement
            </h3>
          </div>
          <span className="text-xs text-wopr-textMuted">
            {fans.length} détecté{fans.length > 1 ? 's' : ''} ·{' '}
            {controllableCount} pilotable{controllableCount > 1 ? 's' : ''}
            {controlTempC !== null && ` · référence ${controlTempC.toFixed(1)} °C`}
          </span>
        </div>

        {failsafeEngaged && (
          <div
            role="alert"
            className="mb-3 p-3 rounded-lg bg-wopr-err/10 border border-wopr-err/40 text-xs text-wopr-err leading-relaxed"
          >
            <strong>Chien de garde thermique déclenché.</strong> Le pilotage a été rendu
            à la carte mère pour protéger la machine{failsafeReason ? ` — ${failsafeReason}` : ''}.
            Les commandes ci-dessous restent refusées tant que la température n'est pas
            redescendue.
          </div>
        )}

        {!fansAvailable && (
          <div className="p-4 rounded-xl bg-wopr-surface border border-dashed border-wopr-border text-xs text-wopr-textMuted leading-relaxed">
            {fansUnavailableReason ??
              "Aucun ventilateur n'est exposé par le noyau sur cette machine."}
          </div>
        )}

        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {fans.map((fan) => {
            const isStall = fan.fault === 'stall';

            return (
              <div
                key={fan.id}
                className={`bg-wopr-surface border rounded-xl p-4 flex flex-col justify-between space-y-3 relative ${
                  isStall
                    ? 'border-rose-500/50 bg-rose-500/10'
                    : 'border-wopr-border'
                }`}
              >
                {/* Header */}
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <h4 className="text-sm font-semibold text-wopr-text">{fan.label}</h4>
                    <span className="text-[11px] font-mono text-wopr-textMuted">
                      {fan.mode === 'curve'
                        ? `Courbe « ${activeCurvePreset} » sur ${fan.sourceSensor ?? 'la température CPU'}`
                        : fan.mode === 'manual'
                          ? 'Consigne fixe'
                          : 'Smart Fan de la carte mère'}
                    </span>
                  </div>

                  <span
                    className={`px-2 py-0.5 rounded text-[10px] font-mono font-bold uppercase border ${FAN_MODE_BADGE[fan.mode].className}`}
                  >
                    {FAN_MODE_BADGE[fan.mode].label}
                  </span>
                </div>

                {/* Main metric row */}
                <div className="flex items-center justify-between py-2">
                  <div>
                    <span className="text-[11px] text-wopr-textMuted uppercase font-mono">Vitesse</span>
                    <div className="flex items-baseline gap-1 mt-0.5">
                      <span
                        className={`text-2xl font-bold font-mono tabular ${
                          isStall ? 'text-rose-400 animate-pulse' : 'text-wopr-text'
                        }`}
                      >
                        {fan.rpm}
                      </span>
                      <span className="text-xs font-mono text-wopr-textMuted">RPM</span>
                    </div>
                  </div>

                  <div className="text-right">
                    <span className="text-[11px] text-wopr-textMuted uppercase font-mono">Rapport PWM</span>
                    <div className="text-lg font-bold font-mono text-wopr-text mt-0.5 tabular">
                      {fan.dutyPct} %
                    </div>
                  </div>
                </div>

                {/* Stall Alert Banner if 0 RPM */}
                {isStall && (
                  <div className="p-2 rounded-lg bg-rose-500/20 border border-rose-500/40 flex items-center gap-2 text-xs text-rose-200">
                    <AlertTriangle className="w-4 h-4 text-rose-400 shrink-0" />
                    <span>0 tr/min alors que le ventilateur est commandé à {fan.dutyPct} % : il est peut-être bloqué.</span>
                  </div>
                )}

                {/* Actions */}
                <div className="pt-2 border-t border-wopr-border/50 flex items-center justify-between">
                  {fan.controllable ? (
                    <button
                      onClick={() => handleOpenFanControl(fan)}
                      disabled={failsafeEngaged}
                      className="text-xs text-wopr-accent hover:underline flex items-center gap-1 font-medium disabled:opacity-40 disabled:no-underline"
                    >
                      <Sliders className="w-3 h-3" />
                      <span>Régler consigne</span>
                    </button>
                  ) : (
                    <span className="text-[11px] text-wopr-textSubtle">Pas de sortie PWM pilotable</span>
                  )}

                  {/* Sortie du mode manuel : vers la courbe active s'il y en a une,
                      sinon vers la carte mère. « Rétablir courbe » échouait quand aucun
                      préréglage n'était actif, ce qui est le cas en mode Équilibré. */}
                  {fan.mode === 'manual' && fan.controllable && (
                    <button
                      onClick={() => store.controlFan(fan.id, activeCurvePreset ? 'curve' : 'auto')}
                      disabled={failsafeEngaged}
                      className="text-[11px] text-wopr-textMuted hover:text-wopr-text flex items-center gap-1 disabled:opacity-40"
                    >
                      <RotateCcw className="w-3 h-3" />
                      {activeCurvePreset ? `Suivre la courbe « ${activeCurvePreset} »` : 'Rendre à la carte mère'}
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* SECTION 3: INTERACTIVE FAN CURVE EDITOR */}
      <div className="bg-wopr-surface border border-wopr-border rounded-xl p-5 space-y-4">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between pb-3 border-b border-wopr-border gap-3">
          <div>
            <h3 className="text-sm font-semibold uppercase tracking-wider text-wopr-text">
              Éditeur de courbe de ventilation PWM
            </h3>
            <p className="text-xs text-wopr-textMuted mt-0.5">
              Profil actif :{' '}
              <strong className="text-wopr-accent">
                {activeCurvePreset ?? 'pilotage par la carte mère (Smart Fan IV)'}
              </strong>
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <button
              onClick={() => store.setFanCurvePreset(null)}
              disabled={!fansAvailable}
              className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors border disabled:opacity-40 disabled:cursor-not-allowed ${
                activeCurvePreset === null
                  ? 'bg-wopr-accent text-white border-wopr-accent shadow'
                  : 'bg-[#0d1117] border-wopr-border text-wopr-text hover:bg-white/5'
              }`}
              title="Rend le pilotage des ventilateurs à la carte mère"
            >
              Carte mère
            </button>
            {curvePresets.map((preset) => (
              <button
                key={preset}
                onClick={() => store.setFanCurvePreset(preset)}
                disabled={!fansAvailable}
                className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors border disabled:opacity-40 disabled:cursor-not-allowed ${
                  activeCurvePreset === preset
                    ? 'bg-wopr-accent text-white border-wopr-accent shadow'
                    : 'bg-[#0d1117] border-wopr-border text-wopr-text hover:bg-white/5'
                }`}
              >
                {preset}
              </button>
            ))}
          </div>
        </div>

        {/* Visual curve points editors */}
        {currentCurvePoints.length === 0 ? (
          <p className="text-xs text-wopr-textMuted pt-2">
            La carte mère pilote les ventilateurs : il n'y a pas de courbe du dashboard à
            modifier. Choisissez un préréglage ci-dessus pour en éditer les paliers.
          </p>
        ) : (
          <>
            <div className="grid grid-cols-1 sm:grid-cols-4 gap-4 pt-2">
              {currentCurvePoints.map((pt, idx) => (
                <CurvePointEditor key={idx} index={idx} point={pt} disabled={failsafeEngaged} />
              ))}
            </div>
            <p className="text-[11px] text-wopr-textSubtle">
              Température de référence : CPU Tctl
              {controlTempC !== null && ` (${controlTempC.toFixed(1)} °C)`}. Modifier un palier
              change le préréglage « {activeCurvePreset} » pour tous les modes qui l'utilisent.
            </p>
          </>
        )}
      </div>

      {/* Fan manual adjustment modal */}
      {editingFan && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/75 backdrop-blur-sm animate-in fade-in">
          <div className="w-full max-w-sm bg-[#161b22] border border-wopr-border rounded-xl p-5 shadow-2xl space-y-4">
            <h3 className="text-sm font-semibold text-wopr-text pb-2 border-b border-wopr-border">
              Pilotage : {editingFan.label}
            </h3>

            <div>
              <div className="flex justify-between text-xs font-mono mb-2">
                <span className="text-wopr-textMuted">Consigne manuelle :</span>
                <span className="font-bold text-wopr-accent text-sm">{manualDuty} %</span>
              </div>
              <input
                type="range"
                min={0}
                max={100}
                value={manualDuty}
                onChange={(e) => setManualDuty(Number(e.target.value))}
                className="w-full accent-wopr-accent cursor-pointer"
              />
              <div className="flex justify-between text-[10px] font-mono text-wopr-textSubtle mt-1">
                <span>0 % (arrêt)</span>
                <span>Actuellement : {editingFan.rpm} tr/min</span>
                <span>100 % (max)</span>
              </div>
              {manualDuty < 20 && (
                <p className="mt-2 text-[11px] text-amber-400">
                  Consigne très basse : le ventilateur peut s'arrêter. Le chien de garde
                  thermique rendra la main à la carte mère si une sonde devient critique.
                </p>
              )}
            </div>

            <div className="flex justify-end gap-2 pt-2 border-t border-wopr-border">
              <button
                onClick={() => setEditingFan(null)}
                className="px-3 py-1.5 rounded-lg text-xs text-wopr-textMuted hover:text-wopr-text"
              >
                Annuler
              </button>
              <button
                onClick={handleApplyFanDuty}
                className="px-4 py-1.5 rounded-lg bg-wopr-accent hover:bg-wopr-accentHover text-white text-xs font-semibold"
              >
                Appliquer la consigne
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
