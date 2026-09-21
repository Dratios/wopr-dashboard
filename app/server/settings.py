"""Réglages du dashboard : un registre déclaratif, trois couches de résolution.

Le registre `SETTINGS` ci-dessous est la seule description d'un réglage dans tout
le projet. L'API le sert tel quel, l'interface se dessine à partir de lui, la
validation s'appuie sur lui. Ajouter un réglage, c'est ajouter une ligne ici.

Résolution, du plus fort au plus faible :

    config/settings.yaml   →   variable d'environnement   →   défaut du code

Le `.env` reste donc valide : il devient la valeur d'amorçage, pas la vérité.

Deux portées :

* `live` — modifiable et appliqué sans redémarrage. Écrit dans `settings.yaml`,
  puis les modules concernés sont prévenus par un crochet (`register_hook`).
* `cold` — lu une fois à la création du conteneur (uvicorn choisit son adresse
  d'écoute avant que Python ne tourne, compose interpole le `.env` avant tout).
  Écrit dans le `.env`, avec un bandeau « recréation requise » côté interface.
  `pending_restart()` compare simplement le fichier au `os.environ` du processus :
  la différence *est* la liste des réglages en attente, aucun état à tenir.
"""

from __future__ import annotations

import logging
import os
import threading
from dataclasses import dataclass, field
from typing import Any, Callable, Dict, List, Optional

import yaml

from . import confwrite, owners

log = logging.getLogger("wopr.settings")

CONFIG_DIR = os.environ.get("WOPR_CONFIG_DIR", "/config")
SETTINGS_PATH = os.path.join(CONFIG_DIR, "settings.yaml")
# Le `.env` de la stack, monté en écriture (voir docker-compose.yml). Absent en
# développement hors conteneur : les réglages « à froid » passent alors en
# lecture seule plutôt que de faire échouer le démarrage.
DOTENV_PATH = os.environ.get("WOPR_DOTENV_PATH", "/host-env")


@dataclass(frozen=True)
class Setting:
    key: str
    section: str
    label: str
    help: str
    kind: str                       # bool | int | float | str | secret | enum | url | time
    default: Any
    env: Optional[str] = None
    scope: str = "live"             # live | cold
    unit: Optional[str] = None
    min: Any = None
    max: Any = None
    choices: Optional[List[Any]] = None
    choiceLabels: Optional[Dict[str, str]] = None
    secret: bool = False
    readonly: bool = False
    advanced: bool = False
    # Liste de choix qui ne peut pas être écrite ici parce qu'elle dépend d'un
    # fichier de configuration relu à chaud. Seule valeur admise : "owners".
    dynamicChoices: Optional[str] = None


def choices_of(setting: "Setting") -> Optional[List[Any]]:
    """Choix effectifs d'un réglage `enum`, listes dynamiques comprises."""
    if setting.dynamicChoices == "owners":
        return owners.ids()
    return setting.choices


def choice_labels_of(setting: "Setting") -> Optional[Dict[str, str]]:
    if setting.dynamicChoices == "owners":
        return owners.labels()
    return setting.choiceLabels


_LOG_LEVELS = ["DEBUG", "INFO", "WARNING", "ERROR"]
_ALERT_LEVELS = ["err", "warn", "info"]

SETTINGS: List[Setting] = [
    # ---------------------------------------------------------------- général
    Setting("general.ownerIdentity", "general", "Identité du propriétaire",
            "Quels conteneurs sont « les vôtres ». Les actions sur ceux de l'autre "
            "administrateur demandent une confirmation renforcée. La liste vient "
            "de `config/owners.yaml`.",
            "enum", "shared", env="WOPR_OWNER_IDENTITY", dynamicChoices="owners"),
    Setting("general.logLevel", "general", "Niveau de journal",
            "Verbosité des journaux du conteneur. DEBUG trace chaque appel — utile "
            "pour un dépannage, bruyant en fonctionnement normal.",
            "enum", "INFO", env="WOPR_LOG_LEVEL", choices=_LOG_LEVELS),
    Setting("general.ollamaUrl", "general", "Adresse d'Ollama",
            "Utilisée par la vue GPU pour lister, charger et décharger les modèles. "
            "Le conteneur étant en réseau hôte, la boucle locale convient.",
            "url", "http://127.0.0.1:11434", env="WOPR_OLLAMA_URL"),
    Setting("general.ollamaTimeoutS", "general", "Délai d'attente d'Ollama",
            "Au-delà, la vue des modèles affiche une indisponibilité plutôt que de "
            "retarder tout le reste de la page.",
            "float", 2.0, unit="s", min=0.5, max=30.0, advanced=True),
    Setting("general.pingTarget", "general", "Cible du test d'accès Internet",
            "Adresse pingée pour l'indicateur « Internet joignable » de la vue réseau.",
            "str", "1.1.1.1", env="WOPR_PING_TARGET"),

    # ------------------------------------------------------- compte & sécurité
    Setting("security.sessionMaxAgeH", "security", "Durée d'une session",
            "Au-delà, le cookie de session expire et il faut se reconnecter.",
            "int", 12, unit="h", min=1, max=720),
    Setting("security.loginMaxAttempts", "security", "Tentatives avant blocage",
            "Nombre d'échecs de connexion tolérés par compte avant refus temporaire.",
            "int", 5, min=1, max=100),
    Setting("security.loginWindowS", "security", "Fenêtre de blocage",
            "Durée pendant laquelle les échecs sont comptés, et durée du refus.",
            "int", 300, unit="s", min=30, max=86400),
    Setting("security.cookieSecure", "security", "Cookie en HTTPS seulement",
            "À activer le jour où un reverse proxy TLS est placé devant le dashboard. "
            "Activé sans TLS, plus personne ne peut se connecter.",
            "bool", False, env="WOPR_COOKIE_SECURE", scope="cold"),
    Setting("security.sessionSecret", "security", "Secret de signature des sessions",
            "Signe les cookies. Le changer ferme immédiatement toutes les sessions "
            "ouvertes. 48 caractères minimum.",
            "secret", "", env="WOPR_SESSION_SECRET", scope="cold", secret=True,
            advanced=True),

    # --------------------------------------------------------- notifications
    Setting("notifications.enabled", "notifications", "Notifications Telegram",
            "Interrupteur général. Éteint, plus aucun message n'est envoyé, quelles "
            "que soient les règles ci-dessous.",
            "bool", True),
    Setting("notifications.botToken", "notifications", "Jeton du bot",
            "Fourni par @BotFather à la création du bot.",
            "secret", "", env="WOPR_TELEGRAM_BOT_TOKEN", secret=True),
    # Pas marqué secret : ce n'est pas une information d'authentification, et ne
    # pas pouvoir le relire empêcherait de diagnostiquer « pourquoi je ne reçois
    # rien ». Le jeton, lui, reste masqué.
    Setting("notifications.chatId", "notifications", "Identifiant de conversation",
            "Obtenu en écrivant au bot puis en interrogeant getUpdates, ou en parlant "
            "à @userinfobot.",
            "str", "", env="WOPR_TELEGRAM_CHAT_ID"),
    Setting("notifications.minLevel", "notifications", "Niveau minimal",
            "Seuil appliqué aux familles réglées sur « hérité ».",
            "enum", "warn", env="WOPR_TELEGRAM_MIN_LEVEL", choices=_ALERT_LEVELS,
            choiceLabels={"err": "critiques seulement", "warn": "avertissements et plus",
                          "info": "tout, informations comprises"}),
    Setting("notifications.notifyResolved", "notifications", "Notifier les résolutions",
            "Envoyer aussi un message quand une alerte disparaît. Réglable famille par "
            "famille dans le tableau ci-dessous.",
            "bool", True),
    Setting("notifications.confirmDelayS", "notifications", "Délai de confirmation",
            "N'envoyer qu'après ce temps de persistance. C'est ce qui empêche une "
            "pointe de charge de trois secondes de réveiller quelqu'un la nuit.",
            "int", 60, unit="s", min=0, max=3600),
    Setting("notifications.groupWindowS", "notifications", "Fenêtre de groupement",
            "Attendre ce délai et réunir les alertes simultanées en un seul message, "
            "au lieu d'une rafale. 0 désactive le groupement.",
            "int", 20, unit="s", min=0, max=600),
    Setting("notifications.cooldownS", "notifications", "Anti-répétition",
            "Délai minimal avant de renotifier une même alerte qui clignote.",
            "int", 900, unit="s", env="WOPR_TELEGRAM_COOLDOWN_S", min=0, max=86400),
    Setting("notifications.repeatEveryH", "notifications", "Relance périodique",
            "Répéter une alerte toujours pas résolue à cet intervalle. 0 = jamais.",
            "float", 0.0, unit="h", min=0.0, max=168.0),
    Setting("notifications.maxPerHour", "notifications", "Débit maximal",
            "Plafond de messages par heure. Au-delà, un unique message de synthèse "
            "remplace les suivants. 0 = sans plafond.",
            "int", 20, min=0, max=500),
    Setting("notifications.quietHours.enabled", "notifications", "Heures calmes",
            "Plage pendant laquelle on n'envoie rien.",
            "bool", False),
    Setting("notifications.quietHours.start", "notifications", "Début des heures calmes",
            "", "time", "23:00"),
    Setting("notifications.quietHours.end", "notifications", "Fin des heures calmes",
            "", "time", "07:00"),
    Setting("notifications.quietHours.allowCritical", "notifications",
            "Laisser passer les critiques",
            "Une alerte critique traverse les heures calmes. Un disque plein à 3 h du "
            "matin reste un disque plein.",
            "bool", True),
    Setting("notifications.quietHours.flush", "notifications",
            "Envoyer le résumé à la fin",
            "Les alertes retenues pendant la plage sont regroupées et envoyées à sa "
            "fin, plutôt que perdues.",
            "bool", True),
    Setting("notifications.events.modeChange", "notifications",
            "Changement de mode machine", "", "bool", True),
    Setting("notifications.events.reboot", "notifications",
            "Redémarrage de la machine", "", "bool", True),
    Setting("notifications.events.otherOwnerDocker", "notifications",
            "Action sur un conteneur qui n'est pas le vôtre",
            "Sur une machine à deux administrateurs, c'est l'événement qu'on veut voir "
            "passer.", "bool", True),
    Setting("notifications.events.loginFailed", "notifications",
            "Blocage après échecs de connexion", "", "bool", True),
    Setting("notifications.events.dashboardStart", "notifications",
            "Démarrage du dashboard", "", "bool", False),

    # ------------------------------------------------------ collecte & historique
    Setting("collect.sampleIntervalS", "collect", "Cadence d'échantillonnage",
            "Période entre deux points de mesure, en mémoire comme en base. "
            "Descendre sous 5 s multiplie le volume d'historique sans rien apprendre.",
            "float", 5.0, unit="s", min=2.0, max=60.0),
    Setting("collect.memoryPoints", "collect", "Profondeur de l'historique mémoire",
            "Nombre de points gardés en mémoire vive, pour les graphes courts quand la "
            "base est indisponible.",
            "int", 120, min=30, max=1000, advanced=True),
    Setting("collect.historyRetentionH", "collect", "Conservation de l'historique",
            "Durée gardée en base PostgreSQL. La purge passe toutes les dix minutes.",
            "int", 24, unit="h", env="WOPR_HISTORY_RETENTION_H", min=1, max=8760),
    Setting("collect.speedtestMinIntervalS", "collect", "Délai entre deux tests de débit",
            "Empêche d'enchaîner les mesures, qui saturent la liaison pendant qu'elles "
            "tournent.",
            "float", 20.0, unit="s", env="WOPR_SPEEDTEST_MIN_INTERVAL_S",
            min=5.0, max=3600.0),

    # ------------------------------------------------------------- ventilation
    Setting("fans.controlIntervalS", "fans", "Cadence de la boucle de pilotage",
            "Période à laquelle la courbe de ventilation est réévaluée.",
            "float", 5.0, unit="s", min=1.0, max=60.0),
    Setting("fans.controlSensorChip", "fans", "Puce du capteur pilote",
            "Capteur dont la température pilote les courbes.",
            "str", "k10temp", advanced=True),
    Setting("fans.controlSensorLabel", "fans", "Sonde du capteur pilote",
            "", "str", "Tctl", advanced=True),

    # ------------------------------------------------------------------- modes
    Setting("modes.defaultId", "modes", "Mode de repli",
            "Mode appliqué au démarrage et au terme d'un retour automatique.",
            "str", "equilibre"),

    # ------------------------------------------------------------ réseau (froid)
    Setting("net.bindAddr", "network", "Adresse d'écoute",
            "L'IP de la machine sur le réseau local restreint l'accès au LAN. "
            "127.0.0.1 réserve le dashboard à la machine elle-même. Éviter "
            "0.0.0.0, qui expose le dashboard sur toutes les interfaces.",
            "str", "127.0.0.1", env="BIND_ADDR", scope="cold"),
    Setting("net.bindPort", "network", "Port d'écoute",
            "", "int", 8080, env="BIND_PORT", scope="cold", min=1, max=65535),
    Setting("db.port", "network", "Port de la base d'historique",
            "Publié sur la boucle locale uniquement. 5433 est déjà pris par le "
            "PostgreSQL existant de la machine.",
            "int", 5434, env="WOPR_DB_PORT", scope="cold", min=1, max=65535),
    Setting("db.password", "network", "Mot de passe de la base d'historique",
            "Fixé au premier démarrage de la base. Le changer ici demande aussi un "
            "ALTER USER dans PostgreSQL, sans quoi la connexion échouera.",
            "secret", "", env="WOPR_DB_PASSWORD", scope="cold", secret=True),
    Setting("db.host", "network", "Hôte de la base",
            "Figé dans le docker-compose.yml : le conteneur est en réseau hôte.",
            "str", "127.0.0.1", env="WOPR_DB_HOST", scope="cold", readonly=True),
    Setting("db.name", "network", "Base de données",
            "", "str", "wopr_history", env="WOPR_DB_NAME", scope="cold", readonly=True),
    Setting("db.user", "network", "Utilisateur de la base",
            "", "str", "wopr", env="WOPR_DB_USER", scope="cold", readonly=True),
]

BY_KEY: Dict[str, Setting] = {s.key: s for s in SETTINGS}

SECTIONS: List[Dict[str, str]] = [
    {"id": "general", "label": "Général", "icon": "sliders",
     "help": "Identité, journalisation et services joints par le dashboard."},
    {"id": "security", "label": "Compte & sécurité", "icon": "lock",
     "help": "Mot de passe administrateur, sessions et limitation des tentatives."},
    {"id": "notifications", "label": "Notifications", "icon": "bell",
     "help": "Quand, et à quelles conditions, le dashboard écrit sur Telegram."},
    {"id": "thresholds", "label": "Seuils d'alerte", "icon": "thermometer",
     "help": "À partir de quelle valeur une mesure devient un avertissement, puis une alerte."},
    {"id": "modes", "label": "Modes machine", "icon": "gauge",
     "help": "Définition des modes et des leviers qu'ils actionnent."},
    {"id": "fans", "label": "Ventilation", "icon": "fan",
     "help": "Boucle de pilotage et capteur qui commande les courbes."},
    {"id": "collect", "label": "Collecte & historique", "icon": "activity",
     "help": "Cadence des mesures et durée de conservation."},
    {"id": "network", "label": "Réseau & accès", "icon": "globe",
     "help": "Réglages lus à la création du conteneur : ils demandent une recréation."},
    {"id": "interface", "label": "Interface", "icon": "monitor",
     "help": "Préférences propres à ce navigateur, enregistrées localement."},
    {"id": "advanced", "label": "Avancé", "icon": "wrench",
     "help": "Export, import, réinitialisation et fichiers bruts."},
]


# ------------------------------------------------------- familles d'alerte

# Les identifiants d'alerte produits par `alerts.py` ont des préfixes stables :
# c'est ce qui permet de régler les notifications par famille plutôt qu'alerte
# par alerte. Un motif terminé par « - » est un préfixe, sinon c'est un
# identifiant exact.
FAMILIES: List[Dict[str, Any]] = [
    {"id": "temperature", "label": "Températures", "patterns": ["temp-"]},
    {"id": "ventilation", "label": "Ventilateurs", "patterns": ["fan-"]},
    {"id": "disque", "label": "Disques et montages", "patterns": ["disk-", "mount-"]},
    {"id": "charge", "label": "Charge processeur", "patterns": ["load"]},
    {"id": "memoire", "label": "Mémoire et swap", "patterns": ["ram", "swap"]},
    {"id": "vram", "label": "VRAM des GPU", "patterns": ["vram-"]},
    {"id": "gputemp", "label": "Température des GPU", "patterns": ["gputemp-"]},
    {"id": "conteneur", "label": "Conteneurs", "patterns": ["ctr-"]},
    {"id": "redemarrages", "label": "Redémarrages en boucle", "patterns": ["ctrrestart-"]},
    {"id": "docker", "label": "Démon Docker", "patterns": ["docker-down"]},
    {"id": "reseau", "label": "Interfaces réseau", "patterns": ["net-"]},
    {"id": "passerelle", "label": "Passerelle", "patterns": ["gateway"]},
    {"id": "reboot", "label": "Redémarrage requis", "patterns": ["reboot"]},
    {"id": "parefeu", "label": "Pare-feu absent", "patterns": ["firewall"]},
]

FAMILY_LEVELS = ["inherit", "never", "err", "warn", "info"]
FAMILY_LEVEL_LABELS = {
    "inherit": "hérité du niveau minimal",
    "never": "jamais",
    "err": "critiques seulement",
    "warn": "avertissements et plus",
    "info": "tout",
}


def family_of(alert_id: str) -> Optional[str]:
    """Famille d'une alerte, par correspondance du motif le plus long."""
    best: Optional[str] = None
    best_len = -1
    for fam in FAMILIES:
        for pattern in fam["patterns"]:
            matched = alert_id.startswith(pattern) if pattern.endswith("-") else alert_id == pattern
            if matched and len(pattern) > best_len:
                best, best_len = fam["id"], len(pattern)
    return best


# ------------------------------------------------------------------- résolution

_lock = threading.RLock()
_store: Dict[str, Any] = {}
_loaded = False
_hooks: Dict[str, List[Callable[[List[str]], None]]] = {}


def _dig(blob: Dict[str, Any], key: str) -> Any:
    node: Any = blob
    for part in key.split("."):
        if not isinstance(node, dict) or part not in node:
            return _MISSING
        node = node[part]
    return node


def _plant(blob: Dict[str, Any], key: str, value: Any) -> None:
    parts = key.split(".")
    node = blob
    for part in parts[:-1]:
        nxt = node.get(part)
        if not isinstance(nxt, dict):
            nxt = {}
            node[part] = nxt
        node = nxt
    node[parts[-1]] = value


class _Missing:
    def __repr__(self) -> str:  # pragma: no cover - confort de débogage
        return "<absent>"


_MISSING = _Missing()


def load(force: bool = False) -> Dict[str, Any]:
    global _loaded
    with _lock:
        if _loaded and not force:
            return _store
        blob: Dict[str, Any] = {}
        try:
            with open(SETTINGS_PATH, "r", encoding="utf-8") as f:
                blob = yaml.safe_load(f) or {}
            if not isinstance(blob, dict):
                log.warning("%s ne contient pas un dictionnaire, ignoré", SETTINGS_PATH)
                blob = {}
        except FileNotFoundError:
            log.info("%s absent : valeurs du .env et défauts du code", SETTINGS_PATH)
        except Exception:
            log.exception("%s illisible, valeurs du .env et défauts du code", SETTINGS_PATH)
        _store.clear()
        _store.update(blob)
        _loaded = True
        return _store


def coerce(setting: Setting, value: Any) -> Any:
    """Convertit une valeur brute (souvent une chaîne d'environnement) vers son type."""
    if value is None:
        return setting.default
    kind = setting.kind
    try:
        if kind == "bool":
            if isinstance(value, bool):
                return value
            return str(value).strip().lower() in ("1", "true", "oui", "yes", "on")
        if kind == "int":
            return int(str(value).strip())
        if kind == "float":
            return float(str(value).strip())
        if kind == "enum":
            text = str(value).strip()
            allowed = choices_of(setting)
            return text if allowed and text in allowed else setting.default
        return str(value)
    except (TypeError, ValueError):
        log.warning("valeur invalide pour %s (%r), défaut appliqué", setting.key, value)
        return setting.default


def get(key: str) -> Any:
    """Valeur effective d'un réglage : settings.yaml, puis environnement, puis défaut."""
    setting = BY_KEY.get(key)
    if setting is None:
        raise KeyError(f"réglage inconnu : {key}")
    if setting.scope == "live":
        stored = _dig(load(), key)
        if not isinstance(stored, _Missing):
            return coerce(setting, stored)
    if setting.env:
        raw = os.environ.get(setting.env)
        if raw is not None and raw != "":
            return coerce(setting, raw)
    return setting.default


def is_overridden(key: str) -> bool:
    """Le réglage a-t-il une valeur enregistrée dans `settings.yaml` ?

    Sert à dire à l'interface d'où vient la valeur affichée : fichier de
    réglages, variable d'environnement, ou défaut du code.
    """
    return not isinstance(_dig(load(), key), _Missing)


def get_raw(key: str, default: Any = None) -> Any:
    """Valeur libre de `settings.yaml`, hors registre (tables, listes, comptes)."""
    value = _dig(load(), key)
    return default if isinstance(value, _Missing) else value


def set_raw(key: str, value: Any, *, by: str = "système") -> None:
    """Écrit une valeur hors registre et enregistre le fichier."""
    with _lock:
        load()
        _plant(_store, key, value)
        _persist()
    _fire([key])


def families() -> Dict[str, Dict[str, Any]]:
    """Règles par famille, complétées par les défauts pour les familles absentes."""
    stored = get_raw("notifications.families", {}) or {}
    out: Dict[str, Dict[str, Any]] = {}
    for fam in FAMILIES:
        entry = stored.get(fam["id"]) if isinstance(stored, dict) else None
        entry = entry if isinstance(entry, dict) else {}
        level = entry.get("level", "inherit")
        out[fam["id"]] = {
            "level": level if level in FAMILY_LEVELS else "inherit",
            "resolved": bool(entry.get("resolved", True)),
        }
    return out


# --------------------------------------------------------------------- crochets


def register_hook(section: str, fn: Callable[[List[str]], None]) -> None:
    """Appelé après enregistrement avec la liste des clés modifiées de la section.

    `section` est un préfixe de clé (« notifications », « fans.controlIntervalS »…)
    ou « * » pour être prévenu de tout.
    """
    with _lock:
        _hooks.setdefault(section, []).append(fn)


def _fire(changed: List[str]) -> None:
    for prefix, callbacks in list(_hooks.items()):
        touched = changed if prefix == "*" else [k for k in changed if k == prefix or k.startswith(prefix + ".")]
        if not touched:
            continue
        for fn in callbacks:
            try:
                fn(touched)
            except Exception:
                log.exception("crochet d'application à chaud en échec (%s)", prefix)


# -------------------------------------------------------------------- écriture

_HEADER = """\
# Réglages du dashboard wopr — écrits depuis l'onglet Paramètres.
#
# Ce fichier prime sur les variables du .env, qui restent la valeur d'amorçage.
# Il est modifiable à la main ; un enregistrement depuis l'interface le réécrit
# en conservant son propriétaire et ses droits, après une sauvegarde .bak.
#
# Supprimer une clé la fait retomber sur le .env, puis sur le défaut du code.
# Supprimer le fichier entier ramène le dashboard à sa configuration d'origine.
"""


def _persist() -> None:
    body = yaml.safe_dump(_store, allow_unicode=True, sort_keys=True, default_flow_style=False)
    confwrite.backup(SETTINGS_PATH)
    # 0600 : le fichier contient le jeton Telegram et l'empreinte du mot de passe.
    confwrite.atomic_write(SETTINGS_PATH, _HEADER + "\n" + body, mode=0o600)


class ValidationError(Exception):
    def __init__(self, key: str, message: str) -> None:
        super().__init__(message)
        self.key = key
        self.message = message


def validate(setting: Setting, value: Any) -> Any:
    if setting.readonly:
        raise ValidationError(setting.key, "Ce réglage est en lecture seule.")
    if setting.kind == "bool":
        if not isinstance(value, bool):
            raise ValidationError(setting.key, "Valeur attendue : vrai ou faux.")
        return value
    if setting.kind in ("int", "float"):
        try:
            number = int(value) if setting.kind == "int" else float(value)
        except (TypeError, ValueError):
            raise ValidationError(setting.key, "Valeur numérique attendue.")
        if setting.min is not None and number < setting.min:
            raise ValidationError(setting.key, f"Minimum : {setting.min}.")
        if setting.max is not None and number > setting.max:
            raise ValidationError(setting.key, f"Maximum : {setting.max}.")
        return number
    if setting.kind == "enum":
        if value not in (choices_of(setting) or []):
            raise ValidationError(setting.key, "Valeur hors de la liste autorisée.")
        return value
    if setting.kind == "time":
        text = str(value).strip()
        parts = text.split(":")
        if len(parts) != 2 or not all(p.isdigit() for p in parts) \
                or not (0 <= int(parts[0]) <= 23) or not (0 <= int(parts[1]) <= 59):
            raise ValidationError(setting.key, "Heure attendue au format HH:MM.")
        return f"{int(parts[0]):02d}:{int(parts[1]):02d}"
    text = str(value).strip()
    if setting.kind == "url" and text and not text.startswith(("http://", "https://")):
        raise ValidationError(setting.key, "L'adresse doit commencer par http:// ou https://.")
    if setting.key == "security.sessionSecret" and text and len(text) < 32:
        raise ValidationError(setting.key, "48 caractères minimum recommandés, 32 exigés.")
    return text


def apply(patch: Dict[str, Any]) -> Dict[str, List[str]]:
    """Valide puis enregistre un lot de réglages.

    Renvoie `{"live": [...], "cold": [...]}` : les clés effectivement modifiées,
    séparées selon qu'elles sont déjà actives ou en attente d'une recréation du
    conteneur. Lève `ValidationError` sans rien écrire si une valeur est refusée.
    """
    live_changes: Dict[str, Any] = {}
    cold_changes: Dict[str, str] = {}
    changed = {"live": [], "cold": []}  # type: Dict[str, List[str]]

    # Validation complète d'abord : un lot s'applique entièrement ou pas du tout.
    prepared: List[tuple] = []
    for key, value in patch.items():
        setting = BY_KEY.get(key)
        if setting is None:
            raise ValidationError(key, "Réglage inconnu.")
        if setting.secret and (value is None or value == ""):
            # Un champ secret laissé vide signifie « inchangé », pas « effacer ».
            continue
        prepared.append((setting, validate(setting, value)))

    for setting, value in prepared:
        # Pour un réglage « à froid », la référence est ce qui figure déjà dans le
        # .env, pas ce que le processus a en mémoire : sans cela, réenregistrer
        # une valeur en attente la réécrirait à chaque fois.
        if value == (saved_value(setting) if setting.scope == "cold" else get(setting.key)):
            continue
        if setting.scope == "cold":
            cold_changes[setting.env or setting.key] = _as_env(setting, value)
            changed["cold"].append(setting.key)
        else:
            live_changes[setting.key] = value
            changed["live"].append(setting.key)

    if live_changes:
        with _lock:
            load()
            for key, value in live_changes.items():
                _plant(_store, key, value)
            _persist()

    if cold_changes:
        if not os.path.exists(DOTENV_PATH):
            raise ValidationError(
                changed["cold"][0],
                f"Le fichier .env n'est pas accessible ({DOTENV_PATH}). "
                "Vérifiez le montage ./.env:/host-env du docker-compose.yml.")
        confwrite.write_dotenv(DOTENV_PATH, cold_changes)

    if changed["live"]:
        _fire(changed["live"])
    return changed


def _as_env(setting: Setting, value: Any) -> str:
    if setting.kind == "bool":
        return "1" if value else "0"
    return str(value)


def reset_section(section: str) -> List[str]:
    """Retire du settings.yaml toutes les clés d'une section (retour aux défauts)."""
    removed: List[str] = []
    with _lock:
        load()
        for setting in SETTINGS:
            if setting.section != section or setting.scope != "live":
                continue
            if not isinstance(_dig(_store, setting.key), _Missing):
                _prune(_store, setting.key)
                removed.append(setting.key)
        if section == "notifications":
            if not isinstance(_dig(_store, "notifications.families"), _Missing):
                _prune(_store, "notifications.families")
                removed.append("notifications.families")
        if removed:
            _persist()
    if removed:
        _fire(removed)
    return removed


def _prune(blob: Dict[str, Any], key: str) -> None:
    parts = key.split(".")
    stack = [blob]
    node = blob
    for part in parts[:-1]:
        node = node.get(part)
        if not isinstance(node, dict):
            return
        stack.append(node)
    node.pop(parts[-1], None)
    # Nettoie les dictionnaires devenus vides, pour que le fichier reste lisible.
    for depth in range(len(stack) - 1, 0, -1):
        if not stack[depth]:
            stack[depth - 1].pop(parts[depth - 1], None)


# --------------------------------------------------------- réglages « à froid »


def pending_restart() -> List[Dict[str, Any]]:
    """Réglages écrits dans le .env mais pas encore pris par le conteneur.

    Aucun état n'est tenu : on relit le fichier et on le compare à l'environnement
    du processus, qui a été figé à la création du conteneur.
    """
    if not os.path.exists(DOTENV_PATH):
        return []
    saved = confwrite.read_dotenv(DOTENV_PATH)
    out: List[Dict[str, Any]] = []
    for setting in SETTINGS:
        if setting.scope != "cold" or not setting.env or setting.readonly:
            continue
        if setting.env not in saved or setting.env not in os.environ:
            # Variable absente du fichier, ou absente de l'environnement du
            # processus (hors conteneur) : la comparaison n'aurait aucun sens.
            continue
        running = os.environ[setting.env]
        if saved[setting.env] == running:
            continue
        out.append({
            "key": setting.key,
            "label": setting.label,
            "env": setting.env,
            "running": "••••" if setting.secret else running,
            "saved": "••••" if setting.secret else saved[setting.env],
        })
    return out


def saved_value(setting: Setting) -> Any:
    """Valeur telle qu'elle figure dans le .env (et non celle du processus)."""
    if setting.scope != "cold":
        return get(setting.key)
    if os.path.exists(DOTENV_PATH):
        saved = confwrite.read_dotenv(DOTENV_PATH)
        if setting.env in saved and saved[setting.env] != "":
            return coerce(setting, saved[setting.env])
    return get(setting.key)


def dotenv_writable() -> bool:
    return os.path.exists(DOTENV_PATH) and os.access(DOTENV_PATH, os.W_OK)


def config_writable() -> bool:
    return os.access(CONFIG_DIR, os.W_OK)
