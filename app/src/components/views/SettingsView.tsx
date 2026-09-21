/**
 * Onglet Paramètres.
 *
 * Mise en page : rail de sections à gauche, sections empilées à droite, recherche
 * globale en haut, barre d'enregistrement en bas qui n'apparaît qu'en cas de
 * modification. Rien n'est envoyé à la frappe : on travaille sur un brouillon
 * local, et l'enregistrement montre d'abord ce qui va changer.
 *
 * Les champs eux-mêmes ne sont pas écrits ici : ils viennent du registre servi
 * par `/api/settings`. Ajouter un réglage côté Python le fait apparaître dans la
 * bonne section, avec son libellé, ses bornes et son badge de portée.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Activity, Bell, Fan, Gauge, Globe, Loader2, Lock, Monitor, RotateCcw, Save,
  Search, Settings as SettingsIcon, Sliders, Thermometer, Wrench, X,
} from 'lucide-react';

import { api, ApiError } from '../../state/api';
import { store } from '../../state/store';
import type { StatusData } from '../../state/types';
import type {
  FamilyRule, SettingDescriptor, SettingsData, UiPrefs,
} from '../../state/settingsTypes';
import { SettingField, formatValue } from '../settings/SettingField';
import {
  FamilyRulesTable, NotificationJournal, TelegramTestButton,
} from '../settings/NotificationRules';
import { ThresholdsEditor } from '../settings/ThresholdsEditor';
import { ModesEditor } from '../settings/ModesEditor';
import {
  AdvancedSection, InterfaceSection, PasswordCard, PendingRestartCard,
  loadPrefs, savePrefs,
} from '../settings/MiscSections';
import { BUTTON_GHOST, BUTTON_PRIMARY, SettingsCard } from '../common/FormControls';
import { DiffDialog, DiffEntry } from '../common/DiffDialog';
import type { ViewId } from '../layout/Sidebar';

const SECTION_ICONS: Record<string, React.FC<{ className?: string }>> = {
  sliders: Sliders, lock: Lock, bell: Bell, thermometer: Thermometer,
  gauge: Gauge, fan: Fan, activity: Activity, globe: Globe,
  monitor: Monitor, wrench: Wrench,
};

const VIEWS: { id: ViewId; label: string }[] = [
  { id: 'overview', label: "Vue d'ensemble" },
  { id: 'cpu-ram', label: 'CPU / RAM / CM' },
  { id: 'gpu', label: 'GPU & LLM' },
  { id: 'thermal', label: 'Thermique & Fans' },
  { id: 'storage-network', label: 'Stockage & Réseau' },
  { id: 'modes', label: 'Modes / Profils' },
  { id: 'docker', label: 'Docker & Stacks' },
  { id: 'processes', label: 'Processus système' },
  { id: 'system', label: 'Système & Actions' },
  { id: 'audit', label: 'Journal / Audit' },
];

/** Les sections qui n'ont pas de champ issu du registre, ou seulement des extras. */
const CUSTOM_SECTIONS = new Set(['thresholds', 'modes', 'interface', 'advanced']);

export const SettingsView: React.FC = () => {
  const [data, setData] = useState<SettingsData | null>(null);
  // Le store ne conserve pas /api/status en entier ; le rail en a besoin pour
  // dire d'un coup d'œil ce qui répond sur la machine.
  const [status, setStatus] = useState<StatusData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState<Record<string, unknown>>({});
  const [families, setFamilies] = useState<Record<string, FamilyRule>>({});
  const [search, setSearch] = useState('');
  const [active, setActive] = useState('general');
  const [saving, setSaving] = useState(false);
  const [showDiff, setShowDiff] = useState(false);
  const [prefs, setPrefs] = useState<UiPrefs>(() => loadPrefs());

  const sectionRefs = useRef<Record<string, HTMLElement | null>>({});
  const scrollRef = useRef<HTMLDivElement | null>(null);

  // --------------------------------------------------------------- chargement

  const load = useCallback(async () => {
    try {
      const res = await api.settings();
      setData(res);
      setFamilies(res.families.rules);
      setDraft({});
      setError(null);
      // Le bandeau global lit cette liste depuis le store.
      store.setPendingRestart(res.pendingRestart);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  useEffect(() => {
    api.status().then(setStatus).catch(() => setStatus(null));
  }, []);

  const updatePrefs = (next: UiPrefs) => { setPrefs(next); savePrefs(next); };

  // ------------------------------------------------------------- modifications

  const valueOf = (setting: SettingDescriptor): unknown =>
    Object.prototype.hasOwnProperty.call(draft, setting.key)
      ? draft[setting.key]
      : setting.value;

  const setValue = (key: string, value: unknown) =>
    setDraft((d) => ({ ...d, [key]: value }));

  const isModified = (setting: SettingDescriptor): boolean => {
    if (!Object.prototype.hasOwnProperty.call(draft, setting.key)) return false;
    // Un champ secret vide veut dire « inchangé » : ce n'est pas une modification.
    if (setting.secret) return String(draft[setting.key] ?? '') !== '';
    return JSON.stringify(draft[setting.key]) !== JSON.stringify(setting.value);
  };

  const familiesChanged = useMemo(() => {
    if (!data) return false;
    return Object.entries(families).some(([id, rule]) => {
      const server = data.families.rules[id];
      return !server || server.level !== rule.level || server.resolved !== rule.resolved;
    });
  }, [data, families]);

  const changedSettings = useMemo(
    () => (data ? data.settings.filter(isModified) : []),
    [data, draft],
  );

  const dirty = changedSettings.length > 0 || familiesChanged;

  const diffEntries: DiffEntry[] = useMemo(() => {
    const entries: DiffEntry[] = changedSettings.map((setting) => ({
      key: setting.key,
      label: setting.label,
      before: setting.secret ? '••••' : formatValue(setting, setting.value),
      after: setting.secret ? '•••• (nouvelle valeur)'
        : formatValue(setting, draft[setting.key]),
      scope: setting.scope,
    }));
    if (data && familiesChanged) {
      // Les règles par famille ne sont pas des réglages du registre : sans cette
      // ligne, le diff passerait sous silence une partie de ce qu'on enregistre.
      const changed = Object.entries(families).filter(([id, rule]) => {
        const server = data.families.rules[id];
        return !server || server.level !== rule.level || server.resolved !== rule.resolved;
      });
      entries.push({
        key: 'notifications.families',
        label: 'Règles par famille d\'alerte',
        before: `${changed.length} famille(s)`,
        after: changed
          .map(([id, rule]) =>
            `${data.families.meta.find((f) => f.id === id)?.label ?? id} → `
            + `${data.families.levelLabels[rule.level]}`)
          .join(', '),
        scope: 'live',
      });
    }
    return entries;
  }, [changedSettings, draft, data, families, familiesChanged]);

  // ------------------------------------------------------------ enregistrement

  const save = async () => {
    if (!data) return;
    setSaving(true);
    try {
      const values: Record<string, unknown> = {};
      changedSettings.forEach((setting) => { values[setting.key] = draft[setting.key]; });
      const res = await api.saveSettings(
        values, familiesChanged ? families : undefined);
      setData(res);
      setFamilies(res.families.rules);
      setDraft({});
      setShowDiff(false);
      store.setPendingRestart(res.pendingRestart);

      const cold = res.changed?.cold ?? [];
      store.addToast({
        type: cold.length ? 'warn' : 'success',
        title: 'Paramètres enregistrés',
        message: cold.length
          ? `${cold.length} réglage(s) attendent une recréation du conteneur.`
          : 'Appliqués immédiatement.',
      });
      // Des réglages comme l'identité du propriétaire changent ce que les autres
      // vues affichent : on rafraîchit ce qui en dépend.
      await store.checkSession().catch(() => undefined);
    } catch (err) {
      store.addToast({
        type: 'err',
        title: 'Enregistrement — échec',
        message: err instanceof ApiError ? err.message : String(err),
      });
      setShowDiff(false);
    } finally {
      setSaving(false);
    }
  };

  // Ctrl+S enregistre, comme partout ailleurs.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key === 's') {
        event.preventDefault();
        if (dirty && !saving) setShowDiff(true);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [dirty, saving]);

  // Garde-fou : ne pas quitter la page avec des modifications non enregistrées.
  useEffect(() => {
    if (!dirty) return;
    const onLeave = (event: BeforeUnloadEvent) => { event.preventDefault(); };
    window.addEventListener('beforeunload', onLeave);
    return () => window.removeEventListener('beforeunload', onLeave);
  }, [dirty]);

  // Le rail suit la section visible.
  useEffect(() => {
    if (!data) return;
    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((e) => e.isIntersecting)
          .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0];
        if (visible?.target.id) setActive(visible.target.id.replace('section-', ''));
      },
      { rootMargin: '-80px 0px -70% 0px', threshold: 0 },
    );
    Object.values(sectionRefs.current).forEach((el) => el && observer.observe(el));
    return () => observer.disconnect();
  }, [data, search]);

  // ------------------------------------------------------------------ rendu

  if (error) {
    return (
      <div className="space-y-6 animate-in fade-in duration-200">
        <Header />
        <div className="bg-wopr-err/10 border border-wopr-err/30 rounded-xl p-4 text-xs
                        text-wopr-err" role="alert">
          Paramètres indisponibles : {error}
        </div>
      </div>
    );
  }

  if (!data) {
    return (
      <div className="space-y-6 animate-in fade-in duration-200">
        <Header />
        <div className="flex items-center gap-2 text-xs text-wopr-textMuted">
          <Loader2 className="w-4 h-4 animate-spin text-wopr-accent" /> Chargement des réglages…
        </div>
      </div>
    );
  }

  const needle = search.trim().toLowerCase();
  const matches = (setting: SettingDescriptor) =>
    !needle
    || setting.label.toLowerCase().includes(needle)
    || setting.help.toLowerCase().includes(needle)
    || setting.key.toLowerCase().includes(needle)
    || (setting.env ?? '').toLowerCase().includes(needle);

  const fieldsOf = (section: string) =>
    data.settings.filter(
      (s) => s.section === section && matches(s) && (prefs.showAdvanced || !s.advanced || needle));

  const sectionVisible = (section: string) => {
    if (!needle) return true;
    if (fieldsOf(section).length > 0) return true;
    const meta = data.sections.find((s) => s.id === section);
    return Boolean(meta && (meta.label.toLowerCase().includes(needle)
      || meta.help.toLowerCase().includes(needle)));
  };

  const goTo = (section: string) => {
    sectionRefs.current[section]?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    setActive(section);
  };

  const minLevelSetting = data.settings.find((s) => s.key === 'notifications.minLevel');
  const minLevelLabel = minLevelSetting
    ? formatValue(minLevelSetting, valueOf(minLevelSetting)) : '';

  return (
    <div className="space-y-6 animate-in fade-in duration-200 pb-24" ref={scrollRef}>
      <Header />

      <PendingRestartCard data={data} />

      {(!data.writable.config || !data.writable.dotenv) && (
        <div className="rounded-xl border border-wopr-err/30 bg-wopr-err/10 p-4 text-xs
                        text-wopr-err space-y-1" role="alert">
          <p className="font-semibold">Configuration en lecture seule</p>
          {!data.writable.config && (
            <p>
              Le dossier <code className="font-mono">{data.paths.settings}</code> n'est pas
              inscriptible : vérifiez que la ligne <code className="font-mono">./config:/config</code>
              {' '}du docker-compose.yml ne porte plus <code className="font-mono">:ro</code>.
            </p>
          )}
          {!data.writable.dotenv && (
            <p>
              Le fichier <code className="font-mono">{data.paths.dotenv}</code> n'est pas
              monté : ajoutez <code className="font-mono">- ./.env:/host-env</code> aux volumes,
              sans quoi les réglages « à froid » ne peuvent pas être enregistrés.
            </p>
          )}
        </div>
      )}

      <div className="flex gap-6 items-start">
        {/* ------------------------------------------------------------- rail */}
        <nav className="hidden lg:block w-52 shrink-0 sticky top-2 self-start space-y-1">
          {data.sections.filter((s) => sectionVisible(s.id)).map((section) => {
            const Icon = SECTION_ICONS[section.icon] ?? SettingsIcon;
            const count = fieldsOf(section.id).length;
            const modifiedHere = changedSettings.some((s) => s.section === section.id)
              || (section.id === 'notifications' && familiesChanged);
            return (
              <button
                key={section.id}
                type="button"
                onClick={() => goTo(section.id)}
                className={`w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-xs
                            font-medium transition-colors text-left ${
                  active === section.id
                    ? 'bg-wopr-accent/15 text-wopr-accent border border-wopr-accent/30'
                    : 'text-wopr-textMuted hover:text-wopr-text hover:bg-white/5 border border-transparent'
                }`}
              >
                <Icon className="w-3.5 h-3.5 shrink-0" />
                <span className="flex-1 truncate">{section.label}</span>
                {modifiedHere && (
                  <span className="w-1.5 h-1.5 rounded-full bg-wopr-accent shrink-0"
                        title="Modifications non enregistrées" />
                )}
                {needle && count > 0 && (
                  <span className="text-[10px] text-wopr-textSubtle">{count}</span>
                )}
              </button>
            );
          })}

          <div className="pt-3 mt-3 border-t border-wopr-border space-y-1.5">
            <p className="text-[10px] uppercase tracking-wider text-wopr-textSubtle px-3">
              État
            </p>
            <RailStatus label="Base d'historique" ok={Boolean(status?.historyDb)} />
            <RailStatus label="Telegram" ok={data.telegram.configured}
                        okLabel="configuré" koLabel="non configuré" />
            <RailStatus label="Accès à l'hôte" ok={Boolean(status?.hostControl)} />
            <RailStatus label="Écriture config" ok={data.writable.config} />
          </div>
        </nav>

        {/* --------------------------------------------------------- sections */}
        <div className="flex-1 min-w-0 space-y-8">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5
                               text-wopr-textSubtle" />
            <input
              type="search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Rechercher un réglage (libellé, aide, clé, variable d'environnement)…"
              className="w-full bg-[#0d1117] border border-wopr-border rounded-lg pl-9 pr-9 py-2
                         text-xs text-wopr-text placeholder:text-wopr-textSubtle
                         focus:outline-none focus:border-wopr-accent focus:ring-1
                         focus:ring-wopr-accent transition-colors"
            />
            {search && (
              <button
                type="button"
                onClick={() => setSearch('')}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-wopr-textMuted
                           hover:text-wopr-text"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            )}
          </div>

          {data.sections.filter((s) => sectionVisible(s.id)).map((section) => {
            const fields = fieldsOf(section.id);
            if (needle && fields.length === 0 && CUSTOM_SECTIONS.has(section.id)
                && !section.label.toLowerCase().includes(needle)) {
              return null;
            }
            const Icon = SECTION_ICONS[section.icon] ?? SettingsIcon;
            return (
              <section
                key={section.id}
                id={`section-${section.id}`}
                ref={(el) => { sectionRefs.current[section.id] = el; }}
                className="scroll-mt-4 space-y-4"
              >
                <div>
                  <h2 className="text-sm font-bold text-wopr-text flex items-center gap-2">
                    <Icon className="w-4 h-4 text-wopr-accent" />
                    {section.label}
                  </h2>
                  <p className="text-[11px] text-wopr-textMuted mt-0.5">{section.help}</p>
                </div>

                {fields.length > 0 && (
                  <SettingsCard>
                    {fields.map((setting) => (
                      <SettingField
                        key={setting.key}
                        setting={setting}
                        value={valueOf(setting)}
                        modified={isModified(setting)}
                        onChange={(value) => setValue(setting.key, value)}
                        onRevert={() => setValue(setting.key, setting.default)}
                      />
                    ))}
                  </SettingsCard>
                )}

                {/* ------------------------------------------ extras par section */}
                {section.id === 'security' && !needle && (
                  <PasswordCard username={data.account.username} />
                )}

                {section.id === 'notifications' && !needle && (
                  <>
                    <SettingsCard
                      title="Vérification"
                      description="Le test utilise les valeurs saisies ci-dessus, avant
                                   enregistrement : on vérifie un jeton avant de le garder."
                    >
                      <div className="pt-3">
                        <TelegramTestButton
                          botToken={String(draft['notifications.botToken'] ?? '')}
                          chatId={String(draft['notifications.chatId'] ?? '')}
                        />
                      </div>
                    </SettingsCard>

                    <SettingsCard
                      title="Règles par famille d'alerte"
                      description="Les familles correspondent aux préfixes d'identifiant
                                   produits par le moteur d'alertes."
                    >
                      <div className="pt-3">
                        <FamilyRulesTable
                          meta={data.families.meta}
                          levels={data.families.levels}
                          levelLabels={data.families.levelLabels}
                          rules={families}
                          serverRules={data.families.rules}
                          minLevelLabel={minLevelLabel}
                          onChange={(family, rule) =>
                            setFamilies((f) => ({ ...f, [family]: rule }))}
                        />
                      </div>
                    </SettingsCard>

                    <NotificationJournal />
                  </>
                )}

                {section.id === 'thresholds' && !needle && <ThresholdsEditor />}
                {section.id === 'modes' && !needle && <ModesEditor />}
                {section.id === 'interface' && !needle && (
                  <InterfaceSection prefs={prefs} onChange={updatePrefs} views={VIEWS} />
                )}
                {section.id === 'advanced' && !needle && (
                  <AdvancedSection data={data} onReload={() => void load()} />
                )}

                {needle && fields.length === 0 && (
                  <p className="text-[11px] text-wopr-textMuted">
                    Aucun réglage de cette section ne correspond. Effacez la recherche pour
                    retrouver les éditeurs de cette section.
                  </p>
                )}
              </section>
            );
          })}

          {needle && !data.sections.some((s) => sectionVisible(s.id)) && (
            <p className="text-xs text-wopr-textMuted">
              Aucun réglage ne correspond à «&nbsp;{search}&nbsp;».
            </p>
          )}
        </div>
      </div>

      {/* ------------------------------------------------- barre d'enregistrement */}
      {dirty && (
        <div className="fixed bottom-0 left-0 right-0 z-40 bg-[#161b22]/95 backdrop-blur
                        border-t border-wopr-accent/40 px-4 py-3 animate-in fade-in duration-150">
          <div className="max-w-7xl mx-auto flex items-center justify-between gap-4 flex-wrap">
            <p className="text-xs text-wopr-text">
              <span className="font-semibold text-wopr-accent">
                {changedSettings.length + (familiesChanged ? 1 : 0)}
              </span>{' '}
              modification{changedSettings.length + (familiesChanged ? 1 : 0) > 1 ? 's' : ''} non
              enregistrée{changedSettings.length + (familiesChanged ? 1 : 0) > 1 ? 's' : ''}
            </p>
            <div className="flex items-center gap-3">
              <button
                type="button"
                onClick={() => { setDraft({}); setFamilies(data.families.rules); }}
                className={BUTTON_GHOST}
              >
                <span className="flex items-center gap-1.5">
                  <RotateCcw className="w-3.5 h-3.5" /> Annuler
                </span>
              </button>
              <button type="button" onClick={() => setShowDiff(true)} className={BUTTON_GHOST}>
                Voir le détail
              </button>
              <button
                type="button"
                onClick={() => setShowDiff(true)}
                disabled={saving}
                className={BUTTON_PRIMARY}
              >
                <span className="flex items-center gap-1.5">
                  {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
                          : <Save className="w-3.5 h-3.5" />}
                  Enregistrer
                </span>
              </button>
            </div>
          </div>
        </div>
      )}

      <DiffDialog
        isOpen={showDiff}
        entries={diffEntries}
        busy={saving}
        onConfirm={() => void save()}
        onCancel={() => setShowDiff(false)}
      />
    </div>
  );
};

const Header: React.FC = () => (
  <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pb-4
                  border-b border-wopr-border">
    <div>
      <h1 className="text-xl font-bold tracking-tight text-wopr-text flex items-center gap-2.5">
        <SettingsIcon className="w-5 h-5 text-wopr-accent" />
        <span>Paramètres</span>
      </h1>
      <p className="text-xs text-wopr-textMuted mt-1">
        Tous les réglages du dashboard. Ce qui peut s'appliquer sans redémarrage le fait ;
        le reste est écrit dans le .env et signalé.
      </p>
    </div>
  </div>
);

const RailStatus: React.FC<{
  label: string; ok: boolean; okLabel?: string; koLabel?: string;
}> = ({ label, ok, okLabel = 'disponible', koLabel = 'indisponible' }) => (
  <div className="flex items-center gap-2 px-3 py-1">
    <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${ok ? 'bg-wopr-ok' : 'bg-wopr-inactive'}`} />
    <span className="text-[10px] text-wopr-textMuted flex-1 truncate">{label}</span>
    <span className={`text-[10px] ${ok ? 'text-wopr-ok' : 'text-wopr-textSubtle'}`}>
      {ok ? okLabel : koLabel}
    </span>
  </div>
);
