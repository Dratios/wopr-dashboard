import React from 'react';

/**
 * Affiche une mesure qui peut ne pas être disponible.
 *
 * Le backend renvoie `null` plutôt qu'un chiffre plausible quand il ne sait pas
 * (RAPL illisible, capteur absent, carte sans ventilateur…). Ce composant rend ce
 * `null` visible — un tiret et une explication au survol — au lieu de le laisser
 * s'afficher en « 0 », qui se lirait comme une mesure.
 */
interface MeasureProps {
  value: number | null | undefined;
  unit?: string;
  /** Décimales à afficher. Par défaut : l'entier le plus proche. */
  digits?: number;
  /** Ce qui est dit au survol quand la valeur manque. */
  unavailableHint?: string;
  className?: string;
}

export const Measure: React.FC<MeasureProps> = ({
  value,
  unit,
  digits = 0,
  unavailableHint = 'Mesure indisponible sur cette machine',
  className,
}) => {
  if (value === null || value === undefined || Number.isNaN(value)) {
    return (
      <span className={className} title={unavailableHint}>
        <span className="text-wopr-textSubtle">—</span>
      </span>
    );
  }
  return (
    <span className={className}>
      {value.toFixed(digits)}
      {unit ? <span className="text-wopr-textMuted font-normal"> {unit}</span> : null}
    </span>
  );
};

/** Variante texte, pour les chaînes qui peuvent manquer (gouverneur, PCIe, VBIOS…). */
export const TextValue: React.FC<{
  value: string | null | undefined;
  unavailableHint?: string;
  className?: string;
}> = ({ value, unavailableHint = 'Information non exposée par le matériel', className }) => {
  if (!value) {
    return (
      <span className={className} title={unavailableHint}>
        <span className="text-wopr-textSubtle">—</span>
      </span>
    );
  }
  return <span className={className}>{value}</span>;
};
