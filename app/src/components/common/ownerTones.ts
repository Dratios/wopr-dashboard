/**
 * Habillage des identités d'administrateur, teinte par teinte.
 *
 * Tailwind ne compile que les classes qu'il trouve **littéralement** dans les
 * sources : `bg-${tone}-500/15` ne produirait aucun style. Les combinaisons
 * sont donc écrites en toutes lettres ici, une fois, et les vues piochent
 * dedans à partir de la teinte déclarée dans `config/owners.yaml`.
 *
 * Ajouter une teinte = ajouter une entrée ici et dans `OwnerTone` (types.ts).
 */

import type { OwnerTone } from '../../state/types';

export interface OwnerToneStyle {
  /** Badge d'appartenance (fond + texte + bordure). */
  badge: string;
  /** Texte seul, pour un nom affiché hors badge. */
  text: string;
  /** Pastille d'icône des cartes de synthèse. */
  bubble: string;
  /** Carte de synthèse, filtre actif. */
  cardSelected: string;
  /** Carte de synthèse au repos (la bordure change au survol). */
  cardIdle: string;
  /** Pastille de filtre, sélectionnée. */
  chipSelected: string;
  /** Pastille de filtre, au repos. */
  chipIdle: string;
}

export const OWNER_TONES: Record<OwnerTone, OwnerToneStyle> = {
  cyan: {
    badge: 'bg-cyan-500/15 text-cyan-400 border-cyan-500/30',
    text: 'text-cyan-400',
    bubble: 'bg-cyan-500/20 text-cyan-400',
    cardSelected: 'bg-cyan-500/15 border-cyan-500/50 shadow-sm shadow-cyan-500/10 ring-1 ring-cyan-500/40',
    cardIdle: 'bg-wopr-surface border-wopr-border hover:border-cyan-500/30 hover:bg-cyan-500/[0.04]',
    chipSelected: 'bg-cyan-500 text-black font-bold shadow-sm',
    chipIdle: 'bg-cyan-500/10 text-cyan-400 border border-cyan-500/20 hover:bg-cyan-500/20',
  },
  purple: {
    badge: 'bg-purple-500/15 text-purple-300 border-purple-500/30',
    text: 'text-purple-300',
    bubble: 'bg-purple-500/20 text-purple-300',
    cardSelected: 'bg-purple-500/15 border-purple-500/50 shadow-sm shadow-purple-500/10 ring-1 ring-purple-500/40',
    cardIdle: 'bg-wopr-surface border-wopr-border hover:border-purple-500/30 hover:bg-purple-500/[0.04]',
    chipSelected: 'bg-purple-500 text-white font-bold shadow-sm',
    chipIdle: 'bg-purple-500/10 text-purple-300 border border-purple-500/20 hover:bg-purple-500/20',
  },
  emerald: {
    badge: 'bg-emerald-500/15 text-emerald-400 border-emerald-500/30',
    text: 'text-emerald-400',
    bubble: 'bg-emerald-500/20 text-emerald-400',
    cardSelected: 'bg-emerald-500/15 border-emerald-500/50 shadow-sm shadow-emerald-500/10 ring-1 ring-emerald-500/40',
    cardIdle: 'bg-wopr-surface border-wopr-border hover:border-emerald-500/30 hover:bg-emerald-500/[0.04]',
    chipSelected: 'bg-emerald-500 text-black font-bold shadow-sm',
    chipIdle: 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 hover:bg-emerald-500/20',
  },
  amber: {
    badge: 'bg-amber-500/15 text-amber-300 border-amber-500/30',
    text: 'text-amber-300',
    bubble: 'bg-amber-500/20 text-amber-300',
    cardSelected: 'bg-amber-500/15 border-amber-500/50 shadow-sm shadow-amber-500/10 ring-1 ring-amber-500/40',
    cardIdle: 'bg-wopr-surface border-wopr-border hover:border-amber-500/30 hover:bg-amber-500/[0.04]',
    chipSelected: 'bg-amber-500 text-black font-bold shadow-sm',
    chipIdle: 'bg-amber-500/10 text-amber-300 border border-amber-500/20 hover:bg-amber-500/20',
  },
  rose: {
    badge: 'bg-rose-500/15 text-rose-300 border-rose-500/30',
    text: 'text-rose-300',
    bubble: 'bg-rose-500/20 text-rose-300',
    cardSelected: 'bg-rose-500/15 border-rose-500/50 shadow-sm shadow-rose-500/10 ring-1 ring-rose-500/40',
    cardIdle: 'bg-wopr-surface border-wopr-border hover:border-rose-500/30 hover:bg-rose-500/[0.04]',
    chipSelected: 'bg-rose-500 text-white font-bold shadow-sm',
    chipIdle: 'bg-rose-500/10 text-rose-300 border border-rose-500/20 hover:bg-rose-500/20',
  },
  sky: {
    badge: 'bg-sky-500/15 text-sky-300 border-sky-500/30',
    text: 'text-sky-300',
    bubble: 'bg-sky-500/20 text-sky-300',
    cardSelected: 'bg-sky-500/15 border-sky-500/50 shadow-sm shadow-sky-500/10 ring-1 ring-sky-500/40',
    cardIdle: 'bg-wopr-surface border-wopr-border hover:border-sky-500/30 hover:bg-sky-500/[0.04]',
    chipSelected: 'bg-sky-500 text-black font-bold shadow-sm',
    chipIdle: 'bg-sky-500/10 text-sky-300 border border-sky-500/20 hover:bg-sky-500/20',
  },
  slate: {
    badge: 'bg-slate-500/15 text-slate-300 border-slate-500/30',
    text: 'text-slate-300',
    bubble: 'bg-slate-500/20 text-slate-300',
    cardSelected: 'bg-slate-500/15 border-slate-500/50 shadow-sm shadow-slate-500/10 ring-1 ring-slate-500/40',
    cardIdle: 'bg-wopr-surface border-wopr-border hover:border-slate-500/30 hover:bg-slate-500/[0.04]',
    chipSelected: 'bg-slate-500 text-white font-bold shadow-sm',
    chipIdle: 'bg-slate-500/10 text-slate-300 border border-slate-500/20 hover:bg-slate-500/20',
  },
};

/** Style d'une teinte, avec repli gris si elle est inconnue ou absente. */
export const ownerTone = (tone: OwnerTone | undefined): OwnerToneStyle =>
  OWNER_TONES[tone as OwnerTone] ?? OWNER_TONES.slate;
