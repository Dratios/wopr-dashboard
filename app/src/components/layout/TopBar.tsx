import React, { useEffect, useRef, useState } from 'react';
import { useWoprStore } from '../../state/useWoprStore';
import { store } from '../../state/store';
import { HealthDot } from '../common/HealthDot';
import { ModeActivationDialog } from '../common/ModeActivationDialog';
import type { ModeItem } from '../../state/types';
import {
  Bell,
  Sun,
  Moon,
  Tv,
  ChevronDown,
  Cpu,
  Clock,
  Sparkles,
  UserRound,
  LogOut,
} from 'lucide-react';

interface TopBarProps {
  onOpenAlerts: () => void;
  onToggleKiosk: () => void;
  isKiosk: boolean;
}

export const TopBar: React.FC<TopBarProps> = ({ onOpenAlerts, onToggleKiosk, isKiosk }) => {
  const { overview, modes, theme, connected, stale, currentUser } = useWoprStore();
  const [showModeDropdown, setShowModeDropdown] = useState(false);
  const [modeToActivate, setModeToActivate] = useState<ModeItem | null>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);

  // Le menu se ferme au clic en dehors, comme n'importe quel menu déroulant.
  useEffect(() => {
    if (!showModeDropdown) return;
    const onPointerDown = (e: MouseEvent) => {
      if (!dropdownRef.current?.contains(e.target as Node)) setShowModeDropdown(false);
    };
    document.addEventListener('mousedown', onPointerDown);
    return () => document.removeEventListener('mousedown', onPointerDown);
  }, [showModeDropdown]);

  const formatUptime = (seconds: number) => {
    const days = Math.floor(seconds / 86400);
    const hours = Math.floor((seconds % 86400) / 3600);
    const mins = Math.floor((seconds % 3600) / 60);
    return `${days}j ${hours.toString().padStart(2, '0')}h ${mins.toString().padStart(2, '0')}m`;
  };

  const activeModeItem = modes.modes.find((m) => m.id === modes.active);
  // On ne compte que les alertes non acquittées : une pastille qui ne
  // redescend jamais finit par être ignorée.
  const alertsCount = overview.alerts.filter((a) => !a.acknowledged).length;

  return (
    <>
    {/* La boîte de dialogue reste hors du <header> : son `backdrop-blur` en ferait
        le bloc conteneur des éléments `fixed`, la modale serait coincée dedans. */}
    <ModeActivationDialog
      target={modeToActivate}
      current={activeModeItem}
      onClose={() => setModeToActivate(null)}
    />
    <header className="sticky top-0 z-40 w-full h-14 bg-[#161b22]/95 backdrop-blur border-b border-wopr-border px-4 flex items-center justify-between gap-4">
      {/* Left: Host, Health, and Quick Mode */}
      <div className="flex items-center gap-4 min-w-0">
        <div className="flex items-center gap-2.5">
          <div className="w-8 h-8 rounded-lg bg-[#4c9ffe]/15 border border-[#4c9ffe]/30 flex items-center justify-center text-wopr-accent font-mono font-black text-sm tracking-wider shadow-sm">
            W
          </div>
          <span className="font-mono font-bold text-sm tracking-tight text-wopr-text hidden sm:inline">
            {overview.host}
          </span>

          {/* État réel de la liaison temps réel */}
          {connected && !stale ? (
            <span
              className="px-2 py-0.5 rounded text-[10px] font-mono font-bold bg-emerald-500/15 text-emerald-400 border border-emerald-500/30 flex items-center gap-1.5"
              title="Flux de télémétrie établi avec le serveur"
            >
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
              <span>EN DIRECT</span>
            </span>
          ) : (
            <span
              className="px-2 py-0.5 rounded text-[10px] font-mono font-bold bg-amber-500/15 text-amber-400 border border-amber-500/30 flex items-center gap-1.5"
              title="Liaison interrompue — les valeurs affichées ne sont plus actualisées"
            >
              <span className="w-1.5 h-1.5 rounded-full bg-amber-400" />
              <span>HORS LIGNE</span>
            </span>
          )}

          <button
            onClick={onOpenAlerts}
            className="flex items-center gap-1.5 px-2 py-0.5 rounded-full bg-white/5 hover:bg-white/10 border border-wopr-border transition-colors cursor-pointer"
            title="Cliquez pour voir le détail de l'état de santé"
          >
            <HealthDot level={overview.health.level} size="sm" />
            <span className="text-xs font-semibold text-wopr-text font-mono uppercase">
              {overview.health.level === 'ok'
                ? 'OK'
                : overview.health.level === 'warn'
                ? 'ATTENTION'
                : 'ALERTE'}
            </span>
          </button>
        </div>

        <div className="h-4 w-[1px] bg-wopr-border hidden md:block" />

        {/* Mode Selector Dropdown */}
        <div ref={dropdownRef} className="relative hidden sm:block">
          <button
            onClick={() => setShowModeDropdown(!showModeDropdown)}
            className="flex items-center gap-2 px-2.5 py-1 rounded-lg bg-wopr-surface2 hover:bg-wopr-surface3 border border-wopr-border text-xs font-medium text-wopr-text transition-colors"
          >
            <span className="text-wopr-textMuted font-normal">Mode :</span>
            <span className="text-wopr-accent font-semibold">{overview.activeMode.label || activeModeItem?.label}</span>
            <ChevronDown className="w-3.5 h-3.5 text-wopr-textMuted" />
          </button>

          {showModeDropdown && (
            <div className="absolute top-full left-0 mt-1.5 w-64 bg-[#161b22] border border-wopr-border rounded-xl shadow-2xl py-1.5 z-50 animate-in fade-in zoom-in-95">
              <div className="px-3 py-1.5 text-[11px] font-semibold uppercase tracking-wider text-wopr-textSubtle border-b border-wopr-border/50">
                Changer de profil machine
              </div>
              {modes.modes.map((mode) => (
                <button
                  key={mode.id}
                  onClick={() => {
                    // Même confirmation que la vue Modes : motif et aperçu des leviers.
                    setShowModeDropdown(false);
                    if (mode.id !== modes.active) setModeToActivate(mode);
                  }}
                  className={`w-full text-left px-3 py-2 flex items-start gap-2.5 hover:bg-white/5 transition-colors text-xs ${
                    mode.id === modes.active ? 'bg-wopr-accent/10 text-wopr-accent font-semibold' : 'text-wopr-text'
                  }`}
                >
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center justify-between">
                      <span>{mode.label}</span>
                      {mode.id === modes.active && (
                        <span className="text-[10px] font-mono uppercase bg-wopr-accent/20 text-wopr-accent px-1.5 py-0.2 rounded">
                          Actif
                        </span>
                      )}
                    </div>
                    <p className="text-[11px] text-wopr-textMuted mt-0.5 truncate">
                      {mode.description}
                    </p>
                  </div>
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Center: System metrics */}
      <div className="hidden lg:flex items-center gap-5 text-xs text-wopr-textMuted font-mono">
        <div className="flex items-center gap-1.5">
          <Clock className="w-3.5 h-3.5 text-wopr-textSubtle" />
          <span>Uptime:</span>
          <span className="text-wopr-text font-semibold">{formatUptime(overview.uptimeSeconds)}</span>
        </div>
        <div className="flex items-center gap-1.5">
          <Cpu className="w-3.5 h-3.5 text-wopr-textSubtle" />
          <span>Load:</span>
          <span className="text-wopr-text font-semibold">{overview.loadavg.join(' · ')}</span>
        </div>
        <div
          className="flex items-center gap-1.5"
          title={overview.powerScope ? `Mesure partielle : ${overview.powerScope} — carte mère, disques et ventilateurs non comptés` : 'Puissance non mesurable sur cette machine'}
        >
          <Sparkles className="w-3.5 h-3.5 text-amber-400" />
          <span>Conso:</span>
          <span className="text-wopr-text font-semibold">
            {overview.powerEstimateW !== null ? `${overview.powerEstimateW} W` : '—'}
          </span>
        </div>
      </div>

      {/* Right: Controls, Notifications & Profile */}
      <div className="flex items-center gap-2">
        {/* Session en cours : c'est ce nom qui est inscrit au journal d'audit. */}
        <span
          className="hidden sm:flex items-center gap-1.5 px-2 py-1 rounded-lg bg-wopr-surface2 border border-wopr-border text-[11px] font-mono text-wopr-text"
          title="Compte connecté — toutes vos actions sont journalisées sous ce nom"
        >
          <UserRound className="w-3 h-3 text-wopr-textMuted" />
          {currentUser}
        </span>

        {/* Alerts Bell */}
        <button
          onClick={onOpenAlerts}
          className="relative p-2 rounded-lg text-wopr-textMuted hover:text-wopr-text hover:bg-white/5 transition-colors"
          title="Panneau d'alertes"
        >
          <Bell className="w-4 h-4" />
          {alertsCount > 0 && (
            <span className="absolute top-1 right-1 w-4 h-4 rounded-full bg-rose-500 text-white font-mono text-[10px] font-bold flex items-center justify-center animate-pulse">
              {alertsCount}
            </span>
          )}
        </button>

        {/* Kiosk Mode Toggle */}
        <button
          onClick={onToggleKiosk}
          className={`p-2 rounded-lg transition-colors ${
            isKiosk
              ? 'bg-wopr-accent text-white'
              : 'text-wopr-textMuted hover:text-wopr-text hover:bg-white/5'
          }`}
          title={isKiosk ? 'Quitter le mode kiosque' : 'Passer en mode kiosque (plein écran mural)'}
        >
          <Tv className="w-4 h-4" />
        </button>

        {/* Theme Toggle */}
        <button
          onClick={() => store.toggleTheme()}
          className="p-2 rounded-lg text-wopr-textMuted hover:text-wopr-text hover:bg-white/5 transition-colors"
          title={`Thème ${theme === 'dark' ? 'clair' : 'sombre'}`}
        >
          {theme === 'dark' ? <Sun className="w-4 h-4" /> : <Moon className="w-4 h-4" />}
        </button>

        <button
          onClick={() => store.logout()}
          className="p-2 rounded-lg text-wopr-textMuted hover:text-wopr-err hover:bg-wopr-err/10 transition-colors"
          title="Se déconnecter"
        >
          <LogOut className="w-4 h-4" />
        </button>
      </div>
    </header>
    </>
  );
};
