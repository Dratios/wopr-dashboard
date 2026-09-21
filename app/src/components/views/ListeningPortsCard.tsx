import React, { useMemo, useState } from 'react';
import { Search } from 'lucide-react';
import type { DockerData, NetworkListener } from '../../state/types';

type Exposure = 'exposed' | 'lan' | 'local';

interface PortRow {
  key: string;
  port: number;
  protos: string[];
  process: string;
  container: string | null;
  addresses: string[];
  exposure: Exposure;
}

const EXPOSURE_RANK: Record<Exposure, number> = { local: 0, lan: 1, exposed: 2 };

const EXPOSURE_STYLE: Record<Exposure, { label: string; badge: string }> = {
  exposed: { label: 'Exposé', badge: 'bg-amber-500/15 text-amber-400 border-amber-500/30' },
  lan: { label: 'LAN', badge: 'bg-sky-500/15 text-sky-400 border-sky-500/30' },
  local: { label: 'Local', badge: 'bg-emerald-500/15 text-emerald-400 border-emerald-500/30' },
};

/**
 * Portée d'une adresse d'écoute.
 *
 * `0.0.0.0` et `::` écoutent sur toutes les interfaces ; une adresse IPv6 globale
 * (2000::/3) est joignable depuis Internet. L'ancienne version ne signalait que
 * `0.0.0.0` : un service sur `::` passait pour sûr.
 */
function exposureOf(address: string): Exposure {
  const a = address.toLowerCase();
  if (a === '0.0.0.0' || a === '::') return 'exposed';
  if (a.startsWith('127.') || a === '::1') return 'local';
  if (/^[23]/.test(a) && a.includes(':')) return 'exposed';
  return 'lan';
}

function addressSummary(row: PortRow): string {
  if (row.addresses.some((a) => a === '0.0.0.0' || a === '::')) return 'toutes interfaces';
  if (row.addresses.length === 1) return row.addresses[0];
  return `${row.addresses.length} adresses`;
}

/**
 * Regroupe les sockets d'un même service. Le collecteur renvoie une ligne par
 * adresse : IPv4 + IPv6, et un service de streaming apparaissait ici 13 fois
 * pour un seul port.
 */
function groupListeners(listeners: NetworkListener[], containerNames: Map<string, string>,
                        publishedPorts: Map<number, string>): PortRow[] {
  const rows = new Map<string, PortRow>();
  for (const l of listeners) {
    const key = `${l.port}|${l.process}|${l.container ?? ''}`;
    let row = rows.get(key);
    if (!row) {
      const container = l.container
        ? containerNames.get(l.container) ?? l.container
        : l.process === 'docker-proxy'
          ? publishedPorts.get(l.port) ?? null
          : null;
      row = { key, port: l.port, protos: [], process: l.process, container, addresses: [], exposure: 'local' };
      rows.set(key, row);
    }
    if (!row.protos.includes(l.proto)) row.protos.push(l.proto);
    if (!row.addresses.includes(l.listen)) row.addresses.push(l.listen);
    const exposure = exposureOf(l.listen);
    if (EXPOSURE_RANK[exposure] > EXPOSURE_RANK[row.exposure]) row.exposure = exposure;
  }
  return [...rows.values()].sort((a, b) => a.port - b.port);
}

export const ListeningPortsCard: React.FC<{ listeners: NetworkListener[]; docker: DockerData }> = ({
  listeners,
  docker,
}) => {
  const [filter, setFilter] = useState<Exposure | 'all'>('all');
  const [query, setQuery] = useState('');

  const rows = useMemo(() => {
    const containerNames = new Map<string, string>();
    // `docker-proxy` tourne sur l'hôte : on retrouve le conteneur par le port publié.
    const publishedPorts = new Map<number, string>();
    for (const stack of docker.stacks) {
      for (const c of stack.containers) {
        containerNames.set(c.id, c.name);
        for (const p of c.ports) {
          const hostPort = /(\d+)→/.exec(p);
          if (hostPort) publishedPorts.set(Number(hostPort[1]), c.name);
        }
      }
    }
    return groupListeners(listeners, containerNames, publishedPorts);
  }, [listeners, docker]);

  const counts = useMemo(() => {
    const c = { all: rows.length, exposed: 0, lan: 0, local: 0 };
    rows.forEach((r) => c[r.exposure]++);
    return c;
  }, [rows]);

  const q = query.trim().toLowerCase();
  const visible = rows.filter(
    (r) =>
      (filter === 'all' || r.exposure === filter) &&
      (!q ||
        String(r.port).includes(q) ||
        r.process.toLowerCase().includes(q) ||
        (r.container ?? '').toLowerCase().includes(q)),
  );

  const chips: { id: Exposure | 'all'; label: string }[] = [
    { id: 'all', label: 'Tous' },
    { id: 'exposed', label: 'Exposés' },
    { id: 'lan', label: 'LAN' },
    { id: 'local', label: 'Local' },
  ];

  return (
    <div className="bg-wopr-surface border border-wopr-border rounded-xl p-5 flex flex-col min-h-0">
      <div className="flex items-center justify-between pb-3 border-b border-wopr-border mb-3">
        <span className="text-xs font-semibold uppercase tracking-wider text-wopr-text">
          Ports en écoute ({rows.length})
        </span>
        <span className="text-[10px] font-mono text-wopr-textSubtle">
          {listeners.length} sockets
        </span>
      </div>

      <div className="flex flex-col gap-2 mb-3">
        <div className="relative">
          <Search className="w-3.5 h-3.5 text-wopr-textSubtle absolute left-3 top-1/2 -translate-y-1/2" />
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Port, processus ou conteneur…"
            className="w-full bg-[#0d1117] border border-wopr-border rounded-lg pl-9 pr-3 py-1.5 text-xs text-wopr-text placeholder:text-wopr-textSubtle focus:outline-none focus:border-wopr-accent"
          />
        </div>
        <div className="flex items-center gap-1.5 flex-wrap">
          {chips.map((chip) => (
            <button
              key={chip.id}
              onClick={() => setFilter(chip.id)}
              className={`px-2 py-0.5 rounded-md text-[11px] font-medium border transition-colors cursor-pointer ${
                filter === chip.id
                  ? 'bg-wopr-accent/15 text-wopr-accent border-wopr-accent/40'
                  : 'bg-white/5 text-wopr-textMuted border-wopr-border hover:text-wopr-text'
              }`}
            >
              {chip.label} <span className="font-mono opacity-70">{counts[chip.id]}</span>
            </button>
          ))}
        </div>
      </div>

      {/* Sur grand écran, la liste est positionnée en absolu dans un conteneur qui
          prend la hauteur restante : elle ne compte pas dans la hauteur de la ligne,
          la carte s'aligne sur la carte réseau voisine et la liste défile à
          l'intérieur. (`flex-1` + `h-0` ne suffisait pas : `flex-basis: 0%` sur une
          hauteur indéfinie est traité comme « contenu », la liste gardait toute sa
          hauteur.) */}
      <div className="relative lg:flex-1 lg:min-h-[12rem]">
        <div className="max-h-96 lg:max-h-none lg:absolute lg:inset-0 overflow-y-auto -mx-1 px-1">
          {visible.length === 0 ? (
            <p className="text-xs text-wopr-textMuted text-center py-6">Aucun port ne correspond.</p>
          ) : (
            <table className="w-full text-xs font-mono">
              <tbody>
                {visible.map((row) => (
                  <tr key={row.key} className="border-b border-wopr-border/40 last:border-0">
                    <td className="py-1.5 pr-2 align-top">
                      <span className="font-bold text-wopr-accent">:{row.port}</span>
                      <div className="text-[10px] text-wopr-textSubtle uppercase">{row.protos.join('/')}</div>
                    </td>
                    <td className="py-1.5 pr-2 align-top min-w-0">
                      <div className="text-wopr-text font-sans font-medium truncate max-w-[9rem]" title={row.process}>
                        {row.process}
                      </div>
                      <div className="text-[10px] text-wopr-textMuted truncate max-w-[9rem]" title={row.container ?? undefined}>
                        {row.container ?? 'hôte'}
                      </div>
                    </td>
                    <td className="py-1.5 text-right align-top">
                      <span className={`px-1.5 py-0.5 rounded text-[10px] font-bold border ${EXPOSURE_STYLE[row.exposure].badge}`}>
                        {EXPOSURE_STYLE[row.exposure].label}
                      </span>
                      <div className="text-[10px] text-wopr-textMuted mt-0.5" title={row.addresses.join('\n')}>
                        {addressSummary(row)}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  );
};
