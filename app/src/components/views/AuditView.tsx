import React, { useEffect, useState } from 'react';
import { useWoprStore } from '../../state/useWoprStore';
import {
  FileClock,
  Download,
  RefreshCw,
  Search,
  Filter,
  CheckCircle,
  AlertTriangle,
  AlertOctagon,
  Info,
} from 'lucide-react';
import { AuditLogItem } from '../../state/types';
import { store } from '../../state/store';

const PAGE_SIZE = 100;

/**
 * Acteurs qui ne sont pas des comptes : le dashboard lui-même, et ses règles
 * automatiques. Ils s'affichent sans arobase et en gris, pour qu'on distingue
 * d'un coup d'œil ce qu'une personne a fait de ce que la machine a décidé.
 */
const AUTOMATED_ACTORS = new Set(['système', 'règle auto']);

export const AuditView: React.FC = () => {
  const { audit } = useWoprStore();

  const [searchQuery, setSearchQuery] = useState('');
  const [actorFilter, setActorFilter] = useState('all');
  const [categoryFilter, setCategoryFilter] = useState('all');
  const [limit, setLimit] = useState(PAGE_SIZE);
  const [loading, setLoading] = useState(true);
  const [reloadTick, setReloadTick] = useState(0);

  // Le journal vit en base côté serveur : acteur et catégorie sont filtrés par
  // l'API, qui seule voit l'historique complet. Seule la recherche plein texte
  // reste locale, sur la page chargée.
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    store
      .refreshAudit({
        limit,
        by: actorFilter === 'all' ? undefined : actorFilter,
        category: categoryFilter === 'all' ? undefined : categoryFilter,
      })
      .catch(() => undefined)
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [actorFilter, categoryFilter, limit, reloadTick]);

  const needle = searchQuery.trim().toLowerCase();
  const filteredLogs = audit.items.filter(
    (log) =>
      !needle ||
      log.target.toLowerCase().includes(needle) ||
      log.detail.toLowerCase().includes(needle),
  );

  const handleExportCsv = () => {
    // Chaque champ est entouré de guillemets et ses guillemets doublés (RFC 4180).
    // L'ancien export passait par une URI `data:` encodée avec `encodeURI`, qui
    // n'échappe pas `#` : le fichier était tronqué au premier dièse rencontré.
    const cell = (value: string) => `"${value.replace(/"/g, '""')}"`;
    const headers = ['Horodatage', 'Acteur', 'Catégorie', 'Cible', 'Détail', 'Résultat'];
    const rows = filteredLogs.map((l) => [l.at, l.by, l.category, l.target, l.detail, l.result]);
    const csv = [headers, ...rows].map((r) => r.map(cell).join(',')).join('\r\n');

    // BOM : Excel et LibreOffice lisent alors les accents correctement.
    const url = URL.createObjectURL(new Blob(['\uFEFF', csv], { type: 'text/csv;charset=utf-8' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = `wopr-audit-${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  };

  const getResultBadge = (result: AuditLogItem['result']) => {
    switch (result) {
      case 'succès':
        return (
          <span className="px-2 py-0.5 rounded-full bg-emerald-500/15 text-emerald-400 border border-emerald-500/30 text-[10px] font-semibold flex items-center gap-1">
            <CheckCircle className="w-3 h-3" />
            Succès
          </span>
        );
      case 'attention':
        return (
          <span className="px-2 py-0.5 rounded-full bg-amber-500/15 text-amber-400 border border-amber-500/30 text-[10px] font-semibold flex items-center gap-1">
            <AlertTriangle className="w-3 h-3" />
            Attention
          </span>
        );
      case 'échec':
        return (
          <span className="px-2 py-0.5 rounded-full bg-rose-500/15 text-rose-400 border border-rose-500/30 text-[10px] font-semibold flex items-center gap-1">
            <AlertOctagon className="w-3 h-3" />
            Échec
          </span>
        );
      default:
        return (
          <span className="px-2 py-0.5 rounded-full bg-wopr-surface2 text-wopr-textMuted text-[10px] font-semibold">
            Info
          </span>
        );
    }
  };

  return (
    <div className="space-y-6 animate-in fade-in duration-200">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pb-4 border-b border-wopr-border">
        <div>
          <h1 className="text-xl font-bold tracking-tight text-wopr-text flex items-center gap-2.5">
            <FileClock className="w-5 h-5 text-wopr-accent" />
            <span>Journal d'Audit & Traçabilité</span>
          </h1>
          <p className="text-xs text-wopr-textMuted mt-1">
            Actions des administrateurs, changements de mode, ventilation et alertes, conservés dans data/audit.db
          </p>
        </div>

        <div className="flex items-center gap-2 self-start sm:self-auto">
        <button
          onClick={() => setReloadTick((t) => t + 1)}
          className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-white/5 hover:bg-white/10 border border-wopr-border text-xs font-semibold text-wopr-text transition-colors"
        >
          <RefreshCw className={`w-3.5 h-3.5 text-wopr-accent ${loading ? 'animate-spin' : ''}`} />
          <span>Actualiser</span>
        </button>
        <button
          onClick={handleExportCsv}
          className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-white/5 hover:bg-white/10 border border-wopr-border text-xs font-semibold text-wopr-text transition-colors self-start sm:self-auto"
        >
          <Download className="w-3.5 h-3.5 text-wopr-accent" />
          <span>Exporter CSV</span>
        </button>
        </div>
      </div>

      {/* Filter toolbar */}
      <div className="flex flex-col sm:flex-row items-center justify-between gap-3 bg-wopr-surface border border-wopr-border rounded-xl p-3">
        <div className="flex items-center gap-3 w-full sm:w-auto">
          <div className="relative w-full sm:w-72">
            <Search className="w-4 h-4 text-wopr-textMuted absolute left-3 top-2.5" />
            <input
              type="text"
              placeholder="Rechercher cible, détail..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full bg-[#0d1117] border border-wopr-border rounded-lg pl-9 pr-3 py-1.5 text-xs text-wopr-text placeholder:text-wopr-textSubtle focus:outline-none focus:border-wopr-accent"
            />
          </div>

          <select
            value={actorFilter}
            onChange={(e) => setActorFilter(e.target.value)}
            className="bg-[#0d1117] border border-wopr-border rounded-lg px-2.5 py-1.5 text-xs text-wopr-text focus:outline-none font-mono"
          >
            <option value="all">Tous les acteurs</option>
            {/* Acteurs réellement présents dans le journal, fournis par l'API :
                aucun compte n'est écrit ici, et aucun filtre ne peut être vide. */}
            {audit.actors.map((actor) => (
              <option key={actor} value={actor}>
                {AUTOMATED_ACTORS.has(actor) ? actor : `@${actor}`}
              </option>
            ))}
          </select>

          <select
            value={categoryFilter}
            onChange={(e) => setCategoryFilter(e.target.value)}
            className="bg-[#0d1117] border border-wopr-border rounded-lg px-2.5 py-1.5 text-xs text-wopr-text focus:outline-none font-mono"
          >
            <option value="all">Toutes les catégories</option>
            <option value="mode">Modes machine</option>
            <option value="docker">Docker & Stacks</option>
            <option value="system">Système hôte</option>
            <option value="process">Processus</option>
            <option value="llm">Modèles LLM</option>
            <option value="fan">Ventilation</option>
            <option value="alert">Alertes</option>
          </select>
        </div>

        <span className="text-xs text-wopr-textMuted font-mono">
          {needle
            ? `${filteredLogs.length} résultat(s) sur ${audit.items.length} chargé(s)`
            : `${audit.items.length} sur ${audit.total} événement(s)`}
        </span>
      </div>

      {/* Audit Log Table */}
      <div className="bg-wopr-surface border border-wopr-border rounded-xl overflow-hidden shadow-sm">
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead className="border-b border-wopr-border text-wopr-textMuted uppercase font-mono text-[11px] bg-[#0d1117]/50">
              <tr>
                <th className="py-2.5 px-4 font-medium">Horodatage</th>
                <th className="py-2.5 px-4 font-medium">Acteur</th>
                <th className="py-2.5 px-4 font-medium">Catégorie</th>
                <th className="py-2.5 px-4 font-medium">Cible</th>
                <th className="py-2.5 px-4 font-medium">Détail de l'opération</th>
                <th className="py-2.5 px-4 font-medium text-right">Résultat</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-wopr-border/40 font-mono">
              {filteredLogs.map((log) => (
                <tr key={log.id} className="hover:bg-white/5 transition-colors">
                  <td className="py-3 px-4 text-wopr-textMuted text-[11px] whitespace-nowrap">
                    {new Date(log.at).toLocaleString('fr-FR', {
                      day: '2-digit',
                      month: '2-digit',
                      hour: '2-digit',
                      minute: '2-digit',
                      second: '2-digit',
                    })}
                  </td>

                  <td className="py-3 px-4 whitespace-nowrap">
                    <span
                      className={`font-semibold ${
                        AUTOMATED_ACTORS.has(log.by) ? 'text-wopr-textMuted' : 'text-cyan-400'
                      }`}
                    >
                      {AUTOMATED_ACTORS.has(log.by) || log.by.startsWith('@')
                        ? log.by
                        : `@${log.by}`}
                    </span>
                  </td>

                  <td className="py-3 px-4">
                    <span className="px-1.5 py-0.5 rounded text-[10px] font-bold uppercase bg-wopr-surface2 text-wopr-accent border border-wopr-border">
                      {log.category}
                    </span>
                  </td>

                  <td className="py-3 px-4 font-semibold text-wopr-text">{log.target}</td>

                  <td className="py-3 px-4 font-sans text-wopr-text max-w-md">
                    <p className="line-clamp-2">{log.detail}</p>
                  </td>

                  <td className="py-3 px-4 text-right whitespace-nowrap">
                    <div className="flex justify-end">{getResultBadge(log.result)}</div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {audit.items.length < audit.total && (
          <div className="p-3 border-t border-wopr-border flex justify-center">
            <button
              onClick={() => setLimit((l) => l + PAGE_SIZE)}
              disabled={loading}
              className="px-3 py-1.5 rounded-lg bg-white/5 hover:bg-white/10 border border-wopr-border text-xs text-wopr-text disabled:opacity-40"
            >
              {loading ? 'Chargement…' : `Charger ${Math.min(PAGE_SIZE, audit.total - audit.items.length)} de plus`}
            </button>
          </div>
        )}
      </div>
    </div>
  );
};
