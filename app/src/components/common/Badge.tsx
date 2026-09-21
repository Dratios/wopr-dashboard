import React from 'react';
import { Owner, SHARED_OWNER } from '../../state/types';
import { useWoprStore } from '../../state/useWoprStore';
import { ownerTone } from './ownerTones';
import { User, Users } from 'lucide-react';

interface OwnerBadgeProps {
  owner: Owner;
  className?: string;
  size?: 'sm' | 'md';
}

/**
 * Badge d'appartenance d'un conteneur ou d'une stack.
 *
 * Aucun compte n'est écrit ici : le libellé, la couleur et l'infobulle viennent
 * de `config/owners.yaml`, servi par `/api/status`. Une identité inconnue (une
 * étiquette posée à la main, un fichier modifié depuis) s'affiche telle quelle
 * en gris plutôt que de disparaître silencieusement.
 */
export const OwnerBadge: React.FC<OwnerBadgeProps> = ({ owner, className = '', size = 'md' }) => {
  const { owners } = useWoprStore();
  const isSm = size === 'sm';

  const info = owners.find((o) => o.id === owner);
  const isShared = owner === SHARED_OWNER;
  const Icon = isShared ? Users : User;

  return (
    <span
      className={`inline-flex items-center gap-1 font-mono font-medium rounded-md border ${
        ownerTone(info?.tone).badge
      } ${isSm ? 'px-1.5 py-0.5 text-[10px]' : 'px-2 py-0.5 text-[11px]'} ${className}`}
      title={info?.description || `Appartient à ${info?.label ?? owner}`}
    >
      <Icon className={isSm ? 'w-2.5 h-2.5 shrink-0' : 'w-3 h-3 shrink-0'} />
      <span>{info?.label ?? owner}</span>
    </span>
  );
};

interface StatusBadgeProps {
  status: 'running' | 'stopped' | 'paused' | 'restarting' | 'unhealthy' | 'active' | 'idle' | 'failed';
  className?: string;
}

export const StatusBadge: React.FC<StatusBadgeProps> = ({ status, className = '' }) => {
  const config = {
    running: { label: 'En cours', bg: 'bg-[#3fb950]/15 text-[#3fb950] border-[#3fb950]/30' },
    active: { label: 'Actif', bg: 'bg-[#3fb950]/15 text-[#3fb950] border-[#3fb950]/30' },
    stopped: { label: 'Arrêté', bg: 'bg-[#6e7681]/15 text-[#8b949e] border-[#6e7681]/30' },
    paused: { label: 'En pause', bg: 'bg-[#d29922]/15 text-[#d29922] border-[#d29922]/30' },
    idle: { label: 'Inactif', bg: 'bg-[#6e7681]/15 text-[#8b949e] border-[#6e7681]/30' },
    restarting: {
      label: 'Redémarrage',
      bg: 'bg-[#d29922]/15 text-[#d29922] border-[#d29922]/30 animate-pulse',
    },
    unhealthy: {
      label: 'Dégradé',
      bg: 'bg-[#f85149]/15 text-[#f85149] border-[#f85149]/30 font-semibold',
    },
    failed: {
      label: 'Échec',
      bg: 'bg-[#f85149]/15 text-[#f85149] border-[#f85149]/30',
    },
  }[status];

  return (
    <span
      className={`inline-flex items-center px-2 py-0.5 rounded text-[11px] font-medium border ${config.bg} ${className}`}
    >
      {config.label}
    </span>
  );
};
