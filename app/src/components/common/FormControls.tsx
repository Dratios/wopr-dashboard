/**
 * Contrôles de formulaire de l'onglet Paramètres.
 *
 * L'application n'en avait aucun : chaque vue redessinait son `<input>` à la
 * main. Ceux-ci reprennent exactement les classes déjà employées (LoginView,
 * ModeActivationDialog, ThermalFansView) et sont réutilisables ailleurs.
 */

import React, { useId, useState } from 'react';
import { Eye, EyeOff, RotateCcw, Check } from 'lucide-react';

/** Classes du champ texte, identiques à celles de l'écran de connexion. */
export const INPUT_CLASS =
  'w-full bg-[#0d1117] border border-wopr-border rounded-lg px-3 py-1.5 text-xs ' +
  'text-wopr-text placeholder:text-wopr-textSubtle focus:outline-none ' +
  'focus:border-wopr-accent focus:ring-1 focus:ring-wopr-accent transition-colors ' +
  'disabled:opacity-40 disabled:cursor-not-allowed';

export const SELECT_CLASS =
  'w-full bg-[#0d1117] border border-wopr-border rounded-lg px-2.5 py-1.5 text-xs ' +
  'text-wopr-text focus:outline-none focus:border-wopr-accent transition-colors ' +
  'disabled:opacity-40 disabled:cursor-not-allowed';

export const BUTTON_PRIMARY =
  'px-4 py-1.5 rounded-lg bg-wopr-accent hover:bg-wopr-accentHover text-white ' +
  'text-xs font-semibold transition-colors disabled:opacity-40 disabled:cursor-not-allowed';

export const BUTTON_GHOST =
  'px-3 py-1.5 rounded-lg text-xs font-medium text-wopr-textMuted hover:text-wopr-text ' +
  'bg-white/5 hover:bg-white/10 border border-wopr-border transition-colors ' +
  'disabled:opacity-40 disabled:cursor-not-allowed';

// --------------------------------------------------------------- interrupteur

interface ToggleProps {
  checked: boolean;
  onChange: (value: boolean) => void;
  disabled?: boolean;
  label?: string;
}

export const Toggle: React.FC<ToggleProps> = ({ checked, onChange, disabled, label }) => (
  <button
    type="button"
    role="switch"
    aria-checked={checked}
    aria-label={label}
    disabled={disabled}
    onClick={() => onChange(!checked)}
    className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full border
                transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${
      checked
        ? 'bg-wopr-accent border-wopr-accent'
        : 'bg-[#0d1117] border-wopr-border hover:border-wopr-borderLight'
    }`}
  >
    <span
      className={`inline-block h-3.5 w-3.5 rounded-full bg-white shadow transition-transform ${
        checked ? 'translate-x-[18px]' : 'translate-x-[3px]'
      }`}
    />
  </button>
);

// ----------------------------------------------------------- contrôle segmenté

interface SegmentedProps<T extends string> {
  value: T;
  options: { value: T; label: string; title?: string }[];
  onChange: (value: T) => void;
  disabled?: boolean;
  size?: 'sm' | 'md';
}

export function SegmentedControl<T extends string>({
  value, options, onChange, disabled, size = 'md',
}: SegmentedProps<T>) {
  return (
    <div className="inline-flex rounded-lg border border-wopr-border overflow-hidden bg-[#0d1117]">
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          title={option.title}
          disabled={disabled}
          onClick={() => onChange(option.value)}
          className={`${size === 'sm' ? 'px-2 py-1 text-[10px]' : 'px-3 py-1.5 text-xs'}
                      font-medium transition-colors disabled:opacity-40
                      disabled:cursor-not-allowed ${
            value === option.value
              ? 'bg-wopr-accent text-white'
              : 'text-wopr-textMuted hover:text-wopr-text hover:bg-white/5'
          }`}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

// --------------------------------------------------------------- champ secret

interface SecretInputProps {
  value: string;
  onChange: (value: string) => void;
  /** Une valeur est-elle déjà enregistrée côté serveur ? */
  isSet: boolean;
  disabled?: boolean;
  placeholder?: string;
}

/**
 * Le serveur ne renvoie jamais un secret en clair : le champ part donc vide et
 * n'envoie quelque chose que si l'on saisit une nouvelle valeur. Laisser vide
 * signifie « inchangé », jamais « effacer ».
 */
export const SecretInput: React.FC<SecretInputProps> = ({
  value, onChange, isSet, disabled, placeholder,
}) => {
  const [revealed, setRevealed] = useState(false);
  return (
    <div className="space-y-1">
      <div className="relative">
        <input
          type={revealed ? 'text' : 'password'}
          value={value}
          disabled={disabled}
          autoComplete="new-password"
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder ?? (isSet ? '•••••••••••• (inchangé)' : 'non défini')}
          className={`${INPUT_CLASS} pr-9 font-mono`}
        />
        <button
          type="button"
          tabIndex={-1}
          onClick={() => setRevealed((r) => !r)}
          className="absolute right-2 top-1/2 -translate-y-1/2 text-wopr-textMuted
                     hover:text-wopr-text transition-colors"
          aria-label={revealed ? 'Masquer' : 'Afficher'}
        >
          {revealed ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
        </button>
      </div>
      <p className="text-[10px] text-wopr-textSubtle flex items-center gap-1">
        {isSet ? (
          <><Check className="w-3 h-3 text-wopr-ok" /> Une valeur est enregistrée.
            Laisser vide pour la conserver.</>
        ) : (
          <>Aucune valeur enregistrée.</>
        )}
      </p>
    </div>
  );
};

// ------------------------------------------------------------- ligne de réglage

interface FieldRowProps {
  label: string;
  help?: string;
  /** Badge de portée : « à chaud » ou « recréation ». */
  scope?: 'live' | 'cold';
  /** Affiché quand la valeur diffère du défaut, avec le bouton de retour. */
  defaultHint?: string;
  onRevert?: () => void;
  modified?: boolean;
  envName?: string | null;
  source?: string;
  children: React.ReactNode;
}

export const FieldRow: React.FC<FieldRowProps> = ({
  label, help, scope, defaultHint, onRevert, modified, envName, source, children,
}) => {
  const id = useId();
  return (
    <div
      className={`flex flex-col sm:flex-row sm:items-start gap-3 py-3 px-3 -mx-1 rounded-lg
                  transition-colors ${modified ? 'bg-wopr-accent/5 ring-1 ring-wopr-accent/25' : ''}`}
    >
      <div className="sm:w-1/2 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <label htmlFor={id} className="text-xs font-medium text-wopr-text">{label}</label>
          {scope === 'cold' && (
            <span
              title="Lu à la création du conteneur : la modification attendra une recréation."
              className="text-[9px] uppercase tracking-wider px-1.5 py-0.5 rounded
                         bg-wopr-warn/15 text-wopr-warn border border-wopr-warn/30"
            >
              recréation
            </span>
          )}
          {scope === 'live' && (
            <span
              title="Appliqué immédiatement, sans redémarrage."
              className="text-[9px] uppercase tracking-wider px-1.5 py-0.5 rounded
                         bg-wopr-ok/10 text-wopr-ok border border-wopr-ok/25"
            >
              à chaud
            </span>
          )}
        </div>
        {help && <p className="text-[11px] text-wopr-textMuted mt-1 leading-relaxed">{help}</p>}
        <div className="flex items-center gap-2 mt-1 flex-wrap">
          {defaultHint && (
            <span className="text-[10px] text-wopr-textSubtle font-mono">{defaultHint}</span>
          )}
          {envName && (
            <span
              title="Variable d'environnement correspondante dans le .env"
              className="text-[10px] text-wopr-textSubtle font-mono opacity-70"
            >
              {envName}
            </span>
          )}
          {source === 'env' && (
            <span className="text-[10px] text-wopr-textSubtle">valeur venue du .env</span>
          )}
          {onRevert && (
            <button
              type="button"
              onClick={onRevert}
              className="text-[10px] text-wopr-accent hover:underline flex items-center gap-1"
            >
              <RotateCcw className="w-3 h-3" /> revenir au défaut
            </button>
          )}
        </div>
      </div>
      <div className="sm:w-1/2 sm:pt-0.5" id={id}>{children}</div>
    </div>
  );
};

// ------------------------------------------------------------------ carte

export const SettingsCard: React.FC<{
  title?: string;
  description?: string;
  action?: React.ReactNode;
  children: React.ReactNode;
}> = ({ title, description, action, children }) => (
  <div className="bg-wopr-surface border border-wopr-border rounded-xl p-5">
    {(title || action) && (
      <div className="flex items-start justify-between gap-3 mb-2">
        <div>
          {title && (
            <h3 className="text-xs font-semibold uppercase tracking-wider text-wopr-text">
              {title}
            </h3>
          )}
          {description && (
            <p className="text-[11px] text-wopr-textMuted mt-1 max-w-2xl leading-relaxed">
              {description}
            </p>
          )}
        </div>
        {action}
      </div>
    )}
    <div className="divide-y divide-wopr-border/40">{children}</div>
  </div>
);
