import React, { useCallback, useEffect, useRef, useState } from 'react';
import { LoaderCircle, WifiOff, AlertTriangle } from 'lucide-react';

import { useWoprStore } from './state/useWoprStore';
import { store } from './state/store';
import { startLiveConnection, stopLiveConnection } from './state/live';

import { LoginView } from './components/auth/LoginView';
import { TopBar } from './components/layout/TopBar';
import { Sidebar, ViewId } from './components/layout/Sidebar';
import { ActiveModeBanner } from './components/layout/ActiveModeBanner';
import { AlertsDrawer } from './components/layout/AlertsDrawer';
import { ToastContainer } from './components/common/ToastContainer';

import { OverviewView } from './components/views/OverviewView';
import { CpuRamView } from './components/views/CpuRamView';
import { GpuView } from './components/views/GpuView';
import { ThermalFansView } from './components/views/ThermalFansView';
import { StorageNetworkView } from './components/views/StorageNetworkView';
import { ModesView } from './components/views/ModesView';
import { DockerView } from './components/views/DockerView';
import { ProcessesView } from './components/views/ProcessesView';
import { SystemView } from './components/views/SystemView';
import { AuditView } from './components/views/AuditView';
import { SettingsView } from './components/views/SettingsView';
import { loadPrefs } from './components/settings/MiscSections';
import { KioskView } from './components/views/KioskView';

/** Bandeau affiché quand le flux temps réel est coupé. */
const StaleBanner: React.FC<{ lastUpdate: number | null }> = ({ lastUpdate }) => {
  const seconds = lastUpdate ? Math.round((Date.now() - lastUpdate) / 1000) : null;
  return (
    <div
      role="status"
      className="flex items-center justify-center gap-2 bg-wopr-warn/15
                 border-b border-wopr-warn/40 text-wopr-warn text-xs py-1.5 px-4"
    >
      <WifiOff size={13} aria-hidden="true" />
      <span>
        Liaison interrompue — les valeurs affichées ne sont plus actualisées
        {seconds !== null && ` (dernière mise à jour il y a ${seconds} s)`}. Reconnexion en cours…
      </span>
    </div>
  );
};

/**
 * Bandeau affiché quand des réglages « à froid » attendent une recréation.
 *
 * Volontairement visible depuis n'importe quelle vue : un réglage enregistré qui
 * n'a pas encore pris effet doit se voir, sans quoi on croit que l'interface ment.
 */
const PendingRestartBanner: React.FC<{
  count: number;
  onOpenSettings: () => void;
}> = ({ count, onOpenSettings }) => (
  <div
    role="status"
    className="flex items-center justify-center gap-2 bg-wopr-accent/10
               border-b border-wopr-accent/30 text-wopr-accent text-xs py-1.5 px-4"
  >
    <AlertTriangle size={13} aria-hidden="true" />
    <span>
      {count} réglage{count > 1 ? 's' : ''} enregistré{count > 1 ? 's' : ''} attend
      {count > 1 ? 'ent' : ''} une recréation du conteneur pour prendre effet.
    </span>
    <button
      type="button"
      onClick={onOpenSettings}
      className="underline underline-offset-2 hover:text-wopr-accentHover font-medium"
    >
      Voir la marche à suivre
    </button>
  </div>
);

const LoadingScreen: React.FC<{ label: string }> = ({ label }) => (
  <div className="min-h-screen bg-wopr-bg flex flex-col items-center justify-center gap-3">
    <LoaderCircle size={22} className="text-wopr-accent animate-spin" aria-hidden="true" />
    <p className="text-sm text-wopr-textMuted">{label}</p>
  </div>
);

export const App: React.FC = () => {
  const state = useWoprStore();
  // Vue de départ : préférence enregistrée dans ce navigateur (onglet Paramètres).
  const [currentView, setCurrentView] = useState<ViewId>(
    () => (loadPrefs().startView as ViewId) || 'overview');
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [isKiosk, setIsKiosk] = useState(false);
  const [isAlertsOpen, setIsAlertsOpen] = useState(false);
  const [connectionError, setConnectionError] = useState<string | null>(null);

  // Le thème est appliqué sur <html> : Tailwind est configuré en `darkMode: 'class'`.
  useEffect(() => {
    document.documentElement.classList.toggle('light', state.theme === 'light');
  }, [state.theme]);

  // Une session existe-t-elle déjà ? (rechargement de page, onglet rouvert)
  useEffect(() => {
    store.checkSession();
  }, []);

  // Le flux temps réel ne démarre qu'une fois authentifié, et s'arrête à la
  // déconnexion — inutile de marteler un serveur qui répondra 401.
  useEffect(() => {
    if (!state.currentUser) {
      stopLiveConnection();
      return;
    }
    let cancelled = false;
    setConnectionError(null);
    startLiveConnection().catch((err) => {
      if (!cancelled) {
        setConnectionError(err?.message ?? 'Impossible de joindre le serveur');
      }
    });
    return () => {
      cancelled = true;
      stopLiveConnection();
    };
  }, [state.currentUser]);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'k' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        setIsKiosk((prev) => !prev);
      }
      if (e.key === 'Escape') setIsAlertsOpen(false);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  // C'est <main> qui défile, pas la fenêtre : sans remise à zéro, une vue s'ouvrirait
  // à la position de défilement de la précédente.
  const mainRef = useRef<HTMLElement>(null);
  const navigate = useCallback((view: ViewId) => {
    setCurrentView(view);
    mainRef.current?.scrollTo({ top: 0 });
  }, []);

  if (!state.authChecked) {
    return <LoadingScreen label="Vérification de la session…" />;
  }

  if (!state.currentUser) {
    return (
      <>
        <LoginView />
        <ToastContainer />
      </>
    );
  }

  if (connectionError) {
    return (
      <div className="min-h-screen bg-wopr-bg flex flex-col items-center justify-center gap-4 p-6">
        <WifiOff size={26} className="text-wopr-err" aria-hidden="true" />
        <p className="text-sm text-wopr-text text-center max-w-md">
          Impossible de récupérer l'état du serveur.
        </p>
        <p className="text-xs text-wopr-textMuted text-center max-w-md">{connectionError}</p>
        <button
          onClick={() => window.location.reload()}
          className="text-xs bg-wopr-surface2 hover:bg-wopr-surface3 border border-wopr-border
                     rounded-lg px-4 py-2 text-wopr-text transition-colors"
        >
          Réessayer
        </button>
      </div>
    );
  }

  // Aucune vue n'est rendue avant la première photographie complète : c'est ce qui
  // garantit qu'aucun écran n'affiche jamais de valeur par défaut à la place d'une
  // mesure.
  if (!state.ready) {
    return <LoadingScreen label="Lecture de l'état de la machine…" />;
  }

  if (isKiosk) {
    return (
      <div className="min-h-screen bg-wopr-bg">
        {state.stale && <StaleBanner lastUpdate={state.lastUpdate} />}
        <KioskView onExitKiosk={() => setIsKiosk(false)} />
        <ToastContainer />
      </div>
    );
  }

  const renderView = () => {
    switch (currentView) {
      case 'cpu-ram':
        return <CpuRamView onNavigate={navigate} />;
      case 'gpu':
        return <GpuView />;
      case 'thermal':
        return <ThermalFansView />;
      case 'storage-network':
        return <StorageNetworkView />;
      case 'modes':
        return <ModesView />;
      case 'docker':
        return <DockerView />;
      case 'processes':
        return <ProcessesView onNavigate={navigate} />;
      case 'system':
        return <SystemView />;
      case 'audit':
        return <AuditView />;
      case 'settings':
        return <SettingsView />;
      case 'overview':
      default:
        return (
          <OverviewView onNavigate={navigate} onOpenAlerts={() => setIsAlertsOpen(true)} />
        );
    }
  };

  return (
    // `h-screen` et non `min-h-screen` : la page elle-même ne doit pas défiler. Seul
    // <main> défile, la barre supérieure et le menu de gauche restent en place.
    <div className="h-screen bg-wopr-bg text-wopr-text flex flex-col font-sans
                    selection:bg-wopr-accent/30 selection:text-white">
      <TopBar
        onOpenAlerts={() => setIsAlertsOpen(true)}
        onToggleKiosk={() => setIsKiosk(true)}
        isKiosk={isKiosk}
      />

      {state.stale && <StaleBanner lastUpdate={state.lastUpdate} />}

      {state.pendingRestart.length > 0 && currentView !== 'settings' && (
        <PendingRestartBanner
          count={state.pendingRestart.length}
          onOpenSettings={() => navigate('settings')}
        />
      )}

      <ActiveModeBanner />

      <div className="flex-1 min-h-0 flex overflow-hidden">
        <Sidebar
          currentView={currentView}
          onSelectView={navigate}
          collapsed={sidebarCollapsed}
          onToggleCollapse={() => setSidebarCollapsed(!sidebarCollapsed)}
        />
        <main ref={mainRef} className="flex-1 overflow-y-auto p-4 md:p-6 pb-20">
          <div className="max-w-7xl mx-auto">{renderView()}</div>
        </main>
      </div>

      <AlertsDrawer isOpen={isAlertsOpen} onClose={() => setIsAlertsOpen(false)} />
      <ToastContainer />
    </div>
  );
};

export default App;
