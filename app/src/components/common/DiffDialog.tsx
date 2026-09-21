/**
 * Aperçu « avant → après » d'un enregistrement de réglages.
 *
 * Une page de paramètres complète permet de changer beaucoup de choses d'un
 * coup, dont l'adresse d'écoute ou le mot de passe de la base. Montrer le diff
 * avant d'écrire évite d'appliquer sans s'en rendre compte une valeur qu'on
 * avait juste effleurée.
 */

import React from 'react';
import { X, ArrowRight, AlertTriangle } from 'lucide-react';
import { BUTTON_GHOST, BUTTON_PRIMARY } from './FormControls';

export interface DiffEntry {
  key: string;
  label: string;
  before: string;
  after: string;
  scope: 'live' | 'cold';
}

interface DiffDialogProps {
  isOpen: boolean;
  entries: DiffEntry[];
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

export const DiffDialog: React.FC<DiffDialogProps> = ({
  isOpen, entries, busy, onConfirm, onCancel,
}) => {
  if (!isOpen) return null;
  const cold = entries.filter((e) => e.scope === 'cold');

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/75
                    backdrop-blur-sm animate-in fade-in duration-200">
      <div className="relative w-full max-w-2xl bg-[#161b22] border border-wopr-border
                      rounded-xl shadow-2xl p-6 max-h-[85vh] flex flex-col">
        <div className="flex items-start justify-between gap-4 mb-4">
          <div>
            <h3 className="text-base font-semibold text-wopr-text tracking-wide">
              {entries.length} modification{entries.length > 1 ? 's' : ''} à enregistrer
            </h3>
            <p className="text-[11px] text-wopr-textMuted mt-1">
              Les valeurs secrètes sont masquées.
            </p>
          </div>
          <button
            onClick={onCancel}
            className="text-wopr-textMuted hover:text-wopr-text p-1 rounded-lg
                       hover:bg-white/5 transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {cold.length > 0 && (
          <div className="mb-4 p-3 rounded-lg bg-amber-500/10 border border-amber-500/25
                          flex items-start gap-2.5 text-xs text-amber-300">
            <AlertTriangle className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" />
            <div>
              <p className="font-semibold">
                {cold.length} réglage{cold.length > 1 ? 's' : ''} ne prendra effet qu'à la
                recréation du conteneur.
              </p>
              <p className="text-amber-300/80 mt-0.5">
                La valeur sera écrite dans le <code className="font-mono">.env</code> ;
                la commande à lancer s'affichera ensuite.
              </p>
            </div>
          </div>
        )}

        <div className="flex-1 overflow-y-auto -mx-1 px-1">
          <table className="w-full text-xs">
            <tbody className="divide-y divide-wopr-border/40">
              {entries.map((entry) => (
                <tr key={entry.key} className="align-top">
                  <td className="py-2 pr-3 w-2/5">
                    <div className="text-wopr-text">{entry.label}</div>
                    <div className="text-[10px] text-wopr-textSubtle font-mono">{entry.key}</div>
                  </td>
                  <td className="py-2">
                    <div className="flex items-center gap-2 flex-wrap font-mono">
                      <span className="px-1.5 py-0.5 rounded bg-rose-500/10 text-rose-300
                                       border border-rose-500/20 line-through decoration-rose-400/50">
                        {entry.before}
                      </span>
                      <ArrowRight className="w-3 h-3 text-wopr-textSubtle shrink-0" />
                      <span className="px-1.5 py-0.5 rounded bg-wopr-ok/10 text-wopr-ok
                                       border border-wopr-ok/25">
                        {entry.after}
                      </span>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="flex items-center justify-end gap-3 pt-4 mt-2 border-t border-wopr-border/50">
          <button type="button" onClick={onCancel} className={BUTTON_GHOST}>Annuler</button>
          <button type="button" onClick={onConfirm} disabled={busy} className={BUTTON_PRIMARY}>
            {busy ? 'Enregistrement…' : 'Enregistrer'}
          </button>
        </div>
      </div>
    </div>
  );
};
