/**
 * Rend un réglage à partir de sa description envoyée par le serveur.
 *
 * Le registre Python (`server/settings.py`) porte le libellé, l'aide, le type,
 * les bornes et la portée ; ce composant ne fait que les traduire en contrôle.
 * Ajouter un réglage côté serveur suffit donc à le faire apparaître ici.
 */

import React from 'react';
import type { SettingDescriptor } from '../../state/settingsTypes';
import {
  FieldRow, INPUT_CLASS, SELECT_CLASS, SecretInput, Toggle,
} from '../common/FormControls';

interface SettingFieldProps {
  setting: SettingDescriptor;
  value: unknown;
  onChange: (value: unknown) => void;
  modified: boolean;
  onRevert: () => void;
}

/** Représentation lisible d'une valeur, pour la mention « défaut : … ». */
export function formatValue(setting: SettingDescriptor, value: unknown): string {
  if (setting.secret) return value ? '••••' : 'non défini';
  if (typeof value === 'boolean') return value ? 'activé' : 'désactivé';
  if (value === '' || value === null || value === undefined) return '—';
  if (setting.choices && setting.choiceLabels && typeof value === 'string') {
    return setting.choiceLabels[value] ?? value;
  }
  return setting.unit ? `${value} ${setting.unit}` : String(value);
}

export const SettingField: React.FC<SettingFieldProps> = ({
  setting, value, onChange, modified, onRevert,
}) => {
  const disabled = setting.readonly;

  const control = () => {
    if (setting.secret) {
      return (
        <SecretInput
          value={typeof value === 'string' ? value : ''}
          onChange={onChange}
          isSet={Boolean(setting.isSet)}
          disabled={disabled}
        />
      );
    }
    if (setting.kind === 'bool') {
      return (
        <div className="flex items-center gap-2.5">
          <Toggle
            checked={Boolean(value)}
            onChange={onChange}
            disabled={disabled}
            label={setting.label}
          />
          <span className="text-[11px] text-wopr-textMuted">
            {value ? 'activé' : 'désactivé'}
          </span>
        </div>
      );
    }
    if (setting.kind === 'enum' && setting.choices) {
      return (
        <select
          value={String(value ?? '')}
          disabled={disabled}
          onChange={(e) => onChange(e.target.value)}
          className={SELECT_CLASS}
        >
          {setting.choices.map((choice) => (
            <option key={choice} value={choice}>
              {setting.choiceLabels?.[choice] ?? choice}
            </option>
          ))}
        </select>
      );
    }
    if (setting.kind === 'int' || setting.kind === 'float') {
      return (
        <div className="flex items-center gap-2">
          <input
            type="number"
            value={value === null || value === undefined ? '' : String(value)}
            disabled={disabled}
            min={setting.min ?? undefined}
            max={setting.max ?? undefined}
            step={setting.kind === 'int' ? 1 : 0.5}
            onChange={(e) => {
              const raw = e.target.value;
              if (raw === '') return onChange('');
              const parsed = setting.kind === 'int' ? parseInt(raw, 10) : parseFloat(raw);
              onChange(Number.isNaN(parsed) ? raw : parsed);
            }}
            className={`${INPUT_CLASS} font-mono tabular`}
          />
          {setting.unit && (
            <span className="text-[11px] text-wopr-textMuted shrink-0">{setting.unit}</span>
          )}
        </div>
      );
    }
    if (setting.kind === 'time') {
      return (
        <input
          type="time"
          value={String(value ?? '')}
          disabled={disabled}
          onChange={(e) => onChange(e.target.value)}
          className={`${INPUT_CLASS} font-mono tabular`}
        />
      );
    }
    return (
      <input
        type="text"
        value={String(value ?? '')}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
        className={`${INPUT_CLASS} ${setting.kind === 'url' ? 'font-mono' : ''}`}
      />
    );
  };

  const isDefault = JSON.stringify(value) === JSON.stringify(setting.default);

  return (
    <FieldRow
      label={setting.label}
      help={setting.help || undefined}
      scope={disabled ? undefined : setting.scope}
      envName={setting.env}
      source={setting.source}
      modified={modified}
      defaultHint={
        isDefault || setting.secret ? undefined
          : `défaut : ${formatValue(setting, setting.default)}`
      }
      onRevert={isDefault || disabled || setting.secret ? undefined : onRevert}
    >
      {control()}
      {disabled && (
        <p className="text-[10px] text-wopr-textSubtle mt-1">
          Figé dans le docker-compose.yml — lecture seule.
        </p>
      )}
    </FieldRow>
  );
};
