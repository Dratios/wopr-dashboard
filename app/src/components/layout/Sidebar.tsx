import React from 'react';
import {
  LayoutDashboard,
  Cpu,
  Tv2,
  ThermometerSnowflake,
  HardDrive,
  Sliders,
  Boxes,
  ListTree,
  Terminal,
  FileClock,
  Settings,
  ChevronLeft,
  ChevronRight,
} from 'lucide-react';
import { useWoprStore } from '../../state/useWoprStore';

export type ViewId =
  | 'overview'
  | 'cpu-ram'
  | 'gpu'
  | 'thermal'
  | 'storage-network'
  | 'modes'
  | 'docker'
  | 'processes'
  | 'system'
  | 'audit'
  | 'settings';

interface SidebarProps {
  currentView: ViewId;
  onSelectView: (view: ViewId) => void;
  collapsed: boolean;
  onToggleCollapse: () => void;
}

export const Sidebar: React.FC<SidebarProps> = ({
  currentView,
  onSelectView,
  collapsed,
  onToggleCollapse,
}) => {
  const { overview } = useWoprStore();

  // Rattache les alertes non acquittées à une vue par le préfixe de leur `id`
  // (cf. server/alerts.py). `component` est un libellé lisible (« Processeur »,
  // « Réseau »…) : filtrer dessus sur « gpu/ » ou « docker/ » ne trouvait jamais rien.
  const hasPendingAlert = (...prefixes: string[]) =>
    overview.alerts.some((a) => !a.acknowledged && prefixes.some((p) => a.id.startsWith(p)));

  const navItems: { id: ViewId; label: string; icon: React.FC<{ className?: string }>; hasAlert?: boolean }[] = [
    { id: 'overview', label: "Vue d'ensemble", icon: LayoutDashboard },
    { id: 'cpu-ram', label: 'CPU / RAM / CM', icon: Cpu, hasAlert: hasPendingAlert('load', 'ram', 'swap') },
    {
      id: 'gpu',
      label: 'GPU & LLM',
      icon: Tv2,
      hasAlert: hasPendingAlert('vram-', 'gputemp-'),
    },
    {
      id: 'thermal',
      label: 'Thermique & Fans',
      icon: ThermometerSnowflake,
      hasAlert: hasPendingAlert('temp-', 'fan-'),
    },
    {
      id: 'storage-network',
      label: 'Stockage & Réseau',
      icon: HardDrive,
      hasAlert: hasPendingAlert('mount-', 'disk-', 'net-', 'gateway', 'firewall'),
    },
    { id: 'modes', label: 'Modes / Profils', icon: Sliders },
    {
      id: 'docker',
      label: 'Docker & Stacks',
      icon: Boxes,
      hasAlert: hasPendingAlert('ctr-', 'ctrrestart-', 'docker-down'),
    },
    { id: 'processes', label: 'Processus système', icon: ListTree },
    { id: 'system', label: 'Système & Actions', icon: Terminal, hasAlert: hasPendingAlert('reboot') },
    { id: 'audit', label: 'Journal / Audit', icon: FileClock },
    { id: 'settings', label: 'Paramètres', icon: Settings },
  ];

  return (
    <aside
      className={`relative h-full shrink-0 bg-[#0e1116] border-r border-wopr-border transition-all duration-200 flex flex-col justify-between select-none z-30 ${
        collapsed ? 'w-16' : 'w-56'
      }`}
    >
      {/* Navigation list */}
      <div className="py-3 px-2 flex flex-col gap-1 overflow-y-auto">
        {navItems.map((item) => {
          const Icon = item.icon;
          const isActive = currentView === item.id;

          return (
            <button
              key={item.id}
              onClick={() => onSelectView(item.id)}
              className={`relative flex items-center gap-3 px-3 py-2.5 rounded-lg text-xs font-medium transition-all group ${
                isActive
                  ? 'bg-wopr-accent/15 text-wopr-accent font-semibold shadow-sm'
                  : 'text-wopr-textMuted hover:text-wopr-text hover:bg-white/5'
              }`}
              title={collapsed ? item.label : undefined}
            >
              <Icon
                className={`w-4 h-4 shrink-0 transition-transform ${
                  isActive ? 'text-wopr-accent scale-110' : 'text-wopr-textMuted group-hover:text-wopr-text'
                }`}
              />

              {!collapsed && (
                <span className="truncate tracking-wide">{item.label}</span>
              )}

              {/* Red dot if there is an active alert */}
              {item.hasAlert && (
                <span
                  className={`w-2 h-2 rounded-full bg-rose-500 shadow-[0_0_6px_rgba(248,81,73,0.8)] ${
                    collapsed ? 'absolute top-2 right-2' : 'ml-auto shrink-0'
                  }`}
                />
              )}
            </button>
          );
        })}
      </div>

      {/* Collapse Toggle Footer */}
      <div className="p-2 border-t border-wopr-border/60">
        <button
          onClick={onToggleCollapse}
          className="w-full flex items-center justify-center p-2 rounded-lg text-wopr-textMuted hover:text-wopr-text hover:bg-white/5 transition-colors"
          title={collapsed ? 'Déplier le menu' : 'Replier le menu'}
        >
          {collapsed ? <ChevronRight className="w-4 h-4" /> : <ChevronLeft className="w-4 h-4" />}
        </button>
      </div>
    </aside>
  );
};
