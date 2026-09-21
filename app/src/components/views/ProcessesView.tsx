import React, { useState } from 'react';
import { useWoprStore } from '../../state/useWoprStore';
import { store } from '../../state/store';
import { ConfirmDialog } from '../common/ConfirmDialog';
import { ViewId } from '../layout/Sidebar';
import {
  ListTree,
  List,
  Search,
  Sliders,
  Trash2,
  Boxes,
  Cpu,
  Layers,
  ArrowUpDown,
  AlertOctagon,
} from 'lucide-react';
import { ProcessItem } from '../../state/types';

interface ProcessesViewProps {
  onNavigate: (view: ViewId) => void;
}

export const ProcessesView: React.FC<ProcessesViewProps> = ({ onNavigate }) => {
  const { processes } = useWoprStore();
  const { summary, processes: processList } = processes;

  const [searchQuery, setSearchQuery] = useState('');
  const [userFilter, setUserFilter] = useState('all');
  const [viewMode, setViewMode] = useState<'flat' | 'tree'>('flat');
  const [sortBy, setSortBy] = useState<'cpu' | 'mem' | 'pid'>('cpu');

  // Kill modal state
  const [processToKill, setProcessToKill] = useState<{ proc: ProcessItem; signal: 'SIGTERM' | 'SIGKILL' } | null>(null);

  // Renice modal state
  const [processToRenice, setProcessToRenice] = useState<ProcessItem | null>(null);
  const [targetNice, setTargetNice] = useState<number>(0);

  const handleOpenRenice = (proc: ProcessItem) => {
    setProcessToRenice(proc);
    setTargetNice(proc.nice);
  };

  const compare = (a: ProcessItem, b: ProcessItem) => {
    if (sortBy === 'cpu') return b.cpuPct - a.cpuPct;
    if (sortBy === 'mem') return b.rssMiB - a.rssMiB;
    return a.pid - b.pid;
  };

  const filteredFlat = processList
    .filter((p) => {
      if (userFilter !== 'all' && p.user !== userFilter) return false;
      if (
        searchQuery &&
        !p.cmd.toLowerCase().includes(searchQuery.toLowerCase()) &&
        !p.pid.toString().includes(searchQuery) &&
        !p.user.toLowerCase().includes(searchQuery.toLowerCase())
      ) {
        return false;
      }
      return true;
    })
    .sort(compare);

  // Vue arborescente réelle : chaque processus sous son parent, avec sa profondeur.
  // L'ancienne vue gardait l'ordre à plat et préfixait « └── » tout PPID ≠ 1.
  const rows: { proc: ProcessItem; depth: number }[] = (() => {
    if (viewMode === 'flat') return filteredFlat.map((proc) => ({ proc, depth: 0 }));
    const pids = new Set(filteredFlat.map((p) => p.pid));
    const children = new Map<number, ProcessItem[]>();
    const roots: ProcessItem[] = [];
    for (const proc of filteredFlat) {
      if (proc.ppid !== proc.pid && pids.has(proc.ppid)) {
        const list = children.get(proc.ppid) ?? [];
        list.push(proc);
        children.set(proc.ppid, list);
      } else {
        roots.push(proc);
      }
    }
    const out: { proc: ProcessItem; depth: number }[] = [];
    const walk = (proc: ProcessItem, depth: number) => {
      out.push({ proc, depth });
      (children.get(proc.pid) ?? []).sort(compare).forEach((child) => walk(child, depth + 1));
    };
    roots.sort(compare).forEach((root) => walk(root, 0));
    return out;
  })();

  const uniqueUsers = Array.from(new Set(processList.map((p) => p.user)));

  return (
    <div className="space-y-6 animate-in fade-in duration-200">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pb-4 border-b border-wopr-border">
        <div>
          <h1 className="text-xl font-bold tracking-tight text-wopr-text flex items-center gap-2.5">
            <ListTree className="w-5 h-5 text-wopr-accent" />
            <span>Processus Système & Arborescence</span>
          </h1>
          <p className="text-xs text-wopr-textMuted mt-1">
            Liste rafraîchie toutes les 10 s · {processList.length < summary.count
              ? `les ${processList.length} plus gourmands en CPU sur ${summary.count}`
              : `${summary.count} processus`} · signaux SIGTERM/SIGKILL et priorité renice
          </p>
        </div>

        {/* Stats Strip */}
        <div className="flex items-center gap-2 text-xs font-mono">
          <span className="px-2.5 py-1 rounded-md bg-wopr-surface2 border border-wopr-border text-wopr-text">
            {summary.count} processus
          </span>
          <span className="px-2.5 py-1 rounded-md bg-wopr-surface2 border border-wopr-border text-wopr-text">
            {summary.threads} threads
          </span>
          <span
            className={`px-2.5 py-1 rounded-md border ${
              summary.zombies > 0
                ? 'bg-amber-500/15 text-amber-400 border-amber-500/30'
                : 'bg-emerald-500/15 text-emerald-400 border-emerald-500/30'
            }`}
          >
            {summary.zombies} zombie{summary.zombies > 1 ? 's' : ''}
          </span>
        </div>
      </div>

      {/* Toolbar (Search, Filter, ViewMode, Sort) */}
      <div className="flex flex-col sm:flex-row items-center justify-between gap-3 bg-wopr-surface border border-wopr-border rounded-xl p-3">
        <div className="flex items-center gap-3 w-full sm:w-auto">
          <div className="relative w-full sm:w-64">
            <Search className="w-4 h-4 text-wopr-textMuted absolute left-3 top-2.5" />
            <input
              type="text"
              placeholder="Rechercher PID, commande..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full bg-[#0d1117] border border-wopr-border rounded-lg pl-9 pr-3 py-1.5 text-xs text-wopr-text placeholder:text-wopr-textSubtle focus:outline-none focus:border-wopr-accent"
            />
          </div>

          <select
            value={userFilter}
            onChange={(e) => setUserFilter(e.target.value)}
            className="bg-[#0d1117] border border-wopr-border rounded-lg px-2.5 py-1.5 text-xs text-wopr-text focus:outline-none font-mono"
          >
            <option value="all">Tous les utilisateurs</option>
            {uniqueUsers.map((u) => (
              <option key={u} value={u}>
                user: {u}
              </option>
            ))}
          </select>
        </div>

        <div className="flex items-center gap-2 w-full sm:w-auto justify-end">
          <div className="flex items-center gap-1 bg-[#0d1117] p-1 rounded-lg border border-wopr-border text-xs font-mono">
            <button
              onClick={() => setSortBy('cpu')}
              className={`px-2 py-0.5 rounded transition-colors ${
                sortBy === 'cpu' ? 'bg-wopr-surface2 text-wopr-accent font-bold' : 'text-wopr-textMuted'
              }`}
            >
              Tri CPU
            </button>
            <button
              onClick={() => setSortBy('mem')}
              className={`px-2 py-0.5 rounded transition-colors ${
                sortBy === 'mem' ? 'bg-wopr-surface2 text-wopr-accent font-bold' : 'text-wopr-textMuted'
              }`}
            >
              Tri MEM
            </button>
            <button
              onClick={() => setSortBy('pid')}
              className={`px-2 py-0.5 rounded transition-colors ${
                sortBy === 'pid' ? 'bg-wopr-surface2 text-wopr-accent font-bold' : 'text-wopr-textMuted'
              }`}
            >
              Tri PID
            </button>
          </div>

          <div className="flex items-center gap-1 bg-[#0d1117] p-1 rounded-lg border border-wopr-border text-xs">
            <button
              onClick={() => setViewMode('flat')}
              className={`p-1 rounded ${
                viewMode === 'flat' ? 'bg-wopr-surface2 text-wopr-accent' : 'text-wopr-textMuted'
              }`}
              title="Vue plate"
            >
              <List className="w-4 h-4" />
            </button>
            <button
              onClick={() => setViewMode('tree')}
              className={`p-1 rounded ${
                viewMode === 'tree' ? 'bg-wopr-surface2 text-wopr-accent' : 'text-wopr-textMuted'
              }`}
              title="Vue arborescente PPID"
            >
              <ListTree className="w-4 h-4" />
            </button>
          </div>
        </div>
      </div>

      {/* Processes Table */}
      <div className="bg-wopr-surface border border-wopr-border rounded-xl overflow-hidden shadow-sm">
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead className="border-b border-wopr-border text-wopr-textMuted uppercase font-mono text-[11px] bg-[#0d1117]/50">
              <tr>
                <th className="py-2.5 px-4 font-medium">PID / PPID</th>
                <th className="py-2.5 px-4 font-medium">Utilisateur</th>
                <th className="py-2.5 px-4 font-medium">Commande système</th>
                <th className="py-2.5 px-4 font-medium">CPU %</th>
                <th className="py-2.5 px-4 font-medium">RSS (Mio)</th>
                <th className="py-2.5 px-4 font-medium">Threads</th>
                <th className="py-2.5 px-4 font-medium">Nice</th>
                <th className="py-2.5 px-4 font-medium">État</th>
                <th className="py-2.5 px-4 font-medium text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-wopr-border/40 font-mono">
              {rows.map(({ proc, depth }) => {
                const isHeavyCpu = proc.cpuPct > 50;
                const isHeavyMem = proc.rssMiB > 1000;

                return (
                  <tr key={proc.pid} className="hover:bg-white/5 transition-colors">
                    <td className="py-2.5 px-4">
                      <span className="font-bold text-wopr-accent">{proc.pid}</span>
                      <span className="text-[10px] text-wopr-textSubtle ml-1">({proc.ppid})</span>
                    </td>

                    <td className="py-2.5 px-4 text-wopr-text font-sans font-medium">
                      {proc.user}
                    </td>

                    <td className="py-2.5 px-4 font-mono text-wopr-text max-w-xs">
                      <div className="truncate font-semibold" title={proc.cmd}>
                        {depth > 0 && (
                          <span className="text-wopr-textSubtle" style={{ paddingLeft: `${(depth - 1) * 12}px` }}>
                            └{' '}
                          </span>
                        )}
                        {proc.cmd}
                      </div>
                      {proc.containerId && (
                        <button
                          onClick={() => onNavigate('docker')}
                          className="text-[10px] text-purple-400 hover:underline flex items-center gap-1 mt-0.5"
                        >
                          <Boxes className="w-3 h-3" />
                          <span>Conteneur {proc.containerId}</span>
                        </button>
                      )}
                    </td>

                    <td className="py-2.5 px-4 font-bold tabular">
                      <span className={isHeavyCpu ? 'text-rose-400' : 'text-wopr-text'}>
                        {proc.cpuPct.toFixed(1)} %
                      </span>
                    </td>

                    <td className="py-2.5 px-4 font-medium tabular">
                      <span className={isHeavyMem ? 'text-amber-400 font-bold' : 'text-wopr-text'}>
                        {proc.rssMiB} Mio
                      </span>
                    </td>

                    <td className="py-2.5 px-4 text-wopr-textMuted">{proc.threads}</td>

                    <td className="py-2.5 px-4 text-wopr-textMuted">{proc.nice}</td>

                    <td className="py-2.5 px-4">
                      <span className="px-1.5 py-0.5 rounded bg-wopr-surface2 text-wopr-text text-[10px] border border-wopr-border font-bold">
                        {proc.state}
                      </span>
                    </td>

                    <td className="py-2.5 px-4 text-right">
                      <div className="flex items-center justify-end gap-1.5">
                        <button
                          onClick={() => handleOpenRenice(proc)}
                          className="p-1 rounded text-wopr-textMuted hover:text-wopr-text hover:bg-white/5 transition-colors"
                          title="Ajuster la priorité renice"
                        >
                          <Sliders className="w-3.5 h-3.5" />
                        </button>

                        <button
                          onClick={() => setProcessToKill({ proc, signal: 'SIGTERM' })}
                          className="px-2 py-0.5 rounded bg-rose-500/10 hover:bg-rose-500/20 text-rose-300 border border-rose-500/30 text-[10px] font-semibold transition-colors"
                          title="Envoyer signal SIGTERM"
                        >
                          TERM
                        </button>

                        <button
                          onClick={() => setProcessToKill({ proc, signal: 'SIGKILL' })}
                          className="px-2 py-0.5 rounded bg-rose-500/20 hover:bg-rose-500/30 text-rose-200 border border-rose-500/40 text-[10px] font-bold transition-colors"
                          title="Tuer immédiatement (SIGKILL)"
                        >
                          KILL
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      {/* Kill Process Modal */}
      {processToKill && (
        <ConfirmDialog
          isOpen={!!processToKill}
          title={`Signal ${processToKill.signal} sur PID ${processToKill.proc.pid}`}
          isDestructive={true}
          description={
            <div>
              <p>
                Êtes-vous certain de vouloir envoyer le signal{' '}
                <strong className="text-rose-400 font-mono">{processToKill.signal}</strong> au processus
                suivant ?
              </p>
              <div className="mt-2.5 p-2.5 rounded-lg bg-[#0d1117] border border-wopr-border text-xs font-mono">
                <div>Commande : {processToKill.proc.cmd}</div>
                <div className="text-wopr-textMuted mt-1">
                  PID: {processToKill.proc.pid} · User: {processToKill.proc.user}
                </div>
              </div>
            </div>
          }
          confirmText={`Envoyer ${processToKill.signal}`}
          onConfirm={() => {
            store.killProcess(processToKill.proc.pid, processToKill.signal);
            setProcessToKill(null);
          }}
          onCancel={() => setProcessToKill(null)}
        />
      )}

      {/* Renice Process Modal */}
      {processToRenice && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/75 backdrop-blur-sm animate-in fade-in">
          <div className="w-full max-w-sm bg-[#161b22] border border-wopr-border rounded-xl p-5 shadow-2xl space-y-4">
            <h3 className="text-sm font-semibold text-wopr-text pb-2 border-b border-wopr-border">
              Priorité Renice (PID {processToRenice.pid})
            </h3>

            <div>
              <div className="flex justify-between text-xs font-mono mb-2">
                <span className="text-wopr-textMuted">Priorité cible :</span>
                <span className="font-bold text-wopr-accent text-sm">{targetNice}</span>
              </div>
              <input
                type="range"
                min={-20}
                max={19}
                value={targetNice}
                onChange={(e) => setTargetNice(Number(e.target.value))}
                className="w-full accent-wopr-accent cursor-pointer"
              />
              <div className="flex justify-between text-[10px] font-mono text-wopr-textSubtle mt-1">
                <span>-20 (Priorité maximale)</span>
                <span>0 (Standard)</span>
                <span>+19 (Basse priorité)</span>
              </div>
            </div>

            <div className="flex justify-end gap-2 pt-2 border-t border-wopr-border">
              <button
                onClick={() => setProcessToRenice(null)}
                className="px-3 py-1.5 rounded-lg text-xs text-wopr-textMuted hover:text-wopr-text"
              >
                Annuler
              </button>
              <button
                onClick={() => {
                  store.reniceProcess(processToRenice.pid, targetNice);
                  setProcessToRenice(null);
                }}
                className="px-4 py-1.5 rounded-lg bg-wopr-accent hover:bg-wopr-accentHover text-white text-xs font-semibold"
              >
                Appliquer renice
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
