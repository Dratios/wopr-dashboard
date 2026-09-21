/**
 * Tableau des règles de notification, par famille d'alerte, et journal des envois.
 *
 * C'est le cœur de l'onglet : décider *quand* le serveur écrit sur Telegram.
 * Les familles viennent du serveur, qui les dérive des préfixes d'identifiant
 * produits par `alerts.py` — il n'y a donc pas de liste à tenir à jour ici.
 */

import React, { useEffect, useState } from 'react';
import { Send, RefreshCw, CheckCircle2, XCircle, Loader2 } from 'lucide-react';

import { api } from '../../state/api';
import { store } from '../../state/store';
import { ApiError } from '../../state/api';
import type {
  FamilyLevel, FamilyMeta, FamilyRule, NotificationJournalItem, SettingsData,
} from '../../state/settingsTypes';
import { BUTTON_GHOST, SELECT_CLASS, SettingsCard, Toggle } from '../common/FormControls';

// -------------------------------------------------------------- bouton de test

export const TelegramTestButton: React.FC<{
  botToken: string;
  chatId: string;
}> = ({ botToken, chatId }) => {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);

  const run = async () => {
    setBusy(true);
    setResult(null);
    try {
      // On envoie les valeurs saisies : c'est tout l'intérêt, vérifier un jeton
      // avant de l'enregistrer.
      const res = await api.testTelegram(botToken, chatId);
      setResult({ ok: true, message: res.detail });
    } catch (error) {
      setResult({
        ok: false,
        message: error instanceof ApiError ? error.message : String(error),
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-2">
      <button type="button" onClick={run} disabled={busy} className={BUTTON_GHOST}>
        {busy ? (
          <span className="flex items-center gap-1.5">
            <Loader2 className="w-3.5 h-3.5 animate-spin" /> Envoi…
          </span>
        ) : (
          <span className="flex items-center gap-1.5">
            <Send className="w-3.5 h-3.5" /> Envoyer un message de test
          </span>
        )}
      </button>
      {result && (
        <p
          className={`text-[11px] flex items-start gap-1.5 ${
            result.ok ? 'text-wopr-ok' : 'text-wopr-err'
          }`}
        >
          {result.ok
            ? <CheckCircle2 className="w-3.5 h-3.5 shrink-0 mt-px" />
            : <XCircle className="w-3.5 h-3.5 shrink-0 mt-px" />}
          <span>{result.message}</span>
        </p>
      )}
    </div>
  );
};

// ------------------------------------------------------------ tableau familles

interface RulesProps {
  meta: FamilyMeta[];
  levels: FamilyLevel[];
  levelLabels: Record<FamilyLevel, string>;
  rules: Record<string, FamilyRule>;
  serverRules: Record<string, FamilyRule>;
  minLevelLabel: string;
  onChange: (family: string, rule: FamilyRule) => void;
  disabled?: boolean;
}

export const FamilyRulesTable: React.FC<RulesProps> = ({
  meta, levels, levelLabels, rules, serverRules, minLevelLabel, onChange, disabled,
}) => {
  const setAll = (level: FamilyLevel) =>
    meta.forEach((f) => onChange(f.id, { ...(rules[f.id] ?? { resolved: true }), level }));

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <p className="text-[11px] text-wopr-textMuted max-w-2xl leading-relaxed">
          « Hérité » suit le niveau minimal réglé plus haut ({minLevelLabel}). Les autres
          valeurs s'appliquent à la famille seule. La colonne de droite décide si la
          disparition de l'alerte donne lieu à un second message.
        </p>
        <div className="flex items-center gap-2 shrink-0">
          <span className="text-[10px] text-wopr-textSubtle">tout régler sur</span>
          <button type="button" disabled={disabled} onClick={() => setAll('inherit')}
                  className="text-[10px] text-wopr-accent hover:underline">hérité</button>
          <span className="text-wopr-textSubtle">·</span>
          <button type="button" disabled={disabled} onClick={() => setAll('never')}
                  className="text-[10px] text-wopr-accent hover:underline">jamais</button>
        </div>
      </div>

      <div className="rounded-lg border border-wopr-border overflow-hidden">
        <table className="w-full text-xs">
          <thead className="bg-[#0d1117] text-wopr-textMuted">
            <tr>
              <th className="text-left font-medium px-3 py-2">Famille d'alerte</th>
              <th className="text-left font-medium px-3 py-2 w-56">Notifier</th>
              <th className="text-left font-medium px-3 py-2 w-28">Résolution</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-wopr-border/40">
            {meta.map((family) => {
              const rule = rules[family.id] ?? { level: 'inherit', resolved: true };
              const server = serverRules[family.id] ?? { level: 'inherit', resolved: true };
              const modified = rule.level !== server.level || rule.resolved !== server.resolved;
              return (
                <tr
                  key={family.id}
                  className={modified ? 'bg-wopr-accent/5' : 'hover:bg-white/[0.02]'}
                >
                  <td className="px-3 py-2">
                    <div className="text-wopr-text">{family.label}</div>
                    <div className="text-[10px] text-wopr-textSubtle font-mono">
                      {family.patterns.map((p) => (p.endsWith('-') ? `${p}*` : p)).join('  ')}
                    </div>
                  </td>
                  <td className="px-3 py-2">
                    <select
                      value={rule.level}
                      disabled={disabled}
                      onChange={(e) =>
                        onChange(family.id, { ...rule, level: e.target.value as FamilyLevel })}
                      className={SELECT_CLASS}
                    >
                      {levels.map((level) => (
                        <option key={level} value={level}>{levelLabels[level]}</option>
                      ))}
                    </select>
                  </td>
                  <td className="px-3 py-2">
                    <Toggle
                      checked={rule.resolved}
                      disabled={disabled || rule.level === 'never'}
                      onChange={(resolved) => onChange(family.id, { ...rule, resolved })}
                      label={`Notifier la résolution — ${family.label}`}
                    />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
};

// ------------------------------------------------------------------- journal

const KIND_LABEL: Record<string, string> = {
  alert: 'alerte',
  resolved: 'résolution',
  event: 'événement',
  digest: 'synthèse',
  test: 'test',
};

export const NotificationJournal: React.FC = () => {
  const [items, setItems] = useState<NotificationJournalItem[] | null>(null);
  const [counts, setCounts] = useState({ sent: 0, suppressed: 0 });
  const [busy, setBusy] = useState(false);
  const [days, setDays] = useState(7);

  const load = async (windowDays: number) => {
    setBusy(true);
    try {
      const res = await api.notificationJournal(windowDays);
      setItems(res.items);
      setCounts({ sent: res.sent, suppressed: res.suppressed });
    } catch (error) {
      store.addToast({
        type: 'err',
        title: 'Journal des notifications',
        message: error instanceof ApiError ? error.message : String(error),
      });
      setItems([]);
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => { void load(days); }, [days]);

  return (
    <SettingsCard
      title="Journal des notifications"
      description="Ce qui est parti, ce qui a été retenu — et pour quelle raison. Sans cette
                   trace, on ne pourrait pas distinguer « rien ne s'est passé » de « le
                   message a été supprimé par une règle »."
      action={
        <div className="flex items-center gap-2 shrink-0">
          <select
            value={days}
            onChange={(e) => setDays(Number(e.target.value))}
            className={`${SELECT_CLASS} w-auto`}
          >
            <option value={1}>24 heures</option>
            <option value={7}>7 jours</option>
            <option value={30}>30 jours</option>
          </select>
          <button
            type="button"
            onClick={() => void load(days)}
            disabled={busy}
            className={BUTTON_GHOST}
            title="Rafraîchir"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${busy ? 'animate-spin' : ''}`} />
          </button>
        </div>
      }
    >
      <div className="pt-3 space-y-3">
        <div className="flex items-center gap-4 text-[11px]">
          <span className="text-wopr-ok">{counts.sent} envoyée(s)</span>
          <span className="text-wopr-textMuted">{counts.suppressed} supprimée(s)</span>
        </div>

        {items === null ? (
          <p className="text-[11px] text-wopr-textMuted">Chargement…</p>
        ) : items.length === 0 ? (
          <p className="text-[11px] text-wopr-textMuted">
            Aucune notification sur la période. Si vous en attendiez, vérifiez
            l'interrupteur général et le tableau des familles ci-dessus.
          </p>
        ) : (
          <div className="rounded-lg border border-wopr-border overflow-hidden max-h-80 overflow-y-auto">
            <table className="w-full text-[11px]">
              <tbody className="divide-y divide-wopr-border/40">
                {items.map((item) => (
                  <tr key={item.id} className="hover:bg-white/[0.02] align-top">
                    <td className="px-3 py-1.5 w-6">
                      {item.sent
                        ? <CheckCircle2 className="w-3.5 h-3.5 text-wopr-ok" />
                        : <XCircle className="w-3.5 h-3.5 text-wopr-textSubtle" />}
                    </td>
                    <td className="px-2 py-1.5 w-36 font-mono tabular text-wopr-textSubtle">
                      {item.at.replace('T', ' ').replace('Z', '')}
                    </td>
                    <td className="px-2 py-1.5 w-20 text-wopr-textMuted">
                      {KIND_LABEL[item.kind] ?? item.kind}
                    </td>
                    <td className="px-2 py-1.5 text-wopr-text">{item.title}</td>
                    <td className="px-3 py-1.5 w-64 text-wopr-textMuted">
                      {item.sent ? '—' : item.reason}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </SettingsCard>
  );
};
